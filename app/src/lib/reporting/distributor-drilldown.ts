/**
 * Distributor dashboard drill-downs — who and what makes up a headline number.
 *
 * Reconciliation is by construction, not by a second calculation:
 *
 *   - Active / New / Inactive This Period / Returning rows are
 *     `buildDistributorRows(aggregate)` filtered by DISTRIBUTOR_METRIC_PREDICATES,
 *     the exact rows and predicates `buildDistributorAnalyticsReport` counts.
 *   - Active Orders rows (metric key `total_orders`, kept for existing links)
 *     are the report window's ACTIVE eligible orders read with the shared
 *     eligible-order scope; their count and value are checked against the
 *     report's Active Orders / Active Order Value and any mismatch is
 *     surfaced, never hidden. Draft and cancelled orders are not listed.
 *
 * Order history is used only to label rows (first / last order numbers and
 * dates); it never decides membership or a count.
 */
import {
  DISTRIBUTOR_METRIC_PREDICATES,
  buildDistributorAnalyticsReport,
  buildDistributorRows,
  type DistributorAnalyticsAggregate,
  type DistributorMetricKey,
  type DistributorRow,
} from './distributor-analytics'
import type { EligibleWindowOrder, OrderRecord } from './distributor-analytics-source'
import { businessDateStartUtc, malaysiaDateOf, orderBusinessDate } from '@/lib/orders/order-date'
import { reportDateWindows } from './distributor-analytics'

export const DRILLDOWN_METRICS = ['total_orders', 'active', 'new', 'inactive', 'returning'] as const
export type DrilldownMetric = (typeof DRILLDOWN_METRICS)[number]

export function isDrilldownMetric(value: unknown): value is DrilldownMetric {
  return typeof value === 'string' && (DRILLDOWN_METRICS as readonly string[]).includes(value)
}

export const DRILLDOWN_META: Record<DrilldownMetric, { title: string; noun: string; definition: string; empty: string }> = {
  total_orders: {
    title: 'Active Orders',
    noun: 'orders',
    definition: 'Submitted and approved-stage D2H orders placed by distributors inside the report period, for the selected distributor and status. Draft and cancelled orders are excluded.',
    empty: 'No active orders for this reporting period.',
  },
  active: {
    title: 'Active Distributors',
    noun: 'distributors',
    definition: 'Distributors with at least one active (submitted or approved-stage) order in the report period.',
    empty: 'No active distributors for this reporting period.',
  },
  new: {
    title: 'New Distributors',
    noun: 'distributors',
    definition: 'First ever eligible distributor order falls inside this report period.',
    empty: 'No new distributors for this reporting period.',
  },
  inactive: {
    title: 'Inactive Distributors',
    noun: 'distributors',
    definition: 'Ordered in the comparison period, no eligible order in this one.',
    empty: 'No inactive distributors for this reporting period.',
  },
  returning: {
    title: 'Returning Distributors',
    noun: 'distributors',
    definition: 'Active this period with eligible trading before it — their first ever eligible order is earlier than the report period.',
    empty: 'No returning distributors for this reporting period.',
  },
}

export interface OrderRef {
  orderId: string
  orderNo: string
  /** Business SO date (YYYY-MM-DD). */
  date: string
  /** The instant that business date starts in MYT (kept for existing consumers). */
  at: string
}

export interface DrilldownDistributorRow {
  distributorId: string
  name: string
  code: string | null
  currentOrders: number
  currentValue: number
  aov: number | null
  previousOrders: number
  previousValue: number
  daysSinceLastOrder: number | null
  lastOrder: OrderRef | null
  firstOrder: OrderRef | null
  /** First eligible order inside the report period. */
  currentFirstOrder: OrderRef | null
  /** Latest eligible order before the report period started. */
  lastOrderBeforePeriod: OrderRef | null
}

export interface DrilldownOrderRow extends Omit<EligibleWindowOrder, 'createdById'> {
  createdByName: string | null
}

export interface DistributorDrilldown {
  metric: DrilldownMetric
  title: string
  definition: string
  emptyMessage: string
  period: { month: string; label: string; rangeLabel: string; comparisonRangeLabel: string; isCurrentMonth: boolean }
  scope: { distributorId: string; distributorName: string; status: string; statusLabel: string }
  /** The dashboard's own numbers for this scope. */
  headline: { count: number; activeOrders: number; activeOrderValue: number; ordersCreated: number; activeDistributors: number }
  /** Whether the rows reproduce the headline count (and, for orders, the value). */
  reconciled: boolean
  distributors: DrilldownDistributorRow[]
  orders: DrilldownOrderRow[]
}

const round2 = (value: number) => Math.round(value * 100) / 100
const orderNo = (order: OrderRecord) => order.display_doc_no || order.order_no || order.id

function headlineCount(metric: DrilldownMetric, report: ReturnType<typeof buildDistributorAnalyticsReport>): number {
  switch (metric) {
    case 'total_orders': return report.summary.activeOrders
    case 'active': return report.summary.activeDistributors
    case 'new': return report.relationship.newDistributors
    case 'inactive': return report.relationship.inactiveThisPeriod
    case 'returning': return report.relationship.returningDistributors
  }
}

