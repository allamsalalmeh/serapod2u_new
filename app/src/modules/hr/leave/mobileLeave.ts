/**
 * HR mobile leave — pure helpers for the mobile ESS/MSS leave screen (Wave 1 closure, 2026-10-25).
 *
 * Fixes two defects found while verifying mobile leave against the live constraint set:
 *  1. Half-day requests were sent with `is_half_day = true` but no `half_day_period`; the table constraint
 *     `hr_leave_requests_half_day_chk` refuses that, so every mobile half-day request failed. A half day is now a
 *     single date with an explicit morning/afternoon period.
 *  2. A decision was reported as saved when any row came back; it is now reported only when the STORED status equals
 *     the requested decision (same rule as the web screen, `HrLeaveRequestsView`).
 */
import { assertLeaveRowsChanged } from './leaveErrors'

export type HalfDayPeriod = 'morning' | 'afternoon'

export interface MobileLeaveForm {
  leaveTypeId: string
  startDate: string // yyyy-mm-dd
  endDate: string // yyyy-mm-dd
  halfDay: boolean
  halfDayPeriod: HalfDayPeriod | ''
  reason: string
}

export interface MobileLeaveInsert {
  employee_id: string
  organization_id: string
  leave_type_id: string
  start_date: string
  end_date: string
  total_days: number
  is_half_day: boolean
  half_day_period: HalfDayPeriod | null
  reason: string | null
  status: 'pending'
}

export type BuildResult = { ok: true; row: MobileLeaveInsert } | { ok: false; message: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function utcDay(d: string): number {
  const [y, m, day] = d.split('-').map(Number)
  return Date.UTC(y, m - 1, day) / 86_400_000
}

/** Calendar days inclusive — a first estimate only: with the Wave 3 leave ledger (20261223100000) the DATABASE sets
 * total_days from working days (policy workdays, public holidays); the sent value is replaced. */
export function inclusiveCalendarDays(startDate: string, endDate: string): number {
  return utcDay(endDate) - utcDay(startDate) + 1
}

export function buildMobileLeaveRequest(
  form: MobileLeaveForm,
  ctx: { employeeId: string; organizationId: string | null | undefined },
): BuildResult {
  if (!ctx.organizationId) return { ok: false, message: 'Your company could not be determined. Please sign in again.' }
  if (!form.leaveTypeId || !form.startDate || !form.endDate) {
    return { ok: false, message: 'Please select a leave type and dates.' }
  }
  if (!ISO_DATE.test(form.startDate) || !ISO_DATE.test(form.endDate)) {
    return { ok: false, message: 'Please enter valid dates.' }
  }
  if (form.endDate < form.startDate) return { ok: false, message: 'The end date cannot be before the start date.' }
  if (form.halfDay) {
    if (form.startDate !== form.endDate) {
      return { ok: false, message: 'A half-day leave must start and end on the same date.' }
    }
    if (form.halfDayPeriod !== 'morning' && form.halfDayPeriod !== 'afternoon') {
      return { ok: false, message: 'Please choose morning or afternoon for a half-day leave.' }
    }
  }
  const reason = form.reason.trim()
  return {
    ok: true,
    row: {
      employee_id: ctx.employeeId,
      organization_id: ctx.organizationId,
      leave_type_id: form.leaveTypeId,
      start_date: form.startDate,
      end_date: form.endDate,
      total_days: form.halfDay ? 0.5 : inclusiveCalendarDays(form.startDate, form.endDate),
      is_half_day: form.halfDay,
      half_day_period: form.halfDay ? (form.halfDayPeriod as HalfDayPeriod) : null,
      reason: reason ? reason : null,
      status: 'pending',
    },
  }
}

/**
 * Confirms that a leave decision was stored. RLS-hidden rows come back empty (refusal); a row whose stored status
 * differs from the requested decision means the database did not apply it — never report that as success.
 */
export function assertDecisionStored(
  rows: ReadonlyArray<{ status?: string | null }> | null | undefined,
  decision: 'approved' | 'rejected' | 'cancelled',
): void {
  assertLeaveRowsChanged(rows)
  const stored = rows![0]?.status
  if (stored !== decision) {
    throw new Error(`The decision was not saved (the request is ${stored ?? 'unchanged'}). Please refresh and try again.`)
  }
}
