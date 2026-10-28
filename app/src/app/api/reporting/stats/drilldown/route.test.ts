import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const guard = vi.hoisted(() => ({ denied: null as Response | null }))
vi.mock('@/lib/security-access/operation', () => ({ guardUserOperation: vi.fn(async () => guard.denied) }))

const DIST_A = { id: '11111111-1111-4111-8111-111111111111', org_name: 'Dist A', org_code: 'DA01', org_type_code: 'DIST' }
const DIST_B = { id: '22222222-2222-4222-8222-222222222222', org_name: 'Dist B', org_code: 'DB02', org_type_code: 'DIST' }
const SHOP = { id: '33333333-3333-4333-8333-333333333333', org_name: 'Kedai Satu', org_code: null, org_type_code: 'SHOP' }
const HQ = { id: '44444444-4444-4444-8444-444444444444', org_name: 'HQ', org_code: 'HQ', org_type_code: 'HQ' }

let seq = 0
function order(order_type: string, status: string, order_date: string, buyer: any, line_total: number, qty = 1) {
  seq += 1
  return {
    id: `o${seq}`, order_no: `SO${seq}`, display_doc_no: null, order_type, status, order_date,
    created_at: `${order_date}T02:00:00Z`, buyer_org_id: buyer.id, buyer, order_items: [{ variant_id: 'v1', qty, unit_price: null, line_total }],
  }
}

const ORDERS = [
  order('D2H', 'approved', '2026-09-01', DIST_A, 100),
  order('D2H', 'closed', '2026-09-30', DIST_A, 300), // DIST_A twice → one buyer
  order('S2D', 'shipped_distributor', '2026-09-12', SHOP, 40),
  order('D2H', 'warehouse_packed', '2026-08-31', DIST_B, 50), // August
  order('D2H', 'submitted', '2026-09-05', DIST_B, 900),
  order('D2H', 'cancelled', '2026-09-06', DIST_B, 700),
  order('H2M', 'approved', '2026-09-06', HQ, 10000),
  order('D2H', 'approved', '2026-10-01', DIST_B, 77), // October
]

const calls: { table: string; filters: string[] }[] = []
let visibleOrders: any[] = ORDERS
let authedUser: { id: string } | null = { id: 'u1' }
const createClient = vi.fn(async () => ({
  auth: { getUser: async () => ({ data: { user: authedUser }, error: authedUser ? null : new Error('no session') }) },
  from: (table: string) => {
    let result = table === 'orders' ? [...visibleOrders] : []
    const call = { table, filters: [] as string[] }
    calls.push(call)
    const q: any = {
      select: () => q,
      eq: (col: string, v: any) => { call.filters.push(`${col}=${v}`); result = result.filter((r) => r[col] === v); return q },
      in: (col: string, values: any[]) => { call.filters.push(`${col} in ${values.join(',')}`); result = result.filter((r) => values.includes(r[col])); return q },
      gte: (col: string, v: any) => { call.filters.push(`${col}>=${v}`); result = result.filter((r) => r[col] >= v); return q },
      lt: (col: string, v: any) => { call.filters.push(`${col}<${v}`); result = result.filter((r) => r[col] < v); return q },
      order: (col: string, opts: any) => { result.sort((a, b) => (opts?.ascending === false ? -1 : 1) * String(a[col]).localeCompare(String(b[col]))); return q },
      limit: (n: number) => { result = result.slice(0, n); return q },
      range: (from: number, to: number) => { result = result.slice(from, to + 1); return q },
      then: (resolve: any) => Promise.resolve({ data: result, error: null }).then(resolve),
    }
    return q
  },
}))
vi.mock('@/lib/supabase/server', () => ({ createClient }))

async function drill(qs: string) {
  const { GET } = await import('./route')
  return GET(new Request(`http://x/api/reporting/stats/drilldown${qs}`))
}
async function stats(qs: string) {
  const { GET } = await import('../route')
  return GET(new Request(`http://x/api/reporting/stats${qs}`))
}

