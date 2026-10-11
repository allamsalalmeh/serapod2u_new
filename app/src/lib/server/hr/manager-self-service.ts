import 'server-only'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadNavActor, type NavActor } from '@/lib/server/nav-access'
import { hrCan } from '@/lib/server/hrAccess'

export const noStore = { 'Cache-Control': 'no-store' }

export type ManagerContext =
  | { ok: true; actor: NavActor & { organizationId: string }; admin: any }
  | { ok: false; response: NextResponse }

/**
 * Manager Self-Service request context. The manager is ALWAYS the authenticated account: the account id comes from the
 * verified session and the organization from that account's own profile, never from the request. Any employee id,
 * user id or organization parameter a client sends is ignored.
 *
 *   - the permission is decided on the manager's OWN organization by the canonical S&A evaluation (hrCan), with no
 *     legacy fallback (a new capability; a legacy ALLOW can never widen it)
 *   - DATA scope (which employees the manager may reach) is enforced separately in each query via the current, active
 *     direct-report relationship (hr_employees.manager_user_id = the manager)
 *   - 401 expired login, 403 no permission, 400 no organization
 */
/** Auth + actor + admin client only (no permission decision): the verified account and its own organization. */
export async function requireManagerActor(): Promise<ManagerContext> {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) {
    return { ok: false, response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: noStore }) }
  }

  const actor = await loadNavActor(user.id)
  if (!actor?.organizationId) {
    return { ok: false, response: NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400, headers: noStore }) }
  }

  return { ok: true, actor: actor as NavActor & { organizationId: string }, admin: createAdminClient() as any }
}

export async function requireManagerPermission(permission: string): Promise<ManagerContext> {
  const ctx = await requireManagerActor()
  if (!ctx.ok) return ctx

  const allowed = await hrCan(
    { userId: ctx.actor.userId, organizationId: ctx.actor.organizationId, roleCode: ctx.actor.roleCode, roleLevel: ctx.actor.roleLevel },
    permission,
    () => false,
  )
  if (!allowed) {
    return { ok: false, response: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403, headers: noStore }) }
  }

  return ctx
}

/** The fields a manager may see about a direct report (never email, phone, salary or payroll data). */
export interface DirectReport {
  userId: string
  fullName: string | null
  jobTitle: string | null
  department: string | null
  employeeNo: number | null
  employmentStatus: string | null
}

const one = <T,>(value: T | T[] | null | undefined): T | null => (Array.isArray(value) ? value[0] ?? null : value ?? null)

type DirectReportRow = {
  id: string
  full_name: string | null
  employee_no: number | null
  employment_status: string | null
  positions?: { name?: string | null } | { name?: string | null }[] | null
  departments?: { dept_name?: string | null } | { dept_name?: string | null }[] | null
}

/** Pure projection (kept separate so it can be tested without a database). */
export function projectDirectReports(rows: readonly DirectReportRow[]): DirectReport[] {
  return rows.map((row) => ({
    userId: row.id,
    fullName: (row.full_name ?? '').trim() || 'Unnamed',
    jobTitle: one(row.positions)?.name ?? null,
    department: one(row.departments)?.dept_name ?? null,
    employeeNo: row.employee_no ?? null,
    employmentStatus: row.employment_status ?? null,
  }))
}

/**
 * The manager's CURRENT, active direct reports in the manager's own organization. The reporting relationship is the
 * single current hr_employees.manager_user_id (projected onto users), so a reporting-line change or an organization
 * transfer removes a person from this list immediately. Only active accounts whose HR onboarding is complete and whose
 * employment status is active/probation are returned.
 */
export async function loadDirectReports(admin: any, organizationId: string, managerId: string): Promise<DirectReport[]> {
  const { data, error } = await admin
    .from('users')
    .select(`
      id, full_name, employee_no, employment_status,
      positions:position_id (name),
      departments:department_id (dept_name),
      hr_employees!hr_employees_user_id_fkey!inner (organization_id, onboarding_status, status)
    `)
    .eq('organization_id', organizationId)
    .eq('manager_user_id', managerId)
    .eq('is_active', true)
    .eq('hr_employees.organization_id', organizationId)
    .eq('hr_employees.onboarding_status', 'completed')
    .in('hr_employees.status', ['active', 'probation'])
    .order('full_name', { ascending: true })
  if (error) throw new Error('direct_reports_unavailable')
  return projectDirectReports((data ?? []) as DirectReportRow[])
}
