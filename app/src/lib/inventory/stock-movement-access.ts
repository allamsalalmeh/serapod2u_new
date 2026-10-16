/**
 * Stock movement read access — lock-step with
 * supabase/migrations/20261107100000_sa_stock_movement_access.sql.
 *
 * Rows: a movement is readable when its source or destination organization is
 * in the caller's inventory scope (S&A inventory.stock.view, inventory.report.view
 * or a stock workflow permission). The same rule backs stock_movements,
 * vw_stock_movements_ordered and v_stock_movements_display.
 *
 * Fields: the browser can never select the restricted columns from the
 * stock_movements table (column privileges). The two movement views return
 * them masked — NULL — when the caller may not see them:
 *   - unit_cost / total_cost: HQ-side callers only (internal HQ / warehouse staff);
 *   - quantity_before / quantity_after: HQ-side callers, or every organization
 *     on the movement is in the caller's scope.
 * Read these columns from the views only; never from the table.
 */

export const STOCK_MOVEMENT_REPORT_SOURCE = 'vw_stock_movements_ordered'

export const STOCK_MOVEMENT_RESTRICTED_COLUMNS = ['unit_cost', 'total_cost', 'quantity_before', 'quantity_after'] as const

export const STOCK_MOVEMENT_ACCESS_DENIED_MESSAGE =
  'You do not have permission to view stock movements. Ask your administrator for an inventory permission (for example View Inventory or Inventory Reports).'

type PostgrestLikeError = { code?: string | null; message?: string | null; status?: number | null } | null | undefined

/** PostgREST permission errors (42501 / HTTP 401·403) — not "no rows". */
export function isStockMovementAccessDenied(error: PostgrestLikeError): boolean {
  if (!error) return false
  if (error.code === '42501' || error.status === 401 || error.status === 403) return true
  return /permission denied/i.test(error.message ?? '')
}
