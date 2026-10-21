/**
 * Order Month filter for Supply Chain → Orders.
 *
 * The month is a calendar month of the order's business date
 * (`orders.order_date`, a Malaysia DATE — see ./order-date). Because it is a
 * DATE and not an instant, a month is the half-open key range
 * `[YYYY-MM-01, next YYYY-MM-01)`: no time zone conversion happens, so a
 * backdated order or one created at 00:30 MYT on the 1st can never slip into
 * the neighbouring month.
 *
 * `all` is the default and means "no month condition" — the list keeps its
 * pre-existing behaviour. The month list and arrows reuse the Executive
 * Dashboard Reporting Month helpers so both pages walk months the same way.
 */

import { isValidMonthKey, parseReportingMonthParam, shiftMonthKey } from '@/lib/reporting/consumer-analytics'
import { businessDateStartUtc, malaysiaDateOf } from './order-date'

export const ALL_ORDER_MONTHS = 'all'
export const ALL_ORDER_MONTHS_LABEL = 'All Months'
/** URL search parameter holding the selected Order Month. */
export const ORDER_MONTH_PARAM = 'month'

export type OrderMonth = typeof ALL_ORDER_MONTHS | string

/**
 * The Order Month a `?month=` value selects. Only a well-formed `YYYY-MM` that
 * is not after the current Malaysia month is accepted; a missing, malformed or
 * future value fails safe to All Months.
 */
export function parseOrderMonthParam(value: string | null | undefined, currentMonth?: string): OrderMonth {
  return parseReportingMonthParam(value, currentMonth) ?? ALL_ORDER_MONTHS
}

/** Half-open business-date range for a month: `order_date >= from AND order_date < toExclusive`. */
export function orderMonthDateRange(month: string): { from: string; toExclusive: string } {
  if (!isValidMonthKey(month)) throw new Error(`Invalid order month: ${month}`)
  return { from: `${month}-01`, toExclusive: `${shiftMonthKey(month, 1)}-01` }
}

/**
 * The same month as a `created_at` instant window (00:00 MYT boundaries), for a
 * database that predates the order_date column — whose migration backfilled
 * order_date from exactly this MYT date of created_at.
 */
export function orderMonthCreatedAtRange(month: string): { fromUtc: string; toExclusiveUtc: string } {
  const { from, toExclusive } = orderMonthDateRange(month)
  return { fromUtc: businessDateStartUtc(from), toExclusiveUtc: businessDateStartUtc(toExclusive) }
}

interface RangeFilterable<Q> {
  gte(column: string, value: string): Q
  lt(column: string, value: string): Q
}

/**
 * Apply the Order Month to an `orders` query before it is limited/paginated.
 * `all` leaves the query untouched.
 */
export function applyOrderMonthFilter<Q extends RangeFilterable<Q>>(
  query: Q,
  month: OrderMonth,
  options: { useCreatedAt?: boolean } = {},
): Q {
  if (month === ALL_ORDER_MONTHS || !isValidMonthKey(month)) return query
  if (options.useCreatedAt) {
    const { fromUtc, toExclusiveUtc } = orderMonthCreatedAtRange(month)
    return query.gte('created_at', fromUtc).lt('created_at', toExclusiveUtc)
  }
  const { from, toExclusive } = orderMonthDateRange(month)
  return query.gte('order_date', from).lt('order_date', toExclusive)
}

/** `YYYY-MM` of an order's earliest business date row, for the month dropdown's lower bound. */
export function orderMonthOf(row: { order_date?: string | null; created_at?: string | null } | null | undefined): string | null {
  if (!row) return null
  const date = typeof row.order_date === 'string' ? row.order_date.slice(0, 10) : row.created_at ? malaysiaDateOf(row.created_at) : null
  const month = date?.slice(0, 7) ?? null
  return isValidMonthKey(month) ? month : null
}

/**
 * The URL for a new Order Month on the current location: `all` removes the
 * parameter (a fresh entry and All Months share one URL), a month sets it, and
 * every other parameter is kept.
 */
export function orderMonthHref(pathname: string, search: string, month: OrderMonth): string {
  const params = new URLSearchParams(search)
  if (month === ALL_ORDER_MONTHS) params.delete(ORDER_MONTH_PARAM)
  else params.set(ORDER_MONTH_PARAM, month)
  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}
