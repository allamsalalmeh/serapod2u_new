/**
 * Data source for the monthly Distributor Analytics report.
 *
 * Primary path is the `reporting_distributor_analytics` RPC, which aggregates
 * the whole report inside the database and returns a few KB of JSON however
 * many orders the month holds.
 *
 * The fallback mirrors `product-analytics-source.ts`: when application code
 * reaches a database whose migration / schema cache is behind, the aggregation
 * still runs SERVER-SIDE so the browser only ever receives the compact report.
 * It is deliberately different from the model it replaces:
 *
 *   - the browser never receives raw orders — the previous route returned the
 *     full order population plus every distributor on every request;
 *   - order items are read in ONE paged join filtered on the embedded order,
 *     never by batching order ids;
 *   - product labels are resolved in ONE `.in()` query over the ranked
 *     variants, never per line;
 *   - the only all-history read is a narrow `(id, buyer, order_date, status)`
 *     projection, which is what "first ever order" and dormancy require.
 *
 * Every read windows and buckets on the business date `orders.order_date`.
 * Against a database that predates the order_date migration the column does
 * not exist; the reads then fall back to the Malaysia date of `created_at`
 * (exactly how the migration backfills legacy rows) and the report says so.
 *
 * The fallback is a bridge for environments where the reporting migration has
 * not been applied yet; it is bounded and reports itself as degraded.
 */

import {
  ACTIVE_KPI_MODEL,
  ACTIVE_STATUSES,
  ALL_DISTRIBUTORS,
  ALL_DISTRIBUTORS_LABEL,
  ALL_STATUS,
  DISTRIBUTOR_ORG_TYPE,
  ELIGIBLE_ORDER_TYPE,
  emptyAggregate,
  isActiveStatus,
  LEGACY_REPORT_DATE_FIELD,
  REPORT_DATE_FIELD,
  reportDateWindows,
  resolveDistributorReportPeriod,
  type DistributorAggregate,
  type DistributorAnalyticsAggregate,
  type DistributorReportPeriod,
  type OrderRecordTotals,
  type ProductTotals,
  type StatusTotals,
} from './distributor-analytics'
import { reportingPeriodFromKey, REPORTING_TIME_ZONE, type ReportingPeriod } from './reporting-period'
import {
  businessDateStartUtc,
  isDateKey,
  malaysiaDateOf,
  orderBusinessDate,
} from '@/lib/orders/order-date'
import {
  filterBusinessDateRange,
  legacyOrderDateNotice,
  orderByBusinessDate,
  orderDateSelect,
  resolveOrderDateColumn,
  type OrderDateColumn,
} from './business-date-query'

export { filterBusinessDateRange, orderByBusinessDate, orderDateSelect, resolveOrderDateColumn }
export type { OrderDateColumn }

const PAGE_SIZE = 1000
/** Hard ceiling for the degraded fallback. Beyond this the migration is required. */
export const MAX_FALLBACK_ROWS = 200_000
/** Variants whose labels are resolved for the Top Products table. */
const LABEL_LOOKUP_LIMIT = 50

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000

export interface DistributorAnalyticsSourceResult {
  aggregate: DistributorAnalyticsAggregate
  source: 'rpc' | 'fallback'
  degraded: boolean
  notice: string | null
}

export function isMissingDistributorAnalyticsRpc(error: any): boolean {
  const message = String(error?.message || '')
  return error?.code === 'PGRST202'
    || (message.includes('reporting_distributor_analytics') && message.includes('schema cache'))
}

export function isMissingDistributorPeriodsRpc(error: any): boolean {
  const message = String(error?.message || '')
  return error?.code === 'PGRST202'
    || (message.includes('reporting_distributor_order_periods') && message.includes('schema cache'))
}

/** One selectable distributor, as the filters endpoint returns it. */
export interface ReportingDistributor {
  id: string
  name: string
  orgCode: string | null
  isActive: boolean
}

/** MYT calendar date of an instant — the bucket a Malaysian 00:30 order belongs to. */
export function mytDate(timestamp: string): string {
  return new Date(new Date(timestamp).getTime() + MYT_OFFSET_MS).toISOString().slice(0, 10)
}

// ── Records as the fallback queries return them ────────────────────────────

