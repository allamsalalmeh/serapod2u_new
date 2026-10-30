import { describe, expect, it } from 'vitest'
import {
  buildCorrectionEntryUpdate, buildOvertimeRequestInsert, correctionReviewRefusal, overtimeCancelRefusal, overtimeDecisionRefusal,
  overtimeDecisionUpdate, summarizeTimesheetEntries, timesheetRegenerationRefusal, timesheetRow, validateTimesheetPeriod,
} from './attendance-repairs'

const correction = (over: Record<string, unknown> = {}) => ({
  id: 'c1', entry_id: 'e1', requested_by: 'emp', status: 'pending',
  corrected_clock_in: null, corrected_clock_out: '2026-10-01T18:00:00.000Z',
  entry: { user_id: 'emp', clock_in_at: '2026-10-01T09:00:00.000Z', clock_out_at: null, worked_minutes: null, status: 'open' }, ...over,
}) as any

describe('attendance correction review', () => {
  it('refuses self-review (requester or the entry owner) and repeated review', () => {
    expect(correctionReviewRefusal('emp', correction())?.code).toBe('self_review')
    expect(correctionReviewRefusal('hr', correction({ requested_by: 'hr' }))?.code).toBe('self_review')
    expect(correctionReviewRefusal('hr', correction({ status: 'approved' }))?.code).toBe('already_reviewed')
    expect(correctionReviewRefusal('hr', correction())).toBeNull()
  })
  it('builds the entry update with recalculated minutes and keeps the before-image', () => {
    const r = buildCorrectionEntryUpdate(correction())
    expect(r).toEqual({
      ok: true,
      updates: { status: 'adjusted', clock_out_at: '2026-10-01T18:00:00.000Z', worked_minutes: 540 },
      before: { clock_in_at: '2026-10-01T09:00:00.000Z', clock_out_at: null, worked_minutes: null, status: 'open' },
    })
  })
  it('refuses a clock-out before the clock-in', () => {
    const r = buildCorrectionEntryUpdate(correction({ corrected_clock_out: '2026-10-01T08:00:00.000Z' }))
    expect(r.ok).toBe(false)
  })
})

describe('timesheet generation', () => {
  const entries = [
    { worked_minutes: 480, overtime_minutes: 30, attendance_flag: 'late', clock_in_at: '2026-10-01T01:00:00Z' },
    { worked_minutes: 500, overtime_minutes: null, attendance_flag: 'late_and_early', clock_in_at: '2026-10-02T01:00:00Z' },
    { worked_minutes: null, overtime_minutes: 0, attendance_flag: null, clock_in_at: '2026-10-02T09:00:00Z' },
  ]
  it('stores only real columns; counters are derived', () => {
    const totals = summarizeTimesheetEntries(entries)
    expect(totals).toEqual({ total_minutes: 980, overtime_minutes: 30, derived: { days_worked: 2, late_count: 2, early_leave_count: 1 } })
    expect(timesheetRow({ userId: 'u', organizationId: 'o', periodStart: '2026-10-01', periodEnd: '2026-10-31', totals })).toEqual({
      user_id: 'u', organization_id: 'o', period_start: '2026-10-01', period_end: '2026-10-31', period_type: 'monthly',
      total_minutes: 980, overtime_minutes: 30, status: 'draft',
    })
  })
  it('never regenerates a submitted, pending or approved timesheet', () => {
    expect(timesheetRegenerationRefusal(undefined)).toBeNull()
    expect(timesheetRegenerationRefusal('draft')).toBeNull()
    expect(timesheetRegenerationRefusal('rejected')).toBeNull()
    for (const s of ['submitted', 'pending', 'approved']) expect(timesheetRegenerationRefusal(s)?.status).toBe(409)
  })
  it('validates the period', () => {
    expect(validateTimesheetPeriod('2026-10-01', '2026-10-31')).toBeNull()
    expect(validateTimesheetPeriod('2026-10-31', '2026-10-01')?.status).toBe(400)
    expect(validateTimesheetPeriod('01/10/2026', '2026-10-31')?.status).toBe(400)
  })
})

describe('overtime requests', () => {
  it('always needs an independent approval (never auto-approved) and uses real columns', () => {
    const r = buildOvertimeRequestInsert({ organizationId: 'o', employeeId: 'emp', body: { request_date: '2026-10-01', reason: ' Stock count ', ot_minutes_claimed: 90 } })
    expect(r).toEqual({ ok: true, row: {
      organization_id: 'o', employee_id: 'emp', attendance_entry_id: null, request_date: '2026-10-01', reason: 'Stock count',
      ot_minutes: 90, day_type: 'normal', status: 'submitted',
    } })
  })
  it('validates input', () => {
    expect(buildOvertimeRequestInsert({ organizationId: 'o', employeeId: 'e', body: { reason: 'x' } }).ok).toBe(false)
    expect(buildOvertimeRequestInsert({ organizationId: 'o', employeeId: 'e', body: { request_date: '2026-10-01', reason: 'x', ot_minutes: -5 } }).ok).toBe(false)
    expect(buildOvertimeRequestInsert({ organizationId: 'o', employeeId: 'e', body: { request_date: '2026-10-01', reason: 'x', day_type: 'sunday' } }).ok).toBe(false)
  })
  it('refuses self-approval and decisions on non-submitted requests', () => {
    expect(overtimeDecisionRefusal('emp', { employee_id: 'emp', status: 'submitted' }, 'approved')?.code).toBe('self_approval')
    expect(overtimeDecisionRefusal('mgr', { employee_id: 'emp', status: 'approved' }, 'rejected')?.code).toBe('invalid_status')
    expect(overtimeDecisionRefusal('mgr', { employee_id: 'emp', status: 'submitted' }, 'approved')).toBeNull()
  })
  it('records the approver in approver_id / approver_comment', () => {
    expect(overtimeDecisionUpdate('mgr', 'approved', ' ok ', new Date('2026-10-24T00:00:00Z'))).toEqual({
      status: 'approved', approver_id: 'mgr', approved_at: '2026-10-24T00:00:00.000Z', approver_comment: 'ok',
    })
  })
  it('cancel: requester or manager, only before a decision', () => {
    expect(overtimeCancelRefusal('emp', false, { employee_id: 'emp', status: 'submitted' })).toBeNull()
    expect(overtimeCancelRefusal('x', false, { employee_id: 'emp', status: 'submitted' })?.status).toBe(403)
    expect(overtimeCancelRefusal('mgr', true, { employee_id: 'emp', status: 'approved' })?.status).toBe(400)
  })
})
