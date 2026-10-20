import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)
vi.mock('@/lib/security-access/resource-context', async () => (await import('@/test-support/sa-legacy-mode')).resourceContextModule)

const authGetUser = vi.fn()
const profileSingle = vi.fn()
const maybeSingle = vi.fn()
const updateCalls: Array<{ payload: any }> = []
const refundStripeCheckout = vi.fn()
const stockRpc = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: authGetUser } })),
}))

vi.mock('@/lib/payments', () => ({
  getGatewayByProvider: vi.fn(async () => ({ credentials: { secret_key: 'sk_test_x' } })),
}))

vi.mock('@/lib/payments/stripe-refund', () => ({ refundStripeCheckout }))

const notifyStatus = vi.hoisted(() => vi.fn())
vi.mock('@/lib/outdoor/order-status-email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/outdoor/order-status-email')>()),
  notifyOutdoorOrderStatus: notifyStatus,
}))
const notifyShipped = vi.hoisted(() => vi.fn())
vi.mock('@/lib/storefront/order-shipped-email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/storefront/order-shipped-email')>()),
  notifyStoreOrderShipped: notifyShipped,
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    rpc: stockRpc,
    from: (table: string) => {
      if (table === 'users') {
        return { select: () => ({ eq: () => ({ single: profileSingle }) }) }
      }
      const call = { payload: null as any }
      const chain: any = {
        update: (payload: any) => { call.payload = payload; updateCalls.push(call); return chain },
        insert: async () => ({ error: null }),
        eq: () => chain,
        or: () => chain,
        select: () => chain,
        maybeSingle,
      }
      return chain
    },
  })),
}))

const ORDER_ID = '3f1c2b7e-8a44-4c55-9d7e-0a1b2c3d4e5f'
const stripeOrder = {
  id: ORDER_ID, order_ref: 'ORD-1', status: 'paid', sales_channel: 'outdoor',
  payment_provider: 'stripe', payment_ref: 'cs_live_abc', total_amount: 2, currency: 'MYR',
}

const put = (body: Record<string, unknown>) => new Request('http://localhost/api/admin/store/orders', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}) as any

