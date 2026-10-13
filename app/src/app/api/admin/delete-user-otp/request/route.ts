import { guardUserOperation } from '@/lib/security-access/operation'
import { authorizeIdentityRemoval } from '@/lib/identity/removal-authorization'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { identityHistoryReferences } from '@/lib/identity/provisioning'
import { generateOtp, hashOtp } from '@/server/auth/passwordResetService'
import { maskEmail } from '@/lib/auth/registration-otp-email'
import { maskPhone, normalizePhoneE164 } from '@/utils/phone'
import { DELETE_USER_OTP_EVENT } from '@/lib/notifications/notificationEventCatalog'
import { deliveryChainForPreset, resolveDeleteUserOtpPreset } from '@/lib/notifications/routing'
import {
    OTP_EXPIRY_MINUTES,
    describeOtpSendFailure,
    sendTransactionalOtp,
} from '@/lib/notifications/transactional-otp-router'

const PURPOSE = 'user_deletion'
const MAX_SENDS_PER_15MIN = 3
type UserRemovalMode = 'delete' | 'archive'

async function getUserRemovalMode(_admin: any, userId: string): Promise<UserRemovalMode> {
    // Same definition of "history" as the confirmation step and the database
    // delete guard (public.identity_history_references): orders, documents,
    // signatures, Supply Chain movements, finance and audit references all
    // mean archive. A failed check never falls through to hard deletion.
    const references = await identityHistoryReferences(userId)
    if (references === null) return 'archive'
    return references.length > 0 ? 'archive' : 'delete'
}

function normalizeOrgEmail(email: string | null | undefined): string | null {
    const value = String(email || '').trim().toLowerCase()
    if (!value || !value.includes('@')) return null
    return value
}

/**
 * POST /api/admin/delete-user-otp/request
 *
 * Step 1: HQ Admin or Super Admin requests a deletion OTP.
 * Delivery follows Notifications → Types routing for delete_user_otp.
 * Missing settings keep the original WhatsApp → SMS → Email chain.
 * Recipient is always the organization contact phone/email.
 */
