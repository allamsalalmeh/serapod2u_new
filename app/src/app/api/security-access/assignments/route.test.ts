import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// sa_actor_may_assign_profile answers `mayAssign` (null = function missing); every other call is the grant / revoke.
let mayAssign: boolean | null = true
let assignErrors: any[] = []
const rpc = vi.fn(async (fn: string, _args?: any): Promise<any> => fn === 'sa_actor_may_assign_profile'
  ? (mayAssign === null ? { data: null, error: { message: 'function not found' } } : { data: mayAssign, error: null })
  : assignErrors.length ? { data: null, error: assignErrors.shift() } : { data: 'assignment-1', error: null })
const writes = () => rpc.mock.calls.filter(c => c[0] !== 'sa_actor_may_assign_profile')
let actorResult: any = null
let orgType = 'HQ'
// Eligible organization types of the non-ESS test policy (an ordering policy: HQ, Distributor and Shop).
let otherOrgTypes: string[] = ['HQ', 'DIST', 'SHOP']
const ESS = '00000000-0000-4000-8000-000000000003'
const OTHER = '00000000-0000-4000-8000-000000000001'
vi.mock('@/lib/security-access/admin-api', () => ({
  requireSecurityActor: vi.fn(async () => actorResult ?? ({ userId: 'admin', organizationId: 'o', admin: {
    rpc,
    from: (table: string) => table === 'organizations'
      ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { org_type_code: orgType } }) }) }) }
      : table === 'sa_scope_definitions' ? { select: () => ({ in: async () => ({ data: [{ id: 's', display_name: 'Serapod HQ' }] }) }) }
      : { select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: { role_key: id === ESS ? 'employee-self-service' : 'receiver', status: 'active', name: 'GL Clerk', email: 'supply@dev.com', applicable_org_types: id === ESS ? ['HQ'] : otherOrgTypes, permissions: id === ESS ? [] : [{ permission: { permission_key: 'supply_chain.order.create' } }] } }) }) }) },
  } })),
  governanceError: vi.fn((e: any) => new Response(JSON.stringify({ error: String(e?.message) }), { status: 409 })),
}))

let scopeResult: any = { ok: true }
const validateScopeGrant = vi.fn(async () => scopeResult)
vi.mock('@/lib/security-access/scope-grant', () => ({ validateScopeGrant: (...a: any[]) => (validateScopeGrant as any)(...a) }))

let heldResult: any = { held: false }
const findHeldGrant = vi.fn(async () => heldResult)
vi.mock('@/lib/security-access/grant-identity', () => ({ findHeldGrant: (...a: any[]) => (findHeldGrant as any)(...a) }))

const restoreMock = vi.hoisted(() => ({ outcome: null as any, calls: [] as any[] }))
vi.mock('@/lib/security-access/policy-restore', () => ({
  restorePolicyGrant: async (...a: any[]) => { restoreMock.calls.push(a.slice(1)); return restoreMock.outcome },
}))

const body = (roleId: string) => new NextRequest('http://t/api', { method: 'POST', body: JSON.stringify({
  action: 'grant', userId: '00000000-0000-4000-8000-0000000000aa', roleId, organizationId: '00000000-0000-4000-8000-0000000000bb',
  scopeIds: ['00000000-0000-4000-8000-000000000011'], reason: 'Needs it' }) })

beforeEach(() => { rpc.mockClear(); mayAssign = true; assignErrors = []; actorResult = null; validateScopeGrant.mockClear(); scopeResult = { ok: true }; heldResult = { held: false }; findHeldGrant.mockClear(); orgType = 'HQ'; otherOrgTypes = ['HQ', 'DIST', 'SHOP'] })

describe('POST /api/security-access/assignments — Employee Self Service is HQ-only', () => {
  it.each(['DIST', 'SHOP', 'MFG', 'WH'])('rejects an ESS grant inside a %s organization before the database is called', async (type) => {
    orgType = type
    const { POST } = await import('./route')
    const res = await POST(body(ESS))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('ESS_HQ_ONLY')
    expect(writes()).toEqual([])
  })
  it('grants ESS inside HQ and another policy where it is eligible', async () => {
    const { POST } = await import('./route')
    expect((await POST(body(ESS))).status).toBe(200)
    orgType = 'SHOP'
    expect((await POST(body(OTHER))).status).toBe(200)
    expect(writes()).toHaveLength(2)
  })
})

