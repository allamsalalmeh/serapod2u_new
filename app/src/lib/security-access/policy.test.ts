import { describe, expect, it } from 'vitest'
import { evaluateNewPolicy, type PolicyInput } from './policy'

const now = new Date('2026-09-27T00:00:00Z')
const request = (warehouseId = 'wh-a', organizationId = 'org-a') => ({
  actorId: 'user-a', permission: 'inventory.stock_count.post',
  resource: { type: 'stock_count', organizationId, warehouseId }, context: { now },
})
const base = (overrides: Partial<PolicyInput> = {}): PolicyInput => ({
  actorActive: true,
  memberships: [{ id: 'mem-a', organizationId: 'org-a', status: 'active', effectiveFrom: null, effectiveUntil: null }],
  assignments: [{ assignmentId: 'as-a', roleId: 'role-a', roleKey: 'warehouse-operator', roleName: 'Warehouse Operator', membershipId: 'mem-a', status: 'active', effectiveFrom: null, effectiveUntil: null, permissions: ['inventory.stock_count.post'], scopes: [{ type: 'warehouse', value: 'wh-a' }] }],
  ...overrides,
})

describe('new S&A policy', () => {
  it('allows a matching permission and warehouse scope', () => expect(evaluateNewPolicy(request(), base()).decision).toBe('ALLOW'))
  it('denies a wrong warehouse', () => expect(evaluateNewPolicy(request('wh-b'), base()).reasonCode).toBe('SCOPE_MISMATCH'))
  it('denies cross-organization access', () => expect(evaluateNewPolicy(request('wh-a', 'org-b'), base()).reasonCode).toBe('MISSING_MEMBERSHIP'))
  it('denies inactive accounts', () => expect(evaluateNewPolicy(request(), base({ actorActive: false })).reasonCode).toBe('ACCOUNT_INACTIVE'))
  it('denies inactive and expired memberships', () => {
    const inactive = base({ memberships: [{ id: 'mem-a', organizationId: 'org-a', status: 'inactive', effectiveFrom: null, effectiveUntil: null }] })
    const expired = base({ memberships: [{ id: 'mem-a', organizationId: 'org-a', status: 'active', effectiveFrom: null, effectiveUntil: '2026-01-01T00:00:00Z' }] })
    expect(evaluateNewPolicy(request(), inactive).reasonCode).toBe('MISSING_MEMBERSHIP')
    expect(evaluateNewPolicy(request(), expired).reasonCode).toBe('MISSING_MEMBERSHIP')
  })
  it('supports multiple roles without widening missing permissions', () => {
    const input = base({ assignments: [
      { ...base().assignments[0], permissions: ['inventory.stock_count.view'] },
      { ...base().assignments[0], assignmentId: 'as-b', roleId: 'role-b', roleKey: 'viewer', permissions: ['inventory.transfer.view'] },
    ] })
    expect(evaluateNewPolicy(request(), input).reasonCode).toBe('MISSING_PERMISSION')
  })
  it('requires resource context for typed scopes', () => {
    const withoutWarehouse = { ...request(), resource: { type: 'stock_count', organizationId: 'org-a' } }
    expect(evaluateNewPolicy(withoutWarehouse, base()).reasonCode).toBe('MISSING_CONTEXT')
  })
  it('a warehouse scope matches a resource of exactly that warehouse organization (sa_scope_matches, 20261109100000)', () => {
    const atWarehouse = base({ memberships: [{ id: 'mem-a', organizationId: 'wh-a', status: 'active', effectiveFrom: null, effectiveUntil: null }] })
    const warehouseOrg = { ...request(), resource: { type: 'stock_count', organizationId: 'wh-a' } }
    expect(evaluateNewPolicy(warehouseOrg, atWarehouse).decision).toBe('ALLOW')
    const sibling = { ...request(), resource: { type: 'stock_count', organizationId: 'wh-b' } }
    const atSibling = base({ memberships: [{ id: 'mem-a', organizationId: 'wh-b', status: 'active', effectiveFrom: null, effectiveUntil: null }] })
    expect(evaluateNewPolicy(sibling, atSibling).reasonCode).toBe('MISSING_CONTEXT')
  })
})
