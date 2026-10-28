/**
 * Executive Overview order source — the ONE read and row mapping shared by the
 * Overview report (`/api/reporting/stats`) and its metric drill-downs
 * (`/api/reporting/stats/drilldown`), so a drill-down can never read a
 * different population, date or value than the card it explains.
 *
 * Always called with the caller's own request-scoped Supabase client: company
 * scope is enforced by row-level security on `orders` / `organizations`. No
 * service-role client is ever used here.
 */
import { orderBusinessDate } from '@/lib/orders/order-date'
import {
  filterBusinessDateRange,
  orderByBusinessDate,
  orderDateSelect,
  type OrderDateColumn,
} from './business-date-query'
import type { OverviewOrderInput } from './executive-overview'
import { APPROVED_SALES_STATUSES, CANCELLED_STATUS, PIPELINE_STATUSES } from './sales-kpi'

/** Orders per page. Every page is requested explicitly so the PostgREST row cap can never truncate a month. */
export const OVERVIEW_PAGE_SIZE = 500
export const OVERVIEW_MAX_PAGES = 400

/** Statuses the Overview reads: approved sales, pipeline and cancelled. Drafts are not commitments and are never read. */
export const OVERVIEW_READ_STATUSES = [...APPROVED_SALES_STATUSES, ...PIPELINE_STATUSES, CANCELLED_STATUS] as const

/**
 * Orders with a business date in [start, end) and one of `statuses`.
 * H2M is read alongside sales so it can be reported apart; classification is
 * always done afterwards by the shared predicates in sales-kpi.ts.
 */
export async function readOverviewOrders(
  supabase: any,
  dateColumn: OrderDateColumn,
  start: string,
  end: string,
  statuses: readonly string[] = OVERVIEW_READ_STATUSES,
): Promise<any[]> {
  const out: any[] = []
  for (let page = 0; page < OVERVIEW_MAX_PAGES; page++) {
    const from = page * OVERVIEW_PAGE_SIZE
    let query = supabase
      .from('orders')
      .select(`
        id, order_no, display_doc_no, order_type, status, buyer_org_id,
        ${orderDateSelect(dateColumn)},
        buyer:organizations!orders_buyer_org_id_fkey ( id, org_name, org_code, org_type_code ),
        order_items ( variant_id, qty, unit_price, line_total )
      `)
      .in('status', [...statuses])
    query = filterBusinessDateRange(query, dateColumn, start, end)
    query = orderByBusinessDate(query, dateColumn, true).range(from, from + OVERVIEW_PAGE_SIZE - 1)
    const { data, error } = await query
    if (error) throw error
    const pageRows = data ?? []
    out.push(...pageRows)
    if (pageRows.length < OVERVIEW_PAGE_SIZE) return out
  }
  throw new Error('Executive overview exceeded its read limit; narrow the reporting month.')
}

/** One `orders` row (with buyer + lines) as the Overview reads it. */
export function toOverviewOrderInput(order: any): OverviewOrderInput {
  return {
    id: order.id,
    orderNo: order.display_doc_no || order.order_no,
    orderType: order.order_type ?? null,
    status: order.status,
    // Business date (Malaysia calendar day) — never the UTC day of created_at.
    orderDate: orderBusinessDate(order) ?? '',
    createdAt: order.created_at ?? null,
    buyerId: order.buyer?.id ?? order.buyer_org_id ?? null,
    buyerName: order.buyer?.org_name ?? null,
    buyerType: order.buyer?.org_type_code ?? null,
    buyerCode: order.buyer?.org_code ?? null,
    items: (order.order_items ?? []).map((item: any) => ({
      variantId: item.variant_id ?? null,
      qty: Number(item.qty) || 0,
      // Generated line_total, falling back to qty × price exactly like the analytics RPCs.
      lineTotal: item.line_total != null ? Number(item.line_total) || 0 : (Number(item.qty) || 0) * (Number(item.unit_price) || 0),
    })),
  }
}
