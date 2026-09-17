/**
 * Password Reset OTP Service
 *
 * Collect Points / loyalty: email OTP (generic, non-enumerating).
 * Portal /login forgot-password: email → email OTP, phone → SMS OTP.
 * SMS body comes from Notification Types (password_reset_otp) then the SMS catalog.
 * Unregistered or missing contacts are disclosed so the user can ask an admin.
 *
 * Tables:
 *   - auth_verification_codes
 *   - notification_events
 *   - users
 *   - notification_provider_configs
 */

import crypto from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import { normalizePhoneE164, toProviderPhone } from '@/utils/phone'
import { sendTransactionalHtmlEmail } from '@/lib/email/transactional-html-email'
import {
    buildPasswordResetOtpEmail,
    isValidEmail,
    normalizeEmail,
} from '@/lib/auth/password-reset-otp-email'
import { getSmsTemplateBody } from '@/config/smsTemplates'
import { PASSWORD_RESET_OTP_EVENT } from '@/lib/notifications/notificationEventCatalog'

export const OTP_LENGTH = 4
export const OTP_EXPIRY_MINUTES = 5
export const RESEND_COOLDOWN_SECONDS = 60
export const MAX_SEND_ATTEMPTS_PER_15MIN = 3
export const MAX_VERIFY_ATTEMPTS_PER_OTP = 5
export const MAX_RESEND_PER_15MIN = 5
export const RESET_TOKEN_EXPIRY_MINUTES = 10

const PURPOSE = 'password_reset'
/** Consumer password-reset OTP uses email (Dynamic Config / notification providers). */
export const CHANNEL = 'email' as const
export const SMS_CHANNEL = 'sms' as const
export type PasswordResetChannel = typeof CHANNEL | typeof SMS_CHANNEL
const EMAIL_PROVIDER_FALLBACK = 'email'
const SMS_PROVIDER_FALLBACK = 'local_my'

export const GENERIC_EMAIL_OTP_MESSAGE =
    'If this email exists, we will send a verification code via email.'
export const GENERIC_SMS_OTP_MESSAGE =
    'If this account has a registered phone number, a 4-digit SMS code will arrive shortly.'

export const ADMIN_CONTACT_HELP =
    'Ask your administrator to register and verify your email or phone on the account, then try again.'

export function passwordResetMessageForChannel(channel: PasswordResetChannel): string {
    return channel === SMS_CHANNEL ? GENERIC_SMS_OTP_MESSAGE : GENERIC_EMAIL_OTP_MESSAGE
}

export function sentPasswordResetMessage(channel: PasswordResetChannel): string {
    return channel === SMS_CHANNEL
        ? 'We sent a 4-digit verification code by SMS to this phone number.'
        : 'We sent a 4-digit verification code to this email address.'
}

export function unregisteredPasswordResetMessage(kind: 'email' | 'phone'): string {
    return kind === 'phone'
        ? `This phone number is not registered. ${ADMIN_CONTACT_HELP}`
        : `This email is not registered. ${ADMIN_CONTACT_HELP}`
}

export function missingContactPasswordResetMessage(channel: PasswordResetChannel): string {
    return channel === SMS_CHANNEL
        ? `This account has no verified phone number. ${ADMIN_CONTACT_HELP}`
        : `This account has no verified email address. ${ADMIN_CONTACT_HELP}`
}

export function failedSendPasswordResetMessage(channel: PasswordResetChannel): string {
    return channel === SMS_CHANNEL
        ? `We could not send the SMS code. ${ADMIN_CONTACT_HELP}`
        : `We could not send the email code. ${ADMIN_CONTACT_HELP}`
}

export function generateOtp(): string {
    const num = crypto.randomInt(0, 10000)
    return num.toString().padStart(OTP_LENGTH, '0')
}

export function hashOtp(code: string): string {
    return crypto.createHash('sha256').update(code).digest('hex')
}

export function generateResetToken(): string {
    return crypto.randomBytes(32).toString('base64url')
}

export interface ConsumerLookupResult {
    userId: string
    email: string
    fullName: string | null
    phone: string | null
    organizationId: string | null
}

export async function lookupConsumerByEmail(
    admin: SupabaseClient,
    emailRaw: string,
): Promise<ConsumerLookupResult | null> {
    const email = normalizeEmail(emailRaw)
    if (!isValidEmail(email)) return null

    const { data } = await admin
        .from('users')
        .select('id, email, full_name, phone, organization_id')
        .ilike('email', email)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle()

    if (!data?.email) return null
    return {
        userId: data.id,
        email: normalizeEmail(data.email),
        fullName: data.full_name,
        phone: data.phone ? normalizePhoneE164(data.phone) : null,
        organizationId: data.organization_id || null,
    }
}

