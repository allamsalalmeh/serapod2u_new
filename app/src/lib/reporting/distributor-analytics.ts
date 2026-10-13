/**
 * Distributor Analytics — monthly distributor management report.
 *
 * Shared by the reporting API route (server), DistributorReportsTab (client)
 * and the PDF generator, so the web report and the downloaded PDF can never
 * disagree: all three consume the single DTO this module builds.
 *
 * Everything here is pure. The aggregate arrives either from the
 * `reporting_distributor_analytics` RPC or from the route's bounded
 * server-side fallback; this module turns it into the display DTO and applies
 * every management classification rule.
 *
 * The period model is imported from the Product Analytics monthly report
 * rather than re-implemented. The month-to-date rule, the same-elapsed-days
 * comparison and its short-previous-month clamp must be identical across the
 * monthly reports, and a third copy is a third chance to drift.
 */

import {
  formatReportDate,
  monthShortLabel,
  resolveProductReportPeriod,
  type ProductReportPeriod,
} from './product-analytics'
import {
  buildReportingMonthOptions,
  currentReportingMonthKey,
  daysInMonthKey,
  isValidMonthKey,
  metricDelta,
  previousMonthKey,
  rateDelta,
  safeShare,
  shiftMonthKey,
  type MetricDelta,
  type RateDelta,
} from './consumer-analytics'
import { REPORTING_TIME_ZONE } from './reporting-period'
import { addDaysToDateKey } from '@/lib/orders/order-date'

export {
  REPORTING_TIME_ZONE,
  buildReportingMonthOptions,
  currentReportingMonthKey,
  daysInMonthKey,
  formatReportDate,
  isValidMonthKey,
  monthShortLabel,
  previousMonthKey,
  shiftMonthKey,
}
export type { MetricDelta, RateDelta }

const DAY_MS = 24 * 60 * 60 * 1000

// ── Order inclusion semantics (deliberately unchanged) ─────────────────────

/**
 * The order type this report has always measured.
 *
 * D2H is the distributor's purchase order to HQ — distributor sell-in. The
 * previous DistributorReportsTab pinned `orderType=D2H` on every request from
 * the client; the rule now lives here so it is documented and testable rather
 * than hidden in a query-string literal.
 */
export const ELIGIBLE_ORDER_TYPE = 'D2H'

/** The buyer organisation type that makes an order a distributor order. */
export const DISTRIBUTOR_ORG_TYPE = 'DIST'

/**
 * Statuses counted by this report when Status is "All Status".
 *
 * ALL of them, which is the previous report's behaviour and is preserved on
 * purpose: Order Processing Health measures the status mix itself, and it can
 * only do that if cancelled and draft orders are inside the population being
 * measured. This is why the financial KPI is "Order Value" and never
 * "Revenue" — it is the value of orders raised, not recognised revenue.
 */
export const ORDER_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'closed',
  'cancelled',
  'warehouse_packed',
  'shipped_distributor',
] as const

export type OrderStatus = (typeof ORDER_STATUSES)[number]

/**
 * Statuses treated as approved by the Approval Rate.
 *
 * Unchanged from the previous report, which counted `approved` and `closed`
 * against every order in the window. Completion Rate is reported separately
 * rather than folded into this one, so neither number changes meaning.
 */
export const APPROVED_STATUSES: string[] = ['approved', 'closed']
/** Statuses treated as completed by the Completion Rate. */
export const COMPLETED_STATUSES: string[] = ['closed']

/**
 * The business date the monthly report buckets on — `orders.order_date`, the
 * SO date (a Malaysia calendar date that may be backdated). `orders.created_at`
 * stays the audit/entry timestamp and no longer decides the reporting period:
 * an SO dated 31 Aug keyed in on 21 Sep is August sell-in.
 */
export const REPORT_DATE_FIELD = 'orders.order_date'

/**
 * What the report bucketed on when the database predates the order_date
 * migration (the legacy RPC, or a fallback that cannot see the column). The
 * report states it in its meta rather than silently claiming order_date.
 */
export const LEGACY_REPORT_DATE_FIELD = 'orders.created_at'

/** Order Value is summed from order lines, never from an order header total. */
export const ORDER_VALUE_FIELD = 'sum(order_items.line_total)'

// ── Scope sentinels ────────────────────────────────────────────────────────

export const ALL_DISTRIBUTORS = 'all'
export const ALL_DISTRIBUTORS_LABEL = 'All Distributors'
export const ALL_STATUS = 'all'
export const ALL_STATUS_LABEL = 'All Status'

// ── Limits ─────────────────────────────────────────────────────────────────

export const LEADERBOARD_LIMIT = 25
export const HEALTH_ROWS_LIMIT = 60
export const ACTION_ROWS_LIMIT = 60
export const RECENT_ORDERS_LIMIT = 20
/** Distributors in the "Top N" concentration headline. */
export const CONCENTRATION_TOP_N = 3

// ── Classification thresholds (documented business rules) ──────────────────

/**
 * Order-value movement inside ±this band reads as flat trading.
 *
 * Wider than a statistical band on purpose: a single large sell-in order
 * landing on the 2nd rather than the 29th moves a distributor's month by more
 * than 10% without anything having changed commercially.
 */
export const STABLE_BAND_PCT = 15

/** A decline at or beyond this is escalated to HIGH priority. */
export const SEVERE_DECLINE_PCT = -40

/** Days since the last eligible order, measured against the report's as-of instant. */
export const WATCH_DAYS = 45
export const AT_RISK_DAYS = 90
export const DORMANT_DAYS = 180

/**
 * A distributor carrying at least this share of comparison-period Order Value
 * is treated as commercially important, which raises the priority of its
 * re-engagement rather than changing its status.
 */
