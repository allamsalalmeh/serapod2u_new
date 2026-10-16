import { NextResponse } from 'next/server'
import { badRequest, commissionContext, isUuid, requireAny } from '@/lib/server/commission/route-kit'
import { logAccess, userNames } from '@/lib/server/commission/data'

export const dynamic = 'force-dynamic'

/**
 * GET /api/hr/commission/report/drilldown?cycleId=…&employeeId=… — one employee's commission in a cycle: each item with
 * its rate period and the exact source order lines it was calculated on, adjustments, and the cycle's approval trail.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const cycleId = url.searchParams.get('cycleId')
  const employeeId = url.searchParams.get('employeeId')
  if (!isUuid(cycleId) || !isUuid(employeeId)) return badRequest('Choose a cycle and an employee.')
  const ctx = await commissionContext()
  if (ctx instanceof NextResponse) return ctx
  const denied = requireAny(ctx, 'reporting.commission.view', 'hr.commission.view')
  if (denied) return denied

  const [{ data: cycle }, { data: items }, { data: adjustments }] = await Promise.all([
    ctx.supabase.from('hr_commission_cycles').select('id, label, status, calculated_by, calculated_at, submitted_by, submitted_at, approved_by, approved_at, approval_note, locked_by, locked_at, payroll_ready_by, payroll_ready_at, calc_version').eq('id', cycleId).maybeSingle(),
    ctx.supabase.from('hr_commission_items').select('*').eq('cycle_id', cycleId).eq('employee_id', employeeId),
    ctx.supabase.from('hr_commission_adjustments').select('id, kind, amount, reason, status, business_unit_id, source_order_no, requested_at, decided_at, decided_by, decision_note').eq('target_cycle_id', cycleId).eq('employee_id', employeeId),
  ])
  if (!cycle) return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
  const buIds = [...new Set((items ?? []).map((i: any) => i.business_unit_id))]
  const { data: sources } = buIds.length
    ? await ctx.supabase.from('hr_commission_sources')
      .select('id, order_id, order_item_id, order_no, order_status, buyer_name, approval_at, approval_source, approval_date, product_name, brand_name, business_unit_id, qty, unit_price, line_value')
      .eq('cycle_id', cycleId).in('business_unit_id', buIds).order('approval_at')
    : { data: [] as any[] }
  // Each source line under the item (rate period) it was paid at.
  const lines = (items ?? []).map((i: any) => ({
    ...i,
    sources: (sources ?? []).filter((s: any) => s.business_unit_id === i.business_unit_id
      && s.approval_date >= i.rule_effective_from && (i.rule_effective_to == null || s.approval_date <= i.rule_effective_to)),
  }))
  const names = await userNames([cycle.calculated_by, cycle.submitted_by, cycle.approved_by, cycle.locked_by, cycle.payroll_ready_by, ...(adjustments ?? []).map((a: any) => a.decided_by)])
  await logAccess(ctx, 'drilldown_viewed', 'employee', employeeId, { cycle_id: cycleId })
  return NextResponse.json({ success: true, cycle, items: lines, adjustments: adjustments ?? [], names })
}
