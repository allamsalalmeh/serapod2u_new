/**
 * HR leave — user-facing messages for the database leave guard (B2A, migration 20261219100000).
 *
 * The database is the authority: it refuses on-behalf submissions, self-approval, unauthorized decisions and invalid
 * transitions with stable codes. Row-level security additionally makes rows the account may not decide invisible, so
 * an update that matches no row is also a refusal (see `assertLeaveRowsChanged`).
 */

export const LEAVE_ERROR_MESSAGES: Record<string, string> = {
  hr_leave_on_behalf_refused: 'Leave can only be applied for by the employee themself.',
  hr_leave_self_approval: 'You cannot approve or reject your own leave.',
  hr_leave_not_authorized:
    'You are not authorized to act on this leave request. Only the direct manager (Manager Self-Service) or authorized HR can decide it.',
  hr_leave_invalid_transition: 'This leave request can no longer be changed in that way.',
  hr_leave_immutable_field: 'The employee and organization of a leave request cannot be changed.',
  // Raised by hr_require_onboarded_employee when the employee has no COMPLETED employment record in the request's
  // organization. Leave is filed in the account's home organization (users.organization_id, as the B2A insert policy
  // requires); an employee whose employment record sits in another company of the group is refused the same way.
  // Wave 3 leave ledger (20261223100000): working days, duplicate protection and balance are decided by the database.
  hr_leave_no_working_days: 'The selected dates contain no working days (rest days or public holidays).',
  hr_leave_overlap: 'You already have leave on some of these dates.',
  hr_leave_insufficient_balance: 'Not enough leave balance for these dates.',
  hr_leave_type_invalid: 'This leave type is not available.',
  hr_leave_half_day_single_date: 'A half day is a single date.',
  hr_leave_span_too_long: 'A leave request can span at most one year.',
  hr_onboarding_pending:
    'Leave cannot be submitted: you have no completed HR employment record in this company. If you are employed by another company of the group, ask HR to check your employment record.',
}

/** A decision was saved but its approval-history step could not be written (the decision itself stands). */
export const LEAVE_STEP_NOT_RECORDED = 'The decision was saved, but its approval history entry could not be recorded.'

const NOT_VISIBLE = 'This leave request was not found or you are not authorized to act on it.'

/** Maps a Supabase/PostgREST error (or any thrown value) to a clear message. Unknown errors keep a generic text. */
export function leaveErrorMessage(error: unknown, fallback = 'The leave request could not be saved.'): string {
  const text =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object'
        ? [(error as { message?: unknown }).message, (error as { details?: unknown }).details, (error as { hint?: unknown }).hint]
            .filter((part): part is string => typeof part === 'string')
            .join(' ')
        : ''
  for (const [code, message] of Object.entries(LEAVE_ERROR_MESSAGES)) {
    if (text.includes(code)) {
      // the balance refusal carries the database's own numbers ("2 day(s) requested in 2027, 1.5 available")
      const details = error && typeof error === 'object' ? (error as { details?: unknown }).details : undefined
      return code === 'hr_leave_insufficient_balance' && typeof details === 'string' && details ? `${message} ${details}.` : message
    }
  }
  if (/row-level security/i.test(text)) return NOT_VISIBLE
  return fallback
}

/** An UPDATE filtered out by row-level security returns no rows and no error: treat that as a refusal. */
export function assertLeaveRowsChanged(rows: readonly unknown[] | null | undefined): void {
  if (!rows || rows.length === 0) throw new Error(NOT_VISIBLE)
}
