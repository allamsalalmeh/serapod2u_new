import { describe, expect, it } from 'vitest'
import { assertDecisionStored, buildMobileLeaveRequest, inclusiveCalendarDays, type MobileLeaveForm } from './mobileLeave'

const ctx = { employeeId: 'emp-1', organizationId: 'org-1' }
const form = (over: Partial<MobileLeaveForm> = {}): MobileLeaveForm => ({
  leaveTypeId: 'lt-1', startDate: '2026-11-02', endDate: '2026-11-04', halfDay: false, halfDayPeriod: '', reason: '', ...over,
})

describe('buildMobileLeaveRequest (Wave 1 mobile leave)', () => {
  it('builds a pending own-request row with inclusive calendar days and no half-day period', () => {
    const r = buildMobileLeaveRequest(form({ reason: '  family  ' }), ctx)
    expect(r).toEqual({
      ok: true,
      row: {
        employee_id: 'emp-1', organization_id: 'org-1', leave_type_id: 'lt-1', start_date: '2026-11-02', end_date: '2026-11-04',
        total_days: 3, is_half_day: false, half_day_period: null, reason: 'family', status: 'pending',
      },
    })
  })

  it('sends half_day_period with a half day (table constraint hr_leave_requests_half_day_chk)', () => {
    const r = buildMobileLeaveRequest(form({ endDate: '2026-11-02', halfDay: true, halfDayPeriod: 'afternoon' }), ctx)
    expect(r.ok && r.row).toMatchObject({ total_days: 0.5, is_half_day: true, half_day_period: 'afternoon' })
  })

  it.each([
    [form({ halfDay: true, halfDayPeriod: 'morning' }), 'same date'],
    [form({ endDate: '2026-11-02', halfDay: true }), 'morning or afternoon'],
    [form({ endDate: '2026-11-01' }), 'before the start'],
    [form({ leaveTypeId: '' }), 'leave type'],
    [form({ startDate: '02/11/2026' }), 'valid dates'],
  ])('refuses an invalid form before calling the database (%#)', (f, text) => {
    const r = buildMobileLeaveRequest(f, ctx)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toContain(text)
  })

  it('refuses when the company is unknown', () => {
    expect(buildMobileLeaveRequest(form(), { employeeId: 'e', organizationId: '' }).ok).toBe(false)
  })

  it('counts calendar days across month and DST-free UTC boundaries', () => {
    expect(inclusiveCalendarDays('2026-10-30', '2026-11-02')).toBe(4)
    expect(inclusiveCalendarDays('2026-12-31', '2027-01-01')).toBe(2)
  })
})

describe('assertDecisionStored (no false success)', () => {
  it('accepts only the stored requested status', () => {
    expect(() => assertDecisionStored([{ status: 'approved' }], 'approved')).not.toThrow()
  })
  it('refuses an RLS-hidden row (no rows returned)', () => {
    expect(() => assertDecisionStored([], 'approved')).toThrow(/not authorized/)
    expect(() => assertDecisionStored(null, 'rejected')).toThrow(/not authorized/)
  })
  it('refuses a row whose stored status differs from the decision', () => {
    expect(() => assertDecisionStored([{ status: 'pending' }], 'approved')).toThrow(/not saved/)
  })
})
