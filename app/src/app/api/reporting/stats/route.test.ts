import { beforeEach, describe, expect, it, vi } from 'vitest'
import { summarizeSales } from '@/lib/reporting/sales-kpi'

vi.mock('@/lib/security-access/operation', () => ({ guardUserOperation: vi.fn(async () => null) }))

const ORDERS = [
  { id: 'o1', order_no: 'SO1', order_type: 'D2H', status: 'approved', order_date: '2026-10-02', created_at: '2026-10-02T02:00:00Z', buyer: { id: 'd1', org_name: 'Dist A', org_type_code: 'DIST' }, order_items: [{ variant_id: 'v1', qty: 2, line_total: 100 }] },
  { id: 'o2', order_no: 'SO2', order_type: 'D2H', status: 'warehouse_packed', order_date: '2026-10-03', created_at: '2026-10-03T02:00:00Z', buyer: { id: 'd1', org_name: 'Dist A', org_type_code: 'DIST' }, order_items: [{ variant_id: 'v1', qty: 3, line_total: 300 }] },
  { id: 'o3', order_no: 'SO3', order_type: 'D2H', status: 'shipped_distributor', order_date: '2026-10-04', created_at: '2026-10-04T02:00:00Z', buyer: { id: 'd2', org_name: 'Dist B', org_type_code: 'DIST' }, order_items: [{ variant_id: 'v2', qty: 1, line_total: 50.5 }] },
  { id: 'o4', order_no: 'SO4', order_type: 'D2H', status: 'closed', order_date: '2026-10-05', created_at: '2026-10-05T02:00:00Z', buyer: { id: 'd2', org_name: 'Dist B', org_type_code: 'DIST' }, order_items: [{ variant_id: 'v2', qty: 1, line_total: 49.5 }] },
  { id: 'o5', order_no: 'SO5', order_type: 'D2H', status: 'submitted', order_date: '2026-10-05', created_at: '2026-10-05T03:00:00Z', buyer: { id: 'd2', org_name: 'Dist B', org_type_code: 'DIST' }, order_items: [{ variant_id: 'v2', qty: 9, line_total: 900 }] },
  { id: 'o6', order_no: 'SO6', order_type: 'D2H', status: 'cancelled', order_date: '2026-10-06', created_at: '2026-10-06T03:00:00Z', buyer: { id: 'd2', org_name: 'Dist B', org_type_code: 'DIST' }, order_items: [{ variant_id: 'v2', qty: 7, line_total: 700 }] },
  { id: 'o7', order_no: 'PO7', order_type: 'H2M', status: 'approved', order_date: '2026-10-06', created_at: '2026-10-06T04:00:00Z', buyer: { id: 'hq', org_name: 'HQ', org_type_code: 'HQ' }, order_items: [{ variant_id: 'v3', qty: 100, line_total: 10000 }] },
]

let statusFilter: string[] = []
function chain(result: any, onIn?: (col: string, values: any[]) => void) {
  const q: any = {}
  for (const m of ['select', 'eq', 'gte', 'lte', 'lt', 'order', 'limit']) q[m] = () => q
  q.in = (col: string, values: any[]) => { onIn?.(col, values); return q }
  q.single = async () => result
  q.then = (resolve: any) => Promise.resolve(result).then(resolve)
  return q
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
    from: (table: string) => {
      if (table === 'users') return chain({ data: { organization_id: 'hq', role_code: 'HQ', roles: { role_level: 10 } }, error: null })
      if (table === 'orders') {
        return chain({ data: ORDERS.filter((o) => statusFilter.length === 0 || statusFilter.includes(o.status)), error: null },
          (col, values) => { if (col === 'status') statusFilter = values })
      }
      return chain({ data: [], error: null })
    },
  }),
}))

describe('GET /api/reporting/stats — Approved Sales KPI', () => {
  beforeEach(() => { statusFilter = [] })

  it('reports approved sales only, with pipeline, cancelled and H2M purchases apart', async () => {
    const { GET } = await import('./route')
    const res = await GET(new Request('http://x/api/reporting/stats?startDate=2026-10-01T00:00:00Z&endDate=2026-10-31T00:00:00Z'))
    const body = await res.json()
    expect(statusFilter).not.toContain('draft')
    expect(statusFilter).toEqual(expect.arrayContaining(['approved', 'warehouse_packed', 'shipped_distributor', 'closed', 'submitted', 'cancelled']))
    // Parity with the shared definition used by Distributor Analytics and exports.
    const expected = summarizeSales(ORDERS.map((o) => ({ status: o.status, orderType: o.order_type, value: o.order_items.reduce((s, i) => s + i.line_total, 0) })))
    expect(body.summary.approvedSalesValue).toBe(expected.approvedSalesValue)
    expect(body.summary.approvedSalesValue).toBe(500)
    expect(body.summary.totalRevenue).toBe(500)
    expect(body.summary.totalOrders).toBe(4)
    expect(body.summary.totalUnits).toBe(7)
    expect(body.summary.pipelineValue).toBe(900)
    expect(body.summary.pipelineOrders).toBe(1)
    expect(body.summary.cancelledOrders).toBe(1)
    expect(body.summary.cancelledValue).toBe(700)
    expect(body.summary.purchaseValue).toBe(10000)
    // Trend and buyer performance carry approved sales only.
    expect(body.trend.reduce((s: number, r: any) => s + r.revenue, 0)).toBe(500)
    expect(body.distributorPerformance.reduce((s: number, r: any) => s + r.revenue, 0)).toBe(500)
    expect(body.distributorPerformance.map((r: any) => r.name)).not.toContain('HQ')
  })
})
