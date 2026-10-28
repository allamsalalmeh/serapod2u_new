import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { resetWave2, sessionClient, wave2 } from '@/lib/hr/test-support/wave2Mocks'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => sessionClient()) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: wave2.rpc }) }))

const EMP = '00000000-0000-0000-0000-00000000e003'
const DEPT = '00000000-0000-0000-0000-00000000d001'
const post = async (body: unknown, id = EMP) => (await import('./route')).POST(
  new NextRequest(`http://localhost/api/hr/employees/${id}/employment`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
const valid = { changes: { department_id: DEPT }, effective_date: '2026-10-01', reason: 'Transfer to Sales' }

describe('POST /api/hr/employees/:id/employment (Wave 2)', () => {
  beforeEach(resetWave2)
  it('passes session actor, changes, effective date and reason to the database', async () => {
    wave2.rpc.mockResolvedValue({ data: { status: 'changed', version_no: 3, change_kind: 'transfer' }, error: null })
    const res = await post(valid)
    expect(res.status).toBe(200)
    expect(wave2.rpc).toHaveBeenCalledWith('hr_employment_change', {
      p_actor: wave2.sessionUser!.id, p_employee_user: EMP, p_changes: { department_id: DEPT }, p_effective_date: '2026-10-01', p_reason: 'Transfer to Sales',
    })
  })
  it.each([
    [{ ...valid, reason: 'x' }, 'REASON_REQUIRED'],
    [{ ...valid, changes: { hire_date: '2020-01-01' } }, 'FIELD_NOT_ALLOWED'],
    [{ ...valid, changes: {} }, 'INVALID_INPUT'],
    [{ ...valid, effective_date: '01/10/2026' }, 'INVALID_INPUT'],
    [{ ...valid, changes: { manager_user_id: 'bob' } }, 'INVALID_INPUT'],
  ])('refuses an invalid request before the database (%#)', async (body, code) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe(code)
    expect(wave2.rpc).not.toHaveBeenCalled()
  })
  it.each([
    ['hr_employment_archived_locked', 409], ['hr_manager_cycle', 400], ['hr_self_change_prohibited', 403], ['sa_authorization_required', 403],
  ])('maps the database refusal %s', async (code, status) => {
    wave2.rpc.mockResolvedValue({ data: null, error: { message: code } })
    const res = await post(valid)
    expect(res.status).toBe(status)
    expect((await res.json()).success).toBe(false)
  })
})
