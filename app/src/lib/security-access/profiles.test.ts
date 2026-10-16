import { describe, expect, it, vi } from 'vitest'
import { buildPermissionPicker, isForbiddenForPartner, isSensitivePermission, loadProfiles, mapProfileError, profileActionSchema, profileKind, runProfileAction } from './profiles'

const ROLE = '11111111-1111-4111-8111-111111111111'
const ACTOR = 'actor-1'

describe('profileKind', () => {
  it('separates standard, custom and compatibility roles by their stored source', () => {
    expect(profileKind({ source: 'template' })).toBe('standard')
    expect(profileKind({ source: 'new' })).toBe('custom')
    expect(profileKind({ source: 'legacy' })).toBe('compatibility')
  })
})

describe('profileActionSchema', () => {
  const content = { name: 'Counter', permissionKeys: ['inventory.stock_count.view'] }
  it('accepts explicit permission keys only (no wildcards, no module grants)', () => {
    expect(profileActionSchema.safeParse({ action: 'create', roleKey: 'counter', ...content }).success).toBe(true)
    for (const permissionKeys of [['inventory.*'], ['inventory.stock_count.*'], ['*'], ['inventory'], ['Inventory.Stock_count.View']]) {
      expect(profileActionSchema.safeParse({ action: 'create', roleKey: 'counter', name: 'x', permissionKeys }).success).toBe(false)
    }
    expect(profileActionSchema.safeParse({ action: 'create', roleKey: 'counter', name: 'x', permissionKeys: Array(301).fill('a.b.c') }).success).toBe(false)
  })
  it('is strict: unknown fields (e.g. a forged status, source or version) are rejected', () => {
    expect(profileActionSchema.safeParse({ action: 'save_draft', roleId: ROLE, ...content, source: 'template' }).success).toBe(false)
    expect(profileActionSchema.safeParse({ action: 'publish', roleId: ROLE, impactHash: 'a'.repeat(32), status: 'active' }).success).toBe(false)
  })
  it('requires reasons and a 32-hex impact hash where the database does', () => {
    expect(profileActionSchema.safeParse({ action: 'copy', sourceId: ROLE, roleKey: 'copy', reason: 'short' }).success).toBe(false)
    expect(profileActionSchema.safeParse({ action: 'retire', roleId: ROLE, reason: 'too short' }).success).toBe(false)
    expect(profileActionSchema.safeParse({ action: 'publish', roleId: ROLE, impactHash: 'nope' }).success).toBe(false)
    expect(profileActionSchema.safeParse({ action: 'publish', roleId: ROLE, impactHash: 'a'.repeat(32), reason: 'reviewed and approved' }).success).toBe(true)
  })
})

describe('runProfileAction', () => {
  const admin = (error: any = null, data: any = 'ok') => ({ rpc: vi.fn(async () => ({ data, error })) })
  it('calls exactly one database function as the authenticated actor, never a client-named one', async () => {
    const a = admin()
    await runProfileAction(a, ACTOR, { action: 'publish', roleId: ROLE, impactHash: 'a'.repeat(32), reason: 'reviewed and approved' })
    expect(a.rpc).toHaveBeenCalledTimes(1)
    expect(a.rpc).toHaveBeenCalledWith('sa_publish_profile_draft', { p_actor: ACTOR, p_role: ROLE, p_reason: 'reviewed and approved', p_impact_hash: 'a'.repeat(32) })
  })
  it('maps each action to its database function', async () => {
    const a = admin()
    await runProfileAction(a, ACTOR, { action: 'copy', sourceId: ROLE, roleKey: 'k', name: '', reason: 'copy for customization' })
    await runProfileAction(a, ACTOR, { action: 'submit', roleId: ROLE })
    await runProfileAction(a, ACTOR, { action: 'preview', roleId: ROLE })
    await runProfileAction(a, ACTOR, { action: 'retire', roleId: ROLE, reason: 'no longer needed here' })
    await runProfileAction(a, ACTOR, { action: 'holders', roleId: ROLE })
    expect((a.rpc.mock.calls as any[]).map(c => c[0])).toEqual(['sa_copy_access_profile', 'sa_submit_profile_draft', 'sa_profile_publish_preview', 'sa_retire_access_profile', 'sa_profile_holders'])
  })
  it.each([
    ['sa_profile_standard_protected', 409, 'standard_protected'], ['sa_profile_stale_preview', 409, 'stale_preview'],
    ['sa_profile_holder_conflict: 1', 409, 'holder_conflict'], ['sa_profile_has_holders: 3', 409, 'has_holders'],
    ['sa_profile_self_review_prohibited', 403, 'self_review'], ['sa_profile_partner_forbidden: hr.employee.view', 409, 'partner_forbidden'],
    ['sa_authorization_required', 403, 'forbidden'], ['sa_profile_not_in_review', 409, 'not_in_review'],
  ])('maps %s', async (message, status, code) => {
    expect(await runProfileAction(admin({ message }), ACTOR, { action: 'submit', roleId: ROLE })).toMatchObject({ ok: false, status, code })
  })
  it('explains a missing migration and never leaks unexpected errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await runProfileAction(admin({ code: 'PGRST202', message: 'Could not find the function' }), ACTOR, { action: 'submit', roleId: ROLE })).toMatchObject({ ok: false, code: 'profiles_migration_missing' })
    expect(JSON.stringify(mapProfileError({ message: 'relation "secret" does not exist at 12', code: 'XX' }))).not.toContain('secret')
  })
})

