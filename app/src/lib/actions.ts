'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { normalizePhone } from '@/lib/utils'
import { SIGNUP_PASSWORD_MIN_LENGTH_MESSAGE } from '@/lib/engagement/registration-link-selection'
import {
  getRegistrationPendingShopDisplayName,
  matchesRegistrationPendingShopSelection,
  sanitizeRegistrationPendingShopRequest,
} from '@/lib/engagement/registration-link-selection'
import { normalizePhoneE164, samePhone } from '@/utils/phone'
import { checkPermissionForUser } from '@/lib/server/permissions'
import { hasLinkedShopProfile } from '@/lib/engagement/point-claim-settings'
import { resolveRegistrationLinkSelection } from '@/lib/engagement/registration-link-resolution'
import { sanitizeRoadtourRegistrationContext } from '@/lib/roadtour/registration-context'
import { createShopOrganization } from '@/lib/shop-requests/create-shop'
import { resolveRoadtourByToken } from '@/lib/roadtour/server'
import { getRoadtourExperienceForCategory } from '@/lib/roadtour/experience-registry'
import {
  upsertProgramMembershipsForUserAndOrganization,
  upsertUserProgramMembership,
  type LoyaltyParticipantType,
  type LoyaltyProgramCode,
} from '@/lib/server/loyalty-memberships'
import {
  findCodeByVerificationToken,
  logNotificationEvent as logRegistrationNotificationEvent,
  markCodeUsed as markRegistrationCodeUsed,
} from '@/server/auth/registrationVerificationService'

