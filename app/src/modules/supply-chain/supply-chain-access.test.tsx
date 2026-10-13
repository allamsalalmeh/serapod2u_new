import { describe, expect, it } from 'vitest'
import {
  SUPPLY_CHAIN_MODULE_DESTINATION,
  SUPPLY_CHAIN_VIEW_DESTINATIONS,
  computeDestinations,
  productCatalogHome,
  supplyChainDestinationForView,
  supplyChainModuleVisible,
  supplyChainViewVisible,
  type NavAccessSnapshot,
  type PermissionAnswers,
} from '@/lib/security-access/nav-access'
import { INVENTORY_STOCK_READ_PERMISSIONS } from '@/lib/security-access/inventory-stock'
import { canAccessSupplyChainView, filterSupplyChainNavForUser, isSupplyChainViewId, supplyChainNavGroups } from './supplyChainNav'

const answers = (org: string[] = [], self: string[] = []): PermissionAnswers => ({
  org: Object.fromEntries(org.map(p => [p, true])),
  self: Object.fromEntries(self.map(p => [p, true])),
})
const snapshot = (org: string[], self: string[] = []): NavAccessSnapshot => ({
  userId: 'u1', organizationId: 'o1', destinations: computeDestinations(answers(org, self)),
  sidebar: { users: false, securityAccess: false }, policies: [],
})

/** Supply Chain Full Access after 20261031100000 (live staging list + inventory.stock.view). */
const FULL_ACCESS = ['inventory.adjustment.post', 'inventory.opening_balance.manage', 'inventory.report.view', 'inventory.return.manage',
  'inventory.return.request', 'inventory.stock_config.manage', 'inventory.stock_count.create', 'inventory.stock_count.post',
  'inventory.stock_count.verify', 'inventory.stock_count.view', 'inventory.transfer.approve', 'inventory.transfer.cancel',
  'inventory.transfer.dispatch', 'inventory.transfer.receive', 'inventory.transfer.request', 'inventory.transfer.view',
  'manufacturing.adjustment.administer', 'manufacturing.adjustment.manage', 'manufacturing.production.manage', 'manufacturing.scan.reverse',
  'product.catalog.manage', 'product.catalog.view', 'qr.batch.manage', 'supply_chain.document.acknowledge', 'supply_chain.document.manage',
  'supply_chain.order.approve', 'supply_chain.order.cancel', 'supply_chain.order.create', 'warehouse.receipt.post', 'warehouse.shipment.manage',
  'inventory.stock.view']

const allows = (s: NavAccessSnapshot | null) => (viewId: string) => supplyChainViewVisible(s, viewId)
/** Landing / top navigation children for an HQ admin-level profile (organization rules out of the way). */
const visibleViews = (s: NavAccessSnapshot | null, orgType = 'HQ', level = 1) =>
  filterSupplyChainNavForUser(orgType, level, false, allows(s)).flatMap(g => g.children.map(c => c.id)).sort()
const INVENTORY_WRITES = ['add-stock', 'stock-adjustment', 'stock-transfer', 'inventory-settings']

describe('Every Supply Chain screen has its own destination', () => {
  it('each navigation child and detail view maps to a supply-chain/<view> destination, never silently to the module', () => {
    const ids = [...supplyChainNavGroups.flatMap(g => g.children.map(c => c.id)),
      'inventory', 'view-product', 'edit-product', 'add-product', 'create-order', 'view-order', 'track-order',
      'manufacturer-quality-issues', 'view-organization', 'edit-organization', 'edit-organization-hq']
    for (const id of ids) {
      expect(isSupplyChainViewId(id), id).toBe(true)
      expect(supplyChainDestinationForView(id), id).not.toBe(SUPPLY_CHAIN_MODULE_DESTINATION)
    }
  })
  it('View Inventory is decided with exactly the database stock read permissions', () => {
    expect(SUPPLY_CHAIN_VIEW_DESTINATIONS['supply-chain/inventory-list'].org).toEqual(INVENTORY_STOCK_READ_PERMISSIONS)
    expect(supplyChainDestinationForView('inventory')).toBe('supply-chain/inventory-list')
  })
})

describe('Scenario 1 — no Supply Chain access (ESS only, revoked Full Access)', () => {
  const s = snapshot([], ['hr.self_service.use'])
  it('hides the sidebar entry, every landing card and every view', () => {
    expect(supplyChainModuleVisible(s)).toBe(false)
    expect(visibleViews(s)).toEqual([])
    for (const id of ['inventory-list', 'orders', 'view-order', 'products', 'qr-batches', 'return-product']) {
      expect(canAccessSupplyChainView(id, 'HQ', 1, true, allows(s)), id).toBe(false)
    }
  })
  it('legacy role level does not reopen anything (the org rules alone would)', () => {
    expect(canAccessSupplyChainView('inventory-list', 'HQ', 1)).toBe(true)  // organization rule alone
    expect(canAccessSupplyChainView('inventory-list', 'HQ', 1, undefined, allows(s))).toBe(false)
  })
  it('an unresolved snapshot opens nothing', () => {
    expect(supplyChainModuleVisible(null)).toBe(false)
    expect(visibleViews(null)).toEqual([])
  })
})

