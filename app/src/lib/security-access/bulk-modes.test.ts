import { describe, expect, it, vi } from 'vitest'
import { MODULE_TAXONOMY } from './modules'
import { applyBulkModeChange, previewBulkModeChange, previewHashOf, resolveGroup } from './bulk-modes'

const ACTOR = 'actor-1'
const KEY = '11111111-1111-4111-8111-111111111111'

// Registered permissions: Supply Chain (Stock Count, Stock Transfer, Orders), Finance, Platform.
const REGISTERED: Array<[string, string]> = [
  ['inventory.stock_count.view', 'NEW_ENFORCED'], ['inventory.stock_count.create', 'NEW_ENFORCED'], ['inventory.stock_count.verify', 'SHADOW'],
  ['inventory.transfer.request', 'NEW_ENFORCED'], ['supply_chain.order.create', 'NEW_ENFORCED'],
  ['finance.ledger.view', 'SHADOW'],
]
const ready = new Set(['inventory.stock_count.view', 'inventory.stock_count.create', 'inventory.stock_count.verify', 'inventory.transfer.request', 'supply_chain.order.create'])

/** In-memory stand-in for the admin client: same evaluation rules as sa_bulk_mode_evaluate. */
function fakeAdmin(opts: { missingFunction?: boolean; batches?: any[]; applyError?: any } = {}) {
  const modes = new Map(REGISTERED)
  const calls: Array<{ fn: string; args: any }> = []
  const batches = opts.batches ?? []
  const evaluate = (keys: string[], target: string) => keys.map(key => {
    const current = modes.get(key)
    const blockers = [
      !current ? 'sa_permission_unknown' : null,
      current && ['NEW_ENFORCED', 'LEGACY_RETIRED'].includes(target) && !ready.has(key) ? 'sa_not_enforcement_ready' : null,
      current && target === 'LEGACY_RETIRED' && !['NEW_ENFORCED', 'LEGACY_RETIRED'].includes(current) ? 'sa_retire_requires_new_enforced' : null,
    ].filter(Boolean)
    return { permission_key: key, current_mode: current ?? null, status: blockers.length ? 'blocked' : current === target ? 'unchanged' : 'change', blockers }
  })
  const admin = {
    modes,
    calls,
    from(table: string) {
      if (table === 'sa_migration_modes') return { select: async () => ({ data: Array.from(modes, ([permission_key, mode]) => ({ permission_key, mode })), error: null }) }
      const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: batches[0] ?? null, error: null }) }
      return chain
    },
    async rpc(fn: string, args: any) {
      calls.push({ fn, args })
      if (opts.missingFunction) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
      if (fn === 'sa_preview_bulk_migration_mode') return { data: evaluate(args.p_permissions, args.p_target), error: null }
      if (opts.applyError) return { data: null, error: opts.applyError }
      return { data: { batchId: 'b-1', changed: 2, unchanged: 0, skipped: 1, replayed: false, items: [] }, error: null }
    },
  }
  return admin
}

describe('resolveGroup: server-side membership', () => {
  const keys = REGISTERED.map(([k]) => k)
  it('a module group contains every permission of its subgroups', () => {
    const g = resolveGroup('supply_chain', keys)!
    expect(g.kind).toBe('group')
    expect(g.keys).toEqual(['inventory.stock_count.create', 'inventory.stock_count.verify', 'inventory.stock_count.view', 'inventory.transfer.request', 'supply_chain.order.create'])
  })
  it('a subgroup contains only its own permissions and names its module', () => {
    const g = resolveGroup('supply_chain/stock_count', keys)!
    expect(g.kind).toBe('subgroup')
    expect(g.name).toBe('Supply Chain · Stock Count')
    expect(g.keys).toEqual(['inventory.stock_count.create', 'inventory.stock_count.verify', 'inventory.stock_count.view'])
    expect(resolveGroup('supply_chain/stock_transfer', keys)!.keys).toEqual(['inventory.transfer.request'])
  })
  it('never crosses module boundaries', () => {
    expect(resolveGroup('finance', keys)!.keys).toEqual(['finance.ledger.view'])
    expect(resolveGroup('finance/stock_count', keys)).toBeNull()
  })
  it('unregistered permissions are never invented; membership comes only from registered keys', () => {
    expect(resolveGroup('supply_chain', ['finance.ledger.view'])!.keys).toEqual([])
  })
  it('rejects forged or malformed group ids', () => {
    for (const id of ['', 'nope', 'supply_chain/nope', 'supply_chain/stock_count/x', '../etc', 'supply_chain/', '/stock_count', 'other/stock_count']) expect(resolveGroup(id, keys)).toBeNull()
  })
  it('every taxonomy group and area resolves (ids match the Overview node ids)', () => {
    for (const g of MODULE_TAXONOMY) {
      expect(resolveGroup(g.id, [])).not.toBeNull()
      for (const a of g.areas ?? []) expect(resolveGroup(`${g.id}/${a.id}`, [])).not.toBeNull()
    }
  })
})

