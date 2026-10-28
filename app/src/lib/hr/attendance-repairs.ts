/**
 * HR attendance — schema-aligned builders and safety rules for corrections, timesheets and overtime (B2B).
 * Pure functions (no database access) so the rules are unit-tested; the routes only load rows and write the results.
 *
 * Column contract (2026-10-16 schema):
 *   hr_attendance_corrections: status, reviewed_by, reviewed_at, review_comment
 *   hr_attendance_audit:       organization_id, actor_user_id, entity_type, entity_id, action, metadata
 *   hr_timesheets:             user_id, organization_id, period_start, period_end, period_type, total_minutes, overtime_minutes, status
 *   hr_overtime_requests:      employee_id, attendance_entry_id, request_date, ot_minutes, reason, status, approver_id, approved_at,
 *                              approver_comment, day_type, rate_multiplier, tier
 */

export type Refusal = { code: string; message: string; status: number }

// ─── Attendance corrections ──────────────────────────────────────────────────

export interface CorrectionRow {
  id: string
  entry_id: string
  requested_by: string
  status: string
  corrected_clock_in: string | null
  corrected_clock_out: string | null
  entry?: { user_id?: string | null; clock_in_at?: string | null; clock_out_at?: string | null; worked_minutes?: number | null; status?: string | null } | null
}

/** A reviewer may never decide a correction they requested or one about their own attendance. */
export function correctionReviewRefusal(reviewerId: string, correction: CorrectionRow): Refusal | null {
  if (correction.status !== 'pending') return { code: 'already_reviewed', message: 'Already reviewed', status: 400 }
  if (correction.requested_by === reviewerId || correction.entry?.user_id === reviewerId) {
    return { code: 'self_review', message: 'You cannot review your own attendance correction.', status: 403 }
  }
  return null
}

/** Entry changes for an approved correction; refuses a clock-out that is not after the clock-in. */
export function buildCorrectionEntryUpdate(correction: CorrectionRow):
  | { ok: true; updates: Record<string, unknown>; before: Record<string, unknown> }
  | { ok: false; refusal: Refusal } {
  const entry = correction.entry ?? {}
  const clockIn = correction.corrected_clock_in ?? entry.clock_in_at ?? null
  const clockOut = correction.corrected_clock_out ?? entry.clock_out_at ?? null
  const updates: Record<string, unknown> = { status: 'adjusted' }
  if (correction.corrected_clock_in) updates.clock_in_at = correction.corrected_clock_in
  if (correction.corrected_clock_out) updates.clock_out_at = correction.corrected_clock_out
  if (clockIn && clockOut) {
    const minutes = Math.round((new Date(clockOut).getTime() - new Date(clockIn).getTime()) / 60000)
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { ok: false, refusal: { code: 'invalid_times', message: 'The corrected clock-out must be after the clock-in.', status: 422 } }
    }
    updates.worked_minutes = minutes
  }
  return {
    ok: true,
    updates,
    before: { clock_in_at: entry.clock_in_at ?? null, clock_out_at: entry.clock_out_at ?? null, worked_minutes: entry.worked_minutes ?? null, status: entry.status ?? null },
  }
}

export function attendanceAuditRow(input: {
  organizationId: string
  actorId: string
  entityType: string
  entityId: string
  action: string
  metadata: Record<string, unknown>
}) {
  return {
    organization_id: input.organizationId,
    actor_user_id: input.actorId,
    entity_type: input.entityType,
    entity_id: input.entityId,
    action: input.action,
    metadata: input.metadata,
  }
}

// ─── Timesheets ──────────────────────────────────────────────────────────────

export interface TimesheetEntryInput {
  worked_minutes: number | null
  overtime_minutes: number | null
  attendance_flag: string | null
  clock_in_at: string
}

