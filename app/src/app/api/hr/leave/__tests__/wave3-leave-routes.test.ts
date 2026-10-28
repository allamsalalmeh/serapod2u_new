import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { ess, hrSelfCanMock, resetEss, resetWave2, sessionClient, wave2 } from '@/lib/hr/test-support/wave3Mocks'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => sessionClient()) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: wave2.rpc }) }))
vi.mock('@/lib/server/hrAccess', () => ({ hrSelfCan: (...a: unknown[]) => hrSelfCanMock(...a) }))

const E = '00000000-0000-0000-0000-00000000e001'
const T = '00000000-0000-0000-0000-0000000000a7'
const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body) })
const get = (url: string) => new NextRequest(`http://localhost${url}`)

beforeEach(() => { resetWave2(); resetEss() })

describe('Wave 3 leave routes', () => {
  it('quote: own quote (ESS), valid input only', async () => {
    const { GET } = await import('../quote/route')
    wave2.rpc.mockResolvedValue({ data: { working_days: 3 }, error: null })
    expect((await GET(get(`/api/hr/leave/quote?leave_type_id=${T}&start_date=2027-03-01&end_date=2027-03-03`))).status).toBe(200)
    expect(wave2.rpc).toHaveBeenCalledWith('hr_leave_quote', { p_actor: wave2.sessionUser!.id, p_type: T, p_start: '2027-03-01', p_end: '2027-03-03', p_half_day: false, p_exclude_request: null })
    expect((await GET(get(`/api/hr/leave/quote?leave_type_id=${T}&start_date=03/01/2027&end_date=2027-03-03`))).status).toBe(400)
    ess.allowed = false
    expect((await GET(get(`/api/hr/leave/quote?leave_type_id=${T}&start_date=2027-03-01&end_date=2027-03-03`))).status).toBe(403)
  })
  it('balances: mine (ESS) vs organization (database decides HR authority)', async () => {
    const { GET } = await import('../balances/route')
    wave2.rpc.mockResolvedValue({ data: {}, error: null })
    await GET(get('/api/hr/leave/balances?year=2027'))
    expect(wave2.rpc).toHaveBeenCalledWith('hr_leave_my_balances', { p_actor: wave2.sessionUser!.id, p_year: 2027 })
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'sa_authorization_required' } })
    expect((await GET(get('/api/hr/leave/balances?scope=organization&year=2027'))).status).toBe(403)
    expect(wave2.rpc).toHaveBeenLastCalledWith('hr_leave_balances_overview', { p_actor: wave2.sessionUser!.id, p_org: wave2.organizationId, p_year: 2027 })
    expect((await GET(get('/api/hr/leave/balances?year=99'))).status).toBe(400)
  })
  it('admin: reasons required; whole payload passed with the session actor; own record refused by the database', async () => {
    const { POST } = await import('../admin/route')
    expect((await (await POST(post('/api/hr/leave/admin', { action: 'adjust', employee_user_id: E, leave_type_id: T, year: 2027, delta: 1, reason: '' }))).json()).code).toBe('REASON_REQUIRED')
    wave2.rpc.mockResolvedValue({ data: { status: 'adjusted' }, error: null })
    expect((await POST(post('/api/hr/leave/admin', { action: 'adjust', employee_user_id: E, leave_type_id: T, year: 2027, delta: -0.5, reason: 'Correction of a mistake' }))).status).toBe(200)
    expect(wave2.rpc).toHaveBeenCalledWith('hr_leave_adjust', { p_actor: wave2.sessionUser!.id, p_employee: E, p_type: T, p_year: 2027, p_delta: -0.5, p_reason: 'Correction of a mistake' })
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'hr_self_change_prohibited' } })
    expect((await POST(post('/api/hr/leave/admin', { action: 'set_entitlement', employee_user_id: E, leave_type_id: T, year: 2027, days: 14, reason: 'Own record test' }))).status).toBe(403)
  })
  it('admin runs: preview without reason, apply needs a reason', async () => {
    const { POST } = await import('../admin/route')
    wave2.rpc.mockResolvedValue({ data: { dry_run: true, rows: [] }, error: null })
    expect((await POST(post('/api/hr/leave/admin', { action: 'entitlement_run', leave_type_id: T, year: 2027, dry_run: true }))).status).toBe(200)
    expect(wave2.rpc).toHaveBeenCalledWith('hr_leave_entitlement_run', { p_actor: wave2.sessionUser!.id, p_org: wave2.organizationId, p_type: T, p_year: 2027, p_dry_run: true, p_reason: null })
    expect((await POST(post('/api/hr/leave/admin', { action: 'carry_forward', leave_type_id: T, from_year: 2027, dry_run: false }))).status).toBe(400)
    await POST(post('/api/hr/leave/admin', { action: 'carry_forward', leave_type_id: T, from_year: 2027, dry_run: false, reason: 'Year-end close' }))
    expect(wave2.rpc).toHaveBeenLastCalledWith('hr_leave_carry_forward_run', { p_actor: wave2.sessionUser!.id, p_org: wave2.organizationId, p_type: T, p_from_year: 2027, p_dry_run: false, p_reason: 'Year-end close' })
  })
  it('ledger and unpaid days', async () => {
    wave2.rpc.mockResolvedValue({ data: [], error: null })
    const ledger = (await import('../ledger/route')).GET
    await ledger(get(`/api/hr/leave/ledger?employee_user_id=${E}&year=2027`))
    expect(wave2.rpc).toHaveBeenCalledWith('hr_leave_ledger_for', { p_actor: wave2.sessionUser!.id, p_employee: E, p_year: 2027 })
    const unpaid = (await import('../unpaid/route')).GET
    expect((await unpaid(get('/api/hr/leave/unpaid?from=2026-10-01'))).status).toBe(400)
    await unpaid(get('/api/hr/leave/unpaid?from=2026-10-01&to=2026-10-31'))
    expect(wave2.rpc).toHaveBeenLastCalledWith('hr_leave_unpaid_days', { p_actor: wave2.sessionUser!.id, p_org: wave2.organizationId, p_from: '2026-10-01', p_to: '2026-10-31' })
  })
})
