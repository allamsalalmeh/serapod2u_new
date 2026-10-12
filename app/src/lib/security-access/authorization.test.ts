import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorld, fakeClient, legacyPermission, ORG, USER, type FakeWorld } from './test-world'
import type { AuthorizationResource, MigrationMode } from './types'

let world: FakeWorld

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => fakeClient(world) }))
vi.mock('@/lib/server/permissions', () => ({
  checkPermissionForUser: async (userId: string, key: string) => legacyPermission(userId, key),
}))

const { authorize, requireAuthorization, isAuthorizationDenied } = await import('./authorization')
const { resolveWarehouseResourceContext } = await import('./resource-context')

const VERIFY = 'inventory.stock_count.verify'
const MODES: MigrationMode[] = ['LEGACY_ENFORCED', 'SHADOW', 'NEW_ENFORCED', 'LEGACY_RETIRED']
const actorOrg: Record<string, string> = {
  [USER.sa]: ORG.hqA, [USER.hq]: ORG.hqA, [USER.manager]: ORG.hqA, [USER.user]: ORG.hqA, [USER.wh1]: ORG.whA1,
  [USER.inactive]: ORG.hqA, [USER.expired]: ORG.hqA, [USER.distManager]: ORG.distA, [USER.hqB]: ORG.hqB,
}

// The real Stock Count path: organization context is resolved from the
// warehouse's ancestry, never taken from the caller unconditionally.
async function stockCount(actorId: string, warehouseId: string): Promise<AuthorizationResource> {
  return { type: 'stock_count', id: `sc-${warehouseId}`, ...(await resolveWarehouseResourceContext(actorOrg[actorId], warehouseId)) }
}

async function run(mode: MigrationMode, actorId: string, resource: AuthorizationResource) {
  world.modes[VERIFY] = mode
  const before = world.decisions.length
  try {
    const decision = await requireAuthorization({ actorId, permission: VERIFY, resource })
    return { allowed: true, decision, logged: world.decisions.slice(before) }
  } catch (error) {
    if (!isAuthorizationDenied(error)) throw error
    return { allowed: false, error, logged: world.decisions.slice(before) }
  }
}

beforeEach(() => { world = createWorld() })

// [label, actor, warehouse, legacy outcome, new outcome, new reason]
const matrix: Array<[string, string, string, 'ALLOW' | 'DENY', 'ALLOW' | 'DENY', string]> = [
  ['SA, correct org + warehouse', USER.sa, ORG.whA1, 'ALLOW', 'ALLOW', 'ALLOWED_BY_ASSIGNMENT'],
  ['HQ, correct org + warehouse', USER.hq, ORG.whA1, 'ALLOW', 'ALLOW', 'ALLOWED_BY_ASSIGNMENT'],
  ['Manager, correct org + warehouse', USER.manager, ORG.whA2, 'ALLOW', 'ALLOW', 'ALLOWED_BY_ASSIGNMENT'],
  ['ordinary USER, correct org + warehouse', USER.user, ORG.whA1, 'DENY', 'DENY', 'MISSING_PERMISSION'],
  ['warehouse-scoped user, own warehouse', USER.wh1, ORG.whA1, 'ALLOW', 'ALLOW', 'ALLOWED_BY_ASSIGNMENT'],
  ['warehouse-scoped user, wrong warehouse', USER.wh1, ORG.whA2, 'ALLOW', 'DENY', 'MISSING_MEMBERSHIP'],
  ['HQ of another tenant (wrong org)', USER.hqB, ORG.whA1, 'ALLOW', 'DENY', 'MISSING_MEMBERSHIP'],
  ['distributor manager (wrong org, same tenant)', USER.distManager, ORG.whA1, 'ALLOW', 'DENY', 'MISSING_MEMBERSHIP'],
  ['expired membership', USER.expired, ORG.whA1, 'ALLOW', 'DENY', 'MISSING_MEMBERSHIP'],
]

describe('inventory.stock_count.verify enforcement matrix (real path context)', () => {
  for (const [label, actor, warehouse, legacy, next, reason] of matrix) {
    for (const mode of MODES) {
      const newAuthoritative = mode === 'NEW_ENFORCED' || mode === 'LEGACY_RETIRED'
      const expected = newAuthoritative ? next : legacy
      it(`${label} · ${mode} → ${expected}`, async () => {
        const result = await run(mode, actor, await stockCount(actor, warehouse))
        expect(result.allowed).toBe(expected === 'ALLOW')
        expect(result.logged).toHaveLength(1)
        const row = result.logged[0]
        expect(row.decision).toBe(expected)
        expect(row.new_decision).toBe(next)
        expect(row.migration_mode).toBe(mode)
        expect(row.legacy_decision).toBe(mode === 'LEGACY_RETIRED' ? null : legacy)
        if (next === 'DENY') expect(result.allowed ? null : (result as any).error.reasonCode).toBe(newAuthoritative ? reason : (legacy === 'ALLOW' ? null : 'LEGACY_DENIED'))
      })
    }
  }
})