export async function createUserWithAuth(userData: {
  email: string
  password: string
  full_name: string
  call_name?: string
  role_code: string
  organization_id?: string
  phone?: string
  is_active?: boolean
  avatar_url?: string | null
  shop_name?: string | null
  address?: string | null
  referral_phone?: string | null
  bank_id?: string | null
  bank_account_number?: string | null
  bank_account_holder_name?: string | null
  department_id?: string | null
  manager_user_id?: string | null
  position_id?: string | null
  employment_type?: string | null
  join_date?: string | null
  employment_status?: string | null
  can_be_reference?: boolean
}, callerInfo?: { id: string, role_code: string }) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: sessionAuthError } = await supabase.auth.getUser()
    let callerUserId = user?.id

    if (sessionAuthError || !user) {
      if (!callerInfo?.id) {
        return { success: false, error: 'Unauthorized' }
      }
      callerUserId = callerInfo.id
    }

    if (!callerUserId) {
      return { success: false, error: 'Unauthorized' }
    }

    const permissionCheck = await checkPermissionForUser(callerUserId, 'create_users')
    const roleLevel = permissionCheck.context?.role_level
    const hasRoleLevelCreateAccess = typeof roleLevel === 'number' && roleLevel <= 30
    if (!permissionCheck.allowed && !hasRoleLevelCreateAccess) {
      return { success: false, error: 'Forbidden' }
    }

    // Step 1: Create auth user using admin API
    const adminClient = createAdminClient()

    if (!adminClient) {
      return {
        success: false,
        error: 'Admin client not available. Check service role key configuration.'
      }
    }

    const phone = userData.phone ? normalizePhone(userData.phone) : undefined

    const { data: authUser, error: authError } = await adminClient.auth.admin.createUser({
      email: userData.email,
      password: userData.password,
      email_confirm: true,
      phone: phone,
      phone_confirm: !!phone,
      user_metadata: {
        full_name: userData.full_name // Set display_name in auth user_metadata
      }
    })

    if (authError) {
      return {
        success: false,
        error: authError.message || 'Failed to create auth user'
      }
    }

    if (!authUser?.user?.id) {
      return {
        success: false,
        error: 'No user ID returned from auth creation'
      }
    }

    // Step 2: Sync user profile to public.users table using the sync function
    const { data: syncResult, error: syncError } = await supabase
      .rpc('sync_user_profile', {
        p_user_id: authUser.user.id,
        p_email: userData.email,
        p_role_code: userData.role_code,
        p_organization_id: userData.organization_id || undefined,
        p_full_name: userData.full_name || undefined,
        p_phone: phone
      })

    if (syncError) {
      // Rollback: Delete the auth user if sync failed
      try {
        await adminClient.auth.admin.deleteUser(authUser.user.id)
      } catch (deleteError) {
        console.error('Failed to rollback auth user:', deleteError)
      }

      return {
        success: false,
        error: `Failed to sync user profile: ${syncError.message}`
      }
    }

    // Step 2b: Set account_scope to 'portal' for business users (those with an org)
    // sync_user_profile doesn't set account_scope, so it defaults to 'store'.
    // Without this, admin-created business users can't access /dashboard.
    if (userData.organization_id) {
      const { error: scopeError } = await adminClient
        .from('users')
        .update({ account_scope: 'portal' })
        .eq('id', authUser.user.id)

      if (scopeError) {
        console.error('Failed to set account_scope:', scopeError.message)
        // Non-fatal: user is created but may need manual scope fix
      }
    }

    const profileUpdateData: Record<string, any> = {}
    if (userData.call_name !== undefined) profileUpdateData.call_name = userData.call_name || null
    if (userData.is_active !== undefined) profileUpdateData.is_active = userData.is_active
    if (userData.avatar_url !== undefined) profileUpdateData.avatar_url = userData.avatar_url || null
    if (userData.shop_name !== undefined) profileUpdateData.shop_name = userData.shop_name || null
    if (userData.address !== undefined) profileUpdateData.address = userData.address || null
    if (userData.referral_phone !== undefined) profileUpdateData.referral_phone = userData.referral_phone || null
    if (userData.bank_id !== undefined) profileUpdateData.bank_id = userData.bank_id || null
    if (userData.bank_account_number !== undefined) profileUpdateData.bank_account_number = userData.bank_account_number || null
    if (userData.bank_account_holder_name !== undefined) profileUpdateData.bank_account_holder_name = userData.bank_account_holder_name || null
    if (userData.department_id !== undefined) profileUpdateData.department_id = userData.department_id || null
    if (userData.manager_user_id !== undefined) profileUpdateData.manager_user_id = userData.manager_user_id || null
    if (userData.position_id !== undefined) profileUpdateData.position_id = userData.position_id || null
    if (userData.employment_type !== undefined) profileUpdateData.employment_type = userData.employment_type || null
    if (userData.join_date !== undefined) profileUpdateData.join_date = userData.join_date || null
    if (userData.employment_status !== undefined) profileUpdateData.employment_status = userData.employment_status || 'active'
    if (phone) profileUpdateData.phone_verified_at = new Date().toISOString()
    if (userData.can_be_reference !== undefined) profileUpdateData.can_be_reference = Boolean(userData.can_be_reference)

    if (Object.keys(profileUpdateData).length > 0) {
      const { error: callNameError } = await adminClient
        .from('users')
        .update(profileUpdateData)
        .eq('id', authUser.user.id)

      if (callNameError) {
        console.error('Failed to set created user profile fields:', callNameError.message)
        try {
          await adminClient.auth.admin.deleteUser(authUser.user.id)
        } catch (deleteError) {
          console.error('Failed to rollback auth user after profile update error:', deleteError)
        }

        return {
          success: false,
          error: `Failed to save created user profile fields: ${callNameError.message}`
        }
      }
    }

    if (userData.organization_id) {
      try {
        const { data: orgRow } = await adminClient
          .from('organizations')
          .select('org_type_code')
          .eq('id', userData.organization_id)
          .maybeSingle()

        if (orgRow?.org_type_code === 'SHOP' || orgRow?.org_type_code === 'DIST') {
          await upsertUserProgramMembership(adminClient as any, 'cellera', authUser.user.id, 'organization_user', 'legacy_registration', {
            memberOrganizationId: userData.organization_id,
            createdBy: callerUserId,
          })
        }
      } catch (membershipError) {
        console.error('Failed to create Cellera membership for admin-created user:', membershipError)
      }
    }

    // Step 3: Return success
    revalidatePath('/dashboard')
    return {
      success: true,
      user_id: authUser.user.id,
      message: `User ${userData.email} created successfully`
    }
  } catch (error) {
    console.error('Error creating user:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete user'
    }
  }
}

