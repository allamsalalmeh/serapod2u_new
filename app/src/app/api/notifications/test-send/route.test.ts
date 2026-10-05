import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)

const logInsert = vi.fn()
const sendSms = vi.fn()
vi.mock('@/lib/notifications/sms-send', () => ({ sendSmsWithActiveProvider: (...args: any[]) => sendSms(...args) }))
vi.mock('@/app/api/settings/whatsapp/_utils', () => ({ getWhatsAppConfig: vi.fn(), sendWhatsAppMessage: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } }, error: null }) },
    from: (table: string) => {
      if (table === 'notification_logs') return { insert: (row: any) => { logInsert(row); return Promise.resolve({ error: null }) } }
      const query: any = { select: () => query, eq: () => query, single: async () => ({ data: { organization_id: 'org-1' } }) }
      return query
    },
  }),
}))

async function post(body: Record<string, unknown>) {
  const { POST } = await import('./route')
  const response = await POST(new NextRequest('http://localhost/api/notifications/test-send', { method: 'POST', body: JSON.stringify(body) }))
  return { status: response.status, body: await response.json() }
}

beforeEach(() => { logInsert.mockReset(); sendSms.mockReset() })

describe('POST /api/notifications/test-send', () => {
  it('never reports an email test as sent and records nothing', async () => {
    const { status, body } = await post({ eventCode: 'order_submitted', channel: 'email', recipient: { email: 'a@example.com' }, template: 'Hello', sampleData: {} })
    expect(status).toBe(501)
    expect(body).toMatchObject({ success: false, status: 'unsupported' })
    expect(logInsert).not.toHaveBeenCalled()
  })

  it('renders the template with sample data and leaves unknown placeholders visible', async () => {
    sendSms.mockResolvedValue({ success: true, messageId: 'm1' })
    const { body } = await post({ eventCode: 'order_approved', channel: 'sms', recipient: { phone: '60123456789' }, template: 'Order {{order_no}} by {{User}} {{user}}', sampleData: { order_no: 'ORD1', User: 'Cara' } })
    expect(body.success).toBe(true)
    expect(sendSms.mock.calls[0][3]).toBe('Order ORD1 by Cara {{user}}')
    expect(logInsert.mock.calls[0][0]).toMatchObject({ channel: 'sms', status: 'sent', recipient_type: 'phone' })
  })
})
