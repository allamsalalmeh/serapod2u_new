import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { resetWave2, sessionClient, wave2 } from '@/lib/hr/test-support/wave2Mocks'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => sessionClient()) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: wave2.rpc }) }))
vi.mock('@/lib/hr/onboarding', () => ({ completeOnboarding: vi.fn() }))
vi.mock('@/lib/server/hrAccess', () => ({ hrCan: vi.fn(async () => false) }))

const EMP = '00000000-0000-0000-0000-00000000e007'
const get = async (id = EMP) => (await import('./route')).GET(new NextRequest(`http://localhost/api/hr/employees/profile?user_id=${id}`))
const put = async (body: unknown) => (await import('./route')).PUT(new NextRequest('http://localhost/api/hr/employees/profile', { method: 'PUT', body: JSON.stringify(body) }))

describe('HR Profile sheet route (Wave 2: one source for statutory data, explicit HR authority)', () => {
  beforeEach(resetWave2)
  it('GET returns the merged sheet shape and the permissions the database computed', async () => {
    wave2.rpc.mockResolvedValue({ data: { organization_id: wave2.organizationId, profile: { city: 'Klang' }, statutory: { nric_no: '900101011234' },
      can_edit_personal: true, can_edit_all_personal: true, can_edit_statutory: true, self_fields: [], archived: false }, error: null })
    const json = await (await get()).json()
    expect(json.data.profile).toMatchObject({ city: 'Klang', ic_number: '900101011234' })
    expect(json.data.permissions).toMatchObject({ can_edit_statutory: true, archived: false })
    expect(wave2.rpc).toHaveBeenCalledWith('hr_employee_profile_get', { p_actor: wave2.sessionUser!.id, p_employee_user: EMP })
  })
  it('GET refusal is 403 (no legacy fallback in the route)', async () => {
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'sa_authorization_required' } })
    expect((await get()).status).toBe(403)
  })
  it('PUT by HR splits the sheet into personal and statutory sections', async () => {
    wave2.rpc.mockResolvedValue({ data: { status: 'saved' }, error: null })
    const res = await put({ user_id: EMP, ic_number: '900101-01-1234', city: 'Klang', tax_id: '' })
    expect(res.status).toBe(200)
    expect(wave2.rpc).toHaveBeenCalledWith('hr_employee_profile_save', {
      p_actor: wave2.sessionUser!.id, p_employee_user: EMP, p_personal: { city: 'Klang' },
      p_statutory: { nric_no: '900101011234', id_type: 'nric', income_tax_no: null }, p_reason: null,
    })
  })
  it('PUT refuses a malformed NRIC before the database', async () => {
    const res = await put({ user_id: EMP, ic_number: '1234' })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('INVALID_STATUTORY')
    expect(wave2.rpc).not.toHaveBeenCalled()
  })
  it('PUT by the employee sends only self-service fields (statutory and HR-only fields are dropped)', async () => {
    wave2.rpc.mockResolvedValue({ data: { status: 'saved' }, error: null })
    await put({ user_id: wave2.sessionUser!.id, ic_number: '900101-01-1234', notes: 'x', emergency_phone: '0123' })
    expect(wave2.rpc).toHaveBeenCalledWith('hr_employee_profile_save', expect.objectContaining({ p_personal: { emergency_phone: '0123' }, p_statutory: null }))
  })
  it('PUT on a former employee shows the read-only reason', async () => {
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'hr_employment_archived_locked' } })
    const res = await put({ user_id: EMP, city: 'Klang' })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('FORMER_EMPLOYEE')
  })
})