/** Narrow all-history order projection: no items, no joins, a handful of columns. */
export interface OrderRecord {
  id: string
  buyer_org_id: string | null
  /** Business date; absent when read from a database without the column. */
  order_date?: string | null
  created_at: string | null
  status: string | null
  order_no?: string | null
  display_doc_no?: string | null
}

/** An order item joined to its order, as the windowed fallback query returns it. */
export interface OrderItemRecord {
  order_id: string
  variant_id: string | null
  product_id: string | null
  qty: number | null
  line_total: number | null
  unit_price?: number | null
}

export interface DistributorRecord {
  id: string
  org_name: string | null
  org_code?: string | null
  is_active?: boolean | null
}

export interface VariantLabelRecord {
  id: string
  product_id: string | null
  variant_name: string | null
  product_code: string | null
  productName?: string | null
}

/** Line value, preferring the generated `line_total` and falling back to qty × price. */
export function lineValue(row: OrderItemRecord): number {
  const total = Number(row.line_total)
  if (Number.isFinite(total) && total !== 0) return total
  const qty = Number(row.qty) || 0
  const price = Number(row.unit_price) || 0
  return qty * price
}

// ── Pure aggregation (fallback + regression tests) ──────────────────────────

/**
 * Fold orders, order items and master data into the shape the RPC returns.
 *
 * `orders` must be the distributor's ALL-HISTORY eligible population already
 * restricted to the report's order type, buyer scope and status scope, every
 * status included. Only its ACTIVE orders (`isActiveStatus`) reach the
 * headline, trend, rankings, top products and the lifetime first/last order
 * dates that decide New and Dormant; the whole scope reaches Orders Created,
 * the status mix and Recent Orders — the same split the RPC applies.
 * `items` covers only the report window and its comparison window; which
 * window a row belongs to is decided from its order's business date
 * (`order_date`, or the Malaysia date of `created_at` for a legacy row).
 */