/** @deprecated Prefer lookupConsumerByEmail for consumer Collect Points reset. */
export async function lookupConsumerByPhone(
    admin: SupabaseClient,
    phoneRaw: string,
): Promise<ConsumerLookupResult | null> {
    const phone = normalizePhoneE164(phoneRaw)
    const phoneDigits = phone.replace(/^\+/, '')

    let data: any = null
    const { data: d1 } = await admin
        .from('users')
        .select('id, email, full_name, phone, organization_id')
        .eq('phone', phone)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle()
    data = d1

    if (!data) {
        const { data: d2 } = await admin
            .from('users')
            .select('id, email, full_name, phone, organization_id')
            .eq('phone', phoneDigits)
            .eq('is_active', true)
            .limit(1)
            .maybeSingle()
        data = d2
    }

    if (!data) return null
    return {
        userId: data.id,
        email: normalizeEmail(data.email || ''),
        fullName: data.full_name,
        phone,
        organizationId: data.organization_id || null,
    }
}

export async function checkSendRateLimit(
    admin: SupabaseClient,
    email: string,
): Promise<{ allowed: boolean; retryAfterSec?: number }> {
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    const { count } = await admin
        .from('notification_events')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_email', email)
        .eq('purpose', PURPOSE)
        .in('event_type', ['password_reset_otp_requested', 'password_reset_otp_resend'])
        .gte('created_at', since)

    if ((count ?? 0) >= MAX_SEND_ATTEMPTS_PER_15MIN) {
        return { allowed: false, retryAfterSec: 60 }
    }
    return { allowed: true }
}

export async function checkResendRateLimit(
    admin: SupabaseClient,
    email: string,
): Promise<{ allowed: boolean; retryAfterSec?: number }> {
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    const { count } = await admin
        .from('notification_events')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_email', email)
        .eq('purpose', PURPOSE)
        .eq('event_type', 'password_reset_otp_resend')
        .gte('created_at', since)

    if ((count ?? 0) >= MAX_RESEND_PER_15MIN) {
        return { allowed: false, retryAfterSec: 60 }
    }
    return { allowed: true }
}

export async function invalidateExistingCodes(
    admin: SupabaseClient,
    email: string,
    channel: PasswordResetChannel = CHANNEL,
) {
    await admin
        .from('auth_verification_codes')
        .update({ invalidated_at: new Date().toISOString() })
        .eq('email_normalized', email)
        .eq('purpose', PURPOSE)
        .eq('channel', channel)
        .is('invalidated_at', null)
        .is('used_at', null)
}

export async function invalidateExistingCodesForAccount(
    admin: SupabaseClient,
    account: Pick<ConsumerLookupResult, 'email' | 'phone'>,
    channel: PasswordResetChannel,
) {
    if (account.email) {
        await invalidateExistingCodes(admin, account.email, channel)
    }
    if (account.phone) {
        await admin
            .from('auth_verification_codes')
            .update({ invalidated_at: new Date().toISOString() })
            .eq('phone_normalized', account.phone)
            .eq('purpose', PURPOSE)
            .eq('channel', channel)
            .is('invalidated_at', null)
            .is('used_at', null)
    }
}

export async function createVerificationCode(
    admin: SupabaseClient,
    email: string,
    codeHash: string,
    userId: string | null,
    ip: string | null,
    userAgent: string | null,
    phone?: string | null,
    channel: PasswordResetChannel = CHANNEL,
): Promise<string> {
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString()

    const { data, error } = await admin
        .from('auth_verification_codes')
        .insert({
            purpose: PURPOSE,
            channel,
            email_normalized: email || null,
            phone_normalized: phone || null,
            user_id: userId,
            code_hash: codeHash,
            expires_at: expiresAt,
            max_attempts: MAX_VERIFY_ATTEMPTS_PER_OTP,
            request_ip: ip,
            request_user_agent: userAgent,
        })
        .select('id')
        .single()

    if (error) throw new Error(`Failed to create verification code: ${error.message}`)
    return data.id
}

