/**
 * HR Wave 3 (migrations 20261222100000 attendance/overtime + 20261223100000 leave ledger) — caller-safe messages.
 * Isomorphic (no server imports): used by the API routes and by the attendance, overtime and leave screens.
 *
 * The database owns every rule (server time, canonical identity, explicit S&A authority, no self-approval,
 * maker-checker, duplicate/overlap protection, append-only history). This module only maps its stable error codes.
 */

export interface W3ErrorInfo {
  status: number
  code: string
  message: string
}

const RULES: Array<[string, number, string, string]> = [
  // authority
  ['sa_authorization_required', 403, 'FORBIDDEN', 'You do not have HR authority for this (an explicit HR policy in the employee\'s company is required).'],
  ['sa_actor_inactive', 403, 'FORBIDDEN', 'Your account is not active.'],
  ['hr_attendance_not_authorized', 403, 'FORBIDDEN', 'You are not authorized to decide this. Only explicitly authorized HR (or the direct manager, where Manager Self-Service allows it) can.'],
  ['hr_attendance_self_review', 403, 'SELF_REVIEW', 'You cannot review or approve your own attendance or your own request.'],
  ['hr_attendance_maker_checker', 403, 'MAKER_CHECKER', 'Another HR person must confirm an attendance entry you recorded.'],
  ['hr_ot_self_approval', 403, 'SELF_REVIEW', 'You cannot approve or reject your own overtime.'],
  ['hr_ot_cancel_approved_by_hr', 403, 'FORBIDDEN', 'Approved overtime can only be cancelled by HR.'],
  ['hr_self_change_prohibited', 403, 'SELF_CHANGE', 'You cannot change your own HR record. Another HR administrator must do it.'],
  ['hr_attendance_direct_write_refused', 409, 'NOT_ALLOWED', 'Attendance is recorded only through the attendance screens (server time and audit).'],
  // employment state
  ['hr_onboarding_pending', 409, 'ONBOARDING_PENDING', 'HR onboarding is not completed yet, so attendance, overtime and leave cannot be recorded.'],
  ['hr_employment_not_active', 409, 'EMPLOYMENT_NOT_ACTIVE', 'This employment is not active.'],
  ['hr_employment_not_found', 404, 'NOT_FOUND', 'No current employment record was found for this person.'],
  // clock
  ['hr_attendance_already_clocked_in', 409, 'ALREADY_CLOCKED_IN', 'You are already clocked in.'],
  ['hr_attendance_not_clocked_in', 409, 'NOT_CLOCKED_IN', 'You are not clocked in.'],
  ['hr_attendance_shift_required', 400, 'SHIFT_REQUIRED', 'Select your shift before clocking in.'],
  ['hr_attendance_shift_invalid', 400, 'SHIFT_INVALID', 'The selected shift is not available.'],
  // entries / corrections
  ['hr_attendance_overlap', 409, 'OVERLAP', 'This time overlaps attendance already recorded for the employee.'],
  ['hr_attendance_future_date', 400, 'INVALID_DATES', 'Attendance cannot be recorded for the future.'],
  ['hr_attendance_before_hire', 400, 'INVALID_DATES', 'The date is before the employee\'s hire date.'],
  ['hr_attendance_duration_invalid', 400, 'INVALID_DATES', 'Clock-out must be after clock-in and within 24 hours.'],
  ['hr_attendance_break_invalid', 400, 'INVALID_INPUT', 'Break minutes must be between 0 and 600.'],
  ['hr_attendance_time_required', 400, 'INVALID_INPUT', 'Enter the date and clock-in time.'],
  ['hr_attendance_range_invalid', 400, 'INVALID_DATES', 'Choose a valid date range (at most about two months, not in the future).'],
  ['hr_attendance_correction_pending', 409, 'ALREADY_PENDING', 'A correction for this day is already waiting for review.'],
  ['hr_attendance_already_decided', 409, 'ALREADY_DECIDED', 'This item has already been decided.'],
  ['hr_attendance_entry_not_found', 404, 'NOT_FOUND', 'The attendance entry was not found.'],
  ['hr_attendance_correction_not_found', 404, 'NOT_FOUND', 'The correction request was not found.'],
  ['hr_attendance_exception_not_found', 404, 'NOT_FOUND', 'The attendance exception was not found.'],
  ['hr_attendance_action_invalid', 400, 'INVALID_INPUT', 'This action is not supported.'],
  ['hr_changes_required', 400, 'INVALID_INPUT', 'Enter at least one corrected value.'],
  ['hr_comment_required', 400, 'COMMENT_REQUIRED', 'Enter a comment (at least 3 characters).'],
  ['hr_reason_required', 400, 'REASON_REQUIRED', 'Enter a reason (at least 5 characters).'],
  // import
  ['hr_import_file_already_committed', 409, 'ALREADY_IMPORTED', 'This file has already been imported for this company.'],
  ['hr_import_preview_changed', 409, 'PREVIEW_CHANGED', 'The preview changed. Review it again before importing.'],
  ['hr_import_preview_expired', 409, 'PREVIEW_EXPIRED', 'The preview is older than 24 hours. Upload the file again.'],
  ['hr_import_nothing_valid', 400, 'NOTHING_VALID', 'No valid rows to import.'],
  ['hr_import_batch_not_open', 409, 'ALREADY_DECIDED', 'This import was already committed or cancelled.'],
  ['hr_import_batch_not_found', 404, 'NOT_FOUND', 'The import was not found.'],
  ['hr_import_too_many_rows', 400, 'TOO_MANY_ROWS', 'A file can hold at most 5,000 rows.'],
  ['hr_import_empty', 400, 'EMPTY_FILE', 'The file contains no attendance rows.'],
  ['hr_import_file_invalid', 400, 'INVALID_INPUT', 'The file could not be identified.'],
  // overtime
  ['hr_ot_duplicate', 409, 'DUPLICATE', 'You already have an overtime request for this date. Cancel it first to submit a new one.'],
  ['hr_ot_minutes_invalid', 400, 'INVALID_INPUT', 'Overtime must be between 15 and 720 minutes (approved minutes cannot exceed the request).'],
  ['hr_ot_post_in_future', 400, 'INVALID_DATES', 'Overtime already worked cannot be in the future. Use a pre-approval request.'],
  ['hr_ot_pre_in_past', 400, 'INVALID_DATES', 'A pre-approval request must be for today or later.'],
  ['hr_ot_too_old', 400, 'INVALID_DATES', 'Overtime older than 60 days cannot be claimed here. Contact HR.'],
  ['hr_ot_entry_mismatch', 400, 'INVALID_INPUT', 'The attendance entry does not match this date.'],
  ['hr_ot_not_found', 404, 'NOT_FOUND', 'The overtime request was not found.'],
  ['hr_ot_consumed', 409, 'LOCKED', 'This overtime has already been processed by payroll.'],
  // leave
  ['hr_leave_insufficient_balance', 409, 'INSUFFICIENT_BALANCE', 'Not enough leave balance for these dates.'],
  ['hr_leave_no_working_days', 400, 'NO_WORKING_DAYS', 'The selected dates contain no working days (rest days or public holidays).'],
  ['hr_leave_overlap', 409, 'OVERLAP', 'You already have leave on some of these dates.'],
  ['hr_leave_type_invalid', 400, 'INVALID_INPUT', 'This leave type is not available.'],
  ['hr_leave_type_no_tiers', 400, 'NO_TIERS', 'This leave type has no entitlement tiers configured (Leave Types → Entitlement tiers).'],
  ['hr_leave_carry_forward_disabled', 400, 'NOT_CONFIGURED', 'Carry-forward is not enabled for this leave type.'],
  ['hr_leave_half_day_single_date', 400, 'INVALID_DATES', 'A half day is a single date.'],
  ['hr_leave_span_too_long', 400, 'INVALID_DATES', 'A leave request can span at most one year.'],
  ['hr_leave_dates_invalid', 400, 'INVALID_DATES', 'Choose valid dates.'],
  ['hr_leave_days_invalid', 400, 'INVALID_INPUT', 'Enter a valid number of days (whole or half days).'],
  ['hr_history_append_only', 409, 'HISTORY_SEALED', 'History cannot be changed.'],
]

