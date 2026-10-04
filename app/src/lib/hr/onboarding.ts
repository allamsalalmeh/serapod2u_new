import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeIdentityEmail, normalizeIdentityPhone } from '@/lib/identity/normalize'
import { IDENTITY_BLOCK_MESSAGES, isIdentityBlockCode, parseResolution } from '@/lib/identity/resolution'

/**
 * HR onboarding (Add Employee) over one central identity.
 *
 * The employment record (hr_employees) is created automatically for every
 * internal identity and only anchors employment facts; HR registration is the
 * explicit onboarding state, owned by public.hr_onboarding_complete
 * (supabase/migrations/20261003100000_hr_onboarding_state_and_data_reset.sql).
 *
 *   find the person   name search (selection aid only) or email/phone through
 *                     the canonical resolver (identity_resolve)
 *   preview           hr_onboarding_candidate: minimal, masked, authorized
 *   onboard           existing internal identity of the organization → same
 *                     user id, login and employee number; new person →
 *                     canonical provisioning first (provisionIdentity)
 *
 * Every function re-checks the actor's HR authority in the database.
 */

export type OnboardingStatus = 'pending' | 'completed' | 'reset'

export interface OnboardingCandidate {
  found: boolean
  user_id?: string
  full_name?: string | null
  email_masked?: string | null
  phone_masked?: string | null
  principal_type?: string
  account_status?: string
  same_organization?: boolean
  organization_name?: string | null
  has_login?: boolean
  employment?: {
    employee_no: number | null
    onboarding_status: OnboardingStatus
    employment_status: string
    hire_date: string | null
    hire_date_confirmed: boolean
    department_id: string | null
    position_id: string | null
    manager_user_id: string | null
    employment_type: string | null
  } | null
  block_code?: string | null
  eligible?: boolean
}

export const ONBOARDING_BLOCK_MESSAGES: Record<string, string> = {
  ...IDENTITY_BLOCK_MESSAGES,
  IDENTITY_NOT_INTERNAL_EMPLOYEE:
    'This person is not an internal employee of this organization (for example a distributor or shop user). Their account must be converted through User Management first.',
  EMPLOYMENT_ENDED:
    'This person\'s employment with this organization has ended. Re-hiring is an employment lifecycle step, not onboarding.',
  SELF_ONBOARDING: 'You cannot complete your own HR onboarding. Another HR administrator must do it.',
}

const DB_ERRORS: Array<[RegExp, string, number, string]> = [
  [/identity_org_move_required/, 'IDENTITY_ORG_MOVE_REQUIRED', 409, ONBOARDING_BLOCK_MESSAGES.IDENTITY_ORG_MOVE_REQUIRED],
  [/identity_principal_upgrade_required/, 'IDENTITY_PRINCIPAL_UPGRADE_REQUIRED', 409, ONBOARDING_BLOCK_MESSAGES.IDENTITY_PRINCIPAL_UPGRADE_REQUIRED],
  [/identity_not_internal_employee/, 'IDENTITY_NOT_INTERNAL_EMPLOYEE', 409, ONBOARDING_BLOCK_MESSAGES.IDENTITY_NOT_INTERNAL_EMPLOYEE],
  [/identity_archived/, 'IDENTITY_ARCHIVED', 409, ONBOARDING_BLOCK_MESSAGES.IDENTITY_ARCHIVED],
  [/identity_inactive/, 'IDENTITY_INACTIVE', 409, ONBOARDING_BLOCK_MESSAGES.IDENTITY_INACTIVE],
  [/hr_employment_ended/, 'EMPLOYMENT_ENDED', 409, ONBOARDING_BLOCK_MESSAGES.EMPLOYMENT_ENDED],
  [/hr_onboarding_self_prohibited/, 'SELF_ONBOARDING', 403, ONBOARDING_BLOCK_MESSAGES.SELF_ONBOARDING],
  [/identity_hr_reference_outside_organization/, 'INVALID_ORGANIZATION', 400, 'The department, position or manager does not belong to this organization.'],
  [/hr_onboarding_hire_date_required/, 'INVALID_INPUT', 400, 'The actual hire date is required.'],
  [/hr_onboarding_hire_date_invalid/, 'INVALID_INPUT', 400, 'The hire date is not valid.'],
  [/hr_onboarding_employment_type_invalid/, 'INVALID_INPUT', 400, 'The employment type is not valid.'],
  [/hr_onboarding_identity_unknown/, 'NOT_FOUND', 404, 'This person was not found.'],
  [/sa_authorization_required|sa_actor_inactive|sa_actor_required/, 'FORBIDDEN', 403, 'You are not authorized to onboard employees in this organization.'],
]

export type OnboardingError = { ok: false; code: string; status: number; message: string }

export function mapOnboardingDbError(error: { message?: string | null } | null | undefined): OnboardingError {
  const message = error?.message || ''
  for (const [pattern, code, status, text] of DB_ERRORS) {
    if (pattern.test(message)) return { ok: false, code, status, message: text }
  }
  return { ok: false, code: 'ONBOARDING_FAILED', status: 500, message: 'HR onboarding could not be completed. No changes were kept.' }
}

