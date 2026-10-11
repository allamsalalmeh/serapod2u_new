import { NextResponse } from 'next/server'
import { badRequest, commissionContext, isDate, readJson, requireAny, rpc } from '@/lib/server/commission/route-kit'
import { loadCycles, userNames } from '@/lib/server/commission/data'

export const dynamic = 'force-dynamic'

/** GET /api/hr/commission/cycles — every cycle of the caller's company (newest first). */
export async function GET() {
  const ctx = await commissionContext()
  if (ctx instanceof NextResponse) return ctx
  const denied = requireAny(ctx, 'hr.commission.view', 'reporting.commission.view')
  if (denied) return denied
  const { data } = await loadCycles(ctx)
  const names = await userNames(data.flatMap((c: any) => [c.calculated_by, c.submitted_by, c.approved_by, c.locked_by, c.payroll_ready_by]))
  return NextResponse.json({ success: true, cycles: data, names })
}

/** POST /api/hr/commission/cycles — { periodMonth: 'YYYY-MM-01' } opens (or returns) that month's cycle. */
export async function POST(request: Request) {
  const ctx = await commissionContext()
  if (ctx instanceof NextResponse) return ctx
  const denied = requireAny(ctx, 'hr.commission.manage')
  if (denied) return denied
  const body = await readJson(request)
  if (!isDate(body.periodMonth) || !body.periodMonth.endsWith('-01')) return badRequest('Choose a cycle month.')
  const r = await rpc(ctx, 'hr_commission_ensure_cycle', { p_period_month: body.periodMonth })
  return 'response' in r ? r.response : NextResponse.json({ success: true, cycle: r.data })
}