describe('PUT /api/admin/store/orders — refunds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updateCalls.length = 0
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin-1' } }, error: null })
    profileSingle.mockResolvedValue({
      data: { id: 'admin-1', organization_id: 'hq', role_code: 'HQ', organizations: { id: 'hq', org_type_code: 'HQ' }, roles: { role_level: 10 } },
    })
    stockRpc.mockResolvedValue({ data: { status: 'returned', units: 2 }, error: null })
  })

  it('puts shipped goods back in stock only when staff say they came back', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { ...stripeOrder, status: 'shipped' } })
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'refunded' }, error: null })
    refundStripeCheckout.mockResolvedValueOnce({ ok: true, refundId: 're_3', amountCents: 200, alreadyRefunded: false })
    const { PUT } = await import('./route')
    const response = await PUT(put({ id: ORDER_ID, status: 'refunded', restock: true }))
    expect(response.status).toBe(200)
    expect(stockRpc).toHaveBeenCalledWith('storefront_order_stock_return', { p_order_id: ORDER_ID, p_actor: 'admin-1' })
  })

  it('leaves the stock alone on a refund when the goods did not come back', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { ...stripeOrder, status: 'shipped' } })
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'refunded' }, error: null })
    refundStripeCheckout.mockResolvedValueOnce({ ok: true, refundId: 're_4', amountCents: 200, alreadyRefunded: false })
    const { PUT } = await import('./route')
    await PUT(put({ id: ORDER_ID, status: 'refunded' }))
    expect(stockRpc).not.toHaveBeenCalled()
  })

  it('still refunds, and says so, when putting the stock back fails', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { ...stripeOrder, status: 'shipped' } })
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'refunded' }, error: null })
    refundStripeCheckout.mockResolvedValueOnce({ ok: true, refundId: 're_5', amountCents: 200, alreadyRefunded: false })
    stockRpc.mockResolvedValueOnce({ data: null, error: { message: 'inventory_cutoff_warehouse_frozen' } })
    const { PUT } = await import('./route')
    const response = await PUT(put({ id: ORDER_ID, status: 'refunded', restock: true }))
    expect(response.status).toBe(200)
    expect((await response.json()).warning).toContain('stock count')
  })

  it('returns the money on Stripe before marking a paid order refunded', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: stripeOrder })
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'refunded' }, error: null })
    refundStripeCheckout.mockResolvedValueOnce({ ok: true, refundId: 're_1', amountCents: 200, alreadyRefunded: false })
    const { PUT } = await import('./route')
    const response = await PUT(put({ id: ORDER_ID, status: 'refunded' }))
    expect(response.status).toBe(200)
    expect(refundStripeCheckout).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'cs_live_abc', secretKey: 'sk_test_x', orderRef: 'ORD-1' }))
    expect(updateCalls[0].payload).toEqual({ status: 'refunded' })
    expect(notifyStatus).toHaveBeenCalledWith(ORDER_ID, 'refunded', { moneyReturned: true })
  })

  it('also refunds when a paid order is cancelled', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { ...stripeOrder, status: 'processing' } })
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'cancelled' }, error: null })
    refundStripeCheckout.mockResolvedValueOnce({ ok: true, refundId: 're_2', amountCents: 200, alreadyRefunded: false })
    const { PUT } = await import('./route')
    const response = await PUT(put({ id: ORDER_ID, status: 'cancelled' }))
    expect(response.status).toBe(200)
    expect(refundStripeCheckout).toHaveBeenCalledTimes(1)
    expect(notifyStatus).toHaveBeenCalledWith(ORDER_ID, 'cancelled', { moneyReturned: true })
  })

  it('leaves the order untouched when Stripe refuses the refund', async () => {
    maybeSingle.mockResolvedValueOnce({ data: stripeOrder })
    refundStripeCheckout.mockResolvedValueOnce({ ok: false, error: 'Insufficient balance' })
    const { PUT } = await import('./route')
    const response = await PUT(put({ id: ORDER_ID, status: 'refunded' }))
    expect(response.status).toBe(502)
    expect((await response.json()).error).toContain('Insufficient balance')
    expect(updateCalls).toHaveLength(0)
    expect(notifyStatus).not.toHaveBeenCalled()
  })

  it('asks staff to confirm a refund made outside the dashboard for other payment methods', async () => {
    maybeSingle.mockResolvedValueOnce({ data: { ...stripeOrder, payment_provider: 'billplz', payment_ref: 'bill_1' } })
    const { PUT } = await import('./route')
    const refused = await PUT(put({ id: ORDER_ID, status: 'refunded' }))
    expect(refused.status).toBe(409)
    expect(updateCalls).toHaveLength(0)

    maybeSingle
      .mockResolvedValueOnce({ data: { ...stripeOrder, payment_provider: 'billplz', payment_ref: 'bill_1' } })
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'refunded' }, error: null })
    const confirmed = await PUT(put({ id: ORDER_ID, status: 'refunded', refundedOutside: true }))
    expect(confirmed.status).toBe(200)
    expect(refundStripeCheckout).not.toHaveBeenCalled()
  })

  it('cancels an unpaid order without touching Stripe', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { ...stripeOrder, status: 'pending_payment' } })
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'cancelled' }, error: null })
    const { PUT } = await import('./route')
    const response = await PUT(put({ id: ORDER_ID, status: 'cancelled' }))
    expect(response.status).toBe(200)
    expect(refundStripeCheckout).not.toHaveBeenCalled()
    expect(notifyStatus).toHaveBeenCalledWith(ORDER_ID, 'cancelled', { moneyReturned: false })
  })
})
