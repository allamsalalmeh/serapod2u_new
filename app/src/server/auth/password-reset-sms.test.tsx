import { describe, expect, it } from 'vitest'
import { getSmsTemplateBody } from '@/config/smsTemplates'
import {
    ADMIN_CONTACT_HELP,
    buildPasswordResetOtpSms,
    CHANNEL,
    identifierMatchesCodeRow,
    isPortalPasswordReset,
    isSmsPasswordResetDelivery,
    parsePasswordResetIdentifier,
    passwordResetMessageForChannel,
    resolvePasswordResetChannel,
    SMS_CHANNEL,
    unregisteredPasswordResetMessage,
} from '@/server/auth/passwordResetService'

describe('portal password reset SMS helpers', () => {
    it('parses email and phone identifiers', () => {
        expect(parsePasswordResetIdentifier('  Ada@Serapod.com ')).toEqual({
            kind: 'email',
            value: 'ada@serapod.com',
        })
        expect(parsePasswordResetIdentifier('01163739729')?.kind).toBe('phone')
        expect(parsePasswordResetIdentifier('not-valid')).toBeNull()
    })

    it('sends email codes for email and SMS codes for phone unless delivery is overridden', () => {
        expect(resolvePasswordResetChannel({ kind: 'email' })).toBe(CHANNEL)
        expect(resolvePasswordResetChannel({ kind: 'phone' })).toBe(SMS_CHANNEL)
        expect(resolvePasswordResetChannel({ kind: 'email' }, 'sms')).toBe(SMS_CHANNEL)
        expect(resolvePasswordResetChannel({ kind: 'phone' }, 'email')).toBe(CHANNEL)
        expect(isSmsPasswordResetDelivery('sms')).toBe(true)
        expect(isSmsPasswordResetDelivery('email')).toBe(false)
        expect(isPortalPasswordReset('portal')).toBe(true)
        expect(passwordResetMessageForChannel(SMS_CHANNEL)).toMatch(/SMS/)
    })

    it('tells the user when the contact is not registered', () => {
        expect(unregisteredPasswordResetMessage('email')).toContain('not registered')
        expect(unregisteredPasswordResetMessage('phone')).toContain('not registered')
        expect(unregisteredPasswordResetMessage('email')).toContain(ADMIN_CONTACT_HELP)
    })

    it('builds a 4-digit SMS body from the catalog', () => {
        const sms = buildPasswordResetOtpSms('4832')
        expect(sms).toContain('4832')
        expect(sms).toContain('5 minutes')
        expect(getSmsTemplateBody('password_reset_otp')).toContain('{{verification_code}}')
    })

    it('uses the Notification Types SMS template when provided', () => {
        expect(buildPasswordResetOtpSms(
            '4832',
            'UI reset code {{verification_code}}. {{otp_expiry_minutes}} min.',
        )).toBe('UI reset code 4832. 5 min.')
    })

    it('matches reset tokens to email or phone identifiers', () => {
        expect(identifierMatchesCodeRow(
            { kind: 'email', value: 'ada@serapod.com' },
            { email_normalized: 'ada@serapod.com', phone_normalized: '+601163739729' },
        )).toBe(true)
        expect(identifierMatchesCodeRow(
            { kind: 'phone', value: '+601163739729' },
            { email_normalized: 'ada@serapod.com', phone_normalized: '+601163739729' },
        )).toBe(true)
        expect(identifierMatchesCodeRow(
            { kind: 'email', value: 'other@serapod.com' },
            { email_normalized: 'ada@serapod.com', phone_normalized: '+601163739729' },
        )).toBe(false)
    })
})
