import { guardUserOperation } from '@/lib/security-access/operation'
import { authorizeOrganizationIdentityRemoval } from '@/lib/identity/removal-authorization'
import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { hashOtp } from '@/server/auth/passwordResetService'
import { DELETE_ORGANIZATION_EVENT_CODE } from '@/lib/notifications/organization-delete-verification'

export const dynamic = 'force-dynamic'

const PURPOSE = 'organization_deletion'

function getJoinedRole(profile: any) {
  return Array.isArray(profile?.roles) ? profile.roles[0] : profile?.roles
}

function getRoleLevel(profile: any) {
  const rawLevel = getJoinedRole(profile)?.role_level
  const roleLevel = typeof rawLevel === 'number' ? rawLevel : Number(rawLevel)

  return Number.isFinite(roleLevel) ? roleLevel : null
}

function getRoleCodes(profile: any) {
  const joinedRole = getJoinedRole(profile)

  return [profile?.role_code, joinedRole?.role_code]
    .filter(Boolean)
    .map((code) => String(code).trim().toLowerCase())
}

function canDeleteOrganizations(profile: any) {
  const roleLevel = getRoleLevel(profile)
  const roleCodes = getRoleCodes(profile)

  return (roleLevel !== null && roleLevel <= 10) ||
    roleCodes.some((roleCode) => ['super_admin', 'superadmin', 'sa', 'super', 'hq_admin', 'hq', 'admin_hq'].includes(roleCode))
}

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null

  try {
    const supabase = await createClient()
    const admin = createAdminClient()
    const db: any = admin

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile, error: profileError } = await admin
      .from('users')
      .select('organization_id, role_code, roles(role_level, role_code)')
      .eq('id', user.id)
      .single()

    // Deleting an organization is an S&A decision (platform.data.destructive);
    // the historical HQ Admin / Super Admin rule is the legacy evaluator.
    const saDenied = await guardUserOperation(user.id, 'platform.data.destructive', {
      legacy: () => canDeleteOrganizations(profile),
    })
    if (saDenied) return saDenied
    if (profileError || !profile) {
      return NextResponse.json({ error: 'Access denied. HQ Admin or Super Admin only.' }, { status: 403 })
    }

    const { orgId, code, codeId } = await request.json()
    if (!orgId || !code || !codeId) {
      return NextResponse.json({ error: 'orgId, code, and codeId are required' }, { status: 400 })
    }

    if (orgId === profile?.organization_id) {
      return NextResponse.json({ error: 'Cannot delete your current organization.' }, { status: 400 })
    }

    // Deleting the organization deletes its member identities: each one is
    // Archive Identities (platform.identity.delete) with target protection,
    // decided now (at submission) before the code is checked or consumed.
    const memberRemoval = await authorizeOrganizationIdentityRemoval(user.id, orgId)
    if (!memberRemoval.ok) {
      if (memberRemoval.status === 403) {
        await logOrganizationDeletionAudit(admin, {
          operation: 'delete_organization_execute',
          userId: user.id,
          userEmail: user.email || null,
          allowed: false,
          reason: memberRemoval.auditReason,
          ip,
        })
      }
      return NextResponse.json(
        { error: memberRemoval.error, code: memberRemoval.code, ...(memberRemoval.decisionId ? { decisionId: memberRemoval.decisionId } : {}) },
        { status: memberRemoval.status },
      )
    }

    const { data: codeRow } = await db
      .from('auth_verification_codes')
      .select('*')
      .eq('id', codeId)
      .eq('purpose', PURPOSE)
      .is('invalidated_at', null)
      .is('used_at', null)
      .single()

    if (!codeRow) {
      return NextResponse.json({ error: 'Invalid or expired verification code. Please request a new one.' }, { status: 400 })
    }

    if (new Date(codeRow.expires_at) < new Date()) {
      return NextResponse.json({ error: 'Verification code expired. Please request a new one.' }, { status: 400 })
    }

    if (codeRow.attempt_count >= codeRow.max_attempts) {
      await db
        .from('auth_verification_codes')
        .update({ invalidated_at: new Date().toISOString() })
        .eq('id', codeId)

      return NextResponse.json({ error: 'Too many incorrect attempts. Please request a new code.' }, { status: 400 })
    }

    await db
      .from('auth_verification_codes')
      .update({ attempt_count: (codeRow.attempt_count || 0) + 1 })
      .eq('id', codeId)

    if (hashOtp(code) !== codeRow.code_hash) {
      const remaining = codeRow.max_attempts - (codeRow.attempt_count || 0) - 1
      return NextResponse.json(
        { error: `Incorrect code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` },
        { status: 400 },
      )
    }

    const meta = codeRow.meta || {}
    if (meta.target_org_id && meta.target_org_id !== orgId) {
      return NextResponse.json({ error: 'Organization mismatch. Please request a new code.' }, { status: 400 })
    }

    if (codeRow.user_id && codeRow.user_id !== user.id) {
      return NextResponse.json({ error: 'This code was requested by a different admin.' }, { status: 403 })
    }

    const { data: dependencyCheck, error: dependencyError } = await admin
      .rpc('check_organization_dependencies', { p_org_id: orgId })

    if (dependencyError) {
      console.error('check_organization_dependencies RPC error before delete:', dependencyError)
      return NextResponse.json({ error: 'Failed to verify organization dependencies.' }, { status: 500 })
    }

    if (!dependencyCheck?.can_delete) {
      await logOrganizationDeletionAudit(admin, {
        operation: 'delete_organization_execute',
        userId: user.id,
        userEmail: user.email || null,
        allowed: false,
        reason: `Dependency check blocked delete for ${orgId}`,
        ip,
      })
      return NextResponse.json(
        { error: dependencyCheck?.error || 'Organization has blocking dependencies and cannot be deleted.' },
        { status: 400 },
      )
    }

    await db
      .from('auth_verification_codes')
      .update({ used_at: new Date().toISOString(), verified_at: new Date().toISOString() })
      .eq('id', codeId)

    const { data: targetOrg } = await admin
      .from('organizations')
      .select('org_name, org_code')
      .eq('id', orgId)
      .single()

    const { data, error } = await admin.rpc('hard_delete_organization', { p_org_id: orgId })

    if (error) {
      console.error('hard_delete_organization RPC error after OTP verification:', error)
      await logOrganizationDeletionAudit(admin, {
        operation: 'delete_organization_execute',
        userId: user.id,
        userEmail: user.email || null,
        allowed: true,
        reason: `RPC delete failed for ${targetOrg?.org_name || orgId}: ${error.message}`,
        ip,
      })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    await logOrganizationDeletionAudit(admin, {
      operation: 'delete_organization_execute',
      userId: user.id,
      userEmail: user.email || null,
      allowed: Boolean(data?.success),
      reason: data?.success
        ? `Organization deleted: ${targetOrg?.org_name || orgId}`
        : `Deletion blocked after OTP: ${data?.error || 'Unknown reason'}`,
      ip,
    })

    await admin.from('notification_events').insert({
      channel: codeRow.channel,
      event_type: data?.success ? 'delete_organization_completed' : 'delete_organization_blocked',
      purpose: PURPOSE,
      recipient_phone: codeRow.phone_normalized || null,
      recipient_email: codeRow.email_normalized || null,
      user_id: user.id,
      related_entity_type: 'organization',
      related_entity_id: orgId,
      status: data?.success ? 'completed' : 'blocked',
      completed_at: data?.success ? new Date().toISOString() : null,
      meta: {
        notification_event_code: DELETE_ORGANIZATION_EVENT_CODE,
        target_org_id: orgId,
        target_org_name: targetOrg?.org_name,
        target_org_code: targetOrg?.org_code,
        result: data,
      },
      request_ip: ip,
    })

    return NextResponse.json(data)
  } catch (error: any) {
    console.error('Organization delete verify error:', error)
    return NextResponse.json({ error: 'Unable to verify the code or delete the organization. Please try again; if the issue continues, contact an administrator.' }, { status: 500 })
  }
}

async function logOrganizationDeletionAudit(
  admin: any,
  entry: { operation: string; userId: string; userEmail: string | null; allowed: boolean; reason: string; ip: string | null }
) {
  const prefix = entry.allowed ? '✅ ORG-DELETE' : '🚫 ORG-DELETE BLOCKED'
  console.log(`${prefix} | op=${entry.operation} | user=${entry.userEmail ?? entry.userId} | reason=${entry.reason}`)

  try {
    await admin.from('destructive_ops_audit_log').insert({
      operation: entry.operation,
      user_id: entry.userId,
      user_email: entry.userEmail,
      allowed: entry.allowed,
      reason: entry.reason,
      ip_address: entry.ip,
      created_at: new Date().toISOString(),
    })
  } catch {
    // best effort
  }
}
