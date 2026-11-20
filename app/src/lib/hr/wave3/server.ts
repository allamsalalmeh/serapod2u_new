import 'server-only'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { sessionActor, type SessionActor } from '@/lib/hr/employment-foundation'
import { hrSelfCan } from '@/lib/server/hrAccess'
import { w3Error, type W3ErrorInfo } from '@/lib/hr/wave3/messages'

/**
 * HR Wave 3 — server calls into the database functions of 20261222100000 (hybrid attendance & overtime) and
 * 20261223100000 (leave ledger).
 *
 * The server passes only the SESSION actor (never a body value) and maps refusals; the database decides every rule
 * with canonical S&A on every call (explicit, non-legacy authority in the employee's organization):
 *   - hr.attendance.manage       HR attendance administration (manual entry, import, decisions, detection, reports)
 *   - hr.mss.attendance_view     direct manager: team board and exceptions (read)
 *   - hr.mss.attendance_approve  direct manager: corrections and exceptions (REQUESTED from S&A; until it exists only HR decides)
 *   - hr.mss.overtime_approve    direct manager: overtime decisions (REQUESTED from S&A; until it exists only HR decides)
 *   - hr.leave.approve           HR leave administration (entitlements, adjustments, runs) until hr.leave.manage exists
 *   - hr.mss.leave_view          direct manager: a direct report's leave ledger
 *   - hr.self_service.use        Employee Self-Service gate for the employee's own entry points (route level)
 * Fail closed: any error refuses.
 */
export const W3_PERMISSIONS = {
  attendanceManage: 'hr.attendance.manage',
  mssAttendanceView: 'hr.mss.attendance_view',
  mssAttendanceApprove: 'hr.mss.attendance_approve',
  mssOvertimeApprove: 'hr.mss.overtime_approve',
  leaveAdmin: 'hr.leave.approve',
  mssLeaveView: 'hr.mss.leave_view',
  selfService: 'hr.self_service.use',
} as const

export type W3Result<T> = { ok: true; data: T } | ({ ok: false } & W3ErrorInfo)

export { sessionActor, type SessionActor }

export async function callW3<T>(fn: string, args: Record<string, unknown>, fallback?: string): Promise<W3Result<T>> {
  try {
    const { data, error } = await (createAdminClient() as any).rpc(fn, args)
    if (error) return { ok: false, ...w3Error(error, fallback) }
    return { ok: true, data: data as T }
  } catch (e) {
    return { ok: false, ...w3Error(e, fallback) }
  }
}

/** Employee Self-Service gate (canonical S&A on the caller's own record) for the employee entry points. */
export async function selfServiceAllowed(actor: SessionActor): Promise<boolean> {
  if (!actor.organizationId) return false
  return hrSelfCan({ userId: actor.id, organizationId: actor.organizationId }, W3_PERMISSIONS.selfService)
}

/* ─── attendance ─────────────────────────────────────────────────────────────── */

export const clock = (actor: string, action: 'clock_in' | 'clock_out', shiftId: string | null, source: 'web' | 'mobile',
                      clientAt: string | null, note: string | null) =>
  callW3<Record<string, unknown>>('hr_attendance_clock', {
    p_actor: actor, p_action: action, p_shift: shiftId, p_source: source, p_client_at: clientAt, p_note: note,
  }, 'Clocking could not be recorded.')

export const myAttendance = (actor: string, from: string | null, to: string | null) =>
  callW3<Record<string, unknown>>('hr_attendance_my_overview', { p_actor: actor, p_from: from, p_to: to }, 'Your attendance could not be loaded.')

export const manualEntry = (actor: string, a: { employeeId: string; workDate: string; clockIn: string; clockOut: string | null;
                            breakMinutes: number | null; shiftId: string | null; reason: string }) =>
  callW3<Record<string, unknown>>('hr_attendance_manual_entry', {
    p_actor: actor, p_employee: a.employeeId, p_work_date: a.workDate, p_clock_in: a.clockIn, p_clock_out: a.clockOut,
    p_break_minutes: a.breakMinutes, p_shift: a.shiftId, p_reason: a.reason,
  }, 'The attendance entry could not be recorded.')

