/**
 * Executive Overview metric drill-downs — the records behind two Overview cards:
 *
 *   - Confirmed Sales Orders (`summary.approvedSalesOrders`): every D2H / S2D
 *     order in an approved-sales status (approved, warehouse_packed,
 *     shipped_distributor, closed — sales-kpi.ts) whose business date
 *     (`orders.order_date`, Malaysia) falls in the report window.
 *   - Active Buyers (`summary.activeBuyers`): the DISTINCT buyer organisation
 *     ids on exactly those orders. An order without a buyer id is not a buyer.
 *
 * Both lists are built from the same predicates and window as the card
 * (`isApprovedSale`, `ordersInReportWindow`, `activeBuyerCounts` in
 * executive-overview.ts) and carry the card's own figure as `headline`, so
 * `reconciled` is a real check, not an assumption.
 *
 * Isomorphic and pure.
 */
import {
  activeBuyerCounts,
  isApprovedSale,
  orderUnits,
  orderValue,
  ordersInReportWindow,
  resolveExecutiveOverviewPeriod,
  type ExecutiveOverviewPeriod,
  type OverviewOrderInput,
} from './executive-overview'
import { APPROVED_SALES_STATUSES, summarizeSales } from './sales-kpi'

export const OVERVIEW_DRILLDOWN_METRICS = ['confirmed_orders', 'active_buyers'] as const
export type OverviewDrilldownMetric = (typeof OVERVIEW_DRILLDOWN_METRICS)[number]

export const OVERVIEW_DRILLDOWN_DEFAULT_PAGE_SIZE = 25
export const OVERVIEW_DRILLDOWN_MAX_PAGE_SIZE = 100

export function isOverviewDrilldownMetric(value: unknown): value is OverviewDrilldownMetric {
  return typeof value === 'string' && (OVERVIEW_DRILLDOWN_METRICS as readonly string[]).includes(value)
}

export const OVERVIEW_DRILLDOWN_TITLE: Record<OverviewDrilldownMetric, string> = {
  confirmed_orders: 'Confirmed Sales Orders',
  active_buyers: 'Active Buyers',
}

export interface ConfirmedOrderRow {
  orderId: string
  orderNo: string
  orderDate: string
  orderType: string
  status: string
  buyerId: string | null
  buyerName: string
  buyerCode: string | null
  units: number
  value: number
}

export interface ActiveBuyerRow {
  buyerId: string
  buyerName: string
  buyerCode: string | null
  buyerType: string | null
  /** D2H / S2D — the order types this buyer placed confirmed orders under. */
  orderTypes: string[]
  orders: number
  units: number
  value: number
  lastOrderDate: string
}

export interface OverviewDrilldown<Row> {
  metric: OverviewDrilldownMetric
  period: Pick<ExecutiveOverviewPeriod, 'month' | 'label' | 'rangeLabel' | 'isCurrentMonth' | 'startDate' | 'endDate'>
  /** The card's own figure for this scope. */
  headline: number
  /** Rows across every page (before paging). */
  total: number
  /** Whether `total` reproduces `headline`. Always true unless something upstream drifted. */
  reconciled: boolean
  /** Sum of `value` across every row (not just this page), RM. */
  totalValue: number
  /** Confirmed orders with no buyer organisation: counted as orders, never as a buyer. */
  ordersWithoutBuyer: number
  definition: string
  page: number
  pageSize: number
  pageCount: number
  rows: Row[]
  /** Present when the list is narrowed to one buyer (`buyer=<id>`). */
  buyer: { id: string; name: string } | null
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

const DEFINITION: Record<OverviewDrilldownMetric, string> = {
  confirmed_orders:
    `D2H and S2D sales orders in status ${APPROVED_SALES_STATUSES.join(', ')} with an SO date in the reporting window (Malaysia time). ` +
    'Submitted, draft and cancelled orders and H2M purchases are excluded. Value is the sum of order lines.',
  active_buyers:
    'Distinct buyer organisations with at least one Confirmed Sales Order in the reporting window. ' +
    'A buyer with several orders is listed once; orders and sales are its confirmed orders only.',
}

function clampPage(page: number | undefined, pageSize: number | undefined, total: number) {
  const size = Math.min(OVERVIEW_DRILLDOWN_MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(pageSize) || OVERVIEW_DRILLDOWN_DEFAULT_PAGE_SIZE)))
  const pageCount = Math.max(1, Math.ceil(total / size))
  const index = Math.min(pageCount - 1, Math.max(0, Math.floor(Number(page) || 0)))
  return { size, pageCount, index }
}

