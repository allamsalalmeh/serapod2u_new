import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const rpc = vi.fn()
const auditInsert = vi.fn(async () => ({ error: null }))
let sessionUser: { id: string } | null = { id: 'admin-1' }

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: async () => ({ data: { user: sessionUser }, error: sessionUser ? null : { message: 'no session' } }) } })),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: (...a: unknown[]) => rpc(...a), from: () => ({ insert: auditInsert }) }) }))

const TARGET = '00000000-0000-0000-0000-00000000e001'
const REQ = '00000000-0000-0000-0000-00000000f001'
const post = (body: Record<string, unknown>) => new NextRequest('http://localhost/api/identity/archive', { method: 'POST', body: JSON.stringify(body) })
const archive = { action: 'archive', user_id: TARGET, entry: 'hr', request_id: REQ, preview_token: 'tok', reason: 'Resigned effective today', confirmation: 'x@example.test' }

describe('Archive & Revoke Access route (User Management + HR share it)', () => {
  beforeEach(() => { vi.clearAllMocks(); rpc.mockReset(); sessionUser = { id: 'admin-1' } })

  it('refuses without a session', async () => {
    sessionUser = null
    const { POST, GET } = await import('./route')
    expect((await POST(post(archive))).status).toBe(401)
    expect((await GET(new NextRequest(`http://localhost/api/identity/archive?entry=hr&user_id=${TARGET}`))).status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('preview is decided by the database for the session actor; blockers and warnings are explained', async () => {
    rpc.mockResolvedValue({ data: { archive_allowed: false, release_allowed: false, blockers: [{ code: 'PROTECTED_ROOT' }], warnings: [{ code: 'SESSIONS_REVOKED', count: 2 }] }, error: null })
    const { GET } = await import('./route')
    const json = await (await GET(new NextRequest(`http://localhost/api/identity/archive?entry=user_management&user_id=${TARGET}&actor=x`))).json()
    expect(rpc).toHaveBeenCalledWith('identity_archive_preview', { p_actor: 'admin-1', p_user: TARGET, p_entry: 'user_management' })
    expect(json.data.blockers[0].message).toContain('Root Access')
    expect(json.data.warnings[0].message).toContain('2 active sign-in session')
  })

  it('a database refusal is 403 without target details', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'sa_authorization_required' } })
    const { GET } = await import('./route')
    const res = await GET(new NextRequest(`http://localhost/api/identity/archive?entry=hr&user_id=${TARGET}`))
    expect(res.status).toBe(403)
    expect((await res.json()).data).toBeUndefined()
  })

  it('validates before the database', async () => {
    const { POST } = await import('./route')
    for (const bad of [{ ...archive, action: 'purge' }, { ...archive, confirmation: ' ' },
      { ...archive, employment_end: 'retired' }, { ...archive, release_identifiers: 'yes' }, { ...archive, request_id: 'x' },
      { ...archive, action: 'release', reason: 'short' }]) {
      expect((await POST(post(bad))).status).toBeGreaterThanOrEqual(400)
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it('archive accepts an empty (optional) reason and passes it through unchanged', async () => {
    rpc.mockResolvedValue({ data: { status: 'completed', action_id: 'a-0', release: { released: false } }, error: null })
    const { POST } = await import('./route')
    const res = await POST(post({ ...archive, reason: '' }))
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('identity_archive_execute', expect.objectContaining({ p_reason: '' }))
  })

  it('archive passes the session actor (never body values), release choice and employment end', async () => {
    rpc.mockResolvedValue({ data: { status: 'completed', action_id: 'a-1', release: { released: true }, login: { sessions_revoked: 1 } }, error: null })
    const { POST } = await import('./route')
    const res = await POST(post({ ...archive, actor_id: 'someone-else', release_identifiers: true, employment_end: 'terminated' }))
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('identity_archive_execute', {
      p_actor: 'admin-1', p_user: TARGET, p_entry: 'hr', p_request_id: REQ, p_preview_token: 'tok', p_reason: 'Resigned effective today',
      p_confirmation: 'x@example.test', p_release_identifiers: true, p_employment_end: 'terminated' })
    expect((await res.json()).data).toMatchObject({ status: 'completed', released: true })
  })

  it('release of an archived account', async () => {
    rpc.mockResolvedValue({ data: { status: 'completed', action_id: 'a-2', release: { released: true } }, error: null })
    const { POST } = await import('./route')
    const res = await POST(post({ action: 'release', user_id: TARGET, entry: 'user_management', request_id: REQ, reason: 'Released for a new hire' }))
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('identity_release_identifiers', { p_actor: 'admin-1', p_user: TARGET, p_entry: 'user_management', p_request_id: REQ, p_reason: 'Released for a new hire' })
  })

  it('blocked and stale are never success; errors are mapped and audited', async () => {
    const { POST } = await import('./route')
    rpc.mockResolvedValueOnce({ data: { status: 'blocked', blockers: [{ code: 'ALREADY_ARCHIVED' }] }, error: null })
    const blocked = await POST(post(archive))
    expect(blocked.status).toBe(409)
    expect((await blocked.json()).data.blockers[0].message).toContain('already archived')
    rpc.mockResolvedValueOnce({ data: { status: 'stale' }, error: null })
    expect((await POST(post(archive))).status).toBe(409)
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'Could not find the function public.identity_archive_execute' } })
    expect((await POST(post(archive))).status).toBe(503)
    expect(auditInsert).toHaveBeenCalledWith(expect.objectContaining({ operation: 'identity_archive', allowed: false }))
  })
})
