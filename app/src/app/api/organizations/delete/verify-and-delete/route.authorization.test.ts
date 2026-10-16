import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * Organization deletion deletes every member identity (hard_delete_organization;
 * check_organization_dependencies does not treat users as a blocker), so each
 * member is Archive Identities (platform.identity.delete) with target
 * protection. Isolated in-memory database: nothing here touches Supabase. The
 * route and lib/identity/removal-authorization.ts run for real.
 */
type Row = Record<string, any>
const mocks = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  sessionUser: { id: 'admin-1', email: 'admin@example.com' } as any,
  authorize: vi.fn(),
  protect: vi.fn(),
  rpc: vi.fn(),
  memberLookupFails: false,
}))

function table(name: string) {
  const filters: Array<(r: Row) => boolean> = []
  let op: { kind: 'select' | 'update' | 'insert'; values?: any } = { kind: 'select' }
  const rows = () => (mocks.db[name] ||= [])
  const run = () => {
    const hit = rows().filter(r => filters.every(f => f(r)))
    if (op.kind === 'update') hit.forEach(r => Object.assign(r, op.values))
    if (op.kind === 'insert') { rows().push({ ...op.values }); return [op.values] }
    return hit
  }
  const q: any = {
    select: () => q,
    eq: (c: string, v: any) => { filters.push(r => r[c] === v); return q },
    is: (c: string, v: any) => { filters.push(r => (r[c] ?? null) === v); return q },
    update: (values: any) => { op = { kind: 'update', values }; return q },
    insert: (values: any) => { op = { kind: 'insert', values }; return q },
    single: async () => { const r = run(); return r.length === 1 ? { data: structuredClone(r[0]), error: null } : { data: null, error: { message: 'no rows' } } },
    maybeSingle: async () => { const r = run(); return { data: r[0] ? structuredClone(r[0]) : null, error: null } },
    then: (resolve: any, reject: any) => Promise.resolve().then(() => {
      if (name === 'users' && op.kind === 'select' && mocks.memberLookupFails && filters.length === 1) return { data: null, error: { message: 'pool exhausted' } }
      return { data: run(), error: null }
    }).then(resolve, reject),
  }
  return q
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: mocks.sessionUser } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: table, rpc: (...args: any[]) => mocks.rpc(...args) }) }))
vi.mock('@/lib/security-access/operation', () => ({
  guardUserOperation: async () => null,
  authorizeOperation: (req: any) => mocks.authorize(req),
  organizationResource: (type: string, organizationId: string | null | undefined, extra = {}) => ({ type, organizationId: organizationId ?? null, ...extra }),
}))
vi.mock('@/lib/security-access/scope', () => ({ targetProtectionAllows: (...args: any[]) => mocks.protect(...args) }))
vi.mock('@/lib/security-access/authorization', () => ({ currentMigrationMode: async () => 'SHADOW' }))
vi.mock('@/lib/identity/provisioning', () => ({ setIdentityAccountStatus: vi.fn() }))
vi.mock('@/server/auth/passwordResetService', () => ({ hashOtp: (c: string) => `h:${c}` }))

import { POST } from './route'

const allow = { decision: 'ALLOW', decisionId: 'd-allow', reasonCode: 'ALLOWED_BY_ASSIGNMENT' }
const deny = { decision: 'DENY', decisionId: 'd-deny', reasonCode: 'SCOPE_MISMATCH' }

