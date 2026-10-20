import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ order: null as any, sent: [] as any[] }))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: state.order }) }
      return chain
    },
  }),
}))
vi.mock('@/server/auth/passwordResetService', () => ({ resolveOrgForEmail: async () => 'hq' }))
vi.mock('@/lib/payments', () => ({ getGatewayByProvider: async () => null }))
vi.mock('@/lib/email/transactional-html-email', () => ({
  sendTransactionalHtmlEmail: async (_admin: any, _org: string, input: any) => {
    state.sent.push(input)
    return { success: true }
  },
}))

import { buildStoreShippingEmail, notifyStoreOrderShipped, storeShippingEmailFor } from './order-shipped-email'
import { OWN_DELIVERY_LABEL } from './delivery'

describe('storeShippingEmailFor', () => {
  it('emails when a Store order first ships', () => {
    expect(storeShippingEmailFor({ salesChannel: 'store', fromStatus: 'paid', toStatus: 'shipped', toTracking: 'JT1' })).toBe('shipped')
  })
  it('emails again only for a new tracking number on a shipped order', () => {
    expect(storeShippingEmailFor({ salesChannel: 'store', fromStatus: 'shipped', toStatus: 'shipped', fromTracking: 'JT1', toTracking: 'JT2' })).toBe('tracking_updated')
    expect(storeShippingEmailFor({ salesChannel: 'store', fromStatus: 'shipped', toStatus: 'shipped', fromTracking: 'JT1', toTracking: 'JT1' })).toBeNull()
  })
  it('leaves Outdoor orders and other statuses alone', () => {
    expect(storeShippingEmailFor({ salesChannel: 'outdoor', fromStatus: 'paid', toStatus: 'shipped' })).toBeNull()
    expect(storeShippingEmailFor({ salesChannel: 'store', fromStatus: 'paid', toStatus: 'processing' })).toBeNull()
  })
})

describe('buildStoreShippingEmail', () => {
  const order = {
    order_ref: 'ORD-1',
    customer_name: 'Amirul Aiman',
    shipping_courier_name: 'J&T Express',
    shipping_tracking_no: 'JT123456',
    shipping_address: { line1: '49 Lebuh Acheh', postcode: '10200', city: 'Georgetown', state: 'Penang' },
    storefront_order_items: [{ product_name: 'Serapod Device S.Box', variant_name: 'Cosmos Black', quantity: 1 }],
  }

  it('gives the courier, tracking number, address and items', () => {
    const email = buildStoreShippingEmail('shipped', order)
    expect(email.subject).toBe('Order ORD-1 is on its way')
    for (const part of ['Hi Amirul', 'J&T Express', 'JT123456', '49 Lebuh Acheh', 'Serapod Device S.Box · Cosmos Black × 1']) {
      expect(email.text).toContain(part)
    }
    expect(email.html).toContain('JT123456')
    expect(email.html).toContain('J&amp;T Express')
  })

  it('says our own team delivers, without a tracking number', () => {
    const email = buildStoreShippingEmail('shipped', { ...order, shipping_courier_name: OWN_DELIVERY_LABEL, shipping_tracking_no: null })
    expect(email.text).toContain('Our own delivery team')
    expect(email.text).not.toContain('Tracking number')
  })
})

describe('notifyStoreOrderShipped', () => {
  beforeEach(() => {
    state.sent = []
    state.order = {
      order_ref: 'ORD-1',
      sales_channel: 'store',
      customer_name: 'Amirul',
      customer_email: 'amirul@example.com',
      shipping_courier_name: 'J&T Express',
      shipping_tracking_no: 'JT123456',
      storefront_order_items: [],
    }
  })

  it('emails the customer from Serapod2U Store', async () => {
    await notifyStoreOrderShipped('o1', 'shipped')
    expect(state.sent).toHaveLength(1)
    expect(state.sent[0].to).toBe('amirul@example.com')
    expect(state.sent[0].fromName).toBe('Serapod2U Store')
  })

  it('sends nothing without a reason, for Outdoor orders, or without an email', async () => {
    await notifyStoreOrderShipped('o1', null)
    state.order.sales_channel = 'outdoor'
    await notifyStoreOrderShipped('o1', 'shipped')
    state.order.sales_channel = 'store'
    state.order.customer_email = null
    await notifyStoreOrderShipped('o1', 'shipped')
    expect(state.sent).toHaveLength(0)
  })
})
