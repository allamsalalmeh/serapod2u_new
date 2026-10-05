import { describe, expect, it, vi } from 'vitest'
import { directoryQuerySchema, loadDirectory, mapDirectoryError } from './directory'

const ACTOR = 'actor-1'
const ORG_MFG = '11111111-1111-4111-8111-111111111111'

/** Fake admin client that records every call; only reads are expected. */
function fakeAdmin(over: { page?: any; users?: any[]; visible?: any[]; orgs?: any[]; pageError?: any } = {}) {
  const calls: Array<{ kind: string; name: string; args?: any }> = []
  const admin = {
    calls,
    rpc: async (fn: string, args: any) => {
      calls.push({ kind: 'rpc', name: fn, args })
      if (fn === 'sa_directory_page' || fn === 'sa_directory_page_v2') return over.pageError ? { data: null, error: over.pageError } : { data: over.page ?? { total: 1, counts: { all: 1 }, ids: ['u-manu'] }, error: null }
      if (fn === 'sa_directory_organizations') return { data: over.orgs ?? [], error: null }
      if (fn === 'sa_directory_visible_memberships') return { data: over.visible ?? [], error: null }
      return { data: null, error: { message: 'unexpected rpc ' + fn } }
    },
    from: (table: string) => {
      calls.push({ kind: 'from', name: table })
      const chain: any = { select: () => chain, in: async () => ({ data: over.users ?? [], error: null }) }
      return chain
    },
  }
  return admin
}
const query = directoryQuerySchema.parse({})