export async function searchOnboardingCandidates(actorId: string, organizationId: string, query: string) {
  const admin = createAdminClient() as any
  const { data, error } = await admin.rpc('hr_onboarding_search', { p_actor: actorId, p_org: organizationId, p_query: query })
  if (error) return mapOnboardingDbError(error)
  return { ok: true as const, candidates: (Array.isArray(data) ? data : []) as Array<{
    user_id: string; full_name: string | null; email_masked: string | null; employee_no: number | null; onboarding_status: OnboardingStatus
  }> }
}

export async function previewOnboardingCandidate(actorId: string, organizationId: string, userId: string) {
  const admin = createAdminClient() as any
  const { data, error } = await admin.rpc('hr_onboarding_candidate', { p_actor: actorId, p_org: organizationId, p_user: userId })
  if (error) return mapOnboardingDbError(error)
  return { ok: true as const, candidate: data as OnboardingCandidate }
}

export type ResolvedForOnboarding =
  | { ok: true; outcome: 'NEW_PERSON' }
  | { ok: true; outcome: 'EXISTING'; candidate: OnboardingCandidate }
  | OnboardingError

/** Email/phone → canonical resolver → minimal preview. Names are never used here. */
export async function resolveForOnboarding(actorId: string, organizationId: string, email: string | null, phone: string | null): Promise<ResolvedForOnboarding> {
  const normalizedEmail = email && email.trim() ? normalizeIdentityEmail(email) : null
  const normalizedPhone = phone && phone.trim() ? normalizeIdentityPhone(phone) : null
  if ((email && email.trim() && !normalizedEmail) || (phone && phone.trim() && !normalizedPhone) || (!normalizedEmail && !normalizedPhone)) {
    return { ok: false, code: 'INVALID_INPUT', status: 400, message: 'Enter a valid email address or phone number.' }
  }
  const admin = createAdminClient() as any
  const { data, error } = await admin.rpc('identity_resolve', { p_email: normalizedEmail, p_phone: normalizedPhone })
  if (error) return mapOnboardingDbError(error)
  const resolution = parseResolution(data)
  if (resolution.outcome === 'INVALID_INPUT') {
    return { ok: false, code: 'INVALID_INPUT', status: 400, message: 'Enter a valid email address or phone number.' }
  }
  if (isIdentityBlockCode(resolution.outcome)) {
    await admin.rpc('identity_record_conflict', {
      p_code: resolution.outcome, p_resolution: data, p_email: normalizedEmail, p_phone: normalizedPhone,
      p_source: 'hr', p_actor: actorId, p_details: { stage: 'hr_onboarding_lookup' },
    })
    return { ok: false, code: resolution.outcome, status: 409, message: IDENTITY_BLOCK_MESSAGES[resolution.outcome] }
  }
  if (resolution.outcome === 'NO_MATCH') return { ok: true, outcome: 'NEW_PERSON' }
  if (!resolution.userId || resolution.hasProfile === false) {
    // A login without a profile is completed by canonical provisioning (no second account).
    return { ok: true, outcome: 'NEW_PERSON' }
  }
  const preview = await previewOnboardingCandidate(actorId, organizationId, resolution.userId)
  if (!preview.ok) return preview
  return { ok: true, outcome: 'EXISTING', candidate: preview.candidate }
}

export interface EmploymentFacts {
  departmentId?: string | null
  positionId?: string | null
  managerUserId?: string | null
  employmentType?: string | null
  hireDate: string
}

export async function completeOnboarding(actorId: string, organizationId: string, userId: string, facts: EmploymentFacts, source: string) {
  const admin = createAdminClient() as any
  const { data, error } = await admin.rpc('hr_onboarding_complete', {
    p_actor: actorId,
    p_user: userId,
    p_payload: {
      organization_id: organizationId,
      department_id: facts.departmentId || null,
      position_id: facts.positionId || null,
      manager_user_id: facts.managerUserId || null,
      employment_type: facts.employmentType || null,
      hire_date: facts.hireDate,
      source,
    },
  })
  if (error) return mapOnboardingDbError(error)
  return {
    ok: true as const,
    outcome: data?.outcome as 'ONBOARDED' | 'REONBOARDED' | 'ALREADY_ONBOARDED',
    userId: data?.user_id as string,
    employeeNo: (data?.employee_no ?? null) as number | null,
  }
}

/** The caller's own onboarding state in an organization (ESS). */
export async function getOwnOnboardingState(userId: string, organizationId: string): Promise<OnboardingStatus | 'none' | 'unknown'> {
  try {
    const admin = createAdminClient() as any
    const { data, error } = await admin.rpc('hr_onboarding_state', { p_user: userId, p_org: organizationId })
    if (error) return 'unknown'
    return (data ?? 'none') as OnboardingStatus | 'none'
  } catch {
    return 'unknown'
  }
}

/** True when a database error is the "HR onboarding not completed" guard. */
export function isOnboardingPendingError(error: { message?: string | null } | null | undefined): boolean {
  return /hr_onboarding_pending/.test(error?.message || '')
}

export const ONBOARDING_PENDING_MESSAGE =
  'Your HR profile is still being set up. HR must complete your onboarding before attendance, leave and payroll records can be created.'
