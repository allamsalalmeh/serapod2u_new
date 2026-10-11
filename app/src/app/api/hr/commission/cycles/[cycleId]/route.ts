import { NextResponse } from 'next/server'
import { badRequest, commissionContext, isDate, isUuid, readJson, requireAny, rpc, text } from '@/lib/server/commission/route-kit'
import { employeeNames, userNames } from '@/lib/server/commission/data'
import type { CommissionPermission } from '@/lib/security-access/commission'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ cycleId: string }> }

/** GET /api/hr/commission/cycles/:id — cycle, review flags, adjustments, calculation runs and (HR) the audit trail. */
export async function GET(_request: Request, { params }: Params) {
  const { cycleId } = await params
  if (!isUuid(cycleId)) return badRequest('Invalid cycle.')
  const ctx = await commissionContext()
  if (ctx instanceof NextResponse) return ctx
  const denied = requireAny(ctx, 'hr.commission.view', 'reporting.commission.view')
  if (denied) return denied
  const [{ data: cycle }, { data: flags }, { data: adjustments }, { data: runs }, { data: audit }, { data: transfers }] = await Promise.all([
    ctx.supabase.from('hr_commission_cycles').select('*').eq('id', cycleId).maybeSingle(),
    ctx.supabase.from('hr_commission_review_flags').select('*').eq('cycle_id', cycleId).order('flag_type'),
    ctx.supabase.from('hr_commission_adjustments').select('*').eq('target_cycle_id', cycleId).order('requested_at'),
    ctx.supabase.from('hr_commission_calc_runs').select('*').eq('cycle_id', cycleId).order('calc_version', { ascending: false }),
    ctx.supabase.from('hr_commission_audit_log').select('id, actor_id, action, reason, details, occurred_at').eq('entity_type', 'commission_cycle').eq('entity_id', cycleId).order('occurred_at'),
    ctx.supabase.from('hr_commission_payroll_transfers').select('*').eq('cycle_id', cycleId),
  ])
  if (!cycle) return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
  const employees = await employeeNames((adjustments ?? []).map((a: any) => a.employee_id))
  const names = await userNames([cycle.calculated_by, cycle.submitted_by, cycle.approved_by, cycle.locked_by, cycle.payroll_ready_by,
    ...(audit ?? []).map((a: any) => a.actor_id), ...(adjustments ?? []).flatMap((a: any) => [a.requested_by, a.decided_by])])
  return NextResponse.json({
    success: true,
    cycle,
    flags: flags ?? [],
    adjustments: (adjustments ?? []).map((a: any) => ({ ...a, employee_name: employees.get(a.employee_id)?.name ?? 'Unknown employee' })),
    runs: runs ?? [],
    // The audit trail is HR administration data (RLS returns nothing to Commission Reporting alone).
    history: audit ?? [],
    transfers: transfers ?? [],
    names,
  })
}

const ACTIONS: Record<string, { permission: CommissionPermission; fn: string }> = {
  calculate: { permission: 'hr.commission.manage', fn: 'hr_commission_calculate' },
  submit: { permission: 'hr.commission.manage', fn: 'hr_commission_submit_cycle' },
  request_adjustment: { permission: 'hr.commission.manage', fn: 'hr_commission_request_adjustment' },
  return: { permission: 'hr.commission.approve', fn: 'hr_commission_return_cycle' },
  approve: { permission: 'hr.commission.approve', fn: 'hr_commission_approve_cycle' },
  lock: { permission: 'hr.commission.approve', fn: 'hr_commission_lock_cycle' },
  payroll_ready: { permission: 'hr.commission.approve', fn: 'hr_commission_mark_payroll_ready' },
}

/**
 * POST /api/hr/commission/cycles/:id — { action, ... }
 *   calculate | submit {note?} | return {reason} | approve {acknowledgeFlags, note?} | lock {note?}
 *   payroll_ready {payrollPeriodStart, payrollPeriodEnd, note?} (prepares hand-off rows only; no payroll is created)
 *   request_adjustment {employeeUserId, businessUnitId?, amount, reason, sourceOrderNo?}
 */
export async function POST(request: Request, { params }: Params) {
  const { cycleId } = await params
  if (!isUuid(cycleId)) return badRequest('Invalid cycle.')
  const ctx = await commissionContext()
  if (ctx instanceof NextResponse) return ctx
  const body = await readJson(request)
  const spec = ACTIONS[String(body.action)]
  if (!spec) return badRequest('Unknown action.')
  const denied = requireAny(ctx, spec.permission)
  if (denied) return denied
  const note = text(body.note) || null

  let args: Record<string, unknown>
  switch (body.action) {
    case 'calculate': args = { p_cycle: cycleId }; break
    case 'submit': args = { p_cycle: cycleId, p_note: note }; break
    case 'lock': args = { p_cycle: cycleId, p_note: note }; break
    case 'return': {
      const reason = text(body.reason)
      if (reason.length < 5) return badRequest('A reason of at least 5 characters is required.')
      args = { p_cycle: cycleId, p_reason: reason }; break
    }
    case 'approve': args = { p_cycle: cycleId, p_acknowledge_flags: body.acknowledgeFlags === true, p_note: note }; break
    case 'payroll_ready': {
      if (!isDate(body.payrollPeriodStart) || !isDate(body.payrollPeriodEnd) || body.payrollPeriodEnd < body.payrollPeriodStart) return badRequest('Enter a valid payroll period.')
      args = { p_cycle: cycleId, p_payroll_period_start: body.payrollPeriodStart, p_payroll_period_end: body.payrollPeriodEnd, p_note: note }; break
    }
    case 'request_adjustment': {
      const amount = typeof body.amount === 'string' ? body.amount.trim() : String(body.amount ?? '')
      if (!/^-?\d{1,10}(\.\d{1,2})?$/.test(amount) || Number(amount) === 0) return badRequest('Enter a non-zero amount with at most 2 decimals.')
      if (!isUuid(body.employeeId)) return badRequest('Choose an employee.')
      if (body.businessUnitId != null && body.businessUnitId !== '' && !isUuid(body.businessUnitId)) return badRequest('Invalid Business Unit.')
      const reason = text(body.reason)
      if (reason.length < 5) return badRequest('A reason of at least 5 characters is required.')
      args = { p_employee: body.employeeId, p_business_unit: body.businessUnitId || null, p_target_cycle: cycleId, p_amount: amount,
        p_reason: reason, p_source_cycle: isUuid(body.sourceCycleId) ? body.sourceCycleId : null, p_source_order_no: text(body.sourceOrderNo, 60) || null }
      break
    }
    default: return badRequest('Unknown action.')
  }
  const r = await rpc(ctx, spec.fn, args)
  return 'response' in r ? r.response : NextResponse.json({ success: true, result: r.data })
}
