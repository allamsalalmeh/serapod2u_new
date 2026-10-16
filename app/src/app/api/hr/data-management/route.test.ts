import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const rpc = vi.fn()
let sessionUser: { id: string } | null = { id: 'sa-1' }

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser }, error: sessionUser ? null : { message: 'no session' } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'sa-1', organization_id: 'org-a' }, error: null }) }) }) }),
  })),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc }) }))

const ORG = '00000000-0000-0000-0000-00000000a001'
const REQ = '00000000-0000-0000-0000-00000000f001'
const execute = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/hr/data-management/execute', { method: 'POST', body: JSON.stringify(body) })
const valid = { organization_id: ORG, kind: 'full', request_id: REQ, preview_token: 'tok', reason: 'Clean HR test data', confirmation: 'RESET ALL HR DATA HQA' }

describe('HR Data Management routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionUser = { id: 'sa-1' }
  })

  it('preview: the database decides authorization and its refusal is returned (no data)', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'hr_reset_permission_required' } })
    const { POST } = await import('./route')
    const res = await POST(new NextRequest('http://localhost/api/hr/data-management', { method: 'POST', body: JSON.stringify({ organization_id: ORG, kind: 'onboarding' }) }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('RESET_PERMISSION_REQUIRED')
    expect(rpc).toHaveBeenCalledWith('hr_reset_preview', { p_actor: 'sa-1', p_org: ORG, p_kind: 'onboarding' })
  })

  it('preview rejects an unknown reset kind before reaching the database', async () => {
    const { POST } = await import('./route')
    const res = await POST(new NextRequest('http://localhost/api/hr/data-management', { method: 'POST', body: JSON.stringify({ organization_id: ORG, kind: 'everything' }) }))
    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('execute passes the session actor (never a body actor), token, request id, reason and confirmation', async () => {
    rpc.mockResolvedValue({ data: { status: 'completed', run_id: 'run-1', counts: { hr_leave_requests: 2 }, onboarding_reset: 3 }, error: null })
    const { POST } = await import('./execute/route')
    const res = await POST(execute({ ...valid, actor_id: 'someone-else' }))
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('hr_reset_execute', {
      p_actor: 'sa-1', p_org: ORG, p_kind: 'full', p_request_id: REQ, p_preview_token: 'tok',
      p_reason: 'Clean HR test data', p_confirmation: 'RESET ALL HR DATA HQA',
    })
  })

  it('execute reports a stale preview as a conflict', async () => {
    rpc.mockResolvedValue({ data: { status: 'stale', message: 'changed' }, error: null })
    const { POST } = await import('./execute/route')
    const res = await POST(execute(valid))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('PREVIEW_STALE')
  })

  it('execute reports blockers without claiming success', async () => {
    rpc.mockResolvedValue({ data: { status: 'blocked', blockers: [{ code: 'FINANCE_POSTED' }] }, error: null })
    const { POST } = await import('./execute/route')
    const res = await POST(execute(valid))
    const json = await res.json()
    expect(res.status).toBe(409)
    expect(json.success).toBe(false)
    expect(json.code).toBe('BLOCKED')
  })

  it('execute maps pre-go-live and Super Admin refusals', async () => {
    const { POST } = await import('./execute/route')
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'hr_reset_not_pre_go_live' } })
    expect((await (await POST(execute(valid))).json()).code).toBe('NOT_PRE_GO_LIVE')
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'hr_reset_requires_super_admin' } })
    expect((await POST(execute(valid))).status).toBe(403)
  })

  it('execute requires a reason, a request id and a session', async () => {
    const { POST } = await import('./execute/route')
    expect((await POST(execute({ ...valid, reason: 'short' }))).status).toBe(400)
    expect((await POST(execute({ ...valid, request_id: 'not-a-uuid' }))).status).toBe(400)
    sessionUser = null
    expect((await POST(execute(valid))).status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })
})
