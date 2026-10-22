import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { isUuid } from '@/lib/hr/data-reset'

/**
 * HR → People → Employees: Delete Employee / Reset HR Registration, one
 * employee at a time. The database owns every rule
 * (supabase/migrations/20261214100000_hr_employee_controlled_delete.sql):
 * explicit hr.employee.delete grant in the organization, target in the same
 * organization, no self action, HR not live, dependency blockers re-checked
 * under row locks, preview token, idempotency key, append-only audit.
 *
 * Neither action deletes a row: the identity, login, access, employment record
 * and employee number stay (the employment record is the anchor the identity
 * triggers would recreate). "Delete" removes the HR registration of someone
 * with no HR records (back to Awaiting onboarding); "Reset" marks a registered
 * employee for re-onboarding and keeps their HR history.
 */

export const REGISTRATION_PERMISSION = 'hr.employee.delete'

export type RegistrationAction = 'delete' | 'reset'
export const isRegistrationAction = (value: unknown): value is RegistrationAction => value === 'delete' || value === 'reset'
export { isUuid }

export interface RegistrationBlocker {
  code: 'SELF' | 'HR_LIVE' | 'NOT_REGISTERED' | 'NOT_COMPLETED' | 'HR_RECORDS' | 'DIRECT_REPORTS' | string
  category?: string
  count?: number
  message?: string
}

export interface RegistrationPreview {
  employee: {
    user_id: string
    full_name: string | null
    employee_no: number | null
    onboarding_status: 'pending' | 'completed' | 'reset'
    employment_status: string
    account_status: string | null
  }
  phase: 'pre_go_live' | 'live'
  categories: Record<string, number>
  direct_reports: number
  kept: { login: boolean; access_assignments: number; employee_no: number | null }
  blockers: { delete: RegistrationBlocker[]; reset: RegistrationBlocker[] }
  delete_allowed: boolean
  reset_allowed: boolean
  preview_token: string
}

const CATEGORY_LABELS: Record<string, string> = {
  attendance: 'attendance, overtime or timesheet records',
  leave: 'leave requests, balances or approvals',
  payroll: 'payroll lines or payslips',
  compensation: 'compensation, allowances, deductions or benefits',
  commission: 'sales commission records',
  performance: 'KPI or performance review records',
  other_hr: 'other HR records (contracts, claims, onboarding, approvals or HR configuration)',
  reporting_line: 'direct reports',
}

/** Caller-safe explanation of one blocker. */
export function describeBlocker(b: RegistrationBlocker): string {
  switch (b.code) {
    case 'SELF': return 'You cannot delete or reset your own HR registration. Another HR administrator must do it.'
    case 'HR_LIVE': return 'HR for this organization is live. Individual deletes and resets are only available before HR goes live.'
    case 'NOT_REGISTERED': return 'This person is not registered in HR (awaiting onboarding), so there is nothing to delete.'
    case 'NOT_COMPLETED': return 'Only an employee whose HR onboarding is completed can be reset.'
    case 'DIRECT_REPORTS':
      return `${b.count ?? 'Some'} employee(s) report to this person. Assign them another manager first.`
    case 'HR_RECORDS':
      return `This employee has ${b.count != null ? `${b.count} ` : ''}${CATEGORY_LABELS[b.category ?? ''] ?? 'HR records'}. HR records are never deleted to make an employee eligible; use Reset HR Registration instead.`
    default: return 'This action is not available for this employee.'
  }
}

function withMessages(preview: RegistrationPreview): RegistrationPreview {
  const add = (list: RegistrationBlocker[] | undefined) => (list ?? []).map(b => ({ ...b, message: describeBlocker(b) }))
  return { ...preview, blockers: { delete: add(preview.blockers?.delete), reset: add(preview.blockers?.reset) } }
}

const DB_ERRORS: Array<[RegExp, string, number, string]> = [
  [/sa_authorization_required/, 'FORBIDDEN', 403,
    'You need the "HR Employee Record Administrator" policy for this organization in Security & Access.'],
  [/sa_actor_inactive|sa_actor_required/, 'FORBIDDEN', 403, 'Your account cannot perform this action.'],
  [/hr_employee_not_in_organization/, 'NOT_FOUND', 404, 'This employee was not found in your organization.'],
  [/hr_employee_registration_self_prohibited/, 'SELF', 403, 'You cannot delete or reset your own HR registration.'],
  [/hr_employee_registration_reason_required/, 'REASON_REQUIRED', 400, 'Enter a reason of at least 10 characters.'],
  [/hr_employee_registration_request_reused/, 'INVALID_INPUT', 400, 'This request was already used for another action. Review the preview again.'],
  [/hr_employee_registration_(input_required|action_invalid)/, 'INVALID_INPUT', 400, 'The request is incomplete.'],
  [/hr_employee_registration_organization_unknown/, 'NOT_FOUND', 404, 'Organization not found.'],
  [/hr_employee_registration_count_mismatch/, 'CONFLICT', 409, 'The employee record changed during the request, so nothing was changed. Review the preview again.'],
  [/lock_not_available|canceling statement due to lock timeout/, 'BUSY', 409, 'This employee\'s records are being changed right now. Nothing was changed; try again in a moment.'],
]

export type RegistrationError = { ok: false; code: string; status: number; message: string }

export function mapRegistrationDbError(error: { message?: string | null } | null | undefined): RegistrationError {
  const message = error?.message || ''
  for (const [pattern, code, status, text] of DB_ERRORS) {
    if (pattern.test(message)) return { ok: false, code, status, message: text }
  }
  if (/function .* does not exist|Could not find the function/i.test(message)) {
    return { ok: false, code: 'NOT_INSTALLED', status: 503, message: 'Employee delete is not installed on this database yet.' }
  }
  return { ok: false, code: 'FAILED', status: 500, message: 'The request did not complete. No changes were kept.' }
}

export async function registrationActorCheck(actorId: string, organizationId: string) {
  const admin = createAdminClient() as any
  const { data, error } = await admin.rpc('hr_employee_registration_actor_check', { p_actor: actorId, p_org: organizationId })
  if (error) return mapRegistrationDbError(error)
  return { ok: true as const, check: { ...(data as { permission: boolean; phase: 'pre_go_live' | 'live' }), permission_key: REGISTRATION_PERMISSION } }
}

export async function registrationPreview(actorId: string, organizationId: string, userId: string) {
  const admin = createAdminClient() as any
  const { data, error } = await admin.rpc('hr_employee_registration_preview', { p_actor: actorId, p_org: organizationId, p_user: userId })
  if (error) return mapRegistrationDbError(error)
  return { ok: true as const, preview: withMessages(data as RegistrationPreview) }
}

export async function registrationExecute(input: {
  actorId: string
  organizationId: string
  userId: string
  action: RegistrationAction
  requestId: string
  previewToken: string
  reason: string
}) {
  const admin = createAdminClient(30_000) as any
  const { data, error } = await admin.rpc('hr_employee_registration_execute', {
    p_actor: input.actorId,
    p_org: input.organizationId,
    p_user: input.userId,
    p_action: input.action,
    p_request_id: input.requestId,
    p_preview_token: input.previewToken,
    p_reason: input.reason,
  })
  if (error) return mapRegistrationDbError(error)
  const result = data as { status: 'completed' | 'blocked' | 'stale'; replayed?: boolean; action_id?: string; new_status?: string;
    employee_no?: number | null; blockers?: RegistrationBlocker[]; message?: string }
  return { ok: true as const, result: { ...result, blockers: (result.blockers ?? []).map(b => ({ ...b, message: describeBlocker(b) })) } }
}
