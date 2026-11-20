import { guardUserOperation } from '@/lib/security-access/operation'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { legacyOrderDateNotice, resolveOrderDateColumn } from '@/lib/reporting/business-date-query'
import { currentReportingMonthKey, isValidMonthKey } from '@/lib/reporting/consumer-analytics'
import { overviewDateWindows, resolveExecutiveOverviewPeriod } from '@/lib/reporting/executive-overview'
import { OVERVIEW_DRILLDOWN_STATUSES, buildOverviewDrilldown, isOverviewDrilldownMetric } from '@/lib/reporting/executive-overview-drilldown'
import { readOverviewOrders, toOverviewOrderInput } from '@/lib/reporting/executive-overview-source'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET /api/reporting/stats/drilldown
 *     ?metric=confirmed_orders|active_buyers|cancelled_orders&month=YYYY-MM[&buyer=<org uuid>][&page=0][&pageSize=25]
 *
 * The records behind the Executive Overview's Confirmed Sales Orders, Active
 * Buyers and Cancelled Orders cards, for the SAME month, window, statuses and buyer identity as
 * `/api/reporting/stats` (see lib/reporting/executive-overview-drilldown.ts).
 * Same authentication and Security & Access operation as the Overview; reads
 * with the caller's own client so row-level security decides which orders and
 * buyers exist. Paged on the server: the browser only ever receives one page.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const metric = searchParams.get('metric')
    if (!isOverviewDrilldownMetric(metric)) {
      return NextResponse.json({ error: `Invalid metric "${metric}"` }, { status: 400 })
    }
    const month = searchParams.get('month') || currentReportingMonthKey()
    if (!isValidMonthKey(month)) {
      return NextResponse.json({ error: 'Invalid reporting month. Use YYYY-MM.' }, { status: 400 })
    }
    if (month > currentReportingMonthKey()) {
      return NextResponse.json({ error: 'Reporting month is in the future.' }, { status: 400 })
    }
    const buyer = searchParams.get('buyer')
    if (buyer && !UUID_RE.test(buyer)) {
      return NextResponse.json({ error: 'Invalid buyer.' }, { status: 400 })
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
    // Only the report window and only the metric's statuses: the card's population is a subset of this read.
    const { start, end } = overviewDateWindows(period)
    const rows = await readOverviewOrders(supabase, dateColumn, start, end, OVERVIEW_DRILLDOWN_STATUSES[metric])

    const drilldown = buildOverviewDrilldown({
      metric,
      month,
      orders: rows.map(toOverviewOrderInput),
      buyerId: buyer,
      page: Number(searchParams.get('page') ?? 0),
      pageSize: Number(searchParams.get('pageSize') ?? 0) || undefined,
    })

    return NextResponse.json(
      { drilldown, meta: { notice: legacyOrderDateNotice(dateColumn) } },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error: any) {
    console.error('[Reporting API] Executive overview drill-down failed:', error)
    return NextResponse.json({ error: error?.message || 'Unable to load drill-down' }, { status: 500 })
  }
}
