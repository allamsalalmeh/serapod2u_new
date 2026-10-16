import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  orders: [] as any[],
  updates: [] as Array<{ values: any; filters: Array<[string, ...any[]]> }>,
  applied: [] as any[],
  emails: [] as Array<[string, string]>,
}))

vi.mock('@/lib/outdoor/order-status-email', () => ({
  notifyOutdoorOrderStatus: async (orderId: string, kind: string) => { state.emails.push([orderId, kind]) },
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      let update: any = null
      const filters: Array<[string, ...any[]]> = []
      const builder: any = {
        update(values: any) { update = values; return builder },
        then(resolve: (value: any) => void) {
          if (update) {
            state.updates.push({ values: update, filters })
            resolve({ data: [{ id: 'x' }], error: null })
          } else {
            resolve({ data: state.orders, error: null })
          }
        },
      }
      for (const method of ['select', 'eq', 'in', 'lte', 'order', 'limit', 'ilike', 'is']) {
        builder[method] = (...args: any[]) => { filters.push([method, ...args]); return builder }
      }
      return builder
    },
  }),
}))

vi.mock('@/lib/payments', () => ({
  getGatewayByProvider: async () => ({ credentials: { secret_key: 'sk_test_1' } }),
}))

vi.mock('@/lib/payments/apply-callback', () => ({
  applyStorefrontPaymentResult: async (result: any) => { state.applied.push(result); return { updated: true } },
}))

import { expireUnpaidOrders, stripeSessionState } from './expire-unpaid-orders'
import { isUnpaidOrderExpired, unpaidOrderCutoff, unpaidOrderDeadline } from './unpaid-order-deadline'

const order = { id: 'o1', order_ref: 'ORD-1', payment_provider: 'stripe', payment_ref: 'cs_test_1' }

