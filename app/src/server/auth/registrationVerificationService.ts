import crypto from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import { normalizePhoneE164, toProviderPhone } from '@/utils/phone'
import { sendTransactionalHtmlEmail } from '@/lib/email/transactional-html-email'
import { buildRegistrationOtpEmail, buildShopContactOtpEmail, maskEmail } from '@/lib/auth/registration-otp-email'
import { resolveOrgForEmail, resolveOrgForSms } from '@/server/auth/passwordResetService'
import { REGISTRATION_OTP_EVENT } from '@/lib/notifications/notificationEventCatalog'
import { deliveryChainForPreset, resolveNotificationRoutingPreset } from '@/lib/notifications/routing'
import { loadOrgEventSetting, loadOrgSmsTemplateBody } from '@/lib/notifications/resolveSmsTemplate'
import { getSmsTemplateBody } from '@/config/smsTemplates'
import { getTemplatesForEvent } from '@/config/notificationTemplates'
import { textToSimpleHtml } from '@/lib/notifications/transactional-otp-router'

export const OTP_LENGTH = 4
export const OTP_EXPIRY_MINUTES = 5
export const RESEND_COOLDOWN_SECONDS = 60
export const MAX_SEND_ATTEMPTS_PER_15MIN = 3
export const MAX_VERIFY_ATTEMPTS_PER_OTP = 5
export const MAX_RESEND_PER_15MIN = 5
export const VERIFICATION_TOKEN_EXPIRY_MINUTES = 15

const PURPOSE = 'registration_verification'
export const CHANNEL_WHATSAPP = 'whatsapp'
export const CHANNEL_EMAIL = 'email'
export const CHANNEL_SMS = 'sms'
/** Default when Notification Types has no SMS/email routing yet. */
export const REGISTRATION_OTP_CHANNEL = CHANNEL_EMAIL
/** Shop contact verification (Create New Shop from QR/registration) uses email. */
export const SHOP_CONTACT_OTP_CHANNEL = CHANNEL_EMAIL
const PROVIDER_WHATSAPP = 'baileys'
const PROVIDER_EMAIL = 'email'
const PROVIDER_SMS = 'local_my'

export type RegistrationOtpChannel = typeof CHANNEL_EMAIL | typeof CHANNEL_SMS

type VerificationPurposeOptions = {
    purpose?: string
    channel?: 'whatsapp' | 'email' | 'sms'
    ignoreChannel?: boolean
}

type VerificationRateLimitOptions = VerificationPurposeOptions & {
    requestEventTypes?: string[]
    resendEventType?: string
}

type VerificationMessageOptions = {
    message?: string
}

function resolvePurpose(options?: VerificationPurposeOptions) {
    return options?.purpose || PURPOSE
}

function resolveChannel(options?: VerificationPurposeOptions) {
    return options?.channel || CHANNEL_WHATSAPP
}

export function generateOtp(): string {
    const num = crypto.randomInt(0, 10000)
    return num.toString().padStart(OTP_LENGTH, '0')
}

export function hashOtp(code: string): string {
    return crypto.createHash('sha256').update(code).digest('hex')
}

function generateVerificationToken(): string {
    return crypto.randomBytes(32).toString('base64url')
}

export async function checkRegistrationAvailability(
    admin: SupabaseClient,
    emailRaw: string,
    phoneRaw: string,
) {
    const email = emailRaw.trim().toLowerCase()
    const phone = normalizePhoneE164(phoneRaw.trim())

    const { data: emailMatch, error: emailError } = await admin
        .from('users')
        .select('id')
        .ilike('email', email)
        .limit(1)

    if (emailError) {
        throw new Error(`Email availability check failed: ${emailError.message}`)
    }

    const { data: phoneExists, error: phoneError } = await admin
        .rpc('check_phone_exists', {
            p_phone: phone,
            p_exclude_user_id: null,
        })

    if (phoneError) {
        throw new Error(`Phone availability check failed: ${phoneError.message}`)
    }

    return {
        emailAvailable: !emailMatch || emailMatch.length === 0,
        phoneAvailable: !phoneExists,
        normalizedPhone: phone,
    }
}

