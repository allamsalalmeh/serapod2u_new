import { beforeEach, describe, expect, it, vi } from 'vitest'

// Server-side scope validation: the same eligibility as the picker, policy compatibility and the administrator's authority per scope.
const allowedOrgs = new Set<string>()
const authorizeOperation = vi.fn(async (req: any) => ({ decision: allowedOrgs.has(req.resource.organizationId) ? 'ALLOW' : 'DENY' }))
vi.mock('./operation', () => ({ authorizeOperation: (r: any) => authorizeOperation(r), organizationResource: (type: string, organizationId: string) => ({ type, organizationId }) }))
vi.mock('./delegation', () => ({ legacyOrDelegatedSecurityAccess: async () => false }))

type Row = Record<string, any>
function fakeAdmin(tables: Record<string, Row[]>) {
  const build = (table: string) => {
    let rows = tables[table] ?? []
    const q: any = {
      select: () => q,
      eq: (c: string, v: any) => { rows = rows.filter(r => r[c] === v); return q },
      in: (c: string, vs: any[]) => { rows = rows.filter(r => vs.includes(r[c])); return q },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: any) => resolve({ data: rows, error: null }),
    }
    return q
  }
  return { from: build }
}

const orgs: Row[] = [
  { id: 'hq', org_name: 'Serapod HQ', org_type_code: 'HQ', parent_org_id: null, is_active: true },
  { id: 'bal', org_name: 'Balakong', org_type_code: 'WH', parent_org_id: 'hq', is_active: true },
  { id: 'alma', org_name: 'Alma', org_type_code: 'WH', parent_org_id: 'hq', is_active: true },
  { id: 'dist', org_name: 'North Distributor', org_type_code: 'DIST', parent_org_id: 'hq', is_active: true },
  { id: 'mfg', org_name: 'Manu', org_type_code: 'MFG', parent_org_id: 'hq', is_active: true },
  { id: 'hq2', org_name: 'Other HQ', org_type_code: 'HQ', parent_org_id: null, is_active: true },
]
const sc = (id: string, organization_id: string, scope_type: string) => ({ id, organization_id, scope_type, scope_value: organization_id, display_name: id, status: 'active' })
const scopes = [sc('s-hq', 'hq', 'organization'), sc('s-bal', 'bal', 'warehouse'), sc('s-alma', 'alma', 'warehouse'), sc('s-dist', 'dist', 'organization'), sc('s-mfg', 'mfg', 'organization'), sc('s-hq2', 'hq2', 'organization')]
const roles = [
  { id: 'r-stock', permissions: [{ permission: { permission_key: 'inventory.stock_count.verify' } }] },
  { id: 'r-mixed', permissions: [{ permission: { permission_key: 'inventory.stock_count.verify' } }, { permission: { permission_key: 'supply_chain.order.approve' } }] },
  { id: 'r-finance', permissions: [{ permission: { permission_key: 'finance.journal.post' } }] },
]
const admin = () => fakeAdmin({ organizations: orgs, sa_scope_definitions: scopes, sa_business_roles: roles })