describe('engine-level context cases', () => {
  it('wrong warehouse inside the actor organization is a SCOPE_MISMATCH', async () => {
    const result = await run('NEW_ENFORCED', USER.wh1, { type: 'stock_count', id: 'sc', organizationId: ORG.whA1, warehouseId: ORG.whA2 })
    expect(result.allowed).toBe(false)
    expect((result as any).error.reasonCode).toBe('SCOPE_MISMATCH')
  })

  it('a warehouse-scoped actor on exactly its warehouse organization (no warehouse id) is allowed; a sibling is denied', async () => {
    // 20261109100000: a warehouse is an organization, so a resource of exactly that organization is the warehouse's.
    const own = await run('NEW_ENFORCED', USER.wh1, { type: 'stock_count', id: 'sc', organizationId: ORG.whA1 })
    expect(own.allowed).toBe(true)
    const sibling = await run('NEW_ENFORCED', USER.wh1, { type: 'stock_count', id: 'sc', organizationId: ORG.whA2 })
    expect(sibling.allowed).toBe(false)
  })

  it('wrong organization supplied explicitly is denied for org-scoped HQ', async () => {
    const result = await run('NEW_ENFORCED', USER.hq, { type: 'stock_count', id: 'sc', organizationId: ORG.hqB, warehouseId: ORG.whB })
    expect(result.allowed).toBe(false)
    expect((result as any).error.reasonCode).toBe('MISSING_MEMBERSHIP')
  })
})

describe('critical mode contract', () => {
  it('legacy ALLOW + new DENY + NEW_ENFORCED → DENY (no legacy fallback)', async () => {
    const result = await run('NEW_ENFORCED', USER.hqB, await stockCount(USER.hqB, ORG.whA1))
    expect(result.allowed).toBe(false)
    expect(result.logged[0]).toMatchObject({ legacy_decision: 'ALLOW', new_decision: 'DENY', decision: 'DENY', audit_class: 'ENFORCED_DECISION' })
  })

  it('legacy ALLOW + new DENY + SHADOW → ALLOW, comparison logged', async () => {
    const result = await run('SHADOW', USER.hqB, await stockCount(USER.hqB, ORG.whA1))
    expect(result.allowed).toBe(true)
    expect(result.logged[0]).toMatchObject({
      legacy_decision: 'ALLOW', new_decision: 'DENY', decision: 'ALLOW',
      comparison: 'LEGACY_ALLOW_NEW_DENY', reason_code: 'LEGACY_ALLOWED', audit_class: 'ORDINARY_SHADOW',
    })
  })

  it('inactive account is denied in every mode, even with legacy ALLOW', async () => {
    for (const mode of MODES) {
      const result = await run(mode, USER.inactive, await stockCount(USER.inactive, ORG.whA1))
      expect(result.allowed, mode).toBe(false)
      expect((result as any).error.reasonCode, mode).toBe('ACCOUNT_INACTIVE')
    }
  })

  it('NEW_ENFORCED ALLOW whose audit row cannot be written fails closed', async () => {
    world.failDecisionInsert = true
    const result = await run('NEW_ENFORCED', USER.sa, await stockCount(USER.sa, ORG.whA1))
    expect(result.allowed).toBe(false)
    expect((result as any).error.reasonCode).toBe('POLICY_ERROR')
  })

  it('SHADOW audit write failure keeps the legacy outcome', async () => {
    world.failDecisionInsert = true
    const result = await run('SHADOW', USER.sa, await stockCount(USER.sa, ORG.whA1))
    expect(result.allowed).toBe(true)
  })

  it('migration-mode lookup failure fails closed instead of assuming legacy', async () => {
    world.failModeLookup = true
    await expect(requireAuthorization({ actorId: USER.sa, permission: VERIFY, resource: await stockCount(USER.sa, ORG.whA1) }))
      .rejects.toThrow('migration_mode_unavailable')
  })

  it('denial exposes only the decision id and a stable reason code', async () => {
    const result = await run('NEW_ENFORCED', USER.hqB, await stockCount(USER.hqB, ORG.whA1))
    const error = (result as any).error
    expect(Object.keys(error).sort()).toEqual(['decisionId', 'name', 'reasonCode', 'status'])
    expect(error.message).toBe('Forbidden')
  })
})

describe('audit classification at write time', () => {
  it('protects security-sensitive permissions and policy errors', async () => {
    world.modes['security.role.assign'] = 'LEGACY_ENFORCED'
    world.sensitivity['security.role.assign'] = 'security_sensitive'
    await authorize({ actorId: USER.sa, permission: 'security.role.assign', resource: { type: 'business_role' } })
    expect(world.decisions.at(-1)?.audit_class).toBe('SECURITY_SENSITIVE')

    world.failPolicyData = true
    await authorize({ actorId: USER.sa, permission: VERIFY, resource: await stockCount(USER.sa, ORG.whA1) })
    expect(world.decisions.at(-1)).toMatchObject({ comparison: 'POLICY_ERROR', audit_class: 'POLICY_ERROR' })
  })

  it('treats an unknown permission sensitivity as protected', async () => {
    delete world.sensitivity[VERIFY]
    await authorize({ actorId: USER.sa, permission: VERIFY, resource: await stockCount(USER.sa, ORG.whA1) })
    expect(world.decisions.at(-1)?.audit_class).toBe('SECURITY_SENSITIVE')
  })

  it('explain-only evaluation never writes a decision', async () => {
    await authorize({ actorId: USER.sa, permission: VERIFY, resource: await stockCount(USER.sa, ORG.whA1), context: { explainOnly: true } }, { log: false })
    expect(world.decisions).toHaveLength(0)
  })
})
