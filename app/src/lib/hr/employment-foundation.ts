import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { employmentError, type EmploymentErrorInfo } from '@/lib/hr/employment-messages'

/**
 * HR employment foundation (Wave 2, migration 20261221100000) — server calls.
 *
 * The database decides every rule on every call: explicit (non-legacy) S&A authority in the EMPLOYEE's organization
 * (an organization scope covers its child organizations), self-service where it applies, no self-change for HR,
 * former-employee lock, reporting-line validation, effective dating, reasons, append-only history. The server only
 * passes the session actor (never a body value) and maps refusals to clear messages. Fail closed: any error refuses.
 */

/** The S&A permissions the database entry points assert (explicit, non-legacy; in the employee's organization). */
export const EMPLOYMENT_PERMISSIONS = {
  /** history (besides the employee themself) and the reporting-line review */
  view: 'hr.employee.view',
  /** employment changes, reporting-line changes, HR profile and statutory profile (HR side) */
  manage: 'hr.employee.manage',
} as const

export type RpcResult<T> = { ok: true; data: T } | ({ ok: false } & EmploymentErrorInfo)

export interface SessionActor {
  id: string
  organizationId: string | null
}

/** The signed-in person (verified by the auth server, not by a request value). */
export async function sessionActor(): Promise<SessionActor | null> {
  const supabase = (await createClient()) as any
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user?.id) return null
  const { data: profile } = await supabase.from('users').select('id, organization_id').eq('id', user.id).single()
  if (!profile?.id) return null
  return { id: profile.id as string, organizationId: (profile.organization_id as string | null) ?? null }
}

export async function callHr<T>(fn: string, args: Record<string, unknown>, fallback?: string): Promise<RpcResult<T>> {
  try {
    const { data, error } = await (createAdminClient() as any).rpc(fn, args)
    if (error) return { ok: false, ...employmentError(error, fallback) }
    return { ok: true, data: data as T }
  } catch (e) {
    return { ok: false, ...employmentError(e, fallback) }
  }
}

export const employeeHistory = (actorId: string, employeeUserId: string) =>
  callHr<unknown[]>('hr_employee_history', { p_actor: actorId, p_employee_user: employeeUserId }, 'The employment history could not be loaded.')

export const employeeProfile = (actorId: string, employeeUserId: string) =>
  callHr<Record<string, any>>('hr_employee_profile_get', { p_actor: actorId, p_employee_user: employeeUserId }, 'The profile could not be loaded.')

export const saveEmployeeProfile = (actorId: string, employeeUserId: string, personal: Record<string, unknown> | null,
                                    statutory: Record<string, unknown> | null, reason: string | null) =>
  callHr<Record<string, any>>('hr_employee_profile_save', {
    p_actor: actorId, p_employee_user: employeeUserId, p_personal: personal, p_statutory: statutory, p_reason: reason,
  }, 'The profile could not be saved.')

export const employmentChange = (actorId: string, employeeUserId: string, changes: Record<string, unknown>,
                                 effectiveDate: string, reason: string) =>
  callHr<{ status: string; version_no: number; change_kind: string }>('hr_employment_change', {
    p_actor: actorId, p_employee_user: employeeUserId, p_changes: changes, p_effective_date: effectiveDate, p_reason: reason,
  })

export const reportingLineReview = (actorId: string, organizationId: string) =>
  callHr<unknown[]>('hr_reporting_line_review_for', { p_actor: actorId, p_org: organizationId }, 'The reporting-line review could not be loaded.')

export const setReportingLine = (actorId: string, employeeUserId: string, managerUserId: string | null, reason: string) =>
  callHr<{ status: string }>('hr_set_reporting_line', {
    p_actor: actorId, p_employee_user: employeeUserId, p_manager_user: managerUserId, p_reason: reason,
  })

export const reassignDirectReports = (actorId: string, fromManager: string, toManager: string | null, reason: string,
                                      employeeUserIds: string[] | null) =>
  callHr<{ status: string; count: number }>('hr_reassign_direct_reports', {
    p_actor: actorId, p_from_manager: fromManager, p_to_manager: toManager, p_reason: reason, p_employee_users: employeeUserIds,
  })
