import { guardUserOperation } from '@/lib/security-access/operation'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { orderBusinessDate } from '@/lib/orders/order-date'
import {
  filterBusinessDateRange,
  legacyOrderDateNotice,
  orderByBusinessDate,
  orderDateSelect,
  resolveOrderDateColumn,
  type OrderDateColumn,
} from '@/lib/reporting/business-date-query'
import { currentReportingMonthKey, isValidMonthKey } from '@/lib/reporting/consumer-analytics'
import { reportingPeriodKeyFromTimestamp } from '@/lib/reporting/reporting-period'
import {
  buildExecutiveOverviewReport,
  overviewReadWindow,
  resolveExecutiveOverviewPeriod,
  type OverviewOrderInput,
} from '@/lib/reporting/executive-overview'
import { APPROVED_SALES_STATUSES, CANCELLED_STATUS, PIPELINE_STATUSES, SALES_ORDER_TYPES } from '@/lib/reporting/sales-kpi'

export const dynamic = 'force-dynamic'

/** Orders per page. Every page is requested explicitly so the PostgREST row cap can never truncate a month. */
const PAGE_SIZE = 500
const MAX_PAGES = 400

/**
 * Executive Overview monthly report: `GET /api/reporting/stats?month=YYYY-MM`.
 *
 * Returns the `ExecutiveOverviewReport` DTO the Overview tab and its PDF both
 * render, plus the earliest month with sales so the month selector can offer
 * every month from it to today. Company scope is the caller's own, enforced by
 * row-level security on `orders`; this route adds no wider read.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const month = searchParams.get('month') || currentReportingMonthKey()
    if (!isValidMonthKey(month)) {
      return NextResponse.json({ error: 'Invalid reporting month. Use YYYY-MM.' }, { status: 400 })
    }
    if (month > currentReportingMonthKey()) {
      return NextResponse.json({ error: 'Reporting month is in the future.' }, { status: 400 })
    }

    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const saDenied = await guardUserOperation(user.id, 'reporting.analytics.view')
    if (saDenied) return saDenied

    const period = resolveExecutiveOverviewPeriod(month)
    const dateColumn = await resolveOrderDateColumn(supabase)
    const window = overviewReadWindow(period)

    const rows = await readOrders(supabase, dateColumn, window.start, window.end)
    const orders: OverviewOrderInput[] = rows.map((order: any) => ({
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
      items: (order.order_items ?? []).map((item: any) => ({
        variantId: item.variant_id ?? null,
        qty: Number(item.qty) || 0,
        // Generated line_total, falling back to qty × price exactly like the analytics RPCs.
        lineTotal: item.line_total != null ? Number(item.line_total) || 0 : (Number(item.qty) || 0) * (Number(item.unit_price) || 0),
      })),
    }))

    const report = buildExecutiveOverviewReport({
      month,
      orders,
      productNames: await readProductNames(supabase, orders),
      notice: legacyOrderDateNotice(dateColumn),
    })

    return NextResponse.json(
      { report, earliestMonth: await readEarliestSalesMonth(supabase, dateColumn) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error: any) {
    console.error('[Reporting API] Executive overview failed:', error)
    return NextResponse.json({ error: error?.message || 'Unable to load the executive overview' }, { status: 500 })
  }
}

/**
 * Sales-side and purchase orders in the read window. Drafts are not
 * commitments and are never read; H2M is read only so it can be reported apart.
 */
async function readOrders(supabase: any, dateColumn: OrderDateColumn, start: string, end: string) {
  const out: any[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE
    let query = supabase
      .from('orders')
      .select(`
        id, order_no, display_doc_no, order_type, status, buyer_org_id,
        ${orderDateSelect(dateColumn)},
        buyer:organizations!orders_buyer_org_id_fkey ( id, org_name, org_type_code ),
        order_items ( variant_id, qty, unit_price, line_total )
      `)
      .in('status', [...APPROVED_SALES_STATUSES, ...PIPELINE_STATUSES, CANCELLED_STATUS])
    query = filterBusinessDateRange(query, dateColumn, start, end)
    query = orderByBusinessDate(query, dateColumn, true).range(from, from + PAGE_SIZE - 1)
    const { data, error } = await query
    if (error) throw error
    const pageRows = data ?? []
    out.push(...pageRows)
    if (pageRows.length < PAGE_SIZE) return out
  }
  throw new Error('Executive overview exceeded its read limit; narrow the reporting month.')
}

async function readProductNames(supabase: any, orders: OverviewOrderInput[]): Promise<Record<string, string>> {
  const variantIds = [...new Set(orders.flatMap((order) => order.items.map((item) => item.variantId).filter(Boolean)))] as string[]
  const names: Record<string, string> = {}
  for (let i = 0; i < variantIds.length; i += 200) {
    const { data, error } = await supabase
      .from('product_variants')
      .select('id, variant_name, products ( product_name )')
      .in('id', variantIds.slice(i, i + 200))
    if (error) throw error
    for (const variant of data ?? []) {
      const productName = variant.products?.product_name
      const variantName = variant.variant_name
      const fullName = productName && variantName && productName !== variantName
        ? `${productName} - ${variantName}`
        : (variantName || productName || 'Unknown Product')
      // Variant names carry the flavour in [brackets]; that is the readable label.
      const match = fullName.match(/\[(.*?)\]/)
      names[variant.id] = match ? match[1].trim() : fullName
    }
  }
  return names
}

/** The first month with a sales order the caller can see: the start of the supported reporting range. */
async function readEarliestSalesMonth(supabase: any, dateColumn: OrderDateColumn): Promise<string | null> {
  const { data, error } = await supabase
    .from('orders')
    .select(orderDateSelect(dateColumn))
    .in('order_type', [...SALES_ORDER_TYPES])
    .order(dateColumn, { ascending: true })
    .limit(1)
  if (error) throw error
  const first = data?.[0]
  if (!first) return null
  const date = orderBusinessDate(first)
  return date ? date.slice(0, 7) : reportingPeriodKeyFromTimestamp(first.created_at)
}
