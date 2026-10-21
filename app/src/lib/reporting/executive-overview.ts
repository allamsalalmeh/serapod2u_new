/**
 * Executive Overview — the monthly report behind the dashboard's Overview tab
 * and its PDF export.
 *
 * One DTO, built here from raw order rows, feeds the web report and the PDF,
 * so the two can never disagree. Rules:
 *
 *   - Reporting month: the shared monthly period model (`resolveProductReportPeriod`):
 *     the current month is month to date and is compared with the SAME elapsed
 *     days of the previous month; a historical month is the complete calendar
 *     month compared with the complete previous calendar month. Asia/Kuala_Lumpur.
 *   - Business date: `orders.order_date` (the SO date, which may be backdated),
 *     never the UTC day of `created_at`.
 *   - Classification: `summarizeSales` (sales-kpi.ts) only. Approved Sales =
 *     D2H + S2D in approved, warehouse_packed, shipped_distributor or closed.
 *     Submitted is pipeline, cancelled is reported apart, H2M is a purchase and
 *     never a sale, and an order with no recognised type is never a sale.
 *   - Value: sum of order lines (`order_items.line_total`), never a header total.
 *   - Units, buyers, product mix, buyer ranking, trends and the recent-order
 *     list all use the SAME approved-sales population as the headline value.
 *
 * Isomorphic and pure.
 */

import { addDaysToDateKey } from '@/lib/orders/order-date'
import { monthKeyRange, monthShortLabel, shiftMonthKey } from './consumer-analytics'
import { formatReportDate, resolveProductReportPeriod, type ProductReportPeriod } from './product-analytics'
import {
  APPROVED_SALES_STATUSES,
  isApprovedSalesStatus,
  isSalesOrderType,
  summarizeSales,
  type SalesSummary,
} from './sales-kpi'

export type ExecutiveOverviewPeriod = ProductReportPeriod

/** Months shown in the monthly sales trend, ending with the reporting month. */
export const MONTHLY_TREND_MONTHS = 6
export const PRODUCT_MIX_LIMIT = 10
export const TOP_BUYERS_LIMIT = 10
export const RECENT_ORDERS_LIMIT = 10

export const OVERVIEW_DATE_FIELD = 'orders.order_date'
export const OVERVIEW_VALUE_FIELD = 'sum(order_items.line_total)'

export function resolveExecutiveOverviewPeriod(month: string, now: Date = new Date()): ExecutiveOverviewPeriod {
  return resolveProductReportPeriod(month, now)
}

/** One order as the overview reads it. `orderDate` is the Malaysia business date. */
export interface OverviewOrderInput {
  id: string
  orderNo: string
  orderType: string | null
  status: string
  orderDate: string
  createdAt: string | null
  buyerId: string | null
  buyerName: string | null
  buyerType: string | null
  items: { variantId: string | null; qty: number; lineTotal: number }[]
}

export interface MetricComparison {
  current: number
  previous: number
  /** `null` when the comparison window had nothing to compare against. */
  changePct: number | null
}

export interface ExecutiveOverviewReport {
  period: ExecutiveOverviewPeriod
  meta: {
    dateField: string
    valueField: string
    timeZone: string
    approvedStatuses: string[]
    salesOrderTypes: string[]
    /** Shown when the database predates orders.order_date. */
    notice: string | null
  }
  summary: SalesSummary & {
    unitsSold: number
    activeBuyers: number
    activeDistributorBuyers: number
    activeShopBuyers: number
    avgOrderValue: number | null
  }
  comparison: {
    approvedSalesValue: MetricComparison
    approvedSalesOrders: MetricComparison
    unitsSold: MetricComparison
    activeBuyers: MetricComparison
    distributorSalesValue: MetricComparison
    shopSalesValue: MetricComparison
  }
  /** Every day of the report window, zero-filled. */
  dailyTrend: { date: string; label: string; value: number; orders: number; units: number }[]
  /** Approved sales per month, oldest first, ending with the reporting month (to date when current). */
  monthlyTrend: { month: string; label: string; value: number; orders: number; units: number; isPartial: boolean }[]
  productMix: { variantId: string; name: string; units: number; value: number; unitsSharePct: number | null }[]
  topBuyers: {
    buyerId: string
    name: string
    buyerType: string | null
    orders: number
    units: number
    value: number
    valueSharePct: number | null
  }[]
  recentOrders: {
    id: string
    orderNo: string
    orderDate: string
    createdAt: string | null
    buyerName: string
    orderType: string
    status: string
    units: number
    value: number
  }[]
  isEmpty: boolean
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const round1 = (n: number) => Math.round((n + Number.EPSILON) * 10) / 10

function changePct(current: number, previous: number): number | null {
  if (!(previous > 0)) return null
  return round1(((current - previous) / previous) * 100)
}

function compare(current: number, previous: number): MetricComparison {
  return { current, previous, changePct: changePct(current, previous) }
}

function share(part: number, total: number): number | null {
  return total > 0 ? round1((part / total) * 100) : null
}

const orderValue = (order: OverviewOrderInput) => order.items.reduce((sum, item) => sum + (Number(item.lineTotal) || 0), 0)
const orderUnits = (order: OverviewOrderInput) => order.items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0)

