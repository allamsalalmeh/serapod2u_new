import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DELETE_USER_OTP_EVENT, REQUIRED_NOTIFICATION_TYPES } from '@/lib/notifications/notificationEventCatalog'

const root = path.resolve(__dirname, '../../..')
const typesTab = fs.readFileSync(path.join(root, 'src/components/settings/NotificationTypesTab.tsx'), 'utf8')
const typeModules = fs.readFileSync(path.join(root, 'src/lib/notifications/notificationTypeModules.ts'), 'utf8')
const templates = fs.readFileSync(path.join(root, 'src/config/notificationTemplates.ts'), 'utf8')
const ensureTypes = fs.readFileSync(path.join(root, 'src/lib/notifications/ensureNotificationTypes.ts'), 'utf8')
const migration = fs.readFileSync(
  path.join(root, '../supabase/migrations/20260818100000_delete_user_otp_notification_type.sql'),
  'utf8',
)

describe('delete_user_otp notification type catalog (phase 1)', () => {
  it('registers delete_user_otp in the required notification catalog', () => {
    const row = REQUIRED_NOTIFICATION_TYPES.find((type) => type.event_code === DELETE_USER_OTP_EVENT)
    expect(row).toBeTruthy()
    expect(row?.category).toBe('security')
    expect(row?.available_channels).toEqual(['whatsapp', 'sms', 'email'])
    expect(row?.default_enabled).toBe(true)
  })

  it('exposes security category and whatsapp_sms_email_fallback preset in Notification Types UI', () => {
    expect(typeModules).toContain("security: 'Security & OTP'")
    expect(typesTab).toContain("'whatsapp_sms_email_fallback'")
    expect(typesTab).toContain('DELETE_USER_OTP_EVENT')
    expect(typesTab).toContain('Always on')
    expect(typesTab).toContain('Recipient is the organization contact.')
  })

  it('ships default templates for all delete_user_otp channels', () => {
    expect(templates).toContain("'delete_user_otp'")
    expect(templates).toContain("channel: 'whatsapp'")
    expect(templates).toContain("channel: 'sms'")
    expect(templates).toContain("channel: 'email'")
    expect(templates).toContain('{{verification_code}}')
  })

  it('seeds delete_user_otp via ensureNotificationTypes upsert', () => {
    expect(ensureTypes).toContain('REQUIRED_NOTIFICATION_TYPES')
    expect(ensureTypes).toContain("onConflict: 'event_code'")
  })

  it('includes a migration for notification_types', () => {
    expect(migration).toContain("'delete_user_otp'")
    expect(migration).toContain("ARRAY['whatsapp', 'sms', 'email']")
  })
})
