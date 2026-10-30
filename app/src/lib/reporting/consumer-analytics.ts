/**
 * Consumer Analytics — monthly management report.
 *
 * Shared by the reporting API route (server) and ConsumerAnalyticsTab (client).
 * Everything here is pure: the aggregate arrives either from the
 * `reporting_consumer_analytics` RPC or from the route's bounded fallback, and
 * this module turns it into the display DTO.
 *
 * Reporting timezone is Asia/Kuala_Lumpur. Malaysia has observed a fixed +08:00
 * offset with no DST since 1982, and `reporting-period.ts` already builds its
 * month boundaries from literal `+08:00`, so a fixed offset is used here too.
 */

import { currentReportingPeriodKey, reportingPeriodFromKey, REPORTING_TIME_ZONE } from './reporting-period'

export { REPORTING_TIME_ZONE }
/** Current calendar month in Asia/Kuala_Lumpur — the default reporting month. */
export { currentReportingPeriodKey as currentReportingMonthKey }

export const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000

/** Months of history the report covers: the selected month plus 11 before it. */
export const TREND_MONTHS = 12
/** Rows in the retention cohort table: the selected month plus 5 before it. */
export const COHORT_MONTHS = 6
export const TOP_CONSUMERS_LIMIT = 15
export const TOP_PRODUCTS_LIMIT = 10

// ── Raw aggregate (mirrors the RPC's JSON shape 1:1) ───────────────────────

export interface MonthTotals {
  totalScans: number
  identifiedScans: number
  identifiedConsumers: number
}

export interface ConsumerAnalyticsAggregate {
  month: string
  daysInMonth: number
  current: MonthTotals
  previous: MonthTotals
  returningCurrent: number
  returningPrevious: number
  dailyTrend: { date: string; scans: number; consumers: number }[]
  twelveMonthTrend: { month: string; scans: number; consumers: number }[]
  activityHeatmap: { dayOfWeek: number; hour: number; scans: number }[]
  cohort: { month: string; consumers: number; retained: number }[]
  topConsumers: {
    consumerId: string
    scans: number
    lastScan: string | null
    name: string | null
    phone: string | null
  }[]
  topProducts: {
    productId: string | null
    variantId: string | null
    productName: string | null
    variantName: string | null
    scans: number
  }[]
}

// ── Display DTO ────────────────────────────────────────────────────────────

/** Count metric compared against the immediately preceding calendar month. */
export interface MetricDelta {
  current: number
  previous: number
  /** Relative movement in %. `null` when the previous month has no base — never report 0% growth from nothing. */
  changePct: number | null
}

/** Rate metric compared against the immediately preceding calendar month. */
export interface RateDelta {
  current: number | null
  previous: number | null
  /** Movement in percentage points. `null` when either side is unknown. */
  changePoints: number | null
}

export interface ConsumerAnalyticsReport {
  period: {
    month: string
    label: string
    monthStartUtc: string
    monthEndUtc: string
    daysInMonth: number
    previousMonth: string
    previousMonthLabel: string
    /** Short form used in KPI captions, e.g. "Aug 2026". */
    previousMonthShortLabel: string
    timeZone: string
  }
  summary: {
    totalScans: number
    avgScansPerDay: number
    identifiedConsumers: number
    identifiedScans: number
    /** Share of scans in the month that carry a stable consumer_id. */
    identityCoveragePct: number | null
    repeatConsumers: number
    /** Repeat consumers as a share of identified consumers this month. */
    repeatSharePct: number | null
    newConsumers: number
    /** Previous month's identified consumers who scanned again in this month. */
    retentionRate: number | null
  }
  comparison: {
    totalScans: MetricDelta
    identifiedConsumers: MetricDelta
    repeatConsumers: MetricDelta
    retentionRate: RateDelta
  }
  dailyTrend: { date: string; label: string; scans: number; consumers: number }[]
  newVsReturning: {
    identifiedConsumers: number
    newConsumers: number
    newPct: number | null
    returningConsumers: number
    returningPct: number | null
  }
  twelveMonthTrend: { month: string; label: string; fullLabel: string; scans: number; consumers: number }[]
  activityHeatmap: { dayOfWeek: number; hour: number; scans: number }[]
  heatmapMax: number
  retentionCohort: {
    month: string
    label: string
    consumers: number
    retained: number | null
    retentionRate: number | null
    /** True for the selected month, whose following month is not in scope yet. */
    pending: boolean
  }[]
  topConsumers: {
    rank: number
    consumerId: string
    name: string
    phone: string
    scans: number
    lastScan: string | null
    frequency: 'High' | 'Medium' | 'Low'
  }[]
  topProducts: {
    rank: number
    productId: string | null
    variantId: string | null
    productName: string
    variantName: string | null
    label: string
    scans: number
    sharePct: number | null
  }[]
  isEmpty: boolean
}

// ── Month helpers (Asia/Kuala_Lumpur) ──────────────────────────────────────

export function isValidMonthKey(month: string | null | undefined): month is string {
  return typeof month === 'string' && MONTH_KEY_PATTERN.test(month)
}