const text = (error: unknown) =>
  typeof error === 'string'
    ? error
    : error && typeof error === 'object'
      ? [(error as any).message, (error as any).details, (error as any).hint].filter((p) => typeof p === 'string').join(' ')
      : ''

/** Maps a database/PostgREST error (or thrown value) to a status, code and caller-safe message. */
export function w3Error(error: unknown, fallback = 'The request could not be completed.'): W3ErrorInfo {
  const t = text(error)
  for (const [needle, status, code, message] of RULES) {
    if (t.includes(needle)) {
      // keep the database's own numbers for balance refusals ("2 day(s) requested in 2027, 1.5 available")
      const detail = needle === 'hr_leave_insufficient_balance' && error && typeof error === 'object' && typeof (error as any).details === 'string'
        ? ` ${(error as any).details}.` : ''
      return { status, code, message: message + detail }
    }
  }
  if (/could not find the function|does not exist/i.test(t)) {
    return { status: 503, code: 'NOT_AVAILABLE', message: 'This HR feature is not installed on this environment yet (Wave 3 migrations 20261222100000 / 20261223100000).' }
  }
  if (/violates check constraint/i.test(t)) return { status: 400, code: 'INVALID_INPUT', message: 'One of the values has an invalid format.' }
  return { status: 500, code: 'ERROR', message: fallback }
}

export const W3_ERROR_CODES = RULES.map((r) => r[0])

/* ─── shared labels ─────────────────────────────────────────────────────────── */

export const EXCEPTION_LABELS: Record<string, string> = {
  late_arrival: 'Late arrival',
  early_departure: 'Early departure',
  missing_clock_out: 'Missing clock-out',
  absent_no_record: 'No attendance (no leave)',
  non_working_day_work: 'Work on rest day / holiday',
  manual_entry: 'HR manual entry (second review)',
}

export const SOURCE_LABELS: Record<string, string> = {
  web: 'Web', mobile: 'Mobile', hr_manual: 'HR manual', import: 'Excel import', correction: 'Correction',
}

export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
export const isIsoDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
export const isClockTime = (v: unknown): v is string =>
  typeof v === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v)

/** Minutes → "7h 30m". */
export function formatMinutes(min: number | null | undefined): string {
  if (min === null || min === undefined || Number.isNaN(min)) return '—'
  const h = Math.floor(Math.abs(min) / 60)
  const m = Math.abs(min) % 60
  return `${min < 0 ? '-' : ''}${h}h ${String(m).padStart(2, '0')}m`
}
