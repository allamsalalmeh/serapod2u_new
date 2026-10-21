import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase, type FakeSupabase } from '@/lib/warehouse/test-utils/fake-supabase'
import {
  aggregateDistributorOrders,
  reportOrderValue,
} from '@/lib/reporting/distributor-analytics-source'
import { ALL_DISTRIBUTORS, ALL_STATUS, resolveDistributorReportPeriod } from '@/lib/reporting/distributor-analytics'
import { malaysiaDateOf } from '@/lib/orders/order-date'

// S&A in legacy mode: this suite tests the route's own rules.
vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)
vi.mock('@/lib/security-access/resource-context', async () => (await import('@/test-support/sa-legacy-mode')).resourceContextModule)

/**
 * Distributor dashboard drill-downs through the real routes:
 * GET /api/reporting/distributor-analytics (headline) and
 * GET /api/reporting/distributor-analytics/drilldown (rows), against one
 * in-memory dataset. `reporting_distributor_analytics` is emulated with
 * aggregateDistributorOrders — the repo's TypeScript mirror of the RPC.
 */

let db: FakeSupabase
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u-admin' } }, error: null }) },
    rpc: (name: string, args: any) => db.rpc(name, args),
    from: (table: string) => db.from(table),
  }),
}))

const A = 'aaaaaaaa-0000-4000-8000-000000000001' // returning
const B = 'aaaaaaaa-0000-4000-8000-000000000002' // new in Aug
const C = 'aaaaaaaa-0000-4000-8000-000000000003' // inactive in Aug
const D = 'aaaaaaaa-0000-4000-8000-000000000004' // history in March, Aug order cancelled → not active in Aug
const E = 'aaaaaaaa-0000-4000-8000-000000000005' // inactive in Aug, orders again in Sep
const HQ = 'bbbbbbbb-0000-4000-8000-000000000001'

type Order = { id: string; buyer: string; at: string; orderDate?: string; status: string; type?: string; value: number; lines?: number; no: string }
const ORDERS: Order[] = [
  { id: 'o-a-jul', buyer: A, at: '2026-07-05T02:00:00.000Z', status: 'approved', value: 1000, no: 'SO26000101' },
  { id: 'o-a-aug1', buyer: A, at: '2026-08-03T02:00:00.000Z', status: 'approved', value: 2500, lines: 2, no: 'SO26000110' },
  { id: 'o-a-aug2', buyer: A, at: '2026-08-20T02:00:00.000Z', status: 'closed', value: 4000, no: 'SO26000120' },
  { id: 'o-b-aug', buyer: B, at: '2026-08-10T02:00:00.000Z', status: 'submitted', value: 1500, no: 'SO26000115' },
  { id: 'o-c-jul', buyer: C, at: '2026-07-12T02:00:00.000Z', status: 'approved', value: 3000, no: 'SO26000102' },
  { id: 'o-d-mar', buyer: D, at: '2026-03-01T02:00:00.000Z', status: 'closed', value: 800, no: 'SO26000020' },
  { id: 'o-d-aug', buyer: D, at: '2026-08-25T02:00:00.000Z', status: 'cancelled', value: 600, no: 'SO26000125' },
  { id: 'o-e-jul', buyer: E, at: '2026-07-30T02:00:00.000Z', status: 'approved', value: 2200, no: 'SO26000105' },
  { id: 'o-e-sep', buyer: E, at: '2026-09-02T02:00:00.000Z', status: 'approved', value: 900, no: 'SO26000130' },
  // Never eligible: non-DIST buyer, and an H2M order.
  { id: 'o-hq-aug', buyer: HQ, at: '2026-08-05T02:00:00.000Z', status: 'approved', value: 9999, no: 'SO26000999' },
  { id: 'o-a-h2m', buyer: A, at: '2026-08-06T02:00:00.000Z', status: 'approved', type: 'H2M', value: 7777, no: 'ORD26000777' },
]

