import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase } from '@/lib/hr/test-support/fakeSupabase'

let fake = createFakeSupabase()
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }))
vi.mock('@/lib/server/attendanceAccess', () => ({
  getAttendanceAuthContext: async () => ({ success: true, data: { userId: 'emp-1', organizationId: 'org-1' } }),
  attendanceCan: async () => false,
  canManageAttendance: async () => false,
}))

const ok = (data: unknown) => ({ data, error: null })
const req = (body: unknown) => ({ json: async () => body, url: 'http://x/api' }) as any

beforeEach(() => {
  fake = createFakeSupabase({
    hr_timesheets: [ok(null), ok({ id: 'ts-1', status: 'draft' })],
    hr_attendance_entries: ok([
      { worked_minutes: 480, overtime_minutes: 30, attendance_flag: 'late', clock_in_at: '2026-10-01T01:00:00Z' },
      { worked_minutes: 450, overtime_minutes: 0, attendance_flag: null, clock_in_at: '2026-10-02T01:00:00Z' },
    ]),
  })
})

describe('POST /api/hr/attendance/timesheets (generate)', () => {
  it('upserts only real columns and returns derived counters', async () => {
    const { POST } = await import('./route')
    const res = await POST(req({ period_start: '2026-10-01', period_end: '2026-10-31' }))
    expect(res.status).toBe(200)
    expect((await res.json()).summary).toEqual({ days_worked: 2, late_count: 1, early_leave_count: 0 })
    const row = fake.callsTo('hr_timesheets', 'upsert')[0][2] as any
    expect(row).toEqual({
      user_id: 'emp-1', organization_id: 'org-1', period_start: '2026-10-01', period_end: '2026-10-31', period_type: 'monthly',
      total_minutes: 930, overtime_minutes: 30, status: 'draft',
    })
  })

  it('never resets an approved timesheet to draft', async () => {
    fake.results.hr_timesheets = ok({ id: 'ts-1', status: 'approved' })
    const { POST } = await import('./route')
    const res = await POST(req({ period_start: '2026-10-01', period_end: '2026-10-31' }))
    expect(res.status).toBe(409)
    expect(fake.callsTo('hr_timesheets', 'upsert')).toEqual([])
  })

  it('validates the period', async () => {
    const { POST } = await import('./route')
    expect((await POST(req({ period_start: '2026-10-31', period_end: '2026-10-01' }))).status).toBe(400)
  })
})
