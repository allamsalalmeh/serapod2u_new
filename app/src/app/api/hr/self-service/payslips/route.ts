import { NextRequest, NextResponse } from 'next/server'
import { PUBLISHED_PAYROLL_RUN_STATUSES, noStore, requireSelfService } from '@/lib/server/hr/self-service'

export const dynamic = 'force-dynamic'

const PERIOD = /^\d{4}-\d{2}-\d{2}$/

/**
 * GET /api/hr/self-service/payslips?periodStart=YYYY-MM-DD&periodEnd=YYYY-MM-DD
 *
 * The caller's OWN published payslips (hr.self_service.use). The employee is the authenticated account and the
 * organization is its own; no employee or organization parameter is read, so changing ids/query parameters cannot reach
 * another person's payslip. Only items of a final payroll run (approved or posted) are returned; a calculated or draft
 * run is not published and never appears.
 */
export async function GET(request: NextRequest) {
  const ctx = await requireSelfService({ requireReadyEmployee: true })
  if (!ctx.ok) return ctx.response

  const periodStart = request.nextUrl.searchParams.get('periodStart')
  const periodEnd = request.nextUrl.searchParams.get('periodEnd')
  if ((periodStart && !PERIOD.test(periodStart)) || (periodEnd && !PERIOD.test(periodEnd))) {
    return NextResponse.json({ success: false, error: 'Invalid period' }, { status: 400, headers: noStore })
  }

  let query = ctx.admin
    .from('hr_payroll_run_items')
    .select(`
      id, basic_salary, gross_amount, deductions_amount, net_amount, allowances_amount, other_allowances,
      epf_employee, socso_employee, eis_employee, pcb_amount, created_at,
      hr_payroll_runs!inner (id, period_start, period_end, status, organization_id)
    `)
    .eq('employee_user_id', ctx.actor.userId)
    .eq('organization_id', ctx.actor.organizationId)
    .eq('hr_payroll_runs.organization_id', ctx.actor.organizationId)
    .in('hr_payroll_runs.status', [...PUBLISHED_PAYROLL_RUN_STATUSES])
    .order('created_at', { ascending: false })
    .limit(24)
  if (periodStart) query = query.gte('hr_payroll_runs.period_start', periodStart)
  if (periodEnd) query = query.lte('hr_payroll_runs.period_end', periodEnd)

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: 'Payslips are unavailable' }, { status: 500, headers: noStore })
  return NextResponse.json({ success: true, data: data ?? [] }, { headers: noStore })
}