export const requestCorrection = (actor: string, a: { entryId: string | null; workDate: string | null; clockIn: string | null;
                                  clockOut: string | null; breakMinutes: number | null; reason: string; onBehalfOf: string | null }) =>
  callW3<Record<string, unknown>>('hr_attendance_request_correction', {
    p_actor: actor, p_entry: a.entryId, p_work_date: a.workDate, p_clock_in: a.clockIn, p_clock_out: a.clockOut,
    p_break_minutes: a.breakMinutes, p_reason: a.reason, p_on_behalf_of: a.onBehalfOf,
  }, 'The correction could not be submitted.')

export const cancelCorrection = (actor: string, id: string) =>
  callW3<Record<string, unknown>>('hr_attendance_cancel_correction', { p_actor: actor, p_correction: id })

export const decideCorrection = (actor: string, id: string, decision: 'approved' | 'rejected', comment: string | null) =>
  callW3<Record<string, unknown>>('hr_attendance_decide_correction', { p_actor: actor, p_correction: id, p_decision: decision, p_comment: comment },
    'The decision could not be saved.')

export const resolveException = (actor: string, id: string, resolution: string, note: string | null) =>
  callW3<Record<string, unknown>>('hr_attendance_resolve_exception', { p_actor: actor, p_exception: id, p_resolution: resolution, p_note: note },
    'The exception could not be resolved.')

export const runDetection = (actor: string, org: string, from: string, to: string) =>
  callW3<Record<string, unknown>>('hr_attendance_run_detection', { p_actor: actor, p_org: org, p_from: from, p_to: to })

export const reviewQueue = (actor: string, org: string, kind: 'exceptions' | 'corrections', status: string | null,
                            from: string | null, to: string | null) =>
  callW3<unknown[]>('hr_attendance_review_queue', { p_actor: actor, p_org: org, p_kind: kind, p_status: status, p_from: from, p_to: to },
    'The review queue could not be loaded.')

export const dayBoard = (actor: string, org: string, date: string) =>
  callW3<unknown[]>('hr_attendance_day_board', { p_actor: actor, p_org: org, p_date: date }, 'The attendance board could not be loaded.')

export const periodReport = (actor: string, org: string, from: string, to: string) =>
  callW3<Record<string, unknown>>('hr_attendance_period_report', { p_actor: actor, p_org: org, p_from: from, p_to: to },
    'The attendance report could not be loaded.')

export const importPreview = (actor: string, org: string, fileName: string, sha256: string, rows: unknown[]) =>
  callW3<Record<string, unknown>>('hr_attendance_import_preview', {
    p_actor: actor, p_org: org, p_file_name: fileName, p_file_sha256: sha256, p_rows: rows,
  }, 'The file could not be checked.')

export const importCommit = (actor: string, batchId: string, expectedValid: number) =>
  callW3<Record<string, unknown>>('hr_attendance_import_commit', { p_actor: actor, p_batch: batchId, p_expected_valid: expectedValid },
    'The import could not be completed.')

export const importCancel = (actor: string, batchId: string) =>
  callW3<Record<string, unknown>>('hr_attendance_import_cancel', { p_actor: actor, p_batch: batchId })

export const importBatch = (actor: string, batchId: string) =>
  callW3<Record<string, unknown>>('hr_attendance_import_batch_get', { p_actor: actor, p_batch: batchId })

export const importBatches = (actor: string, org: string) =>
  callW3<unknown[]>('hr_attendance_import_batches_list', { p_actor: actor, p_org: org })

/* ─── overtime ───────────────────────────────────────────────────────────────── */

export const overtimeSubmit = (actor: string, a: { date: string; minutes: number; reason: string; kind: 'pre' | 'post';
                               entryId: string | null; plannedStart: string | null; plannedEnd: string | null; idempotencyKey: string | null }) =>
  callW3<Record<string, unknown>>('hr_overtime_submit', {
    p_actor: actor, p_request_date: a.date, p_minutes: a.minutes, p_reason: a.reason, p_kind: a.kind, p_entry: a.entryId,
    p_planned_start: a.plannedStart, p_planned_end: a.plannedEnd, p_idempotency_key: a.idempotencyKey,
  }, 'The overtime request could not be submitted.')

export const overtimeDecide = (actor: string, id: string, decision: 'approved' | 'rejected', comment: string | null, approvedMinutes: number | null) =>
  callW3<Record<string, unknown>>('hr_overtime_decide', {
    p_actor: actor, p_request: id, p_decision: decision, p_comment: comment, p_approved_minutes: approvedMinutes,
  }, 'The decision could not be saved.')

