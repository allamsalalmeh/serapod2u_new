import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)
vi.mock('@/lib/security-access/resource-context', async () => (await import('@/test-support/sa-legacy-mode')).resourceContextModule)

const authGetUser = vi.fn()
const profileSingle = vi.fn()
const maybeSingle = vi.fn()
const updateCalls: Array<{ payload: any; filters: string[] }> = []
const stockRpc = vi.fn()

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

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: authGetUser } })),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    rpc: stockRpc,
    from: (table: string) => {
      if (table === 'users') {
        return { select: () => ({ eq: () => ({ single: profileSingle }) }) }
      }
      const call = { payload: null as any, filters: [] as string[] }
      const chain: any = {
        update: (payload: any) => { call.payload = payload; updateCalls.push(call); return chain },
        eq: (column: string, value: string) => { call.filters.push(`eq:${column}=${value}`); return chain },
        or: (filter: string) => { call.filters.push(`or:${filter}`); return chain },
        select: () => chain,
        maybeSingle,
      }
      return chain
    },
  })),
}))

const ORDER_ID = '3f1c2b7e-8a44-4c55-9d7e-0a1b2c3d4e5f'

const put = (body: Record<string, unknown>) => new Request('http://localhost/api/admin/store/orders', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}) as any

describe('PUT /api/admin/store/orders — shipping an order', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    updateCalls.length = 0
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin-1' } }, error: null })
    profileSingle.mockResolvedValue({
      data: { id: 'admin-1', organization_id: 'hq', role_code: 'HQ', organizations: { id: 'hq', org_type_code: 'HQ' }, roles: { role_level: 10 } },
    })
    stockRpc.mockResolvedValue({ data: { status: 'taken', units: 1 }, error: null })
  })

  it('refuses to ship an Outdoor order without a courier and tracking number', async () => {
    maybeSingle.mockResolvedValueOnce({ data: { id: ORDER_ID, sales_channel: 'outdoor', shipping_tracking_no: null, shipping_courier_name: null } })
    const { PUT } = await import('./route')
    const response = await PUT(put({ id: ORDER_ID, status: 'shipped', trackingNo: 'JT123' }))
    expect(response.status).toBe(400)
    expect(updateCalls).toHaveLength(0)
    expect(notifyStatus).not.toHaveBeenCalled()
  })

  it('saves the courier and tracking number when shipping an Outdoor order', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { id: ORDER_ID, sales_channel: 'outdoor', shipping_tracking_no: null, shipping_courier_name: null } })
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'shipped' }, error: null })
    const { PUT } = await import('./route')
    const response = await PUT(put({ id: ORDER_ID, status: 'shipped', trackingNo: ' JT123 ', courierName: 'J&T Express' }))
    expect(response.status).toBe(200)
    expect(updateCalls[0].payload).toEqual({ status: 'shipped', shipping_tracking_no: 'JT123', shipping_courier_name: 'J&T Express' })
    expect(notifyStatus).toHaveBeenCalledWith(ORDER_ID, 'shipped', { moneyReturned: false })
    expect(notifyShipped).toHaveBeenCalledWith(ORDER_ID, null)
  })

  it('keeps classic store orders shippable without tracking', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { id: ORDER_ID, sales_channel: 'store', shipping_tracking_no: null, shipping_courier_name: null } })
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'shipped' }, error: null })
    const { PUT } = await import('./route')
    const response = await PUT(put({ id: ORDER_ID, status: 'shipped' }))
    expect(response.status).toBe(200)
    expect(updateCalls[0].payload).toEqual({ status: 'shipped' })
    expect(notifyStatus).toHaveBeenCalledWith(ORDER_ID, null, { moneyReturned: false })
    expect(notifyShipped).toHaveBeenCalledWith(ORDER_ID, 'shipped')
  })

  it('ships an Outdoor order with our own delivery team, without a tracking number', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'processing', sales_channel: 'outdoor', shipping_tracking_no: null, shipping_courier_name: null } })
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'shipped' }, error: null })
    const { PUT } = await import('./route')
    const response = await PUT(put({ id: ORDER_ID, status: 'shipped', deliveryMethod: 'own', trackingNo: 'ignored' }))
    expect(response.status).toBe(200)
    expect(updateCalls[0].payload).toEqual({
      status: 'shipped',
      shipping_courier_name: 'Serapod delivery team',
      shipping_tracking_no: null,
    })
  })

  it('takes the stock out of the warehouse when a paid order ships', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'paid', sales_channel: 'store' } })
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'shipped' }, error: null })
    const { PUT } = await import('./route')
    const response = await PUT(put({ id: ORDER_ID, status: 'shipped' }))
    expect(response.status).toBe(200)
    expect(stockRpc).toHaveBeenCalledWith('storefront_order_stock_out', { p_order_id: ORDER_ID, p_actor: 'admin-1' })
  })

  it('does not ship when the warehouse cannot cover the order', async () => {
    maybeSingle.mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'processing', sales_channel: 'store' } })
    stockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'storefront_stock_short: Cellera (Mango) has 0 in the warehouse, this order needs 2.' },
    })
    const { PUT } = await import('./route')
    const response = await PUT(put({ id: ORDER_ID, status: 'shipped' }))
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('Cellera (Mango) has 0 in the warehouse')
    expect(updateCalls).toHaveLength(0)
  })

  it('puts the stock back as not-shipped when the status cannot be saved', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'paid', sales_channel: 'store' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
    const { PUT } = await import('./route')
    const response = await PUT(put({ id: ORDER_ID, status: 'shipped' }))
    expect(response.status).toBe(500)
    expect(stockRpc).toHaveBeenLastCalledWith('storefront_order_stock_undo', { p_order_id: ORDER_ID, p_actor: 'admin-1' })
  })

  it('keeps shipping as before while the stock functions are not deployed', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'paid', sales_channel: 'store' } })
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'shipped' }, error: null })
    stockRpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })
    const { PUT } = await import('./route')
    const response = await PUT(put({ id: ORDER_ID, status: 'shipped' }))
    expect(response.status).toBe(200)
  })

  it('does not take stock again when a shipped order is marked delivered', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'shipped', sales_channel: 'store' } })
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'delivered' }, error: null })
    const { PUT } = await import('./route')
    await PUT(put({ id: ORDER_ID, status: 'delivered' }))
    expect(stockRpc).not.toHaveBeenCalled()
  })

  it('leaves shipping details alone for other status changes', async () => {
    maybeSingle
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'shipped', sales_channel: 'outdoor' } })
      .mockResolvedValueOnce({ data: { id: ORDER_ID, status: 'delivered' }, error: null })
    const { PUT } = await import('./route')
    const response = await PUT(put({ id: ORDER_ID, status: 'delivered', trackingNo: 'ignored', deliveryMethod: 'own' }))
    expect(response.status).toBe(200)
    expect(updateCalls[0].payload).toEqual({ status: 'delivered' })
    expect(notifyStatus).toHaveBeenCalledWith(ORDER_ID, 'delivered', { moneyReturned: false })
  })
})