describe('POST /api/security-access/assignments — organization-type eligibility of the TARGET membership', () => {
  it.each([['HQ-only policy to a Shop', ['HQ'], 'SHOP'], ['Shop policy to HQ', ['SHOP'], 'HQ'], ['any policy to an End User', ['HQ', 'DIST', 'SHOP'], 'END_USER'], ['unclassified policy', [], 'HQ']])(
    'a direct request cannot grant an ineligible policy (%s): refused before the database, in preflight and submission', async (_n, types, type) => {
      otherOrgTypes = types as string[]; orgType = type as string
      const { POST } = await import('./route')
      const res = await POST(body(OTHER))
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('RECIPIENT_NOT_ELIGIBLE')
      const pre = await (await POST(post({ ...grantBody(), action: 'preflight' }))).json()
      expect(pre).toMatchObject({ allowed: false, code: 'RECIPIENT_NOT_ELIGIBLE' })
      expect(writes()).toEqual([])
    })
})

describe('POST /api/security-access/assignments — scope eligibility is enforced like the picker', () => {
  it('validates the submitted scopes against the real recipient organization and the acting administrator before the database is called', async () => {
    const { POST } = await import('./route')
    expect((await POST(body(OTHER))).status).toBe(200)
    expect(validateScopeGrant).toHaveBeenCalledWith(expect.anything(), { actorId: 'admin', roleId: OTHER, organizationId: '00000000-0000-4000-8000-0000000000bb', scopeIds: ['00000000-0000-4000-8000-000000000011'] })
  })
  it.each([
    [{ ok: false, code: 'SCOPE_NOT_ELIGIBLE', message: 'not for HQ', status: 400 }, 400],
    [{ ok: false, code: 'WAREHOUSE_SCOPE_UNSUPPORTED', message: 'no', status: 400 }, 400],
    [{ ok: false, code: 'SCOPE_BEYOND_AUTHORITY', message: 'beyond', status: 403 }, 403],
    [{ ok: false, code: 'SCOPE_CHECK_UNAVAILABLE', message: 'later', status: 503 }, 503],
  ])('refuses an incompatible or unauthorized direct submission (%j) without calling the database', async (result, status) => {
    scopeResult = result
    const { POST } = await import('./route')
    const res = await POST(body(OTHER))
    expect(res.status).toBe(status)
    expect((await res.json()).code).toBe((result as any).code)
    expect(writes()).toEqual([])
  })
  it('revoke and restore are not scope grants and skip the check', async () => {
    const { POST } = await import('./route')
    const res = await POST(new NextRequest('http://t/api', { method: 'POST', body: JSON.stringify({ action: 'revoke', assignmentId: '00000000-0000-4000-8000-0000000000cc', reason: 'No longer needed' }) }))
    expect(res.status).toBe(200)
    expect(validateScopeGrant).not.toHaveBeenCalled()
  })
})

describe('POST /api/security-access/assignments — an identical active grant is never added again', () => {
  it('refuses with 409 before the scope check and the database, and never revokes or replaces the existing grant', async () => {
    heldResult = { held: true, message: 'already held', coversWarehouses: true }
    const { POST } = await import('./route')
    const res = await POST(body(OTHER))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'already held', code: 'ROLE_ALREADY_HELD' })
    expect(findHeldGrant).toHaveBeenCalledWith(expect.anything(), { userId: '00000000-0000-4000-8000-0000000000aa', roleId: OTHER, organizationId: '00000000-0000-4000-8000-0000000000bb', scopeIds: ['00000000-0000-4000-8000-000000000011'] })
    expect(validateScopeGrant).not.toHaveBeenCalled()
    expect(writes()).toEqual([])
  })
})

const USER = '00000000-0000-4000-8000-0000000000aa'
const ORG = '00000000-0000-4000-8000-0000000000bb'
const SCOPE = '00000000-0000-4000-8000-000000000011'
const post = (b: any) => new NextRequest('http://t/api', { method: 'POST', body: JSON.stringify(b) })
const grantBody = (extra: any = {}) => ({ action: 'grant', userId: USER, roleId: OTHER, organizationId: ORG, scopeIds: [SCOPE], ...extra })