/** Totals stored on the timesheet (real columns) plus derived counters returned to the caller only. */
export function summarizeTimesheetEntries(entries: readonly TimesheetEntryInput[]) {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  return {
    total_minutes: Math.round(entries.reduce((s, e) => s + n(e.worked_minutes), 0)),
    overtime_minutes: Math.round(entries.reduce((s, e) => s + n(e.overtime_minutes), 0)),
    derived: {
      days_worked: new Set(entries.map((e) => new Date(e.clock_in_at).toISOString().slice(0, 10))).size,
      late_count: entries.filter((e) => e.attendance_flag === 'late' || e.attendance_flag === 'late_and_early').length,
      early_leave_count: entries.filter((e) => e.attendance_flag === 'early_leave' || e.attendance_flag === 'late_and_early').length,
    },
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
export function validateTimesheetPeriod(periodStart: unknown, periodEnd: unknown): Refusal | null {
  if (typeof periodStart !== 'string' || typeof periodEnd !== 'string' || !ISO_DATE.test(periodStart) || !ISO_DATE.test(periodEnd)) {
    return { code: 'invalid_period', message: 'period_start and period_end are required (YYYY-MM-DD)', status: 400 }
  }
  if (periodEnd < periodStart) return { code: 'invalid_period', message: 'period_end must not be before period_start', status: 400 }
  return null
}

/** A submitted, pending or approved timesheet is never silently regenerated back to draft. */
export function timesheetRegenerationRefusal(existingStatus: string | null | undefined): Refusal | null {
  if (!existingStatus || existingStatus === 'draft' || existingStatus === 'rejected') return null
  return { code: 'timesheet_locked', message: `This timesheet is ${existingStatus} and cannot be regenerated.`, status: 409 }
}

export function timesheetRow(input: {
  userId: string
  organizationId: string
  periodStart: string
  periodEnd: string
  periodType?: string | null
  totals: { total_minutes: number; overtime_minutes: number }
}) {
  return {
    user_id: input.userId,
    organization_id: input.organizationId,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    period_type: input.periodType || 'monthly',
    total_minutes: input.totals.total_minutes,
    overtime_minutes: input.totals.overtime_minutes,
    status: 'draft',
  }
}

// ─── Overtime requests ───────────────────────────────────────────────────────

/** Until the full OT workflow (B5), every request needs an independent approval: no auto-approval, ever. */
export function buildOvertimeRequestInsert(input: {
  organizationId: string
  employeeId: string
  body: Record<string, unknown>
}): { ok: true; row: Record<string, unknown> } | { ok: false; refusal: Refusal } {
  const { body } = input
  const requestDate = body.request_date
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (typeof requestDate !== 'string' || !ISO_DATE.test(requestDate) || !reason) {
    return { ok: false, refusal: { code: 'invalid_request', message: 'request_date and reason are required', status: 400 } }
  }
  const rawMinutes = body.ot_minutes ?? body.ot_minutes_claimed
  let otMinutes: number | null = null
  if (rawMinutes !== undefined && rawMinutes !== null && rawMinutes !== '') {
    otMinutes = Number(rawMinutes)
    if (!Number.isInteger(otMinutes) || otMinutes <= 0 || otMinutes > 24 * 60) {
      return { ok: false, refusal: { code: 'invalid_minutes', message: 'ot_minutes must be a whole number of minutes between 1 and 1440', status: 400 } }
    }
  }
  const dayType = body.day_type ?? 'normal'
  if (!['normal', 'rest_day', 'public_holiday'].includes(String(dayType))) {
    return { ok: false, refusal: { code: 'invalid_day_type', message: 'day_type must be normal, rest_day or public_holiday', status: 400 } }
  }
  return {
    ok: true,
    row: {
      organization_id: input.organizationId,
      employee_id: input.employeeId,
      attendance_entry_id: typeof body.attendance_entry_id === 'string' && body.attendance_entry_id ? body.attendance_entry_id : null,
      request_date: requestDate,
      reason,
      ot_minutes: otMinutes,
      day_type: dayType,
      status: 'submitted',
    },
  }
}

export function overtimeDecisionRefusal(deciderId: string, request: { employee_id: string; status: string }, decision: 'approved' | 'rejected'): Refusal | null {
  if (request.employee_id === deciderId) {
    return { code: 'self_approval', message: 'You cannot approve or reject your own overtime request.', status: 403 }
  }
  if (request.status !== 'submitted') {
    return { code: 'invalid_status', message: `Cannot ${decision === 'approved' ? 'approve' : 'reject'} a request with status: ${request.status}`, status: 400 }
  }
  return null
}

export function overtimeDecisionUpdate(deciderId: string, decision: 'approved' | 'rejected', comment: unknown, now = new Date()) {
  return {
    status: decision,
    approver_id: deciderId,
    approved_at: now.toISOString(),
    approver_comment: typeof comment === 'string' && comment.trim() ? comment.trim() : null,
  }
}

export function overtimeCancelRefusal(actorId: string, isManager: boolean, request: { employee_id: string; status: string }): Refusal | null {
  if (request.employee_id !== actorId && !isManager) return { code: 'forbidden', message: 'Insufficient permissions', status: 403 }
  if (!['draft', 'submitted'].includes(request.status)) {
    return { code: 'invalid_status', message: `Cannot cancel a request with status: ${request.status}`, status: 400 }
  }
  return null
}
