import { authorizeOperation, organizationResource } from '@/lib/security-access/operation'
import { targetProtectionAllows } from '@/lib/security-access/scope'
import { USER_PASSWORD_RESET_PERMISSION } from '@/lib/security-access/user-admin-catalog'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { referenceHeaders, reportServerError } from '@/lib/system-logs/server'

const extractRoleLevel = (roleRelation: { role_level?: number | null } | Array<{ role_level?: number | null }> | null | undefined) => {
  if (Array.isArray(roleRelation)) {
    const nestedRoleLevel = roleRelation[0]?.role_level
    return typeof nestedRoleLevel === 'number' ? nestedRoleLevel : null
  }

  return typeof roleRelation?.role_level === 'number' ? roleRelation.role_level : null
}

/**
 * Reset user password (administrative reset; separate from a user changing their own password).
 *
 * Security:
 * - Requires a valid authentication session.
 * - Authority is the Security & Access permission platform.user.password_reset, decided for the TARGET user's
 *   organization (loaded by the server, never taken from the request). Editing profiles or opening User Management
 *   (platform.user.manage / platform.user.profile_edit) does not authorize it. Until the permission is enforced, the
 *   historical rule decides: HQ Admin, role level exactly 10.
 * - Target protection is unchanged: a higher-privilege account cannot be reset (platform.identity_access.manage).
 * - The new password is only ever passed to the Supabase Admin API. It is never logged, stored or put in the audit row.
 * - Success, failure and denial are recorded in audit_logs without any password value.
 */
export async function POST(request: NextRequest) {
  let actorId: string | null = null
  try {
    const supabase = await createClient()

    // Verify authentication
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser()

    if (authError || !authUser) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized - Please log in' },
        { status: 401 }
      )
    }
    actorId = authUser.id

    const supabaseAdmin = createAdminClient()
    const { data: currentUserProfile, error: profileError } = await supabaseAdmin
      .from('users')
      .select('id, email, organization_id, roles(role_level)')
      .eq('id', authUser.id)
      .single()
    const currentUserLevel = extractRoleLevel((currentUserProfile as any)?.roles)

    if (profileError || !currentUserProfile) {
      return NextResponse.json(
        { success: false, error: 'Failed to fetch user profile' },
        { status: 403 }
      )
    }

    // Parse request body
    const body = await request.json().catch(() => null)
    const user_id = body?.user_id
    const new_password = body?.new_password

    if (typeof user_id !== 'string' || typeof new_password !== 'string' || !user_id.trim() || !new_password) {
      return NextResponse.json(
        { success: false, error: 'user_id and new_password are required' },
        { status: 400 }
      )
    }

    // The target is loaded first: the authority is judged in the target's organization.
    const { data: targetUser, error: targetError } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name, role_code, organization_id, roles(role_level)')
      .eq('id', user_id)
      .single()

    // Audit metadata deliberately excludes the password.
    const audit = async (action: 'PASSWORD_RESET' | 'PASSWORD_RESET_FAILED', newValues: Record<string, unknown>) => {
      const { error: auditError } = await supabaseAdmin.from('audit_logs').insert({
        user_id: authUser.id,
        user_email: currentUserProfile.email || authUser.email || null,
        action,
        entity_type: 'user',
        entity_id: user_id,
        changed_fields: ['password'],
        new_values: { reset_by_admin: true, ...newValues },
        user_agent: request.headers.get('user-agent'),
      })
      if (auditError) console.error('Password reset audit log error:', auditError.message)
    }

    // A missing target is judged in the administrator's own organization, so existence is not revealed to someone without authority.
    const decision = await authorizeOperation({
      actorId: authUser.id,
      permission: USER_PASSWORD_RESET_PERMISSION,
      resource: organizationResource('user', targetUser ? (targetUser as any).organization_id : (currentUserProfile as any).organization_id),
      legacy: () => currentUserLevel === 10,
    }).catch(() => null)
    if (!decision) {
      return NextResponse.json({ success: false, error: 'Authorization service unavailable' }, { status: 503 })
    }
    if (decision.decision !== 'ALLOW') {
      if (targetUser) await audit('PASSWORD_RESET_FAILED', { reason: 'not_authorized', decision_id: decision.decisionId ?? null })
      return NextResponse.json(
        { success: false, error: 'Forbidden - You are not authorized to reset this user\'s password', code: 'sa_forbidden', permission: USER_PASSWORD_RESET_PERMISSION, decisionId: decision.decisionId, reason: decision.reasonCode },
        { status: 403 }
      )
    }

    if (targetError || !targetUser) {
      return NextResponse.json(
        { success: false, error: 'User not found' },
        { status: 404 }
      )
    }

    // Validate password length
    if (new_password.length < 8) {
      return NextResponse.json(
        { success: false, error: 'Password must be at least 8 characters' },
        { status: 400 }
      )
    }

    const targetUserLevel = extractRoleLevel((targetUser as any).roles)
    // Target protection: once platform.identity_access.manage is enforced the
    // actor must hold every grant the target holds (sa_actor_dominates); until
    // then the historical "not a higher legacy role" rule decides.
    if (!(await targetProtectionAllows(authUser.id, user_id, 'platform.identity_access.manage', () => !(
      typeof currentUserLevel === 'number' &&
      typeof targetUserLevel === 'number' &&
      targetUserLevel < currentUserLevel
    )))) {
      await audit('PASSWORD_RESET_FAILED', { reason: 'target_protected' })
      return NextResponse.json(
        { success: false, error: 'Access denied - You cannot reset the password for a higher-privilege user' },
        { status: 403 }
      )
    }

    // Use the admin updateUserById method to change password
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      user_id,
      { password: new_password }
    )

    if (updateError) {
      // Only the error's own code/status are logged: never the request body.
      console.error('Password reset error:', { code: (updateError as any).code ?? null, status: (updateError as any).status ?? null })
      await audit('PASSWORD_RESET_FAILED', { reason: 'auth_update_failed', error_code: (updateError as any).code ?? null })
      // System Logs diagnostic (the outcome itself is the audit row above). Fixed message: never the request body.
      const referenceId = await reportServerError({
        message: 'Auth admin password update failed', code: (updateError as any).code ?? null, status: (updateError as any).status ?? 500,
        module: 'User Management', action: 'Administrative password reset', apiRoute: '/api/users/reset-password', method: 'POST',
        actorId, details: { target_user_id: user_id },
      })
      return NextResponse.json(
        { success: false, error: `Failed to reset password: ${updateError.message}`, referenceId },
        { status: 500, headers: referenceHeaders(referenceId) }
      )
    }

    await audit('PASSWORD_RESET', {})

    return NextResponse.json({
      success: true,
      message: `Password reset successfully for ${targetUser.full_name}`
    })

  } catch (error: any) {
    console.error('Password reset API error:', error?.message ?? 'unknown error')
    const referenceId = await reportServerError({
      error: { name: error?.name, message: error?.message, stack: error?.stack }, status: 500, category: 'unexpected',
      module: 'User Management', action: 'Administrative password reset', apiRoute: '/api/users/reset-password', method: 'POST',
      actorId,
    })
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error', referenceId },
      { status: 500, headers: referenceHeaders(referenceId) }
    )
  }
}