function seed(extra: Order[] = []) {
  const all = [...ORDERS, ...extra]
  const orgs = [
    { id: A, org_name: 'Alpha Distribution', org_code: 'ALPHA', org_type_code: 'DIST', is_active: true },
    { id: B, org_name: 'Beta Vape', org_code: 'BETA', org_type_code: 'DIST', is_active: true },
    { id: C, org_name: 'Cahaya Trading', org_code: 'CHY', org_type_code: 'DIST', is_active: true },
    { id: D, org_name: 'Delta Supply', org_code: 'DLT', org_type_code: 'DIST', is_active: true },
    { id: E, org_name: 'Ekor Enterprise', org_code: 'EKR', org_type_code: 'DIST', is_active: true },
    { id: HQ, org_name: 'Serapod HQ', org_code: 'HQ', org_type_code: 'HQ', is_active: true },
  ]
  const itemsFor = (o: Order) => Array.from({ length: o.lines ?? 1 }, (_, i) => ({
    order_id: o.id, variant_id: `v${i}`, product_id: 'p', qty: 1, unit_price: o.value / (o.lines ?? 1), line_total: o.value / (o.lines ?? 1),
  }))
  const orders = all.map((o) => ({
    id: o.id, order_no: `ORD-DH-${o.id}`, display_doc_no: o.no, buyer_org_id: o.buyer,
    // Business date as the migration backfills it (MYT date of created_at) unless overridden.
    order_date: o.orderDate ?? malaysiaDateOf(o.at), created_at: o.at, updated_at: o.at,
    status: o.status, order_type: o.type ?? 'D2H', created_by: 'u-sales', order_items: itemsFor(o),
  }))
  db = createFakeSupabase(
    {
      organizations: orgs,
      orders,
      order_items: all.flatMap(itemsFor),
      users: [{ id: 'u-sales', full_name: 'Siti Sales', email: 'siti@example.com' }],
    },
    {
      reporting_distributor_analytics: (a: any) => {
        const distributorId = a.p_distributor_id ?? ALL_DISTRIBUTORS
        const status = a.p_status ?? ALL_STATUS
        const dist = orgs.filter((o) => o.org_type_code === 'DIST' && (distributorId === ALL_DISTRIBUTORS || o.id === distributorId))
        const ids = new Set(dist.map((o) => o.id))
        const eligible = orders.filter((o) => o.order_type === 'D2H' && ids.has(o.buyer_org_id) && (status === ALL_STATUS || o.status === status))
        const eligibleIds = new Set(eligible.map((o) => o.id))
        const now = new Date()
        return {
          data: aggregateDistributorOrders(
            eligible, all.flatMap(itemsFor).filter((i) => eligibleIds.has(i.order_id)),
            dist.map((o) => ({ id: o.id, org_name: o.org_name, org_code: o.org_code, is_active: o.is_active })),
            [], a.p_month, now, resolveDistributorReportPeriod(a.p_month, now), distributorId, status,
          ),
          error: null,
        }
      },
    },
  )
}

async function headline(query: Record<string, string>) {
  const { GET } = await import('../route')
  const res = await GET(new Request(`http://localhost/api/reporting/distributor-analytics?${new URLSearchParams(query)}`))
  return (await res.json()).report
}

async function csv(query: Record<string, string>) {
  const { GET } = await import('../csv/route')
  const res = await GET(new Request(`http://localhost/api/reporting/distributor-analytics/csv?${new URLSearchParams(query)}`))
  return res.text()
}

async function drill(metric: string, query: Record<string, string> = {}) {
  const { GET } = await import('./route')
  const res = await GET(new Request(`http://localhost/api/reporting/distributor-analytics/drilldown?${new URLSearchParams({ metric, ...query })}`))
  return { status: res.status, body: await res.json() }
}

const AUG = { month: '2026-08', distributor: 'all', status: 'all' }
const names = (rows: any[]) => rows.map((r) => r.name).sort()

beforeEach(() => seed())

describe('headline counts (unchanged by the drill-down work)', () => {
  it('17. August, all distributors, all status', async () => {
    const report = await headline(AUG)
    // Delta's August order is cancelled: it is created, never active.
    expect(report.summary).toMatchObject({ ordersCreated: 4, activeOrders: 3, activeOrderValue: 8000, activeDistributors: 2, returningDistributors: 1 })
    expect(report.relationship).toMatchObject({ newDistributors: 1, returningDistributors: 1, inactiveThisPeriod: 2 })
    expect(report.orderProcessing).toMatchObject({ total: 4, cancelledOrders: 1, cancelledValue: 600, approvedSalesValue: 6500, pipelineValue: 1500 })
    // Cancelled orders stay visible in Recent Orders, labelled by status.
    expect(report.recentOrders.find((o: any) => o.orderNo === 'SO26000125')).toMatchObject({ status: 'cancelled', orderValue: 600 })
  })
})

