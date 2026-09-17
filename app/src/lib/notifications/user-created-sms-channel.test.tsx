import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { REQUIRED_NOTIFICATION_TYPES } from '@/lib/notifications/notificationEventCatalog'
import { getTemplatesForEvent } from '@/config/notificationTemplates'

const root = path.resolve(__dirname, '../../..')
const migration = fs.readFileSync(
  path.join(root, '../supabase/migrations/20260911140000_user_created_sms_channel.sql'),
  'utf8',
)

describe('user_created SMS channel in Notification Types', () => {
  it('exposes email and SMS so the SMS body can be edited in the UI', () => {
    const row = REQUIRED_NOTIFICATION_TYPES.find((type) => type.event_code === 'user_created')
    expect(row?.available_channels).toEqual(['email', 'sms'])
    expect(getTemplatesForEvent('user_created', 'sms').length).toBeGreaterThan(0)
  })

  it('includes a migration that adds the SMS channel', () => {
    expect(migration).toContain("'user_created'")
    expect(migration).toContain("ARRAY['email', 'sms']")
  })
})
