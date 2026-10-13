import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalScopeChoices, choiceAllowedForPolicy, isScopeEligible, warehousesOfHq, warehouseSupportFor, WAREHOUSE_SCOPED_PERMISSIONS,
  type ScopeDefinitionLike, type ScopeOrg,
} from './scope-eligibility'

const org = (id: string, name: string, typeCode: string, parentId: string | null = null, isActive = true): ScopeOrg => ({ id, name, typeCode, parentId, isActive })
const HQ = org('hq', 'Serapod HQ', 'HQ')
const ORGS: ScopeOrg[] = [
  HQ, org('bal', 'Balakong', 'WH', 'hq'), org('alma', 'Alma', 'WH', 'hq'), org('old', 'Closed WH', 'WH', 'hq', false),
  org('dist', 'North Distributor', 'DIST', 'hq'), org('shop', 'Corner Shop', 'SHOP', 'dist'), org('mfg', 'Manu', 'MFG', 'hq'),
  org('hq2', 'Other HQ', 'HQ'), org('zeta', 'Zeta', 'WH', 'hq2'), org('loose', 'Unattached WH', 'WH', null),
]
const def = (id: string, organization_id: string | null, scope_type: string, value?: string): ScopeDefinitionLike =>
  ({ id, organization_id, scope_type, scope_value: value ?? organization_id, display_name: id })
const SCOPES: ScopeDefinitionLike[] = [
  def('s-hq', 'hq', 'organization'), def('s-bal', 'bal', 'warehouse'), def('s-bal-org', 'bal', 'organization'), def('s-alma', 'alma', 'warehouse'),
  def('s-old', 'old', 'warehouse'), def('s-dist', 'dist', 'organization'), def('s-shop', 'shop', 'organization'), def('s-mfg', 'mfg', 'organization'),
  def('s-hq2', 'hq2', 'organization'), def('s-zeta', 'zeta', 'warehouse'), def('s-loose', 'loose', 'warehouse'),
  def('s-dist-own', 'dist', 'own_record', 'self'), def('s-territory', null, 'territory', 'north'),
]

describe('HQ recipient scope choices', () => {
  const choices = canonicalScopeChoices(HQ, ORGS, SCOPES)
  it('offers only the HQ and its own active warehouses', () => {
    expect(choices.map(c => c.scopeId)).toEqual(['s-hq', 's-alma', 's-bal'])
    expect(choices.map(c => c.name)).toEqual(['Serapod HQ', 'Alma', 'Balakong'])
  })
  it('never offers Shop, Distributor or Manufacturer scopes, another HQ, an unattached or closed warehouse, own-record or typed scopes', () => {
    const ids = choices.map(c => c.scopeId)
    for (const bad of ['s-dist', 's-shop', 's-mfg', 's-hq2', 's-zeta', 's-loose', 's-old', 's-dist-own', 's-territory']) expect(ids).not.toContain(bad)
  })
  it('uses the actual names and the approved labels', () => {
    expect(choices.map(c => c.label)).toEqual(['Serapod HQ — HQ and all its warehouses', 'Alma — this warehouse only', 'Balakong — this warehouse only'])
    expect(choices.map(c => c.coverage)).toEqual(['HQ and all its warehouses', 'This warehouse only', 'This warehouse only'])
  })
  it('shows a warehouse once: the canonical warehouse scope, not its organization duplicate', () => {
    expect(choices.filter(c => c.targetOrganizationId === 'bal')).toHaveLength(1)
    expect(choices.find(c => c.targetOrganizationId === 'bal')?.scopeType).toBe('warehouse')
  })
  it('falls back to an organization definition only when a warehouse has no warehouse definition', () => {
    const onlyOrg = SCOPES.filter(s => s.id !== 's-bal')
    expect(canonicalScopeChoices(HQ, ORGS, onlyOrg).find(c => c.targetOrganizationId === 'bal')?.scopeId).toBe('s-bal-org')
  })
  it('a warehouse attached later appears with no change to the HQ choice; one moved away disappears', () => {
    const attached = [...ORGS, org('new', 'Newco', 'WH', 'hq')]
    const scopes = [...SCOPES, def('s-new', 'new', 'warehouse')]
    expect(canonicalScopeChoices(HQ, attached, scopes).map(c => c.name)).toContain('Newco')
    expect(canonicalScopeChoices(HQ, attached.map(o => (o.id === 'alma' ? { ...o, parentId: 'hq2' } : o)), scopes).map(c => c.name)).not.toContain('Alma')
    expect(warehousesOfHq('hq', attached).map(o => o.id).sort()).toEqual(['alma', 'bal', 'new'])
  })
  it('a warehouse without any scope definition is simply not a choice (nothing is created)', () => {
    expect(canonicalScopeChoices(HQ, ORGS, SCOPES.filter(s => s.organization_id !== 'alma')).map(c => c.name)).toEqual(['Serapod HQ', 'Balakong'])
  })
})

