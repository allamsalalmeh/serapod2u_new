// Posting dates are calendar dates in the company's time zone (Malaysia), never UTC.
// A document is posted on its own date by default, so a payment made in October
// lands in October even when it is posted in November.

export const FINANCE_TIME_ZONE = 'Asia/Kuala_Lumpur'

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

const financeDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: FINANCE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** True when the value is a real calendar date written as YYYY-MM-DD. */
export function isValidPostingDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = DATE_ONLY.exec(value)
  if (!match) return false
  const [, y, m, d] = match.map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/** The Malaysian calendar date (YYYY-MM-DD) of a timestamp, date or date string. */
export function toFinanceDate(value: string | Date | null | undefined): string | null {
  if (!value) return null
  if (typeof value === 'string' && isValidPostingDate(value)) return value
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return financeDateFormat.format(date)
}

/** Today's date in Malaysia. */
export function financeToday(now: Date = new Date()): string {
  return financeDateFormat.format(now)
}

/**
 * The default posting date for a document: its own date in Malaysia time,
 * or today when the document has no usable date or is dated in the future.
 */
export function defaultPostingDate(
  documentDate: string | Date | null | undefined,
  now: Date = new Date(),
): string {
  const today = financeToday(now)
  const docDate = toFinanceDate(documentDate)
  if (!docDate || docDate > today) return today
  return docDate
}