function seed() {
  mocks.db = {
    users: [
      { id: 'admin-1', email: 'admin@example.com', organization_id: 'org-hq', role_code: 'HQ_ADMIN', roles: { role_level: 10, role_code: 'HQ_ADMIN' } },
      { id: 'shop-a1', organization_id: 'org-shop', roles: { role_level: 40 } },
      { id: 'shop-a2', organization_id: 'org-shop', roles: { role_level: 40 } },
      { id: 'super-2', organization_id: 'org-super', roles: { role_level: 1 } },
    ],
    organizations: [
      { id: 'org-shop', org_name: 'Shop A', org_code: 'SHA' },
      { id: 'org-empty', org_name: 'Empty', org_code: 'EMP' },
      { id: 'org-super', org_name: 'Holding', org_code: 'HLD' },
    ],
    auth_verification_codes: [code('c-shop', 'org-shop'), code('c-empty', 'org-empty'), code('c-super', 'org-super')],
    destructive_ops_audit_log: [],
    notification_events: [],
  }
}
function code(id: string, org: string): Row {
  return { id, purpose: 'organization_deletion', user_id: 'admin-1', code_hash: 'h:1234', attempt_count: 0, max_attempts: 5,
    expires_at: new Date(Date.now() + 600_000).toISOString(), invalidated_at: null, used_at: null, meta: { target_org_id: org } }
}
const otp = (id: string) => mocks.db.auth_verification_codes.find(c => c.id === id)!
const confirm = (orgId: string, codeId: string) => POST(new NextRequest('http://localhost/api/organizations/delete/verify-and-delete', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId, code: '1234', codeId }),
}))
const deleteCalls = () => mocks.rpc.mock.calls.filter(c => c[0] === 'hard_delete_organization')
const snapshot = () => JSON.stringify({ users: mocks.db.users, otp: mocks.db.auth_verification_codes, orgs: mocks.db.organizations })

describe('POST /api/organizations/delete/verify-and-delete — member identities are Archive Identities', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seed()
    mocks.sessionUser = { id: 'admin-1', email: 'admin@example.com' }
    mocks.memberLookupFails = false
    mocks.authorize.mockResolvedValue(allow)
    mocks.protect.mockResolvedValue(true)
    mocks.rpc.mockImplementation(async (name: string, args: any) => {
      if (name === 'check_organization_dependencies') return { data: { can_delete: true }, error: null }
      if (name === 'hard_delete_organization') {
        mocks.db.users = mocks.db.users.filter(u => u.organization_id !== args.p_org_id)
        return { data: { success: true }, error: null }
      }
      return { data: null, error: null }
    })
  })

  it('authorized: every member passes for the member organization → deleted as before', async () => {
    const res = await confirm('org-shop', 'c-shop')
    expect(res.status).toBe(200)
    expect(deleteCalls()).toHaveLength(1)
    const asked = mocks.authorize.mock.calls.map(c => c[0])
    expect(asked.map(a => a.resource.id).sort()).toEqual(['shop-a1', 'shop-a2'])
    for (const a of asked) expect(a).toMatchObject({ permission: 'platform.identity.delete', resource: { organizationId: 'org-shop' } })
  })

  it('an organization without members needs no identity decision', async () => {
    expect((await confirm('org-empty', 'c-empty')).status).toBe(200)
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(deleteCalls()).toHaveLength(1)
  })

  it('unauthorized / out of scope for the member organization → 403 before the code is read; nothing deleted', async () => {
    mocks.authorize.mockImplementation(async (req: any) => (req.resource.organizationId === 'org-shop' ? deny : allow))
    const before = snapshot()
    const res = await confirm('org-shop', 'c-shop')
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'member_removal_forbidden' })
    expect(snapshot()).toBe(before)
    expect(otp('c-shop')).toMatchObject({ attempt_count: 0, used_at: null })
    expect(deleteCalls()).toHaveLength(0)
    expect(mocks.db.destructive_ops_audit_log.at(-1)).toMatchObject({ operation: 'delete_organization_execute', allowed: false })
  })

  it('protected members (Super Admin by a non-Super Admin, or dominance refused) block the whole deletion', async () => {
    let before = snapshot()
    expect((await confirm('org-super', 'c-super')).status).toBe(403)
    expect(snapshot()).toBe(before)
    mocks.protect.mockResolvedValue(false)
    before = snapshot()
    expect((await confirm('org-shop', 'c-shop')).status).toBe(403)
    expect(snapshot()).toBe(before)
    expect(deleteCalls()).toHaveLength(0)
  })

  it('member lookup or authorization outage → 503, nothing deleted', async () => {
    mocks.memberLookupFails = true
    expect((await confirm('org-shop', 'c-shop')).status).toBe(503)
    mocks.memberLookupFails = false
    mocks.authorize.mockResolvedValue({ ...deny, unavailable: 'policy_evaluation_failed' })
    expect((await confirm('org-shop', 'c-shop')).status).toBe(503)
    expect(deleteCalls()).toHaveLength(0)
    expect(otp('c-shop').used_at).toBeNull()
  })
})
