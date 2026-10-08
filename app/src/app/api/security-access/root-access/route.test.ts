import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const ADMIN = '11111111-1111-4111-8111-111111111111'
const TARGET = '22222222-2222-4222-8222-222222222222'
const KEY = '33333333-3333-4333-8333-333333333333'

let actor: any
let rpcResult: { data: any; error: any }
const rpc = vi.fn(async (_fn: string, _args: any) => rpcResult)
const requireSecurityActor = vi.fn(async (_p: string) => actor)
vi.mock('@/lib/security-access/admin-api', () => ({ requireSecurityActor: (p: string) => requireSecurityActor(p) }))

const post = async (body: unknown) => {
  const { POST } = await import('./route')
  return POST({ json: async () => body } as any)
}
const grantBody = (extra: any = {}) => ({ action: 'grant', userId: TARGET, reason: 'Platform owner for the migration', confirmation: 'GRANT ROOT ACCESS', requestKey: KEY, ...extra })

describe('POST /api/security-access/root-access', () => {
  beforeEach(() => {
    rpc.mockClear(); requireSecurityActor.mockClear()
    actor = { userId: ADMIN, admin: { rpc } }
    rpcResult = { data: { ok: true, grant_id: 'g1', replayed: false, effective_until: null }, error: null }
  })

  it('requires an authenticated Security & Access viewer before anything else', async () => {
    actor = NextResponse.json({ error: 'Your session has expired. Sign in again.' }, { status: 401 })
    expect((await post(grantBody())).status).toBe(401)
    actor = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    expect((await post(grantBody())).status).toBe(403)
    expect(requireSecurityActor).toHaveBeenCalledWith('security.access.view')
    expect(rpc).not.toHaveBeenCalled()
  })

  it('grants through the database with the session actor, never an actor from the body', async () => {
    const res = await post(grantBody({ actorId: TARGET, p_actor: TARGET, permissions: ['*'], organizationId: TARGET }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, action: 'grant', grantId: 'g1', replayed: false })
    expect(rpc).toHaveBeenCalledWith('sa_grant_root_access', {
      p_actor: ADMIN, p_target: TARGET, p_reason: 'Platform owner for the migration', p_until: null, p_request_key: KEY,
    })
  })

  it('requires the typed confirmation, a reason and an idempotency key', async () => {
    let res = await post(grantBody({ confirmation: 'yes' }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('root_confirmation_required')
    res = await post(grantBody({ reason: 'short' }))
    expect(res.status).toBe(400)
    res = await post(grantBody({ requestKey: undefined }))
    expect(res.status).toBe(400)
    res = await post(grantBody({ userId: 'not-a-uuid' }))
    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['root_authority_required', 403],
    ['root_self_grant_prohibited', 403],
    ['root_target_not_internal', 400],
    ['root_already_active', 409],
    ['root_expiry_invalid', 400],
  ])('maps the database refusal %s to %i (the refusal itself is logged by the database)', async (code, status) => {
    rpcResult = { data: { ok: false, code }, error: null }
    const res = await post(grantBody())
    expect(res.status).toBe(status)
    expect((await res.json()).code).toBe(code)
  })

  it('revokes through the database; self-revoke and last-administrator refusals are reported', async () => {
    rpcResult = { data: { ok: true, grant_id: 'g1' }, error: null }
    let res = await post({ action: 'revoke', userId: TARGET, reason: 'No longer the platform owner' })
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('sa_revoke_root_access', { p_actor: ADMIN, p_target: TARGET, p_reason: 'No longer the platform owner' })
    rpcResult = { data: { ok: false, code: 'root_self_revoke_prohibited' }, error: null }
    res = await post({ action: 'revoke', userId: ADMIN, reason: 'Trying to drop my own root' })
    expect(res.status).toBe(403)
    rpcResult = { data: { ok: false, code: 'root_last_administrator' }, error: null }
    res = await post({ action: 'revoke', userId: TARGET, reason: 'Removing the last root admin' })
    expect(res.status).toBe(409)
  })

  it('reports a missing migration distinctly and fails closed on any other error', async () => {
    rpcResult = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
    let res = await post(grantBody())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('root_access_migration_missing')
    rpcResult = { data: null, error: { code: '57014', message: 'timeout' } }
    res = await post(grantBody())
    expect(res.status).toBe(500)
    rpcResult = { data: 'weird', error: null }
    res = await post(grantBody())
    expect(res.status).toBe(500)
  })
})

describe('GET /api/security-access/root-access', () => {
  it('returns the viewer capability, no-store', async () => {
    actor = { userId: ADMIN, admin: { rpc: async (fn: string) => ({ data: fn === 'sa_actor_is_root' ? false : 1, error: null }) } }
    const { GET } = await import('./route')
    const res = await GET()
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ ok: true, available: true, viewerIsRoot: false, activeCount: 1 })
  })
})
