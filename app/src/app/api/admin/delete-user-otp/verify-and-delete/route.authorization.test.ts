import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * Archive Identities (platform.identity.delete) on the confirmation step, against an isolated in-memory database:
 * nothing here touches Supabase. The S&A decision, target protection and migration mode are controlled per test;
 * the route and lib/identity/removal-authorization.ts run for real.
 */
type Row = Record<string, any>
const mocks = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  sessionUser: { id: 'admin-1', email: 'admin@example.com' } as any,
  authorize: vi.fn(),
  protect: vi.fn(),
  mode: 'SHADOW' as string,
  history: [] as string[] | null,
  setStatus: vi.fn(),
  ban: vi.fn(),
  destructiveDenied: null as any,
}))

function table(name: string) {
  const filters: Array<(r: Row) => boolean> = []
  let op: { kind: 'select' | 'update' | 'insert' | 'delete'; values?: any } = { kind: 'select' }
  const rows = () => (mocks.db[name] ||= [])
  const run = () => {
    const hit = rows().filter(r => filters.every(f => f(r)))
    if (op.kind === 'update') hit.forEach(r => Object.assign(r, op.values))
    if (op.kind === 'delete') mocks.db[name] = rows().filter(r => !hit.includes(r))
    if (op.kind === 'insert') { const v = { id: `${name}-${rows().length + 1}`, ...op.values }; rows().push(v); return [v] }
    return hit
  }
  const q: any = {
    select: () => q,
    eq: (c: string, v: any) => { filters.push(r => r[c] === v); return q },
    is: (c: string, v: any) => { filters.push(r => (r[c] ?? null) === v); return q },
    in: (c: string, v: any[]) => { filters.push(r => v.includes(r[c])); return q },
    neq: (c: string, v: any) => { filters.push(r => r[c] !== v); return q },
    update: (values: any) => { op = { kind: 'update', values }; return q },
    insert: (values: any) => { op = { kind: 'insert', values }; return q },
    delete: () => { op = { kind: 'delete' }; return q },
    single: async () => { const r = run(); return r.length === 1 ? { data: structuredClone(r[0]), error: null } : { data: null, error: { message: 'no rows' } } },
    maybeSingle: async () => { const r = run(); return { data: r[0] ? structuredClone(r[0]) : null, error: null } },
    then: (resolve: any, reject: any) => Promise.resolve().then(() => ({ data: run(), error: null })).then(resolve, reject),
  }
  return q
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: mocks.sessionUser } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: table, auth: { admin: { updateUserById: mocks.ban, deleteUser: vi.fn(async () => ({ error: null })) } } }),
}))
vi.mock('@/lib/security-access/operation', () => ({
  guardUserOperation: async () => mocks.destructiveDenied,
  authorizeOperation: (req: any) => mocks.authorize(req),
  organizationResource: (type: string, organizationId: string | null | undefined, extra = {}) => ({ type, organizationId: organizationId ?? null, ...extra }),
}))
vi.mock('@/lib/security-access/scope', () => ({ targetProtectionAllows: (...args: any[]) => mocks.protect(...args) }))
vi.mock('@/lib/security-access/authorization', () => ({ currentMigrationMode: async () => mocks.mode }))
vi.mock('@/lib/identity/provisioning', () => ({
  identityHistoryReferences: async () => mocks.history,
  setIdentityAccountStatus: (...args: any[]) => mocks.setStatus(...args),
}))
vi.mock('@/server/auth/passwordResetService', () => ({ hashOtp: (c: string) => `h:${c}`, logNotificationEvent: vi.fn() }))

import { POST } from './route'

const allow = { decision: 'ALLOW', decisionId: 'd-allow', reasonCode: 'ALLOWED_BY_ASSIGNMENT' }
const deny = { decision: 'DENY', decisionId: 'd-deny', reasonCode: 'SCOPE_MISMATCH' }

