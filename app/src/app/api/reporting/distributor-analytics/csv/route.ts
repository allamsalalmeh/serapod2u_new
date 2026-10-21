import { guardUserOperation } from '@/lib/security-access/operation'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import {
  ALL_DISTRIBUTORS,
  ALL_STATUS,
  DISTRIBUTOR_ORG_TYPE,
  ELIGIBLE_ORDER_TYPE,
  ORDER_STATUSES,
  isActiveStatus,
  currentReportingMonthKey,
  distributorReportFilename,
  isValidMonthKey,
  LEGACY_REPORT_DATE_FIELD,
  REPORT_DATE_FIELD,
  reportDateWindows,
  resolveDistributorReportPeriod,
  statusLabel,
  type OrderStatus,
} from '@/lib/reporting/distributor-analytics'
import {
  filterBusinessDateRange,
  orderByBusinessDate,
  orderDateSelect,
  resolveOrderDateColumn,
  scopeEligibleDistributorOrders,
} from '@/lib/reporting/distributor-analytics-source'
import { orderBusinessDate } from '@/lib/orders/order-date'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PAGE_SIZE = 1000
/** Rows a single operational export may carry before it is refused. */
const MAX_ROWS = 50_000

const HEADERS = [
  'Order No', 'Date (MYT)', 'Distributor', 'Status', 'Counts As Active', 'Qty', 'Order Value (RM)',
] as const

function csvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

/**
 * GET /api/reporting/distributor-analytics/csv
 *     ?month=YYYY-MM&distributor=all|<uuid>&status=all|<order_status>
 *
 * Order-level operational export, retained from the previous report but now
 * scoped to the SAME reporting month, distributor and status as the management
 * report on screen — the old export used the retired rolling `dateRange`
 * presets and could not agree with what the user was looking at.
 *
 * Detailed reporting: every status of the scope is exported, draft and
 * cancelled included, and `Counts As Active` marks the rows that make up the
 * report's Active Orders / Active Order Value.
 *
 * Row-level detail belongs in a download rather than in the report DTO, so the
 * export is streamed straight to a file and never passes through the report
 * payload the browser holds.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const saDenied = await guardUserOperation(user.id, 'reporting.analytics.view')
    if (saDenied) return saDenied

    const currentMonth = currentReportingMonthKey()
    const params = new URL(request.url).searchParams
    const month = params.get('month') ?? currentMonth
    if (!isValidMonthKey(month) || month > currentMonth) {
      return NextResponse.json({ error: `Invalid reporting month "${month}"` }, { status: 400 })
    }
    const distributorId = params.get('distributor')?.trim() || ALL_DISTRIBUTORS
    if (distributorId !== ALL_DISTRIBUTORS && !UUID.test(distributorId)) {
      return NextResponse.json({ error: `Invalid distributor "${distributorId}"` }, { status: 400 })
    }
    const status = params.get('status')?.trim() || ALL_STATUS
    if (status !== ALL_STATUS && !(ORDER_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ error: `Invalid order status "${status}"` }, { status: 400 })
    }

    const period = resolveDistributorReportPeriod(month, new Date())

    // Distributor organisations resolve to stable ids first, so "buyer must be
    // a distributor" stays an indexed IN rather than a post-filter.
    const { data: orgs, error: orgError } = await supabase
      .from('organizations')
      .select('id, org_name')
      .eq('org_type_code', DISTRIBUTOR_ORG_TYPE)
    if (orgError) throw orgError

    const scoped = ((orgs || []) as any[])
      .filter((row) => distributorId === ALL_DISTRIBUTORS || row.id === distributorId)
    const nameById = new Map(scoped.map((row) => [row.id, (row.org_name || '').trim() || 'Unknown distributor']))
    const scopeName = distributorId === ALL_DISTRIBUTORS
      ? 'All Distributors'
      : nameById.get(distributorId) || 'Unknown distributor'

    const lines: string[] = [HEADERS.map(csvCell).join(',')]
    // Same business-date column and window as the report: order_date, or the
    // MYT date of created_at on a database that predates the migration.
    const dateColumn = await resolveOrderDateColumn(supabase)
    const windows = reportDateWindows(period)

    if (scoped.length > 0 && period.dayCount > 0) {
      const ids = scoped.map((row) => row.id)
      for (let from = 0; ; from += PAGE_SIZE) {
        // Same eligible-order scope as the report and its drill-downs.
        const query = filterBusinessDateRange(
          scopeEligibleDistributorOrders(
            supabase
              .from('orders')
              .select(`id, order_no, display_doc_no, ${orderDateSelect(dateColumn)}, status, buyer_org_id, order_items(qty, unit_price, line_total)`),
            ids,
            status as OrderStatus | typeof ALL_STATUS,
          ),
          dateColumn,
          windows.start,
          windows.end,
        )

        const { data, error } = await orderByBusinessDate(query, dateColumn, false)
          .range(from, from + PAGE_SIZE - 1)
        if (error) throw error

        const page = (data || []) as any[]
        for (const order of page) {
          const items = (order.order_items || []) as any[]
          const value = items.reduce((sum, item) => {
            const total = Number(item.line_total)
            if (Number.isFinite(total) && total !== 0) return sum + total
            return sum + (Number(item.qty) || 0) * (Number(item.unit_price) || 0)
          }, 0)
          const qty = items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0)
          lines.push([
            order.display_doc_no || order.order_no || order.id,
            orderBusinessDate(order) ?? '',
            nameById.get(order.buyer_org_id) || 'Unknown distributor',
            statusLabel(order.status || 'unknown'),
            isActiveStatus(order.status) ? 'Yes' : 'No',
            qty,
            value.toFixed(2),
          ].map(csvCell).join(','))
        }

        if (page.length < PAGE_SIZE) break
        if (lines.length > MAX_ROWS) {
          return NextResponse.json(
            { error: `Export exceeds ${MAX_ROWS.toLocaleString('en-MY')} rows — narrow the distributor or status filter.` },
            { status: 413 },
          )
        }
      }
    }

    const scope = {
      id: distributorId,
      name: scopeName,
      isAll: distributorId === ALL_DISTRIBUTORS,
    }
    const filename = distributorReportFilename(period, scope, 'csv')

    // A header block keeps an exported file self-describing: which month, which
    // scope and which inclusion rules produced these rows.
    const preamble = [
      `# Serapod Distributor Report — ${period.label}${period.isCurrentMonth ? ' (month to date)' : ''}`,
      `# Report Period: ${period.rangeLabel}`,
      `# Distributor: ${scopeName}`,
      `# Status: ${status === ALL_STATUS ? 'All Status' : statusLabel(status)}`,
      '# Active Orders / Active Order Value = rows with Counts As Active = Yes (submitted and approved-stage); draft and cancelled rows are history only',
      `# Order Type: ${ELIGIBLE_ORDER_TYPE} · Buyer Org Type: ${DISTRIBUTOR_ORG_TYPE} · Bucketed on ${dateColumn === 'order_date' ? `${REPORT_DATE_FIELD} (business SO date)` : `${LEGACY_REPORT_DATE_FIELD} (Asia/Kuala_Lumpur) — order_date migration not applied`}`,
    ].join('\n')

    return new Response(`${preamble}\n${lines.join('\n')}`, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unable to export' }, { status: 500 })
  }
}