function stripeReplies(...replies: Array<{ status?: number; body?: any }>) {
  const fetchMock = vi.fn(async () => {
    const reply = replies.shift() || { status: 500 }
    const status = reply.status ?? 200
    return { ok: status < 300, status, json: async () => reply.body, text: async () => '' } as any
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('unpaid order deadline', () => {
  const now = new Date('2026-09-28T12:00:00Z')

  it('expires Outdoor orders waiting for payment 24 hours or more', () => {
    expect(isUnpaidOrderExpired({ status: 'pending_payment', sales_channel: 'outdoor', created_at: '2026-09-27T12:00:00Z' }, now)).toBe(true)
    expect(isUnpaidOrderExpired({ status: 'pending_payment', sales_channel: 'outdoor', created_at: '2026-09-27T12:01:00Z' }, now)).toBe(false)
  })

  it('leaves paid orders, classic store orders and bad dates alone', () => {
    expect(isUnpaidOrderExpired({ status: 'paid', sales_channel: 'outdoor', created_at: '2026-09-01T00:00:00Z' }, now)).toBe(false)
    expect(isUnpaidOrderExpired({ status: 'pending_payment', sales_channel: 'store', created_at: '2026-09-01T00:00:00Z' }, now)).toBe(false)
    expect(isUnpaidOrderExpired({ status: 'pending_payment', sales_channel: null, created_at: '2026-09-01T00:00:00Z' }, now)).toBe(false)
    expect(isUnpaidOrderExpired({ status: 'pending_payment', sales_channel: 'outdoor', created_at: 'nope' }, now)).toBe(false)
  })

  it('computes the cutoff and deadline 24 hours apart from the order time', () => {
    expect(unpaidOrderCutoff(now)).toBe('2026-09-27T12:00:00.000Z')
    expect(unpaidOrderDeadline('2026-09-27T12:00:00Z')?.toISOString()).toBe('2026-09-28T12:00:00.000Z')
    expect(unpaidOrderDeadline(null)).toBeNull()
  })
})

describe('stripeSessionState', () => {
  it('reads what the Checkout Session still allows', () => {
    expect(stripeSessionState({ status: 'complete', payment_status: 'paid' })).toBe('paid')
    expect(stripeSessionState({ status: 'complete', payment_status: 'unpaid' })).toBe('processing')
    expect(stripeSessionState({ status: 'open', payment_status: 'unpaid' })).toBe('open')
    expect(stripeSessionState({ status: 'expired', payment_status: 'unpaid' })).toBe('closed')
    expect(stripeSessionState(null)).toBe('closed')
  })
})

describe('expireUnpaidOrders', () => {
  beforeEach(() => {
    state.orders = [order]
    state.updates = []
    state.applied = []
    state.emails = []
  })
  afterEach(() => vi.unstubAllGlobals())

  it('closes an open Stripe page, then cancels the order it belonged to', async () => {
    const fetchMock = stripeReplies(
      { body: { id: 'cs_test_1', status: 'open', payment_status: 'unpaid' } },
      { body: { id: 'cs_test_1', status: 'expired', payment_status: 'unpaid' } },
    )
    const [result] = await expireUnpaidOrders()
    expect(result.outcome).toBe('cancelled')
    expect((fetchMock.mock.calls[1] as any[])[0]).toContain('/cs_test_1/expire')
    expect(state.updates).toHaveLength(1)
    expect(state.updates[0].values).toEqual({ status: 'cancelled' })
    expect(state.updates[0].filters).toContainEqual(['eq', 'status', 'pending_payment'])
    expect(state.updates[0].filters).toContainEqual(['eq', 'payment_ref', 'cs_test_1'])
    expect(state.emails).toEqual([['o1', 'auto_cancelled']])
  })

  it('marks the order paid instead when Stripe already took the money', async () => {
    stripeReplies({ body: { id: 'cs_test_1', status: 'complete', payment_status: 'paid' } })
    const [result] = await expireUnpaidOrders()
    expect(result.outcome).toBe('paid')
    expect(state.applied).toEqual([{ verified: true, orderId: 'o1', paid: true, transactionId: 'cs_test_1' }])
    expect(state.updates).toHaveLength(0)
    expect(state.emails).toEqual([])
  })

  it('catches a payment that completes while the page is being closed', async () => {
    stripeReplies(
      { body: { id: 'cs_test_1', status: 'open', payment_status: 'unpaid' } },
      { status: 400 },
      { body: { id: 'cs_test_1', status: 'complete', payment_status: 'paid' } },
    )
    const [result] = await expireUnpaidOrders()
    expect(result.outcome).toBe('paid')
    expect(state.updates).toHaveLength(0)
  })

  it('keeps orders whose payment is still settling or cannot be checked', async () => {
    stripeReplies({ body: { id: 'cs_test_1', status: 'complete', payment_status: 'unpaid' } })
    expect((await expireUnpaidOrders())[0].outcome).toBe('kept')
    stripeReplies({ status: 500 })
    expect((await expireUnpaidOrders())[0].outcome).toBe('kept')
    expect(state.updates).toHaveLength(0)
  })

  it('cancels when the session does not exist on this Stripe account', async () => {
    stripeReplies({ status: 404 })
    expect((await expireUnpaidOrders())[0].outcome).toBe('cancelled')
  })

  it('never cancels orders paid through another gateway it cannot check', async () => {
    state.orders = [{ ...order, payment_provider: 'billplz', payment_ref: 'bill_123' }]
    const fetchMock = stripeReplies()
    expect((await expireUnpaidOrders())[0].outcome).toBe('kept')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(state.updates).toHaveLength(0)
  })

  it('cancels an order placed while no gateway was on: it has no payment page', async () => {
    state.orders = [{ ...order, payment_provider: 'manual', payment_ref: 'MANUAL-ORD-1' }]
    const fetchMock = stripeReplies()
    expect((await expireUnpaidOrders())[0].outcome).toBe('cancelled')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(state.updates[0].filters).toContainEqual(['eq', 'payment_ref', 'MANUAL-ORD-1'])
    expect(state.emails).toEqual([['o1', 'auto_cancelled']])
  })
})
