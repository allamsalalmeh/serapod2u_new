import { describe, expect, it } from 'vitest'
import { essGrantAllowed, evaluateInitialSelections, validateInitialSelections, type PolicyRow } from './add-user-selections'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const R1 = id(1), R2 = id(2), ESS = id(3), DRAFT = id(4), RETIRED = id(5), LEGACY = id(6)
const S1 = id(11), S2 = id(12)
const roles = new Map<string, PolicyRow>([
  [R1, { id: R1, role_key: 'warehouse-operator', status: 'active', source: 'template', applicable_org_types: ['HQ', 'WH'] }],
  [R2, { id: R2, role_key: 'receiver', status: 'active', source: 'custom', applicable_org_types: ['HQ'] }],
  [ESS, { id: ESS, role_key: 'employee-self-service', status: 'active', source: 'template', applicable_org_types: ['HQ'] }],
  [DRAFT, { id: DRAFT, role_key: 'draft', status: 'draft', source: 'custom' }],
  [RETIRED, { id: RETIRED, role_key: 'old', status: 'retired', source: 'custom' }],
  [LEGACY, { id: LEGACY, role_key: 'legacy-user', status: 'active', source: 'legacy' }],
])
const run = (items: Array<[string, string]>, org: string | null = 'HQ') => evaluateInitialSelections({ organizationTypeCode: org, roles, items: items.map(([role_id, scope_id]) => ({ role_id, scope_id })) })

describe('evaluateInitialSelections', () => {
  it('groups several policies, each with its own scope, in submitted order', () => {
    expect(run([[R1, S1], [R2, S2]])).toEqual({ ok: true, grouped: [{ roleId: R1, scopeIds: [S1] }, { roleId: R2, scopeIds: [S2] }] })
  })

  it('allows the same policy with different scopes (one grant, several scopes) but never the same pair twice', () => {
    expect(run([[R1, S1], [R1, S2]])).toEqual({ ok: true, grouped: [{ roleId: R1, scopeIds: [S1, S2] }] })
    expect(run([[R1, S1], [R1, S1]])).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
  })

  it('two module Full Access selections are exactly two assignments (no narrower policy is implied)', () => {
    const SC = id(21), CG = id(22)
    const withFull = new Map(roles)
    withFull.set(SC, { id: SC, role_key: 'supply-chain-full-access', status: 'active', source: 'template', applicable_org_types: ['HQ'] })
    withFull.set(CG, { id: CG, role_key: 'customer-growth-full-access', status: 'active', source: 'template', applicable_org_types: ['HQ'] })
    const r = evaluateInitialSelections({ organizationTypeCode: 'HQ', roles: withFull, items: [{ role_id: SC, scope_id: S1 }, { role_id: CG, scope_id: S1 }] })
    expect(r).toEqual({ ok: true, grouped: [{ roleId: SC, scopeIds: [S1] }, { roleId: CG, scopeIds: [S1] }] })
  })

  it('a missing scope is never accepted as global access', () => {
    expect(run([[R1, '']])).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
  })

  it.each([[DRAFT], [RETIRED], [LEGACY], [id(99)]])('refuses a draft, retired, legacy or unknown policy (%s)', (role) => {
    expect(run([[role, S1]])).toMatchObject({ ok: false, code: 'ROLE_GRANT_NOT_ALLOWED' })
  })

  it('refuses empty, oversized and malformed selections', () => {
    expect(run([])).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(run([['not-a-uuid', S1]])).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(run([[R1, '']])).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(run(Array.from({ length: 21 }, (_, i) => [R1, id(100 + i)] as [string, string]))).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
  })

  it('accepts the ESS policy for HQ and rejects it for every other organization type (decided from the stored type)', () => {
    expect(run([[ESS, S1]], 'HQ')).toMatchObject({ ok: true })
    for (const type of ['DIST', 'SHOP', 'MFG', 'WH', null]) expect(run([[ESS, S1]], type)).toMatchObject({ ok: false, code: 'ESS_HQ_ONLY' })
  })
})

