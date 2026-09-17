import { NextRequest, NextResponse } from 'next/server'
import { resolveRegistrationLinkSelection } from '@/lib/engagement/registration-link-resolution'
import {
    SIGNUP_CONFIRM_PASSWORD_REQUIRED_MESSAGE,
    SIGNUP_PASSWORD_MIN_LENGTH_MESSAGE,
    SIGNUP_PASSWORDS_DO_NOT_MATCH_MESSAGE,
} from '@/lib/engagement/registration-link-selection'
import { sanitizeRoadtourRegistrationContext } from '@/lib/roadtour/registration-context'
import { createAdminClient } from '@/lib/supabase/admin'
import { normalizePhoneE164 } from '@/utils/phone'
import {
    RESEND_COOLDOWN_SECONDS,
    checkRegistrationAvailability,
    checkSendRateLimit,
    createVerificationCode,
    deliverRegistrationOtp,
    generateOtp,
    hashOtp,
    invalidateExistingCodes,
    logNotificationEvent,
    registrationOtpFailedMessage,
    registrationOtpSentMessage,
    resolveRegistrationOtpDelivery,
} from '@/server/auth/registrationVerificationService'

export async function POST(req: NextRequest) {
    try {
        const body = await req.json()
        const email = String(body?.email || '').trim().toLowerCase()
        const phoneRaw = String(body?.phone || '').trim()
        const fullName = String(body?.fullName || '').trim()
        const orgId = String(body?.orgId || '').trim()
        const referenceUserId = String(body?.referenceUserId || '').trim()
        const referralPhone = String(body?.referralPhone || '').trim()
        const shopOrganizationId = String(body?.shopOrganizationId || '').trim()
        const shopName = String(body?.shopName || '').trim()
        const pendingShopRequest = body?.pendingShopRequest || null
        const password = String(body?.password || '')
        const confirmPassword = String(body?.confirmPassword || '')
        const roadtourContext = sanitizeRoadtourRegistrationContext(body?.roadtourContext)

        if (!email || !phoneRaw || !fullName || !orgId) {
            return NextResponse.json({ error: 'Email, full name, phone number, and organization are required.' }, { status: 400 })
        }

        const admin = createAdminClient()
        const phone = normalizePhoneE164(phoneRaw)
        const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || null
        const ua = req.headers.get('user-agent') || null

        if (password.length < 6) {
            return NextResponse.json({ field: 'password', error: SIGNUP_PASSWORD_MIN_LENGTH_MESSAGE }, { status: 400 })
        }

        if (!confirmPassword) {
            return NextResponse.json({ field: 'confirmPassword', error: SIGNUP_CONFIRM_PASSWORD_REQUIRED_MESSAGE }, { status: 400 })
        }

        if (password !== confirmPassword) {
            return NextResponse.json({ field: 'confirmPassword', error: SIGNUP_PASSWORDS_DO_NOT_MATCH_MESSAGE }, { status: 400 })
        }

        const linkSelection = await resolveRegistrationLinkSelection(admin, {
            organizationId: shopOrganizationId,
            shopName,
            referenceUserId,
            referralPhone,
            pendingShopRequest,
        })

        if (!linkSelection.ok) {
            return NextResponse.json({ field: linkSelection.field, error: linkSelection.error }, { status: 400 })
        }

        const availability = await checkRegistrationAvailability(admin, email, phoneRaw)
        if (!availability.emailAvailable) {
            return NextResponse.json({ field: 'email', error: 'This email address is already linked to an existing account. Please sign in or use a different email.' }, { status: 409 })
        }
        if (!availability.phoneAvailable) {
            return NextResponse.json({ field: 'phone', error: 'This mobile number is already linked to an existing account. Please sign in or use a different number.' }, { status: 409 })
        }

        const { channel } = await resolveRegistrationOtpDelivery(admin, orgId)

        const rateCheck = await checkSendRateLimit(admin, phone)
        if (!rateCheck.allowed) {
            await logNotificationEvent(admin, {
                eventType: 'registration_rate_limited',
                phone,
                email,
                channel,
                status: 'rate_limited',
                meta: { reason: 'send_limit_exceeded', email },
                ip,
            })
            return NextResponse.json({
                success: false,
                error: 'Too many verification requests were submitted. Please wait a moment before trying again.',
                resendCooldown: RESEND_COOLDOWN_SECONDS,
            }, { status: 429 })
        }

        await invalidateExistingCodes(admin, phone, { ignoreChannel: true })

        const code = generateOtp()
        const codeId = await createVerificationCode(
            admin,
            phone,
            hashOtp(code),
            {
                email,
                full_name: fullName,
                org_id: orgId,
                reference_user_id: linkSelection.referenceUserId,
                referral_phone: linkSelection.referralPhone,
                shop_organization_id: linkSelection.organizationId,
                shop_name: linkSelection.shopDisplayName,
                pending_shop_request: linkSelection.pendingShopRequest,
                registration_source: roadtourContext ? 'roadtour' : 'premium_loyalty',
                roadtour_context: roadtourContext,
            },
            ip,
            ua,
            { channel },
        )

        const sendResult = await deliverRegistrationOtp(admin, {
            email,
            phone,
            code,
            orgId,
            fullName,
        })

        if (sendResult.success) {
            await logNotificationEvent(admin, {
                eventType: 'registration_otp_sent',
                phone,
                email,
                channel: sendResult.channel,
                status: 'sent',
                providerMessageId: sendResult.providerName || null,
                meta: {
                    codeId,
                    email,
                    org_id: orgId,
                    email_org_id: sendResult.usedOrgId || orgId,
                    reference_user_id: linkSelection.referenceUserId,
                    shop_organization_id: linkSelection.organizationId,
                    pending_shop_request: Boolean(linkSelection.pendingShopRequest),
                    registration_source: roadtourContext ? 'roadtour' : 'premium_loyalty',
                    roadtour_context: roadtourContext,
                },
                ip,
            })
        } else {
            await logNotificationEvent(admin, {
                eventType: 'registration_otp_send_failed',
                phone,
                email,
                channel: sendResult.channel,
                status: 'failed',
                errorMessage: sendResult.error,
                meta: {
                    codeId,
                    email,
                    org_id: orgId,
                    notConfigured: Boolean(sendResult.notConfigured),
                    reference_user_id: linkSelection.referenceUserId,
                    shop_organization_id: linkSelection.organizationId,
                    pending_shop_request: Boolean(linkSelection.pendingShopRequest),
                    registration_source: roadtourContext ? 'roadtour' : 'premium_loyalty',
                    roadtour_context: roadtourContext,
                },
                ip,
            })
            return NextResponse.json({
                success: false,
                error: registrationOtpFailedMessage(sendResult.channel, sendResult.notConfigured),
            }, { status: 500 })
        }

        await logNotificationEvent(admin, {
            eventType: 'registration_otp_requested',
            phone,
            email,
            channel: sendResult.channel,
            status: 'sent',
            meta: {
                codeId,
                email,
                org_id: orgId,
                reference_user_id: linkSelection.referenceUserId,
                shop_organization_id: linkSelection.organizationId,
                pending_shop_request: Boolean(linkSelection.pendingShopRequest),
                registration_source: roadtourContext ? 'roadtour' : 'premium_loyalty',
                roadtour_context: roadtourContext,
            },
            ip,
        })

        return NextResponse.json({
            success: true,
            message: registrationOtpSentMessage(sendResult.channel, email),
            resendCooldown: RESEND_COOLDOWN_SECONDS,
            channel: sendResult.channel,
        })
    } catch (error: any) {
        console.error('Registration OTP request error:', error)
        return NextResponse.json(
            { error: 'Unable to start registration verification. Please try again later.' },
            { status: 500 },
        )
    }
}
