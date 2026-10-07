import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  denied: null as Response | null,
  rpc: vi.fn(),
  queue: vi.fn(),
  buildPayload: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: mocks.user }, error: mocks.user ? null : new Error('no session') }) },
    rpc: mocks.rpc,
  }),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/security-access/operation', () => ({ guardUserOperation: async () => mocks.denied }))
vi.mock('@/lib/notifications/supplyChainEventQueue', () => ({
  buildOrderEventPayload: mocks.buildPayload,
  queueNotificationEvent: mocks.queue,
}))

import { POST } from './route'

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const body = (patch: Record<string, unknown> = {}) => ({
  mode: 'update',
  orderId: uuid(1),
  requestedStatus: 'submitted',
  expectedUpdatedAt: '2026-10-07T01:02:03.123456+00:00',
  sellerOrgId: uuid(2),
  unitsPerCase: 4,
  qrBufferPercent: 10,
  extraQrMaster: 5,
  hasRfid: false,
  hasPoints: true,
  hasLuckyDraw: false,
  hasRedeem: false,
  notes: 'Customer: Secret Name, Phone: 0123, Address: Somewhere',
  items: [1000, 2000, 3000, 5000, 8000].map((qty, i) => ({ product_id: uuid(10), variant_id: uuid(20 + i), qty, unit_price: 12.5 })),
  ...patch,
})
const call = (b: unknown) => POST(new NextRequest('http://localhost/api/orders/save', { method: 'POST', body: JSON.stringify(b) }))
const saved = (status = 'submitted', replayed = false) => ({
  data: { order_id: uuid(1), order_no: 'ORD-DH-2610-01', status, updated_at: '2026-10-07T01:05:00.000001+00:00', item_count: 5, replayed },
  error: null,
})

describe('POST /api/orders/save', () => {
  beforeEach(() => {
    mocks.user = { id: 'user-1' }
    mocks.denied = null
    mocks.rpc.mockReset()
    mocks.queue.mockReset().mockResolvedValue({ queuedCount: 1 })
    mocks.buildPayload.mockReset().mockResolvedValue({ orgId: 'org-1', payload: { order_no: 'ORD-DH-2610-01' } })
    vi.spyOn(console, 'error').mockImplementation(() => { })
    vi.spyOn(console, 'info').mockImplementation(() => { })
    vi.spyOn(console, 'warn').mockImplementation(() => { })
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}')) as any
  })

  it('401 without a session and never calls the database', async () => {
    mocks.user = null
    const res = await call(body())
    expect(res.status).toBe(401)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('returns the S&A denial untouched and never calls the database', async () => {
    mocks.denied = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
    const res = await call(body())
    expect(res.status).toBe(403)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('400 on malformed bodies without touching the database', async () => {
    const res = await call(body({ items: [] }))
    expect(res.status).toBe(400)
    expect((await res.json()).outcome).toBe('not_saved')
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('saves all lines in ONE rpc call with only server-trusted parameters', async () => {
    mocks.rpc.mockResolvedValue(saved())
    const res = await call(body())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ success: true, outcome: 'saved', notification: 'queued', order: { itemCount: 5, status: 'submitted' } })
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    const [fn, params] = mocks.rpc.mock.calls[0]
    expect(fn).toBe('save_order_with_items')
    expect(params.p_items.map((i: any) => i.qty)).toEqual([1000, 2000, 3000, 5000, 8000])
    expect(params.p_expected_updated_at).toBe('2026-10-07T01:02:03.123456+00:00')
    expect(Object.keys(params).filter(k => /created|company|buyer|warehouse|actor|user/.test(k))).toEqual([])
  })

  it('does not queue a notification for drafts', async () => {
    mocks.rpc.mockResolvedValue(saved('draft'))
    const json = await (await call(body({ requestedStatus: 'draft' }))).json()
    expect(json.notification).toBe('skipped')
    expect(mocks.queue).not.toHaveBeenCalled()
  })

  it('queues with the same dedupe key as the order-event route so retries cannot double-notify', async () => {
    mocks.rpc.mockResolvedValue(saved('submitted', true))
    await call(body())
    expect(mocks.queue.mock.calls[0][1]).toMatchObject({ eventCode: 'order_submitted', dedupePayload: { order_no: 'ORD-DH-2610-01' } })
  })

  it('a failing notification never turns a committed save into a failure', async () => {
    mocks.rpc.mockResolvedValue(saved())
    mocks.queue.mockRejectedValue(new Error('outbox down'))
    const res = await call(body())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toMatchObject({ success: true, notification: 'failed' })
  })

  it.each([
    ['40001', 409, 'order_changed'],
    ['55000', 409, 'order_not_editable'],
    ['P0002', 404, 'order_not_found'],
    ['57014', 504, 'timeout'],
  ])('database error %s => not_saved / %s with stage and no notification', async (code, status, mapped) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message: 'boom', details: 'stage=delete_items' } })
    const res = await call(body())
    const json = await res.json()
    expect(res.status).toBe(status)
    expect(json).toMatchObject({ success: false, outcome: 'not_saved', code: mapped, stage: 'delete_items' })
    expect(json.correlationId).toMatch(/[0-9a-f-]{36}/)
    expect(mocks.queue).not.toHaveBeenCalled()
  })

  it('logs identifiers and stage but never customer notes or item payload', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout', details: 'stage=delete_items' } })
    await call(body())
    const logged = JSON.stringify((console.error as any).mock.calls)
    expect(logged).toContain('delete_items')
    expect(logged).toContain('57014')
    expect(logged).not.toContain('Secret Name')
    expect(logged).not.toContain('0123')
    expect(logged).not.toContain('product_id')
  })
})