describe('validateScopeGrant', () => {
  beforeEach(() => { allowedOrgs.clear(); ['hq', 'bal', 'alma', 'dist', 'mfg'].forEach(o => allowedOrgs.add(o)); authorizeOperation.mockClear() })

  it('accepts the HQ scope and its own warehouses for an HQ recipient', async () => {
    const { validateScopeGrant } = await import('./scope-grant')
    await expect(validateScopeGrant(admin(), { actorId: 'a', roleId: 'r-stock', organizationId: 'hq', scopeIds: ['s-hq', 's-bal', 's-alma'] })).resolves.toEqual({ ok: true })
  })
  it('rejects Distributor, Manufacturer and other-HQ scopes for an HQ recipient (direct API submission)', async () => {
    const { validateScopeGrant } = await import('./scope-grant')
    for (const id of ['s-dist', 's-mfg', 's-hq2']) {
      const r = await validateScopeGrant(admin(), { actorId: 'a', roleId: 'r-stock', organizationId: 'hq', scopeIds: [id] })
      expect(r, id).toMatchObject({ ok: false, code: 'SCOPE_NOT_ELIGIBLE', status: 400 })
    }
  })
  it('a Balakong-only administrator cannot grant the broader HQ scope or Alma, but can grant Balakong', async () => {
    const { validateScopeGrant } = await import('./scope-grant')
    allowedOrgs.clear(); allowedOrgs.add('bal')
    expect(await validateScopeGrant(admin(), { actorId: 'a', roleId: 'r-stock', organizationId: 'hq', scopeIds: ['s-hq'] })).toMatchObject({ ok: false, code: 'SCOPE_BEYOND_AUTHORITY', status: 403 })
    expect(await validateScopeGrant(admin(), { actorId: 'a', roleId: 'r-stock', organizationId: 'hq', scopeIds: ['s-alma'] })).toMatchObject({ ok: false, code: 'SCOPE_BEYOND_AUTHORITY' })
    expect(await validateScopeGrant(admin(), { actorId: 'a', roleId: 'r-stock', organizationId: 'hq', scopeIds: ['s-bal'] })).toEqual({ ok: true })
  })
  it('authority is judged per scope: one unauthorized scope refuses the whole grant', async () => {
    const { validateScopeGrant } = await import('./scope-grant')
    allowedOrgs.clear(); allowedOrgs.add('bal')
    expect(await validateScopeGrant(admin(), { actorId: 'a', roleId: 'r-stock', organizationId: 'hq', scopeIds: ['s-bal', 's-alma'] })).toMatchObject({ ok: false, code: 'SCOPE_BEYOND_AUTHORITY' })
  })
  it('a policy no warehouse can limit is refused a warehouse scope, accepted at HQ; a mixed policy is accepted', async () => {
    const { validateScopeGrant } = await import('./scope-grant')
    expect(await validateScopeGrant(admin(), { actorId: 'a', roleId: 'r-finance', organizationId: 'hq', scopeIds: ['s-bal'] })).toMatchObject({ ok: false, code: 'WAREHOUSE_SCOPE_UNSUPPORTED' })
    expect(await validateScopeGrant(admin(), { actorId: 'a', roleId: 'r-finance', organizationId: 'hq', scopeIds: ['s-hq'] })).toEqual({ ok: true })
    expect(await validateScopeGrant(admin(), { actorId: 'a', roleId: 'r-mixed', organizationId: 'hq', scopeIds: ['s-bal'] })).toEqual({ ok: true })
  })
  it('a self-service request is judged for eligibility and policy but not for grant authority', async () => {
    const { validateScopeGrant } = await import('./scope-grant')
    allowedOrgs.clear()
    expect(await validateScopeGrant(admin(), { actorId: null, roleId: 'r-stock', organizationId: 'hq', scopeIds: ['s-bal'] })).toEqual({ ok: true })
    expect(await validateScopeGrant(admin(), { actorId: null, roleId: 'r-stock', organizationId: 'hq', scopeIds: ['s-dist'] })).toMatchObject({ ok: false, code: 'SCOPE_NOT_ELIGIBLE' })
    expect(authorizeOperation).not.toHaveBeenCalled()
  })
  it('fails closed when the engine cannot answer', async () => {
    const { validateScopeGrant } = await import('./scope-grant')
    authorizeOperation.mockRejectedValueOnce(new Error('boom'))
    expect(await validateScopeGrant(admin(), { actorId: 'a', roleId: 'r-stock', organizationId: 'hq', scopeIds: ['s-hq'] })).toMatchObject({ ok: false, code: 'SCOPE_BEYOND_AUTHORITY' })
  })
})

describe('loadScopeChoices', () => {
  beforeEach(() => { allowedOrgs.clear(); ['hq', 'bal', 'alma'].forEach(o => allowedOrgs.add(o)) })
  it('an HQ recipient is offered the HQ and its warehouses only, with names', async () => {
    const { loadScopeChoices } = await import('./scope-grant')
    const r = await loadScopeChoices(admin(), 'hq', null)
    expect(r?.choices.map(c => c.label)).toEqual(['Serapod HQ — HQ and all its warehouses', 'Alma — this warehouse only', 'Balakong — this warehouse only'])
  })
  it('limits the list to organizations where the administrator may grant (no broader HQ scope for a warehouse-only admin)', async () => {
    const { loadScopeChoices } = await import('./scope-grant')
    allowedOrgs.clear(); allowedOrgs.add('bal')
    const r = await loadScopeChoices(admin(), 'hq', 'a')
    expect(r?.choices.map(c => c.name)).toEqual(['Balakong'])
  })
})
