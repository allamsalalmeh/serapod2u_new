/**
 * View Orders (supply_chain.order.view) — the application side of 20261101100000_sa_order_view_policy_dependencies.sql.
 *
 * Isomorphic and pure: no server imports. order-view.test.ts keeps these values in lock-step with the migration.
 */

export const ORDER_VIEW_PERMISSION = 'supply_chain.order.view'

/** Permission keys registered by the migration (route-coverage and catalogue checks). */
export const ORDER_VIEW_PERMISSION_KEYS: readonly string[] = [ORDER_VIEW_PERMISSION]

/**
 * The legacy rule for View Orders while the permission is on LEGACY_ENFORCED/SHADOW: the historical Order Details rule
 * (canOpenOrderEditor, role level 40 or higher in privilege). Also the compatibility rule seeded by the migration.
 */
export function legacyOrderView(roleLevel: number | null | undefined): boolean {
  return typeof roleLevel === 'number' && Number.isFinite(roleLevel) && roleLevel <= 40
}

export interface OrderParties {
  order_type?: string | null
  buyer_org_id?: string | null
  seller_org_id?: string | null
  warehouse_org_id?: string | null
}

/**
 * The organizations an order is decided on, most specific first: the approval organization (H2M → buyer, otherwise
 * seller; the organization orders_approve() authorizes on), then the remaining parties. A caller may view the order
 * when View Orders is allowed on any of them, so view reach always includes approval reach.
 */
export function orderViewOrganizations(order: OrderParties): string[] {
  const approval = String(order.order_type ?? '').toUpperCase() === 'H2M' ? order.buyer_org_id : order.seller_org_id
  return [...new Set([approval, order.buyer_org_id, order.seller_org_id, order.warehouse_org_id]
    .filter((id): id is string => typeof id === 'string' && id.length > 0))]
}