export const KEY_ACCOUNT_SHARE_PCT = 10

/**
 * Cadence-aware risk needs a settled ordering rhythm before it means anything.
 * Below this many lifetime orders the flat day thresholds are used instead.
 */
export const CADENCE_MIN_ORDERS = 3

// ── Period model ───────────────────────────────────────────────────────────

/**
 * Identical to the Product Analytics window, by import rather than by copy.
 *
 * Current month  → month to date (01 → today), compared against the SAME
 *                  elapsed days of the previous calendar month.
 * Historical month → the complete calendar month, compared against the
 *                  complete previous calendar month, across year boundaries.
 */
export type DistributorReportPeriod = ProductReportPeriod

export function resolveDistributorReportPeriod(month: string, now: Date = new Date()): DistributorReportPeriod {
  return resolveProductReportPeriod(month, now)
}

/**
 * The report and comparison windows as half-open BUSINESS-DATE ranges
 * [start, end) over `orders.order_date` — the same windows the SQL applies.
 * A window with no days (a month that has not started) has start === end.
 */
export function reportDateWindows(period: DistributorReportPeriod): {
  start: string
  end: string
  comparisonStart: string
  comparisonEnd: string
} {
  return {
    start: period.startDate,
    end: addDaysToDateKey(period.startDate, period.dayCount),
    comparisonStart: period.comparisonStartDate,
    comparisonEnd: addDaysToDateKey(period.comparisonStartDate, period.comparisonDayCount),
  }
}

// ── Raw aggregate (mirrors the RPC's JSON shape 1:1) ───────────────────────

export interface PeriodTotals {
  orders: number
  orderValue: number
  /** Distinct distributor buyers with at least one eligible order in the window. */
  activeDistributors: number
}

/** One distributor with both reporting windows plus its lifetime trading history. */
export interface DistributorAggregate {
  distributorId: string
  name: string
  orgCode: string | null
  isActive: boolean
  currentOrders: number
  currentValue: number
  previousOrders: number
  previousValue: number
  /**
   * First EVER eligible order for this distributor, across all history — not
   * the first order inside the report window. "New Distributor" is decided
   * from this and from nothing else.
   */
  firstOrderAt: string | null
  /** Most recent EVER eligible order, which drives recency and dormancy. */
  lastOrderAt: string | null
  /** Lifetime eligible order count, used to derive an ordering cadence. */
  lifetimeOrders: number
  /**
   * First / last business date (YYYY-MM-DD). `firstOrderAt` / `lastOrderAt`
   * are the instants those Malaysia days start, so recency arithmetic and the
   * period boundaries (also MYT midnights) compare like with like.
   */
  firstOrderDate?: string | null
  lastOrderDate?: string | null
}

export interface StatusTotals {
  status: string
  orders: number
  orderValue: number
}

export interface ProductTotals {
  variantId: string | null
  productId: string | null
  productName: string | null
  variantName: string | null
  productCode: string | null
  units: number
  orderValue: number
}

export interface OrderRecordTotals {
  orderId: string
  orderNo: string | null
  /** Business SO date (YYYY-MM-DD) — what the report displays and sorts on. */
  orderDate: string
  /** Actual system entry instant (audit), kept for reference. */
  createdAt: string
  status: string
  distributorId: string
  distributorName: string
  orderValue: number
  itemCount: number
}

export interface DistributorAnalyticsAggregate {
  month: string
  /** `all`, or the selected distributor `organizations.id`. */
  distributorId: string
  distributorName: string
  /** `all`, or the single selected order status. */
  status: string
  /** The column the source bucketed on; absent means the pre-order_date RPC. */
  dateField?: string
  current: PeriodTotals
  previous: PeriodTotals
  dailyTrend: { date: string; orders: number; orderValue: number }[]
  distributors: DistributorAggregate[]
  /** Status mix of the CURRENT window, for Order Processing Health. */
  statusBreakdown: StatusTotals[]
  topProducts: ProductTotals[]
  recentOrders: OrderRecordTotals[]
}

// ── Display DTO ────────────────────────────────────────────────────────────

export type HealthStatus =
  | 'growing'
  | 'stable'
  | 'declining'
  | 'inactive_period'
  | 'watch'
  | 'at_risk'
  | 'dormant'

export type ActionKey = 'grow' | 'maintain' | 're_engage' | 'review'
export type ActionPriority = 'HIGH' | 'MEDIUM' | 'NORMAL'
export type RelationshipStage = 'new' | 'returning' | 'inactive' | 'absent'

export interface DistributorRow {
  distributorId: string
  name: string
  currentOrders: number
  currentValue: number
  previousOrders: number
  previousValue: number
  /** Order-value movement in %. `null` when the comparison window had no baseline. */
  growthPct: number | null
  orderGrowthPct: number | null
  aov: number | null
  previousAov: number | null
  /** Share of the report period's Order Value. */
  sharePct: number | null
  /** Share of the comparison period's Order Value — drives key-account priority. */
  previousSharePct: number | null
  lastOrderAt: string | null
  firstOrderAt: string | null
  daysSinceLastOrder: number | null
  /** Mean days between lifetime orders, or `null` below `CADENCE_MIN_ORDERS`. */
  cadenceDays: number | null
  /** Days of silence at which THIS distributor is judged at risk. */
  riskThresholdDays: number
  stage: RelationshipStage
  isNew: boolean
  isReturning: boolean
  isInactiveThisPeriod: boolean
  health: HealthStatus
  action: ActionKey | null
  actionPriority: ActionPriority
  recommendation: string
}

