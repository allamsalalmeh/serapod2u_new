import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { normalizePhoneE164 } from '@/utils/phone'
import {
    REGISTRATION_OTP_CHANNEL,
    findActiveCode,
    hashOtp,
    incrementAttemptCount,
    logNotificationEvent,
    markCodeVerified,
} from '@/server/auth/registrationVerificationService'

export async function POST(req: NextRequest) {
    try {
        const body = await req.json()
        const phoneRaw = String(body?.phone || '').trim()
        const code = String(body?.code || '').trim()

        if (!phoneRaw || !/^\d{4}$/.test(code)) {
            return NextResponse.json({ error: 'Please enter the 4-digit verification code.' }, { status: 400 })
        }

        const admin = createAdminClient()
        const phone = normalizePhoneE164(phoneRaw)
        const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || null

        const activeCode = await findActiveCode(admin, phone, { ignoreChannel: true })
        if (!activeCode) {
            await logNotificationEvent(admin, {
                eventType: 'registration_otp_verify_failed',
                phone,
                channel: REGISTRATION_OTP_CHANNEL,
                status: 'failed',
                errorMessage: 'No active registration code found',
                ip,
            })
            return NextResponse.json({ error: 'The verification code has expired. Please request a new code.' }, { status: 400 })
        }

        if (activeCode.attempt_count >= activeCode.max_attempts) {
            await logNotificationEvent(admin, {
                eventType: 'registration_otp_verify_failed',
                phone,
                email: activeCode.email_normalized || activeCode.meta?.email || null,
                channel: activeCode.channel || REGISTRATION_OTP_CHANNEL,
                status: 'failed',
                errorMessage: 'Maximum verification attempts exceeded',
                meta: { codeId: activeCode.id, attempts: activeCode.attempt_count },
                ip,
            })
            return NextResponse.json({ error: 'Too many incorrect attempts. Please request a new code.' }, { status: 429 })
        }

        await incrementAttemptCount(admin, activeCode.id, activeCode.attempt_count)

        if (hashOtp(code) !== activeCode.code_hash) {
            const remaining = activeCode.max_attempts - (activeCode.attempt_count + 1)
            await logNotificationEvent(admin, {
                eventType: 'registration_otp_verify_failed',
                phone,
                email: activeCode.email_normalized || activeCode.meta?.email || null,
                channel: activeCode.channel || REGISTRATION_OTP_CHANNEL,
                status: 'failed',
                errorMessage: 'Invalid verification code',
                meta: { codeId: activeCode.id, remaining },
                ip,
            })
            return NextResponse.json({
                error: 'The verification code is incorrect. Please try again.',
                attemptsRemaining: remaining,
            }, { status: 400 })
        }

        const verificationToken = await markCodeVerified(admin, activeCode.id)

        await logNotificationEvent(admin, {
            eventType: 'registration_otp_verified',
            phone,
            email: activeCode.email_normalized || activeCode.meta?.email || null,
            channel: activeCode.channel || REGISTRATION_OTP_CHANNEL,
            status: 'verified',
            meta: { codeId: activeCode.id, email: activeCode.meta?.email || null },
            ip,
        })

        return NextResponse.json({
            success: true,
            message: activeCode.channel === 'sms' ? 'Phone verified successfully.' : 'Email verified successfully.',
            verificationToken,
        })
    } catch (error: any) {
        console.error('Registration OTP verify error:', error)
        return NextResponse.json(
            { error: 'Unable to verify the code right now. Please try again later.' },
            { status: 500 },
        )
    }
}
