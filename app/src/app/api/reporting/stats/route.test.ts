import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { summarizeSales } from '@/lib/reporting/sales-kpi'

vi.mock('@/lib/security-access/operation', () => ({ guardUserOperation: vi.fn(async () => null) }))

const DIST_A = { id: 'd1', org_name: 'Dist A', org_type_code: 'DIST' }
const DIST_B = { id: 'd2', org_name: 'Dist B', org_type_code: 'DIST' }
const SHOP = { id: 's1', org_name: 'Kedai Satu', org_type_code: 'SHOP' }
const HQ = { id: 'hq', org_name: 'HQ', org_type_code: 'HQ' }

let seq = 0
function order(order_type: string, status: string, order_date: string, buyer: any, items: { variant_id: string; qty: number; line_total: number }[]) {
  seq += 1
  return { id: `o${seq}`, order_no: `SO${seq}`, display_doc_no: null, order_type, status, order_date, created_at: `${order_date}T02:00:00Z`, buyer_org_id: buyer.id, buyer, order_items: items }
}

// October 2026 (report month, running to the 20th) and September (comparison + trend).
const ORDERS = [
  order('D2H', 'approved', '2026-10-02', DIST_A, [{ variant_id: 'v1', qty: 2, line_total: 100 }]),
  order('D2H', 'warehouse_packed', '2026-10-03', DIST_A, [{ variant_id: 'v1', qty: 3, line_total: 300 }]),
  order('D2H', 'shipped_distributor', '2026-10-04', DIST_B, [{ variant_id: 'v2', qty: 1, line_total: 50.5 }]),
  order('D2H', 'closed', '2026-10-05', DIST_B, [{ variant_id: 'v2', qty: 1, line_total: 49.5 }]),
  order('S2D', 'approved', '2026-10-06', SHOP, [{ variant_id: 'v1', qty: 4, line_total: 40 }]),
  order('D2H', 'submitted', '2026-10-05', DIST_B, [{ variant_id: 'v2', qty: 9, line_total: 900 }]),
  order('D2H', 'cancelled', '2026-10-06', DIST_B, [{ variant_id: 'v2', qty: 7, line_total: 700 }]),
  order('H2M', 'approved', '2026-10-06', HQ, [{ variant_id: 'v3', qty: 100, line_total: 10000 }]),
  // Comparison window is 01–20 Sep: the 10th counts, the 25th does not (it is in the trend only).
  order('D2H', 'approved', '2026-09-10', DIST_A, [{ variant_id: 'v1', qty: 1, line_total: 200 }]),
  order('D2H', 'closed', '2026-09-25', DIST_A, [{ variant_id: 'v1', qty: 5, line_total: 1000 }]),
  // Backdated: keyed in during October, SO-dated 30 Sep — September sales by business date.
  { ...order('D2H', 'approved', '2026-09-30', DIST_B, [{ variant_id: 'v2', qty: 1, line_total: 77 }]), created_at: '2026-10-08T03:00:00Z' },
]

/** A tiny PostgREST stand-in that honours the filters this route uses, including paging. */
const calls: { table: string; filters: string[]; range?: [number, number] }[] = []
function query(table: string, rows: any[]) {
  let result = [...rows]
  const call = { table, filters: [] as string[], range: undefined as [number, number] | undefined }
  calls.push(call)
  const q: any = {
    select: () => q,
    eq: (col: string, v: any) => { call.filters.push(`${col}=${v}`); result = result.filter((r) => r[col] === v); return q },
    in: (col: string, values: any[]) => { call.filters.push(`${col} in ${values.join(',')}`); result = result.filter((r) => values.includes(r[col])); return q },
    gte: (col: string, v: any) => { call.filters.push(`${col}>=${v}`); result = result.filter((r) => r[col] >= v); return q },
    lt: (col: string, v: any) => { call.filters.push(`${col}<${v}`); result = result.filter((r) => r[col] < v); return q },
    order: (col: string, opts: any) => { result.sort((a, b) => (opts?.ascending === false ? -1 : 1) * String(a[col]).localeCompare(String(b[col]))); return q },
    limit: (n: number) => { result = result.slice(0, n); return q },
    range: (from: number, to: number) => { call.range = [from, to]; result = result.slice(from, to + 1); return q },
    single: async () => ({ data: result[0] ?? null, error: null }),
    then: (resolve: any) => Promise.resolve({ data: result, error: null }).then(resolve),
  }
  return q
}

let orderRows: any[] = ORDERS
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
    from: (table: string) => {
      if (table === 'orders') return query(table, orderRows)
      if (table === 'product_variants') return query(table, [
        { id: 'v1', variant_name: 'Cartridge [ Mango ]', products: { product_name: 'Cellera' } },
        { id: 'v2', variant_name: 'Cartridge [ Grape ]', products: { product_name: 'Cellera' } },
      ])
      return query(table, [])
    },
  }),
}))

async function get(qs: string) {
  const { GET } = await import('./route')
  return GET(new Request(`http://x/api/reporting/stats${qs}`))
}