export function buildOverviewDrilldown(input: {
  metric: 'confirmed_orders'
  month: string
  orders: readonly OverviewOrderInput[]
  buyerId?: string | null
  page?: number
  pageSize?: number
  now?: Date
}): OverviewDrilldown<ConfirmedOrderRow>
export function buildOverviewDrilldown(input: {
  metric: 'active_buyers'
  month: string
  orders: readonly OverviewOrderInput[]
  buyerId?: string | null
  page?: number
  pageSize?: number
  now?: Date
}): OverviewDrilldown<ActiveBuyerRow>
export function buildOverviewDrilldown(input: {
  metric: OverviewDrilldownMetric
  month: string
  orders: readonly OverviewOrderInput[]
  buyerId?: string | null
  page?: number
  pageSize?: number
  now?: Date
}): OverviewDrilldown<ConfirmedOrderRow | ActiveBuyerRow>
export function buildOverviewDrilldown(input: {
  metric: OverviewDrilldownMetric
  month: string
  orders: readonly OverviewOrderInput[]
  buyerId?: string | null
  page?: number
  pageSize?: number
  now?: Date
}): OverviewDrilldown<ConfirmedOrderRow | ActiveBuyerRow> {
  const period = resolveExecutiveOverviewPeriod(input.month, input.now)
  const current = ordersInReportWindow(period, input.orders)
  const confirmedAll = current.filter(isApprovedSale)
  const buyerFilter = input.buyerId ? String(input.buyerId) : null
  const confirmed = buyerFilter ? confirmedAll.filter((order) => order.buyerId === buyerFilter) : confirmedAll

  // The card figures, computed exactly as buildExecutiveOverviewReport does.
  const summary = summarizeSales(current.map((order) => ({ status: order.status, orderType: order.orderType, value: orderValue(order) })))
  const buyerCounts = activeBuyerCounts(confirmed)

  const periodOut = {
    month: period.month,
    label: period.label,
    rangeLabel: period.rangeLabel,
    isCurrentMonth: period.isCurrentMonth,
    startDate: period.startDate,
    endDate: period.endDate,
  }
  const ordersWithoutBuyer = confirmed.filter((order) => !order.buyerId).length
  const buyer = buyerFilter
    ? { id: buyerFilter, name: confirmed.find((order) => order.buyerName)?.buyerName || 'Unknown buyer' }
    : null

  if (input.metric === 'confirmed_orders') {
    const all: ConfirmedOrderRow[] = [...confirmed]
      .sort((a, b) => b.orderDate.localeCompare(a.orderDate)
        || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
        || a.orderNo.localeCompare(b.orderNo))
      .map((order) => ({
        orderId: order.id,
        orderNo: order.orderNo,
        orderDate: order.orderDate,
        orderType: String(order.orderType).toUpperCase(),
        status: order.status,
        buyerId: order.buyerId,
        buyerName: order.buyerName || 'Unknown buyer',
        buyerCode: order.buyerCode ?? null,
        units: orderUnits(order),
        value: round2(orderValue(order)),
      }))
    const headline = buyerFilter ? confirmed.length : summary.approvedSalesOrders
    const { size, pageCount, index } = clampPage(input.page, input.pageSize, all.length)
    return {
      metric: 'confirmed_orders',
      period: periodOut,
      headline,
      total: all.length,
      reconciled: all.length === headline,
      totalValue: round2(all.reduce((sum, row) => sum + row.value, 0)),
      ordersWithoutBuyer,
      definition: DEFINITION.confirmed_orders,
      page: index,
      pageSize: size,
      pageCount,
      rows: all.slice(index * size, (index + 1) * size),
      buyer,
    }
  }

  // Active buyers — keyed by organisation id, never by name.
  const byBuyer = new Map<string, ActiveBuyerRow>()
  for (const order of confirmed) {
    if (!order.buyerId) continue
    const row = byBuyer.get(order.buyerId) ?? {
      buyerId: order.buyerId,
      buyerName: order.buyerName || 'Unknown buyer',
      buyerCode: order.buyerCode ?? null,
      buyerType: order.buyerType,
      orderTypes: [],
      orders: 0,
      units: 0,
      value: 0,
      lastOrderDate: order.orderDate,
    }
    const type = String(order.orderType).toUpperCase()
    if (!row.orderTypes.includes(type)) row.orderTypes.push(type)
    row.orders += 1
    row.units += orderUnits(order)
    row.value += orderValue(order)
    if (order.orderDate > row.lastOrderDate) row.lastOrderDate = order.orderDate
    byBuyer.set(order.buyerId, row)
  }
  const all = [...byBuyer.values()]
    .map((row) => ({ ...row, value: round2(row.value), orderTypes: row.orderTypes.sort() }))
    .sort((a, b) => b.value - a.value || b.orders - a.orders || a.buyerName.localeCompare(b.buyerName) || a.buyerId.localeCompare(b.buyerId))
  const headline = buyerCounts.all
  const { size, pageCount, index } = clampPage(input.page, input.pageSize, all.length)
  return {
    metric: 'active_buyers',
    period: periodOut,
    headline,
    total: all.length,
    reconciled: all.length === headline,
    totalValue: round2(all.reduce((sum, row) => sum + row.value, 0)),
    ordersWithoutBuyer,
    definition: DEFINITION.active_buyers,
    page: index,
    pageSize: size,
    pageCount,
    rows: all.slice(index * size, (index + 1) * size),
    buyer,
  }
}
