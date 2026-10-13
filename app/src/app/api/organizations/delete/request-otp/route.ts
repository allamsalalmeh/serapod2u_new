import { guardUserOperation } from '@/lib/security-access/operation'
import { authorizeOrganizationIdentityRemoval } from '@/lib/identity/removal-authorization'
import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  generateOtp,
  hashOtp,
} from '@/server/auth/passwordResetService'
import {
  buildDeleteOrganizationMessage,
  DELETE_ORGANIZATION_EVENT_CODE,
  DeleteVerificationConfigurationError,
  deliverDeleteVerification,
  resolveDeleteVerificationPreset,
} from '@/lib/notifications/organization-delete-verification'
import { normalizePhoneE164 } from '@/utils/phone'

export const dynamic = 'force-dynamic'

const PURPOSE = 'organization_deletion'
const MAX_SENDS_PER_15MIN = 3

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
  const userAgent = request.headers.get('user-agent') || null

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

    const roleLevel = getRoleLevel(profile)
    // Organization deletion is an S&A decision (platform.organization.manage);
    // the historical HQ Admin / Super Admin rule is the legacy evaluator.
    const saDenied = await guardUserOperation(user.id, 'platform.organization.manage', {
      legacy: () => canDeleteOrganizations(profile),
    })
    if (profileError || saDenied) {
      await logOrganizationDeletionAudit(admin, {
        operation: 'delete_organization_otp_request',
        userId: user.id,
        userEmail: user.email || null,
        allowed: false,
        reason: profileError
          ? `Profile lookup failed: ${profileError.message}`
          : `Security & Access denied platform.organization.manage (legacy role_level=${roleLevel}, role_code=${getRoleCodes(profile).join(',') || 'null'})`,
        ip,
      })
      return saDenied ?? NextResponse.json({ error: 'Access denied. HQ Admin or Super Admin only.' }, { status: 403 })
    }

    const { orgId } = await request.json()
    if (!orgId || typeof orgId !== 'string') {
      return NextResponse.json({ error: 'orgId is required' }, { status: 400 })
    }

    if (orgId === profile?.organization_id) {
      return NextResponse.json({ error: 'Cannot delete your current organization.' }, { status: 400 })
    }

    const { data: targetOrg } = await admin
      .from('organizations')
      .select('id, org_name, org_code')
      .eq('id', orgId)
      .single()

    if (!targetOrg) {
      return NextResponse.json({ error: 'Organization not found.' }, { status: 404 })
    }

    const { data: dependencyCheck, error: dependencyError } = await admin
      .rpc('check_organization_dependencies', { p_org_id: orgId })

    if (dependencyError) {
      console.error('check_organization_dependencies RPC error before OTP:', dependencyError)
      return NextResponse.json({ error: 'Failed to verify organization dependencies.' }, { status: 500 })
    }

    if (!dependencyCheck?.can_delete) {
      return NextResponse.json(
        { error: dependencyCheck?.error || 'Organization has blocking dependencies and cannot be deleted.' },
        { status: 400 },
      )
    }

    // Its member identities are deleted with it: refuse before sending a code
    // when any of them may not be removed by this administrator (re-decided
    // at verify-and-delete).
    const memberRemoval = await authorizeOrganizationIdentityRemoval(user.id, orgId)
    if (!memberRemoval.ok) {
      if (memberRemoval.status === 403) {
        await logOrganizationDeletionAudit(admin, {
          operation: 'delete_organization_otp_request',
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

    const currentOrgId = profile?.organization_id
    if (!currentOrgId) {
      return NextResponse.json({ error: 'No organization found. OTP cannot be sent.' }, { status: 400 })
    }

    const [{ data: currentOrg }, { data: notificationType }, { data: notificationSetting }] = await Promise.all([
      admin
      .from('organizations')
      .select('contact_phone, contact_email, org_name')
      .eq('id', currentOrgId)
      .single(),
      admin
        .from('notification_types')
        .select('event_code, available_channels')
        .eq('event_code', DELETE_ORGANIZATION_EVENT_CODE)
        .maybeSingle(),
      admin
        .from('notification_settings')
        .select('enabled, channels_enabled, recipient_config')
        .eq('org_id', currentOrgId)
        .eq('event_code', DELETE_ORGANIZATION_EVENT_CODE)
        .maybeSingle(),
    ])

    if (!notificationType) {
      return NextResponse.json({
        error: 'Delete Organization Verification Code notification type is missing. Apply the latest database migration, then configure Notifications > Notification Types > Delete Organization Masterdata.',
      }, { status: 409 })
    }

    let routingPreset
    try {
      routingPreset = resolveDeleteVerificationPreset(notificationSetting)
    } catch (error) {
      if (error instanceof DeleteVerificationConfigurationError) {
        return NextResponse.json({ error: error.message }, { status: error.status })
      }
      throw error
    }

    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    const { count } = await db
      .from('notification_events')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('purpose', PURPOSE)
      .eq('event_type', 'delete_organization_otp_requested')
      .gte('created_at', since)

    if ((count ?? 0) >= MAX_SENDS_PER_15MIN) {
      return NextResponse.json({ error: 'Too many OTP requests. Please wait before trying again.' }, { status: 429 })
    }

    await db
      .from('auth_verification_codes')
      .update({ invalidated_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .eq('purpose', PURPOSE)
      .is('invalidated_at', null)
      .is('used_at', null)

    const code = generateOtp()
    const codeHash = hashOtp(code)
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

    const message = buildDeleteOrganizationMessage({
      code,
      organizationName: targetOrg.org_name,
      organizationCode: targetOrg.org_code,
      requestedBy: user.email || 'Authorized administrator',
    })

    const candidatePhone = currentOrg?.contact_phone ? normalizePhoneE164(currentOrg.contact_phone) : null
    const candidateEmail = String(currentOrg?.contact_email || user.email || '').trim().toLowerCase() || null
    if (routingPreset === 'sms_only') {
      return NextResponse.json({
        error: 'SMS Only is selected for Delete Organization Verification Code, but SMS verification delivery is not available. Choose Email Only, WhatsApp Only, or WhatsApp > Email.',
      }, { status: 409 })
    }
    if (routingPreset === 'email_only' && !candidateEmail) {
      return NextResponse.json({ error: 'Email delivery is selected, but the current organization and requesting admin have no email address configured.' }, { status: 409 })
    }
    if (routingPreset === 'whatsapp_only' && !candidatePhone) {
      return NextResponse.json({ error: 'WhatsApp delivery is selected, but the current organization has no valid phone number configured in organization master data.' }, { status: 409 })
    }
    if (!candidatePhone && !candidateEmail) {
      return NextResponse.json({ error: 'No valid WhatsApp phone or email recipient is configured for organization deletion verification.' }, { status: 409 })
    }

    const { data: codeRow, error: codeError } = await db
      .from('auth_verification_codes')
      .insert({
        purpose: PURPOSE,
        channel: routingPreset === 'email_only' ? 'email' : 'whatsapp',
        phone_normalized: candidatePhone,
        email_normalized: candidateEmail,
        user_id: user.id,
        code_hash: codeHash,
        expires_at: expiresAt,
        max_attempts: 5,
        request_ip: ip,
        request_user_agent: userAgent,
        meta: {
          target_org_id: orgId,
          target_org_name: targetOrg.org_name,
          target_org_code: targetOrg.org_code,
          notification_event_code: DELETE_ORGANIZATION_EVENT_CODE,
          routing_preset: routingPreset,
        },
      })
      .select('id')
      .single()

    if (codeError) {
      console.error('Failed to create organization delete OTP:', codeError)
      return NextResponse.json({ error: 'Unable to prepare the verification code. Please try again.' }, { status: 500 })
    }

    let delivery
    try {
      delivery = await deliverDeleteVerification({
        admin,
        orgId: currentOrgId,
        preset: routingPreset,
        phone: currentOrg?.contact_phone,
        email: currentOrg?.contact_email || user.email,
        message,
      })
    } catch (error) {
      await db
        .from('auth_verification_codes')
        .update({ invalidated_at: new Date().toISOString() })
        .eq('id', codeRow.id)
      if (error instanceof DeleteVerificationConfigurationError) {
        await logOrganizationNotificationEvent(admin, {
          channel: routingPreset === 'email_only' ? 'email' : routingPreset === 'sms_only' ? 'sms' : 'whatsapp',
          userId: user.id,
          status: 'failed',
          errorMessage: error.message,
          targetOrg,
          ip,
        })
        return NextResponse.json({ error: error.message }, { status: error.status })
      }
      throw error
    }

    const { error: deliveryUpdateError } = await db
      .from('auth_verification_codes')
      .update({
        channel: delivery.channel,
        phone_normalized: delivery.channel === 'whatsapp' ? delivery.recipient : null,
        email_normalized: delivery.channel === 'email' ? delivery.recipient : null,
        meta: {
          target_org_id: orgId,
          target_org_name: targetOrg.org_name,
          target_org_code: targetOrg.org_code,
          notification_event_code: DELETE_ORGANIZATION_EVENT_CODE,
          routing_preset: routingPreset,
          delivery_channel: delivery.channel,
        },
      })
      .eq('id', codeRow.id)

    if (deliveryUpdateError) {
      console.error('Failed to finalize organization delete OTP delivery metadata:', deliveryUpdateError)
    }

    await logOrganizationNotificationEvent(admin, {
      channel: delivery.channel,
      recipientPhone: delivery.channel === 'whatsapp' ? delivery.recipient : null,
      recipientEmail: delivery.channel === 'email' ? delivery.recipient : null,
      provider: delivery.provider,
      providerMessageId: delivery.providerMessageId,
      userId: user.id,
      status: 'sent',
      targetOrg,
      codeId: codeRow.id,
      ip,
    })

    await logOrganizationDeletionAudit(admin, {
      operation: 'delete_organization_otp_request',
      userId: user.id,
      userEmail: user.email || null,
      allowed: true,
      reason: `OTP sent by ${delivery.channel} for deleting ${targetOrg.org_name} (${targetOrg.org_code})`,
      ip,
    })

    return NextResponse.json({
      success: true,
      message: `Verification code sent by ${delivery.channel === 'email' ? 'email' : 'WhatsApp'} to ${delivery.maskedRecipient}`,
      channel: delivery.channel,
      maskedRecipient: delivery.maskedRecipient,
      codeId: codeRow.id,
    })
  } catch (error: any) {
    console.error('Organization delete OTP request error:', error)
    return NextResponse.json({ error: 'Unable to send the organization deletion verification code. Check Notification Types and provider configuration, then try again.' }, { status: 500 })
  }
}

async function logOrganizationNotificationEvent(admin: any, entry: {
  channel: string
  recipientPhone?: string | null
  recipientEmail?: string | null
  provider?: string | null
  providerMessageId?: string | null
  userId: string
  status: string
  errorMessage?: string | null
  targetOrg: { id: string; org_name: string; org_code: string }
  codeId?: string
  ip: string | null
}) {
  try {
    await admin.from('notification_events').insert({
      channel: entry.channel,
      provider: entry.provider || null,
      event_type: 'delete_organization_otp_requested',
      purpose: PURPOSE,
      recipient_phone: entry.recipientPhone || null,
      recipient_email: entry.recipientEmail || null,
      user_id: entry.userId,
      related_entity_type: 'organization',
      related_entity_id: entry.targetOrg.id,
      provider_message_id: entry.providerMessageId || null,
      status: entry.status,
      error_message: entry.errorMessage || null,
      meta: {
        notification_event_code: DELETE_ORGANIZATION_EVENT_CODE,
        target_org_id: entry.targetOrg.id,
        target_org_name: entry.targetOrg.org_name,
        target_org_code: entry.targetOrg.org_code,
        code_id: entry.codeId || null,
      },
      request_ip: entry.ip,
      requested_at: new Date().toISOString(),
      sent_at: entry.status === 'sent' ? new Date().toISOString() : null,
    })
  } catch (error) {
    console.error('Failed to write organization deletion notification audit:', error)
  }
}

async function logOrganizationDeletionAudit(
  admin: any,
  entry: { operation: string; userId: string; userEmail: string | null; allowed: boolean; reason: string; ip: string | null }
) {
  const prefix = entry.allowed ? '✅ ORG-DELETE ALLOWED' : '🚫 ORG-DELETE BLOCKED'
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
