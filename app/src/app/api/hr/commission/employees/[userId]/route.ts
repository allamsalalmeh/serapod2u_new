import { NextResponse } from 'next/server'
import { badRequest, commissionContext, isDate, isUuid, readJson, requireAny, rpc, text } from '@/lib/server/commission/route-kit'
import { employeeOfUser, logAccess, userNames } from '@/lib/server/commission/data'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ userId: string }> }

/** GET /api/hr/commission/employees/:userId — eligibility, rate history, change requests and recent commission. */
export async function GET(_request: Request, { params }: Params) {
  const { userId } = await params
  if (!isUuid(userId)) return badRequest('Invalid employee.')
  const ctx = await commissionContext()
  if (ctx instanceof NextResponse) return ctx
  const denied = requireAny(ctx, 'hr.commission.view')
  if (denied) return denied
  const employee = await employeeOfUser(ctx, userId)
  if (!employee) return NextResponse.json({ success: true, employee: null })

  const [{ data: profile }, { data: rules }, { data: requests }, { data: items }] = await Promise.all([
    ctx.supabase.from('hr_employee_commission_profiles').select('*').eq('employee_id', employee.id).maybeSingle(),
    ctx.supabase.from('hr_employee_commission_rules').select('*').eq('employee_id', employee.id).order('effective_from', { ascending: false }),
    ctx.supabase.from('hr_employee_commission_rule_requests').select('*').eq('employee_id', employee.id).order('requested_at', { ascending: false }).limit(50),
    ctx.supabase.from('hr_commission_items').select('cycle_id, business_unit_name, rate_percent, eligible_sales, commission_amount, hr_commission_cycles(cycle_code, label, status)').eq('employee_id', employee.id).limit(24),
  ])
  const names = await userNames([
    profile?.updated_by,
    ...(rules ?? []).flatMap((r: any) => [r.requested_by, r.approved_by, r.ended_by]),
    ...(requests ?? []).flatMap((r: any) => [r.requested_by, r.decided_by]),
  ])
  await logAccess(ctx, 'employee_viewed', 'employee', employee.id)
  return NextResponse.json({
    success: true,
    employee: { id: employee.id, onboardingStatus: employee.onboarding_status, status: employee.status, endDate: employee.end_date },
    profile: profile ?? null,
    rules: rules ?? [],
    requests: requests ?? [],
    recentItems: items ?? [],
    names,
    selfUserId: ctx.userId,
  })
}

/**
 * POST /api/hr/commission/employees/:userId
 *   { action: 'eligibility', isEligible, reason }
 *   { action: 'request_rate', businessUnitId, ratePercent, effectiveFrom, effectiveTo?, reason }
 *   { action: 'request_end', ruleId, effectiveTo, reason }
 *   { action: 'cancel_request', requestId, reason? }
 * hr.commission.manage. Rates take effect only after approval by another person (hr.commission.approve).
 */
export async function POST(request: Request, { params }: Params) {
  const { userId } = await params
  if (!isUuid(userId)) return badRequest('Invalid employee.')
  const ctx = await commissionContext()
  if (ctx instanceof NextResponse) return ctx
  const denied = requireAny(ctx, 'hr.commission.manage')
  if (denied) return denied
  const employee = await employeeOfUser(ctx, userId)
  if (!employee) return NextResponse.json({ success: false, error: 'This person has no HR employee record in your company.' }, { status: 404 })
  const body = await readJson(request)
  const reason = text(body.reason)

  if (body.action === 'eligibility') {
    const r = await rpc(ctx, 'hr_commission_set_eligibility', { p_employee: employee.id, p_is_eligible: body.isEligible === true, p_reason: reason })
    return 'response' in r ? r.response : NextResponse.json({ success: true, profile: r.data })
  }
  if (body.action === 'request_rate') {
    const rate = typeof body.ratePercent === 'string' ? body.ratePercent.trim() : String(body.ratePercent ?? '')
    if (!/^\d{1,3}(\.\d{1,5})?$/.test(rate) || Number(rate) <= 0 || Number(rate) > 100) return badRequest('Enter a rate above 0% and at most 100%, with up to 5 decimals.')
    if (!isUuid(body.businessUnitId) || !isDate(body.effectiveFrom)) return badRequest('Choose a Business Unit and an effective date.')
    if (body.effectiveTo && (!isDate(body.effectiveTo) || body.effectiveTo < body.effectiveFrom)) return badRequest('The end date must be on or after the start date.')
    // The rate travels as a decimal string so no binary rounding touches it.
    const r = await rpc(ctx, 'hr_commission_request_rate', {
      p_employee: employee.id, p_business_unit: body.businessUnitId, p_rate_percent: rate,
      p_effective_from: body.effectiveFrom, p_effective_to: body.effectiveTo || null, p_reason: reason,
    })
    return 'response' in r ? r.response : NextResponse.json({ success: true, request: r.data })
  }
  if (body.action === 'request_end') {
    if (!isUuid(body.ruleId) || !isDate(body.effectiveTo)) return badRequest('Choose a rate and an end date.')
    const r = await rpc(ctx, 'hr_commission_request_rule_end', { p_rule: body.ruleId, p_effective_to: body.effectiveTo, p_reason: reason })
    return 'response' in r ? r.response : NextResponse.json({ success: true, request: r.data })
  }
  if (body.action === 'cancel_request') {
    if (!isUuid(body.requestId)) return badRequest('Invalid request.')
    const r = await rpc(ctx, 'hr_commission_cancel_rule_request', { p_request: body.requestId, p_reason: reason || null })
    return 'response' in r ? r.response : NextResponse.json({ success: true, request: r.data })
  }
  return badRequest('Unknown action.')
}
