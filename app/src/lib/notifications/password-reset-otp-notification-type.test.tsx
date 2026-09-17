import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PASSWORD_RESET_OTP_EVENT, REQUIRED_NOTIFICATION_TYPES } from '@/lib/notifications/notificationEventCatalog'
import { getSmsTemplateBody, getSmsTemplatesForEvent } from '@/config/smsTemplates'
import { getTemplatesForEvent } from '@/config/notificationTemplates'

const root = path.resolve(__dirname, '../../..')
const migration = fs.readFileSync(
  path.join(root, '../supabase/migrations/20260911120000_password_reset_otp_sms_channel.sql'),
  'utf8',
)

describe('password_reset_otp notification type catalog', () => {
  it('registers email and SMS channels in the required catalog', () => {
    const row = REQUIRED_NOTIFICATION_TYPES.find((type) => type.event_code === PASSWORD_RESET_OTP_EVENT)
    expect(row).toBeTruthy()
    expect(row?.category).toBe('security')
    expect(row?.available_channels).toEqual(['email', 'sms'])
    expect(row?.default_enabled).toBe(true)
  })

  it('exposes SMS and email templates for the Notification Types drawer', () => {
    const sms = getTemplatesForEvent(PASSWORD_RESET_OTP_EVENT, 'sms')
    const email = getTemplatesForEvent(PASSWORD_RESET_OTP_EVENT, 'email')
    expect(sms[0]?.body).toContain('{{verification_code}}')
    expect(email[0]?.body).toContain('{{verification_code}}')
    expect(getSmsTemplatesForEvent(PASSWORD_RESET_OTP_EVENT)[0]?.id).toBe('pro_sms_1')
    expect(getSmsTemplateBody(PASSWORD_RESET_OTP_EVENT)).toContain('{{otp_expiry_minutes}}')
  })

  it('does not offer WhatsApp for consumer password reset OTP', () => {
    expect(getTemplatesForEvent(PASSWORD_RESET_OTP_EVENT, 'whatsapp')).toEqual([])
  })

  it('includes a migration that adds the SMS channel', () => {
    expect(migration).toContain("'password_reset_otp'")
    expect(migration).toContain("ARRAY['email', 'sms']")
  })
})
