import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorld, fakeClient, legacyPermission, ORG, USER, type FakeWorld } from '@/lib/security-access/test-world'

/**
 * inventory.stock_count.post in the verification preflight (request route + preflight route), through the REAL
 * S&A helper (authorize, policy engine, warehouse resource context) against the fixture world. Only transport is faked.
 */
let world: FakeWorld
vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => fakeClient(world) }))
vi.mock('@/lib/server/permissions', () => ({ checkPermissionForUser: async (userId: string, key: string) => legacyPermission(userId, key) }))

const { createStockCountPreflightDependencies, evaluateStockCountPreflight } = await import('./stock-count-verification-preflight')

beforeEach(() => { world = createWorld() })

const authorizePost = (userId: string, warehouseId: string, legacyAllowed: boolean) =>
  createStockCountPreflightDependencies({}, {}).authorizePost!({ userId, organizationId: legacyPermission(userId, 'post_stock_count').context!.organization_id, warehouseId, sessionId: 'session-1', legacyAllowed })
const postRows = () => world.decisions.filter(d => d.permission_key === 'inventory.stock_count.post')

describe('preflight posting authority (inventory.stock_count.post)', () => {
  it('SHADOW: the legacy key decides exactly as before, and the comparison is recorded', async () => {
    expect(await authorizePost(USER.hqB, ORG.whA1, true)).toBe(true)
    expect(await authorizePost(USER.hq, ORG.whA1, false)).toBe(false)
    expect(postRows().map(r => [r.migration_mode, r.decision, r.new_decision])).toEqual([['SHADOW', 'ALLOW', 'DENY'], ['SHADOW', 'DENY', 'ALLOW']])
  })

  it.each(['NEW_ENFORCED', 'LEGACY_RETIRED'] as const)('%s: S&A decides for the session warehouse (organization and warehouse boundaries)', async (mode) => {
    world.modes['inventory.stock_count.post'] = mode
    expect(await authorizePost(USER.hqB, ORG.whA1, true)).toBe(false)   // another organization, legacy allow ignored
    expect(await authorizePost(USER.hq, ORG.whA1, false)).toBe(true)    // S&A grant, legacy key absent
    expect(await authorizePost(USER.wh1, ORG.whA2, true)).toBe(false)   // warehouse-scoped: other warehouse
    expect(await authorizePost(USER.wh1, ORG.whA1, true)).toBe(true)    // own warehouse
    expect(await authorizePost(USER.user, ORG.whA1, false)).toBe(false) // no posting grant
    expect(await authorizePost(USER.inactive, ORG.whA1, true)).toBe(false)
  })

  it('evaluateStockCountPreflight refuses before any recipient/provider lookup when posting is not allowed', async () => {
    const loadProvider = vi.fn(async () => null)
    const deps: any = {
      loadAccessibleSession: async () => ({ id: 'session-1', status: 'draft', warehouse_organization_id: ORG.whA2, stock_count_session_items: [] }),
      loadActiveWarehouse: async () => ({ id: ORG.whA2 }),
      checkPermission: async (userId: string, key: string) => legacyPermission(userId, key),
      authorizePost: vi.fn(async () => false),
      loadProvider,
    }
    expect(await evaluateStockCountPreflight(deps, USER.wh1, 'session-1')).toEqual({ ok: false, code: 'permission_denied' })
    expect(deps.authorizePost).toHaveBeenCalledWith({ userId: USER.wh1, organizationId: ORG.whA1, warehouseId: ORG.whA2, sessionId: 'session-1', legacyAllowed: true })
    expect(loadProvider).not.toHaveBeenCalled()
  })

  it('evaluateStockCountPreflight continues when S&A allows although the legacy key is absent', async () => {
    const deps: any = {
      loadAccessibleSession: async () => ({ id: 'session-1', status: 'draft', warehouse_organization_id: ORG.whA1, stock_count_session_items: [] }),
      loadActiveWarehouse: async () => ({ id: ORG.whA1 }),
      checkPermission: async () => ({ allowed: false, context: { organization_id: ORG.hqA } }),
      authorizePost: async () => true,
    }
    // Passes the authority gate and stops at the next check (nothing counted).
    expect(await evaluateStockCountPreflight(deps, USER.hq, 'session-1')).toEqual({ ok: false, code: 'invalid_count_data' })
  })
})
