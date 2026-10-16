import { NextResponse } from 'next/server'
import { badRequest, commissionContext, isUuid, reportFilters, requireAny } from '@/lib/server/commission/route-kit'
import { loadReport, logAccess, userNames } from '@/lib/server/commission/data'
import { buildCommissionPdf, buildCommissionWorkbook, exportFilename } from '@/lib/hr/commission/export'

export const dynamic = 'force-dynamic'

/**
 * GET /api/hr/commission/report/export?cycleId=…&format=xlsx|pdf[&filters] — reporting.commission.export.
 * Built on the server from the same report model as the screen; every export is audited.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const cycleId = url.searchParams.get('cycleId')
  const format = url.searchParams.get('format')
  if (!isUuid(cycleId)) return badRequest('Choose a commission cycle.')
  if (format !== 'xlsx' && format !== 'pdf') return badRequest('Format must be xlsx or pdf.')
  const ctx = await commissionContext()
  if (ctx instanceof NextResponse) return ctx
  const denied = requireAny(ctx, 'reporting.commission.export')
  if (denied) return denied
  const filters = reportFilters(url)
  const report = await loadReport(ctx, cycleId, filters)
  if (!report) return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
  const me = (await userNames([ctx.userId]))[ctx.userId] ?? null
  const meta = { generatedAt: new Date().toISOString(), generatedBy: me }
  const buffer = format === 'xlsx' ? await buildCommissionWorkbook(report, meta) : await buildCommissionPdf(report, meta)
  await logAccess(ctx, 'report_exported', 'commission_cycle', cycleId, { format, filters, calc_version: report.cycle.calcVersion })
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf',
      'Content-Disposition': `attachment; filename="${exportFilename(report, format)}"`,
      'Cache-Control': 'no-store',
    },
  })
}