export interface LeaderboardRow extends DistributorRow {
  rank: number
}

export interface ContributionBand {
  label: string
  distributors: number
  orderValue: number
  sharePct: number | null
}

export interface TopProductRow {
  rank: number
  variantId: string | null
  productName: string
  variantLabel: string
  /** "Cellera Hero / Banana Vanilla – BV" — the agreed product identity structure. */
  label: string
  units: number
  orderValue: number
  sharePct: number | null
}

export interface ComparisonRow {
  key: string
  label: string
  /** How the value should be rendered; the PDF and the web read the same flag. */
  format: 'count' | 'currency' | 'percent'
  current: number | null
  previous: number | null
  changePct: number | null
  /** Percentage-point movement, for `percent` rows where a % of a % is meaningless. */
  changePoints: number | null
}

export interface InsightCard {
  key: 'concentration' | 'new' | 'inactive' | 'returning' | 'at_risk'
  title: string
  value: string
  description: string
}

export interface DistributorScope {
  id: string
  name: string
  isAll: boolean
}

export interface StatusScope {
  id: string
  label: string
  isAll: boolean
}

export interface DistributorAnalyticsReport {
  period: DistributorReportPeriod
  distributor: DistributorScope
  status: StatusScope
  summary: {
    totalOrders: number
    orderValue: number
    avgOrderValue: number | null
    activeDistributors: number
    returningDistributors: number
    returningRatePct: number | null
    /** Distributors placing more than one order in the window — NOT retention. */
    multipleOrderDistributors: number
    multipleOrderRatePct: number | null
    approvalRatePct: number | null
    avgOrdersPerDay: number
    avgValuePerDay: number
  }
  comparison: ComparisonRow[]
  insights: InsightCard[]
  dailyTrend: { date: string; label: string; shortLabel: string; orders: number; orderValue: number }[]
  leaderboard: LeaderboardRow[]
  contribution: {
    totalOrderValue: number
    distributorCount: number
    bands: ContributionBand[]
    /** Top 20% of active distributors, and the share of Order Value they carry. */
    topQuintileCount: number
    topQuintileSharePct: number | null
    topNCount: number
    topNSharePct: number | null
  }
  topProducts: TopProductRow[]
  relationship: {
    newDistributors: number
    returningDistributors: number
    inactiveThisPeriod: number
    atRisk: number
    dormant: number
    rows: { key: RelationshipStage | 'at_risk'; label: string; description: string; count: number }[]
  }
  health: {
    rows: DistributorRow[]
    summary: { key: HealthStatus; label: string; count: number }[]
  }
  actionPlan: {
    summary: { key: ActionKey; label: string; description: string; count: number }[]
    rows: DistributorRow[]
  }
  orderProcessing: {
    total: number
    statuses: { status: string; label: string; orders: number; orderValue: number; sharePct: number | null }[]
    approvedOrders: number
    approvalRatePct: number | null
    completedOrders: number
    completionRatePct: number | null
    cancelledOrders: number
    cancellationRatePct: number | null
  }
  recentOrders: OrderRecordTotals[]
  meta: {
    orderType: string
    buyerOrgType: string
    statuses: string[]
    dateField: string
    orderValueField: string
    approvedStatuses: string[]
    completedStatuses: string[]
    watchDays: number
    atRiskDays: number
    dormantDays: number
    stableBandPct: number
  }
  isEmpty: boolean
}

// ── Arithmetic ─────────────────────────────────────────────────────────────

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Growth of `current` over `previous` in %.
 *
 * `null` when the comparison window carried no baseline. A distributor going
 * from nothing to RM400k is new activity, never "Infinity%" and never a
 * fabricated "+100%" — the previous report reported exactly that.
 */
export function growthPercent(current: number, previous: number): number | null {
  if (!(previous > 0)) return null
  return round1(((current - previous) / previous) * 100)
}

/** Whole days between two instants, or `null` when there is no reference point. */
export function daysBetween(from: string | null, to: string): number | null {
  if (!from) return null
  const start = new Date(from).getTime()
  const end = new Date(to).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return Math.max(0, Math.floor((end - start) / DAY_MS))
}

/**
 * Mean days between a distributor's lifetime orders.
 *
 * `null` below `CADENCE_MIN_ORDERS`, because two orders describe one gap and
 * one gap is not a rhythm. Derived from first/last/count rather than from the
 * full order history, so it costs nothing extra to carry.
 */
export function cadenceDays(
  firstOrderAt: string | null,
  lastOrderAt: string | null,
  lifetimeOrders: number,
): number | null {
  if (lifetimeOrders < CADENCE_MIN_ORDERS) return null
  const span = daysBetween(firstOrderAt, lastOrderAt ?? '')
  if (span === null || span <= 0) return null
  return round1(span / (lifetimeOrders - 1))
}

/**
 * The days of silence at which THIS distributor reads as at risk.
 *
 * Cadence-aware where a rhythm exists: twice its normal gap, bounded into
 * [`WATCH_DAYS`, `DORMANT_DAYS`] so a weekly buyer is not declared at risk
 * after a fortnight and a quarterly buyer is not excused indefinitely.
 * Without a rhythm it is the flat `AT_RISK_DAYS` threshold.
 */
export function riskThresholdDays(cadence: number | null): number {
  if (cadence === null || !(cadence > 0)) return AT_RISK_DAYS
  return Math.round(Math.min(DORMANT_DAYS, Math.max(WATCH_DAYS, cadence * 2)))
}

// ── Classification rules ───────────────────────────────────────────────────

