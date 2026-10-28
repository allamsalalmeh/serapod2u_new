import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase } from '@/lib/hr/test-support/fakeSupabase'

let fake = createFakeSupabase()
let admin = createFakeSupabase()
const hrCan = vi.fn()
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => admin.client }))
vi.mock('@/lib/server/hrAccess', () => ({
  getHrAuthContext: async () => ({ success: true, data: { userId: 'approver', organizationId: 'org-1', roleCode: 'HR_MANAGER', roleLevel: 30 } }),
  hrCan: (...a: unknown[]) => hrCan(...a),
}))

const params = { params: Promise.resolve({ id: 'run-1' }) }
const ok = (data: unknown) => ({ data, error: null })

beforeEach(() => {
  hrCan.mockReset().mockResolvedValue(true)
  fake = createFakeSupabase({
    hr_payroll_runs: ok({ id: 'run-1', status: 'calculated', calculated_by: 'preparer' }),
    hr_settings: ok({ config: {} }),
    hr_payroll_audit: ok(null),
  })
  admin = createFakeSupabase({ hr_payroll_runs: ok({ id: 'run-1', status: 'approved' }), hr_payroll_run_items: ok(null) })
})

describe('POST /api/hr/payroll/runs/:id/approve', () => {
  it('is blocked while the statutory calculation is not certified (no write at all)', async () => {
    const { POST } = await import('./route')
    const res = await POST({} as any, params)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ success: false, error: 'PAYROLL_STATUTORY_NOT_CERTIFIED' })
    expect(admin.calls).toEqual([])
    expect(fake.callsTo('hr_payroll_audit')).toEqual([])
  })

  it('a string "true" or a settings read error is not certification', async () => {
    fake.results.hr_settings = ok({ config: { payroll: { statutory_certified: 'true' } } })
    const { POST } = await import('./route')
    expect((await POST({} as any, params)).status).toBe(409)
    fake.results.hr_settings = { data: null, error: { message: 'x' } }
    expect((await POST({} as any, params)).status).toBe(409)
    expect(admin.calls).toEqual([])
  })

  it('approves only once certified, and audits with actor_user_id/metadata', async () => {
    fake.results.hr_settings = ok({ config: { payroll: { statutory_certified: true } } })
    const { POST } = await import('./route')
    const res = await POST({} as any, params)
    expect(res.status).toBe(200)
    expect(admin.callsTo('hr_payroll_runs', 'update')[0][2]).toMatchObject({ status: 'approved', approved_by: 'approver', is_locked: true })
    expect(fake.callsTo('hr_payroll_audit', 'insert')[0][2]).toMatchObject({ actor_user_id: 'approver', action: 'approve', metadata: expect.any(Object) })
    expect(fake.callsTo('hr_payroll_audit', 'insert')[0][2]).not.toHaveProperty('performed_by')
  })

  it('requires hr.payroll.approve', async () => {
    hrCan.mockResolvedValue(false)
    const { POST } = await import('./route')
    expect((await POST({} as any, params)).status).toBe(403)
  })
})