/** `role` = the single policy row read by id (a role key, or a row with its eligibility metadata). `migrated` = 20261030100000 applied. */
function adminFor(orgType: string | null, roleRows: PolicyRow[], role: string | Partial<PolicyRow> | null = null, migrated = true) {
  const single = typeof role === 'string' ? { role_key: role, applicable_org_types: role === 'employee-self-service' ? ['HQ'] : [] } : role
  return {
    from: (table: string) => {
      if (table === 'organizations') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: orgType === null ? null : { org_type_code: orgType } }) }) }) }
      if (table === 'sa_org_type_eligibility') return { select: () => ({ limit: async () => (migrated ? { data: [{ org_type_code: 'HQ' }], error: null } : { data: null, error: { code: '42P01', message: 'relation does not exist' } }) }) }
      return { select: () => ({ in: async () => ({ data: roleRows }), eq: () => ({ maybeSingle: async () => ({ data: single }) }) }) }
    },
  }
}

describe('validateInitialSelections (loads the real organization and policy rows)', () => {
  it('uses the organization type stored in the database, never a submitted one', async () => {
    const dist = await validateInitialSelections(adminFor('DIST', [roles.get(ESS)!]), 'org-1', [{ role_id: ESS, scope_id: S1 }])
    expect(dist).toMatchObject({ ok: false, code: 'ESS_HQ_ONLY' })
    const hq = await validateInitialSelections(adminFor('HQ', [roles.get(ESS)!]), 'org-1', [{ role_id: ESS, scope_id: S1 }])
    expect(hq).toMatchObject({ ok: true })
  })
  it('needs a known organization', async () => {
    expect(await validateInitialSelections(adminFor(null, []), null, [{ role_id: R1, scope_id: S1 }])).toMatchObject({ ok: false })
    expect(await validateInitialSelections(adminFor(null, []), 'org-1', [{ role_id: R1, scope_id: S1 }])).toMatchObject({ ok: false })
  })
})

describe('essGrantAllowed (S&A grant and access-request paths)', () => {
  it('blocks ESS outside HQ', async () => {
    expect(await essGrantAllowed(adminFor('SHOP', [], 'employee-self-service'), ESS, 'org')).toMatchObject({ ok: false })
    expect(await essGrantAllowed(adminFor('HQ', [], 'employee-self-service'), ESS, 'org')).toEqual({ ok: true })
  })
  it('applies organization-type eligibility to the target membership (direct API / access request)', async () => {
    const warehouse = { role_key: 'warehouse-operator', applicable_org_types: ['HQ', 'WH'] }
    const ordering = { role_key: 'order-creator', applicable_org_types: ['HQ', 'DIST', 'SHOP'], permissions: [{ permission: { permission_key: 'supply_chain.order.create' } }] } as any
    expect(await essGrantAllowed(adminFor('SHOP', [], warehouse), R1, 'org')).toMatchObject({ ok: false, code: 'RECIPIENT_NOT_ELIGIBLE' })
    expect(await essGrantAllowed(adminFor('HQ', [], warehouse), R1, 'org')).toEqual({ ok: true })
    expect(await essGrantAllowed(adminFor('SHOP', [], ordering), R1, 'org')).toEqual({ ok: true })
    expect(await essGrantAllowed(adminFor('END_USER', [], ordering), R1, 'org')).toMatchObject({ ok: false, code: 'RECIPIENT_NOT_ELIGIBLE' })
    expect(await essGrantAllowed(adminFor('HQ', [], { role_key: 'custom', applicable_org_types: [] }), R1, 'org')).toMatchObject({ ok: false, code: 'RECIPIENT_NOT_ELIGIBLE' })
  })
  it('follows the database rule before the eligibility migration is applied (empty list = any organization)', async () => {
    expect(await essGrantAllowed(adminFor('SHOP', [], { role_key: 'warehouse-operator', applicable_org_types: [] }, false), R1, 'org')).toEqual({ ok: true })
    expect(await essGrantAllowed(adminFor('SHOP', [], { role_key: 'warehouse-operator', applicable_org_types: [] }, true), R1, 'org')).toMatchObject({ ok: false })
  })
})