describe('POST /api/security-access/assignments — optional note', () => {
  it('grants without a note: the database receives no invented reason', async () => {
    const { POST } = await import('./route')
    const res = await POST(post(grantBody()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, assignmentId: 'assignment-1', noteRecorded: false })
    expect(writes()).toEqual([['sa_assign_role', { p_actor: 'admin', p_user: USER, p_role: OTHER, p_org: ORG, p_scope_ids: [SCOPE], p_from: null, p_until: null, p_reason: null }]])
  })
  it('records a trimmed note; a blank note is no note; the old `reason` field is still accepted as the note', async () => {
    const { POST } = await import('./route')
    expect((await (await POST(post(grantBody({ note: '  Ticket SA-42 ' })))).json()).noteRecorded).toBe(true)
    await POST(post(grantBody({ note: '   ' })))
    await POST(post(grantBody({ reason: 'Old client' })))
    expect(writes().map(c => (c[1] as any).p_reason)).toEqual(['Ticket SA-42', null, 'Old client'])
  })
  it('refuses a note over 500 characters', async () => {
    const { POST } = await import('./route')
    expect((await POST(post(grantBody({ note: 'x'.repeat(501) })))).status).toBe(400)
    expect(writes()).toEqual([])
  })
  it('before the database migration: retries ONCE with a generated description that says no note was given', async () => {
    assignErrors = [{ message: 'sa_reason_required' }]
    const { POST } = await import('./route')
    const res = await POST(post(grantBody()))
    expect(res.status).toBe(200)
    const reasons = writes().map(c => (c[1] as any).p_reason)
    expect(reasons[0]).toBeNull()
    expect(reasons[1]).toBe('Group Policy "GL Clerk" granted to supply@dev.com in ' + ORG + ' (scope: Serapod HQ; no end date). No note provided.')
  })
  it('never retries when a note was given or for any other error, and never reports success on failure', async () => {
    assignErrors = [{ message: 'sa_reason_required' }]
    const { POST } = await import('./route')
    expect((await POST(post(grantBody({ note: 'abc' })))).status).toBe(409)
    assignErrors = [{ message: 'sod_violation: R1' }]
    const res = await POST(post(grantBody()))
    expect(res.status).toBe(409)
    expect((await res.json()).ok).toBeUndefined()
    expect(writes()).toHaveLength(2)
  })
  it('revoke and restore still require a reason', async () => {
    const { POST } = await import('./route')
    expect((await POST(post({ action: 'revoke', assignmentId: '00000000-0000-4000-8000-0000000000cc' }))).status).toBe(400)
    expect((await POST(post({ action: 'restore', assignmentId: '00000000-0000-4000-8000-0000000000cc', reason: 'no' }))).status).toBe(400)
    expect(writes()).toEqual([])
  })
})