export const overtimeCancel = (actor: string, id: string, reason: string | null) =>
  callW3<Record<string, unknown>>('hr_overtime_cancel', { p_actor: actor, p_request: id, p_reason: reason })

export const overtimeList = (actor: string, scope: 'mine' | 'queue', status: string | null, org: string | null) =>
  callW3<unknown[]>('hr_overtime_list', { p_actor: actor, p_scope: scope, p_status: status, p_org: org }, 'Overtime requests could not be loaded.')

/* ─── leave ledger ───────────────────────────────────────────────────────────── */

export const leaveQuote = (actor: string, typeId: string, start: string, end: string, halfDay: boolean, excludeRequest: string | null) =>
  callW3<Record<string, unknown>>('hr_leave_quote', {
    p_actor: actor, p_type: typeId, p_start: start, p_end: end, p_half_day: halfDay, p_exclude_request: excludeRequest,
  }, 'The leave days could not be calculated.')

export const myLeaveBalances = (actor: string, year: number | null) =>
  callW3<Record<string, unknown>>('hr_leave_my_balances', { p_actor: actor, p_year: year }, 'Your leave balances could not be loaded.')

export const leaveBalancesOverview = (actor: string, org: string, year: number) =>
  callW3<Record<string, unknown>>('hr_leave_balances_overview', { p_actor: actor, p_org: org, p_year: year }, 'Leave balances could not be loaded.')

export const leaveLedger = (actor: string, employeeId: string, year: number | null) =>
  callW3<unknown[]>('hr_leave_ledger_for', { p_actor: actor, p_employee: employeeId, p_year: year }, 'The leave ledger could not be loaded.')

export const leaveSetEntitlement = (actor: string, employeeId: string, typeId: string, year: number, days: number, reason: string) =>
  callW3<Record<string, unknown>>('hr_leave_set_entitlement', {
    p_actor: actor, p_employee: employeeId, p_type: typeId, p_year: year, p_days: days, p_reason: reason,
  }, 'The entitlement could not be saved.')

export const leaveAdjust = (actor: string, employeeId: string, typeId: string, year: number, delta: number, reason: string) =>
  callW3<Record<string, unknown>>('hr_leave_adjust', {
    p_actor: actor, p_employee: employeeId, p_type: typeId, p_year: year, p_delta: delta, p_reason: reason,
  }, 'The adjustment could not be saved.')

export const leaveEntitlementRun = (actor: string, org: string, typeId: string, year: number, dryRun: boolean, reason: string | null) =>
  callW3<Record<string, unknown>>('hr_leave_entitlement_run', {
    p_actor: actor, p_org: org, p_type: typeId, p_year: year, p_dry_run: dryRun, p_reason: reason,
  }, 'The entitlement run could not be completed.')

export const leaveCarryForwardRun = (actor: string, org: string, typeId: string, fromYear: number, dryRun: boolean, reason: string | null) =>
  callW3<Record<string, unknown>>('hr_leave_carry_forward_run', {
    p_actor: actor, p_org: org, p_type: typeId, p_from_year: fromYear, p_dry_run: dryRun, p_reason: reason,
  }, 'The carry-forward run could not be completed.')

export const leaveUnpaidDays = (actor: string, org: string, from: string, to: string) =>
  callW3<unknown[]>('hr_leave_unpaid_days', { p_actor: actor, p_org: org, p_from: from, p_to: to }, 'Unpaid leave could not be loaded.')

/* ─── route helpers ──────────────────────────────────────────────────────────── */

export const unauthenticated = () =>
  NextResponse.json({ success: false, error: 'Not authenticated', code: 'UNAUTHENTICATED' }, { status: 401 })
export const forbiddenSelfService = () =>
  NextResponse.json({ success: false, error: 'Employee Self-Service is not enabled for your account.', code: 'FORBIDDEN' }, { status: 403 })
export const invalid = (message = 'The request is incomplete.', code = 'INVALID_INPUT') =>
  NextResponse.json({ success: false, error: message, code }, { status: 400 })
export function respond<T>(result: W3Result<T>) {
  if (!result.ok) return NextResponse.json({ success: false, error: result.message, code: result.code }, { status: result.status })
  return NextResponse.json({ success: true, data: result.data })
}
