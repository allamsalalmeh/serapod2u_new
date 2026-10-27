import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  order: null as any,
  sent: [] as any[],
  secretKey: 'sk_test_x' as string,
  fetchCalls: [] as string[],
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: state.order }) }
      return chain
    },
  }),
}))
vi.mock('@/server/auth/passwordResetService', () => ({ resolveOrgForEmail: async () => 'hq' }))
vi.mock('@/lib/payments', () => ({
  getGatewayByProvider: async () => ({ credentials: { secret_key: state.secretKey } }),
}))
vi.mock('@/lib/email/transactional-html-email', () => ({
  sendTransactionalHtmlEmail: async (_admin: any, _org: string, input: any) => {
    state.sent.push(input)
    return { success: true }
  },
}))

import { notifyStoreOrderPaid, STORE_INBOXES } from './order-paid-email'

const RECEIPT = 'https://pay.stripe.com/receipts/payment/abc'

describe('notifyStoreOrderPaid', () => {
  beforeEach(() => {
    state.order = {
      order_ref: 'ORD-1',
      sales_channel: 'store',
      customer_name: 'Amirul Aiman',
      customer_email: 'amirul@example.com',
      customer_phone: '0164021623',
      total_amount: 60,
      shipping_amount: 0,
      currency: 'MYR',
      shipping_address: { line1: '49 Lebuh Acheh', postcode: '10200', city: 'Georgetown', state: 'Penang' },
      payment_provider: 'stripe',
      payment_ref: 'cs_live_abc',
      paid_at: '2026-10-19T06:03:34.697Z',
      storefront_order_items: [{ product_name: 'Serapod Device S.Box', variant_name: 'Cosmos Black', quantity: 1, subtotal: 60 }],
    }
    state.sent = []
    state.secretKey = 'sk_test_x'
    state.fetchCalls = []
    vi.stubGlobal('fetch', async (url: string) => {
      state.fetchCalls.push(String(url))
      return { ok: true, json: async () => ({ payment_intent: { latest_charge: { receipt_url: RECEIPT } } }) }
    })
  })

  it('emails the customer the order details with the Stripe receipt, and the store inbox', async () => {
    await notifyStoreOrderPaid('o1')
    expect(state.sent.map((m) => m.to)).toEqual(['amirul@example.com', 'admin@serapod.com', 'jafar@serapod.com', 'store@serapod.com'])
    const [customer, staff] = state.sent
    expect(customer.fromName).toBe('Serapod2U Store')
    expect(customer.subject).toContain('ORD-1')
    for (const part of ['Serapod Device S.Box', 'Cosmos Black', 'RM', '49 Lebuh Acheh', RECEIPT]) {
      expect(customer.html).toContain(part)
      expect(customer.text).toContain(part)
    }
    expect(staff.text).toContain('0164021623')
    expect(staff.html).toContain('/ecommerce/store-orders')
    expect(state.fetchCalls[0]).toContain('/checkout/sessions/cs_live_abc')
  })

  it('still sends the details when the Stripe receipt cannot be read', async () => {
    state.secretKey = ''
    await notifyStoreOrderPaid('o1')
    expect(state.sent).toHaveLength(4)
    expect(state.sent[0].html).not.toContain('pay.stripe.com')
    expect(state.fetchCalls).toHaveLength(0)
  })

  it('leaves Outdoor orders to the Outdoor email', async () => {
    state.order.sales_channel = 'outdoor'
    await notifyStoreOrderPaid('o1')
    expect(state.sent).toHaveLength(0)
  })

  it('only tells the store inbox when the customer gave no email', async () => {
    state.order.customer_email = null
    await notifyStoreOrderPaid('o1')
    expect(state.sent.map((m) => m.to)).toEqual(STORE_INBOXES)
  })
})