export async function findActiveCode(
    admin: SupabaseClient,
    email: string,
    channel: PasswordResetChannel = CHANNEL,
) {
    let query = admin
        .from('auth_verification_codes')
        .select('*')
        .eq('purpose', PURPOSE)
        .eq('channel', channel)
        .is('invalidated_at', null)
        .is('used_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)

    if (email.includes('@')) {
        query = query.eq('email_normalized', email)
    } else {
        query = query.eq('phone_normalized', email)
    }

    const { data, error } = await query.maybeSingle()
    if (error) return null
    return data
}

export async function incrementAttemptCount(
    admin: SupabaseClient,
    codeId: string,
    currentCount: number,
) {
    await admin
        .from('auth_verification_codes')
        .update({ attempt_count: currentCount + 1 })
        .eq('id', codeId)
}

export async function markCodeVerified(
    admin: SupabaseClient,
    codeId: string,
): Promise<string> {
    const resetToken = generateResetToken()
    const resetTokenExpires = new Date(
        Date.now() + RESET_TOKEN_EXPIRY_MINUTES * 60 * 1000,
    ).toISOString()

    await admin
        .from('auth_verification_codes')
        .update({
            verified_at: new Date().toISOString(),
            reset_token: resetToken,
            reset_token_expires: resetTokenExpires,
        })
        .eq('id', codeId)

    return resetToken
}

export async function markCodeUsed(
    admin: SupabaseClient,
    codeId: string,
) {
    await admin
        .from('auth_verification_codes')
        .update({ used_at: new Date().toISOString() })
        .eq('id', codeId)
}

export async function findCodeByResetToken(
    admin: SupabaseClient,
    resetToken: string,
) {
    const { data } = await admin
        .from('auth_verification_codes')
        .select('*')
        .eq('reset_token', resetToken)
        .eq('purpose', PURPOSE)
        .is('used_at', null)
        .is('invalidated_at', null)
        .gt('reset_token_expires', new Date().toISOString())
        .limit(1)
        .maybeSingle()

    return data
}

export async function logNotificationEvent(
    admin: SupabaseClient,
    params: {
        eventType: string
        email: string
        phone?: string | null
        userId?: string | null
        status: string
        provider?: string | null
        providerMessageId?: string | null
        errorCode?: string | null
        errorMessage?: string | null
        meta?: Record<string, any>
        ip?: string | null
        channel?: PasswordResetChannel
    },
) {
    const now = new Date().toISOString()
    const sentTypes = ['password_reset_otp_sent', 'password_reset_otp_resend_sent']
    const verifiedTypes = ['password_reset_otp_verified']
    const completedTypes = ['password_reset_password_updated']
    const channel = params.channel || CHANNEL

    await admin.from('notification_events').insert({
        channel,
        provider: params.provider || (channel === SMS_CHANNEL ? SMS_PROVIDER_FALLBACK : EMAIL_PROVIDER_FALLBACK),
        event_type: params.eventType,
        purpose: PURPOSE,
        recipient_email: params.email,
        recipient_phone: params.phone ?? null,
        user_id: params.userId ?? null,
        status: params.status,
        provider_message_id: params.providerMessageId ?? null,
        error_code: params.errorCode ?? null,
        error_message: params.errorMessage ?? null,
        meta: params.meta ?? {},
        request_ip: params.ip ?? null,
        requested_at: now,
        sent_at: sentTypes.includes(params.eventType) ? now : null,
        verified_at: verifiedTypes.includes(params.eventType) ? now : null,
        completed_at: completedTypes.includes(params.eventType) ? now : null,
        created_at: now,
    })
}

export async function sendOtpViaEmail(
    admin: SupabaseClient,
    email: string,
    code: string,
    orgId: string,
    fullName?: string | null,
    logOrgId?: string | null,
): Promise<{ success: boolean; providerName?: string; error?: string; notConfigured?: boolean }> {
    const { recordEmailDelivery } = await import('@/lib/notifications/emailDeliveryLog')
    // orgId owns the provider; the log carries the account's org so the monitor
    // can say whose reset this was, matching how the SMS path records it.
    const record = (result: { success: boolean; providerName?: string; error?: string }) =>
        recordEmailDelivery(admin, {
            orgId: logOrgId || orgId,
            to: email,
            eventCode: PASSWORD_RESET_OTP_EVENT,
            result,
        })

    try {
        const built = buildPasswordResetOtpEmail({ code, fullName })
        const result = await sendTransactionalHtmlEmail(admin, orgId, {
            to: email,
            subject: built.subject,
            text: built.text,
            html: built.html,
            fromName: 'Serapod2U',
        })
        if (!result.success) {
            const failure = {
                success: false,
                notConfigured: result.notConfigured,
                error: result.error || 'Email send failed',
                providerName: result.providerName,
            }
            await record(failure)
            return failure
        }
        const success = { success: true, providerName: result.providerName || EMAIL_PROVIDER_FALLBACK }
        await record(success)
        return success
    } catch (err: any) {
        const failure = { success: false, error: err.message || 'Email send failed' }
        await record(failure)
        return failure
    }
}

export function parsePasswordResetIdentifier(
    raw: string,
): { kind: 'email' | 'phone'; value: string } | null {
    const value = String(raw || '').trim()
    if (!value) return null
    if (value.includes('@')) {
        const email = normalizeEmail(value)
        return isValidEmail(email) ? { kind: 'email', value: email } : null
    }
    const phone = normalizePhoneE164(value)
    if (!phone || phone.replace(/\D/g, '').length < 8) return null
    return { kind: 'phone', value: phone }
}

export function isSmsPasswordResetDelivery(value: unknown): boolean {
    return String(value || '').trim().toLowerCase() === 'sms'
}

export function isPortalPasswordReset(value: unknown): boolean {
    const mode = String(value || '').trim().toLowerCase()
    return mode === 'portal' || mode === 'true'
}

export function resolvePasswordResetChannel(
    identifier: { kind: 'email' | 'phone' },
    delivery?: unknown,
): PasswordResetChannel {
    const requested = String(delivery || '').trim().toLowerCase()
    if (requested === 'sms') return SMS_CHANNEL
    if (requested === 'email') return CHANNEL
    return identifier.kind === 'phone' ? SMS_CHANNEL : CHANNEL
}

export async function lookupPasswordResetAccount(
    admin: SupabaseClient,
    identifier: { kind: 'email' | 'phone'; value: string },
): Promise<ConsumerLookupResult | null> {
    if (identifier.kind === 'email') return lookupConsumerByEmail(admin, identifier.value)
    return lookupConsumerByPhone(admin, identifier.value)
}

export function buildPasswordResetOtpSms(code: string, templateBody?: string): string {
    if (!/^\d{4}$/.test(code)) {
        throw new Error('Password reset OTP must be exactly 4 digits.')
    }
    const template = String(templateBody || getSmsTemplateBody(PASSWORD_RESET_OTP_EVENT) || '').trim()
    const fallback = `[Serapod2U] Password reset code: ${code}. Expires in ${OTP_EXPIRY_MINUTES} minutes.`
    if (!template || !template.includes('{{verification_code}}')) return fallback
    return template
        .replace(/\{\{verification_code\}\}/g, code)
        .replace(/\{\{otp_expiry_minutes\}\}/g, String(OTP_EXPIRY_MINUTES))
}

export async function sendOtpViaSms(
    admin: SupabaseClient,
    phone: string,
    code: string,
    orgId: string,
    templateOrgId?: string | null,
): Promise<{ success: boolean; providerName?: string; error?: string }> {
    const { toSmsE164 } = await import('@/lib/notifications/manualPhoneNumbers')
    const parsed = toSmsE164(phone)
    if (!('e164' in parsed)) {
        return { success: false, error: parsed.reason || 'Invalid phone number' }
    }

    const { loadOrgSmsTemplateBody } = await import('@/lib/notifications/resolveSmsTemplate')
    const template = await loadOrgSmsTemplateBody(
        admin,
        templateOrgId || orgId,
        PASSWORD_RESET_OTP_EVENT,
    )

    const { sendSmsWithActiveProvider, recordSmsDelivery } = await import('@/lib/notifications/sms-send')
    const text = buildPasswordResetOtpSms(code, template)
    const result = await sendSmsWithActiveProvider(admin, orgId, parsed.e164, text)
    await recordSmsDelivery(admin, {
        orgId,
        to: parsed.e164,
        eventCode: PASSWORD_RESET_OTP_EVENT,
        result,
    })
    return {
        success: Boolean(result.success),
        providerName: result.providerName || SMS_PROVIDER_FALLBACK,
        error: result.error,
    }
}

export async function resolveOrgForSms(
    admin: SupabaseClient,
    preferredOrgId?: string | null,
): Promise<string | null> {
    if (preferredOrgId) return preferredOrgId
    const { data: preferred } = await admin
        .from('notification_provider_configs')
        .select('org_id')
        .eq('channel', 'sms')
        .eq('is_default', true)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle()
    if (preferred?.org_id) return preferred.org_id

    const { data: anyActive } = await admin
        .from('notification_provider_configs')
        .select('org_id')
        .eq('channel', 'sms')
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    return anyActive?.org_id ?? null
}

export async function findActivePasswordResetCode(
    admin: SupabaseClient,
    identifier: { kind: 'email' | 'phone'; value: string },
    channel: PasswordResetChannel,
) {
    const lookupKey = identifier.kind === 'email' ? identifier.value : identifier.value
    return findActiveCode(admin, lookupKey, channel)
}

export function identifierMatchesCodeRow(
    identifier: { kind: 'email' | 'phone'; value: string },
    codeRow: { email_normalized?: string | null; phone_normalized?: string | null },
): boolean {
    if (identifier.kind === 'email') {
        return normalizeEmail(codeRow.email_normalized || '') === identifier.value
    }
    const stored = String(codeRow.phone_normalized || '')
    return stored === identifier.value || stored.replace(/^\+/, '') === identifier.value.replace(/^\+/, '')
}

/** Resolve org that owns an active email provider (Dynamic Config → Providers). */
export async function resolveOrgForEmail(
    admin: SupabaseClient,
): Promise<string | null> {
    const { data: preferred } = await admin
        .from('notification_provider_configs')
        .select('org_id')
        .eq('channel', 'email')
        .eq('is_default', true)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle()
    if (preferred?.org_id) return preferred.org_id

    const { data: anyActive } = await admin
        .from('notification_provider_configs')
        .select('org_id')
        .eq('channel', 'email')
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

    return anyActive?.org_id ?? null
}

/** Legacy WhatsApp send — kept for compatibility; consumer reset uses email. */
export async function sendOtpViaWhatsApp(
    admin: SupabaseClient,
    phone: string,
    code: string,
    orgId: string,
): Promise<{ success: boolean; providerMessageId?: string; error?: string }> {
    const { sendWhatsAppMessage } = await import('@/app/api/settings/whatsapp/_utils')
    const recipientDigits = toProviderPhone(phone)
    if (!recipientDigits) return { success: false, error: 'Invalid phone number' }

    const message =
        `Your Serapod2U reset code is *${code}*. This code expires in ${OTP_EXPIRY_MINUTES} minutes. ` +
        `If you did not request this, please ignore this message.`

    try {
        const sent = await sendWhatsAppMessage(admin, orgId, { to: recipientDigits, text: message })
        const result = sent.response
        return {
            success: true,
            providerMessageId: result?.key?.id || result?.messageId || null,
        }
    } catch (err: any) {
        return { success: false, error: err.message || 'WhatsApp send failed' }
    }
}

export async function resolveOrgForWhatsApp(
    admin: SupabaseClient,
): Promise<string | null> {
    const { data } = await admin
        .from('notification_provider_configs')
        .select('org_id')
        .eq('channel', 'whatsapp')
        .eq('is_default', true)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle()

    return data?.org_id ?? null
}

export async function issuePasswordResetOtp(
    admin: SupabaseClient,
    input: {
        identifierRaw: string
        delivery?: unknown
        disclose?: boolean
        ip: string | null
        ua: string | null
        isResend?: boolean
    },
): Promise<
    | { ok: true; message: string; resendCooldown: number; channel: PasswordResetChannel }
    | { ok: false; error: string; status: number; code?: string }
> {
    const identifier = parsePasswordResetIdentifier(input.identifierRaw)
    if (!identifier) {
        return {
            ok: false,
            status: 400,
            code: 'invalid_identifier',
            error: 'Please enter a valid email address or phone number.',
        }
    }

    const channel = resolvePasswordResetChannel(identifier, input.delivery)
    const disclose = Boolean(input.disclose)
    const genericMessage = passwordResetMessageForChannel(channel)
    const rateEmail = identifier.kind === 'email' ? identifier.value : ''
    const rateCheck = input.isResend
        ? await checkResendRateLimit(admin, rateEmail || identifier.value)
        : await checkSendRateLimit(admin, rateEmail || identifier.value)

    if (!rateCheck.allowed) {
        await logNotificationEvent(admin, {
            eventType: input.isResend ? 'password_reset_resend_rate_limited' : 'password_reset_rate_limited',
            email: identifier.kind === 'email' ? identifier.value : '',
            phone: identifier.kind === 'phone' ? identifier.value : null,
            status: 'rate_limited',
            channel,
            ip: input.ip,
        })
        if (disclose) {
            return {
                ok: false,
                status: 429,
                code: 'rate_limited',
                error: 'Too many reset attempts. Please wait a minute and try again.',
            }
        }
        return { ok: true, message: genericMessage, resendCooldown: RESEND_COOLDOWN_SECONDS, channel }
    }

    const account = await lookupPasswordResetAccount(admin, identifier)
    if (!account) {
        await logNotificationEvent(admin, {
            eventType: input.isResend ? 'password_reset_otp_resend' : 'password_reset_otp_requested',
            email: identifier.kind === 'email' ? identifier.value : '',
            phone: identifier.kind === 'phone' ? identifier.value : null,
            status: 'no_account',
            channel,
            meta: { anonymous: true, disclose },
            ip: input.ip,
        })
        if (disclose) {
            return {
                ok: false,
                status: 404,
                code: 'not_registered',
                error: unregisteredPasswordResetMessage(identifier.kind),
            }
        }
        return { ok: true, message: genericMessage, resendCooldown: RESEND_COOLDOWN_SECONDS, channel }
    }

    if (channel === SMS_CHANNEL && !account.phone) {
        await logNotificationEvent(admin, {
            eventType: input.isResend ? 'password_reset_otp_resend' : 'password_reset_otp_requested',
            email: account.email,
            userId: account.userId,
            status: 'no_phone',
            channel,
            ip: input.ip,
        })
        if (disclose) {
            return {
                ok: false,
                status: 409,
                code: 'missing_contact',
                error: missingContactPasswordResetMessage(channel),
            }
        }
        return { ok: true, message: genericMessage, resendCooldown: RESEND_COOLDOWN_SECONDS, channel }
    }

    if (channel === CHANNEL && !account.email) {
        await logNotificationEvent(admin, {
            eventType: input.isResend ? 'password_reset_otp_resend' : 'password_reset_otp_requested',
            phone: account.phone,
            userId: account.userId,
            status: 'no_email',
            channel,
            ip: input.ip,
        })
        if (disclose) {
            return {
                ok: false,
                status: 409,
                code: 'missing_contact',
                error: missingContactPasswordResetMessage(channel),
            }
        }
        return { ok: true, message: genericMessage, resendCooldown: RESEND_COOLDOWN_SECONDS, channel }
    }

    await invalidateExistingCodesForAccount(admin, account, channel)

    const code = generateOtp()
    const codeHash = hashOtp(code)
    const codeId = await createVerificationCode(
        admin,
        account.email,
        codeHash,
        account.userId,
        input.ip,
        input.ua,
        account.phone,
        channel,
    )

    let sendResult: { success: boolean; providerName?: string; error?: string } = { success: false }

    if (channel === SMS_CHANNEL) {
        const orgId = await resolveOrgForSms(admin, account.organizationId)
        if (orgId && account.phone) {
            sendResult = await sendOtpViaSms(admin, account.phone, code, orgId, account.organizationId)
        } else {
            sendResult = { success: false, error: 'No SMS provider configured' }
        }
    } else {
        const orgId = await resolveOrgForEmail(admin)
        if (orgId && account.email) {
            sendResult = await sendOtpViaEmail(admin, account.email, code, orgId, account.fullName, account.organizationId)
        } else {
            sendResult = { success: false, error: 'No email provider configured' }
        }
    }

    const sentEvent = input.isResend ? 'password_reset_otp_resend_sent' : 'password_reset_otp_sent'
    await logNotificationEvent(admin, {
        eventType: sendResult.success ? sentEvent : 'password_reset_otp_send_failed',
        email: account.email,
        phone: account.phone,
        userId: account.userId,
        status: sendResult.success ? 'sent' : 'failed',
        provider: sendResult.providerName,
        errorMessage: sendResult.success ? null : sendResult.error,
        channel,
        meta: { codeId },
        ip: input.ip,
    })

    await logNotificationEvent(admin, {
        eventType: input.isResend ? 'password_reset_otp_resend' : 'password_reset_otp_requested',
        email: account.email,
        phone: account.phone,
        userId: account.userId,
        status: sendResult.success ? 'sent' : 'send_failed',
        provider: sendResult.providerName,
        channel,
        ip: input.ip,
    })

    if (!sendResult.success && disclose) {
        return {
            ok: false,
            status: 502,
            code: 'send_failed',
            error: failedSendPasswordResetMessage(channel),
        }
    }

    return {
        ok: true,
        message: disclose ? sentPasswordResetMessage(channel) : genericMessage,
        resendCooldown: RESEND_COOLDOWN_SECONDS,
        channel,
    }
}