const SORT: Record<DistributorMetricKey, (a: DistributorRow, b: DistributorRow) => number> = {
  active: (a, b) => b.currentValue - a.currentValue || b.currentOrders - a.currentOrders,
  new: (a, b) => b.currentValue - a.currentValue,
  returning: (a, b) => b.currentValue - a.currentValue,
  inactive: (a, b) => b.previousValue - a.previousValue || b.previousOrders - a.previousOrders,
}

export function buildDistributorDrilldown(input: {
  aggregate: DistributorAnalyticsAggregate
  metric: DrilldownMetric
  /** Report-window ACTIVE eligible orders (Active Orders only). */
  orders?: EligibleWindowOrder[]
  /** All-history eligible orders of the listed distributors (labels only). */
  history?: OrderRecord[]
  userNames?: Map<string, string>
  now?: Date
}): DistributorDrilldown {
  const { aggregate, metric } = input
  const report = buildDistributorAnalyticsReport(aggregate, input.now)
  const { period } = report
  const meta = DRILLDOWN_META[metric]
  const count = headlineCount(metric, report)

  let distributors: DrilldownDistributorRow[] = []
  let orders: DrilldownOrderRow[] = []
  let reconciled: boolean

  if (metric === 'total_orders') {
    orders = [...(input.orders || [])]
      // Business date first, entry time as the tie-break — the report's own order.
      .sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || '')
        || Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(({ createdById, ...order }) => ({
        ...order,
        orderValue: round2(order.orderValue),
        createdByName: createdById ? input.userNames?.get(createdById) ?? null : null,
      }))
    const value = round2(orders.reduce((sum, order) => sum + order.orderValue, 0))
    reconciled = orders.length === count && Math.abs(value - report.summary.activeOrderValue) < 0.01
  } else {
    const codeById = new Map(aggregate.distributors.map((row) => [row.distributorId, row.orgCode]))
    // History is labelled by BUSINESS date — the same date that decided each
    // distributor's membership in the headline.
    type Dated = OrderRecord & { businessDate: string }
    const historyBy = new Map<string, Dated[]>()
    for (const order of input.history || []) {
      const businessDate = orderBusinessDate(order)
      if (!order.buyer_org_id || !businessDate) continue
      const list = historyBy.get(order.buyer_org_id) || []
      list.push({ ...order, businessDate })
      historyBy.set(order.buyer_org_id, list)
    }
    const ref = (order: Dated | undefined): OrderRef | null =>
      order ? { orderId: order.id, orderNo: orderNo(order), date: order.businessDate, at: businessDateStartUtc(order.businessDate) } : null
    const windows = reportDateWindows(period)
    const entered = (order: OrderRecord) => (order.created_at ? Date.parse(order.created_at) : 0)

    distributors = buildDistributorRows(aggregate, period)
      .filter(DISTRIBUTOR_METRIC_PREDICATES[metric])
      .sort(SORT[metric])
      .map((row) => {
        const history = [...(historyBy.get(row.distributorId) || [])]
          .sort((a, b) => a.businessDate.localeCompare(b.businessDate) || entered(a) - entered(b))
        const inPeriod = history.filter((o) => o.businessDate >= windows.start && o.businessDate < windows.end)
        const beforePeriod = history.filter((o) => o.businessDate < windows.start)
        // first/last order instants are the MYT starts of business dates, so
        // their Malaysia date IS the business date to match on.
        const lastDate = row.lastOrderAt ? malaysiaDateOf(row.lastOrderAt) : null
        const firstDate = row.firstOrderAt ? malaysiaDateOf(row.firstOrderAt) : null
        const atLastOrder = lastDate ? history.filter((o) => o.businessDate === lastDate) : []
        const atFirstOrder = firstDate ? history.filter((o) => o.businessDate === firstDate) : []
        return {
          distributorId: row.distributorId,
          name: row.name,
          code: codeById.get(row.distributorId) ?? null,
          currentOrders: row.currentOrders,
          currentValue: row.currentValue,
          aov: row.aov,
          previousOrders: row.previousOrders,
          previousValue: row.previousValue,
          daysSinceLastOrder: row.daysSinceLastOrder,
          lastOrder: ref(atLastOrder[atLastOrder.length - 1]),
          firstOrder: ref(atFirstOrder[0]),
          currentFirstOrder: ref(inPeriod[0]),
          lastOrderBeforePeriod: ref(beforePeriod[beforePeriod.length - 1]),
        }
      })
    reconciled = distributors.length === count
  }

  return {
    metric,
    title: meta.title,
    definition: meta.definition,
    emptyMessage: meta.empty,
    period: {
      month: period.month,
      label: period.label,
      rangeLabel: period.rangeLabel,
      comparisonRangeLabel: period.comparisonRangeLabel,
      isCurrentMonth: period.isCurrentMonth,
    },
    scope: {
      distributorId: report.distributor.id,
      distributorName: report.distributor.name,
      status: report.status.id,
      statusLabel: report.status.label,
    },
    headline: {
      count,
      activeOrders: report.summary.activeOrders,
      activeOrderValue: report.summary.activeOrderValue,
      ordersCreated: report.summary.ordersCreated,
      activeDistributors: report.summary.activeDistributors,
    },
    reconciled,
    distributors,
    orders,
  }
}
