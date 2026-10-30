import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase } from '@/lib/hr/test-support/fakeSupabase'

// B2A: the leave repository must report only what the database actually stored.
let fake = createFakeSupabase()
vi.mock('@/lib/supabase/client', () => ({ createClient: () => fake.client }))

import { SupabaseLeaveRepository } from './supabaseRepository'
import { LEAVE_ERROR_MESSAGES } from './leaveErrors'

const row = (status: string) => ({
  id: 'req-1', employee_id: 'emp-1', leave_type_id: 'lt-1', start_date: '2026-11-02', end_date: '2026-11-02', total_days: 1,
  is_half_day: false, half_day_period: null, reason: 'x', attachment_url: null, status, created_at: '2026-10-24', updated_at: '2026-10-24',
  hr_leave_types: { id: 'lt-1', name: 'Annual', color: '#000' }, users: { id: 'emp-1', full_name: 'E One' }, hr_leave_approvals: [],
})

describe('SupabaseLeaveRepository.updateLeaveRequestStatus (B2A)', () => {
  beforeEach(() => { fake = createFakeSupabase() })
  const repo = () => new SupabaseLeaveRepository('org-1', 'mgr-1')

  it('refuses a decision on a row hidden by row-level security (no error, no row) instead of reporting success', async () => {
    fake.results.hr_leave_requests = { data: [], error: null }
    await expect(repo().updateLeaveRequestStatus('req-1', 'approved')).rejects.toThrow(/not authorized/)
    expect(fake.callsTo('hr_leave_approvals', 'insert')).toHaveLength(0)
  })

  it('maps the database guard refusal (self-approval) to its message', async () => {
    fake.results.hr_leave_requests = { data: null, error: { message: 'hr_leave_self_approval', code: '42501' } }
    await expect(repo().updateLeaveRequestStatus('req-1', 'approved')).rejects.toThrow(LEAVE_ERROR_MESSAGES.hr_leave_self_approval)
  })

  it('sends only the decision (never approved_by / approved_at) and returns the stored row', async () => {
    fake.results.hr_leave_requests = [{ data: [{ id: 'req-1' }], error: null }, { data: row('approved'), error: null }]
    fake.results.hr_leave_approvals = { data: null, error: null }
    const saved = await repo().updateLeaveRequestStatus('req-1', 'approved', 'ok')
    const update = fake.callsTo('hr_leave_requests', 'update')[0][2] as Record<string, unknown>
    expect(update).toEqual({ status: 'approved', approval_comment: 'ok' })
    expect(saved.status).toBe('approved')
    expect(saved.approvalStepRecorded).toBeUndefined()
  })

  it('keeps a saved decision but flags a refused approval-history step (never silently dropped)', async () => {
    fake.results.hr_leave_requests = [{ data: [{ id: 'req-1' }], error: null }, { data: row('rejected'), error: null }]
    fake.results.hr_leave_approvals = { data: null, error: { message: 'new row violates row-level security policy' } }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const saved = await repo().updateLeaveRequestStatus('req-1', 'rejected')
    expect(saved.status).toBe('rejected')
    expect(saved.approvalStepRecorded).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('SupabaseLeaveRepository.createLeaveRequest (B2A)', () => {
  beforeEach(() => { fake = createFakeSupabase() })

  it('files the request for the signed-in employee in the home organization, as pending', async () => {
    fake.results.hr_leave_requests = { data: row('pending'), error: null }
    await new SupabaseLeaveRepository('org-home', 'emp-1').createLeaveRequest({
      employeeId: 'someone-else', employeeName: '', employeeAvatar: null, departmentId: '', departmentName: '', leaveTypeId: 'lt-1',
      leaveTypeName: '', leaveTypeColor: '', startDate: '2026-11-02', endDate: '2026-11-02', totalDays: 1, isHalfDay: false,
      halfDayPeriod: null, reason: 'x', attachmentUrl: null,
    } as any)
    const insert = fake.callsTo('hr_leave_requests', 'insert')[0][2] as Record<string, unknown>
    expect(insert).toMatchObject({ organization_id: 'org-home', employee_id: 'emp-1', status: 'pending' })
    expect(insert).not.toHaveProperty('approved_by')
  })

  it('explains the refusal when the employment record is in another company (hr_onboarding_pending)', async () => {
    fake.results.hr_leave_requests = { data: null, error: { message: 'hr_onboarding_pending', details: 'hr_leave_requests: employee … organization …' } }
    await expect(new SupabaseLeaveRepository('org-home', 'emp-1').createLeaveRequest({ leaveTypeId: 'lt-1' } as any))
      .rejects.toThrow(/no completed HR employment record in this company/)
  })
})
