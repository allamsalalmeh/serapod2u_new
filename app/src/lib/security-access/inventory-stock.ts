/**
 * View Inventory (inventory.stock.view) — the application side of 20261031100000_sa_inventory_stock_view.sql.
 *
 * Isomorphic and pure: no server imports. inventory-stock.test.tsx keeps these lists in lock-step with the migration.
 */

export const INVENTORY_STOCK_VIEW_PERMISSION = 'inventory.stock.view'

/**
 * Permissions whose holders read stock balances (on hand, allocated, available, incoming) in their Security & Access
 * scope: View Inventory itself, and the stock workflows whose screens show balances. Mirrors
 * public.sa_inventory_stock_read_permissions(), which the product_inventory policy and the four inventory views use.
 * Order approval/cancellation, documents, catalogue and QR permissions are deliberately absent.
 */
export const INVENTORY_STOCK_READ_PERMISSIONS: readonly string[] = [
  INVENTORY_STOCK_VIEW_PERMISSION,
  'inventory.report.view',
  'inventory.adjustment.post',
  'inventory.opening_balance.manage',
  'inventory.stock_config.manage',
  'inventory.stock_count.view', 'inventory.stock_count.create', 'inventory.stock_count.verify', 'inventory.stock_count.post',
  'inventory.transfer.request', 'inventory.transfer.approve', 'inventory.transfer.dispatch', 'inventory.transfer.receive',
  'warehouse.receipt.post', 'warehouse.shipment.manage',
]

/**
 * Order forms read the seller's availability from product_inventory (database only, inside the unchanged tenant rule).
 * This never opens the Inventory page or its views.
 */
export const INVENTORY_ORDER_AVAILABILITY_PERMISSION = 'supply_chain.order.create'

/** The standard read-only policy seeded by the migration (assigned to no one). */
export const INVENTORY_VIEWER_POLICY = {
  roleKey: 'inventory-viewer',
  name: 'Inventory Viewer',
  permissions: [INVENTORY_STOCK_VIEW_PERMISSION] as readonly string[],
  applicableOrgTypes: ['HQ', 'DIST', 'WH'] as readonly string[],
} as const

/**
 * The legacy rule for View Inventory while the permission is on LEGACY_ENFORCED/SHADOW: the Inventory group's
 * historical organization-type rule (supplyChainNav: HQ, distributor and warehouse organizations, any level).
 */
export function legacyInventoryStockView(orgTypeCode: string | null | undefined): boolean {
  return ['HQ', 'DIST', 'WH'].includes(String(orgTypeCode ?? '').trim().toUpperCase())
}
