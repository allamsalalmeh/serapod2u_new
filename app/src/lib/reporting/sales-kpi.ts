/**
 * Confirmed-sales classification shared by the Executive Dashboard, Distributor Analytics and Staff Commission.
 *
 * Approved Sales = orders that reached approval and are not cancelled: approved, warehouse_packed,
 * shipped_distributor, closed. An approved order that is later cancelled leaves Approved Sales.
 * Order Pipeline = submitted orders awaiting approval (drafts are not commitments and are not pipeline).
 * Cancelled orders are reported separately and never counted as sales.
 *
 * Sales are sell-side orders (D2H distributor purchases from HQ, S2D shop purchases from a distributor). H2M is HQ's
 * purchase from a manufacturer: it is a purchase, never a sale, and is reported as purchases.
 *
 * Calendar reports keep their own reporting date (order_date); only Staff Commission buckets by first approval.
 * Isomorphic and pure.
 */

export const APPROVED_SALES_STATUSES = ['approved', 'warehouse_packed', 'shipped_distributor', 'closed'] as const
export const PIPELINE_STATUSES = ['submitted'] as const
export const CANCELLED_STATUS = 'cancelled'
export const SALES_ORDER_TYPES = ['D2H', 'S2D'] as const
export const PURCHASE_ORDER_TYPES = ['H2M'] as const

export type SalesClass = 'approved_sales' | 'pipeline' | 'cancelled' | 'draft' | 'other'

export function salesClassOf(status: string | null | undefined): SalesClass {
  const s = String(status ?? '').toLowerCase()
  if ((APPROVED_SALES_STATUSES as readonly string[]).includes(s)) return 'approved_sales'
  if ((PIPELINE_STATUSES as readonly string[]).includes(s)) return 'pipeline'
  if (s === CANCELLED_STATUS) return 'cancelled'
  if (s === 'draft') return 'draft'
  return 'other'
}

export const isApprovedSalesStatus = (status: string | null | undefined) => salesClassOf(status) === 'approved_sales'
export const isSalesOrderType = (orderType: string | null | undefined) =>
  (SALES_ORDER_TYPES as readonly string[]).includes(String(orderType ?? '').toUpperCase())

export interface SalesOrderInput {
  status: string | null | undefined
  orderType?: string | null
  /** Sum of order lines (order_items.line_total). Never the header total. */
  value: number
}

export interface SalesSummary {
  approvedSalesValue: number
  approvedSalesOrders: number
  pipelineValue: number
  pipelineOrders: number
  cancelledValue: number
  cancelledOrders: number
  /** H2M purchases in an approved state (shown apart from sales). */
  purchaseValue: number
  purchaseOrders: number
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Splits orders into approved sales, pipeline, cancelled and purchases. Orders without a type count as sales. */
export function summarizeSales(orders: readonly SalesOrderInput[]): SalesSummary {
  const out: SalesSummary = {
    approvedSalesValue: 0, approvedSalesOrders: 0, pipelineValue: 0, pipelineOrders: 0,
    cancelledValue: 0, cancelledOrders: 0, purchaseValue: 0, purchaseOrders: 0,
  }
  for (const order of orders) {
    const value = Number(order.value) || 0
    const cls = salesClassOf(order.status)
    const purchase = order.orderType != null && (PURCHASE_ORDER_TYPES as readonly string[]).includes(String(order.orderType).toUpperCase())
    if (purchase) {
      if (cls === 'approved_sales') { out.purchaseValue += value; out.purchaseOrders += 1 }
      continue
    }
    if (cls === 'approved_sales') { out.approvedSalesValue += value; out.approvedSalesOrders += 1 }
    else if (cls === 'pipeline') { out.pipelineValue += value; out.pipelineOrders += 1 }
    else if (cls === 'cancelled') { out.cancelledValue += value; out.cancelledOrders += 1 }
  }
  out.approvedSalesValue = round2(out.approvedSalesValue)
  out.pipelineValue = round2(out.pipelineValue)
  out.cancelledValue = round2(out.cancelledValue)
  out.purchaseValue = round2(out.purchaseValue)
  return out
}
