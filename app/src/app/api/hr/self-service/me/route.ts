import { NextResponse } from 'next/server'
import { noStore, requireSelfService } from '@/lib/server/hr/self-service'

export const dynamic = 'force-dynamic'

const first = <T,>(value: T | T[] | null | undefined): T | null => (Array.isArray(value) ? value[0] ?? null : value ?? null)

/**
 * GET /api/hr/self-service/me — the caller's own employment summary (hr.self_service.use, own record).
 * `state: 'pending'` when no verified employee record exists or HR onboarding is incomplete: nothing is fabricated.
 */
export async function GET() {
  const ctx = await requireSelfService()
  if (!ctx.ok) return ctx.response
  if (ctx.employee === 'pending') return NextResponse.json({ success: true, state: 'pending' }, { headers: noStore })

  const { actor, admin } = ctx
  const { data: user, error } = await admin
    .from('users')
    .select(`
      full_name, employee_no, employment_type, employment_status,
      positions:position_id (name),
      departments:department_id (dept_name),
      manager:manager_user_id (full_name),
      organizations:organization_id (org_name)
    `)
    .eq('id', actor.userId)
    .maybeSingle()
  const { data: employment } = await admin
    .from('hr_employees')
    .select('hire_date, hire_date_confirmed')
    .eq('user_id', actor.userId)
    .eq('organization_id', actor.organizationId)
    .maybeSingle()
  if (error || !user) return NextResponse.json({ success: false, error: 'Employment details are unavailable' }, { status: 500, headers: noStore })

  return NextResponse.json({
    success: true,
    state: 'ready',
    employment: {
      name: user.full_name ?? null,
      employeeNo: user.employee_no ?? null,
      jobTitle: first<any>(user.positions)?.name ?? null,
      department: first<any>(user.departments)?.dept_name ?? null,
      manager: first<any>(user.manager)?.full_name ?? null,
      employmentType: user.employment_type ?? null,
      employmentStatus: user.employment_status ?? null,
      organization: first<any>(user.organizations)?.org_name ?? null,
      // A login/creation date is never presented as a confirmed hire date.
      hireDate: employment?.hire_date_confirmed ? employment.hire_date ?? null : null,
    },
  }, { headers: noStore })
}
