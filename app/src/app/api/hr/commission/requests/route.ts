import { NextResponse } from 'next/server'
import { badRequest, commissionContext, isUuid, readJson, requireAny, rpc, text } from '@/lib/server/commission/route-kit'
import { employeeNames, userNames } from '@/lib/server/commission/data'

export const dynamic = 'force-dynamic'

/** GET /api/hr/commission/requests — pending rate changes and pending adjustments awaiting a decision. */
export async function GET() {
  const ctx = await commissionContext()
  if (ctx instanceof NextResponse) return ctx
  const denied = requireAny(ctx, 'hr.commission.view')
  if (denied) return denied
  const [{ data: rateRequests }, { data: adjustments }, { data: units }, { data: cycles }] = await Promise.all([
    ctx.supabase.from('hr_employee_commission_rule_requests').select('*').eq('status', 'pending').order('requested_at'),
    ctx.supabase.from('hr_commission_adjustments').select('*').eq('status', 'pending').order('requested_at'),
    ctx.supabase.from('hr_commission_business_units').select('id, name'),
    ctx.supabase.from('hr_commission_cycles').select('id, cycle_code, label'),
  ])
  const employees = await employeeNames([...(rateRequests ?? []), ...(adjustments ?? [])].map((r: any) => r.employee_id))
  const people = await userNames([...(rateRequests ?? []), ...(adjustments ?? [])].map((r: any) => r.requested_by))
  const bu = new Map((units ?? []).map((u: any) => [u.id, u.name]))
  const cy = new Map((cycles ?? []).map((c: any) => [c.id, c.label]))
  const decorate = (r: any) => ({
    ...r,
    employee_name: employees.get(r.employee_id)?.name ?? 'Unknown employee',
    employee_user_id: employees.get(r.employee_id)?.userId ?? null,
    business_unit_name: r.business_unit_id ? bu.get(r.business_unit_id) ?? null : null,
    requested_by_name: people[r.requested_by] ?? null,
    is_mine: r.requested_by === ctx.userId,
    is_about_me: employees.get(r.employee_id)?.userId === ctx.userId,
  })
  return NextResponse.json({
    success: true,
    rateRequests: (rateRequests ?? []).map(decorate),
    adjustments: (adjustments ?? []).map((a: any) => ({ ...decorate(a), target_cycle_label: cy.get(a.target_cycle_id) ?? null })),
  })
}

/** POST /api/hr/commission/requests — { kind: 'rate' | 'adjustment', id, approve, note } (hr.commission.approve). */
export async function POST(request: Request) {
  const ctx = await commissionContext()
  if (ctx instanceof NextResponse) return ctx
  const denied = requireAny(ctx, 'hr.commission.approve')
  if (denied) return denied
  const body = await readJson(request)
  if (!isUuid(body.id)) return badRequest('Invalid request.')
  const approve = body.approve === true
  const note = text(body.note) || null
  if (!approve && (!note || note.length < 5)) return badRequest('A reason of at least 5 characters is required to reject.')
  const fn = body.kind === 'adjustment' ? 'hr_commission_decide_adjustment' : body.kind === 'rate' ? 'hr_commission_decide_rule_request' : null
  if (!fn) return badRequest('Unknown request kind.')
  const r = await rpc(ctx, fn, body.kind === 'adjustment'
    ? { p_adjustment: body.id, p_approve: approve, p_note: note }
    : { p_request: body.id, p_approve: approve, p_note: note })
  return 'response' in r ? r.response : NextResponse.json({ success: true, result: r.data })
}
