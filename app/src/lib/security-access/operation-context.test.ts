import { beforeEach, describe, expect, it, vi } from 'vitest'
import { evaluateNewPolicy } from './policy'

// guardUserOperation defaults the resource to the actor's own organization.
// A warehouse organization is its own warehouse, so warehouse-scoped
// assignments must receive warehouse context instead of MISSING_CONTEXT
// (staging: ware@dev.com denied inventory.report.view, 2026-10-01).
const authorize = vi.fn()
let userRow: any = null
vi.mock('server-only', () => ({}))
vi.mock('./authorization', () => ({ authorize: (...args: any[]) => authorize(...args) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: userRow, error: null }) }) }) }),
  }),
}))

const { guardUserOperation } = await import('./operation')
const resourceSent = () => authorize.mock.calls.at(-1)![0].resource

beforeEach(() => {
  authorize.mockReset()
  authorize.mockResolvedValue({ decision: 'ALLOW', reasonCode: 'ALLOWED_BY_ASSIGNMENT', decisionId: 'd' })
})

describe('guardUserOperation default resource context', () => {
  it('adds warehouse context when the actor belongs to a warehouse organization', async () => {
    userRow = { organization_id: 'wh-1', organizations: { org_type_code: 'WH' } }
    await expect(guardUserOperation('u', 'inventory.report.view')).resolves.toBeNull()
    expect(resourceSent()).toEqual({ type: 'inventory_report', organizationId: 'wh-1', warehouseId: 'wh-1' })
  })

  it('leaves non-warehouse organizations without warehouse context', async () => {
    userRow = { organization_id: 'hq-1', organizations: { org_type_code: 'HQ' } }
    await guardUserOperation('u', 'inventory.report.view')
    expect(resourceSent()).toEqual({ type: 'inventory_report', organizationId: 'hq-1' })
  })

  it('never infers a warehouse when the caller supplied organization context', async () => {
    userRow = { organization_id: 'wh-1', organizations: { org_type_code: 'WH' } }
    await guardUserOperation('u', 'inventory.report.view', { organizationId: 'hq-1' })
    expect(resourceSent()).toEqual({ type: 'inventory_report', organizationId: 'hq-1' })
  })

  it('lets a warehouse-scoped assignment match the defaulted context', () => {
    const assignment = {
      assignmentId: 'a', membershipId: 'm', roleId: 'r', roleKey: 'legacy-hq', roleName: 'Legacy HQ',
      status: 'active', effectiveFrom: null, effectiveUntil: null,
      permissions: ['inventory.report.view'], scopes: [{ type: 'warehouse' as const, value: 'wh-1' }],
    }
    const input = { actorActive: true, memberships: [{ id: 'm', organizationId: 'wh-1', status: 'active', effectiveFrom: null, effectiveUntil: null }], assignments: [assignment] }
    const request = (resource: any) => ({ actorId: 'u', permission: 'inventory.report.view', resource })
    // 20261109100000: the warehouse organization alone now matches too (it IS the warehouse); the parent does not.
    expect(evaluateNewPolicy(request({ type: 'inventory_report', organizationId: 'wh-1' }), input).decision).toBe('ALLOW')
    expect(evaluateNewPolicy(request({ type: 'inventory_report', organizationId: 'wh-1', warehouseId: 'wh-1' }), input).decision).toBe('ALLOW')
    expect(evaluateNewPolicy(request({ type: 'inventory_report', organizationId: 'wh-1', warehouseId: 'wh-2' }), input).reasonCode).toBe('SCOPE_MISMATCH')
  })
})