describe('Scenario 2 — Inventory Viewer only', () => {
  const s = snapshot(['inventory.stock.view'])
  it('shows Supply Chain and View Inventory only', () => {
    expect(supplyChainModuleVisible(s)).toBe(true)
    expect(visibleViews(s)).toEqual(['inventory-list'])
  })
  it('no stock modification screens', () => {
    for (const id of INVENTORY_WRITES) expect(canAccessSupplyChainView(id, 'HQ', 1, true, allows(s)), id).toBe(false)
  })
  it('organization rules still apply on top (no Inventory for a manufacturer)', () => {
    expect(visibleViews(s, 'MFG', 1)).toEqual([])
  })
})

describe('Scenario 3 — Order Approver only', () => {
  // The standard Order Approver policy: approval + its supporting read (20261101100000).
  const s = snapshot(['supply_chain.order.approve', 'supply_chain.order.view'])
  it('shows Supply Chain and the order review screens', () => {
    expect(supplyChainModuleVisible(s)).toBe(true)
    expect(visibleViews(s)).toEqual(['distributor-incentive', 'orders'])
    expect(canAccessSupplyChainView('view-order', 'HQ', 40, undefined, allows(s))).toBe(true)
    // orderapp@dev.com: level 50 opens Order Details through the grant, not the role level.
    expect(canAccessSupplyChainView('view-order', 'HQ', 50, undefined, allows(s))).toBe(true)
    expect(canAccessSupplyChainView('track-order', 'HQ', 50, undefined, allows(s))).toBe(true)
  })
  it('approval alone (a custom policy) lists orders but does not open them', () => {
    const approveOnly = snapshot(['supply_chain.order.approve'])
    expect(visibleViews(approveOnly)).toEqual(['distributor-incentive', 'orders'])
    expect(canAccessSupplyChainView('view-order', 'HQ', 40, undefined, allows(approveOnly))).toBe(false)
  })
  it('does not grant order creation or inventory', () => {
    for (const id of ['create-order', 'distributor-order', 'shop-order', 'inventory-list', 'stock-movements']) {
      expect(supplyChainViewVisible(s, id), id).toBe(false)
    }
  })
})

describe('Scenario 4 — Supply Chain Full Access', () => {
  const s = snapshot(FULL_ACCESS)
  it('every Supply Chain view the organization rules allow (organization administration is not part of it)', () => {
    const all = filterSupplyChainNavForUser('HQ', 1).flatMap(g => g.children.map(c => c.id))
    const expected = all.filter(id => !['organizations', 'add-organization'].includes(id)).sort()
    expect(visibleViews(s)).toEqual(expected)
  })
  it('organization-type rules remain (inventory hidden for manufacturers); role levels are the permission answer\'s job', () => {
    expect(visibleViews(s, 'MFG', 1)).not.toContain('inventory-list')
    // The S&A answer already carries each permission's legacy level rule in legacy modes: a level-50 grantee is not hidden.
    expect(visibleViews(s, 'HQ', 50)).toEqual(visibleViews(s, 'HQ', 1))
    // Without an S&A answer (legacy callers) the level rules still apply.
    expect(filterSupplyChainNavForUser('HQ', 50).flatMap(g => g.children.map(c => c.id))).not.toContain('distributor-order')
  })
})

describe('Scenario 5 — revocation', () => {
  it('the next snapshot decides: granted → visible, revoked → hidden, nothing cached in the helpers', () => {
    const granted = snapshot(FULL_ACCESS)
    const revoked = snapshot([], ['hr.self_service.use'])
    expect([supplyChainModuleVisible(granted), supplyChainModuleVisible(revoked)]).toEqual([true, false])
    expect([supplyChainViewVisible(granted, 'inventory-list'), supplyChainViewVisible(revoked, 'inventory-list')]).toEqual([true, false])
  })
})

