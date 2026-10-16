import { describe, expect, it } from 'vitest'
import {
  MAX_POLICY_SCOPE_PAIRS, autoSelectSoleScopes, buildCatalogue, coveredByFullAccess, missingScopeMessage, pruneSelections, scopeGroups, setScopeFor, togglePolicy,
  type ProfileChoice, type SelectableProfile, type SelectableScope,
} from './group-policy-picker'

const p = (over: Partial<SelectableProfile> & { id: string }): SelectableProfile => ({ name: over.id, kind: 'standard', ...over })
const SC = p({ id: 'sc', roleKey: 'supply-chain-full-access', permissionKeys: ['inventory.stock_count.view', 'inventory.stock_count.post'] })
const COVERED = p({ id: 'cov', permissionKeys: ['inventory.stock_count.view'] })
const NOT_COVERED = p({ id: 'extra', permissionKeys: ['inventory.stock_count.view', 'inventory.audit.run'] })
const CUSTOM = p({ id: 'cus', kind: 'custom', permissionKeys: ['inventory.stock_count.view'] })
const UNKNOWN = p({ id: 'unk' })
const NAME_ONLY = p({ id: 'named', name: 'Supply Chain Full Access', permissionKeys: ['inventory.stock_count.view'] })    // looks like Full Access, is not in the catalogue
const profiles = [SC, COVERED, NOT_COVERED, CUSTOM, UNKNOWN, NAME_ONLY]
const sc = (id: string, scope_type = 'warehouse'): SelectableScope => ({ id, organization_id: id, scope_type, display_name: id })
const ctx = (scopes: SelectableScope[]) => ({ profiles, scopes })

describe('coverage is proven by contents, not names or modules', () => {
  it('requires every permission of a standard narrower policy to be in the Full Access policy', () => {
    expect(coveredByFullAccess(SC, COVERED)).toBe(true)
    expect(coveredByFullAccess(SC, NOT_COVERED)).toBe(false)
    expect(coveredByFullAccess(SC, CUSTOM)).toBe(false)         // custom is never replaced
    expect(coveredByFullAccess(SC, UNKNOWN)).toBe(false)        // unknown contents are never proven
    expect(coveredByFullAccess(SC, SC)).toBe(false)
  })
  it('only catalogue Full Access policies (role key + standard) form a Full Access row; a look-alike name does not', () => {
    const std = buildCatalogue(profiles).standard
    const supply = std.find(m => m.id === 'supply_chain')!
    expect(supply.fullAccess?.id).toBe('sc')
    expect(supply.policies.map(x => x.id)).toEqual(expect.arrayContaining(['named', 'cov', 'extra']))
    expect(buildCatalogue(profiles).custom.flatMap(m => m.policies.map(x => x.id))).toEqual(['cus'])
  })
})

describe('togglePolicy', () => {
  const one = ctx([sc('s1')])
  it('Full Access replaces only covered standard selections and inherits their scope', () => {
    const start: ProfileChoice[] = [{ roleId: 'cov', scopeId: 's1' }, { roleId: 'extra', scopeId: 's1' }, { roleId: 'cus', scopeId: 's1' }, { roleId: 'unk', scopeId: 's1' }]
    const r = togglePolicy(ctx([sc('s1'), sc('s2')]), start, 'sc', true)
    expect(r.items.map(i => i.roleId)).toEqual(['extra', 'cus', 'unk', 'sc'])
    expect(r.items.find(i => i.roleId === 'sc')?.scopeId).toBe('s1')
    expect(r.notice).toMatch(/replaced cov/)
  })
  it('does not treat a covered policy as covered when its scope is not valid for the Full Access policy', () => {
    const narrow = { ...SC, scopeTypes: ['organization'] }
    const c = { profiles: [narrow, COVERED], scopes: [sc('w1'), sc('o1', 'organization')] }
    const r = togglePolicy(c, [{ roleId: 'cov', scopeId: 'w1' }], 'sc', true)
    expect(r.items.map(i => i.roleId).sort()).toEqual(['cov', 'sc'])
    expect(r.notice).toBeNull()
  })
  it('a narrower policy removes only its own module’s Full Access, explicitly', () => {
    const r = togglePolicy(one, [{ roleId: 'sc', scopeId: 's1' }], 'extra', true)
    expect(r.items.map(i => i.roleId)).toEqual(['extra'])
    expect(r.notice).toMatch(/removed because you chose specific groups/)
  })
  it('never duplicates and unticking removes every row of the policy', () => {
    const on = togglePolicy(one, [], 'sc', true).items
    expect(togglePolicy(one, on, 'sc', true).items).toBe(on)
    expect(togglePolicy(one, on, 'sc', false).items).toEqual([])
  })
  it('starts unscoped when several scopes are valid (never broader), and refuses more than the server accepts', () => {
    const many = ctx(Array.from({ length: 22 }, (_, i) => sc(`s${i}`)))
    expect(togglePolicy(many, [], 'sc', true).items).toEqual([{ roleId: 'sc', scopeId: '' }])
    const full = Array.from({ length: MAX_POLICY_SCOPE_PAIRS }, (_, i) => ({ roleId: 'extra', scopeId: `s${i}` }))
    const r = togglePolicy(many, full, 'cov', true)
    expect(r.items).toBe(full)
    expect(r.notice).toMatch(/At most 20/)
  })
})

