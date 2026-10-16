import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  INVENTORY_ORDER_AVAILABILITY_PERMISSION,
  INVENTORY_STOCK_READ_PERMISSIONS,
  INVENTORY_STOCK_VIEW_PERMISSION,
  INVENTORY_VIEWER_POLICY,
  legacyInventoryStockView,
} from './inventory-stock'
import { classifyPermission } from './modules'

const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../../../supabase/migrations/20261031100000_sa_inventory_stock_view.sql'),
  'utf8',
)

/** The quoted keys of the first `array[...]` after `marker` in the migration. */
function sqlArrayAfter(marker: string): string[] {
  const start = MIGRATION.indexOf(marker)
  expect(start, marker).toBeGreaterThanOrEqual(0)
  const open = MIGRATION.indexOf('array[', start)
  const close = MIGRATION.indexOf(']', open)
  return [...MIGRATION.slice(open, close).matchAll(/'([a-z_.]+)'/g)].map(m => m[1])
}

describe('View Inventory lock-step with 20261031100000_sa_inventory_stock_view.sql', () => {
  it('stock read permissions match sa_inventory_stock_read_permissions()', () => {
    expect(sqlArrayAfter('create or replace function public.sa_inventory_stock_read_permissions()')).toEqual([...INVENTORY_STOCK_READ_PERMISSIONS])
  })
  it('the Inventory Viewer policy matches the seed', () => {
    expect(sqlArrayAfter("v_key constant text := 'inventory-viewer'")).toEqual([...INVENTORY_VIEWER_POLICY.permissions])
    expect(MIGRATION).toContain(`'template', 'active', '{}', array['${INVENTORY_VIEWER_POLICY.applicableOrgTypes.join("','")}']`)
  })
  it('the ordering availability permission is the one the migration reads', () => {
    expect(MIGRATION).toContain(`sa_readable_organizations(auth.uid(), '${INVENTORY_ORDER_AVAILABILITY_PERMISSION}', true)`)
  })
  it('registers the permission and extends Supply Chain Full Access', () => {
    expect(MIGRATION).toContain(`('${INVENTORY_STOCK_VIEW_PERMISSION}','inventory','stock','view'`)
    expect(MIGRATION).toContain(`sa_extend_standard_policy('supply-chain-full-access', array['${INVENTORY_STOCK_VIEW_PERMISSION}']`)
  })
  it('changes no existing mode and assigns nobody', () => {
    expect(MIGRATION).not.toMatch(/update\s+public\.sa_migration_modes/i)
    expect(MIGRATION).not.toMatch(/sa_assign_role\(|insert into public\.sa_role_assignments/i)
  })
})

describe('Stock read permissions', () => {
  it('are Supply Chain permissions', () => {
    for (const key of INVENTORY_STOCK_READ_PERMISSIONS) expect(classifyPermission(key).groupId, key).toBe('supply_chain')
  })
  it('never include order approval, cancellation, documents, catalogue or QR work', () => {
    for (const key of ['supply_chain.order.approve', 'supply_chain.order.cancel', 'supply_chain.order.create',
      'supply_chain.document.manage', 'supply_chain.document.acknowledge', 'product.catalog.view', 'product.catalog.manage',
      'qr.batch.manage', 'inventory.transfer.view', 'inventory.transfer.cancel', 'inventory.return.request']) {
      expect(INVENTORY_STOCK_READ_PERMISSIONS, key).not.toContain(key)
    }
  })
  it('Inventory Viewer is read only', () => {
    expect(INVENTORY_VIEWER_POLICY.permissions).toEqual(['inventory.stock.view'])
  })
  it('legacy rule is the Inventory group organization rule', () => {
    expect(['HQ', 'DIST', 'WH', 'hq'].map(legacyInventoryStockView)).toEqual([true, true, true, true])
    expect(['MFG', 'SHOP', 'END_USER', null, undefined].map(legacyInventoryStockView)).toEqual([false, false, false, false, false])
  })
})