/**
 * Where a distributor sits in the relationship, decided from lifetime history.
 *
 * new       — its FIRST EVER eligible order falls inside the report window. A
 *             distributor that traded in 2025, skipped last month and ordered
 *             again this month is Returning, never New. The previous report
 *             called that New, which is the defect this replaces.
 * returning — active in the report window with eligible trading BEFORE it.
 * inactive  — traded in the comparison window, silent in the report window.
 * absent    — in neither window.
 */
export function classifyStage(row: {
  currentOrders: number
  previousOrders: number
  firstOrderAt: string | null
  periodStartUtc: string
  periodEndUtc: string
}): RelationshipStage {
  if (row.currentOrders > 0) {
    // Instants compared numerically: PostgREST (+00:00) and the period window (Z) format differently.
    const first = row.firstOrderAt ? Date.parse(row.firstOrderAt) : NaN
    if (Number.isFinite(first) && first >= Date.parse(row.periodStartUtc) && first < Date.parse(row.periodEndUtc)) return 'new'
    return 'returning'
  }
  if (row.previousOrders > 0) return 'inactive'
  return 'absent'
}

/**
 * The single health status a distributor carries, first match wins.
 *
 * Recency is evaluated before trading movement, because a distributor that has
 * not ordered in six months is dormant whatever its last month looked like.
 * A distributor that ordered inside the report window cannot be dormant or at
 * risk: its last order is by definition recent.
 *
 * dormant         — silent for `DORMANT_DAYS` or more, or never traded.
 * at_risk         — silent beyond its own `riskThresholdDays`.
 * inactive_period — traded in the comparison window, nothing in this one.
 * watch           — nothing in EITHER window, but still ordering recently
 *                   enough not to be overdue: worth watching, not yet a lapse.
 * growing         — Order Value up more than `STABLE_BAND_PCT`, or trading
 *                   with no comparison baseline at all.
 * declining       — Order Value down more than `STABLE_BAND_PCT`.
 * stable          — everything else that traded.
 */
export function classifyHealth(row: {
  currentOrders: number
  previousOrders: number
  currentValue: number
  previousValue: number
  growthPct: number | null
  daysSinceLastOrder: number | null
  riskThresholdDays: number
}): HealthStatus {
  if (row.currentOrders <= 0) {
    const days = row.daysSinceLastOrder
    if (days === null || days >= DORMANT_DAYS) return 'dormant'
    if (days >= row.riskThresholdDays) return 'at_risk'
    // "Inactive This Period" is reserved for a distributor that actually traded
    // in the comparison window — it is a lost month, not merely a quiet one.
    if (row.previousOrders > 0) return 'inactive_period'
    return 'watch'
  }
  if (row.growthPct === null) return row.previousValue > 0 ? 'stable' : 'growing'
  if (row.growthPct > STABLE_BAND_PCT) return 'growing'
  if (row.growthPct < -STABLE_BAND_PCT) return 'declining'
  return 'stable'
}

/**
 * The one management action a distributor earns, first match wins.
 *
 * REVIEW      — at risk or dormant: the relationship needs a decision, not a
 *               nudge. Always HIGH.
 * RE-ENGAGE   — inactive this period, watch, or a real decline. HIGH when the
 *               decline is severe or the distributor carried at least
 *               `KEY_ACCOUNT_SHARE_PCT` of last period's Order Value.
 * GROW        — growing and trading.
 * MAINTAIN    — stable and trading.
 *
 * A distributor with no trading in either window and no recency signal earns
 * no action rather than padding the plan with noise.
 */
export function classifyAction(row: {
  health: HealthStatus
  growthPct: number | null
  previousSharePct: number | null
  currentOrders: number
}): { action: ActionKey | null; priority: ActionPriority; recommendation: string } {
  const keyAccount = (row.previousSharePct ?? 0) >= KEY_ACCOUNT_SHARE_PCT

  if (row.health === 'dormant' || row.health === 'at_risk') {
    return {
      action: 'review',
      priority: 'HIGH',
      recommendation: row.health === 'dormant'
        ? 'No eligible order for an extended period — confirm whether the account is still trading'
        : 'Overdue against its own ordering pattern — contact before the account lapses',
    }
  }
  if (row.health === 'inactive_period' || row.health === 'watch') {
    return {
      action: 're_engage',
      priority: keyAccount ? 'HIGH' : 'MEDIUM',
      recommendation: 'No order this period — re-engage and confirm the next sell-in',
    }
  }
  if (row.health === 'declining') {
    const severe = row.growthPct !== null && row.growthPct <= SEVERE_DECLINE_PCT
    return {
      action: 're_engage',
      priority: severe || keyAccount ? 'HIGH' : 'MEDIUM',
      recommendation: 'Order Value down against the comparison period — review the account with sales',
    }
  }
  if (row.health === 'growing' && row.currentOrders > 0) {
    return {
      action: 'grow',
      priority: 'NORMAL',
      recommendation: 'Growing — support with stock availability and keep the momentum',
    }
  }
  if (row.health === 'stable' && row.currentOrders > 0) {
    return {
      action: 'maintain',
      priority: 'NORMAL',
      recommendation: 'Trading steadily — hold the current plan',
    }
  }
  return { action: null, priority: 'NORMAL', recommendation: 'No action required this period' }
}

// ── Labels ─────────────────────────────────────────────────────────────────

export const HEALTH_LABEL: Record<HealthStatus, string> = {
  growing: 'Growing',
  stable: 'Stable',
  declining: 'Declining',
  inactive_period: 'Inactive This Period',
  watch: 'Watch',
  at_risk: 'At Risk',
  dormant: 'Dormant',
}

export const ACTION_LABEL: Record<ActionKey, string> = {
  grow: 'Grow / Support',
  maintain: 'Maintain',
  re_engage: 'Re-engage',
  review: 'At Risk / Review',
}