describe('POST /api/security-access/assignments — the same checks for preflight and submission', () => {
  it('preflight answers allowed without writing anything', async () => {
    const { POST } = await import('./route')
    const res = await POST(post({ ...grantBody(), action: 'preflight' }))
    expect(await res.json()).toEqual({ ok: true, allowed: true, sensitiveChecked: true })
    expect(writes()).toEqual([])
    expect(validateScopeGrant).toHaveBeenCalledWith(expect.anything(), { actorId: 'admin', roleId: OTHER, organizationId: ORG, scopeIds: [SCOPE] })
  })
  it('self-grant is refused by actor id vs canonical user id, in preflight and in submission', async () => {
    const { POST } = await import('./route')
    const pre = await (await POST(post({ ...grantBody(), action: 'preflight', userId: '00000000-0000-4000-8000-0000000000ad' }))).json()
    expect(pre).toEqual({ ok: true, allowed: true, sensitiveChecked: true }) // another person: allowed
    actorResult = { userId: USER, organizationId: 'o', admin: { rpc } }
    const self = await (await POST(post({ ...grantBody(), action: 'preflight' }))).json()
    expect(self).toEqual({ ok: true, allowed: false, code: 'SELF_GRANT', reason: 'You cannot grant access to yourself.' })
    const res = await POST(post(grantBody()))
    expect(res.status).toBe(403)
    expect(writes()).toEqual([])
  })
  it('a sensitive policy the administrator may not grant is refused before the database (same rule as the grant guard)', async () => {
    mayAssign = false
    const { POST } = await import('./route')
    expect((await (await POST(post({ ...grantBody(), action: 'preflight' }))).json()).code).toBe('GRANT_BEYOND_AUTHORITY')
    const res = await POST(post(grantBody()))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('GRANT_BEYOND_AUTHORITY')
    expect(writes()).toEqual([])
  })
  it('when the sensitive pre-check is unavailable (migration not applied) the database guard decides', async () => {
    mayAssign = null
    const { POST } = await import('./route')
    expect(await (await POST(post({ ...grantBody(), action: 'preflight' }))).json()).toEqual({ ok: true, allowed: true, sensitiveChecked: false })
    expect((await POST(post(grantBody()))).status).toBe(200)
  })
  it('duplicate and out-of-scope grants are explained by the preflight; an unavailable check is a 503 (Retry), not a denial', async () => {
    const { POST } = await import('./route')
    heldResult = { held: true, message: 'already held', coversWarehouses: false }
    expect(await (await POST(post({ ...grantBody(), action: 'preflight' }))).json()).toEqual({ ok: true, allowed: false, code: 'ROLE_ALREADY_HELD', reason: 'already held' })
    heldResult = { held: false }
    scopeResult = { ok: false, code: 'SCOPE_BEYOND_AUTHORITY', message: 'beyond', status: 403 }
    expect((await (await POST(post({ ...grantBody(), action: 'preflight' }))).json()).code).toBe('SCOPE_BEYOND_AUTHORITY')
    scopeResult = { ok: false, code: 'SCOPE_CHECK_UNAVAILABLE', message: 'later', status: 503 }
    expect((await POST(post({ ...grantBody(), action: 'preflight' }))).status).toBe(503)
  })
  it('authority revoked after the preflight: the submission is re-authorized and refused without touching the database', async () => {
    const { POST } = await import('./route')
    expect((await (await POST(post({ ...grantBody(), action: 'preflight' }))).json()).allowed).toBe(true)
    const { NextResponse } = await import('next/server')
    actorResult = NextResponse.json({ error: 'Forbidden', code: 'sa_forbidden' }, { status: 403 })
    expect((await POST(post(grantBody()))).status).toBe(403)
    expect(writes()).toEqual([])
  })
})

describe('POST /api/security-access/assignments — one-click restore of a revoked grant', () => {
  const restoreBody = (extra: any = {}) => new NextRequest('http://t/api', { method: 'POST', body: JSON.stringify({ action: 'restore_grant', assignmentId: '00000000-0000-4000-8000-0000000000cc', ...extra }) })
  beforeEach(() => { restoreMock.calls = []; restoreMock.outcome = { ok: true, assignmentId: 'a-new', restoredFrom: '00000000-0000-4000-8000-0000000000cc' } })

  it('needs no reason or form: the authenticated administrator restores the revoked grant as a new grant', async () => {
    const { POST } = await import('./route')
    const res = await POST(restoreBody())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, assignmentId: 'a-new', restoredFrom: '00000000-0000-4000-8000-0000000000cc' })
    expect(restoreMock.calls).toEqual([['admin', '00000000-0000-4000-8000-0000000000cc']])
  })

  it('refusals keep their status and explanation; database errors use the shared mapping', async () => {
    const { POST } = await import('./route')
    restoreMock.outcome = { ok: false, status: 409, code: 'sa_restore_validity_expired', message: 'expired. Nothing was changed.' }
    let res = await POST(restoreBody())
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'expired. Nothing was changed.', code: 'sa_restore_validity_expired' })
    restoreMock.outcome = { ok: false, databaseError: { message: 'sod_violation: x' } }
    res = await POST(restoreBody())
    expect(res.status).toBe(409) // governanceError (mocked)
  })

  it('an unauthorized administrator is refused before anything is read', async () => {
    const { NextResponse } = await import('next/server')
    actorResult = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    const { POST } = await import('./route')
    const res = await POST(restoreBody())
    expect(res.status).toBe(403)
    expect(restoreMock.calls).toEqual([])
  })

  it('rejects a malformed request', async () => {
    const { POST } = await import('./route')
    expect((await POST(restoreBody({ assignmentId: 'not-a-uuid' }))).status).toBe(400)
    expect(restoreMock.calls).toEqual([])
  })
})
