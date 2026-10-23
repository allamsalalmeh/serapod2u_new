import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const rpc = vi.fn()
const getUserById = vi.fn()
const deleteUser = vi.fn()
const auditInsert = vi.fn(async () => ({ error: null }))
let sessionUser: { id: string } | null = { id: 'admin-1' }

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: sessionUser }, error: sessionUser ? null : { message: 'no session' } }) },
  })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: (...args: unknown[]) => rpc(...args),
    auth: { admin: { getUserById: (...a: unknown[]) => getUserById(...a), deleteUser: (...a: unknown[]) => deleteUser(...a) } },
    from: () => ({ insert: auditInsert }),
  }),
}))

const TARGET = '00000000-0000-0000-0000-00000000e001'
const REQ = '00000000-0000-0000-0000-00000000f001'
const post = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/identity/permanent-delete', { method: 'POST', body: JSON.stringify(body) })
const valid = { user_id: TARGET, entry: 'hr', request_id: REQ, preview_token: 'tok', reason: 'Pre-go-live test account clean-up', confirmation: 'test@example.test' }
const completed = { data: { status: 'completed', deletion_id: 'd-1', removed: [{ table: 'users', count: 1 }] }, error: null }

describe('permanent identity deletion route (User Management + HR share it)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionUser = { id: 'admin-1' }
    rpc.mockReset()
    getUserById.mockResolvedValue({ data: { user: null }, error: { status: 404, message: 'User not found' } })
    deleteUser.mockResolvedValue({ error: null })
  })

  it('refuses without a session', async () => {
    sessionUser = null
    const { POST, GET } = await import('./route')
    expect((await POST(post(valid))).status).toBe(401)
    expect((await GET(new NextRequest(`http://localhost/api/identity/permanent-delete?entry=hr&user_id=${TARGET}`))).status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('preview is decided by the database for the session actor; a refusal is a 403 without target details', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'sa_authorization_required' } })
    const { GET } = await import('./route')
    const res = await GET(new NextRequest(`http://localhost/api/identity/permanent-delete?entry=user_management&user_id=${TARGET}&actor=someone`))
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json.code).toBe('FORBIDDEN')
    expect(json.data).toBeUndefined()
    expect(rpc).toHaveBeenCalledWith('identity_deletion_preview', { p_actor: 'admin-1', p_user: TARGET, p_entry: 'user_management' })
  })

  it('preview explains every blocker and labels cleanup', async () => {
    rpc.mockResolvedValue({ data: { allowed: false, preview_token: 't', confirmation_phrase: 'x', cleanup: [{ table: 'hr_employees', column: 'user_id', count: 1 }], retained: [],
      blockers: [{ code: 'PROTECTED_RECORDS', category: 'supply_chain', table: 'orders', column: 'created_by', count: 2 }, { code: 'SELF' }] }, error: null })
    const { GET } = await import('./route')
    const json = await (await GET(new NextRequest(`http://localhost/api/identity/permanent-delete?entry=hr&user_id=${TARGET}`))).json()
    expect(json.data.blockers[0].message).toContain('2 Supply Chain records')
    expect(json.data.blockers[1].message).toContain('your own account')
    expect(json.data.cleanup[0].label).toContain('HR employment record')
  })

  it('actor check without user_id', async () => {
    rpc.mockResolvedValue({ data: { permission: true }, error: null })
    const { GET } = await import('./route')
    const json = await (await GET(new NextRequest('http://localhost/api/identity/permanent-delete?entry=hr'))).json()
    expect(json.data.permission).toBe(true)
    expect(rpc).toHaveBeenCalledWith('identity_deletion_actor_check', { p_actor: 'admin-1', p_entry: 'hr' })
  })

  it('rejects an unknown entry, missing fields, a short reason and a blank confirmation before the database', async () => {
    const { POST, GET } = await import('./route')
    expect((await GET(new NextRequest(`http://localhost/api/identity/permanent-delete?entry=payroll&user_id=${TARGET}`))).status).toBe(400)
    expect((await POST(post({ ...valid, entry: 'payroll' }))).status).toBe(400)
    expect((await POST(post({ ...valid, request_id: 'x' }))).status).toBe(400)
    expect((await POST(post({ ...valid, reason: 'short' }))).status).toBe(400)
    expect((await POST(post({ ...valid, confirmation: '  ' }))).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('execute passes the session actor (never body values) and reports success only after the login is verified gone', async () => {
    rpc.mockResolvedValueOnce(completed).mockResolvedValue({ data: null, error: null })
    const { POST } = await import('./route')
    const res = await POST(post({ ...valid, actor_id: 'someone-else' }))
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenNthCalledWith(1, 'identity_deletion_execute', {
      p_actor: 'admin-1', p_user: TARGET, p_entry: 'hr', p_request_id: REQ, p_preview_token: 'tok',
      p_reason: 'Pre-go-live test account clean-up', p_confirmation: 'test@example.test',
    })
    expect(getUserById).toHaveBeenCalledWith(TARGET)
    expect(rpc).toHaveBeenCalledWith('identity_deletion_record_auth_check', { p_request_id: REQ, p_verified: true, p_detail: null })
    expect((await res.json()).data.authVerified).toBe(true)
  })

  it('a login still present after the transaction is deleted through the admin API, then re-verified', async () => {
    rpc.mockResolvedValueOnce(completed).mockResolvedValue({ data: null, error: null })
    getUserById.mockResolvedValueOnce({ data: { user: { id: TARGET } }, error: null })
    const { POST } = await import('./route')
    expect((await POST(post(valid))).status).toBe(200)
    expect(deleteUser).toHaveBeenCalledWith(TARGET)
  })

  it('never reports success when the login cannot be confirmed removed', async () => {
    rpc.mockResolvedValueOnce(completed).mockResolvedValue({ data: null, error: null })
    getUserById.mockResolvedValue({ data: { user: { id: TARGET } }, error: null })
    deleteUser.mockResolvedValue({ error: { message: 'gotrue down' } })
    const { POST } = await import('./route')
    const res = await POST(post(valid))
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.code).toBe('AUTH_CLEANUP_REQUIRED')
    expect(rpc).toHaveBeenCalledWith('identity_deletion_record_auth_check', expect.objectContaining({ p_verified: false }))
  })

  it('an unreachable auth service is not success either', async () => {
    rpc.mockResolvedValueOnce(completed).mockResolvedValue({ data: null, error: null })
    getUserById.mockResolvedValue({ data: null, error: { status: 500, message: 'timeout' } })
    const { POST } = await import('./route')
    expect((await POST(post(valid))).status).toBe(502)
  })

  it('blocked and stale outcomes are never success', async () => {
    const { POST } = await import('./route')
    rpc.mockResolvedValueOnce({ data: { status: 'blocked', deletion_id: 'd-2', blockers: [{ code: 'PROTECTED_RECORDS', category: 'payroll', count: 1 }] }, error: null })
    const blocked = await POST(post(valid))
    expect(blocked.status).toBe(409)
    const json = await blocked.json()
    expect(json.success).toBe(false)
    expect(json.data.blockers[0].message).toContain('payroll')
    rpc.mockResolvedValueOnce({ data: { status: 'stale' }, error: null })
    expect((await POST(post(valid))).status).toBe(409)
    expect(getUserById).not.toHaveBeenCalled()
  })

  it('maps database refusals to clear errors and audits the attempt', async () => {
    const { POST } = await import('./route')
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'identity_deletion_confirmation_mismatch' } })
    const res = await POST(post(valid))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('CONFIRMATION_MISMATCH')
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Could not find the function public.identity_deletion_execute' } })
    expect((await POST(post(valid))).status).toBe(503)
    expect(auditInsert).toHaveBeenCalledWith(expect.objectContaining({ operation: 'identity_permanent_delete', allowed: false }))
  })
})