export async function checkSendRateLimit(
    admin: SupabaseClient,
    phone: string,
    options?: VerificationRateLimitOptions,
) {
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    const purpose = resolvePurpose(options)
    const requestEventTypes = options?.requestEventTypes || ['registration_otp_requested', 'registration_otp_resend']

    const { count } = await admin
        .from('notification_events')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_phone', phone)
        .eq('purpose', purpose)
        .in('event_type', requestEventTypes)
        .gte('created_at', since)

    if ((count ?? 0) >= MAX_SEND_ATTEMPTS_PER_15MIN) {
        return { allowed: false, retryAfterSec: RESEND_COOLDOWN_SECONDS }
    }

    return { allowed: true }
}

export async function checkResendRateLimit(
    admin: SupabaseClient,
    phone: string,
    options?: VerificationRateLimitOptions,
) {
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    const purpose = resolvePurpose(options)
    const resendEventType = options?.resendEventType || 'registration_otp_resend'

    const { count } = await admin
        .from('notification_events')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_phone', phone)
        .eq('purpose', purpose)
        .eq('event_type', resendEventType)
        .gte('created_at', since)

    if ((count ?? 0) >= MAX_RESEND_PER_15MIN) {
        return { allowed: false, retryAfterSec: RESEND_COOLDOWN_SECONDS }
    }

    return { allowed: true }
}

export async function invalidateExistingCodes(
    admin: SupabaseClient,
    phone: string,
    options?: VerificationPurposeOptions,
) {
    const purpose = resolvePurpose(options)
    const channel = resolveChannel(options)

    let query = admin
        .from('auth_verification_codes')
        .update({ invalidated_at: new Date().toISOString() })
        .eq('phone_normalized', phone)
        .eq('purpose', purpose)
        .is('invalidated_at', null)
        .is('used_at', null)

    if (!options?.ignoreChannel) {
        query = query.eq('channel', channel)
    }

    await query
}

export async function createVerificationCode(
    admin: SupabaseClient,
    phone: string,
    codeHash: string,
    meta: Record<string, any>,
    ip: string | null,
    userAgent: string | null,
    options?: VerificationPurposeOptions,
) {
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString()
    const purpose = resolvePurpose(options)
    const channel = resolveChannel(options)
    const emailNormalized = typeof meta?.email === 'string'
        ? String(meta.email).trim().toLowerCase()
        : null

    const { data, error } = await admin
        .from('auth_verification_codes')
        .insert({
            purpose,
            channel,
            phone_normalized: phone,
            email_normalized: emailNormalized || null,
            code_hash: codeHash,
            expires_at: expiresAt,
            max_attempts: MAX_VERIFY_ATTEMPTS_PER_OTP,
            request_ip: ip,
            request_user_agent: userAgent,
            meta,
        })
        .select('id')
        .single()

    if (error) {
        throw new Error(`Failed to create verification code: ${error.message}`)
    }

    return data.id as string
}