describe('GET /api/reporting/stats/drilldown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-20T10:00:00+08:00'))
    calls.length = 0
    visibleOrders = ORDERS
    authedUser = { id: 'u1' }
    guard.denied = null
  })
  afterEach(() => vi.useRealTimers())

  it('returns the confirmed orders of the selected month and reconciles with /api/reporting/stats', async () => {
    const res = await drill('?metric=confirmed_orders&month=2026-09')
    expect(res.status).toBe(200)
    const { drilldown } = await res.json()
    const { report } = await (await stats('?month=2026-09')).json()
    expect(drilldown.total).toBe(report.summary.approvedSalesOrders)
    expect(drilldown.total).toBe(3)
    expect(drilldown.reconciled).toBe(true)
    expect(drilldown.rows.map((r: any) => r.orderNo)).toEqual(['SO2', 'SO3', 'SO1'])
    expect(drilldown.rows[0]).toMatchObject({ buyerName: 'Dist A', buyerCode: 'DA01', status: 'closed', value: 300, orderDate: '2026-09-30' })
    expect(drilldown.period.label).toBe('September 2026')
  })

  it('reads only the report window by business date and only confirmed statuses', async () => {
    await drill('?metric=confirmed_orders&month=2026-09')
    const read = calls.filter((c) => c.table === 'orders' && c.filters.some((f) => f.startsWith('status in')))
    expect(read).toHaveLength(1)
    expect(read[0].filters).toEqual(expect.arrayContaining([
      'status in approved,warehouse_packed,shipped_distributor,closed',
      'order_date>=2026-09-01',
      'order_date<2026-10-01',
    ]))
  })

  it('returns unique active buyers that reconcile with the Active Buyers card', async () => {
    const { drilldown } = await (await drill('?metric=active_buyers&month=2026-09')).json()
    const { report } = await (await stats('?month=2026-09')).json()
    expect(drilldown.total).toBe(report.summary.activeBuyers)
    expect(drilldown.rows.map((r: any) => r.buyerName)).toEqual(['Dist A', 'Kedai Satu'])
    expect(drilldown.rows[0]).toMatchObject({ orders: 2, value: 400, buyerCode: 'DA01' })
  })

  it('follows the Reporting Month: August and October each return their own records', async () => {
    const aug = (await (await drill('?metric=confirmed_orders&month=2026-08')).json()).drilldown
    expect(aug.rows.map((r: any) => r.orderNo)).toEqual(['SO4'])
    const oct = (await (await drill('?metric=active_buyers&month=2026-10')).json()).drilldown
    expect(oct.rows.map((r: any) => r.buyerName)).toEqual(['Dist B'])
  })

  it('narrows confirmed orders to one buyer', async () => {
    const { drilldown } = await (await drill(`?metric=confirmed_orders&month=2026-09&buyer=${DIST_A.id}`)).json()
    expect(drilldown.rows.map((r: any) => r.orderNo)).toEqual(['SO2', 'SO1'])
    expect(drilldown.buyer).toEqual({ id: DIST_A.id, name: 'Dist A' })
  })

  it('returns an empty list for a month with no confirmed orders', async () => {
    const { drilldown } = await (await drill('?metric=active_buyers&month=2026-06')).json()
    expect(drilldown).toMatchObject({ total: 0, rows: [], reconciled: true })
  })

  it('excludes records the caller cannot read: only what row-level security returns is listed', async () => {
    // RLS hides Dist A's orders from this caller: they are not in the card, nor in the drill-down.
    visibleOrders = ORDERS.filter((o) => o.buyer.id !== DIST_A.id)
    const orders = (await (await drill('?metric=confirmed_orders&month=2026-09')).json()).drilldown
    const buyers = (await (await drill('?metric=active_buyers&month=2026-09')).json()).drilldown
    const { report } = await (await stats('?month=2026-09')).json()
    expect(orders.rows.map((r: any) => r.buyerName)).toEqual(['Kedai Satu'])
    expect(buyers.rows.map((r: any) => r.buyerName)).toEqual(['Kedai Satu'])
    expect(orders.total).toBe(report.summary.approvedSalesOrders)
    expect(buyers.total).toBe(report.summary.activeBuyers)
  })

  it('requires a session and the reporting.analytics.view operation', async () => {
    authedUser = null
    expect((await drill('?metric=confirmed_orders&month=2026-09')).status).toBe(401)
    authedUser = { id: 'u1' }
    guard.denied = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
    const denied = await drill('?metric=confirmed_orders&month=2026-09')
    expect(denied.status).toBe(403)
    expect(calls.some((c) => c.table === 'orders')).toBe(false)
    const { guardUserOperation } = await import('@/lib/security-access/operation')
    expect(guardUserOperation).toHaveBeenCalledWith('u1', 'reporting.analytics.view')
  })

  it('reads with the request-scoped user client, never a service-role client', () => {
    const source = readFileSync(path.join(__dirname, 'route.ts'), 'utf8')
      + readFileSync(path.join(__dirname, '../../../../../lib/reporting/executive-overview-source.ts'), 'utf8')
    // Code, not comments: no admin client import, no admin client call, no service key read.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/@\/lib\/supabase\/admin|createAdminClient\s*\(|SUPABASE_SERVICE_(ROLE_)?KEY/)
    expect(code).toContain("from '@/lib/supabase/server'")
  })

  it('rejects unknown metrics, malformed or future months and a malformed buyer', async () => {
    expect((await drill('?metric=approved_sales_value&month=2026-09')).status).toBe(400)
    expect((await drill('?metric=confirmed_orders&month=2026-13')).status).toBe(400)
    expect((await drill('?metric=confirmed_orders&month=2026-11')).status).toBe(400)
    expect((await drill('?metric=confirmed_orders&month=2026-09&buyer=abc')).status).toBe(400)
  })
})