const ACTION_DESCRIPTION: Record<ActionKey, string> = {
  grow: 'Growing accounts worth supporting with availability',
  maintain: 'Trading steadily — hold the current plan',
  re_engage: 'No order this period, or a real decline to reverse',
  review: 'Overdue or dormant — the relationship needs a decision',
}

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  closed: 'Closed',
  cancelled: 'Cancelled',
  warehouse_packed: 'Warehouse Packed',
  shipped_distributor: 'Shipped',
}

export function statusLabel(status: string): string {
  return STATUS_LABEL[status]
    ?? status.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

/**
 * Trailing "[ … ]" flavour segment of a master-data variant name.
 *
 * Mirrors `product-analytics.ts`, which mirrors the Inventory rule. Re-derived
 * rather than imported across report modules so each report's DTO builder stays
 * self-contained inside the API route and the PDF generator.
 */
const BRACKETED_FLAVOUR = /\[([^[\]]*)\]\s*$/

export function variantFlavour(variantName?: string | null): string {
  const name = (variantName || '').trim()
  if (!name) return 'No variant'
  const match = name.match(BRACKETED_FLAVOUR)
  return (match ? match[1] : name).trim() || 'No variant'
}

/** "Cellera Hero / Banana Vanilla – BV" — never a raw variant UUID. */
export function productIdentityLabel(
  productName?: string | null,
  variantName?: string | null,
  productCode?: string | null,
): string {
  const product = (productName || '').trim()
  const flavour = variantFlavour(variantName)
  const hasFlavour = Boolean((variantName || '').trim())
  const code = (productCode || '').trim()
  const duplicate = product && hasFlavour && product.toLowerCase() === flavour.toLowerCase()

  let identity: string
  if (!product) identity = hasFlavour ? flavour : 'Unknown product'
  else if (!hasFlavour || duplicate) identity = product
  else identity = `${product} / ${flavour}`

  return code ? `${identity} – ${code}` : identity
}

// ── Empty aggregate ────────────────────────────────────────────────────────

export function emptyAggregate(
  month: string,
  period?: DistributorReportPeriod,
  distributorId: string = ALL_DISTRIBUTORS,
  distributorName: string = ALL_DISTRIBUTORS_LABEL,
  status: string = ALL_STATUS,
): DistributorAnalyticsAggregate {
  const resolved = period ?? resolveDistributorReportPeriod(month)
  const zero: PeriodTotals = { orders: 0, orderValue: 0, activeDistributors: 0 }
  return {
    month,
    distributorId,
    distributorName,
    status,
    current: { ...zero },
    previous: { ...zero },
    dailyTrend: Array.from({ length: resolved.dayCount }, (_, i) => ({
      date: `${month}-${String(i + 1).padStart(2, '0')}`,
      orders: 0,
      orderValue: 0,
    })),
    distributors: [],
    statusBreakdown: [],
    topProducts: [],
    recentOrders: [],
  }
}

// ── Aggregate → distributor rows ───────────────────────────────────────────

/**
 * Which distributor rows each headline metric counts. The report's counts and
 * the dashboard drill-down lists both filter `buildDistributorRows` with these
 * predicates, so a card's number and the list it opens cannot disagree.
 */
export const DISTRIBUTOR_METRIC_PREDICATES = {
  active: (row: DistributorRow) => row.currentOrders > 0,
  new: (row: DistributorRow) => row.isNew,
  returning: (row: DistributorRow) => row.isReturning,
  inactive: (row: DistributorRow) => row.isInactiveThisPeriod,
} as const

export type DistributorMetricKey = keyof typeof DISTRIBUTOR_METRIC_PREDICATES

/** Classify every distributor of the aggregate for the report window. */
export function buildDistributorRows(
  aggregate: DistributorAnalyticsAggregate,
  period: DistributorReportPeriod,
): DistributorRow[] {
  /**
   * Recency is measured to the end of the report window, not to wall-clock
   * "now". Re-opening August in December must not turn every distributor
   * dormant: a historical month is judged as it stood when it closed.
   */
  const asOf = period.asOf

  return aggregate.distributors.map((entry) => {
    const growthPct = growthPercent(entry.currentValue, entry.previousValue)
    const orderGrowthPct = growthPercent(entry.currentOrders, entry.previousOrders)
    const cadence = cadenceDays(entry.firstOrderAt, entry.lastOrderAt, entry.lifetimeOrders)
    const threshold = riskThresholdDays(cadence)
    const daysSinceLastOrder = daysBetween(entry.lastOrderAt, asOf)
    const sharePct = safeShare(entry.currentValue, aggregate.current.orderValue)
    const previousSharePct = safeShare(entry.previousValue, aggregate.previous.orderValue)

    const stage = classifyStage({
      currentOrders: entry.currentOrders,
      previousOrders: entry.previousOrders,
      firstOrderAt: entry.firstOrderAt,
      periodStartUtc: period.startUtc,
      periodEndUtc: period.endUtc,
    })

    const health = classifyHealth({
      currentOrders: entry.currentOrders,
      previousOrders: entry.previousOrders,
      currentValue: entry.currentValue,
      previousValue: entry.previousValue,
      growthPct,
      daysSinceLastOrder,
      riskThresholdDays: threshold,
    })

    const { action, priority, recommendation } = classifyAction({
      health,
      growthPct,
      previousSharePct,
      currentOrders: entry.currentOrders,
    })

    return {
      distributorId: entry.distributorId,
      name: (entry.name || '').trim() || 'Unknown distributor',
      currentOrders: entry.currentOrders,
      currentValue: round2(entry.currentValue),
      previousOrders: entry.previousOrders,
      previousValue: round2(entry.previousValue),
      growthPct,
      orderGrowthPct,
      aov: entry.currentOrders > 0 ? round2(entry.currentValue / entry.currentOrders) : null,
      previousAov: entry.previousOrders > 0 ? round2(entry.previousValue / entry.previousOrders) : null,
      sharePct,
      previousSharePct,
      lastOrderAt: entry.lastOrderAt,
      firstOrderAt: entry.firstOrderAt,
      daysSinceLastOrder,
      cadenceDays: cadence,
      riskThresholdDays: threshold,
      stage,
      isNew: stage === 'new',
      isReturning: stage === 'returning',
      isInactiveThisPeriod: entry.currentOrders === 0 && entry.previousOrders > 0,
      health,
      action,
      actionPriority: priority,
      recommendation,
    }
  })

}

// ── Aggregate → report ─────────────────────────────────────────────────────

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function buildDistributorAnalyticsReport(
  aggregate: DistributorAnalyticsAggregate,
  now: Date = new Date(),
): DistributorAnalyticsReport {
  const period = resolveDistributorReportPeriod(aggregate.month, now)
  const { dayCount } = period
  const distributorId = aggregate.distributorId || ALL_DISTRIBUTORS
  const isAllDistributors = distributorId === ALL_DISTRIBUTORS
  const distributor: DistributorScope = {
    id: distributorId,
    name: isAllDistributors ? ALL_DISTRIBUTORS_LABEL : (aggregate.distributorName || 'Unknown distributor'),
    isAll: isAllDistributors,
  }
  const statusId = aggregate.status || ALL_STATUS
  const status: StatusScope = {
    id: statusId,
    label: statusId === ALL_STATUS ? ALL_STATUS_LABEL : statusLabel(statusId),
    isAll: statusId === ALL_STATUS,
  }

  const totalOrders = aggregate.current.orders
  const totalValue = round2(aggregate.current.orderValue)
  const previousOrders = aggregate.previous.orders
  const previousValue = round2(aggregate.previous.orderValue)

  // ── Rows ────────────────────────────────────────────────────────────────
  const rows = buildDistributorRows(aggregate, period)

  const activeRows = rows.filter(DISTRIBUTOR_METRIC_PREDICATES.active)
  const activeDistributors = aggregate.current.activeDistributors || activeRows.length
  const newDistributors = rows.filter(DISTRIBUTOR_METRIC_PREDICATES.new).length
  const returningDistributors = rows.filter(DISTRIBUTOR_METRIC_PREDICATES.returning).length
  const inactiveThisPeriod = rows.filter(DISTRIBUTOR_METRIC_PREDICATES.inactive).length
  const atRisk = rows.filter((row) => row.health === 'at_risk').length
  const dormant = rows.filter((row) => row.health === 'dormant').length
  const multipleOrderDistributors = rows.filter((row) => row.currentOrders > 1).length

  const returningRatePct = safeShare(returningDistributors, activeDistributors)
  const previousActive = aggregate.previous.activeDistributors

  const avgOrderValue = totalOrders > 0 ? round2(totalValue / totalOrders) : null
  const previousAvgOrderValue = previousOrders > 0 ? round2(previousValue / previousOrders) : null

  // ── Order Processing Health ─────────────────────────────────────────────
  const statusRows = [...aggregate.statusBreakdown]
    .filter((row) => row.orders > 0)
    .sort((a, b) => b.orders - a.orders)
  const approvedOrders = aggregate.statusBreakdown
    .filter((row) => APPROVED_STATUSES.includes(row.status))
    .reduce((sum, row) => sum + row.orders, 0)
  const completedOrders = aggregate.statusBreakdown
    .filter((row) => COMPLETED_STATUSES.includes(row.status))
    .reduce((sum, row) => sum + row.orders, 0)
  const cancelledOrders = aggregate.statusBreakdown
    .filter((row) => row.status === 'cancelled')
    .reduce((sum, row) => sum + row.orders, 0)
  const approvalRatePct = safeShare(approvedOrders, totalOrders)

  // ── Leaderboard ─────────────────────────────────────────────────────────
  const leaderboard: LeaderboardRow[] = [...activeRows]
    .sort((a, b) => b.currentValue - a.currentValue || b.currentOrders - a.currentOrders)
    .slice(0, LEADERBOARD_LIMIT)
    .map((row, index) => ({ ...row, rank: index + 1 }))

  // ── Contribution / concentration ────────────────────────────────────────
  const valueRanked = [...activeRows].sort((a, b) => b.currentValue - a.currentValue)
  const bandTotal = (slice: DistributorRow[]) => round2(slice.reduce((sum, row) => sum + row.currentValue, 0))
  const topN = valueRanked.slice(0, CONCENTRATION_TOP_N)
  const nextFive = valueRanked.slice(CONCENTRATION_TOP_N, CONCENTRATION_TOP_N + 5)
  const remaining = valueRanked.slice(CONCENTRATION_TOP_N + 5)
  const bands: ContributionBand[] = [
    { label: `Top ${topN.length || CONCENTRATION_TOP_N}`, distributors: topN.length, orderValue: bandTotal(topN), sharePct: safeShare(bandTotal(topN), totalValue) },
    { label: `Next ${nextFive.length || 5}`, distributors: nextFive.length, orderValue: bandTotal(nextFive), sharePct: safeShare(bandTotal(nextFive), totalValue) },
    { label: 'Remaining', distributors: remaining.length, orderValue: bandTotal(remaining), sharePct: safeShare(bandTotal(remaining), totalValue) },
  ]
  const topQuintileCount = valueRanked.length > 0 ? Math.max(1, Math.ceil(valueRanked.length * 0.2)) : 0
  const topQuintile = valueRanked.slice(0, topQuintileCount)
  const topQuintileSharePct = safeShare(bandTotal(topQuintile), totalValue)
  const topNSharePct = safeShare(bandTotal(topN), totalValue)

  // ── Top products ────────────────────────────────────────────────────────
  const productValueTotal = aggregate.topProducts.reduce((sum, row) => sum + row.orderValue, 0)
  const topProducts: TopProductRow[] = [...aggregate.topProducts]
    .sort((a, b) => b.orderValue - a.orderValue || b.units - a.units)
    .map((row, index) => ({
      rank: index + 1,
      variantId: row.variantId,
      productName: (row.productName || '').trim() || 'Unknown product',
      variantLabel: variantFlavour(row.variantName),
      label: productIdentityLabel(row.productName, row.variantName, row.productCode),
      units: row.units,
      orderValue: round2(row.orderValue),
      // Share of the period's Order Value where the two agree, falling back to
      // the ranked population so a partial product aggregate cannot exceed 100%.
      sharePct: safeShare(row.orderValue, totalValue > 0 ? totalValue : productValueTotal),
    }))

  // ── Comparison table ────────────────────────────────────────────────────
  const ordersDelta = metricDelta(totalOrders, previousOrders)
  const valueDelta = metricDelta(totalValue, previousValue)
  const activeDelta = metricDelta(activeDistributors, previousActive)
  const aovDelta = metricDelta(avgOrderValue ?? 0, previousAvgOrderValue ?? 0)
  const previousReturningRate = safeShare(
    rows.filter((row) => row.previousOrders > 0 && row.firstOrderAt !== null
      && Date.parse(row.firstOrderAt) < Date.parse(period.comparisonStartUtc)).length,
    previousActive,
  )
  const returningDelta = rateDelta(returningRatePct, previousReturningRate)

  const comparison: ComparisonRow[] = [
    { key: 'totalOrders', label: 'Total Orders', format: 'count', current: totalOrders, previous: previousOrders, changePct: ordersDelta.changePct, changePoints: null },
    { key: 'orderValue', label: 'Order Value', format: 'currency', current: totalValue, previous: previousValue, changePct: valueDelta.changePct, changePoints: null },
    { key: 'avgOrderValue', label: 'Avg Order Value', format: 'currency', current: avgOrderValue, previous: previousAvgOrderValue, changePct: aovDelta.changePct, changePoints: null },
    { key: 'activeDistributors', label: 'Active Distributors', format: 'count', current: activeDistributors, previous: previousActive, changePct: activeDelta.changePct, changePoints: activeDistributors - previousActive },
    { key: 'returningRate', label: 'Returning Rate', format: 'percent', current: returningRatePct, previous: previousReturningRate, changePct: null, changePoints: returningDelta.changePoints },
  ]

  // ── Insights ────────────────────────────────────────────────────────────
  const insights: InsightCard[] = [
    {
      key: 'concentration',
      title: 'Distributor Concentration',
      value: topNSharePct === null ? '—' : `${topNSharePct.toFixed(0)}%`,
      description: topN.length === 0
        ? 'No distributor order activity to concentrate'
        : `Top ${topN.length} distributor${topN.length === 1 ? '' : 's'} carry ${topNSharePct === null ? '—' : `${topNSharePct.toFixed(0)}%`} of Order Value`
          + (topQuintileSharePct === null ? '' : ` · top 20% carry ${topQuintileSharePct.toFixed(0)}%`),
    },
    {
      key: 'new',
      title: 'New Distributors',
      value: String(newDistributors),
      description: 'First ever eligible distributor order falls inside this report period',
    },
    {
      key: 'inactive',
      title: 'Inactive This Period',
      value: String(inactiveThisPeriod),
      description: 'Ordered in the comparison period, no eligible order in this one',
    },
    {
      key: 'returning',
      title: 'Returning Distributors',
      value: String(returningDistributors),
      description: 'Active this period with eligible trading before it'
        + (returningRatePct === null ? '' : ` · ${returningRatePct.toFixed(0)}% of active`),
    },
    {
      key: 'at_risk',
      title: 'At Risk',
      value: String(atRisk + dormant),
      description: `${atRisk} overdue against their own ordering pattern, ${dormant} dormant for ${DORMANT_DAYS}+ days`,
    },
  ]

  // ── Relationship summary ────────────────────────────────────────────────
  const relationshipRows: { key: RelationshipStage | 'at_risk'; label: string; description: string; count: number }[] = [
    { key: 'new', label: 'New', description: 'First ever eligible order in this period', count: newDistributors },
    { key: 'returning', label: 'Returning', description: 'Active now, traded before this period', count: returningDistributors },
    { key: 'inactive', label: 'Inactive This Period', description: 'Active in the comparison period only', count: inactiveThisPeriod },
    { key: 'at_risk', label: 'At Risk', description: `Overdue against their pattern, or dormant ${DORMANT_DAYS}+ days`, count: atRisk + dormant },
  ]

  // ── Health table ────────────────────────────────────────────────────────
  const healthOrder: Record<HealthStatus, number> = {
    at_risk: 0, dormant: 1, inactive_period: 2, declining: 3, watch: 4, growing: 5, stable: 6,
  }
  const healthRows = [...rows]
    // Distributors that traded in neither window and carry no recency signal
    // are not a management concern; they would only pad the table.
    .filter((row) => row.currentOrders > 0 || row.previousOrders > 0 || row.action !== null)
    .sort((a, b) => healthOrder[a.health] - healthOrder[b.health]
      || b.currentValue - a.currentValue
      || b.previousValue - a.previousValue)
    .slice(0, HEALTH_ROWS_LIMIT)

  const healthKeys: HealthStatus[] = ['growing', 'stable', 'declining', 'inactive_period', 'watch', 'at_risk', 'dormant']
  const healthSummary = healthKeys.map((key) => ({
    key,
    label: HEALTH_LABEL[key],
    count: rows.filter((row) => row.health === key).length,
  }))

  // ── Action plan ─────────────────────────────────────────────────────────
  const priorityOrder: Record<ActionPriority, number> = { HIGH: 0, MEDIUM: 1, NORMAL: 2 }
  const actionRows = rows
    .filter((row) => row.action !== null)
    .sort((a, b) => priorityOrder[a.actionPriority] - priorityOrder[b.actionPriority]
      || Math.max(b.currentValue, b.previousValue) - Math.max(a.currentValue, a.previousValue))

  const actionKeys: ActionKey[] = ['grow', 'maintain', 're_engage', 'review']
  const actionSummary = actionKeys.map((key) => ({
    key,
    label: ACTION_LABEL[key],
    description: ACTION_DESCRIPTION[key],
    // Counted over every classified row, and `rows` below carries them all, so
    // a card's number always equals the list it opens.
    count: actionRows.filter((row) => row.action === key).length,
  }))

  // Chart axis labels: "3 Sep" full, "3" compact for narrow mobile axes.
  const dayLabel = (date: string) => {
    const [, monthNo, day] = date.split('-')
    return { full: `${Number(day)} ${MONTH_ABBR[Number(monthNo) - 1]}`, short: String(Number(day)) }
  }

  return {
    period,
    distributor,
    status,
    summary: {
      totalOrders,
      orderValue: totalValue,
      avgOrderValue,
      activeDistributors,
      returningDistributors,
      returningRatePct,
      multipleOrderDistributors,
      multipleOrderRatePct: safeShare(multipleOrderDistributors, activeDistributors),
      approvalRatePct,
      avgOrdersPerDay: dayCount > 0 ? round1(totalOrders / dayCount) : 0,
      avgValuePerDay: dayCount > 0 ? round2(totalValue / dayCount) : 0,
    },
    comparison,
    insights,
    dailyTrend: aggregate.dailyTrend.map((row) => {
      const { full, short } = dayLabel(row.date)
      return {
        date: row.date,
        label: full,
        shortLabel: short,
        orders: row.orders,
        orderValue: round2(row.orderValue),
      }
    }),
    leaderboard,
    contribution: {
      totalOrderValue: totalValue,
      distributorCount: valueRanked.length,
      bands,
      topQuintileCount,
      topQuintileSharePct,
      topNCount: topN.length,
      topNSharePct,
    },
    topProducts,
    relationship: {
      newDistributors,
      returningDistributors,
      inactiveThisPeriod,
      atRisk,
      dormant,
      rows: relationshipRows,
    },
    health: { rows: healthRows, summary: healthSummary },
    actionPlan: { summary: actionSummary, rows: actionRows.slice(0, ACTION_ROWS_LIMIT) },
    orderProcessing: {
      total: totalOrders,
      statuses: statusRows.map((row) => ({
        status: row.status,
        label: statusLabel(row.status),
        orders: row.orders,
        orderValue: round2(row.orderValue),
        sharePct: safeShare(row.orders, totalOrders),
      })),
      approvedOrders,
      approvalRatePct,
      completedOrders,
      completionRatePct: safeShare(completedOrders, totalOrders),
      cancelledOrders,
      cancellationRatePct: safeShare(cancelledOrders, totalOrders),
    },
    recentOrders: aggregate.recentOrders.slice(0, RECENT_ORDERS_LIMIT),
    meta: {
      orderType: ELIGIBLE_ORDER_TYPE,
      buyerOrgType: DISTRIBUTOR_ORG_TYPE,
      statuses: statusId === ALL_STATUS ? [...ORDER_STATUSES] : [statusId],
      dateField: aggregate.dateField ?? REPORT_DATE_FIELD,
      orderValueField: ORDER_VALUE_FIELD,
      approvedStatuses: APPROVED_STATUSES,
      completedStatuses: COMPLETED_STATUSES,
      watchDays: WATCH_DAYS,
      atRiskDays: AT_RISK_DAYS,
      dormantDays: DORMANT_DAYS,
      stableBandPct: STABLE_BAND_PCT,
    },
    isEmpty: totalOrders === 0 && totalValue === 0,
  }
}

/**
 * Filename-safe form of a distributor name: "Infy Tech Distribution" →
 * "Infy_Tech_Distribution". Anything that is not a letter or digit collapses
 * to a single underscore, so a name carrying "/" cannot produce a path
 * separator.
 */
export function distributorFilenameSegment(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/**
 * `Serapod_Distributor_Report_2026-09_MTD.pdf` for all distributors,
 * `Serapod_Distributor_Report_2026-08.pdf` for a closed month, and
 * `Serapod_Distributor_Infy_Tech_Distribution_2026-09_MTD.pdf` for one
 * distributor.
 */
export function distributorReportFilename(
  period: DistributorReportPeriod,
  distributor?: DistributorScope,
  extension = 'pdf',
): string {
  const suffix = period.isCurrentMonth ? '_MTD' : ''
  if (distributor && !distributor.isAll) {
    const segment = distributorFilenameSegment(distributor.name) || 'Distributor'
    return `Serapod_Distributor_${segment}_${period.month}${suffix}.${extension}`
  }
  return `Serapod_Distributor_Report_${period.month}${suffix}.${extension}`
}
