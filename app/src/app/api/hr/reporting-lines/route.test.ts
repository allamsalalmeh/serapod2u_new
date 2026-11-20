import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { resetWave2, sessionClient, wave2 } from '@/lib/hr/test-support/wave2Mocks'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => sessionClient()) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: wave2.rpc }) }))

const E = '00000000-0000-0000-0000-00000000e004'
const M = '00000000-0000-0000-0000-00000000a005'
const N = '00000000-0000-0000-0000-00000000a006'
const OTHER_ORG = '00000000-0000-0000-0000-000000000003'
const get = async (q = '') => (await import('./route')).GET(new NextRequest(`http://localhost/api/hr/reporting-lines${q}`))
const post = async (body: unknown) => (await import('./route')).POST(new NextRequest('http://localhost/api/hr/reporting-lines', { method: 'POST', body: JSON.stringify(body) }))

describe('/api/hr/reporting-lines (Wave 2)', () => {
  beforeEach(resetWave2)
  it('review defaults to the caller\'s organization', async () => {
    wave2.rpc.mockResolvedValue({ data: [{ employee_user_id: E, issue_code: 'MANAGER_INACTIVE' }], error: null })
    const res = await get()
    expect(res.status).toBe(200)
    expect(wave2.rpc).toHaveBeenCalledWith('hr_reporting_line_review_for', { p_actor: wave2.sessionUser!.id, p_org: wave2.organizationId })
  })
  it('another organization is only what the DATABASE scope allows (refusal → 403)', async () => {
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'sa_authorization_required' } })
    expect((await get(`?organization_id=${OTHER_ORG}`)).status).toBe(403)
    expect(wave2.rpc).toHaveBeenCalledWith('hr_reporting_line_review_for', { p_actor: wave2.sessionUser!.id, p_org: OTHER_ORG })
  })
  it('set: passes session actor, employee, manager and reason', async () => {
    wave2.rpc.mockResolvedValue({ data: { status: 'changed' }, error: null })
    expect((await post({ action: 'set', employee_user_id: E, manager_user_id: M, reason: 'Manager left' })).status).toBe(200)
    expect(wave2.rpc).toHaveBeenCalledWith('hr_set_reporting_line', { p_actor: wave2.sessionUser!.id, p_employee_user: E, p_manager_user: M, p_reason: 'Manager left' })
  })
  it('reassign: subset of direct reports', async () => {
    wave2.rpc.mockResolvedValue({ data: { status: 'reassigned', count: 1 }, error: null })
    expect((await post({ action: 'reassign', from_manager_user_id: M, to_manager_user_id: N, employee_user_ids: [E], reason: 'Team split' })).status).toBe(200)
    expect(wave2.rpc).toHaveBeenCalledWith('hr_reassign_direct_reports', { p_actor: wave2.sessionUser!.id, p_from_manager: M, p_to_manager: N, p_reason: 'Team split', p_employee_users: [E] })
  })
  it.each([
    [{ action: 'set', employee_user_id: E, manager_user_id: M, reason: '' }, 'REASON_REQUIRED'],
    [{ action: 'set', employee_user_id: 'x', manager_user_id: M, reason: 'Manager left' }, 'INVALID_INPUT'],
    [{ action: 'reassign', from_manager_user_id: M, employee_user_ids: [], reason: 'Team split' }, 'INVALID_INPUT'],
    [{ action: 'delete', reason: 'Not supported' }, 'INVALID_INPUT'],
  ])('refuses invalid requests before the database (%#)', async (body, code) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe(code)
    expect(wave2.rpc).not.toHaveBeenCalled()
  })
  it('an archived manager is refused with a clear message', async () => {
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'hr_manager_inactive' } })
    const json = await (await post({ action: 'set', employee_user_id: E, manager_user_id: M, reason: 'Manager left' })).json()
    expect(json).toMatchObject({ success: false, code: 'MANAGER_INVALID' })
    expect(json.error).toMatch(/former or inactive/)
  })
})
