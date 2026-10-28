import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const rpc = vi.fn()
let sessionUser: { id: string } | null = { id: 'admin-1' }

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser }, error: sessionUser ? null : { message: 'no session' } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'admin-1', organization_id: 'org-a' }, error: null }) }) }) }),
  })),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc }) }))

const EMP = '00000000-0000-0000-0000-00000000e001'
const REQ = '00000000-0000-0000-0000-00000000f001'
const post = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/hr/employees/registration', { method: 'POST', body: JSON.stringify(body) })
const valid = { user_id: EMP, action: 'delete', request_id: REQ, preview_token: 'tok', reason: 'Incorrectly onboarded test record' }

describe('HR employee registration delete/reset route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionUser = { id: 'admin-1' }
  })

  it('refuses without a session', async () => {
    sessionUser = null
    const { POST } = await import('./route')
    expect((await POST(post(valid))).status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('preview: always the caller\'s own organization; the database refusal is returned', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'sa_authorization_required' } })
    const { GET } = await import('./route')
    const res = await GET(new NextRequest(`http://localhost/api/hr/employees/registration?user_id=${EMP}&organization_id=org-b`))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('FORBIDDEN')
    expect(rpc).toHaveBeenCalledWith('hr_employee_registration_preview', { p_actor: 'admin-1', p_org: 'org-a', p_user: EMP })
  })

  it('preview: another organization\'s employee is "not found"', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'hr_employee_not_in_organization' } })
    const { GET } = await import('./route')
    const res = await GET(new NextRequest(`http://localhost/api/hr/employees/registration?user_id=${EMP}`))
    expect(res.status).toBe(404)
  })

  it('preview adds a friendly explanation to every blocker', async () => {
    rpc.mockResolvedValue({ data: { delete_allowed: false, reset_allowed: true, preview_token: 't',
      blockers: { delete: [{ code: 'HR_RECORDS', category: 'leave', count: 2 }, { code: 'DIRECT_REPORTS', count: 1 }], reset: [] } }, error: null })
    const { GET } = await import('./route')
    const json = await (await GET(new NextRequest(`http://localhost/api/hr/employees/registration?user_id=${EMP}`))).json()
    expect(json.data.blockers.delete[0].message).toContain('2 leave requests')
    expect(json.data.blockers.delete[1].message).toContain('report to this person')
  })

  it('execute passes the session actor and organization (never body values), token, request id and reason', async () => {
    rpc.mockResolvedValue({ data: { status: 'completed', action_id: 'a-1', new_status: 'pending', employee_no: 7 }, error: null })
    const { POST } = await import('./route')
    const res = await POST(post({ ...valid, actor_id: 'someone-else', organization_id: 'org-b' }))
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('hr_employee_registration_execute', {
      p_actor: 'admin-1', p_org: 'org-a', p_user: EMP, p_action: 'delete', p_request_id: REQ, p_preview_token: 'tok',
      p_reason: 'Incorrectly onboarded test record',
    })
  })

  it('execute rejects an unknown action, a short reason and a missing request id before the database', async () => {
    const { POST } = await import('./route')
    expect((await POST(post({ ...valid, action: 'purge' }))).status).toBe(400)
    expect((await POST(post({ ...valid, reason: 'short' }))).status).toBe(400)
    expect((await POST(post({ ...valid, request_id: 'x' }))).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('execute never reports success for blocked or stale outcomes', async () => {
    const { POST } = await import('./route')
    rpc.mockResolvedValueOnce({ data: { status: 'blocked', blockers: [{ code: 'HR_RECORDS', category: 'payroll', count: 1 }] }, error: null })
    const blocked = await POST(post(valid))
    expect(blocked.status).toBe(409)
    const body = await blocked.json()
    expect(body.success).toBe(false)
    expect(body.code).toBe('BLOCKED')
    rpc.mockResolvedValueOnce({ data: { status: 'stale', message: 'changed' }, error: null })
    expect((await POST(post(valid))).status).toBe(409)
  })

  it('maps self, lock timeout and missing installation to caller-safe errors', async () => {
    const { POST } = await import('./route')
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'hr_employee_registration_self_prohibited' } })
    expect((await (await POST(post(valid))).json()).code).toBe('SELF')
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'canceling statement due to lock timeout' } })
    expect((await (await POST(post(valid))).json()).code).toBe('BUSY')
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Could not find the function public.hr_employee_registration_execute' } })
    expect((await POST(post(valid))).status).toBe(503)
  })
})
