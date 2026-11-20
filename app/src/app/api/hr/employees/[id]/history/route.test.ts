import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { resetWave2, sessionClient, wave2 } from '@/lib/hr/test-support/wave2Mocks'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => sessionClient()) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: wave2.rpc }) }))

const EMP = '00000000-0000-0000-0000-00000000e002'
const call = async (id = EMP) => (await import('./route')).GET(new NextRequest(`http://localhost/api/hr/employees/${id}/history`), { params: Promise.resolve({ id }) })

describe('GET /api/hr/employees/:id/history (Wave 2)', () => {
  beforeEach(resetWave2)
  it('refuses without a session and never calls the database', async () => {
    wave2.sessionUser = null
    expect((await call()).status).toBe(401)
    expect(wave2.rpc).not.toHaveBeenCalled()
  })
  it('passes the SESSION actor to the database, which decides', async () => {
    wave2.rpc.mockResolvedValue({ data: [{ version_no: 2, change_kind: 'transfer' }], error: null })
    const res = await call()
    expect(res.status).toBe(200)
    expect((await res.json()).data[0].change_kind).toBe('transfer')
    expect(wave2.rpc).toHaveBeenCalledWith('hr_employee_history', { p_actor: wave2.sessionUser!.id, p_employee_user: EMP })
  })
  it('returns the database refusal as 403 with a clear message (fail closed)', async () => {
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'sa_authorization_required' } })
    const res = await call()
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('FORBIDDEN')
  })
  it('rejects a malformed id', async () => {
    expect((await call('not-a-uuid')).status).toBe(400)
  })
  it('reports a missing migration as unavailable (503)', async () => {
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'Could not find the function public.hr_employee_history' } })
    expect((await call()).status).toBe(503)
  })
})