describe('drill-downs reconcile exactly with the headline', () => {
  it('7. Active Orders lists exactly the 3 active orders (no cancelled, no HQ buyer, no H2M) with values that sum to the headline', async () => {
    const { body } = await drill('total_orders', AUG)
    const d = body.drilldown
    expect(d.title).toBe('Active Orders')
    expect(d.headline).toMatchObject({ count: 3, activeOrders: 3, activeOrderValue: 8000, ordersCreated: 4 })
    expect(d.reconciled).toBe(true)
    expect(d.orders.map((o: any) => o.orderNo)).toEqual(['SO26000120', 'SO26000115', 'SO26000110'])
    expect(d.orders.reduce((s: number, o: any) => s + o.orderValue, 0)).toBe(8000)
    expect(d.orders.find((o: any) => o.orderNo === 'SO26000110')).toMatchObject({
      distributorName: 'Alpha Distribution', distributorCode: 'ALPHA', status: 'approved', lineCount: 2, orderValue: 2500, createdByName: 'Siti Sales',
    })
  })

  it('8. Active Distributors lists exactly the 2 distributors counted (a cancelled order does not make Delta active)', async () => {
    const d = (await drill('active', AUG)).body.drilldown
    expect(d.headline.count).toBe(2)
    expect(d.reconciled).toBe(true)
    expect(names(d.distributors)).toEqual(['Alpha Distribution', 'Beta Vape'])
    expect(d.distributors[0]).toMatchObject({
      name: 'Alpha Distribution', code: 'ALPHA', currentOrders: 2, currentValue: 6500, aov: 3250, previousOrders: 1, previousValue: 1000,
      // Labelled by business date; `at` is that date's 00:00 MYT.
      lastOrder: { orderNo: 'SO26000120', date: '2026-08-20', at: '2026-08-19T16:00:00.000Z' },
    })
  })

  it('9. New Distributors uses first-ever-order classification', async () => {
    const d = (await drill('new', AUG)).body.drilldown
    expect(d.headline.count).toBe(1)
    expect(d.distributors).toHaveLength(1)
    expect(d.distributors[0]).toMatchObject({ name: 'Beta Vape', firstOrder: { orderNo: 'SO26000115' }, currentOrders: 1, currentValue: 1500, aov: 1500 })
    // Delta's only August order is cancelled → neither new nor active.
    expect(names(d.distributors)).not.toContain('Delta Supply')
  })

  it('10. Inactive This Period uses the comparison-period logic', async () => {
    const d = (await drill('inactive', AUG)).body.drilldown
    expect(d.headline.count).toBe(2)
    expect(names(d.distributors)).toEqual(['Cahaya Trading', 'Ekor Enterprise'])
    const ekor = d.distributors.find((r: any) => r.name === 'Ekor Enterprise')
    // Report window judged as it closed: the September order is not "this period" for August.
    expect(ekor).toMatchObject({ currentOrders: 0, previousOrders: 1, previousValue: 2200 })
    expect(d.title).toBe('Inactive Distributors')
  })

  it('11. Returning Distributors uses the existing classification, with previous and current-period order refs', async () => {
    const d = (await drill('returning', AUG)).body.drilldown
    expect(d.headline.count).toBe(1)
    expect(names(d.distributors)).toEqual(['Alpha Distribution'])
    const alpha = d.distributors.find((r: any) => r.name === 'Alpha Distribution')
    expect(alpha).toMatchObject({
      lastOrderBeforePeriod: { orderNo: 'SO26000101' },
      currentFirstOrder: { orderNo: 'SO26000110' },
    })
    expect(d.definition).toMatch(/first ever eligible order is earlier than the report period/)
  })
})

