import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeSupabase } from './test-support/fakeSupabase'

/** B2B: duplicate payroll GL route retired, broken auto-setup seeds retired, national-only holiday template. */
let fake = createFakeSupabase()
const hrCan = vi.fn()
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }))
vi.mock('@/lib/server/hrAccess', () => ({
  getHrAuthContext: async () => ({ success: true, data: { userId: 'hr-1', organizationId: 'org-1', roleCode: 'HR_MANAGER', roleLevel: 30 } }),
  hrCan: (...a: unknown[]) => hrCan(...a),
  canManageHr: async () => true,
}))
vi.mock('@/lib/server/hr/seedPermissions', () => ({ seedPermissionsCatalog: async () => {}, seedTemplateGroups: async () => 0 }))

const ok = (data: unknown) => ({ data, error: null })
const req = (body: unknown) => ({ json: async () => body, url: 'http://x/api' }) as any

beforeEach(() => {
  hrCan.mockReset().mockResolvedValue(true)
  fake = createFakeSupabase({
    users: ok({ organization_id: 'org-1', role_code: 'HR_MANAGER', roles: { role_level: 30 } }),  // both getOrgContext shapes
    roles: ok({ role_level: 30 }), hr_public_holidays: ok(null),
  })
})

describe('retired second payroll GL route', () => {
  it('returns 410 and never calls hr_post_payroll_run_to_gl', async () => {
    const { POST } = await import('@/app/api/hr/finance/post-payroll-run/route')
    const res = await POST(req({ run_id: 'run-1', amount: 100 }))
    expect(res.status).toBe(410)
    expect((await res.json()).error).toBe('PAYROLL_GL_ROUTE_RETIRED')
    expect(fake.calls.filter((c) => c[0] === 'rpc')).toEqual([])
  })
  it('still requires hr.payroll.release before saying so', async () => {
    hrCan.mockResolvedValue(false)
    const { POST } = await import('@/app/api/hr/finance/post-payroll-run/route')
    expect((await POST(req({ run_id: 'run-1' }))).status).toBe(403)
  })
})

describe('retired auto-setup seeds', () => {
  for (const action of ['default_leave_types', 'default_approval_chain', 'default_holidays_my', 'enable_overtime_ea1955']) {
    it(`${action} → 410 without writing`, async () => {
      const { POST } = await import('@/app/api/hr/config/audit/route')
      const res = await POST(req({ action }))
      expect(res.status).toBe(410)
      expect(fake.calls.filter((c) => ['insert', 'upsert', 'update', 'delete'].includes(c[1]))).toEqual([])
    })
  }
})

describe('public holiday template', () => {
  it('loads national holidays only, without the non-existent category column', async () => {
    const { POST } = await import('@/app/api/hr/public-holidays/route')
    const res = await POST(req({ action: 'load_template', year: 2026 }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.skippedState).toEqual(expect.arrayContaining(['Thaipusam', 'Federal Territory Day']))
    const rows = fake.callsTo('hr_public_holidays', 'insert')[0][2] as any[]
    expect(rows.length).toBe(body.count)
    expect(rows.map((r) => r.name)).not.toContain('Thaipusam')
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['date', 'is_recurring', 'name', 'organization_id'])
  })
  it('single create and update never send category', async () => {
    const { POST, PUT } = await import('@/app/api/hr/public-holidays/route')
    await POST(req({ name: 'Company Day', date: '2026-11-11', category: 'custom', state: 'SGR' }))
    expect(fake.callsTo('hr_public_holidays', 'insert')[0][2]).toEqual({ organization_id: 'org-1', name: 'Company Day', date: '2026-11-11', is_recurring: false, state: 'SGR' })
    await PUT(req({ id: 'h1', name: 'Renamed', category: 'national', organization_id: 'other-org' }))
    expect(fake.callsTo('hr_public_holidays', 'update')[0][2]).toEqual({ name: 'Renamed' })
  })
})
