import { NextResponse } from 'next/server'
import { badRequest, commissionContext, isUuid, reportFilters, requireAny } from '@/lib/server/commission/route-kit'
import { loadReport, logAccess } from '@/lib/server/commission/data'

export const dynamic = 'force-dynamic'

/** GET /api/hr/commission/report?cycleId=…[&businessUnitId&employeeId&departmentId] — the Commission Reporting model. */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const cycleId = url.searchParams.get('cycleId')
  if (!isUuid(cycleId)) return badRequest('Choose a commission cycle.')
  const ctx = await commissionContext()
  if (ctx instanceof NextResponse) return ctx
  const denied = requireAny(ctx, 'reporting.commission.view', 'hr.commission.view')
  if (denied) return denied
  const filters = reportFilters(url)
  const report = await loadReport(ctx, cycleId, filters)
  if (!report) return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
  await logAccess(ctx, 'report_viewed', 'commission_cycle', cycleId, { filters })
  return NextResponse.json({ success: true, report })
}
