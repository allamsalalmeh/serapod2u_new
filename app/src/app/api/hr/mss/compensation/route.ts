import { NextResponse } from 'next/server'
import { noStore, requireManagerActor, loadDirectReports } from '@/lib/server/hr/manager-self-service'
import { hrCan } from '@/lib/server/hrAccess'

export const dynamic = 'force-dynamic'

/**
 * GET /api/hr/mss/compensation — basic salary and authorized fixed allowances of the manager's own direct reports.
 *
 * Restricted and READ-ONLY (Manager Compensation Viewer). The manager is the authenticated account; the organization is
 * its own. Salary requires hr.compensation.salary_view, allowances require hr.compensation.allowance_view; each field is
 * returned only when its own permission is held. Data scope is the manager's current, active direct reports.
 *
 * Payslips, net salary, banking, EPF/SOCSO/PCB, deductions, payroll runs, salary history and export are NEVER returned.
 */
export async function GET() {
  const ctx = await requireManagerActor()
  if (!ctx.ok) return ctx.response

  const { actor, supabase, admin } = ctx
  const orgId = actor.organizationId

  const [salaryView, allowanceView] = await Promise.all([
    hrCan({ userId: actor.userId, organizationId: orgId, roleCode: actor.roleCode, roleLevel: actor.roleLevel }, 'hr.compensation.salary_view', () => false),
    hrCan({ userId: actor.userId, organizationId: orgId, roleCode: actor.roleCode, roleLevel: actor.roleLevel }, 'hr.compensation.allowance_view', () => false),
  ])
  if (!salaryView && !allowanceView) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403, headers: noStore })
  }

  try {
    const reports = await loadDirectReports(admin, orgId, actor.userId)

    // Sensitive compensation reads go through the CALLER'S OWN session, so the row-level security policies on
    // hr_employee_compensation / hr_employee_allowances decide the scope (permission + organization + the current,
    // active direct-report relationship). No employee id is passed: the database restricts rows to the manager's own
    // direct reports. Only the permitted columns are selected.
    const [comp, allowances] = await Promise.all([
      salaryView
        ? supabase
            .from('hr_employee_compensation')
            .select('employee_id, basic_salary, effective_date, currency')
            .eq('organization_id', orgId)
            .eq('status', 'active')
        : null,
      allowanceView
        ? supabase
            .from('hr_employee_allowances')
            .select('employee_id, amount, currency, allowance_type_id')
            .eq('organization_id', orgId)
            .eq('is_active', true)
        : null,
    ])

    const compError = comp && (comp.error as unknown)
    const allowanceError = allowances && (allowances.error as unknown)
    if (compError || allowanceError) {
      return NextResponse.json({ success: false, error: 'Compensation is unavailable' }, { status: 500, headers: noStore })
    }

    const out = reports.map((r) => {
      const entry: Record<string, unknown> = {
        userId: r.userId,
        fullName: r.fullName,
        jobTitle: r.jobTitle,
        department: r.department,
      }
      if (salaryView) {
        const row = (comp?.data ?? []).find((c: any) => c.employee_id === r.userId)
        entry.basicSalary = row ? row.basic_salary : null
        entry.currency = row ? row.currency : null
      }
      if (allowanceView) {
        entry.allowances = (allowances?.data ?? [])
          .filter((a: any) => a.employee_id === r.userId)
          .map((a: any) => ({ allowanceTypeId: a.allowance_type_id, amount: a.amount, currency: a.currency }))
      }
      return entry
    })

    return NextResponse.json({ success: true, data: out }, { headers: noStore })
  } catch {
    return NextResponse.json({ success: false, error: 'Compensation is unavailable' }, { status: 500, headers: noStore })
  }
}
