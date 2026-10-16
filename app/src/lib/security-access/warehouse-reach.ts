/**
 * Warehouse reach: where a warehouse-scoped grant is usable.
 *
 * A Group Policy granted on one warehouse (`warehouse` scope) is decided by the engine on that warehouse only. Screens
 * and module-entry checks that ask "may this person use X?" on the person's OWN organization (an HQ) therefore never see
 * such a grant. For the functions below, whose pages, APIs and data all decide per warehouse (RPC guards with warehouse
 * context, RLS write gates on the warehouse organization, list scope via sa_readable_organizations), the question is asked
 * again on each warehouse the person is granted: the engine decides, nothing is assumed.
 *
 * Deliberately NOT listed (decided on the organization; a warehouse-only grant cannot use them, see
 * docs/security/WAREHOUSE_MANAGER_FULL_ACCESS.md): product.catalog.* (master data), inventory.stock_config.manage and
 * inventory.opening_balance.manage (settings APIs decide on the organization), inventory.return.* (the returns server
 * decides on the organization), warehouse.* (not verified for warehouse-only use).
 *
 * Isomorphic and pure: no server imports. warehouse-reach.test.ts keeps it inside the permission catalogue.
 */

export const WAREHOUSE_REACH_PERMISSIONS: readonly string[] = [
  'inventory.stock.view',
  'inventory.report.view',
  'inventory.adjustment.post',
  'inventory.stock_count.view', 'inventory.stock_count.create', 'inventory.stock_count.verify', 'inventory.stock_count.post',
  'inventory.transfer.view', 'inventory.transfer.request', 'inventory.transfer.approve', 'inventory.transfer.dispatch',
  'inventory.transfer.receive', 'inventory.transfer.cancel',
]

const REACH = new Set(WAREHOUSE_REACH_PERMISSIONS)

export function decidedPerWarehouse(permission: string): boolean {
  return REACH.has(permission)
}

/** Assignment rows as the server reads them (sa_role_assignments + scopes). */
export interface ReachAssignmentRow {
  status: string | null
  effective_from: string | null
  effective_until: string | null
  scopes?: Array<{ scope?: { scope_type?: string | null; scope_value?: string | null; status?: string | null } | null }> | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The warehouses named by the person's live grants (active, inside their validity, active `warehouse` scope). Only a
 * list of places to ASK: whether a permission is allowed there is still the engine's decision.
 */
export function grantedWarehousesFrom(rows: readonly ReachAssignmentRow[], now: Date = new Date()): string[] {
  const out = new Set<string>()
  for (const row of rows) {
    if (row.status !== 'active') continue
    if (row.effective_from && new Date(row.effective_from) > now) continue
    if (row.effective_until && new Date(row.effective_until) <= now) continue
    for (const s of row.scopes ?? []) {
      const scope = s?.scope
      if (scope?.scope_type === 'warehouse' && (scope.status ?? 'active') === 'active' && UUID.test(scope.scope_value ?? '')) {
        out.add(scope.scope_value!)
      }
    }
  }
  return [...out].sort()
}