export async function updateUserWithAuth(userId: string, userData: {
  full_name?: string
  call_name?: string | null
  role_code?: string
  organization_id?: string
  phone?: string
  signature_url?: string | null
  is_active?: boolean
  avatar_url?: string
  location?: string
  shop_name?: string
  address?: string
  referral_phone?: string
  bank_id?: string
  bank_account_number?: string
  bank_account_holder_name?: string
  department_id?: string | null
  manager_user_id?: string | null
  position_id?: string | null
  employment_type?: string | null
  join_date?: string | null
  employment_status?: string | null
  can_be_reference?: boolean
}, callerInfo?: { id: string, role_code: string }) {
  try {
    const adminClient = createAdminClient()

    // Use server client to get current user from cookies
    const supabase = await createClient()

    // Check permissions: Current user must have edit_users OR updating themselves
    const { data: { user: currentUser }, error: authError } = await supabase.auth.getUser()

    let isAuthorized = false
    let isSelfUpdate = false

    // If session check fails, try to use caller info passed from client
    if (!currentUser || authError) {
      console.log('Server action: Session not found via cookies, checking caller info...')

      if (callerInfo) {
        const permissionCheck = await checkPermissionForUser(callerInfo.id, 'edit_users')
        const roleLevel = permissionCheck.context?.role_level
        const hasRoleLevelEditAccess = typeof roleLevel === 'number' && roleLevel <= 30
        isSelfUpdate = callerInfo.id === userId
        isAuthorized = isSelfUpdate || permissionCheck.allowed || hasRoleLevelEditAccess
        console.log('Server action: Caller validated from DB -', { isAuthorized, isSelfUpdate })
      }

      if (!isAuthorized) {
        console.log('Server action: Not authorized, no valid session or caller info')
        return { success: false, error: 'Not authenticated. Please refresh the page and try again.' }
      }
    } else {
      // Session exists - check permissions normally
      isSelfUpdate = currentUser.id === userId
      const permissionCheck = await checkPermissionForUser(currentUser.id, 'edit_users')
      const roleLevel = permissionCheck.context?.role_level
      const hasRoleLevelEditAccess = typeof roleLevel === 'number' && roleLevel <= 30
      isAuthorized = isSelfUpdate || permissionCheck.allowed || hasRoleLevelEditAccess
    }

    if (!isAuthorized) {
      return { success: false, error: 'Unauthorized' }
    }

    // Update Auth User metadata (full_name/display_name) - sync to Supabase Auth user_metadata
    if (userData.full_name !== undefined) {
      try {
        const { error: authMetaError } = await adminClient.auth.admin.updateUserById(userId, {
          user_metadata: { full_name: userData.full_name }
        })

        if (authMetaError) {
          console.error('Auth user_metadata update failed:', authMetaError.message)
          // Don't fail the whole operation for metadata sync failure
          console.warn('Continuing despite metadata sync failure...')
        } else {
          console.log('✅ Auth user_metadata.full_name synced to:', userData.full_name)
        }
      } catch (metaErr) {
        console.error('Auth metadata update exception:', metaErr)
        // Don't fail the whole operation for metadata sync failure
      }
    }

    // Update Auth User (Phone) - handle both setting and clearing phone
    // We make this BLOCKING to ensure consistency between Auth and Database
    if (userData.phone !== undefined) {
      try {
        if (userData.phone && userData.phone.trim()) {
          // Setting/updating phone number
          const phone = normalizePhone(userData.phone) // Returns E.164 with + prefix

          const { data: authData, error: authError } = await adminClient.auth.admin.updateUserById(userId, {
            phone: phone,
            phone_confirm: true
          })

          if (authError) {
            console.error('Auth phone update failed:', authError.message)
            return { success: false, error: `Failed to update phone in Auth: ${authError.message}` }
          }

          // Verify the update actually happened
          if (authData?.user?.phone !== phone) {
            console.warn(`Auth phone mismatch after update. Expected: ${phone}, Got: ${authData?.user?.phone}`)

            // Check if digits match (ignoring formatting differences)
            const expectedDigits = phone.replace(/\D/g, '')
            const gotDigits = (authData?.user?.phone || '').replace(/\D/g, '')

            if (expectedDigits !== gotDigits) {
              console.error('Auth phone update failed silently (digits mismatch)')
              return { success: false, error: 'Failed to update phone in Auth (Silent Failure). Please try again.' }
            }
          }

          console.log('✅ Auth phone updated to:', phone)
        } else {
          // Clearing/removing phone number - set to empty string or null
          const { error: authError } = await adminClient.auth.admin.updateUserById(userId, {
            phone: '',
            phone_confirm: false
          })

          if (authError) {
            console.error('Auth phone clear failed:', authError.message)
            return { success: false, error: `Failed to clear phone in Auth: ${authError.message}` }
          } else {
            console.log('✅ Auth phone cleared')
          }
        }
      } catch (authErr) {
        console.error('Auth phone update exception:', authErr)
        return { success: false, error: `Auth phone update exception: ${authErr}` }
      }
    }

    // Update Public User - prepare data for database update
    // Phone is normalized to E.164 format with + prefix for consistency, or null if cleared
    const updateData: any = { ...userData }
    if (updateData.call_name !== undefined) {
      updateData.call_name = updateData.call_name || null
    }
    if (updateData.phone && updateData.phone.trim()) {
      updateData.phone = normalizePhone(updateData.phone)
      // Also update phone_verified_at since we confirmed it in Auth
      updateData.phone_verified_at = new Date().toISOString()
    } else if (updateData.phone !== undefined) {
      updateData.phone = null // Explicitly set to null when cleared
      updateData.phone_verified_at = null
    }

    // Auto-set account_scope when organization_id changes
    // Users with an org and a business role should be 'portal'; without org → 'store'
    if (updateData.organization_id !== undefined) {
      const effectiveRole = updateData.role_code
      if (updateData.organization_id && (!effectiveRole || !['GUEST', 'CONSUMER'].includes(effectiveRole))) {
        updateData.account_scope = 'portal'
      } else if (!updateData.organization_id) {
        updateData.account_scope = 'store'
      }
    }

    if (updateData.department_id || updateData.manager_user_id || updateData.position_id) {
      const { data: targetUser, error: targetError } = await adminClient
        .from('users')
        .select('id, organization_id')
        .eq('id', userId)
        .single()

      if (targetError || !targetUser) {
        return { success: false, error: 'User not found' }
      }

      const targetOrgId = targetUser.organization_id

      if (updateData.department_id) {
        const { data: dept } = await adminClient
          .from('departments')
          .select('id, organization_id')
          .eq('id', updateData.department_id)
          .single()

        if (!dept || dept.organization_id !== targetOrgId) {
          return { success: false, error: 'Invalid department for this organization' }
        }
      }

      if (updateData.manager_user_id) {
        const { data: manager } = await adminClient
          .from('users')
          .select('id, organization_id')
          .eq('id', updateData.manager_user_id)
          .single()

        if (!manager || manager.organization_id !== targetOrgId) {
          return { success: false, error: 'Invalid manager for this organization' }
        }
      }

      if (updateData.position_id) {
        const { data: position } = await adminClient
          .from('hr_positions')
          .select('id, organization_id')
          .eq('id', updateData.position_id)
          .single()

        if (!position || position.organization_id !== targetOrgId) {
          return { success: false, error: 'Invalid position for this organization' }
        }
      }
    }

    if (updateData.organization_id !== undefined || updateData.referral_phone !== undefined) {
      const { data: existingUser, error: existingUserError } = await adminClient
        .from('users')
        .select(`
          organization_id,
          referral_phone,
          role_code,
          account_scope,
          roles(role_level),
          organizations!fk_users_organization(org_type_code)
        `)
        .eq('id', userId)
        .single()

      if (existingUserError) {
        return { success: false, error: 'Failed to resolve current user profile for confirmation logic' }
      }

      const nextOrganizationId = updateData.organization_id !== undefined
        ? updateData.organization_id
        : existingUser?.organization_id || null
      const nextReferralPhone = updateData.referral_phone !== undefined
        ? updateData.referral_phone
        : existingUser?.referral_phone || null

      let nextOrganizationTypeCode = (existingUser?.organizations as any)?.org_type_code || null

      if (nextOrganizationId && nextOrganizationId !== existingUser?.organization_id) {
        const { data: organizationData, error: organizationError } = await adminClient
          .from('organizations')
          .select('org_type_code')
          .eq('id', nextOrganizationId)
          .maybeSingle()

        if (organizationError) {
          return { success: false, error: 'Failed to resolve selected organization for confirmation logic' }
        }

        nextOrganizationTypeCode = organizationData?.org_type_code || null

        // Prevent accidental HQ Admin → Shop move when saving own profile.
        // Intentional User Management transfers (edit_users by another admin) remain allowed.
        if (isSelfUpdate && nextOrganizationTypeCode === 'SHOP') {
          const { getShopOrgReassignmentBlockReason } = await import('@/lib/auth/employment-org-guard')
          const blockReason = getShopOrgReassignmentBlockReason({
            currentOrgTypeCode: (existingUser?.organizations as any)?.org_type_code || null,
            currentRoleCode: existingUser?.role_code,
            currentRoleLevel: (existingUser?.roles as any)?.role_level ?? null,
            currentAccountScope: existingUser?.account_scope,
            nextOrgTypeCode: 'SHOP',
          })
          if (blockReason) {
            return { success: false, error: blockReason }
          }
        }
      } else if (!nextOrganizationId) {
        nextOrganizationTypeCode = null
      }

      if (hasLinkedShopProfile({
        organization_id: nextOrganizationId,
        organizationTypeCode: nextOrganizationTypeCode,
        referral_phone: nextReferralPhone,
      })) {
        updateData.consumer_claim_confirmed_at = null
      }
    }

    // Use adminClient to ensure update happens even if RLS is tricky (though RLS should allow self update)
    const { error: dbError } = await adminClient
      .from('users')
      .update(updateData)
      .eq('id', userId)

    if (dbError) {
      console.error('Database update error:', dbError)
      return { success: false, error: `Failed to update database user: ${dbError.message}` }
    }

    revalidatePath('/dashboard')
    return { success: true }

  } catch (error) {
    console.error('Error updating user:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function login(formData: FormData) {
  const supabase = await createClient()

  // type-casting here for convenience
  // in practice, you should validate your inputs
  const data = {
    email: formData.get('email') as string,
    password: formData.get('password') as string,
  }

  const { data: authData, error } = await supabase.auth.signInWithPassword(data)

  if (error) {
    redirect('/error')
  }

  // Update last_login_at and capture IP immediately after successful login
  if (authData?.user?.id) {
    try {
      // Capture client IP address from headers
      let clientIp: string | null = null

      // Note: In server actions, we can't directly access request headers
      // The IP will be captured via middleware or we'll use a client-side approach
      // For now, we'll set a placeholder and update it via a client-side call
      // after successful login

      await supabase
        .from('users')
        .update({
          last_login_at: new Date().toISOString(),
          last_login_ip: clientIp // Will be updated by client-side IP capture
        })
        .eq('id', authData.user.id)
    } catch (loginError) {
      console.error('Failed to update last_login_at:', loginError)
      // Don't fail the login if this fails
    }
  }

  revalidatePath('/', 'layout')
  redirect('/dashboard')
}

export async function signup(formData: FormData) {
  const supabase = await createClient()

  // type-casting here for convenience
  // in practice, you should validate your inputs
  const data = {
    email: formData.get('email') as string,
    password: formData.get('password') as string,
  }

  const { error } = await supabase.auth.signUp(data)

  if (error) {
    redirect('/error')
  }

  revalidatePath('/', 'layout')
  redirect('/dashboard')
}

export async function deleteUserWithAuth(userId: string, callerInfo?: { id: string, role_code: string }) {
  try {
    const adminClient = createAdminClient()

    if (!adminClient) {
      return {
        success: false,
        error: 'Admin client not available. Check service role key configuration.'
      }
    }

    const supabase = await createClient()

    // Verify caller has permission to delete users
    let isAuthorized = false

    // Try to get current user from session first
    const { data: { user: currentUser } } = await supabase.auth.getUser()

    if (currentUser) {
      const permissionCheck = await checkPermissionForUser(currentUser.id, 'delete_users')
      isAuthorized = permissionCheck.allowed
    } else if (callerInfo) {
      const permissionCheck = await checkPermissionForUser(callerInfo.id, 'delete_users')
      isAuthorized = permissionCheck.allowed
    }

    if (!isAuthorized) {
      return {
        success: false,
        error: 'Unauthorized: Only administrators can delete users'
      }
    }

    // First, get user's email and phone for consumer_activations lookup
    const { data: targetUser } = await adminClient
      .from('users')
      .select('email, phone')
      .eq('id', userId)
      .single()

    // Step 1: Delete audit_logs first to avoid foreign key constraint
    // Use admin client to bypass RLS policies
    const { error: auditError } = await adminClient
      .from('audit_logs')
      .delete()
      .eq('user_id', userId)

    if (auditError) {
      console.error('Failed to delete audit logs:', auditError)
      // Don't fail on audit log deletion - continue with user deletion
    }

    // Step 2: Delete points_transactions for this user
    const { error: pointsError } = await adminClient
      .from('points_transactions')
      .delete()
      .eq('user_id', userId)

    if (pointsError) {
      console.error('Failed to delete points_transactions:', pointsError)
      // Continue anyway
    }

    // Step 3: Delete consumer_activations for this user by email or phone
    if (targetUser?.email) {
      const { error: activationsEmailError } = await adminClient
        .from('consumer_activations')
        .delete()
        .eq('consumer_email', targetUser.email)

      if (activationsEmailError) {
        console.error('Failed to delete consumer_activations by email:', activationsEmailError)
      }
    }

    if (targetUser?.phone) {
      const { error: activationsPhoneError } = await adminClient
        .from('consumer_activations')
        .delete()
        .eq('consumer_phone', targetUser.phone)

      if (activationsPhoneError) {
        console.error('Failed to delete consumer_activations by phone:', activationsPhoneError)
      }
    }

    // Step 4: Set null on consumer_qr_scans for this user (FK has SET NULL rule)
    const { error: scansError } = await adminClient
      .from('consumer_qr_scans')
      .update({ consumer_id: null })
      .eq('consumer_id', userId)

    if (scansError) {
      console.error('Failed to nullify consumer_qr_scans:', scansError)
    }

    const transferOperations = [
      { table: 'documents', column: 'created_by', value: currentUser?.id || callerInfo?.id, label: 'documents.created_by' },
      { table: 'documents', column: 'acknowledged_by', value: null, label: 'documents.acknowledged_by' },
      { table: 'document_files', column: 'uploaded_by', value: currentUser?.id || callerInfo?.id, label: 'document_files.uploaded_by' },
      { table: 'orders', column: 'created_by', value: currentUser?.id || callerInfo?.id, label: 'orders.created_by' },
      { table: 'orders', column: 'approved_by', value: null, label: 'orders.approved_by' },
      { table: 'orders', column: 'updated_by', value: null, label: 'orders.updated_by' },
    ]

    for (const operation of transferOperations) {
      if (operation.value === undefined) continue

      const { error } = await adminClient
        .from(operation.table)
        .update({ [operation.column]: operation.value })
        .eq(operation.column, userId)

      if (error) {
        console.error(`Failed to transfer ${operation.label}:`, error)
      }
    }

    // Step 5: Delete user from public.users table using admin client to bypass RLS
    const { error: dbError } = await adminClient
      .from('users')
      .delete()
      .eq('id', userId)

    if (dbError) {
      console.error('Database delete error:', dbError)
      return {
        success: false,
        error: `Failed to delete user from database: ${dbError.message}`
      }
    }

    // Step 6: Delete user from Supabase Auth
    const { error: authError } = await adminClient.auth.admin.deleteUser(userId)

    if (authError) {
      console.error('Failed to delete auth user (but database user deleted):', authError)
      // We still return success since the main user record is deleted
      // The auth record will be orphaned but won't cause issues
      return {
        success: true,
        warning: 'User deleted from database but auth deletion failed',
        message: 'User deleted successfully'
      }
    }

    // Step 7: Return success
    revalidatePath('/dashboard')
    return {
      success: true,
      message: 'User deleted successfully from both database and auth'
    }
  } catch (error) {
    console.error('Error deleting user:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete user'
    }
  }
}

export async function registerConsumer(userData: {
  email: string
  password: string
  full_name: string
  phone?: string
  location?: string
  reference_user_id?: string
  referral_phone?: string
  address?: string
  organization_id?: string
  shop_name?: string
  registration_org_id?: string
  verification_token?: string
}) {
  try {
    const adminClient = createAdminClient()
    if (!adminClient) {
      return {
        success: false,
        error: 'System configuration error'
      }
    }

    const phone = userData.phone ? normalizePhone(userData.phone) : undefined
    const normalizedEmail = userData.email.trim().toLowerCase()

    if (!userData.password || userData.password.length < 6) {
      return {
        success: false,
        error: SIGNUP_PASSWORD_MIN_LENGTH_MESSAGE,
      }
    }

    if (!phone) {
      return {
        success: false,
        error: 'A verified mobile number is required for registration.'
      }
    }

    if (!userData.verification_token) {
      return {
        success: false,
        error: 'Email verification is required before registration can be completed.'
      }
    }

    const verificationCode = await findCodeByVerificationToken(adminClient, userData.verification_token)
    if (!verificationCode) {
      return {
        success: false,
        error: 'Your email verification session has expired. Please request a new verification code.'
      }
    }

    const verifiedEmail = String((verificationCode.meta as any)?.email || '').trim().toLowerCase()
    const phoneE164 = normalizePhoneE164(userData.phone || '')
    if (verificationCode.phone_normalized !== phoneE164 || verifiedEmail !== normalizedEmail) {
      return {
        success: false,
        error: 'The verified details do not match the current registration form. Please verify again.'
      }
    }

    const verifiedMeta = (verificationCode.meta as any) || {}
    const verifiedReferenceUserId = String(verifiedMeta.reference_user_id || '').trim()
    const verifiedReferralPhone = String(verifiedMeta.referral_phone || '').trim()
    const verifiedOrganizationId = String(verifiedMeta.shop_organization_id || '').trim()
    const verifiedShopName = String(verifiedMeta.shop_name || '').trim()
    const verifiedPendingShopRequest = sanitizeRegistrationPendingShopRequest(verifiedMeta.pending_shop_request)
    const verifiedRoadtourContext = sanitizeRoadtourRegistrationContext(verifiedMeta.roadtour_context)

    if (verifiedReferenceUserId && userData.reference_user_id?.trim() && userData.reference_user_id.trim() !== verifiedReferenceUserId) {
      return {
        success: false,
        error: 'Your selected reference changed after verification. Please request a new verification code and try again.'
      }
    }

    if (verifiedOrganizationId && userData.organization_id?.trim() && userData.organization_id.trim() !== verifiedOrganizationId) {
      return {
        success: false,
        error: 'Your selected shop changed after verification. Please request a new verification code and try again.'
      }
    }

    if (verifiedPendingShopRequest) {
      if (userData.organization_id?.trim()) {
        return {
          success: false,
          error: 'Your selected shop changed after verification. Please request a new verification code and try again.'
        }
      }

      if (userData.shop_name?.trim() && !matchesRegistrationPendingShopSelection(userData.shop_name, verifiedPendingShopRequest)) {
        return {
          success: false,
          error: 'Your selected shop changed after verification. Please request a new verification code and try again.'
        }
      }
    }

    if (verifiedReferralPhone && userData.referral_phone?.trim() && !samePhone(userData.referral_phone, verifiedReferralPhone)) {
      return {
        success: false,
        error: 'Your selected reference changed after verification. Please request a new verification code and try again.'
      }
    }

    const linkSelection = await resolveRegistrationLinkSelection(adminClient, {
      organizationId: verifiedOrganizationId || userData.organization_id,
      shopName: verifiedShopName || userData.shop_name,
      referenceUserId: verifiedReferenceUserId || userData.reference_user_id,
      referralPhone: verifiedReferralPhone || userData.referral_phone,
      pendingShopRequest: verifiedPendingShopRequest,
    })

    if (!linkSelection.ok) {
      return {
        success: false,
        error: 'Your selected reference and shop must be verified again. Please request a new verification code and try again.'
      }
    }

    let finalOrganizationId = linkSelection.organizationId
    let finalShopDisplayName = linkSelection.shopDisplayName

    // Create user with auto-confirm to bypass rate limits and verification
    const { data: authUser, error: authError } = await adminClient.auth.admin.createUser({
      email: normalizedEmail,
      password: userData.password,
      email_confirm: true,
      phone: phone,
      phone_confirm: !!phone,
      user_metadata: {
        full_name: userData.full_name,
        phone: phone, // Ensure phone is in metadata for the trigger
        location: userData.location
      }
    })

    if (authError) {
      return {
        success: false,
        error: authError.message
      }
    }

    if (!authUser?.user) {
      return {
        success: false,
        error: 'User creation failed'
      }
    }

    if (!finalOrganizationId && linkSelection.pendingShopRequest) {
      try {
        const { organization } = await createShopOrganization(adminClient, {
          form: linkSelection.pendingShopRequest,
          createdBy: authUser.user.id,
        })

        finalOrganizationId = organization.id
        finalShopDisplayName = getRegistrationPendingShopDisplayName(linkSelection.pendingShopRequest)
      } catch (shopCreateError) {
        try {
          await adminClient.auth.admin.deleteUser(authUser.user.id)
        } catch (deleteError) {
          console.error('Failed to rollback auth user after shop creation error:', deleteError)
        }

        return {
          success: false,
          error: shopCreateError instanceof Error ? shopCreateError.message : 'Failed to create shop during registration.',
        }
      }
    }

    // Explicitly sync user profile to ensure it exists before login
    const { error: syncError } = await adminClient
      .rpc('sync_user_profile', {
        p_user_id: authUser.user.id,
        p_email: normalizedEmail,
        p_full_name: userData.full_name,
        p_phone: phone,
        p_role_code: 'GUEST' // Default role for consumer registrations
      })

    if (syncError) {
      console.warn('Manual sync_user_profile failed, relying on trigger:', syncError)
      // Don't fail the registration, as the trigger might still work
    }

    const profileUpdates: Record<string, any> = {}
    if (userData.location) profileUpdates.location = userData.location
    profileUpdates.reference_user_id = linkSelection.referenceUserId
    profileUpdates.referral_phone = linkSelection.referralPhone
    if (userData.address) profileUpdates.address = userData.address
    profileUpdates.organization_id = finalOrganizationId
    profileUpdates.shop_name = finalShopDisplayName

    if (Object.keys(profileUpdates).length > 0) {
      const { error: profileError } = await adminClient
        .from('users')
        .update(profileUpdates)
        .eq('id', authUser.user.id)

      if (profileError) {
        console.warn('Registration profile enrichment failed:', profileError)
      }
    }

    try {
      let programCode: LoyaltyProgramCode = 'cellera'
      let enrollmentSource: 'legacy_registration' | 'roadtour' = 'legacy_registration'
      let firstRoadtourRunId: string | null = null
      let firstCampaignId: string | null = null
      let ownerOrganizationId: string | null = userData.registration_org_id || null

      if (verifiedRoadtourContext?.token) {
        const roadtour = await resolveRoadtourByToken(verifiedRoadtourContext.token)
        const experience = getRoadtourExperienceForCategory(roadtour?.product_category)
        programCode = experience?.key === 'pet_food' ? 'ellbow' : 'cellera'
        enrollmentSource = 'roadtour'
        firstRoadtourRunId = (roadtour as any)?.roadtour_run_id || null
        firstCampaignId = verifiedRoadtourContext.campaign_id || (roadtour as any)?.campaign_id || null
        ownerOrganizationId = verifiedRoadtourContext.org_id || ownerOrganizationId
      }

      const participantType: LoyaltyParticipantType = finalOrganizationId ? 'shop_staff' : 'consumer'
      await upsertProgramMembershipsForUserAndOrganization({
        admin: adminClient as any,
        programCode,
        userId: authUser.user.id,
        memberOrganizationId: finalOrganizationId,
        participantType,
        enrollmentSource,
        context: {
          ownerOrganizationId,
          firstRoadtourRunId,
          firstCampaignId,
          createdBy: authUser.user.id,
        },
      })
    } catch (membershipError) {
      console.error('Registration loyalty membership upsert failed:', membershipError)
    }

    let bonusAwarded = false
    let bonusPoints = 0
    let bonusMode: string | null = null

    if (userData.registration_org_id) {
      try {
        const { data: settings } = await (adminClient as any)
          .from('user_registration_bonus_settings')
          .select('*')
          .eq('org_id', userData.registration_org_id)
          .eq('enabled', true)
          .maybeSingle()

        if (settings) {
          bonusPoints = settings.bonus_points || 0
          bonusMode = settings.bonus_mode || null

          const bonusRow = {
            org_id: userData.registration_org_id,
            user_id: authUser.user.id,
            settings_id: settings.id,
            status: settings.bonus_mode === 'instant' ? 'awarded' : 'pending',
            bonus_mode: settings.bonus_mode,
            bonus_points: settings.bonus_points,
            min_valid_scans_per_month: settings.min_valid_scans_per_month,
            required_consecutive_months: settings.required_consecutive_months,
            only_unique_qr_scans: settings.only_unique_qr_scans,
            allow_grace_month: settings.allow_grace_month,
            bonus_expiry_days: settings.bonus_expiry_days,
            max_bonus_claims_per_user: settings.max_bonus_claims_per_user,
            registration_source: 'premium_loyalty',
            registered_at: new Date().toISOString(),
            qualified_at: settings.bonus_mode === 'instant' ? new Date().toISOString() : null,
            awarded_at: settings.bonus_mode === 'instant' ? new Date().toISOString() : null,
          }

          let awardedTransactionId: string | null = null

          if (settings.bonus_mode === 'instant') {
            const { data: balanceData } = await (adminClient as any)
              .from('v_consumer_points_balance')
              .select('current_balance')
              .eq('user_id', authUser.user.id)
              .maybeSingle()

            const currentBalance = Number(balanceData?.current_balance || 0)
            const { data: txnData, error: txnError } = await (adminClient as any)
              .from('points_transactions')
              .insert({
                company_id: userData.registration_org_id,
                consumer_phone: phone,
                consumer_email: normalizedEmail,
                transaction_type: 'adjust',
                points_amount: settings.bonus_points,
                balance_after: currentBalance + settings.bonus_points,
                description: 'Welcome bonus credited upon successful registration.',
                transaction_date: new Date().toISOString(),
                user_id: authUser.user.id,
                created_by: authUser.user.id,
                // Taxonomy dual-write (Phase 1)
                point_category: 'registration',
                point_indicator: 'welcome_bonus',
                point_owner_type: 'consumer',
                point_direction: 'earn',
              })
              .select('id')
              .single()

            if (txnError) {
              console.warn('Failed to award instant registration bonus:', txnError)
            } else {
              awardedTransactionId = txnData?.id || null
              bonusAwarded = true
            }
          }

          await (adminClient as any)
            .from('user_registration_bonus_progress')
            .upsert({
              ...bonusRow,
              awarded_transaction_id: awardedTransactionId,
            }, { onConflict: 'org_id,user_id' })
        }
      } catch (bonusError) {
        console.warn('Registration bonus setup unavailable or failed:', bonusError)
      }
    }

    await markRegistrationCodeUsed(adminClient, verificationCode.id, authUser.user.id)
    await logRegistrationNotificationEvent(adminClient, {
      eventType: 'registration_completed',
      phone,
      userId: authUser.user.id,
      status: 'completed',
      meta: {
        email: normalizedEmail,
        org_id: userData.registration_org_id || null,
        reference_user_id: linkSelection.referenceUserId,
        shop_organization_id: finalOrganizationId,
        registration_source: verifiedRoadtourContext ? 'roadtour' : 'premium_loyalty',
        roadtour_context: verifiedRoadtourContext,
      },
    })

    return {
      success: true,
      user: authUser.user,
      bonus: {
        awarded: bonusAwarded,
        points: bonusPoints,
        mode: bonusMode,
      },
    }
  } catch (error) {
    console.error('Error registering consumer:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to register consumer'
    }
  }
}