/** Half-open business-date windows [start, end) of the report and its comparison. */
export function overviewDateWindows(period: ExecutiveOverviewPeriod) {
  return {
    start: period.startDate,
    end: addDaysToDateKey(period.startDate, period.dayCount),
    comparisonStart: period.comparisonStartDate,
    comparisonEnd: addDaysToDateKey(period.comparisonStartDate, period.comparisonDayCount),
  }
}

/** The business-date range the source must read: the monthly trend window through the report end. */
export function overviewReadWindow(period: ExecutiveOverviewPeriod): { start: string; end: string } {
  const trendStart = `${monthKeyRange(period.month, MONTHLY_TREND_MONTHS)[0]}-01`
  const { end, comparisonStart } = overviewDateWindows(period)
  return { start: trendStart < comparisonStart ? trendStart : comparisonStart, end }
}

const inWindow = (date: string, start: string, end: string) => date >= start && date < end

function activeBuyerCounts(orders: readonly OverviewOrderInput[]) {
  const all = new Set<string>()
  const distributors = new Set<string>()
  const shops = new Set<string>()
  for (const order of orders) {
    if (!order.buyerId) continue
    all.add(order.buyerId)
    const type = String(order.orderType).toUpperCase()
    if (type === 'D2H') distributors.add(order.buyerId)
    else if (type === 'S2D') shops.add(order.buyerId)
  }
  return { all: all.size, distributors: distributors.size, shops: shops.size }
}

const isApprovedSale = (order: OverviewOrderInput) => isSalesOrderType(order.orderType) && isApprovedSalesStatus(order.status)