export async function POST(request: NextRequest) {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null
    const ua = request.headers.get('user-agent') || null

    try {
        const supabase = await createClient()
        const admin = createAdminClient()
        const db: any = admin

        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const saDenied = await guardUserOperation(user.id, 'platform.data.destructive')
        if (saDenied) return saDenied

        const { targetUserId } = await request.json().catch(() => ({}))

        // Archive Identities (platform.identity.delete), decided for the
        // target's organization, with self and target protection; the
        // historical HQ Admin / Super Admin rule is the legacy evaluator.
        const removal = await authorizeIdentityRemoval(user.id, targetUserId)
        if (!removal.ok) {
            if (removal.status === 403) {
                await logDeletionAudit(admin, {
                    operation: 'delete_user_otp_request',
                    userId: user.id,
                    userEmail: user.email || null,
                    allowed: false,
                    reason: removal.auditReason,
                    ip,
                })
            }
            return NextResponse.json(
                { success: false, error: removal.error, code: removal.code, ...(removal.decisionId ? { decisionId: removal.decisionId } : {}) },
                { status: removal.status }
            )
        }

        const orgId = removal.actorOrganizationId
        if (!orgId) {
            return NextResponse.json(
                { error: 'No organization found. OTP cannot be sent.' },
                { status: 400 }
            )
        }

        const { data: org } = await admin
            .from('organizations')
            .select('contact_phone, contact_email, org_name')
            .eq('id', orgId)
            .single()

        const phoneForSend = org?.contact_phone ? normalizePhoneE164(org.contact_phone) : null
        const emailForSend = normalizeOrgEmail(org?.contact_email)

        const { data: notificationSetting } = await db
            .from('notification_settings')
            .select('enabled, channels_enabled, templates, recipient_config')
            .eq('org_id', orgId)
            .eq('event_code', DELETE_USER_OTP_EVENT)
            .maybeSingle()

        const preset = resolveDeleteUserOtpPreset(notificationSetting)
        const chain = deliveryChainForPreset(preset)
        const needsPhone = chain.includes('whatsapp') || chain.includes('sms')
        const emailOnly = chain.length === 1 && chain[0] === 'email'

        if (needsPhone && !phoneForSend) {
            return NextResponse.json(
                { error: 'Organization phone not configured. Set it in Settings > Organization.' },
                { status: 400 }
            )
        }
        if (emailOnly && !emailForSend) {
            return NextResponse.json(
                { error: 'Organization contact email is not configured. Set it in Settings > Organization.' },
                { status: 400 }
            )
        }

        const since = new Date(Date.now() - 15 * 60 * 1000).toISOString()
        let rateQuery = db
            .from('notification_events')
            .select('id', { count: 'exact', head: true })
            .eq('purpose', PURPOSE)
            .eq('event_type', 'delete_user_otp_requested')
            .gte('created_at', since)

        if (phoneForSend && emailForSend) {
            rateQuery = rateQuery.or(`recipient_phone.eq.${phoneForSend},recipient_email.eq.${emailForSend}`)
        } else if (emailForSend) {
            rateQuery = rateQuery.eq('recipient_email', emailForSend)
        } else if (phoneForSend) {
            rateQuery = rateQuery.eq('recipient_phone', phoneForSend)
        }

        const { count } = await rateQuery
        if ((count ?? 0) >= MAX_SENDS_PER_15MIN) {
            return NextResponse.json(
                { error: 'Too many OTP requests. Please wait before trying again.' },
                { status: 429 }
            )
        }

        const targetUser = removal.target
        const removalMode = await getUserRemovalMode(admin, targetUserId)
        const targetLabel = targetUser.full_name || targetUser.email || targetUserId

        if (phoneForSend) {
            await db
                .from('auth_verification_codes')
                .update({ invalidated_at: new Date().toISOString() })
                .eq('phone_normalized', phoneForSend)
                .eq('purpose', PURPOSE)
                .is('invalidated_at', null)
                .is('used_at', null)
        }
        if (emailForSend) {
            await db
                .from('auth_verification_codes')
                .update({ invalidated_at: new Date().toISOString() })
                .eq('email_normalized', emailForSend)
                .eq('purpose', PURPOSE)
                .is('invalidated_at', null)
                .is('used_at', null)
        }

        const code = generateOtp()
        const codeHash = hashOtp(code)
        const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString()

        const { data: codeRow, error: codeError } = await db
            .from('auth_verification_codes')
            .insert({
                purpose: PURPOSE,
                channel: chain[0],
                phone_normalized: phoneForSend || '',
                email_normalized: emailForSend,
                user_id: user.id,
                code_hash: codeHash,
                expires_at: expiresAt,
                max_attempts: 5,
                request_ip: ip,
                request_user_agent: ua,
                meta: {
                    target_user_id: targetUserId,
                    target_user_name: targetUser.full_name,
                    target_user_email: targetUser.email,
                    routing_preset: preset,
                },
            })
            .select('id')
            .single()

        if (codeError) {
            console.error('Failed to create OTP:', codeError)
            return NextResponse.json({ error: 'Failed to create verification code' }, { status: 500 })
        }

        const sendResult = await sendTransactionalOtp({
            admin,
            orgId,
            setting: notificationSetting,
            phone: phoneForSend,
            email: emailForSend,
            vars: {
                verification_code: code,
                target_user_name: String(targetLabel),
                requester_email: user.email || 'unknown',
                otp_expiry_minutes: OTP_EXPIRY_MINUTES,
            },
        })

        if (!sendResult.success || !sendResult.channel) {
            await db
                .from('auth_verification_codes')
                .update({ invalidated_at: new Date().toISOString() })
                .eq('id', codeRow.id)

            return NextResponse.json({
                error: describeOtpSendFailure(sendResult),
                whatsappError: sendResult.errors.whatsapp || null,
                smsError: sendResult.errors.sms || null,
                emailError: sendResult.errors.email || null,
                preset: sendResult.preset,
            }, { status: 500 })
        }

        const channel = sendResult.channel
        await db
            .from('auth_verification_codes')
            .update({
                channel,
                meta: {
                    target_user_id: targetUserId,
                    target_user_name: targetUser.full_name,
                    target_user_email: targetUser.email,
                    delivery_channel: channel,
                    routing_preset: sendResult.preset,
                    whatsapp_error: sendResult.errors.whatsapp || null,
                    sms_error: sendResult.errors.sms || null,
                },
            })
            .eq('id', codeRow.id)

        const maskedPhone = phoneForSend ? maskPhone(phoneForSend) : null
        const maskedRecipient = channel === 'email' && emailForSend
            ? maskEmail(emailForSend)
            : (maskedPhone || (emailForSend ? maskEmail(emailForSend) : 'organization contact'))

        await db.from('notification_events').insert({
            channel,
            provider: sendResult.provider || channel,
            event_type: 'delete_user_otp_requested',
            purpose: PURPOSE,
            recipient_email: channel === 'email' ? emailForSend : null,
            recipient_phone: phoneForSend,
            user_id: user.id,
            status: 'sent',
            meta: {
                target_user_id: targetUserId,
                target_user_name: targetUser.full_name,
                code_id: codeRow.id,
                delivery_channel: channel,
                routing_preset: sendResult.preset,
                fallback_used: sendResult.fallbackUsed,
                whatsapp_error: sendResult.errors.whatsapp || null,
                sms_error: sendResult.errors.sms || null,
            },
            request_ip: ip,
            requested_at: new Date().toISOString(),
            sent_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
        })

        const deliveryReason = channel === 'email'
            ? `OTP emailed to org contact (${sendResult.preset}) for deleting ${targetLabel}`
            : channel === 'sms'
                ? `OTP sent via SMS (${sendResult.preset}) for deleting ${targetLabel}`
                : `OTP sent to org phone (${sendResult.preset}) for deleting ${targetLabel}`

        await logDeletionAudit(admin, {
            operation: 'delete_user_otp_request',
            userId: user.id,
            userEmail: user.email || null,
            allowed: true,
            reason: deliveryReason,
            ip,
        })

        const successMessage = sendResult.fallbackUsed
            ? `Primary delivery failed, so the verification code was sent via ${channel === 'sms' ? 'SMS' : channel} to ${maskedRecipient}`
            : `Verification code sent to ${maskedRecipient}`

        return NextResponse.json({
            success: true,
            message: successMessage,
            channel,
            preset: sendResult.preset,
            fallbackUsed: sendResult.fallbackUsed,
            maskedPhone,
            maskedEmail: channel === 'email' && emailForSend ? maskEmail(emailForSend) : null,
            maskedRecipient,
            codeId: codeRow.id,
            removalMode,
        })
    } catch (err: any) {
        console.error('Delete OTP request error:', err)
        return NextResponse.json({
            error: 'Unable to send the verification code. Check WhatsApp/SMS/email delivery configuration and try again.',
        }, { status: 500 })
    }
}

async function logDeletionAudit(
    admin: any,
    entry: { operation: string; userId: string; userEmail: string | null; allowed: boolean; reason: string; ip: string | null }
) {
    const prefix = entry.allowed ? '✅ DELETE-OP ALLOWED' : '🚫 DELETE-OP BLOCKED'
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
    } catch { /* best effort */ }
}