describe('previewBulkModeChange', () => {
  it('reports changes, already-in-target and blocked with specific reasons; hidden permissions are included', async () => {
    const admin = fakeAdmin()
    const out = await previewBulkModeChange(admin, ACTOR, { groupId: 'supply_chain/stock_count', targetMode: 'LEGACY_RETIRED' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const p = out.value
    expect(p.group).toMatchObject({ name: 'Supply Chain · Stock Count', total: 3 })
    expect(p.counts).toEqual({ change: 2, unchanged: 0, blocked: 1 })
    expect(p.canApplyAll).toBe(false)
    expect(p.canApplyEligibleOnly).toBe(true)
    const blocked = p.rows.find(r => r.status === 'blocked')!
    expect(blocked.permissionKey).toBe('inventory.stock_count.verify')
    expect(blocked.blockers[0].message).toMatch(/New Access Active first/)
    // The browser never supplied the list: the server sent exactly the group's keys.
    expect(admin.calls[0].args.p_permissions).toEqual(['inventory.stock_count.create', 'inventory.stock_count.verify', 'inventory.stock_count.view'])
    expect(admin.calls[0].args.p_actor).toBe(ACTOR)
  })
  it('offers "all" only when nothing is blocked, and nothing when no change remains', async () => {
    const clean = await previewBulkModeChange(fakeAdmin(), ACTOR, { groupId: 'supply_chain/stock_transfer', targetMode: 'LEGACY_RETIRED' })
    expect(clean.ok && clean.value.canApplyAll).toBe(true)
    const noop = await previewBulkModeChange(fakeAdmin(), ACTOR, { groupId: 'supply_chain/stock_transfer', targetMode: 'NEW_ENFORCED' })
    expect(noop.ok && [noop.value.canApplyAll, noop.value.canApplyEligibleOnly, noop.value.counts.unchanged]).toEqual([false, false, 1])
  })
  it('explains a missing migration instead of failing opaquely', async () => {
    const out = await previewBulkModeChange(fakeAdmin({ missingFunction: true }), ACTOR, { groupId: 'finance', targetMode: 'SHADOW' })
    expect(out).toMatchObject({ ok: false, status: 409, code: 'bulk_migration_missing' })
    expect(!out.ok && out.error).toMatch(/20261004100000_sa_bulk_migration_mode\.sql/)
  })
  it('rejects unknown groups', async () => {
    expect(await previewBulkModeChange(fakeAdmin(), ACTOR, { groupId: 'bogus', targetMode: 'SHADOW' })).toMatchObject({ ok: false, status: 400, code: 'unknown_group' })
  })
  it('the preview hash changes when a relevant mode changes', async () => {
    const a = await previewBulkModeChange(fakeAdmin(), ACTOR, { groupId: 'supply_chain/stock_count', targetMode: 'LEGACY_RETIRED' })
    const admin = fakeAdmin(); admin.modes.set('inventory.stock_count.view', 'SHADOW')
    const b = await previewBulkModeChange(admin, ACTOR, { groupId: 'supply_chain/stock_count', targetMode: 'LEGACY_RETIRED' })
    expect(a.ok && b.ok && a.value.previewHash !== b.value.previewHash).toBe(true)
    expect(previewHashOf('g', 'SHADOW', [])).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('applyBulkModeChange', () => {
  const input = (previewHash: string, over: any = {}) => ({ groupId: 'supply_chain/stock_count', targetMode: 'LEGACY_RETIRED' as const, selection: 'eligible_only' as const, reason: '  Parity reviewed  ', previewHash, idempotencyKey: KEY, ...over })
  const hashOf = async (admin: any, over: any = {}) => { const p = await previewBulkModeChange(admin, ACTOR, { groupId: 'supply_chain/stock_count', targetMode: 'LEGACY_RETIRED', ...over }); return p.ok ? p.value.previewHash : '' }

  it('sends the whole group, previewed modes, trimmed reason and idempotency key to ONE database call', async () => {
    const admin = fakeAdmin()
    const out = await applyBulkModeChange(admin, ACTOR, input(await hashOf(admin)))
    expect(out.ok && out.value.changed).toBe(2)
    const applies = admin.calls.filter(c => c.fn === 'sa_bulk_set_migration_mode')
    expect(applies).toHaveLength(1)
    expect(applies[0].args).toMatchObject({
      p_actor: ACTOR, p_target: 'LEGACY_RETIRED', p_reason: 'Parity reviewed', p_selection: 'eligible_only', p_idempotency_key: KEY,
      p_permissions: ['inventory.stock_count.create', 'inventory.stock_count.verify', 'inventory.stock_count.view'],
      p_expected: { 'inventory.stock_count.create': 'NEW_ENFORCED', 'inventory.stock_count.verify': 'SHADOW', 'inventory.stock_count.view': 'NEW_ENFORCED' },
    })
  })
  it('rejects a stale preview without calling the database apply function', async () => {
    const admin = fakeAdmin()
    const hash = await hashOf(admin)
    admin.modes.set('inventory.stock_count.view', 'SHADOW')
    expect(await applyBulkModeChange(admin, ACTOR, input(hash))).toMatchObject({ ok: false, status: 409, code: 'stale_preview' })
    expect(admin.calls.some(c => c.fn === 'sa_bulk_set_migration_mode')).toBe(false)
  })
  it('"all permissions" is refused while anything is blocked', async () => {
    const admin = fakeAdmin()
    expect(await applyBulkModeChange(admin, ACTOR, input(await hashOf(admin), { selection: 'all' }))).toMatchObject({ ok: false, status: 409, code: 'blocked' })
    expect(admin.calls.some(c => c.fn === 'sa_bulk_set_migration_mode')).toBe(false)
  })
  it('a batch with nothing to change is refused', async () => {
    const admin = fakeAdmin()
    const hash = await hashOf(admin, { targetMode: 'NEW_ENFORCED', groupId: 'supply_chain/stock_transfer' })
    expect(await applyBulkModeChange(admin, ACTOR, input(hash, { groupId: 'supply_chain/stock_transfer', targetMode: 'NEW_ENFORCED' }))).toMatchObject({ ok: false, code: 'no_changes' })
  })
  it('a repeated submission replays the stored result and touches nothing', async () => {
    const stored = { group_id: 'supply_chain/stock_count', target_mode: 'LEGACY_RETIRED', selection: 'eligible_only', result: { batchId: 'b-0', changed: 2, unchanged: 0, skipped: 1, replayed: false, items: [] } }
    const admin = fakeAdmin({ batches: [stored] })
    const out = await applyBulkModeChange(admin, ACTOR, input('0'.repeat(64)))
    expect(out).toMatchObject({ ok: true, value: { batchId: 'b-0', replayed: true } })
    expect(admin.calls).toHaveLength(0)
    const other = await applyBulkModeChange(admin, ACTOR, input('0'.repeat(64), { selection: 'all' }))
    expect(other).toMatchObject({ ok: false, code: 'idempotency_conflict' })
  })
  it.each([
    ['sa_bulk_actor_lockout', 'actor_lockout'], ['sa_bulk_stale_preview', 'stale_preview'], ['sa_authorization_required', 'forbidden'],
    ['sa_retire_requires_new_enforced: x', 'retire_requires_new_enforced'], ['boom', 'failed'],
  ])('maps database error %s to %s and reports nothing changed', async (message, code) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const admin = fakeAdmin({ applyError: { message } })
    const out = await applyBulkModeChange(admin, ACTOR, input(await hashOf(admin)))
    expect(out).toMatchObject({ ok: false, code })
  })
})
