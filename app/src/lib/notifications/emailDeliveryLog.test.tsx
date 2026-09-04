import { describe, expect, it, vi } from 'vitest'
import {
  emailDeliveryLogRow,
  recordEmailDelivery,
} from '@/lib/notifications/emailDeliveryLog'

const NOW = '2026-09-04T02:10:14.764Z'

const base = {
  orgId: 'd83bac94-0722-4901-9ca8-619788eab744',
  to: 'allamsalameh@hotmail.com',
  eventCode: 'password_reset_otp',
}

describe('emailDeliveryLogRow', () => {
  it('writes a row the email monitor can read', () => {
    const row = emailDeliveryLogRow({ ...base, result: { success: true, providerName: 'smtp' } }, NOW)
    expect(row.channel).toBe('email')
    expect(row.recipient_type).toBe('email')
    expect(row.status).toBe('sent')
    expect(row.org_id).toBe(base.orgId)
    expect(row.sent_at).toBe(NOW)
    expect(row.failed_at).toBeNull()
    expect(row.error_message).toBeNull()
  })

  it('keeps the failure reason and leaves no provider on an unsent email', () => {
    const row = emailDeliveryLogRow({
      ...base,
      result: { success: false, error: 'No active email provider configured' },
    }, NOW)
    expect(row.status).toBe('failed')
    expect(row.provider_name).toBeNull()
    expect(row.error_message).toBe('No active email provider configured')
    expect(row.sent_at).toBeNull()
    expect(row.failed_at).toBe(NOW)
  })

  it('always carries a reason for a failure', () => {
    const row = emailDeliveryLogRow({ ...base, result: { success: false } }, NOW)
    expect(row.error_message).toBe('Email delivery failed')
  })
})

describe('recordEmailDelivery', () => {
  it('inserts into notification_logs', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: vi.fn().mockReturnValue({ insert }) }

    await recordEmailDelivery(supabase, { ...base, result: { success: true, providerName: 'smtp' } })

    expect(supabase.from).toHaveBeenCalledWith('notification_logs')
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ channel: 'email', status: 'sent' }))
  })

  it('swallows a logging failure so the password reset still completes', async () => {
    const supabase = {
      from: () => ({ insert: () => Promise.reject(new Error('notification_logs is unreachable')) }),
    }
    await expect(
      recordEmailDelivery(supabase, { ...base, result: { success: true } }),
    ).resolves.toBeUndefined()
  })
})
