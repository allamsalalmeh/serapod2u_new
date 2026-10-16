import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { userAllowed } from '@/lib/security-access/operation'
import { ROOT_TARGET_PROTECTED_MESSAGE, rootTargetGuard } from '@/lib/security-access/root-access'
import { normalizePhone, validatePhoneNumber } from '@/lib/utils'
import { hasLinkedShopProfile } from '@/lib/engagement/point-claim-settings'
import { resolveProfileLinkValidation } from '@/lib/engagement/profile-link-validation'
import { buildPersonalBankUpdateData, validateMsiaBankAccount } from '@/lib/engagement/personal-bank-details'
import {
  getDisallowedSelfServiceFields,
  SELF_SERVICE_AUTH_METADATA_FIELDS,
} from '@/lib/security/user-profile-updates'

/**
 * POST /api/user/update-profile
 * Update user profile (name, phone) with phone sync to Supabase Auth
 * 
 * Body:
 *   userId?: string - Defaults to the authenticated user. Cross-user profile
 *     edits require legacy administrator authorization.
 *   full_name?: string - New name
 *   phone?: string - New phone number (will be synced to Supabase Auth)
 *
 * Authorization, organization and employment fields are intentionally not
 * accepted by this profile endpoint.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const adminClient = createAdminClient()

    // Verify authentication
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()

    if (authError || !authUser) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized - Please log in' },
        { status: 401 }
      )
    }

    const body = await request.json()
    const requestedUserId = typeof body?.userId === 'string' && body.userId.trim()
      ? body.userId.trim()
      : authUser.id
    const {
      full_name,
      phone,
      outdoor_phone,
      outdoor_location,
      referral_phone,
      reference_user_id,
      address,
      shop_name,
      bank_id,
      bank_account_number,
      bank_account_holder_name,
    } = body

    const disallowedFields = getDisallowedSelfServiceFields(body, [
      'userId',
      ...SELF_SERVICE_AUTH_METADATA_FIELDS,
    ])
    if (disallowedFields.length > 0) {
      return NextResponse.json(
        {
          success: false,
          code: 'PROTECTED_PROFILE_FIELD',
          error: `Profile updates cannot modify protected fields: ${disallowedFields.join(', ')}`,
        },
        { status: 403 },
      )
    }

    // Verify user is updating their own profile
    if (authUser.id !== requestedUserId) {
      // Check if user is admin
      const { data: userProfile } = await supabase
        .from('users')
        .select('role_code, roles(role_level)')
        .eq('id', authUser.id)
        .single()

      const roleLevel = (userProfile?.roles as any)?.role_level
      const roleCode = userProfile?.role_code
      const isAdmin = roleCode === 'SUPER' || roleCode === 'SUPERADMIN' || roleCode === 'HQ_ADMIN' || roleLevel === 1 || roleLevel === 10

      // Editing another person's profile is an S&A decision
      // (platform.user.profile_edit) in that person's organization; the
      // historical admin rule is the legacy evaluator.
      const { data: target } = await adminClient.from('users').select('organization_id').eq('id', requestedUserId).maybeSingle()
      if (!target || !(await userAllowed(authUser.id, 'platform.user.profile_edit', () => isAdmin,
        { organizationId: (target as any).organization_id ?? null }))) {
        return NextResponse.json(
          { success: false, error: 'Unauthorized - Can only update your own profile' },
          { status: 403 }
        )
      }
      // The login phone is synced to Supabase Auth: a Root Administrator's profile is changed only by another Root Administrator.
      const rootGuard = await rootTargetGuard(adminClient, authUser.id, requestedUserId)
      if (!rootGuard.ok) {
        return rootGuard.reason === 'root_target_protected'
          ? NextResponse.json({ success: false, code: 'ROOT_TARGET_PROTECTED', error: ROOT_TARGET_PROTECTED_MESSAGE }, { status: 403 })
          : NextResponse.json({ success: false, error: 'Access could not be verified. Please retry.' }, { status: 503 })
      }
    }

    const userId = requestedUserId

    const updateData: any = {}

    // Handle name update - also sync to Supabase Auth user_metadata
    if (full_name !== undefined) {
      updateData.full_name = full_name?.trim() || null

      // Sync full_name to Supabase Auth user_metadata without dropping other fields.
      try {
        const { data: authRecord } = await adminClient.auth.admin.getUserById(userId)
        const { error: authMetaError } = await adminClient.auth.admin.updateUserById(userId, {
          user_metadata: {
            ...(authRecord?.user?.user_metadata || {}),
            full_name: full_name?.trim() || null,
          },
        })

        if (authMetaError) {
          console.error('Auth user_metadata update failed:', authMetaError.message)
          // Don't fail the whole operation for metadata sync failure
        } else {
          console.log('✅ Auth user_metadata.full_name synced to:', full_name?.trim())
        }
      } catch (metaErr) {
        console.error('Auth metadata update exception:', metaErr)
        // Don't fail the whole operation for metadata sync failure
      }
    }

    // Outdoor delivery phone is per storefront profile. It is not a login phone,
    // so it must not use the shared users.phone uniqueness check or Auth phone.
    if (outdoor_phone !== undefined) {
      const raw = typeof outdoor_phone === 'string' ? outdoor_phone.trim() : ''
      let stored: string | null = null
      if (raw) {
        const validation = validatePhoneNumber(raw)
        if (!validation.isValid) {
          return NextResponse.json(
            { success: false, error: validation.error || 'Invalid phone number format' },
            { status: 400 }
          )
        }
        stored = normalizePhone(raw)
      }

      const { data: authRecord } = await adminClient.auth.admin.getUserById(userId)
      const { error: outdoorPhoneError } = await adminClient.auth.admin.updateUserById(userId, {
        user_metadata: {
          ...(authRecord?.user?.user_metadata || {}),
          outdoor_phone: stored,
        },
      })

      if (outdoorPhoneError) {
        console.error('Outdoor phone metadata update failed:', outdoorPhoneError)
        return NextResponse.json(
          { success: false, error: 'Could not save the delivery phone.' },
          { status: 500 }
        )
      }
    }

    // Outdoor city stays on this storefront profile and does not write users.location.
    if (outdoor_location !== undefined) {
      const raw = typeof outdoor_location === 'string' ? outdoor_location.trim() : ''
      if (raw.length > 120) {
        return NextResponse.json(
          { success: false, error: 'City must be 120 characters or less' },
          { status: 400 }
        )
      }

      const { data: authRecord } = await adminClient.auth.admin.getUserById(userId)
      const { error: outdoorLocationError } = await adminClient.auth.admin.updateUserById(userId, {
        user_metadata: {
          ...(authRecord?.user?.user_metadata || {}),
          outdoor_location: raw || null,
        },
      })

      if (outdoorLocationError) {
        console.error('Outdoor location metadata update failed:', outdoorLocationError)
        return NextResponse.json(
          { success: false, error: 'Could not save the city.' },
          { status: 500 }
        )
      }
    }

    // Handle phone update with Auth sync
    if (phone !== undefined) {
      if (phone && phone.trim()) {
        // Validate phone format first (Malaysia/China)
        const validation = validatePhoneNumber(phone)
        if (!validation.isValid) {
          return NextResponse.json(
            { success: false, error: validation.error || 'Invalid phone number format' },
            { status: 400 }
          )
        }

        const normalizedPhone = normalizePhone(phone)

        // Check if phone is already in use in users table
        const { data: existingUser, error: checkError } = await adminClient
          .from('users')
          .select('id')
          .eq('phone', normalizedPhone)
          .neq('id', userId)
          .maybeSingle()

        if (checkError) {
          console.error('Error checking phone in users table:', checkError)
        }

        if (existingUser) {
          return NextResponse.json(
            { success: false, error: 'This phone number is already registered to another account' },
            { status: 400 }
          )
        }

        // Also check auth.users for duplicate phone (Supabase Auth unique constraint)
        const { data: authUsers, error: authListError } = await adminClient.auth.admin.listUsers({
          page: 1,
          perPage: 1
        })

        // We can't directly query auth.users by phone, so we'll let the update fail gracefully
        // and provide a better error message

        // Update phone in Supabase Auth first
        const { error: authPhoneError } = await adminClient.auth.admin.updateUserById(userId, {
          phone: normalizedPhone,
          phone_confirm: true
        })

        if (authPhoneError) {
          console.error('Auth phone update failed:', authPhoneError)

          // Check for duplicate phone error from Supabase Auth
          const errorMessage = authPhoneError.message.toLowerCase()
          if (errorMessage.includes('duplicate') ||
            errorMessage.includes('already') ||
            errorMessage.includes('unique') ||
            errorMessage.includes('phone')) {
            return NextResponse.json(
              { success: false, error: 'This phone number is already registered. Please use a different number.' },
              { status: 400 }
            )
          }

          return NextResponse.json(
            { success: false, error: `Failed to update phone: ${authPhoneError.message}` },
            { status: 500 }
          )
        }

        updateData.phone = normalizedPhone
        // A changed number is not a verified number: phone_verified_at is
        // cleared by the database on change and set only by an OTP flow.
      } else {
        // Clearing phone
        const { error: authPhoneError } = await adminClient.auth.admin.updateUserById(userId, {
          phone: '',
          phone_confirm: false
        })

        if (authPhoneError) {
          console.error('Auth phone clear failed:', authPhoneError)
        }

        updateData.phone = null
        updateData.phone_verified_at = null
      }
    }

    // Handle Bank Details Update
    if (bank_id !== undefined || bank_account_number !== undefined || bank_account_holder_name !== undefined) {
      Object.assign(updateData, buildPersonalBankUpdateData({
        bankId: bank_id,
        bankAccountNumber: bank_account_number,
        bankAccountHolderName: bank_account_holder_name,
      }))

      const nextBankId = updateData.bank_id ?? null
      const nextBankAccountNumber = updateData.bank_account_number ?? null
      const nextBankAccountHolderName = updateData.bank_account_holder_name ?? null
      const hasAnyBankDetails = Boolean(nextBankId || nextBankAccountNumber || nextBankAccountHolderName)

      if (hasAnyBankDetails) {
        if (!nextBankId || !nextBankAccountNumber) {
          return NextResponse.json(
            { success: false, error: 'Please select a bank and enter a valid personal bank account number.' },
            { status: 400 }
          )
        }

        if (!nextBankAccountHolderName) {
          return NextResponse.json(
            { success: false, error: 'Please enter your personal bank account holder name.' },
            { status: 400 }
          )
        }

        const { data: bankRule, error: bankRuleError } = await adminClient
          .from('msia_banks')
          .select('id, short_name, min_account_length, max_account_length, is_numeric_only, is_active')
          .eq('id', nextBankId)
          .maybeSingle()

        if (bankRuleError) {
          console.error('Error validating personal bank details:', bankRuleError)
          return NextResponse.json(
            { success: false, error: 'Failed to validate the selected bank.' },
            { status: 500 }
          )
        }

        if (!validateMsiaBankAccount(bankRule, nextBankAccountNumber)) {
          return NextResponse.json(
            { success: false, error: 'Invalid bank account number for the selected bank.' },
            { status: 400 }
          )
        }
      }
    }

    // Handle address update
    if (address !== undefined) {
      // Validate address length (max 255 characters)
      if (address && address.length > 255) {
        return NextResponse.json(
          { success: false, error: 'Address must be 255 characters or less' },
          { status: 400 }
        )
      }
      updateData.address = address?.trim() || null
    }

    // Handle shop_name update
    if (shop_name !== undefined) {
      updateData.shop_name = shop_name?.trim() || null
    }

    // Handle referral_phone update
    if (referral_phone !== undefined) {
      const trimmedReferral = referral_phone?.trim() || ''
      updateData.referral_phone = trimmedReferral ? normalizePhone(trimmedReferral) : null
    }

    let canonicalReferenceUserId: string | null = null
    if (reference_user_id !== undefined) {
      canonicalReferenceUserId = reference_user_id?.trim() || null
    }

    if (canonicalReferenceUserId) {
      const { data: referenceUser, error: referenceError } = await adminClient
        .from('users')
        .select('id, phone, can_be_reference, is_active')
        .eq('id', canonicalReferenceUserId)
        .maybeSingle()

      if (referenceError || !referenceUser) {
        return NextResponse.json(
          { success: false, error: 'Selected reference could not be found.' },
          { status: 400 }
        )
      }

      updateData.referral_phone = referenceUser.phone || null
    } else if (reference_user_id !== undefined && !canonicalReferenceUserId) {
      updateData.referral_phone = null
    }

    if (shop_name !== undefined || referral_phone !== undefined || reference_user_id !== undefined) {
      const { data: existingUser, error: existingUserError } = await adminClient
        .from('users')
        .select(`
          organization_id,
          shop_name,
          referral_phone,
          organizations!fk_users_organization(org_type_code)
        `)
        .eq('id', userId)
        .single()

      if (existingUserError) {
        return NextResponse.json(
          { success: false, error: 'Failed to resolve current profile state' },
          { status: 500 }
        )
      }

      const nextOrganizationId = existingUser?.organization_id || null
      const nextShopName = updateData.shop_name !== undefined
        ? updateData.shop_name
        : existingUser?.shop_name || null
      const nextReferralPhone = updateData.referral_phone !== undefined
        ? updateData.referral_phone
        : existingUser?.referral_phone || null

      let nextOrganizationTypeCode = (existingUser?.organizations as any)?.org_type_code || null

      if (!nextOrganizationId) {
        nextOrganizationTypeCode = null
      }

      if (nextShopName && !nextOrganizationId) {
        return NextResponse.json(
          { success: false, error: 'Please select a valid shop organization before saving this shop.' },
          { status: 400 }
        )
      }

      const linkValidation = await resolveProfileLinkValidation(adminClient, {
        organizationId: nextOrganizationId,
        shopName: nextShopName,
        referralPhone: nextReferralPhone,
        referenceUserId: canonicalReferenceUserId,
      })

      if (nextShopName && linkValidation.invalidShop) {
        return NextResponse.json(
          { success: false, error: 'Selected shop must be linked to an active shop organization.' },
          { status: 400 }
        )
      }

      if (nextReferralPhone && linkValidation.invalidReference) {
        return NextResponse.json(
          { success: false, error: 'Selected reference must be an active eligible reference.' },
          { status: 400 }
        )
      }

      if (hasLinkedShopProfile({
        organization_id: nextOrganizationId,
        organizationTypeCode: nextOrganizationTypeCode,
        shop_name: nextShopName,
        referral_phone: nextReferralPhone,
        isShopLinkValid: linkValidation.isShopLinkValid,
        isReferenceLinkValid: linkValidation.isReferenceLinkValid,
      })) {
        updateData.consumer_claim_confirmed_at = null
      }
    }

    // Update database
    if (Object.keys(updateData).length > 0) {
      updateData.updated_at = new Date().toISOString()

      const { error: dbError } = await adminClient
        .from('users')
        .update(updateData)
        .eq('id', userId)

      if (dbError) {
        console.error('Database update error:', dbError)
        return NextResponse.json(
          { success: false, error: `Failed to update profile: ${dbError.message}` },
          { status: 500 }
        )
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Profile updated successfully'
    })

  } catch (error: any) {
    console.error('Error updating profile:', error)
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}
