import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)

const buildOrderEventPayload = vi.fn()
vi.mock('@/lib/notifications/supplyChainEventQueue', async (original) => ({
  ...(await original<any>()),
  buildOrderEventPayload: (...args: any[]) => buildOrderEventPayload(...args),
}))

let orders: any[] = []
let users: any[] = []
let orderError: { message: string } | null = null

function table(name: string) {
  const filters: Array<[string, string, any]> = []
  const rows = () => (name === 'orders' ? orders : users).filter((row) => filters.every(([op, column, value]) => (op === 'eq' ? row[column] === value : value.includes(row[column]))))
  const query: any = {
    select: () => query,
    eq: (column: string, value: any) => { filters.push(['eq', column, value]); return query },
    in: (column: string, value: any) => { filters.push(['in', column, value]); return query },
    or: () => { throw new Error('the route must not build filter strings from input') },
    limit: () => query,
    single: async () => ({ data: rows()[0] || null, error: null }),
    maybeSingle: async () => (name === 'orders' && orderError ? { data: null, error: orderError } : { data: rows()[0] || null, error: null }),
    then: (resolve: (value: any) => void) => resolve({ data: rows(), error: null }),
  }
  return query
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'admin-1' } } }) },
    from: table,
  }),
}))

const config = { roles: ['HQ_ADMIN'], recipient_targets: { order_creator: true, roles: true, users: false, consumer: false, dynamic_org: false } }

function request(params: Record<string, string>) {
  return new NextRequest(`http://localhost/api/notifications/resolve?${new URLSearchParams(params)}`)
}

async function call(params: Record<string, string>) {
  const { GET } = await import('./route')
  const response = await GET(request(params))
  return { status: response.status, body: await response.json() }
}

beforeEach(() => {
  orderError = null
  users = [
    { id: 'admin-1', organization_id: 'org-1', role_code: 'SUPER', is_active: true, full_name: 'Caller', phone: null },
    { id: 'u1', organization_id: 'org-1', role_code: 'HQ_ADMIN', is_active: true, full_name: 'Hana Admin', phone: '0121111111', email: 'hana@example.com' },
    { id: 'u2', organization_id: 'org-9', role_code: 'HQ_ADMIN', is_active: true, full_name: 'Elsewhere', phone: '0122222222', email: 'x@example.com' },
  ]
  orders = [{ id: 'o-1', display_doc_no: 'ORD26000001', order_no: 'ORD-1', company_id: 'org-1', buyer_org_id: 'org-5', seller_org_id: 'org-1' }]
  buildOrderEventPayload.mockReset()
  buildOrderEventPayload.mockResolvedValue({ payload: { order_no: 'ORD26000001', created_by: 'Cara Creator', created_by_id: 'c1', created_by_phone: '0129999999', created_by_email: 'cara@example.com' } })
})

describe('GET /api/notifications/resolve', () => {
  it('returns real, organization-scoped recipients for the channel and never sample people', async () => {
    const { status, body } = await call({ eventCode: 'order_submitted', sampleId: 'ORD26000001', channel: 'whatsapp', recipientConfig: JSON.stringify(config) })
    expect(status).toBe(200)
    expect(body.status).toBe('resolved')
    expect(body.recipients.map((r: any) => [r.address, r.source, r.name])).toEqual([
      ['+60129999999', 'order_creator', 'Cara Creator'],
      ['+60121111111', 'roles', 'Hana Admin'],
    ])
    expect(JSON.stringify(body)).not.toMatch(/Alice|Bob Warehouse|mock-/)
  })

  it('says empty when the order exists but nobody resolves', async () => {
    const none = { recipient_targets: { order_creator: false, roles: false, users: false, consumer: false, dynamic_org: true } }
    const { body } = await call({ eventCode: 'order_approved', sampleId: 'ORD26000001', channel: 'whatsapp', recipientConfig: JSON.stringify(none) })
    expect(body).toMatchObject({ success: true, status: 'empty', recipients: [], notUsedWhenSending: ['dynamic_org'] })
  })

  it('says not_found for an order outside the caller organization', async () => {
    orders[0].company_id = 'org-7'
    orders[0].seller_org_id = 'org-7'
    const { body } = await call({ eventCode: 'order_submitted', sampleId: 'ORD26000001', channel: 'sms', recipientConfig: JSON.stringify(config) })
    expect(body).toMatchObject({ success: true, status: 'not_found', recipients: [] })
    expect(buildOrderEventPayload).not.toHaveBeenCalled()
  })

  it('says unsupported for notifications without a sample-record lookup', async () => {
    const { body } = await call({ eventCode: 'low_stock_alert', sampleId: 'X', channel: 'whatsapp' })
    expect(body).toMatchObject({ success: true, status: 'unsupported', recipients: [] })
  })

  it('reports a failed lookup as an error, not as recipients', async () => {
    orderError = { message: 'db down' }
    const { status, body } = await call({ eventCode: 'order_submitted', sampleId: 'ORD26000001', channel: 'whatsapp', recipientConfig: JSON.stringify(config) })
    expect(status).toBe(500)
    expect(body).toEqual({ success: false, status: 'error', error: 'db down' })
  })

  it('rejects an unknown channel', async () => {
    const { status, body } = await call({ eventCode: 'order_submitted', sampleId: 'ORD26000001', channel: 'fax' })
    expect(status).toBe(400)
    expect(body.status).toBe('error')
  })
})