export function buildExecutiveOverviewReport(input: {
  month: string
  orders: readonly OverviewOrderInput[]
  /** variant id → display name */
  productNames?: Record<string, string>
  notice?: string | null
  now?: Date
}): ExecutiveOverviewReport {
  const period = resolveExecutiveOverviewPeriod(input.month, input.now)
  const windows = overviewDateWindows(period)
  const names = input.productNames ?? {}

  const current = input.orders.filter((order) => inWindow(order.orderDate, windows.start, windows.end))
  const previous = input.orders.filter((order) => inWindow(order.orderDate, windows.comparisonStart, windows.comparisonEnd))
  const currentSales = current.filter(isApprovedSale)
  const previousSales = previous.filter(isApprovedSale)

  const toSalesInput = (order: OverviewOrderInput) => ({ status: order.status, orderType: order.orderType, value: orderValue(order) })
  const sales = summarizeSales(current.map(toSalesInput))
  const previousSummary = summarizeSales(previous.map(toSalesInput))

  const unitsSold = currentSales.reduce((sum, order) => sum + orderUnits(order), 0)
  const previousUnits = previousSales.reduce((sum, order) => sum + orderUnits(order), 0)
  const buyers = activeBuyerCounts(currentSales)
  const previousBuyers = activeBuyerCounts(previousSales)

  // ── Daily trend ──────────────────────────────────────────────────────────
  const byDay = new Map<string, { value: number; orders: number; units: number }>()
  for (const order of currentSales) {
    const bucket = byDay.get(order.orderDate) ?? { value: 0, orders: 0, units: 0 }
    bucket.value += orderValue(order)
    bucket.orders += 1
    bucket.units += orderUnits(order)
    byDay.set(order.orderDate, bucket)
  }
  const dailyTrend = Array.from({ length: period.dayCount }, (_, index) => {
    const date = addDaysToDateKey(period.startDate, index)
    const bucket = byDay.get(date)
    return {
      date,
      label: formatReportDate(date).slice(0, 6),
      value: round2(bucket?.value ?? 0),
      orders: bucket?.orders ?? 0,
      units: bucket?.units ?? 0,
    }
  })

  // ── Monthly trend (same approved population, report end as the cut-off) ──
  const monthlyTrend = monthKeyRange(period.month, MONTHLY_TREND_MONTHS).map((month) => {
    const start = `${month}-01`
    const end = month === period.month ? windows.end : `${shiftMonthKey(month, 1)}-01`
    const rows = input.orders.filter((order) => isApprovedSale(order) && inWindow(order.orderDate, start, end))
    return {
      month,
      label: monthShortLabel(month),
      value: round2(rows.reduce((sum, order) => sum + orderValue(order), 0)),
      orders: rows.length,
      units: rows.reduce((sum, order) => sum + orderUnits(order), 0),
      isPartial: month === period.month && period.isCurrentMonth,
    }
  })

  // ── Product mix ──────────────────────────────────────────────────────────
  const mix = new Map<string, { units: number; value: number }>()
  for (const order of currentSales) {
    for (const item of order.items) {
      if (!item.variantId) continue
      const entry = mix.get(item.variantId) ?? { units: 0, value: 0 }
      entry.units += Number(item.qty) || 0
      entry.value += Number(item.lineTotal) || 0
      mix.set(item.variantId, entry)
    }
  }
  const productMix = [...mix.entries()]
    .map(([variantId, entry]) => ({
      variantId,
      name: names[variantId] || 'Unknown Product',
      units: entry.units,
      value: round2(entry.value),
      unitsSharePct: share(entry.units, unitsSold),
    }))
    .sort((a, b) => b.units - a.units || b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, PRODUCT_MIX_LIMIT)

  // ── Buyer performance — keyed by organisation id, never by name ──────────
  const buyersById = new Map<string, { name: string; buyerType: string | null; orders: number; units: number; value: number }>()
  for (const order of currentSales) {
    const id = order.buyerId ?? 'unknown'
    const entry = buyersById.get(id) ?? { name: order.buyerName || 'Unknown buyer', buyerType: order.buyerType, orders: 0, units: 0, value: 0 }
    entry.orders += 1
    entry.units += orderUnits(order)
    entry.value += orderValue(order)
    buyersById.set(id, entry)
  }
  const topBuyers = [...buyersById.entries()]
    .map(([buyerId, entry]) => ({
      buyerId,
      ...entry,
      value: round2(entry.value),
      valueSharePct: share(entry.value, sales.approvedSalesValue),
    }))
    .sort((a, b) => b.value - a.value || b.units - a.units || a.name.localeCompare(b.name))
    .slice(0, TOP_BUYERS_LIMIT)

  // ── Latest approved orders in the month (SO date, then entry time) ───────
  const recentOrders = [...currentSales]
    .sort((a, b) => b.orderDate.localeCompare(a.orderDate) || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    .slice(0, RECENT_ORDERS_LIMIT)
    .map((order) => ({
      id: order.id,
      orderNo: order.orderNo,
      orderDate: order.orderDate,
      createdAt: order.createdAt,
      buyerName: order.buyerName || 'Unknown buyer',
      orderType: String(order.orderType).toUpperCase(),
      status: order.status,
      units: orderUnits(order),
      value: round2(orderValue(order)),
    }))

  return {
    period,
    meta: {
      dateField: OVERVIEW_DATE_FIELD,
      valueField: OVERVIEW_VALUE_FIELD,
      timeZone: period.timeZone,
      approvedStatuses: [...APPROVED_SALES_STATUSES],
      salesOrderTypes: ['D2H', 'S2D'],
      notice: input.notice ?? null,
    },
    summary: {
      ...sales,
      unitsSold,
      activeBuyers: buyers.all,
      activeDistributorBuyers: buyers.distributors,
      activeShopBuyers: buyers.shops,
      avgOrderValue: sales.approvedSalesOrders > 0 ? round2(sales.approvedSalesValue / sales.approvedSalesOrders) : null,
    },
    comparison: {
      approvedSalesValue: compare(sales.approvedSalesValue, previousSummary.approvedSalesValue),
      approvedSalesOrders: compare(sales.approvedSalesOrders, previousSummary.approvedSalesOrders),
      unitsSold: compare(unitsSold, previousUnits),
      activeBuyers: compare(buyers.all, previousBuyers.all),
      distributorSalesValue: compare(sales.distributorSalesValue, previousSummary.distributorSalesValue),
      shopSalesValue: compare(sales.shopSalesValue, previousSummary.shopSalesValue),
    },
    dailyTrend,
    monthlyTrend,
    productMix,
    topBuyers,
    recentOrders,
    isEmpty: current.length === 0,
  }
}

/** `Serapod_Executive_Overview_2026-10_MTD.pdf`; a completed month has no MTD suffix. */
export function executiveOverviewFilename(period: ExecutiveOverviewPeriod): string {
  return `Serapod_Executive_Overview_${period.month}${period.isCurrentMonth ? '_MTD' : ''}.pdf`
}