describe('GET /api/reporting/stats — monthly Executive Overview', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-20T10:00:00+08:00'))
    calls.length = 0
    orderRows = ORDERS
  })
  afterEach(() => vi.useRealTimers())

  it('reports approved D2H + S2D sales only, with pipeline, cancelled and H2M purchases apart', async () => {
    const res = await get('?month=2026-10')
    expect(res.status).toBe(200)
    const { report } = await res.json()
    const s = report.summary

    const october = ORDERS.filter((o) => o.order_date >= '2026-10-01' && o.order_date < '2026-10-21')
    const expected = summarizeSales(october.map((o) => ({ status: o.status, orderType: o.order_type, value: o.order_items.reduce((sum, i) => sum + i.line_total, 0) })))
    expect(s.approvedSalesValue).toBe(expected.approvedSalesValue)
    expect(s.approvedSalesValue).toBe(540)
    expect(s.approvedSalesOrders).toBe(5)
    expect(s.distributorSalesValue).toBe(500)
    expect(s.distributorSalesOrders).toBe(4)
    expect(s.shopSalesValue).toBe(40)
    expect(s.shopSalesOrders).toBe(1)
    expect(s.unitsSold).toBe(11)
    expect(s.activeBuyers).toBe(3)
    expect(s.pipelineValue).toBe(900)
    expect(s.cancelledOrders).toBe(1)
    expect(s.cancelledValue).toBe(700)
    expect(s.purchaseValue).toBe(10000)
    expect(s.purchaseOrders).toBe(1)
  })

  it('keeps H2M, pipeline and cancelled orders out of every sales-derived section', async () => {
    const { report } = await (await get('?month=2026-10')).json()
    const total = report.summary.approvedSalesValue
    expect(report.dailyTrend.reduce((sum: number, r: any) => sum + r.value, 0)).toBeCloseTo(total, 2)
    expect(report.topBuyers.reduce((sum: number, r: any) => sum + r.value, 0)).toBeCloseTo(total, 2)
    expect(report.topBuyers.map((r: any) => r.name)).not.toContain('HQ')
    expect(report.productMix.map((r: any) => r.variantId)).not.toContain('v3')
    expect(report.recentOrders.every((r: any) => ['D2H', 'S2D'].includes(r.orderType))).toBe(true)
    expect(report.monthlyTrend.at(-1)).toMatchObject({ month: '2026-10', value: total, isPartial: true })
  })

  it('compares month to date with the same elapsed days of the previous month', async () => {
    const { report } = await (await get('?month=2026-10')).json()
    expect(report.period).toMatchObject({ isCurrentMonth: true, startDate: '2026-10-01', endDate: '2026-10-20', comparisonStartDate: '2026-09-01', comparisonEndDate: '2026-09-20' })
    expect(report.dailyTrend).toHaveLength(20)
    expect(report.comparison.approvedSalesValue).toEqual({ current: 540, previous: 200, changePct: 170 })
  })

  it('reports a historical month as the complete month, bucketed by the business date', async () => {
    const { report } = await (await get('?month=2026-09')).json()
    expect(report.period).toMatchObject({ isCurrentMonth: false, startDate: '2026-09-01', endDate: '2026-09-30', comparisonStartDate: '2026-08-01', comparisonEndDate: '2026-08-31' })
    // 10 Sep + 25 Sep + the backdated 30 Sep order keyed in on 8 Oct.
    expect(report.summary.approvedSalesValue).toBe(1277)
    expect(report.dailyTrend).toHaveLength(30)
  })

  it('returns an explicit empty report for a month with no orders, not an error or another month', async () => {
    const res = await get('?month=2026-06')
    expect(res.status).toBe(200)
    const { report } = await res.json()
    expect(report.period.month).toBe('2026-06')
    expect(report.isEmpty).toBe(true)
    expect(report.summary.approvedSalesValue).toBe(0)
    expect(report.dailyTrend).toHaveLength(30)
  })

  it('offers the earliest month with sales as the start of the supported range', async () => {
    const { earliestMonth } = await (await get('?month=2026-10')).json()
    expect(earliestMonth).toBe('2026-09')
  })

  it('rejects malformed and future months instead of silently reporting the current month', async () => {
    expect((await get('?month=2026-13')).status).toBe(400)
    expect((await get('?month=October')).status).toBe(400)
    expect((await get('?month=2026-11')).status).toBe(400)
  })

  it('reads every page — a month larger than one page is never truncated', async () => {
    orderRows = Array.from({ length: 1201 }, (_, i) =>
      order('D2H', 'approved', `2026-08-${String((i % 28) + 1).padStart(2, '0')}`, DIST_A, [{ variant_id: 'v1', qty: 1, line_total: 1 }]))
    const { report } = await (await get('?month=2026-08')).json()
    expect(report.summary.approvedSalesOrders).toBe(1201)
    expect(report.summary.approvedSalesValue).toBe(1201)
    const pages = calls.filter((c) => c.table === 'orders' && c.range)
    expect(pages.map((c) => c.range)).toEqual([[0, 499], [500, 999], [1000, 1499]])
  })

  it('never reads drafts', async () => {
    await get('?month=2026-10')
    const read = calls.find((c) => c.table === 'orders' && c.range)!
    const statuses = read.filters.find((f) => f.startsWith('status in'))!
    expect(statuses).not.toContain('draft')
    expect(statuses).toContain('approved')
  })
})
