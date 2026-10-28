import { guardUserOperation } from '@/lib/security-access/operation'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ALL_DISTRIBUTORS, resolveDistributorReportPeriod } from '@/lib/reporting/distributor-analytics'
import {
  fetchDistributorAnalyticsAggregate,
  fetchEligibleOrderHistory,
  fetchEligibleWindowOrders,
  fetchReportingDistributors,
} from '@/lib/reporting/distributor-analytics-source'
import {
  DISTRIBUTOR_METRIC_PREDICATES,
  buildDistributorRows,
} from '@/lib/reporting/distributor-analytics'
import { buildDistributorDrilldown, isDrilldownMetric } from '@/lib/reporting/distributor-drilldown'
import { parseDistributorReportParams } from '@/lib/reporting/distributor-report-params'

export const dynamic = 'force-dynamic'

/**
 * GET /api/reporting/distributor-analytics/drilldown
 *     ?metric=total_orders|approved_orders|active|new|inactive|returning
 *     &month=YYYY-MM&distributor=all|<uuid>&status=all|<order_status>
 *
 * The rows behind one dashboard card, for the SAME scope the dashboard shows.
 * It reads the same aggregate as /api/reporting/distributor-analytics and lists
 * the rows its headline counts (see lib/reporting/distributor-drilldown.ts);
 * `reconciled` reports whether the rows reproduce the headline.
 */
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const saDenied = await guardUserOperation(user.id, 'reporting.analytics.view')
  if (saDenied) return saDenied

  const searchParams = new URL(request.url).searchParams
  const metric = searchParams.get('metric')
  if (!isDrilldownMetric(metric)) {
    return NextResponse.json({ error: `Invalid metric "${metric}"` }, { status: 400 })
  }
  const params = parseDistributorReportParams(searchParams)
  if (!params.ok) return NextResponse.json({ error: params.error }, { status: 400 })
  const { month, distributor, status } = params

  try {
    const now = new Date()
    const { aggregate, source } = await fetchDistributorAnalyticsAggregate(supabase, month, distributor, status, now)
    const period = resolveDistributorReportPeriod(month, now)

    if (metric === 'total_orders' || metric === 'approved_orders') {
      const all = await fetchReportingDistributors(supabase)
      const scoped = distributor === ALL_DISTRIBUTORS ? all : all.filter((row) => row.id === distributor)
      const orders = await fetchEligibleWindowOrders(supabase, { distributors: scoped, status, period, source })
      const creatorIds = Array.from(new Set(orders.map((order) => order.createdById).filter((id): id is string => !!id)))
      const userNames = new Map<string, string>()
      if (creatorIds.length > 0) {
        const { data: users } = await supabase.from('users').select('id, full_name, email').in('id', creatorIds)
        for (const row of (users || []) as any[]) userNames.set(row.id, row.full_name || row.email || '')
      }
      const drilldown = buildDistributorDrilldown({ aggregate, metric, orders, userNames, now })
      return NextResponse.json({ drilldown, meta: { source } }, { headers: { 'Cache-Control': 'no-store' } })
    }

    // Order history only for the distributors this metric lists — labels, never membership.
    const listedIds = buildDistributorRows(aggregate, period)
      .filter(DISTRIBUTOR_METRIC_PREDICATES[metric])
      .map((row) => row.distributorId)
    const history = await fetchEligibleOrderHistory(supabase, { distributorIds: listedIds, status })
    const drilldown = buildDistributorDrilldown({ aggregate, metric, history, now })
    return NextResponse.json({ drilldown, meta: { source } }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Unable to load drill-down' }, { status: 500 })
  }
}
