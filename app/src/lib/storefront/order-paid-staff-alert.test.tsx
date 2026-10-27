import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { REQUIRED_NOTIFICATION_TYPES, STOREFRONT_ORDER_PAID_EVENT } from '@/lib/notifications/notificationEventCatalog'
import { getTemplatesForEvent } from '@/config/notificationTemplates'
import { buildNotificationSampleData, notificationVariableContract, renderPreviewSegments, unknownPlaceholders } from '@/lib/notifications/notificationMessagePreview'
import { initialOutboxAddress } from '@/lib/notifications/supplyChainEventQueue'
import { STORE_INBOXES } from '@/lib/storefront/order-paid-email'
import { OUTDOOR_STAFF_INBOXES } from '@/lib/outdoor/order-paid-email'

const state = vi.hoisted(() => ({ enabled: false as boolean | null, queued: [] as any[] }))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (table === 'notification_settings') return { data: state.enabled === null ? null : { enabled: state.enabled } }
          if (table === 'storefront_orders') return { data: order }
          return { data: null }
        },
      }
      return chain
    },
  }),
}))
vi.mock('@/server/auth/passwordResetService', () => ({ resolveOrgForSms: async () => 'hq' }))
vi.mock('@/lib/notifications/supplyChainEventQueue', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  queueNotificationEvent: async (_db: any, input: any) => {
    state.queued.push(input)
    return { queuedCount: 1, errors: [] }
  },
}))

const order = {
  order_ref: 'ORD-MVPDTUMR-HUXH',
  sales_channel: 'outdoor',
  customer_name: 'Ahmad Faiz bin Hassan',
  customer_email: 'buyer@example.com',
  customer_phone: '0123456789',
  total_amount: 289,
  currency: 'MYR',
  paid_at: '2026-10-27T06:15:00Z',
  storefront_order_items: [
    { product_name: 'Moonchair Highback', variant_name: 'Black', quantity: 1 },
    { product_name: 'Tumbler 1L', variant_name: 'Green', quantity: 2 },
  ],
}

describe('staff alert for a paid website order', () => {
  beforeEach(() => {
    state.enabled = false
    state.queued = []
  })

  it('queues nothing while the event is off or has no settings row', async () => {
    const { notifyStaffOrderPaid } = await import('./order-paid-staff-alert')
    await notifyStaffOrderPaid('o1')
    state.enabled = null
    await notifyStaffOrderPaid('o1')
    expect(state.queued).toEqual([])
  })

  it('queues once on the HQ org with SMS/WhatsApp only when switched on', async () => {
    state.enabled = true
    const { notifyStaffOrderPaid } = await import('./order-paid-staff-alert')
    await notifyStaffOrderPaid('o1')
    expect(state.queued).toHaveLength(1)
    expect(state.queued[0]).toMatchObject({
      orgId: 'hq',
      eventCode: STOREFRONT_ORDER_PAID_EVENT,
      dedupePayload: { order_ref: 'ORD-MVPDTUMR-HUXH' },
      allowedChannels: ['sms', 'whatsapp'],
    })
  })

  it('never carries the customer contact, so the customer is never a recipient', async () => {
    const { storefrontOrderPaidPayload } = await import('./order-paid-staff-alert')
    const payload = storefrontOrderPaidPayload(order)
    for (const key of ['customer_phone', 'contact_phone', 'phone', 'phone_number', 'created_by_phone', 'owner_phone', 'created_by_email', 'owner_email', 'order_id', 'order_no']) {
      expect(payload).not.toHaveProperty(key)
    }
    expect(JSON.stringify(payload)).not.toContain('0123456789')
    expect(JSON.stringify(payload)).not.toContain('buyer@example.com')
    const config = { recipient_targets: { roles: false, users: false, consumer: false, dynamic_org: false, order_creator: false }, custom_phones: '+60105619096' }
    expect(initialOutboxAddress(STOREFRONT_ORDER_PAID_EVENT, 'sms', payload, config)).toEqual({ phone: null, email: null })
  })

  it('the default SMS fills from the order and fits one SMS', async () => {
    const { storefrontOrderPaidPayload } = await import('./order-paid-staff-alert')
    const payload = storefrontOrderPaidPayload(order)
    const body = getTemplatesForEvent(STOREFRONT_ORDER_PAID_EVENT, 'sms')[0].body
    const sms = body.replace(/\{\{(\w+)\}\}/g, (_, key) => payload[key] ?? `{{${key}}}`)
    expect(sms).toBe('[Serapod2U] New paid Outdoor order ORD-MVPDTUMR-HUXH: RM 289.00, 3 item(s) from Ahmad Faiz bin Hassan.')
    expect(sms.length).toBeLessThanOrEqual(160)
    expect(storefrontOrderPaidPayload({ ...order, sales_channel: 'store' }).shop_name).toBe('Store')
  })

  it('is an E-Commerce type, off by default, SMS/WhatsApp, no email', () => {
    const type = REQUIRED_NOTIFICATION_TYPES.find((t) => t.event_code === STOREFRONT_ORDER_PAID_EVENT)!
    expect(type.category).toBe('ecommerce')
    expect(type.default_enabled).toBe(false)
    expect(type.available_channels).toEqual(['sms', 'whatsapp'])
    expect(getTemplatesForEvent(STOREFRONT_ORDER_PAID_EVENT, 'email')).toEqual([])
    expect(getTemplatesForEvent(STOREFRONT_ORDER_PAID_EVENT, 'whatsapp')).toHaveLength(1)
  })

  it('the template screen offers the order variables with a filled example', () => {
    const type = { event_code: STOREFRONT_ORDER_PAID_EVENT, category: 'ecommerce' }
    const { variables, verified } = notificationVariableContract(type)
    expect(verified).toBe(true)
    for (const channel of ['sms', 'whatsapp']) {
      const body = getTemplatesForEvent(STOREFRONT_ORDER_PAID_EVENT, channel)[0].body
      expect(unknownPlaceholders(body, variables)).toEqual([])
      const preview = renderPreviewSegments(body, buildNotificationSampleData(type), variables)
      expect(preview.some((s) => s.kind === 'unresolved')).toBe(false)
    }
  })

  it('staff emails keep every existing inbox and add store@', () => {
    expect(STORE_INBOXES).toEqual(['admin@serapod.com', 'jafar@serapod.com', 'store@serapod.com'])
    expect(OUTDOOR_STAFF_INBOXES).toEqual(['outdoor@serapod.com', 'store@serapod.com'])
  })

  it('migration seeds only the catalog row', () => {
    const sql = readFileSync(join(__dirname, '../../../../supabase/migrations/20261216100000_storefront_order_paid_notification_type.sql'), 'utf8')
    expect(sql).toContain("'storefront_order_paid'")
    expect(sql).not.toMatch(/notification_settings|DELETE|DROP/i)
  })
})
