/**
 * Commission cycle arithmetic (Asia/Kuala_Lumpur, UTC+8 with no daylight saving).
 *
 * Mirrors hr_commission_cycle_bounds() and hr_commission_period_for() in 20261102110000_hr_commission_core.sql
 * (cycle.test.ts keeps the documented examples identical). Persisted cycles in hr_commission_cycles are authoritative;
 * these helpers only label, preview and validate.
 *
 *   start day 28 (default): the October cycle is [28 Sep 00:00 MYT, 28 Oct 00:00 MYT) — i.e. 28 Sep to 27 Oct inclusive.
 *   start day 1: the calendar month.
 *
 * Isomorphic and pure.
 */

export const COMMISSION_TIMEZONE = 'Asia/Kuala_Lumpur'
export const DEFAULT_START_DAY = 28
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000

/** First instant (UTC) of a Malaysia calendar day. */
function mytMidnight(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day) - MYT_OFFSET_MS)
}

/** 'YYYY-MM-01' → { year, monthIndex }. */
function parseMonth(periodMonth: string): { year: number; monthIndex: number } {
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(periodMonth)
  if (!m) throw new Error(`Invalid period month: ${periodMonth}`)
  return { year: Number(m[1]), monthIndex: Number(m[2]) - 1 }
}

export function cycleBounds(periodMonth: string, startDay: number = DEFAULT_START_DAY): { startAt: Date; endAt: Date } {
  if (!Number.isInteger(startDay) || startDay < 1 || startDay > 28) throw new Error('Start day must be 1–28')
  const { year, monthIndex } = parseMonth(periodMonth)
  if (startDay === 1) {
    return { startAt: mytMidnight(year, monthIndex, 1), endAt: mytMidnight(year, monthIndex + 1, 1) }
  }
  return { startAt: mytMidnight(year, monthIndex - 1, startDay), endAt: mytMidnight(year, monthIndex, startDay) }
}

/** Malaysia calendar date parts of an instant. */
export function malaysiaDateParts(at: Date): { year: number; monthIndex: number; day: number } {
  const local = new Date(at.getTime() + MYT_OFFSET_MS)
  return { year: local.getUTCFullYear(), monthIndex: local.getUTCMonth(), day: local.getUTCDate() }
}

const monthKey = (year: number, monthIndex: number) => {
  const d = new Date(Date.UTC(year, monthIndex, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
}

/** The period month ('YYYY-MM-01') an approval instant belongs to. */
export function periodFor(at: Date, startDay: number = DEFAULT_START_DAY): string {
  const { year, monthIndex, day } = malaysiaDateParts(at)
  if (startDay > 1 && day >= startDay) return monthKey(year, monthIndex + 1)
  return monthKey(year, monthIndex)
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function cycleLabel(periodMonth: string, format = '{month} {year} Commission Cycle'): string {
  const { year, monthIndex } = parseMonth(periodMonth)
  return format.replace('{month}', MONTHS[monthIndex]).replace('{year}', String(year))
}

/** "28 Sep 2026 – 27 Oct 2026" (inclusive end shown, exclusive end stored). */
export function cycleRangeLabel(startAt: string | Date, endAt: string | Date): string {
  const fmt = (d: Date) => {
    const p = malaysiaDateParts(d)
    return `${p.day} ${MONTHS[p.monthIndex].slice(0, 3)} ${p.year}`
  }
  const end = new Date(new Date(endAt).getTime() - 1)
  return `${fmt(new Date(startAt))} – ${fmt(end)}`
}

export const CYCLE_STATUSES = ['open', 'calculated', 'under_review', 'approved', 'locked', 'payroll_ready'] as const
export type CycleStatus = (typeof CYCLE_STATUSES)[number]

export const CYCLE_STATUS_LABEL: Record<CycleStatus, string> = {
  open: 'Open',
  calculated: 'Calculated',
  under_review: 'Under Review',
  approved: 'Approved',
  locked: 'Locked',
  payroll_ready: 'Payroll Ready',
}

export const isFinalStatus = (s: string) => s === 'approved' || s === 'locked' || s === 'payroll_ready'

/** Commission on a base: half away from zero to 2 dp on the exact product (as PostgreSQL round(numeric, 2)). */
export function commissionAmount(base: number | string, ratePercent: number | string): number {
  // Work in integer hundred-thousandths of a percent and cents to avoid binary drift.
  const cents = Math.round(Number(base) * 100)
  const rate = Math.round(Number(ratePercent) * 100000) // percent × 1e5
  const raw = BigInt(cents) * BigInt(rate) // cents × percent × 1e5
  const divisor = BigInt(100 * 100000) // /100 (percent) /1e5
  const negative = raw < BigInt(0)
  const abs = negative ? -raw : raw
  let q = abs / divisor
  if ((abs % divisor) * BigInt(2) >= divisor) q += BigInt(1)
  const value = Number(q) / 100
  return negative ? -value : value
}
