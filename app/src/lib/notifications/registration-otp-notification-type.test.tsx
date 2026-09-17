import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REGISTRATION_OTP_EVENT, REQUIRED_NOTIFICATION_TYPES } from '@/lib/notifications/notificationEventCatalog'
import { getSmsTemplateBody } from '@/config/smsTemplates'
import { getTemplatesForEvent } from '@/config/notificationTemplates'
import {
    buildRegistrationOtpSms,
    resolveRegistrationOtpChannel,
} from '@/server/auth/registrationVerificationService'

const root = path.resolve(__dirname, '../../..')
const migration = fs.readFileSync(
  path.join(root, '../supabase/migrations/20260911130000_registration_otp_sms_channel.sql'),
  'utf8',
)

describe('registration_otp notification type catalog', () => {
  it('registers email and SMS channels in the required catalog', () => {
    const row = REQUIRED_NOTIFICATION_TYPES.find((type) => type.event_code === REGISTRATION_OTP_EVENT)
    expect(row).toBeTruthy()
    expect(row?.category).toBe('security')
    expect(row?.available_channels).toEqual(['email', 'sms'])
  })

  it('exposes SMS and email templates for the Notification Types drawer', () => {
    expect(getTemplatesForEvent(REGISTRATION_OTP_EVENT, 'sms')[0]?.body).toContain('{{verification_code}}')
    expect(getTemplatesForEvent(REGISTRATION_OTP_EVENT, 'email')[0]?.body).toContain('{{verification_code}}')
    expect(getSmsTemplateBody(REGISTRATION_OTP_EVENT)).toContain('{{otp_expiry_minutes}}')
    expect(getTemplatesForEvent(REGISTRATION_OTP_EVENT, 'whatsapp')).toEqual([])
  })

  it('includes a migration that adds the SMS channel', () => {
    expect(migration).toContain("'registration_otp'")
    expect(migration).toContain("ARRAY['email', 'sms']")
  })
})

describe('registration OTP delivery', () => {
  it('uses SMS when Notification Types is set to SMS Only', () => {
    expect(resolveRegistrationOtpChannel({
      recipient_config: { routing: { preset: 'sms_only', source: 'event' } },
    })).toBe('sms')
  })

  it('defaults to email when no routing is saved', () => {
    expect(resolveRegistrationOtpChannel(null)).toBe('email')
  })

  it('renders the UI SMS template', () => {
    expect(buildRegistrationOtpSms(
      '4821',
      'Welcome code {{verification_code}} ({{otp_expiry_minutes}}m)',
    )).toBe('Welcome code 4821 (5m)')
  })
})