function seed() {
  mocks.db = {
    users: [
      { id: 'admin-1', email: 'admin@example.com', full_name: 'HQ Admin', organization_id: 'org-hq', account_status: 'ACTIVE', roles: { role_level: 10 } },
      { id: 'target-1', email: 'target@example.com', phone: '+60100000001', full_name: 'Shop Target', organization_id: 'org-shop', account_status: 'ACTIVE', roles: { role_level: 40 } },
      { id: 'other-1', email: 'other@example.com', full_name: 'Other Shop', organization_id: 'org-other', account_status: 'ACTIVE', roles: { role_level: 40 } },
      { id: 'super-1', email: 'super@example.com', full_name: 'Super Admin', organization_id: 'org-hq', account_status: 'ACTIVE', roles: { role_level: 1 } },
    ],
    sa_organization_memberships: [
      { id: 'm-target', user_id: 'target-1', organization_id: 'org-shop', status: 'active', is_primary: true },
    ],
    auth_verification_codes: [
      code('code-1', 'target-1'), code('code-other', 'other-1'), code('code-super', 'super-1'),
      { ...code('code-unbound', 'target-1'), meta: {} },
    ],
    telegram_links: [{ id: 't1', user_id: 'target-1', is_active: true }],
    destructive_ops_audit_log: [],
  }
}
function code(id: string, target: string): Row {
  return { id, purpose: 'user_deletion', user_id: 'admin-1', code_hash: 'h:1234', attempt_count: 0, max_attempts: 5,
    expires_at: new Date(Date.now() + 600_000).toISOString(), invalidated_at: null, used_at: null, meta: { target_user_id: target } }
}
const user = (id: string) => mocks.db.users.find(u => u.id === id)
const otp = (id: string) => mocks.db.auth_verification_codes.find(c => c.id === id)!
const request = (body: Record<string, any>) => new NextRequest('http://localhost/api/admin/delete-user-otp/verify-and-delete', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const confirm = (targetUserId = 'target-1', codeId = 'code-1', code = '1234') => POST(request({ targetUserId, code, codeId }))

/** Account + membership + OTP state that must survive a refused operation unchanged. */
const snapshot = () => JSON.stringify({ users: mocks.db.users, m: mocks.db.sa_organization_memberships, otp: mocks.db.auth_verification_codes, tg: mocks.db.telegram_links })

describe('POST /api/admin/delete-user-otp/verify-and-delete — Archive Identities authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seed()
    mocks.sessionUser = { id: 'admin-1', email: 'admin@example.com' }
    mocks.mode = 'SHADOW'
    mocks.history = ['orders.created_by']
    mocks.destructiveDenied = null
    mocks.authorize.mockResolvedValue(allow)
    mocks.protect.mockResolvedValue(true)
    mocks.ban.mockResolvedValue({ error: null })
    mocks.setStatus.mockImplementation(async (_a: string, id: string, status: string) => {
      Object.assign(user(id)!, { account_status: status }); return { ok: true, status }
    })
  })

  it('authorized archive succeeds as a soft archive (identity kept, identifiers reserved, login banned, Telegram off)', async () => {
    const res = await confirm()
    expect(res.status).toBe(200)
    expect((await res.json()).mode).toBe('archive')
    expect(user('target-1')).toMatchObject({ account_status: 'ARCHIVED', email: 'target@example.com', phone: '+60100000001' })
    expect(mocks.ban).toHaveBeenCalledWith('target-1', { ban_duration: '876000h' })
    expect(mocks.db.telegram_links[0].is_active).toBe(false)
    expect(otp('code-1').used_at).toBeTruthy()
    expect(mocks.db.sa_organization_memberships[0].status).toBe('active')
    expect(mocks.db.destructive_ops_audit_log.at(-1)).toMatchObject({ operation: 'archive_user_keep_identifiers', allowed: true })
  })

  it('decides platform.identity.delete for the TARGET organization with the historical HQ Admin / Super Admin legacy rule', async () => {
    await confirm()
    const asked = mocks.authorize.mock.calls[0][0]
    expect(asked).toMatchObject({ actorId: 'admin-1', permission: 'platform.identity.delete', resource: { organizationId: 'org-shop', id: 'target-1' } })
    expect(await asked.legacy()).toBe(true)
    // Legacy (SHADOW) evaluation: role level <= 10 only.
    mocks.authorize.mockImplementation(async (req: any) => ((await req.legacy()) ? allow : deny))
    for (const [level, expected] of [[1, 200], [10, 200], [20, 403], [30, 403]] as const) {
      seed(); user('admin-1')!.roles = { role_level: level }
      expect((await confirm()).status, `level ${level}`).toBe(expected)
    }
  })

  it('unauthorized and out-of-scope requests fail before the OTP or the account is touched', async () => {
    mocks.authorize.mockImplementation(async (req: any) => (req.resource.organizationId === 'org-shop' ? allow : deny))
    const before = snapshot()
    const res = await confirm('other-1', 'code-other')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'sa_forbidden' })
    expect(snapshot()).toBe(before)
    expect(otp('code-other').attempt_count).toBe(0)
    expect(mocks.setStatus).not.toHaveBeenCalled()
    expect(mocks.ban).not.toHaveBeenCalled()
    expect(mocks.db.destructive_ops_audit_log.at(-1)).toMatchObject({ operation: 'delete_user_execute', allowed: false })
  })

  it('submission rechecks current authorization: revoked after the OTP was sent → refused, nothing changes', async () => {
    mocks.authorize.mockResolvedValue(deny)
    const before = snapshot()
    expect((await confirm()).status).toBe(403)
    expect(snapshot()).toBe(before)
  })

  it('calling the endpoint directly cannot bypass authorization or reuse a code for another target', async () => {
    // A valid code bound to target-1 cannot remove other-1, and a code without a recorded target is never accepted.
    const before = snapshot()
    expect((await confirm('other-1', 'code-1')).status).toBe(400)
    expect((await confirm('target-1', 'code-unbound')).status).toBe(400)
    expect(user('other-1')!.account_status).toBe('ACTIVE')
    expect(user('target-1')!.account_status).toBe('ACTIVE')
    expect(JSON.parse(snapshot()).users).toEqual(JSON.parse(before).users)
    // A code requested by another administrator cannot be used.
    otp('code-1').user_id = 'someone-else'
    expect((await confirm()).status).toBe(403)
    expect(user('target-1')!.account_status).toBe('ACTIVE')
    // No session → 401; destructive-operations refusal → that refusal, before anything else.
    mocks.sessionUser = null
    expect((await confirm()).status).toBe(401)
    mocks.sessionUser = { id: 'admin-1', email: 'admin@example.com' }
    mocks.destructiveDenied = new Response(null, { status: 403 })
    mocks.authorize.mockClear()
    expect((await confirm()).status).toBe(403)
    expect(mocks.authorize).not.toHaveBeenCalled()
  })

  it('self-removal is refused', async () => {
    const before = snapshot()
    const res = await confirm('admin-1', 'code-1')
    expect(res.status).toBe(400)
    expect(snapshot()).toBe(before)
  })

  it('keeps protected-account restrictions: higher legacy role, sa_actor_dominates, and Super Admin in every mode', async () => {
    mocks.protect.mockResolvedValue(false)
    let before = snapshot()
    expect((await confirm()).status).toBe(403)
    expect(mocks.protect).toHaveBeenCalledWith('admin-1', 'target-1', 'platform.identity.delete', expect.any(Function))
    expect(snapshot()).toBe(before)
    // Legacy evaluator passed to target protection: never a more privileged legacy role.
    const legacy = mocks.protect.mock.calls[0][3]
    expect(legacy()).toBe(true) // level 40 target vs level 10 actor
    // A Super Admin target needs a Super Admin actor even when enforced and dominance says yes.
    mocks.protect.mockResolvedValue(true)
    mocks.mode = 'NEW_ENFORCED'
    before = snapshot()
    expect((await confirm('super-1', 'code-super')).status).toBe(403)
    expect(snapshot()).toBe(before)
    expect(mocks.setStatus).not.toHaveBeenCalled()
  })

  it('once enforced, the archive goes through the database lifecycle function (which re-decides the scope)', async () => {
    mocks.mode = 'NEW_ENFORCED'
    expect((await confirm()).status).toBe(200)
    expect(mocks.setStatus).toHaveBeenCalledWith('admin-1', 'target-1', 'ARCHIVED', expect.stringContaining('history retained'))
    expect(user('target-1')!.account_status).toBe('ARCHIVED')
    expect(mocks.db.telegram_links[0].is_active).toBe(false)
  })

  it('a database refusal at archive time keeps the account, membership and code usable state intact', async () => {
    mocks.mode = 'NEW_ENFORCED'
    mocks.setStatus.mockResolvedValue({ ok: false, code: 'FORBIDDEN', status: 403, message: 'You are not authorized to perform this identity or access change.' })
    const res = await confirm()
    expect(res.status).toBe(403)
    expect(user('target-1')!.account_status).toBe('ACTIVE')
    expect(mocks.db.sa_organization_memberships[0].status).toBe('active')
    expect(mocks.db.telegram_links[0].is_active).toBe(true)
    expect(otp('code-1').used_at).toBeNull()
  })

  it('a missing target is judged in the administrator organization (existence not revealed)', async () => {
    mocks.authorize.mockResolvedValue(deny)
    expect((await confirm('ghost', 'code-1')).status).toBe(403)
    expect(mocks.authorize.mock.calls[0][0].resource.organizationId).toBe('org-hq')
    mocks.authorize.mockResolvedValue(allow)
    expect((await confirm('ghost', 'code-1')).status).toBe(404)
  })

  it('an authorization outage is 503 and changes nothing', async () => {
    mocks.authorize.mockResolvedValue({ ...deny, unavailable: 'policy_evaluation_failed' })
    const before = snapshot()
    expect((await confirm()).status).toBe(503)
    expect(snapshot()).toBe(before)
  })
})