describe('filters are respected', () => {
  it('12. Reporting Month', async () => {
    const jul = { ...AUG, month: '2026-07' }
    const report = await headline(jul)
    const orders = (await drill('total_orders', jul)).body.drilldown
    const fresh = (await drill('new', jul)).body.drilldown
    expect(orders.orders.map((o: any) => o.orderNo).sort()).toEqual(['SO26000101', 'SO26000102', 'SO26000105'])
    expect(orders.orders).toHaveLength(report.summary.activeOrders)
    expect(names(fresh.distributors)).toEqual(['Alpha Distribution', 'Cahaya Trading', 'Ekor Enterprise'])
    expect(fresh.distributors).toHaveLength(report.relationship.newDistributors)
    expect(orders.period.label).toMatch(/July 2026/)
  })

  it('13. Distributor', async () => {
    const scope = { ...AUG, distributor: B }
    const report = await headline(scope)
    const orders = (await drill('total_orders', scope)).body.drilldown
    const active = (await drill('active', scope)).body.drilldown
    expect(report.summary.activeOrders).toBe(1)
    expect(orders.orders.map((o: any) => o.orderNo)).toEqual(['SO26000115'])
    expect(names(active.distributors)).toEqual(['Beta Vape'])
    expect(active.scope.distributorName).toBe('Beta Vape')
  })

  it('14. Status', async () => {
    const scope = { ...AUG, status: 'approved' }
    const report = await headline(scope)
    const orders = (await drill('total_orders', scope)).body.drilldown
    const active = (await drill('active', scope)).body.drilldown
    const inactive = (await drill('inactive', scope)).body.drilldown
    expect(report.summary).toMatchObject({ activeOrders: 1, activeDistributors: 1 })
    expect(orders.orders.map((o: any) => o.orderNo)).toEqual(['SO26000110'])
    expect(names(active.distributors)).toEqual(['Alpha Distribution'])
    expect(names(inactive.distributors)).toEqual(['Cahaya Trading', 'Ekor Enterprise'])
    expect(inactive.distributors).toHaveLength(report.relationship.inactiveThisPeriod)
    expect(orders.scope.statusLabel).toBe('Approved')
  })

  it('a specific status is intersected with the active set: Cancelled shows no active orders but keeps the history', async () => {
    const scope = { ...AUG, status: 'cancelled' }
    const report = await headline(scope)
    const orders = (await drill('total_orders', scope)).body.drilldown
    expect(report.summary).toMatchObject({ ordersCreated: 1, activeOrders: 0, activeOrderValue: 0, activeDistributors: 0 })
    expect(report.orderProcessing).toMatchObject({ total: 1, cancelledOrders: 1, cancelledValue: 600, approvedSalesValue: 0 })
    expect(report.recentOrders.map((o: any) => o.orderNo)).toEqual(['SO26000125'])
    expect(report.isEmpty).toBe(false)
    expect(orders.orders).toEqual([])
    expect(orders.reconciled).toBe(true)
  })

  it('15. an empty metric returns zero rows with its empty-state message', async () => {
    const d = (await drill('new', { ...AUG, status: 'approved' })).body.drilldown
    expect(d.headline.count).toBe(0)
    expect(d.distributors).toEqual([])
    expect(d.reconciled).toBe(true)
    expect(d.emptyMessage).toBe('No new distributors for this reporting period.')
  })

  it('validates the metric and scope like the report', async () => {
    expect((await drill('everything', AUG)).status).toBe(400)
    expect((await drill('active', { ...AUG, distributor: 'Beta Vape' })).status).toBe(400)
    expect((await drill('active', { ...AUG, status: 'nope' })).status).toBe(400)
  })

  it('reports a non-reconciling list instead of hiding it', async () => {
    // An extra eligible order the aggregate never saw (e.g. inserted between reads).
    db.tables.orders.push({ ...db.tables.orders[1], id: 'late', display_doc_no: 'SO26000199' })
    const d = (await drill('total_orders', AUG)).body.drilldown
    expect(d.orders).toHaveLength(4)
    expect(d.reconciled).toBe(false)
  })

  it('never writes anything', async () => {
    await drill('total_orders', AUG)
    await drill('returning', AUG)
    expect(db.updates).toHaveLength(0)
    expect(db.inserts).toHaveLength(0)
  })
})