describe('scope groups', () => {
  it('shares one control only for identical valid scope sets, else separate controls', () => {
    const c = { profiles: [p({ id: 'a' }), p({ id: 'b' }), p({ id: 'c', scopeTypes: ['organization'] })], scopes: [sc('w1'), sc('o1', 'organization')] }
    const items = [{ roleId: 'a', scopeId: '' }, { roleId: 'b', scopeId: '' }, { roleId: 'c', scopeId: '' }]
    const groups = scopeGroups(c, items)
    expect(groups.map(g => g.policyIds)).toEqual([['a', 'b'], ['c']])
  })
  it('auto-selects only an exactly-one option; never a guess', () => {
    const c = { profiles: [p({ id: 'a' }), p({ id: 'c', scopeTypes: ['organization'] })], scopes: [sc('w1'), sc('o1', 'organization')] }
    const out = autoSelectSoleScopes(c, [{ roleId: 'a', scopeId: '' }, { roleId: 'c', scopeId: '' }])
    expect(out).toEqual([{ roleId: 'a', scopeId: '' }, { roleId: 'c', scopeId: 'o1' }])
    expect(autoSelectSoleScopes(c, out)).toBe(out)
  })
  it('setScopeFor toggles a scope for every policy of the control and keeps list order', () => {
    const items = [{ roleId: 'a', scopeId: '' }, { roleId: 'b', scopeId: '' }]
    const on = setScopeFor(items, ['a', 'b'], 'w1', true).items
    expect(on).toEqual([{ roleId: 'a', scopeId: 'w1' }, { roleId: 'b', scopeId: 'w1' }])
    expect(setScopeFor(on, ['a', 'b'], 'w1', false).items).toEqual(items)
  })
})

describe('organization change and missing scope', () => {
  it('keeps still-offered selections, drops unknown policies, and un-scopes (never widens) a vanished scope', () => {
    const c = { profiles: [COVERED, NOT_COVERED], scopes: [sc('new')] }
    const { kept, removed } = pruneSelections(c, [{ roleId: 'cov', scopeId: 'old' }, { roleId: 'extra', scopeId: '' }, { roleId: 'gone', scopeId: 'new' }])
    expect(kept).toEqual([{ roleId: 'extra', scopeId: '' }, { roleId: 'cov', scopeId: '' }])
    expect(removed).toBe(2)
  })
  it('says accurately what is missing', () => {
    const c = { profiles: [COVERED], scopes: [sc('w1'), sc('w2')] }
    expect(missingScopeMessage(c, [{ roleId: 'cov', scopeId: '' }])).toBe('Choose a data scope for cov. A policy is never assigned without one.')
    expect(missingScopeMessage({ profiles: [COVERED], scopes: [] }, [{ roleId: 'cov', scopeId: '' }])).toMatch(/No data scope is available for cov/)
    expect(missingScopeMessage(c, [{ roleId: 'cov', scopeId: 'w1' }])).toBeNull()
  })
})