describe('loadProfiles', () => {
  const role = (over: any = {}) => ({ id: 'r1', role_key: 'k', name: 'Counter', description: null, source: 'new', status: 'active', version: 2, applicable_account_types: ['partner'], applicable_org_types: ['MFG'], copied_from_role_id: null, permissions: [{ permission: { permission_key: 'inventory.stock_count.view' } }], ...over })
  const client = (over: { roles?: any[]; fullError?: any; counts?: any[]; drafts?: any[] } = {}) => ({
    from: (table: string) => {
      const chain: any = { select: (cols: string) => chain, order: async () => (table === 'sa_business_roles' && over.fullError && String(chain.cols).includes('applicable') ? { data: null, error: over.fullError } : { data: over.roles ?? [role()], error: null }), in: async () => ({ data: over.drafts ?? [], error: null }) }
      chain.select = (cols: string) => { chain.cols = cols; return chain }
      return chain
    },
    rpc: async () => ({ data: over.counts ?? [{ role_id: 'r1', holders: 5, visible_holders: 2 }], error: null }),
  })
  it('classifies profiles and attaches drafts and holder counts', async () => {
    const out = await loadProfiles(client({ drafts: [{ id: 'd1', role_id: 'r1', status: 'in_review', name: 'Counter', permission_keys: ['inventory.stock_count.view', 'inventory.stock_count.create'], applicable_account_types: [], applicable_org_types: [], updated_at: 'now' }] }), ACTOR)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.profiles[0]).toMatchObject({ kind: 'custom', holders: 5, visibleHolders: 2, accountTypes: ['partner'], draft: { status: 'in_review' } })
    expect(out.value.profiles[0].draft!.permissionKeys).toHaveLength(2)
  })
  it('still lists the roles read-only when the migration is not applied', async () => {
    const out = await loadProfiles(client({ fullError: { code: '42703', message: 'column does not exist' }, roles: [role({ source: 'template' })] }), ACTOR)
    expect(out.ok && out.value.migrationReady).toBe(false)
    expect(out.ok && out.value.profiles[0].kind).toBe('standard')
  })
})

describe('permission picker', () => {
  const perms = [
    { permission_key: 'inventory.stock_count.view' }, { permission_key: 'inventory.stock_count.create' }, { permission_key: 'inventory.transfer.request' },
    { permission_key: 'finance.ledger.view' }, { permission_key: 'supply_chain.order.create' },
  ]
  it('is module → functional area → operation, and groups across modules', () => {
    const tree = buildPermissionPicker(perms)
    const supply = tree.find(m => m.name === 'Supply Chain')!
    expect(supply.areas.map(a => a.name).sort()).toEqual(['Orders & Documents', 'Stock Count', 'Stock Transfer'])
    expect(supply.areas.find(a => a.name === 'Stock Count')!.permissions.map(p => p.key).sort()).toEqual(['inventory.stock_count.create', 'inventory.stock_count.view'])
    expect(tree.map(m => m.name)).toContain('Finance')
    expect(tree.reduce((n, m) => n + m.total, 0)).toBe(perms.length)
  })
  it('lists only the permissions it is given: new catalogue entries are never implied by a module', () => {
    const before = buildPermissionPicker(perms).find(m => m.name === 'Supply Chain')!.total
    const after = buildPermissionPicker([...perms, { permission_key: 'inventory.stock_count.post' }]).find(m => m.name === 'Supply Chain')!.total
    expect(after).toBe(before + 1)   // only displayed; nothing is selected by the picker itself
  })
  it('mirrors the database partner and sensitive rules', () => {
    for (const k of ['hr.employee.view', 'security.access.view', 'platform.user.manage', 'platform.data.destructive', 'finance.data.reset']) expect(isForbiddenForPartner(k)).toBe(true)
    for (const k of ['inventory.stock_count.view', 'supply_chain.order.create', 'finance.ledger.view']) expect(isForbiddenForPartner(k)).toBe(false)
    for (const k of ['security.role.assign', 'hr.data.reset', 'platform.data.destructive', 'finance.data.reset', 'platform.user.password_reset']) expect(isSensitivePermission(k)).toBe(true)
    // Editing profiles is not credential control.
    for (const k of ['platform.user.manage', 'platform.user.profile_edit']) expect(isSensitivePermission(k)).toBe(false)
    expect(isSensitivePermission('hr.employee.view')).toBe(false)
  })
})