describe('other recipients', () => {
  it('a warehouse user is offered that warehouse only', () => {
    expect(canonicalScopeChoices(ORGS[1], ORGS, SCOPES).map(c => c.scopeId)).toEqual(['s-bal'])
  })
  it('a distributor is offered itself and the shop beneath it (the existing hierarchy), nothing above or beside', () => {
    expect(canonicalScopeChoices(ORGS[4], ORGS, SCOPES).map(c => c.scopeId)).toEqual(['s-dist', 's-shop'])
  })
  it('a manufacturer is offered itself only', () => {
    expect(canonicalScopeChoices(ORGS[6], ORGS, SCOPES).map(c => c.scopeId)).toEqual(['s-mfg'])
  })
})

describe('isScopeEligible (server twin of the picker)', () => {
  const byId = (id: string) => SCOPES.find(s => s.id === id)!
  it('matches the picker for an HQ recipient', () => {
    const offered = new Set(canonicalScopeChoices(HQ, ORGS, SCOPES).map(c => c.scopeId))
    for (const s of SCOPES.filter(x => ['organization', 'warehouse'].includes(x.scope_type))) {
      // the legacy organization duplicate of a warehouse is accepted by the server although the picker shows the canonical one
      const expected = offered.has(s.id) || s.id === 's-bal-org'
      expect(isScopeEligible(HQ, ORGS, s), s.id).toBe(expected)
    }
  })
  it('rejects a Distributor / Shop / Manufacturer / other-HQ / unattached scope for an HQ recipient', () => {
    for (const id of ['s-dist', 's-shop', 's-mfg', 's-hq2', 's-zeta', 's-loose']) expect(isScopeEligible(HQ, ORGS, byId(id)), id).toBe(false)
  })
  it('a warehouse recipient cannot be given another warehouse or the HQ', () => {
    expect(isScopeEligible(ORGS[1], ORGS, byId('s-alma'))).toBe(false)
    expect(isScopeEligible(ORGS[1], ORGS, byId('s-hq'))).toBe(false)
    expect(isScopeEligible(ORGS[1], ORGS, byId('s-bal'))).toBe(true)
  })
  it('judges structural scopes only; typed scopes keep their own rules', () => {
    expect(isScopeEligible(HQ, ORGS, byId('s-territory'))).toBe(true)
  })
  it('a scope whose value is not its organization is never eligible', () => {
    expect(isScopeEligible(HQ, ORGS, def('odd', 'hq', 'organization', 'dist'))).toBe(false)
  })
})

describe('policy compatibility', () => {
  const stock = ['inventory.stock_count.verify', 'warehouse.shipment.manage']
  it('classifies full, partial and none', () => {
    expect(warehouseSupportFor(stock).level).toBe('full')
    expect(warehouseSupportFor([...stock, 'supply_chain.order.approve'])).toEqual({ level: 'partial', supported: 2, total: 3 })
    expect(warehouseSupportFor(['finance.journal.post']).level).toBe('none')
    expect(warehouseSupportFor([]).level).toBe('full')
  })
  it('a policy no warehouse can limit is not offered a warehouse scope; HQ and partial policies are', () => {
    const none = warehouseSupportFor(['finance.journal.post'])
    expect(choiceAllowedForPolicy({ kind: 'warehouse' }, none)).toBe(false)
    expect(choiceAllowedForPolicy({ kind: 'hq' }, none)).toBe(true)
    expect(choiceAllowedForPolicy({ kind: 'warehouse' }, warehouseSupportFor([...stock, 'supply_chain.order.approve']))).toBe(true)
  })
  it('every warehouse-capable permission is one the database gates pass a warehouse_id for', () => {
    const sql = readFileSync(path.resolve(__dirname, '../../../../supabase/migrations/20260928120000_sa_final_modules_supply_chain.sql'), 'utf8')
    const fromSql = new Set([...sql.matchAll(/sa_require_operation\('([a-z_.]+)', jsonb_build_object\([^;]*warehouse_id/g)].map(m => m[1]))
    // stock-count verify/post are enforced by the verification routes (resolveWarehouseResourceContext), not an SQL gate
    const routeEnforced = new Set(['inventory.stock_count.verify', 'inventory.stock_count.post'])
    for (const key of WAREHOUSE_SCOPED_PERMISSIONS) expect(fromSql.has(key) || routeEnforced.has(key), key).toBe(true)
    for (const key of fromSql) expect(WAREHOUSE_SCOPED_PERMISSIONS.has(key), key).toBe(true)
  })
})

describe('SQL lock-step', () => {
  const sql = readFileSync(path.resolve(__dirname, '../../../../supabase/migrations/20261011100000_sa_scope_eligibility_for_grants.sql'), 'utf8')
  it('the unapplied migration encodes the same rule and never touches existing grants or the evaluator', () => {
    expect(sql).toMatch(/r\.org_type_code = 'HQ'/)
    expect(sql).toMatch(/t\.org_type_code = 'WH'/)
    expect(sql).toMatch(/parent_org_id = p_membership_org/)
    expect(sql).toMatch(/source not in \('manual', 'access_request'\)/)
    expect(sql).not.toMatch(/\b(delete|update)\s+(from\s+)?public\.sa_(assignment_scopes|role_assignments|scope_definitions)/i)
    expect(sql).not.toMatch(/create or replace function public\.sa_(scope_matches|evaluate_permission)/)
  })
})