describe('directoryQuerySchema', () => {
  it('applies safe defaults and bounds', () => {
    expect(query).toEqual({ q: '', filter: 'all', status: 'all', membership: 'all', offset: 0, limit: 25 })
    expect(directoryQuerySchema.safeParse({ limit: '1000' }).success).toBe(false)
    expect(directoryQuerySchema.safeParse({ offset: '-1' }).success).toBe(false)
    expect(directoryQuerySchema.safeParse({ filter: 'everything' }).success).toBe(false)
    expect(directoryQuerySchema.safeParse({ org: 'not-a-uuid' }).success).toBe(false)
    expect(directoryQuerySchema.safeParse({ q: 'x'.repeat(101) }).success).toBe(false)
    for (const bad of [{ category: 'GUEST' }, { category: 'ROOT' }, { orgType: 'END_USER' }, { orgType: 'mfg' }, { status: 'online' }, { membership: 'maybe' }]) {
      expect(directoryQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    // User categories are the identity principal types (a GUEST role code is not a category).
    for (const category of ['INTERNAL_EMPLOYEE', 'DISTRIBUTOR_USER', 'MANUFACTURER_USER', 'SHOP_STAFF', 'CONSUMER', 'UNCLASSIFIED']) expect(directoryQuerySchema.safeParse({ category }).success).toBe(true)
  })
})

describe('loadDirectory', () => {
  const manu = { id: 'u-manu', full_name: 'Manu Operator', email: 'manu@dev.com', role_code: 'MFG_USER', is_active: true, organization_id: ORG_MFG,
    organization: { org_name: 'Manu Manufacturing', org_type_code: 'MFG' },
    membership: [{ id: 'm-1', organization_id: ORG_MFG, status: 'active', assignments: [] }, { id: 'm-other', organization_id: 'org-elsewhere', status: 'active', assignments: [] }] }

  it('asks the database for the page (server-side search/pagination) and passes the actor and the requested organization through', async () => {
    const admin = fakeAdmin({ users: [manu], visible: [{ membership_id: 'm-1', grantable: true, blocked_reason: null }] })
    await loadDirectory(admin, ACTOR, { ...query, q: 'manu@dev', org: ORG_MFG, offset: 50, limit: 10, filter: 'none' })
    expect(admin.calls.find(c => c.name === 'sa_directory_page_v2')!.args).toEqual({
      p_actor: ACTOR, p_org: ORG_MFG, p_search: 'manu@dev', p_filter: 'none', p_limit: 10, p_offset: 50,
      p_category: null, p_org_type: null, p_status: 'all', p_membership: 'all',
    })
  })

  it('passes every directory filter to the database (applied before pagination, inside the authorized scope)', async () => {
    const admin = fakeAdmin({ users: [manu] })
    await loadDirectory(admin, ACTOR, { ...query, category: 'SHOP_STAFF', orgType: 'SHOP', status: 'active', membership: 'none', org: ORG_MFG })
    expect(admin.calls.find(c => c.name === 'sa_directory_page_v2')!.args).toMatchObject({ p_category: 'SHOP_STAFF', p_org_type: 'SHOP', p_status: 'active', p_membership: 'none', p_org: ORG_MFG })
  })

  it('falls back to the previous directory function only when no new filter is used; otherwise explains the missing migration', async () => {
    const calls: string[] = []
    const admin: any = fakeAdmin({ users: [manu] })
    const rpc = admin.rpc
    admin.rpc = async (fn: string, args: any) => { calls.push(fn); return fn === 'sa_directory_page_v2' ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } : rpc(fn, args) }
    expect((await loadDirectory(admin, ACTOR, query)).ok).toBe(true)
    expect(calls).toContain('sa_directory_page')
    expect(await loadDirectory(admin, ACTOR, { ...query, category: 'CONSUMER' })).toMatchObject({ ok: false, status: 409, code: 'directory_filters_migration_missing' })
  })

  it('returns the classification fields it needs (principal type) and still no sensitive profile data', async () => {
    const select = vi.fn()
    const admin: any = fakeAdmin({ users: [manu] })
    admin.from = () => { const chain: any = { select: (c: string) => { select(c); return chain }, in: async () => ({ data: [manu], error: null }) }; return chain }
    await loadDirectory(admin, ACTOR, query)
    expect(String(select.mock.calls[0][0])).toContain('principal_type')
  })

  it('returns only memberships the actor may see, each with its own grant eligibility', async () => {
    const admin = fakeAdmin({ users: [manu], visible: [{ membership_id: 'm-1', grantable: false, blocked_reason: 'not_authorized' }] })
    const out = await loadDirectory(admin, ACTOR, query)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const person = out.value.people[0]
    expect(person.membership.map((m: any) => m.id)).toEqual(['m-1'])          // m-other is in an unauthorized organization
    expect(person.membership[0]).toMatchObject({ grantable: false, grant_blocked_reason: 'not_authorized' })
    expect(person.organization.org_type_code).toBe('MFG')
  })

  it('never selects credentials or unrelated sensitive profile fields', async () => {
    const select = vi.fn()
    const admin: any = fakeAdmin({ users: [manu] })
    admin.from = () => { const chain: any = { select: (cols: string) => { select(cols); return chain }, in: async () => ({ data: [manu], error: null }) }; return chain }
    await loadDirectory(admin, ACTOR, query)
    const cols = String(select.mock.calls[0][0])
    for (const banned of ['phone', 'password', 'bank', 'address', 'salary', 'signature', 'avatar', 'token']) expect(cols).not.toContain(banned)
  })

  it('is read-only: it only calls the directory read functions and a users select', async () => {
    const admin = fakeAdmin({ users: [manu] })
    await loadDirectory(admin, ACTOR, query)
    expect(admin.calls.map(c => `${c.kind}:${c.name}`).sort()).toEqual(['from:users', 'rpc:sa_directory_organizations', 'rpc:sa_directory_page_v2', 'rpc:sa_directory_visible_memberships'])
  })

  it('does not fetch details for an empty page', async () => {
    const admin = fakeAdmin({ page: { total: 0, counts: {}, ids: [] } })
    const out = await loadDirectory(admin, ACTOR, query)
    expect(out.ok && out.value.people).toEqual([])
    expect(admin.calls.some(c => c.kind === 'from')).toBe(false)
  })

  it.each([
    [{ message: 'sa_directory_org_forbidden', code: '42501' }, 403, 'org_forbidden'],
    [{ message: 'sa_authorization_required', code: '42501' }, 403, 'forbidden'],
    [{ message: 'sa_actor_inactive' }, 403, 'forbidden'],
    [{ code: 'PGRST202', message: 'Could not find the function' }, 409, 'directory_migration_missing'],
  ])('maps database error %j to %s/%s (a forged organization id is rejected, never ignored)', async (error, status, code) => {
    const out = await loadDirectory(fakeAdmin({ pageError: error }), ACTOR, { ...query, org: ORG_MFG })
    expect(out).toMatchObject({ ok: false, status, code })
  })

  it('does not leak unexpected database errors', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const mapped = mapDirectoryError({ message: 'relation "secret_table" does not exist at character 14', code: 'XX000' })
    expect(JSON.stringify(mapped)).not.toContain('secret_table')
  })
})
