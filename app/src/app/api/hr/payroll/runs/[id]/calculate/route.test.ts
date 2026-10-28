import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase } from '@/lib/hr/test-support/fakeSupabase'

let fake = createFakeSupabase()
const hrCan = vi.fn()
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }))
vi.mock('@/lib/server/hrAccess', () => ({
  getHrAuthContext: async () => ({ success: true, data: { userId: 'preparer', organizationId: 'org-1', roleCode: 'HR_MANAGER', roleLevel: 30 } }),
  hrCan: (...a: unknown[]) => hrCan(...a),
}))

const params = { params: Promise.resolve({ id: 'run-1' }) }
const ok = (data: unknown) => ({ data, error: null })

beforeEach(() => {
  hrCan.mockReset().mockResolvedValue(true)
  fake = createFakeSupabase({
    hr_payroll_runs: [ok({ id: 'run-1', status: 'draft', period_start: '2026-10-01', period_end: '2026-10-31' }), ok({ id: 'run-1', status: 'calculated' })],
    hr_settings: ok({ config: { statutory_rates: { epf_employee_rate: 11 } } }),
    hr_employee_compensation: ok([
      { employee_id: 'emp-1', basic_salary: 3000, hourly_rate: null, ot_eligible: null, effective_date: '2026-01-01', end_date: null },
      { employee_id: 'leaver', basic_salary: 5000, hourly_rate: null, ot_eligible: null, effective_date: '2026-01-01', end_date: null },
    ]),
    hr_employees: ok([
      { user_id: 'emp-1', onboarding_status: 'completed', status: 'active', end_date: null },
      { user_id: 'leaver', onboarding_status: 'completed', status: 'resigned', end_date: '2026-09-30' },
    ]),
    hr_employee_allowances: ok([{ amount: 200 }]),
    hr_employee_deductions: ok([]),
    hr_timesheets: ok([{ total_minutes: 9600, overtime_minutes: 0 }]),
    hr_payroll_run_items: [ok(null), ok([{ id: 'line-1' }])],
    hr_payroll_audit: ok(null),
  })
})

describe('POST /api/hr/payroll/runs/:id/calculate (fail-closed)', () => {
  it('requires hr.payroll.prepare', async () => {
    hrCan.mockResolvedValue(false)
    const { POST } = await import('./route')
    expect((await POST({} as any, params)).status).toBe(403)
    expect(fake.callsTo('hr_payroll_run_items')).toEqual([])
  })

  it('writes real columns, excludes the leaver and records the audit with actor_user_id', async () => {
    const { POST } = await import('./route')
    const res = await POST({} as any, params)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ success: true, provisional: true, statutoryCertified: false, excluded: [{ employee_user_id: 'leaver', reason: 'left_before_period' }] })
    const insert = fake.callsTo('hr_payroll_run_items', 'insert')[0][2] as any[]
    expect(insert).toHaveLength(1)
    expect(insert[0]).toMatchObject({ employee_user_id: 'emp-1', organization_id: 'org-1', payroll_run_id: 'run-1', gross_amount: 3200 })
    expect(insert[0]).not.toHaveProperty('employee_id')
    const update = fake.callsTo('hr_payroll_runs', 'update')[0][2] as any
    expect(update).toMatchObject({ status: 'calculated', total_gross: 3200, calculated_by: 'preparer' })
    expect(update).not.toHaveProperty('employee_count')
    expect(fake.callsTo('hr_settings', 'eq')).toEqual([['hr_settings', 'eq', 'organization_id', 'org-1']])  // no config_key
    expect(fake.callsTo('hr_timesheets', 'select')[0][2]).toBe('total_minutes, overtime_minutes')
    expect(fake.callsTo('hr_payroll_audit', 'insert')[0][2]).toMatchObject({ actor_user_id: 'preparer', action: 'calculate', metadata: expect.objectContaining({ provisional: true }) })
  })

  it('a read error for one employee fails the whole run: no lines, no totals, run stays draft', async () => {
    fake.results.hr_employee_allowances = { data: null, error: { message: 'boom' } }
    const { POST } = await import('./route')
    const res = await POST({} as any, params)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ success: false, error: 'PAYROLL_CALCULATION_FAILED', errors: [{ employee_user_id: 'emp-1', step: 'allowances' }] })
    expect(fake.callsTo('hr_payroll_run_items', 'insert')).toEqual([])
    expect(fake.callsTo('hr_payroll_run_items', 'delete')).toEqual([])
    expect(fake.callsTo('hr_payroll_runs', 'update')).toEqual([])
  })

  it('a partial line write is a failure (run not marked calculated)', async () => {
    fake.results.hr_payroll_run_items = [ok(null), ok([])]
    const { POST } = await import('./route')
    const res = await POST({} as any, params)
    expect(res.status).toBe(422)
    expect(fake.callsTo('hr_payroll_runs', 'update')).toEqual([])
  })

  it('refuses two active compensation records for one employee', async () => {
    fake.results.hr_employee_compensation = ok([
      { employee_id: 'emp-1', basic_salary: 3000, effective_date: '2026-01-01', end_date: null },
      { employee_id: 'emp-1', basic_salary: 3500, effective_date: '2026-06-01', end_date: null },
    ])
    const { POST } = await import('./route')
    const res = await POST({} as any, params)
    expect(res.status).toBe(422)
    expect(fake.callsTo('hr_payroll_run_items', 'insert')).toEqual([])
  })
})