export function aggregateDistributorOrders(
  orders: OrderRecord[],
  items: OrderItemRecord[],
  distributors: DistributorRecord[],
  variants: VariantLabelRecord[],
  month: string,
  now: Date = new Date(),
  period: DistributorReportPeriod = resolveDistributorReportPeriod(month, now),
  distributorId: string = ALL_DISTRIBUTORS,
  status: string = ALL_STATUS,
  dateField: string = REPORT_DATE_FIELD,
): DistributorAnalyticsAggregate {
  const windows = reportDateWindows(period)

  const valueByOrder = new Map<string, number>()
  const itemCountByOrder = new Map<string, number>()
  for (const item of items) {
    valueByOrder.set(item.order_id, (valueByOrder.get(item.order_id) ?? 0) + lineValue(item))
    itemCountByOrder.set(item.order_id, (itemCountByOrder.get(item.order_id) ?? 0) + 1)
  }

  const nameById = new Map(distributors.map((row) => [row.id, row]))

  interface Bucket {
    currentOrders: number
    currentValue: number
    previousOrders: number
    previousValue: number
    firstOrderDate: string | null
    lastOrderDate: string | null
    lifetimeOrders: number
  }
  const buckets = new Map<string, Bucket>()
  const bucketFor = (id: string): Bucket => {
    let bucket = buckets.get(id)
    if (!bucket) {
      bucket = {
        currentOrders: 0, currentValue: 0, previousOrders: 0, previousValue: 0,
        firstOrderDate: null, lastOrderDate: null, lifetimeOrders: 0,
      }
      buckets.set(id, bucket)
    }
    return bucket
  }

  const dayTotals = new Map<string, { orders: number; orderValue: number }>()
  const statusTotals = new Map<string, StatusTotals>()
  const currentOrderIds = new Set<string>()
  const recent: OrderRecordTotals[] = []

  let currentOrders = 0
  let currentValue = 0
  let previousOrders = 0
  let previousValue = 0
  let currentCreated = 0
  let previousCreated = 0

  for (const order of orders) {
    // The business date decides everything below; created_at is only carried.
    const orderDate = orderBusinessDate(order)
    const buyerId = order.buyer_org_id
    if (!orderDate || !buyerId) continue

    const active = isActiveStatus(order.status)
    const value = valueByOrder.get(order.id) ?? 0
    // Half-open business-date windows: an order dated the first day of the next
    // month belongs to that month, never to both.
    const inCurrent = orderDate >= windows.start && orderDate < windows.end
    const inPrevious = orderDate >= windows.comparisonStart && orderDate < windows.comparisonEnd

    if (inCurrent) currentCreated += 1
    if (inPrevious) previousCreated += 1

    // Lifetime history, window figures and rankings: active orders only.
    const bucket = active ? bucketFor(buyerId) : null
    if (bucket) {
      bucket.lifetimeOrders += 1
      if (bucket.firstOrderDate === null || orderDate < bucket.firstOrderDate) bucket.firstOrderDate = orderDate
      if (bucket.lastOrderDate === null || orderDate > bucket.lastOrderDate) bucket.lastOrderDate = orderDate
    }

    if (inCurrent) {
      if (bucket) {
        bucket.currentOrders += 1
        bucket.currentValue += value
        currentOrders += 1
        currentValue += value
        currentOrderIds.add(order.id)

        const day = orderDate
        const dayBucket = dayTotals.get(day) ?? { orders: 0, orderValue: 0 }
        dayBucket.orders += 1
        dayBucket.orderValue += value
        dayTotals.set(day, dayBucket)
      }

      // Status mix and Recent Orders keep every status of the scope.
      const statusKey = order.status || 'unknown'
      const statusBucket = statusTotals.get(statusKey) ?? { status: statusKey, orders: 0, orderValue: 0 }
      statusBucket.orders += 1
      statusBucket.orderValue += value
      statusTotals.set(statusKey, statusBucket)

      recent.push({
        orderId: order.id,
        orderNo: order.display_doc_no || order.order_no || null,
        orderDate,
        createdAt: order.created_at ?? businessDateStartUtc(orderDate),
        status: statusKey,
        distributorId: buyerId,
        distributorName: (nameById.get(buyerId)?.org_name || '').trim() || 'Unknown distributor',
        orderValue: value,
        itemCount: itemCountByOrder.get(order.id) ?? 0,
      })
    }
    if (inPrevious && bucket) {
      bucket.previousOrders += 1
      bucket.previousValue += value
      previousOrders += 1
      previousValue += value
    }
  }

  // ── Top products, from the CURRENT window only ──────────────────────────
  const variantById = new Map(variants.map((row) => [row.id, row]))
  const productTotals = new Map<string, ProductTotals>()
  for (const item of items) {
    if (!currentOrderIds.has(item.order_id)) continue
    const key = item.variant_id || `product:${item.product_id ?? 'unknown'}`
    const variant = item.variant_id ? variantById.get(item.variant_id) : undefined
    const entry = productTotals.get(key) ?? {
      variantId: item.variant_id,
      productId: item.product_id ?? variant?.product_id ?? null,
      productName: variant?.productName ?? null,
      variantName: variant?.variant_name ?? null,
      productCode: variant?.product_code ?? null,
      units: 0,
      orderValue: 0,
    }
    entry.units += Number(item.qty) || 0
    entry.orderValue += lineValue(item)
    productTotals.set(key, entry)
  }

  // ── Distributor rows ────────────────────────────────────────────────────
  const distributorRows: DistributorAggregate[] = [...buckets.entries()].map(([id, bucket]) => {
    const org = nameById.get(id)
    return {
      distributorId: id,
      name: (org?.org_name || '').trim() || 'Unknown distributor',
      orgCode: org?.org_code ?? null,
      isActive: org?.is_active !== false,
      currentOrders: bucket.currentOrders,
      currentValue: bucket.currentValue,
      previousOrders: bucket.previousOrders,
      previousValue: bucket.previousValue,
      firstOrderAt: bucket.firstOrderDate ? businessDateStartUtc(bucket.firstOrderDate) : null,
      lastOrderAt: bucket.lastOrderDate ? businessDateStartUtc(bucket.lastOrderDate) : null,
      lifetimeOrders: bucket.lifetimeOrders,
      firstOrderDate: bucket.firstOrderDate,
      lastOrderDate: bucket.lastOrderDate,
    }
  })

  const activeDistributors = distributorRows.filter((row) => row.currentOrders > 0).length
  const previousActive = distributorRows.filter((row) => row.previousOrders > 0).length

  // Every day of the report window is present, including days with no trading,
  // and no day beyond it — the running month stops at today.
  const dailyTrend = Array.from({ length: period.dayCount }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`
    const bucket = dayTotals.get(date)
    return { date, orders: bucket?.orders ?? 0, orderValue: bucket?.orderValue ?? 0 }
  })

  const scopeName = distributorId === ALL_DISTRIBUTORS
    ? ALL_DISTRIBUTORS_LABEL
    : (nameById.get(distributorId)?.org_name || '').trim() || 'Unknown distributor'

  return {
    month,
    distributorId,
    distributorName: scopeName,
    status,
    dateField,
    kpiModel: ACTIVE_KPI_MODEL,
    current: { orders: currentOrders, orderValue: currentValue, activeDistributors, ordersCreated: currentCreated },
    previous: { orders: previousOrders, orderValue: previousValue, activeDistributors: previousActive, ordersCreated: previousCreated },
    dailyTrend,
    distributors: distributorRows,
    statusBreakdown: [...statusTotals.values()],
    topProducts: [...productTotals.values()],
    recentOrders: recent
      .sort((a, b) => b.orderDate.localeCompare(a.orderDate)
        || Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 20),
  }
}

// ── Query helpers ──────────────────────────────────────────────────────────


/**
 * The eligible-order scope every Distributor Analytics read shares — the same
 * rules the `reporting_distributor_analytics` RPC's `eligible` CTE applies:
 * D2H orders whose buyer is one of the scoped DIST organisations, optionally
 * narrowed to one status. Used by the fallback aggregation, the CSV export and
 * the dashboard drill-downs, so none of them re-states the definition.
 *
 * `activeOnly` intersects the scope with the active statuses (the RPC's
 * `is_active`), for reads that must match Active Orders: a specific status
 * outside the active set then yields nothing, exactly as the headline does.
 */
export function scopeEligibleDistributorOrders(
  query: any,
  distributorIds: string[],
  status: string = ALL_STATUS,
  options: { activeOnly?: boolean } = {},
) {
  let scoped = query
    .eq('order_type', ELIGIBLE_ORDER_TYPE)
    .in('buyer_org_id', distributorIds)
  if (status !== ALL_STATUS) scoped = scoped.eq('status', status)
  if (options.activeOnly) scoped = scoped.in('status', ACTIVE_STATUSES)
  return scoped
}

/** Order value exactly as the active report source computes it. */
export function reportOrderValue(items: OrderItemRecord[], source: 'rpc' | 'fallback'): number {
  return items.reduce((sum, item) => {
    if (source === 'rpc') {
      // RPC: sum(COALESCE(line_total, qty * unit_price))
      const total = item.line_total
      return sum + (total === null || total === undefined ? (Number(item.qty) || 0) * (Number(item.unit_price) || 0) : Number(total) || 0)
    }
    return sum + lineValue(item)
  }, 0)
}

/** One eligible order of the report window, as the Total Orders drill-down lists it. */
export interface EligibleWindowOrder {
  orderId: string
  orderNo: string
  /** Business SO date (YYYY-MM-DD) — the date shown and sorted on. */
  orderDate: string
  /** Actual entry instant (audit). */
  createdAt: string
  updatedAt: string | null
  status: string
  distributorId: string
  distributorName: string
  distributorCode: string | null
  orderValue: number
  lineCount: number
  createdById: string | null
}

/**
 * Every ACTIVE eligible order whose business date falls inside the report
 * window [start, end) for the scope, newest first — the population whose count
 * is "Active Orders". Draft and cancelled orders are not listed here; they are
 * in Recent Orders, Order Processing Health and the CSV export.
 */
export async function fetchEligibleWindowOrders(
  supabase: any,
  input: {
    distributors: ReportingDistributor[]
    status: string
    period: DistributorReportPeriod
    source: 'rpc' | 'fallback'
    dateColumn?: OrderDateColumn
  },
): Promise<EligibleWindowOrder[]> {
  const { distributors, status, period, source } = input
  if (distributors.length === 0 || period.dayCount === 0) return []
  const dateColumn = input.dateColumn ?? await resolveOrderDateColumn(supabase)
  const windows = reportDateWindows(period)
  const byId = new Map(distributors.map((row) => [row.id, row]))
  const orders = await readPages<any>(
    (from, to) => orderByBusinessDate(
      filterBusinessDateRange(
        scopeEligibleDistributorOrders(
          supabase
            .from('orders')
            .select(`id, order_no, display_doc_no, ${orderDateSelect(dateColumn)}, updated_at, status, buyer_org_id, created_by, order_items(qty, unit_price, line_total)`),
          distributors.map((row) => row.id),
          status,
          { activeOnly: true },
        ),
        dateColumn,
        windows.start,
        windows.end,
      ),
      dateColumn,
      false,
    )
      .range(from, to),
    { remaining: MAX_FALLBACK_ROWS },
    'drill-down orders',
  )
  return orders.map((order) => {
    const items = (order.order_items || []) as OrderItemRecord[]
    const distributor = byId.get(order.buyer_org_id)
    return {
      orderId: order.id,
      orderNo: order.display_doc_no || order.order_no || order.id,
      orderDate: orderBusinessDate(order) ?? '',
      createdAt: order.created_at,
      updatedAt: order.updated_at ?? null,
      status: order.status || 'unknown',
      distributorId: order.buyer_org_id,
      distributorName: distributor?.name || 'Unknown distributor',
      distributorCode: distributor?.orgCode ?? null,
      orderValue: reportOrderValue(items, source),
      lineCount: items.length,
      createdById: order.created_by ?? null,
    }
  })
}

/** Narrow all-history ACTIVE eligible orders for a set of distributors (dates and numbers only) — the history the report's first / last order dates come from. */
export async function fetchEligibleOrderHistory(
  supabase: any,
  input: { distributorIds: string[]; status: string; dateColumn?: OrderDateColumn },
): Promise<OrderRecord[]> {
  if (input.distributorIds.length === 0) return []
  const dateColumn = input.dateColumn ?? await resolveOrderDateColumn(supabase)
  return readPages<OrderRecord>(
    (from, to) => orderByBusinessDate(
      scopeEligibleDistributorOrders(
        supabase.from('orders').select(`id, buyer_org_id, ${orderDateSelect(dateColumn)}, status, order_no, display_doc_no`),
        input.distributorIds,
        input.status,
        { activeOnly: true },
      )
        .not(dateColumn, 'is', null),
      dateColumn,
      true,
    )
      .range(from, to),
    { remaining: MAX_FALLBACK_ROWS },
    'drill-down order history',
  )
}

async function readPages<T>(
  build: (from: number, to: number) => any,
  budget: { remaining: number },
  label: string,
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const page = (data || []) as T[]
    rows.push(...page)
    budget.remaining -= page.length
    if (budget.remaining < 0) {
      throw new Error(
        `Distributor Analytics fallback exceeded its row budget while reading ${label}. Apply migration `
        + '20261212100000_distributor_analytics_active_orders.sql so the report is aggregated in the database.',
      )
    }
    if (page.length < PAGE_SIZE) break
  }
  return rows
}

/**
 * Selectable distributors from canonical master data.
 *
 * Every DIST organisation is offered, active or not: a distributor that has
 * been deactivated still has trading history the report must be able to open.
 */
export async function fetchReportingDistributors(supabase: any): Promise<ReportingDistributor[]> {
  const { data, error } = await supabase
    .from('organizations')
    .select('id, org_name, org_code, is_active')
    .eq('org_type_code', DISTRIBUTOR_ORG_TYPE)
    .order('org_name', { ascending: true })
  if (error) throw error
  return ((data || []) as any[]).map((row) => ({
    id: row.id,
    name: (row.org_name || '').trim() || 'Unknown distributor',
    orgCode: row.org_code ?? null,
    isActive: row.is_active !== false,
  }))
}

/** Reporting months that hold eligible distributor order activity, newest first. */
export async function fetchDistributorOrderPeriods(supabase: any): Promise<ReportingPeriod[]> {
  const { data, error } = await supabase.rpc('reporting_distributor_order_periods')
  if (!error) {
    return ((data || []) as any[])
      .map((row) => reportingPeriodFromKey(String(row.period_key), Number(row.transaction_count) || 0))
      .filter((period): period is ReportingPeriod => period !== null)
      .sort((a, b) => b.key.localeCompare(a.key))
  }
  if (!isMissingDistributorPeriodsRpc(error)) throw error

  // Reporting months follow the business date, like the report itself.
  const dateColumn = await resolveOrderDateColumn(supabase)
  const months = new Map<string, number>()
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: page, error: pageError } = await orderByBusinessDate(
      supabase
        .from('orders')
        .select(`id, ${orderDateSelect(dateColumn)}`)
        .eq('order_type', ELIGIBLE_ORDER_TYPE)
        .not(dateColumn, 'is', null),
      dateColumn,
      false,
    )
      .range(from, from + PAGE_SIZE - 1)
    if (pageError) throw pageError
    const rows = (page || []) as { order_date?: string | null; created_at: string | null }[]
    for (const row of rows) {
      const date = orderBusinessDate(row)
      if (!date) continue
      const key = date.slice(0, 7)
      months.set(key, (months.get(key) ?? 0) + 1)
    }
    if (rows.length < PAGE_SIZE || from > 50_000) break
  }

  return [...months.entries()]
    .map(([key, count]) => reportingPeriodFromKey(key, count)!)
    .filter(Boolean)
    .sort((a, b) => b.key.localeCompare(a.key))
}

// ── Main entry point ───────────────────────────────────────────────────────

export async function fetchDistributorAnalyticsAggregate(
  supabase: any,
  month: string,
  distributorId: string = ALL_DISTRIBUTORS,
  status: string = ALL_STATUS,
  now: Date = new Date(),
): Promise<DistributorAnalyticsSourceResult> {
  const period = resolveDistributorReportPeriod(month, now)
  const isAllDistributors = distributorId === ALL_DISTRIBUTORS
  const isAllStatus = status === ALL_STATUS

  const { data, error } = await supabase.rpc('reporting_distributor_analytics', {
    p_month: month,
    p_distributor_id: isAllDistributors ? null : distributorId,
    p_status: isAllStatus ? null : status,
  })
  // An installed function that predates the active-order definitions still
  // counts draft and cancelled orders in the headline; its figures are not
  // used, and the report is aggregated on the server instead.
  const legacyKpiModel = !error && data?.kpiModel !== ACTIVE_KPI_MODEL
  if (!error && !legacyKpiModel) {
    const aggregate = normalizeAggregate(data, month, period, distributorId, status)
    return {
      aggregate,
      source: 'rpc',
      degraded: false,
      // The installed function predates order_date and still buckets on
      // created_at: say so rather than present entry dates as SO dates.
      notice: aggregate.dateField === LEGACY_REPORT_DATE_FIELD
        ? 'Reporting function still buckets on orders.created_at — backdated SO dates are not reflected yet. '
          + 'Apply migrations 20260921120000_add_orders_order_date.sql and 20260921120200_distributor_analytics_order_date.sql.'
        : null,
    }
  }
  if (error && !isMissingDistributorAnalyticsRpc(error)) throw error

  if (period.dayCount === 0) {
    return {
      aggregate: emptyAggregate(month, period, distributorId, ALL_DISTRIBUTORS_LABEL, status),
      source: 'fallback',
      degraded: true,
      notice: 'The selected reporting month has not started yet.',
    }
  }

  // Distributor organisations are resolved first so the order scans can filter
  // on stable ids. This is what keeps "buyer must be a distributor" a single
  // indexed `IN`, rather than a post-filter over every order in the database.
  const allDistributors = await fetchReportingDistributors(supabase)
  const scopedDistributors = isAllDistributors
    ? allDistributors
    : allDistributors.filter((row) => row.id === distributorId)

  if (scopedDistributors.length === 0) {
    return {
      aggregate: emptyAggregate(month, period, distributorId, ALL_DISTRIBUTORS_LABEL, status),
      source: 'fallback',
      degraded: true,
      notice: 'No distributor organisations are visible for the selected scope.',
    }
  }

  const distributorIds = scopedDistributors.map((row) => row.id)
  const budget = { remaining: MAX_FALLBACK_ROWS }
  const dateColumn = await resolveOrderDateColumn(supabase)
  const windows = reportDateWindows(period)

  const withScope = (query: any) => scopeEligibleDistributorOrders(query, distributorIds, status)

  const [orders, items] = await Promise.all([
    // All-history, narrow projection. "First ever order" and dormancy cannot be
    // decided from the report window, so this read is unavoidable without the
    // RPC — it carries no joins and no order lines.
    readPages<OrderRecord>(
      (from, to) => orderByBusinessDate(
        withScope(
          supabase
            .from('orders')
            .select(`id, buyer_org_id, ${orderDateSelect(dateColumn)}, status, order_no, display_doc_no`),
        )
          .not(dateColumn, 'is', null),
        dateColumn,
        true,
      )
        .range(from, to),
      budget,
      'orders',
    ),
    // The report window and its comparison window are adjacent, so one range
    // covering both is a single scan rather than two.
    readPages<OrderItemRecord>(
      (from, to) => {
        let query = filterBusinessDateRange(
          supabase
            .from('order_items')
            .select(`order_id, variant_id, product_id, qty, unit_price, line_total, orders!inner(${orderDateSelect(dateColumn)}, order_type, buyer_org_id, status)`)
            .eq('orders.order_type', ELIGIBLE_ORDER_TYPE)
            .in('orders.buyer_org_id', distributorIds),
          dateColumn,
          windows.comparisonStart,
          windows.end,
          'orders.',
        )
        if (!isAllStatus) query = query.eq('orders.status', status)
        return query.order('id', { ascending: true }).range(from, to)
      },
      budget,
      'order items',
    ),
  ])

  // Product labels are resolved for the ranked variants only — one `.in()`
  // query over at most LABEL_LOOKUP_LIMIT ids, never one lookup per line.
  const variants = await fetchVariantLabels(supabase, items, orders, period)

  return {
    aggregate: aggregateDistributorOrders(
      orders, items, scopedDistributors.map((row) => ({
        id: row.id, org_name: row.name, org_code: row.orgCode, is_active: row.isActive,
      })),
      variants, month, now, period, distributorId, status,
      dateColumn === 'order_date' ? REPORT_DATE_FIELD : LEGACY_REPORT_DATE_FIELD,
    ),
    source: 'fallback',
    degraded: true,
    notice: [
      legacyKpiModel
        ? 'Reporting function predates the active-order KPI definitions — figures were aggregated on the server. Apply migration '
          + '20261212100000_distributor_analytics_active_orders.sql to aggregate the report in the database.'
        : 'Reporting function not installed yet — figures were aggregated on the server. Apply migration '
          + '20261212100000_distributor_analytics_active_orders.sql to aggregate the report in the database.',
      legacyOrderDateNotice(dateColumn),
    ].filter(Boolean).join(' '),
  }
}

/** Resolve product identity for the highest-value variants in the report window. */
async function fetchVariantLabels(
  supabase: any,
  items: OrderItemRecord[],
  orders: OrderRecord[],
  period: DistributorReportPeriod,
): Promise<VariantLabelRecord[]> {
  const windows = reportDateWindows(period)
  const inWindow = new Set(
    orders
      .filter((order) => {
        const date = orderBusinessDate(order)
        return isActiveStatus(order.status) && date !== null && date >= windows.start && date < windows.end
      })
      .map((order) => order.id),
  )

  const valueByVariant = new Map<string, number>()
  for (const item of items) {
    if (!item.variant_id || !inWindow.has(item.order_id)) continue
    valueByVariant.set(item.variant_id, (valueByVariant.get(item.variant_id) ?? 0) + lineValue(item))
  }
  const ids = [...valueByVariant.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, LABEL_LOOKUP_LIMIT)
    .map(([id]) => id)
  if (ids.length === 0) return []

  const { data, error } = await supabase
    .from('product_variants')
    .select('id, product_id, variant_name, product_code, products(product_name)')
    .in('id', ids)
  if (error) throw error

  return ((data || []) as any[]).map((row) => {
    // PostgREST resolves an embedded relation as an object or a single-element array.
    const embedded = Array.isArray(row.products) ? row.products[0] : row.products
    return {
      id: row.id,
      product_id: row.product_id ?? null,
      variant_name: row.variant_name ?? null,
      product_code: row.product_code ?? null,
      productName: embedded?.product_name ?? null,
    }
  })
}

/** A business date from the RPC, or the Malaysia date of a legacy instant. */
function normalizeOrderDate(dateKey: unknown, instant: unknown): string | null {
  if (typeof dateKey === 'string' && isDateKey(dateKey.slice(0, 10))) return dateKey.slice(0, 10)
  return typeof instant === 'string' ? malaysiaDateOf(instant) : null
}

/**
 * The instant used for recency and window membership, in the same ISO form as
 * the period boundaries: the MYT start of the business date when the RPC
 * reports one, otherwise the legacy instant as sent.
 */
function normalizeOrderInstant(dateKey: unknown, instant: unknown): string | null {
  if (typeof dateKey === 'string' && isDateKey(dateKey.slice(0, 10))) return businessDateStartUtc(dateKey.slice(0, 10))
  if (typeof instant !== 'string') return null
  const ms = Date.parse(instant)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** Coerce the RPC's JSON (bigint counts arrive as numbers, arrays may be null). */
function normalizeAggregate(
  payload: any,
  month: string,
  period: DistributorReportPeriod,
  distributorId: string = ALL_DISTRIBUTORS,
  status: string = ALL_STATUS,
): DistributorAnalyticsAggregate {
  const totals = (value: any) => ({
    orders: Number(value?.orders) || 0,
    orderValue: Number(value?.orderValue) || 0,
    activeDistributors: Number(value?.activeDistributors) || 0,
    ordersCreated: Number(value?.ordersCreated) || 0,
  })

  return {
    month: payload?.month || month,
    distributorId: payload?.distributorId || distributorId,
    distributorName: payload?.distributorName
      || (distributorId === ALL_DISTRIBUTORS ? ALL_DISTRIBUTORS_LABEL : 'Unknown distributor'),
    status: payload?.status || status,
    // The pre-order_date RPC does not report its date field: it bucketed on created_at.
    dateField: payload?.dateField || LEGACY_REPORT_DATE_FIELD,
    kpiModel: payload?.kpiModel,
    current: totals(payload?.current),
    previous: totals(payload?.previous),
    dailyTrend: (payload?.dailyTrend || []).map((row: any) => ({
      date: String(row.date),
      orders: Number(row.orders) || 0,
      orderValue: Number(row.orderValue) || 0,
    })),
    distributors: (payload?.distributors || []).map((row: any): DistributorAggregate => ({
      distributorId: String(row.distributorId),
      name: row.name ?? 'Unknown distributor',
      orgCode: row.orgCode ?? null,
      isActive: row.isActive !== false,
      currentOrders: Number(row.currentOrders) || 0,
      currentValue: Number(row.currentValue) || 0,
      previousOrders: Number(row.previousOrders) || 0,
      previousValue: Number(row.previousValue) || 0,
      firstOrderAt: normalizeOrderInstant(row.firstOrderDate, row.firstOrderAt),
      lastOrderAt: normalizeOrderInstant(row.lastOrderDate, row.lastOrderAt),
      lifetimeOrders: Number(row.lifetimeOrders) || 0,
      firstOrderDate: normalizeOrderDate(row.firstOrderDate, row.firstOrderAt),
      lastOrderDate: normalizeOrderDate(row.lastOrderDate, row.lastOrderAt),
    })),
    statusBreakdown: (payload?.statusBreakdown || []).map((row: any): StatusTotals => ({
      status: String(row.status ?? 'unknown'),
      orders: Number(row.orders) || 0,
      orderValue: Number(row.orderValue) || 0,
    })),
    topProducts: (payload?.topProducts || []).map((row: any): ProductTotals => ({
      variantId: row.variantId ?? null,
      productId: row.productId ?? null,
      productName: row.productName ?? null,
      variantName: row.variantName ?? null,
      productCode: row.productCode ?? null,
      units: Number(row.units) || 0,
      orderValue: Number(row.orderValue) || 0,
    })),
    recentOrders: (payload?.recentOrders || []).map((row: any): OrderRecordTotals => ({
      orderId: String(row.orderId),
      orderNo: row.orderNo ?? null,
      orderDate: normalizeOrderDate(row.orderDate, row.createdAt) ?? '',
      createdAt: String(row.createdAt),
      status: String(row.status ?? 'unknown'),
      distributorId: String(row.distributorId),
      distributorName: row.distributorName ?? 'Unknown distributor',
      orderValue: Number(row.orderValue) || 0,
      itemCount: Number(row.itemCount) || 0,
    })),
  }
}

export { REPORTING_TIME_ZONE, resolveDistributorReportPeriod }