/** Shift a `YYYY-MM` key by whole months; handles year boundaries in both directions. */
export function shiftMonthKey(month: string, offset: number): string {
  const [year, monthNo] = month.split('-').map(Number)
  const zeroBased = year * 12 + (monthNo - 1) + offset
  const nextYear = Math.floor(zeroBased / 12)
  const nextMonth = zeroBased - nextYear * 12 + 1
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}`
}

/** The calendar month immediately preceding `month` — never "previous 30 days". */
export function previousMonthKey(month: string): string {
  return shiftMonthKey(month, -1)
}

export function monthKeyRange(endMonth: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => shiftMonthKey(endMonth, i - (count - 1)))
}

export function daysInMonthKey(month: string): number {
  const [year, monthNo] = month.split('-').map(Number)
  return new Date(Date.UTC(year, monthNo, 0)).getUTCDate()
}

/** Half-open UTC window for a reporting month: `[start, nextMonthStart)` in MYT. */
export function monthWindowUtc(month: string): { startUtc: string; endUtc: string } {
  const period = reportingPeriodFromKey(month)
  if (!period) throw new Error(`Invalid reporting month: ${month}`)
  return { startUtc: period.startUtc, endUtc: period.endUtc }
}

export function monthLabel(month: string): string {
  return reportingPeriodFromKey(month)?.label ?? month
}

export function monthShortLabel(month: string): string {
  const [year, monthNo] = month.split('-').map(Number)
  return `${new Intl.DateTimeFormat('en-MY', { month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, monthNo - 1, 15)))} ${year}`
}

/** MYT calendar parts of an instant, used for day/hour bucketing. */
export function mytParts(timestamp: string): { date: string; month: string; dayOfWeek: number; hour: number } {
  const shifted = new Date(new Date(timestamp).getTime() + MYT_OFFSET_MS)
  const iso = shifted.toISOString()
  return {
    date: iso.slice(0, 10),
    month: iso.slice(0, 7),
    dayOfWeek: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
  }
}

// ── Safe arithmetic ────────────────────────────────────────────────────────

/** Percentage share, or `null` when the denominator carries no information. */
export function safeShare(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null
  return round1((numerator / denominator) * 100)
}

export function metricDelta(current: number, previous: number): MetricDelta {
  return {
    current,
    previous,
    changePct: previous > 0 ? round1(((current - previous) / previous) * 100) : null,
  }
}

export function rateDelta(current: number | null, previous: number | null): RateDelta {
  return {
    current,
    previous,
    changePoints: current === null || previous === null ? null : round1(current - previous),
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function frequencyBand(scans: number): 'High' | 'Medium' | 'Low' {
  if (scans > 10) return 'High'
  if (scans > 3) return 'Medium'
  return 'Low'
}

// ── Aggregate → report ─────────────────────────────────────────────────────

export function emptyAggregate(month: string): ConsumerAnalyticsAggregate {
  const zero: MonthTotals = { totalScans: 0, identifiedScans: 0, identifiedConsumers: 0 }
  const days = daysInMonthKey(month)
  return {
    month,
    daysInMonth: days,
    current: { ...zero },
    previous: { ...zero },
    returningCurrent: 0,
    returningPrevious: 0,
    dailyTrend: Array.from({ length: days }, (_, i) => ({
      date: `${month}-${String(i + 1).padStart(2, '0')}`,
      scans: 0,
      consumers: 0,
    })),
    twelveMonthTrend: monthKeyRange(month, TREND_MONTHS).map((m) => ({ month: m, scans: 0, consumers: 0 })),
    activityHeatmap: [],
    cohort: monthKeyRange(month, COHORT_MONTHS).map((m) => ({ month: m, consumers: 0, retained: 0 })),
    topConsumers: [],
    topProducts: [],
  }
}

export function buildConsumerAnalyticsReport(aggregate: ConsumerAnalyticsAggregate): ConsumerAnalyticsReport {
  const month = aggregate.month
  const previous = previousMonthKey(month)
  const { startUtc, endUtc } = monthWindowUtc(month)
  const daysInMonth = aggregate.daysInMonth || daysInMonthKey(month)

  const cohortByMonth = new Map(aggregate.cohort.map((row) => [row.month, row]))
  const retentionFor = (cohortMonth: string): number | null => {
    const row = cohortByMonth.get(cohortMonth)
    if (!row) return null
    return safeShare(row.retained, row.consumers)
  }

  // Retention *into* the selected month is the cohort outcome of the month
  // before it: of the consumers identified in that month, how many scanned
  // again in the selected month.
  const retentionRate = retentionFor(previous)
  const previousRetentionRate = retentionFor(shiftMonthKey(month, -2))

  const identified = aggregate.current.identifiedConsumers
  const repeatConsumers = aggregate.returningCurrent
  const newConsumers = Math.max(identified - repeatConsumers, 0)

  const dayFormatter = new Intl.DateTimeFormat('en-MY', { day: 'numeric', month: 'short', timeZone: 'UTC' })

  const heatmapMax = aggregate.activityHeatmap.reduce((max, cell) => Math.max(max, cell.scans), 0)

  return {
    period: {
      month,
      label: monthLabel(month),
      monthStartUtc: startUtc,
      monthEndUtc: endUtc,
      daysInMonth,
      previousMonth: previous,
      previousMonthLabel: monthLabel(previous),
      previousMonthShortLabel: monthShortLabel(previous),
      timeZone: REPORTING_TIME_ZONE,
    },
    summary: {
      totalScans: aggregate.current.totalScans,
      avgScansPerDay: daysInMonth > 0 ? Math.round(aggregate.current.totalScans / daysInMonth) : 0,
      identifiedConsumers: identified,
      identifiedScans: aggregate.current.identifiedScans,
      identityCoveragePct: safeShare(aggregate.current.identifiedScans, aggregate.current.totalScans),
      repeatConsumers,
      repeatSharePct: safeShare(repeatConsumers, identified),
      newConsumers,
      retentionRate,
    },
    comparison: {
      totalScans: metricDelta(aggregate.current.totalScans, aggregate.previous.totalScans),
      identifiedConsumers: metricDelta(identified, aggregate.previous.identifiedConsumers),
      repeatConsumers: metricDelta(repeatConsumers, aggregate.returningPrevious),
      retentionRate: rateDelta(retentionRate, previousRetentionRate),
    },
    dailyTrend: aggregate.dailyTrend.map((row) => ({
      ...row,
      label: dayFormatter.format(new Date(`${row.date}T00:00:00Z`)),
    })),
    newVsReturning: {
      identifiedConsumers: identified,
      newConsumers,
      newPct: safeShare(newConsumers, identified),
      returningConsumers: repeatConsumers,
      returningPct: safeShare(repeatConsumers, identified),
    },
    twelveMonthTrend: aggregate.twelveMonthTrend.map((row) => ({
      ...row,
      label: monthShortLabel(row.month).split(' ')[0],
      fullLabel: monthShortLabel(row.month),
    })),
    activityHeatmap: aggregate.activityHeatmap,
    heatmapMax,
    retentionCohort: aggregate.cohort.map((row) => {
      const pending = row.month === month
      return {
        month: row.month,
        label: monthShortLabel(row.month),
        consumers: row.consumers,
        retained: pending ? null : row.retained,
        retentionRate: pending ? null : safeShare(row.retained, row.consumers),
        pending,
      }
    }),
    topConsumers: aggregate.topConsumers.slice(0, TOP_CONSUMERS_LIMIT).map((row, index) => ({
      rank: index + 1,
      consumerId: row.consumerId,
      name: row.name?.trim() || 'Unnamed consumer',
      phone: row.phone?.trim() || '-',
      scans: row.scans,
      lastScan: row.lastScan,
      frequency: frequencyBand(row.scans),
    })),
    topProducts: aggregate.topProducts.slice(0, TOP_PRODUCTS_LIMIT).map((row, index) => {
      const productName = row.productName?.trim() || 'Unknown product'
      const variantName = row.variantName?.trim() || null
      return {
        rank: index + 1,
        productId: row.productId,
        variantId: row.variantId,
        productName,
        variantName,
        label: variantName ? `${productName} — ${variantName}` : productName,
        scans: row.scans,
        sharePct: safeShare(row.scans, aggregate.current.totalScans),
      }
    }),
    isEmpty: aggregate.current.totalScans === 0,
  }
}

/**
 * Month options for the Reporting Month dropdown, newest first.
 *
 * The supported range runs from the earliest month the report has records
 * for up to the current Malaysia month, and EVERY calendar month inside it is
 * offered — a month with no transactions is a valid (empty) report, not a gap
 * that previous/next navigation silently jumps over. The current month is
 * always offered so entering the tab on the 1st of a month is not a dead end,
 * and nothing beyond it is ever generated.
 */
export function buildReportingMonthOptions(
  availableMonths: string[],
  currentMonth: string = currentReportingPeriodKey(),
): { value: string; label: string }[] {
  let earliest = currentMonth
  for (const month of availableMonths) {
    if (isValidMonthKey(month) && month < earliest) earliest = month
  }
  const options: { value: string; label: string }[] = []
  for (let month = currentMonth; month >= earliest; month = previousMonthKey(month)) {
    options.push({ value: month, label: monthLabel(month) })
  }
  return options
}

/**
 * The months either side of `month` within newest-first `options`: `older` for
 * the ← button and `newer` for →. Undefined at the ends of the supported range.
 */
export function adjacentReportingMonths(
  options: readonly { value: string }[],
  month: string,
): { older?: string; newer?: string } {
  const index = options.findIndex((option) => option.value === month)
  if (index < 0) return {}
  return { older: options[index + 1]?.value, newer: index > 0 ? options[index - 1].value : undefined }
}

/**
 * A `?month=` value accepted from a URL: a well-formed `YYYY-MM` that is not in
 * the future (Malaysia time). Anything else is null so the caller can fall back
 * to the current month explicitly rather than reporting on a bad key.
 */
export function parseReportingMonthParam(
  value: string | null | undefined,
  currentMonth: string = currentReportingPeriodKey(),
): string | null {
  return isValidMonthKey(value) && value <= currentMonth ? value : null
}
