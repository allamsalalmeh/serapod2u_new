import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SUPPLY_CHAIN_ACCESS_PERMISSIONS } from './nav-access'
import { WAREHOUSE_REACH_PERMISSIONS, decidedPerWarehouse, grantedWarehousesFrom } from './warehouse-reach'

const W1 = '00000000-0000-0000-0000-0000000000a1'
const W2 = '00000000-0000-0000-0000-0000000000a2'
const HQ = '00000000-0000-0000-0000-0000000000b1'
const now = new Date('2026-10-12T00:00:00Z')
const row = (over: Record<string, unknown> = {}, scopes: Array<[string, string, string?]> = [['warehouse', W1]]) => ({
  status: 'active', effective_from: null, effective_until: null,
  scopes: scopes.map(([scope_type, scope_value, status]) => ({ scope: { scope_type, scope_value, status: status ?? 'active' } })),
  ...over,
})

describe('WAREHOUSE_REACH_PERMISSIONS', () => {
  it('lists only Supply Chain permissions (nav-access.test.ts keeps that list in step with the catalogues)', () => {
    for (const k of WAREHOUSE_REACH_PERMISSIONS) expect(SUPPLY_CHAIN_ACCESS_PERMISSIONS, k).toContain(k)
  })
  it('never lists permissions decided on the organization', () => {
    for (const k of ['product.catalog.view', 'product.catalog.manage', 'inventory.stock_config.manage', 'inventory.opening_balance.manage',
      'inventory.return.manage', 'inventory.return.request', 'supply_chain.order.create', 'qr.batch.manage', 'platform.organization.manage']) {
      expect(decidedPerWarehouse(k), k).toBe(false)
    }
    expect(decidedPerWarehouse('inventory.transfer.request')).toBe(true)
  })
})

describe('grantedWarehousesFrom', () => {
  it('returns the warehouses of live grants only', () => {
    expect(grantedWarehousesFrom([row()], now)).toEqual([W1])
    expect(grantedWarehousesFrom([row({ status: 'revoked' })], now)).toEqual([])
    expect(grantedWarehousesFrom([row({ effective_until: '2026-10-01T00:00:00Z' })], now)).toEqual([])
    expect(grantedWarehousesFrom([row({ effective_from: '2026-11-01T00:00:00Z' })], now)).toEqual([])
    expect(grantedWarehousesFrom([row({}, [['warehouse', W1, 'inactive']])], now)).toEqual([])
  })
  it('ignores organization and other typed scopes, malformed values; merges grants', () => {
    expect(grantedWarehousesFrom([row({}, [['organization', HQ], ['territory', 'north'], ['warehouse', 'not-a-uuid']])], now)).toEqual([])
    expect(grantedWarehousesFrom([row({}, [['warehouse', W2]]), row(), row()], now)).toEqual([W1, W2])
  })
})

const guardUserOperation = vi.fn()
const rows = vi.fn()
vi.mock('server-only', () => ({}))
vi.mock('@/lib/security-access/operation', () => ({ guardUserOperation }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({
  from: () => ({ select: () => ({ eq: () => ({ eq: async () => rows() }) }) }),
}) }))
const forbidden = { status: 403 }

describe('guardUserOperationInReach', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rows.mockReturnValue({ data: [row()], error: null })
  })
  it('own organization allowed: no warehouse is asked', async () => {
    guardUserOperation.mockResolvedValue(null)
    const { guardUserOperationInReach } = await import('@/lib/server/warehouse-reach')
    expect(await guardUserOperationInReach('u', 'inventory.report.view')).toBeNull()
    expect(guardUserOperation).toHaveBeenCalledTimes(1)
    expect(rows).not.toHaveBeenCalled()
  })
  it('denied on the organization, allowed by the engine on a granted warehouse', async () => {
    guardUserOperation.mockImplementation(async (_u: string, _p: string, o: any) => (o.warehouseId === W1 ? null : forbidden))
    const { guardUserOperationInReach } = await import('@/lib/server/warehouse-reach')
    expect(await guardUserOperationInReach('u', 'inventory.report.view')).toBeNull()
    expect(guardUserOperation).toHaveBeenLastCalledWith('u', 'inventory.report.view', { organizationId: W1, warehouseId: W1 })
  })
  it('stays denied when the engine denies every granted warehouse, or no warehouse is granted', async () => {
    guardUserOperation.mockResolvedValue(forbidden)
    const { guardUserOperationInReach } = await import('@/lib/server/warehouse-reach')
    expect(await guardUserOperationInReach('u', 'inventory.report.view')).toBe(forbidden)
    rows.mockReturnValue({ data: [], error: null })
    expect(await guardUserOperationInReach('u', 'inventory.report.view')).toBe(forbidden)
  })
  it('organization-decided permissions and unavailable answers are never retried on a warehouse', async () => {
    guardUserOperation.mockResolvedValue(forbidden)
    const { guardUserOperationInReach } = await import('@/lib/server/warehouse-reach')
    expect(await guardUserOperationInReach('u', 'product.catalog.manage')).toBe(forbidden)
    expect(guardUserOperation).toHaveBeenCalledTimes(1)
    const unavailable = { status: 503 }
    guardUserOperation.mockResolvedValue(unavailable)
    expect(await guardUserOperationInReach('u', 'inventory.report.view')).toBe(unavailable)
  })
  it('a failed grant read keeps the denial', async () => {
    guardUserOperation.mockResolvedValue(forbidden)
    rows.mockReturnValue({ data: null, error: { code: 'XX' } })
    const { guardUserOperationInReach } = await import('@/lib/server/warehouse-reach')
    expect(await guardUserOperationInReach('u', 'inventory.report.view')).toBe(forbidden)
  })
})
