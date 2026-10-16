import { describe, expect, it } from 'vitest'
import { type CoverageRole, coveredPermissions, fullyCoveredModules, grantableModulePermissions, isRedundantPolicy } from './grant-coverage'

// The Grant a Group Policy smart filter, for the order@dev.com situation (stable role keys, never names).
const HQ = 'org-hq', WH = 'wh-balakong'
const NOW = new Date('2026-10-08T00:00:00Z')
const CREATE = ['supply_chain.order.create']
const role = (id: string, keys: string[]): CoverageRole => ({ id, status: 'active', source: 'template', permissionKeys: keys })
const ROLES = new Map<string, CoverageRole>([
  ['order-creator', role('order-creator', CREATE)],
  ['order-approver', role('order-approver', ['supply_chain.order.approve'])],
  ['catalog-viewer', role('catalog-viewer', ['product.catalog.view'])],
  ['adjustment-administrator', role('adjustment-administrator', ['manufacturing.adjustment.administer'])],
  ['qr-batch-operator', role('qr-batch-operator', ['qr.batch.manage'])],
  ['supply-chain-full-access', role('supply-chain-full-access', ['supply_chain.order.create', 'supply_chain.order.approve', 'supply_chain.order.cancel', 'qr.batch.manage', 'product.catalog.view', 'manufacturing.adjustment.administer'])],
])
const scope = (value: string, type = 'organization') => ({ scope: { id: `s-${value}`, scope_type: type, scope_value: value, display_name: value } })
const grant = (roleId: string, extra: any = {}) => ({ id: `a-${roleId}`, status: 'active', effective_from: null, effective_until: null, role: { id: roleId }, scopes: [scope(HQ)], ...extra })
const covered = (assignments: any[], organizationId = HQ, parents?: Map<string, string | null>) =>
  coveredPermissions({ assignments, organizationId, roles: ROLES, parents, now: NOW })
const CURRENT_FOUR = [grant('catalog-viewer'), grant('order-approver'), grant('adjustment-administrator'), grant('qr-batch-operator')]

describe('Order Creator in the grant smart filter', () => {
  it('stays selectable for a person holding Catalogue User, Order Approver, Stock Adjustment Administrator and QR Batch Operator', () => {
    const c = covered(CURRENT_FOUR)
    expect(c.has('supply_chain.order.create')).toBe(false)
    expect(isRedundantPolicy(CREATE, c)).toBe(false)
    const required = grantableModulePermissions(Array.from(ROLES.values()))
    expect(fullyCoveredModules(required, c).has('supply_chain')).toBe(false)
  })

  it('is hidden as redundant only when equivalent creation access is already held for the whole organization', () => {
    expect(isRedundantPolicy(CREATE, covered([grant('order-creator')]))).toBe(true)
    expect(isRedundantPolicy(CREATE, covered([grant('supply-chain-full-access')]))).toBe(true)
  })

  it('a revoked, expired or not-yet-started Order Creator grant does not block a new one', () => {
    for (const a of [grant('order-creator', { status: 'revoked' }), grant('order-creator', { effective_until: '2026-10-01T00:00:00Z' }),
      grant('order-creator', { effective_from: '2026-11-01T00:00:00Z' })]) {
      expect(isRedundantPolicy(CREATE, covered([...CURRENT_FOUR, a]))).toBe(false)
    }
  })

  it('a warehouse-limited grant or a grant in another organization does not hide it', () => {
    expect(isRedundantPolicy(CREATE, covered([grant('order-creator', { scopes: [scope(WH, 'warehouse')] })]))).toBe(false)
    expect(isRedundantPolicy(CREATE, covered([grant('order-creator')], 'org-dist'))).toBe(false)
  })

  it('an HQ-wide grant covers a child distributor organization (ancestor scope), so it is not duplicated there', () => {
    expect(isRedundantPolicy(CREATE, covered([grant('order-creator')], 'org-dist', new Map([['org-dist', HQ]])))).toBe(true)
  })
})