describe('Scenario 6 — other sources', () => {
  it('a catalogue-only person is not sent to Supply Chain (catalog lives in Customer & Growth)', () => {
    expect(supplyChainModuleVisible(snapshot(['product.catalog.view']))).toBe(false)
  })
  it('organization administration opens Supply Chain with Organizations only', () => {
    const s = snapshot(['platform.organization.manage'])
    expect(supplyChainModuleVisible(s)).toBe(true)
    expect(visibleViews(s)).toEqual(['add-organization', 'organizations'])
  })
  it('a stock workflow permission (Warehouse Operator) reads the Inventory page, as the database does', () => {
    const s = snapshot(['inventory.transfer.receive', 'inventory.stock_count.create', 'inventory.transfer.view'])
    expect(supplyChainViewVisible(s, 'inventory-list')).toBe(true)
    expect(supplyChainViewVisible(s, 'add-stock')).toBe(false)
    expect(supplyChainViewVisible(s, 'stock-transfer')).toBe(true)
  })
  it('order creation alone shows ordering, not the Inventory page', () => {
    const s = snapshot(['supply_chain.order.create'])
    expect(supplyChainViewVisible(s, 'create-order')).toBe(true)
    expect(supplyChainViewVisible(s, 'inventory-list')).toBe(false)
  })
  it('combining grants is a union; removing one keeps the other', () => {
    const both = snapshot(['inventory.stock.view', 'supply_chain.order.approve'])
    const viewerOnly = snapshot(['inventory.stock.view'])
    expect(visibleViews(both)).toEqual(['distributor-incentive', 'inventory-list', 'orders'])
    expect(visibleViews(viewerOnly)).toEqual(['inventory-list'])
  })
})

/** Warehouse Manager after 20261109100000 (Products, Inventory, Quality & Returns). */
const WAREHOUSE_MANAGER = ['product.catalog.view', 'product.catalog.manage', 'inventory.stock.view', 'inventory.stock_config.manage',
  'inventory.opening_balance.manage', 'inventory.adjustment.post', 'inventory.report.view', 'inventory.stock_count.view',
  'inventory.stock_count.create', 'inventory.stock_count.verify', 'inventory.stock_count.post', 'inventory.transfer.view',
  'inventory.transfer.request', 'inventory.transfer.approve', 'inventory.transfer.dispatch', 'inventory.transfer.receive',
  'inventory.transfer.cancel', 'inventory.return.request', 'inventory.return.manage']
const WM_EXPECTED = ['add-stock', 'inventory-list', 'inventory-settings', 'product-management', 'products', 'return-product',
  'return-reporting', 'return-settings', 'stock-adjustment', 'stock-movements', 'stock-transfer']

describe('Scenario 7 — Warehouse Manager (HQ level 50, the orderapp@dev.com profile)', () => {
  it('HQ scope: Supply Chain with Products, Inventory and Quality & Returns only', () => {
    const s = snapshot(WAREHOUSE_MANAGER)
    expect(supplyChainModuleVisible(s)).toBe(true)
    expect(visibleViews(s, 'HQ', 50)).toEqual(WM_EXPECTED)
    const groups = filterSupplyChainNavForUser('HQ', 50, false, allows(s)).map(g => g.id)
    expect(groups).toEqual(['sc-products', 'sc-inventory', 'sc-quality'])
  })
  it('Product Catalog is offered under Supply Chain (catalogue holder who works in Supply Chain)', () => {
    expect(productCatalogHome(snapshot(WAREHOUSE_MANAGER))).toBe('supply-chain')
  })
  it('Organizations, Order Management and QR Tracking stay hidden; their direct views are refused', () => {
    const s = snapshot(WAREHOUSE_MANAGER)
    for (const id of ['organizations', 'add-organization', 'orders', 'create-order', 'distributor-order', 'shop-order', 'view-order',
      'qr-batches', 'manufacturer-scan-2', 'warehouse-receive-2', 'warehouse-ship-v2']) {
      expect(supplyChainViewVisible(s, id), id).toBe(false)
      expect(canAccessSupplyChainView(id, 'HQ', 50, undefined, allows(s)), id).toBe(false)
    }
  })
  it('warehouse-only scope: the server answers only the per-warehouse functions, and the menu follows', () => {
    // Keys the engine allows on the granted warehouse (WAREHOUSE_REACH_PERMISSIONS ∩ policy).
    const s = snapshot(WAREHOUSE_MANAGER.filter(k => k.startsWith('inventory.') && !k.startsWith('inventory.return.')
      && k !== 'inventory.stock_config.manage' && k !== 'inventory.opening_balance.manage'))
    expect(supplyChainModuleVisible(s)).toBe(true)
    expect(visibleViews(s, 'HQ', 50)).toEqual(['add-stock', 'inventory-list', 'stock-adjustment', 'stock-movements', 'stock-transfer'])
  })
  it('plus Order Approver: orders appear next to the Warehouse Manager functions (union)', () => {
    const s = snapshot([...WAREHOUSE_MANAGER, 'supply_chain.order.approve', 'supply_chain.order.view'])
    expect(visibleViews(s, 'HQ', 50)).toEqual([...WM_EXPECTED, 'distributor-incentive', 'orders'].sort())
  })
})