describe('order value follows the active report source', () => {
  it('rpc uses COALESCE(line_total, qty × unit_price); fallback treats 0 line_total as missing', () => {
    const items = [
      { order_id: 'o', variant_id: null, product_id: null, qty: 2, unit_price: 5, line_total: null },
      { order_id: 'o', variant_id: null, product_id: null, qty: 2, unit_price: 5, line_total: 0 },
    ]
    expect(reportOrderValue(items, 'rpc')).toBe(10)
    expect(reportOrderValue(items, 'fallback')).toBe(20)
  })
})

describe('backdated SO: web report, drill-down and CSV agree on the business date', () => {
  // SO dated 31 Aug 2026, keyed in on 21 Sep 2026 (11:00 MYT) for Cahaya.
  const BACKDATED: Order = {
    id: 'o-c-backdated', buyer: C, at: '2026-09-21T03:00:00.000Z', orderDate: '2026-08-31',
    status: 'approved', value: 700, no: 'SO26000140',
  }
  const SEP = { ...AUG, month: '2026-09' }

  it('13/19/20. counts in August — headline, Active Orders drill-down and CSV all include it', async () => {
    seed([BACKDATED])
    const report = await headline(AUG)
    const orders = (await drill('total_orders', AUG)).body.drilldown
    const file = await csv(AUG)

    expect(report.summary.activeOrders).toBe(4)
    expect(report.summary.activeOrderValue).toBe(2500 + 4000 + 1500 + 700)
    expect(orders.reconciled).toBe(true)
    const row = orders.orders.find((o: any) => o.orderNo === 'SO26000140')
    expect(row).toMatchObject({ orderDate: '2026-08-31', createdAt: '2026-09-21T03:00:00.000Z' })
    // Newest business date first.
    expect(orders.orders[0].orderNo).toBe('SO26000140')

    const csvRows = file.split('\n').filter((line) => line.startsWith('"SO'))
    // The CSV is detailed reporting: every status of the scope, active rows marked.
    expect(csvRows).toHaveLength(report.summary.ordersCreated)
    expect(csvRows.filter((line) => line.includes('"Yes"'))).toHaveLength(report.summary.activeOrders)
    expect(file).toContain('"SO26000140","2026-08-31","Cahaya Trading","Approved","Yes","1","700.00"')
    expect(file).toContain('"SO26000125","2026-08-25","Delta Supply","Cancelled","No","1","600.00"')
    expect(file).toContain('Bucketed on orders.order_date (business SO date)')
  })

  it('13. is never counted in September', async () => {
    const before = await headline(SEP)
    const beforeFile = await csv(SEP)
    seed([BACKDATED])
    const after = await headline(SEP)
    const orders = (await drill('total_orders', SEP)).body.drilldown
    expect(after.summary.activeOrders).toBe(before.summary.activeOrders)
    expect(after.summary.activeOrderValue).toBe(before.summary.activeOrderValue)
    expect(orders.orders.map((o: any) => o.orderNo)).not.toContain('SO26000140')
    expect(await csv(SEP)).toBe(beforeFile)
  })

  it('14/15/16/20. moves Cahaya from Inactive to Active in August, with a 31 Aug Last Order', async () => {
    seed([BACKDATED])
    const report = await headline(AUG)
    const active = (await drill('active', AUG)).body.drilldown
    const inactive = (await drill('inactive', AUG)).body.drilldown
    expect(report.dailyTrend.find((d: any) => d.date === '2026-08-31')).toMatchObject({ orders: 1, orderValue: 700 })
    expect(report.leaderboard.map((r: any) => r.name)).toContain('Cahaya Trading')
    expect(names(inactive.distributors)).toEqual(['Ekor Enterprise'])
    const cahaya = active.distributors.find((r: any) => r.name === 'Cahaya Trading')
    expect(cahaya).toMatchObject({
      currentOrders: 1, currentValue: 700,
      lastOrder: { orderNo: 'SO26000140', date: '2026-08-31' },
      currentFirstOrder: { orderNo: 'SO26000140', date: '2026-08-31' },
    })
    expect(active.distributors).toHaveLength(report.summary.activeDistributors)
    expect(report.meta.dateField).toBe('orders.order_date')
  })
})