export async function findActiveCode(
    admin: SupabaseClient,
    phone: string,
    options?: VerificationPurposeOptions,
) {
    const purpose = resolvePurpose(options)
    const channel = resolveChannel(options)

    let query = admin
        .from('auth_verification_codes')
        .select('*')
        .eq('phone_normalized', phone)
        .eq('purpose', purpose)
        .is('invalidated_at', null)
        .is('used_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)

    if (!options?.ignoreChannel) {
        query = query.eq('channel', channel)
    }

    const { data, error } = await query.maybeSingle()

    if (error) return null
    return data
}

export async function incrementAttemptCount(admin: SupabaseClient, codeId: string, currentCount: number) {
    await admin
        .from('auth_verification_codes')
        .update({ attempt_count: currentCount + 1 })
        .eq('id', codeId)
}

export async function markCodeVerified(admin: SupabaseClient, codeId: string) {
    const verificationToken = generateVerificationToken()
    const verificationTokenExpires = new Date(
        Date.now() + VERIFICATION_TOKEN_EXPIRY_MINUTES * 60 * 1000,
    ).toISOString()

    await admin
        .from('auth_verification_codes')
        .update({
            verified_at: new Date().toISOString(),
            reset_token: verificationToken,
            reset_token_expires: verificationTokenExpires,
        })
        .eq('id', codeId)

    return verificationToken
}

export async function findCodeByVerificationToken(
    admin: SupabaseClient,
    verificationToken: string,
    options?: VerificationPurposeOptions,
) {
    const purpose = resolvePurpose(options)
    const channel = options?.channel

    let query = admin
        .from('auth_verification_codes')
        .select('*')
        .eq('reset_token', verificationToken)
        .eq('purpose', purpose)
        .is('used_at', null)
        .is('invalidated_at', null)
        .gt('reset_token_expires', new Date().toISOString())

    if (channel) {
        query = query.eq('channel', channel)
    }

    const { data } = await query.limit(1).maybeSingle()

    return data
}

export async function markCodeUsed(admin: SupabaseClient, codeId: string, userId?: string | null) {
    const updateData: Record<string, string> = {
        used_at: new Date().toISOString(),
    }

    if (userId) {
        updateData.user_id = userId
    }

    await admin
        .from('auth_verification_codes')
        .update(updateData)
        .eq('id', codeId)
}

export async function logNotificationEvent(
    admin: SupabaseClient,
    params: {
        eventType: string
        phone: string
        status: string
        email?: string | null
        channel?: 'whatsapp' | 'email' | 'sms'
        userId?: string | null
        providerMessageId?: string | null
        errorCode?: string | null
        errorMessage?: string | null
        meta?: Record<string, any>
        ip?: string | null
    },
) {
    const now = new Date().toISOString()
    const sentTypes = ['registration_otp_sent', 'registration_otp_resend_sent', 'shop_contact_otp_sent', 'shop_contact_otp_resend_sent']
    const verifiedTypes = ['registration_otp_verified', 'shop_contact_otp_verified']
    const completedTypes = ['registration_completed']
    const channel = params.channel || CHANNEL_WHATSAPP
    const provider = channel === 'email' ? PROVIDER_EMAIL : channel === 'sms' ? PROVIDER_SMS : PROVIDER_WHATSAPP

    // Audit must never break OTP send/verify — password-reset path already succeeds without hard-failing on logs.
    try {
        const { error } = await admin.from('notification_events').insert({
            channel,
            provider,
            event_type: params.eventType,
            purpose: PURPOSE,
            recipient_phone: params.phone,
            recipient_email: params.email ? String(params.email).trim().toLowerCase() : null,
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
        if (error) {
            console.warn('[registrationVerification] notification_events insert failed:', error.message)
        }
    } catch (err) {
        console.warn('[registrationVerification] notification_events insert threw:', err)
    }
}

export async function sendOtpViaWhatsApp(
    admin: SupabaseClient,
    phone: string,
    code: string,
    orgId: string,
    options?: VerificationMessageOptions,
): Promise<{ success: boolean; providerMessageId?: string | null; error?: string }> {
    const { sendWhatsAppMessage } = await import('@/app/api/settings/whatsapp/_utils')

    const recipientDigits = toProviderPhone(phone)
    if (!recipientDigits) {
        return { success: false, error: 'Invalid phone number' }
    }
    const message =
        options?.message ||
        (`Serapod2U registration verification code: *${code}*\n\n` +
            `Please enter this 4-digit code to confirm your mobile number. ` +
            `This code will expire in ${OTP_EXPIRY_MINUTES} minutes.\n\n` +
            `If you did not request this registration, no further action is required.`)

    try {
        const sent = await sendWhatsAppMessage(admin, orgId, { to: recipientDigits, text: message })
        const result = sent.response

        return {
            success: true,
            providerMessageId: result?.key?.id || result?.messageId || null,
        }
    } catch (error: any) {
        return { success: false, error: error?.message || 'WhatsApp send failed' }
    }
}

/**
 * OTP via Dynamic Config email provider.
 * Same resolution order as password-reset (proven on production):
 * prefer the org that owns the active email provider, then fall back to journey orgId.
 */
export async function sendOtpViaEmail(
    admin: SupabaseClient,
    email: string,
    code: string,
    orgId: string,
    fullName?: string | null,
    options?: {
        template?: 'registration' | 'shop_contact'
        shopName?: string | null
    },
): Promise<{ success: boolean; providerName?: string; error?: string; notConfigured?: boolean; usedOrgId?: string }> {
    try {
        const built = options?.template === 'shop_contact'
            ? buildShopContactOtpEmail({ code, fullName, shopName: options.shopName })
            : buildRegistrationOtpEmail({ code, fullName })
        const preferredOrgId = await resolveOrgForEmail(admin)
        const tryOrgs = [preferredOrgId, orgId].filter(
            (id, index, arr): id is string => Boolean(id) && arr.indexOf(id) === index,
        )

        if (tryOrgs.length === 0) {
            return { success: false, notConfigured: true, error: 'No email provider configured' }
        }

        let lastError = 'Email send failed'
        let notConfigured = false
        for (const candidateOrgId of tryOrgs) {
            const result = await sendTransactionalHtmlEmail(admin, candidateOrgId, {
                to: email,
                subject: built.subject,
                text: built.text,
                html: built.html,
                fromName: 'Serapod2U',
            })
            if (result.success) {
                return {
                    success: true,
                    providerName: result.providerName || PROVIDER_EMAIL,
                    usedOrgId: candidateOrgId,
                }
            }
            notConfigured = Boolean(result.notConfigured) || notConfigured
            lastError = result.error || lastError
        }

        return { success: false, notConfigured, error: lastError }
    } catch (error: any) {
        return { success: false, error: error?.message || 'Email send failed' }
    }
}

export function resolveRegistrationOtpChannel(setting: unknown): RegistrationOtpChannel {
    const preset = resolveNotificationRoutingPreset(setting)
    const channel = deliveryChainForPreset(preset).find((item) => item === 'sms' || item === 'email')
    return channel === 'sms' ? CHANNEL_SMS : CHANNEL_EMAIL
}

export function buildRegistrationOtpSms(code: string, templateBody?: string): string {
    if (!/^\d{4}$/.test(code)) {
        throw new Error('Registration OTP must be exactly 4 digits.')
    }
    const template = String(templateBody || getSmsTemplateBody(REGISTRATION_OTP_EVENT) || '').trim()
    const fallback = `[Serapod2U] Registration code: ${code}. Expires in ${OTP_EXPIRY_MINUTES} minutes.`
    if (!template || !template.includes('{{verification_code}}')) return fallback
    return template
        .replace(/\{\{verification_code\}\}/g, code)
        .replace(/\{\{otp_expiry_minutes\}\}/g, String(OTP_EXPIRY_MINUTES))
}

function renderRegistrationEmailFromUi(code: string, setting: unknown): { subject: string; text: string; html: string } | null {
    const saved = String((setting as { templates?: Record<string, string> } | null)?.templates?.email || '').trim()
    const catalog = getTemplatesForEvent(REGISTRATION_OTP_EVENT, 'email')
    const byId = saved ? catalog.find((template) => template.id === saved) : undefined
    const rawBody = String(byId?.body || saved || catalog[0]?.body || '').trim()
    if (!rawBody || !rawBody.includes('{{verification_code}}')) return null
    const text = rawBody
        .replace(/\{\{verification_code\}\}/g, code)
        .replace(/\{\{otp_expiry_minutes\}\}/g, String(OTP_EXPIRY_MINUTES))
    const subject = String(byId?.subject || catalog[0]?.subject || 'Your Serapod2U registration code')
        .replace(/\{\{verification_code\}\}/g, code)
        .replace(/\{\{otp_expiry_minutes\}\}/g, String(OTP_EXPIRY_MINUTES))
    return { subject, text, html: textToSimpleHtml(text) }
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

    const template = await loadOrgSmsTemplateBody(admin, templateOrgId || orgId, REGISTRATION_OTP_EVENT)
    const { sendSmsWithActiveProvider, recordSmsDelivery } = await import('@/lib/notifications/sms-send')
    const result = await sendSmsWithActiveProvider(admin, orgId, parsed.e164, buildRegistrationOtpSms(code, template))
    await recordSmsDelivery(admin, {
        orgId,
        to: parsed.e164,
        eventCode: REGISTRATION_OTP_EVENT,
        result,
    })
    return {
        success: Boolean(result.success),
        providerName: result.providerName || PROVIDER_SMS,
        error: result.error,
    }
}

export async function deliverRegistrationOtp(
    admin: SupabaseClient,
    input: {
        email: string
        phone: string
        code: string
        orgId: string
        fullName?: string | null
    },
): Promise<{
    success: boolean
    channel: RegistrationOtpChannel
    providerName?: string
    error?: string
    notConfigured?: boolean
    usedOrgId?: string
}> {
    const setting = await loadOrgEventSetting(admin, input.orgId, REGISTRATION_OTP_EVENT)
    const channel = resolveRegistrationOtpChannel(setting)

    if (channel === CHANNEL_SMS) {
        const smsOrgId = await resolveOrgForSms(admin, input.orgId)
        if (!smsOrgId) {
            return { success: false, channel, notConfigured: true, error: 'No SMS provider configured' }
        }
        const sent = await sendOtpViaSms(admin, input.phone, input.code, smsOrgId, input.orgId)
        return { ...sent, channel, usedOrgId: smsOrgId }
    }

    const uiEmail = renderRegistrationEmailFromUi(input.code, setting)
    const built = uiEmail || buildRegistrationOtpEmail({ code: input.code, fullName: input.fullName })
    const preferredOrgId = await resolveOrgForEmail(admin)
    const tryOrgs = [preferredOrgId, input.orgId].filter(
        (id, index, arr): id is string => Boolean(id) && arr.indexOf(id) === index,
    )
    if (tryOrgs.length === 0) {
        return { success: false, channel, notConfigured: true, error: 'No email provider configured' }
    }

    let lastError = 'Email send failed'
    let notConfigured = false
    for (const candidateOrgId of tryOrgs) {
        const result = await sendTransactionalHtmlEmail(admin, candidateOrgId, {
            to: input.email,
            subject: built.subject,
            text: built.text,
            html: built.html,
            fromName: 'Serapod2U',
        })
        if (result.success) {
            return {
                success: true,
                channel,
                providerName: result.providerName || PROVIDER_EMAIL,
                usedOrgId: candidateOrgId,
            }
        }
        notConfigured = Boolean(result.notConfigured) || notConfigured
        lastError = result.error || lastError
    }
    return { success: false, channel, notConfigured, error: lastError }
}

export async function resolveRegistrationOtpDelivery(admin: SupabaseClient, orgId: string) {
    const setting = await loadOrgEventSetting(admin, orgId, REGISTRATION_OTP_EVENT)
    return { setting, channel: resolveRegistrationOtpChannel(setting) }
}

export function registrationOtpSentMessage(channel: RegistrationOtpChannel, email: string, isResend = false) {
    if (channel === CHANNEL_SMS) {
        return isResend
            ? 'A fresh verification code has been sent by SMS.'
            : 'A 4-digit verification code has been sent by SMS.'
    }
    return isResend
        ? `A fresh verification code has been sent to ${maskEmail(email)}.`
        : `A 4-digit verification code has been sent to ${maskEmail(email)}.`
}

export function registrationOtpFailedMessage(channel: RegistrationOtpChannel, notConfigured?: boolean) {
    const label = channel === CHANNEL_SMS ? 'SMS' : 'email'
    return notConfigured
        ? `${label} verification is not configured yet. Please contact support.`
        : `We could not send the ${label} verification code right now. Please try again shortly.`
}
