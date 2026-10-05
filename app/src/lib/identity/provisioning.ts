import 'server-only'
import { randomInt } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { normalizeIdentityEmail, normalizeIdentityPhone } from './normalize'
import {
  IDENTITY_BLOCK_MESSAGES,
  isIdentityBlockCode,
  parseResolution,
  type HumanPrincipalType,
  type IdentityBlockCode,
} from './resolution'

/**
 * Canonical provisioning service — the only way enterprise humans are
 * onboarded. It never lets an administrator choose "link existing or create
 * new": the identity is resolved from the email/phone, then
 *
 *   normalize → resolve (identity_resolve) → create the auth identity only on
 *   NO_MATCH → identity_provision (one database transaction: authorization,
 *   re-resolution under a lock, profile, organization membership + baseline
 *   via the lifecycle, optional initial S&A role, audit).
 *
 * If anything after the auth identity was created fails or is blocked, the
 * auth identity created by THIS request is deleted, so no orphan remains. If
 * that compensation itself fails, the auth identity is still resolvable
 * (identity_resolve reads auth.users), so a retry reuses it rather than
 * creating a duplicate.
 */

export type IdentitySource = 'user_management' | 'hr' | 'department' | 'import'

export interface ProvisionIdentityInput {
  actorId: string
  email: string
  phone?: string | null
  fullName: string
  callName?: string | null
  organizationId?: string | null
  accountScope?: 'portal' | 'store'
  expectedPrincipalType?: HumanPrincipalType
  /** Legacy compatibility role. Omit for the baseline; anything else is access administration. */
  legacyRoleCode?: string | null
  authorizingPermission?: 'platform.user.manage' | 'hr.employee.manage'
  /** Administrator-chosen password; otherwise a strong temporary password is generated. */
  password?: string | null
  hr?: {
    departmentId?: string | null
    managerUserId?: string | null
    positionId?: string | null
    employmentType?: string | null
    joinDate?: string | null
  }
  initialAccess?: { roleId: string; scopeIds?: string[]; reason: string }
  /** Several Access Profiles, each with its own explicit scope. Assigned all-or-nothing inside the provisioning transaction. */
  initialProfiles?: Array<{ roleId: string; scopeIds: string[]; reason?: string }>
  source: IdentitySource
  reason?: string
}

export type IdentityErrorCode =
  | IdentityBlockCode
  | 'INVALID_INPUT'
  | 'FORBIDDEN'
  | 'ROLE_GRANT_NOT_ALLOWED'
  | 'INVALID_ORGANIZATION'
  | 'AUTH_IDENTITY_FAILED'
  | 'PROVISIONING_FAILED'

export type ProvisionIdentityResult =
  | {
      ok: true
      userId: string
      outcome: 'CREATED' | 'REUSED'
      principalType: HumanPrincipalType
      membershipId: string | null
      initialAssignmentId: string | null
      legacyRoleCode: string | null
      /** Only when this request created the login and generated the password. */
      tempPassword?: string
    }
  | { ok: false; code: IdentityErrorCode; status: number; message: string; matchedUserIds?: string[] }

const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#$%'

export function generateTemporaryPassword(length = 14): string {
  let password = ''
  for (let i = 0; i < length; i++) password += TEMP_PASSWORD_ALPHABET[randomInt(TEMP_PASSWORD_ALPHABET.length)]
  return password
}

const DB_ERROR_MAP: Array<[RegExp, IdentityErrorCode, number, string]> = [
  [/identity_role_grant_not_allowed|identity_role_change_not_allowed/, 'ROLE_GRANT_NOT_ALLOWED', 403,
    'That role cannot be granted: it is unknown, inactive, or above your own access level.'],
  [/sa_authorization_required|sa_actor_inactive|sa_actor_required|identity_self_/, 'FORBIDDEN', 403,
    'You are not authorized to perform this identity or access change.'],
  [/sa_profile_not_applicable/, 'ROLE_GRANT_NOT_ALLOWED', 400,
    'One of the selected Access Profiles does not apply to this organization or account type. Nothing was created; choose a suitable profile.'],
  [/sa_profile_sensitive_not_initial/, 'ROLE_GRANT_NOT_ALLOWED', 400,
    'Administrative or reset profiles cannot be assigned while creating a user. Create the user first, then assign them in Security & Access → People & Access. Nothing was created.'],
  [/sa_scope_required|sa_scope_outside_membership/, 'INVALID_INPUT', 400,
    'Each Access Profile needs its own scope inside this person\'s organization. Nothing was created.'],
  [/sa_initial_access_duplicate|sa_initial_access_invalid/, 'INVALID_INPUT', 400,
    'The Access Profile selection is not valid (each profile once, at most ten). Nothing was created.'],
  [/identity_consumer_cannot_receive_business_role|sa_self_assignment_prohibited|sod_violation|sa_role_not_assignable|sa_scope_/, 'FORBIDDEN', 403,
    'The requested initial access cannot be granted to this person. Nothing was created.'],
  [/identity_organization_unknown|identity_organization_required|identity_hr_reference_outside_organization|identity_principal_type_mismatch|identity_hr_requires_enterprise/, 'INVALID_ORGANIZATION', 400,
    'The organization, department, position or manager does not fit this person.'],
  [/identity_email_invalid|identity_phone_invalid|identity_account_scope_invalid|identity_authorizing_permission_invalid/, 'INVALID_INPUT', 400,
    'The email or phone number is not valid.'],
]

/** Maps a database exception from the identity functions to a caller-safe error. */
export function mapIdentityDbError(error: { message?: string | null } | null | undefined): Exclude<ProvisionIdentityResult, { ok: true }> {
  const message = error?.message || ''
  for (const [pattern, code, status, text] of DB_ERROR_MAP) {
    if (pattern.test(message)) return { ok: false, code, status, message: text }
  }
  return { ok: false, code: 'PROVISIONING_FAILED', status: 500, message: 'The identity could not be provisioned. No changes were kept.' }
}

function blocked(code: IdentityBlockCode, matchedUserIds?: string[]): ProvisionIdentityResult {
  return { ok: false, code, status: 409, message: IDENTITY_BLOCK_MESSAGES[code], matchedUserIds }
}

export async function provisionIdentity(input: ProvisionIdentityInput): Promise<ProvisionIdentityResult> {
  const email = normalizeIdentityEmail(input.email)
  const phone = input.phone && String(input.phone).trim() ? normalizeIdentityPhone(input.phone) : null
  if (!email) return { ok: false, code: 'INVALID_INPUT', status: 400, message: 'A valid email address is required.' }
  if (input.phone && String(input.phone).trim() && !phone) {
    return { ok: false, code: 'INVALID_INPUT', status: 400, message: 'The phone number is not valid. Use an international (+CC…) or Malaysian (01x…) number.' }
  }
  if (!input.fullName?.trim()) return { ok: false, code: 'INVALID_INPUT', status: 400, message: 'Full name is required.' }

  const admin = createAdminClient() as any

  // 1. Resolve before touching the auth service.
  const { data: resolved, error: resolveError } = await admin.rpc('identity_resolve', { p_email: email, p_phone: phone })
  if (resolveError) return mapIdentityDbError(resolveError)
  const resolution = parseResolution(resolved)
  if (resolution.outcome === 'INVALID_INPUT') {
    return { ok: false, code: 'INVALID_INPUT', status: 400, message: 'The email or phone number is not valid.' }
  }
  if (isIdentityBlockCode(resolution.outcome)) {
    await admin.rpc('identity_record_conflict', {
      p_code: resolution.outcome, p_resolution: resolved, p_email: email, p_phone: phone,
      p_source: input.source, p_actor: input.actorId, p_details: { stage: 'resolve' },
    })
    return blocked(resolution.outcome, resolution.matchedUserIds)
  }

  // 2. Create the login only when no identity exists.
  let userId = resolution.userId
  let created = false
  let tempPassword: string | undefined
  if (resolution.outcome === 'NO_MATCH') {
    const password = input.password?.trim() ? input.password : (tempPassword = generateTemporaryPassword())
    const { data: authUser, error: authError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      phone: phone ?? undefined,
      phone_confirm: !!phone,
      user_metadata: { full_name: input.fullName.trim() },
    })
    if (authError || !authUser?.user?.id) {
      return { ok: false, code: 'AUTH_IDENTITY_FAILED', status: 409, message: authError?.message || 'The login could not be created.' }
    }
    userId = authUser.user.id as string
    created = true
  }

  const compensate = async () => {
    if (!created || !userId) return
    const { error } = await admin.auth.admin.deleteUser(userId)
    if (error) console.error('[identity] compensation failed; auth identity remains resolvable for retry', { userId })
  }

  // 3. One transaction for profile, membership, initial access and audit.
  const payload = {
    email,
    phone,
    full_name: input.fullName.trim(),
    call_name: input.callName?.trim() || null,
    organization_id: input.organizationId || null,
    account_scope: input.accountScope ?? (input.organizationId ? 'portal' : 'store'),
    expected_principal_type: input.expectedPrincipalType ?? null,
    legacy_role_code: input.legacyRoleCode || null,
    authorizing_permission: input.authorizingPermission ?? 'platform.user.manage',
    created_identity: created,
    source: input.source,
    reason: input.reason ?? null,
    department_id: input.hr?.departmentId || null,
    manager_user_id: input.hr?.managerUserId || null,
    position_id: input.hr?.positionId || null,
    employment_type: input.hr?.employmentType || null,
    join_date: input.hr?.joinDate || null,
    initial_role_id: input.initialAccess?.roleId ?? null,
    initial_scope_ids: input.initialAccess?.scopeIds ?? [],
    initial_reason: input.initialAccess?.reason ?? null,
    initial_access: (input.initialProfiles ?? []).map(p => ({ role_id: p.roleId, scope_ids: p.scopeIds, reason: p.reason ?? null })),
  }
  let data: any
  try {
    const result = await admin.rpc('identity_provision', { p_actor: input.actorId, p_user: userId, p_payload: payload })
    if (result.error) {
      await compensate()
      return mapIdentityDbError(result.error)
    }
    data = result.data
  } catch (error) {
    await compensate()
    return mapIdentityDbError(error as any)
  }

  if (data?.status !== 'ok') {
    await compensate()
    const code = isIdentityBlockCode(data?.code) ? data.code : 'IDENTITY_CONFLICT'
    return blocked(code, Array.isArray(data?.matched_user_ids) ? data.matched_user_ids : undefined)
  }

  return {
    ok: true,
    userId: data.user_id,
    outcome: data.outcome,
    principalType: data.principal_type,
    membershipId: data.membership_id ?? null,
    initialAssignmentId: data.initial_assignment_id ?? null,
    legacyRoleCode: data.legacy_role_code ?? null,
    ...(created && tempPassword ? { tempPassword } : {}),
  }
}

/** Account lifecycle change through the database lifecycle function. */
export async function setIdentityAccountStatus(actorId: string, userId: string, status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED' | 'ARCHIVED', reason: string) {
  const admin = createAdminClient() as any
  const { data, error } = await admin.rpc('identity_set_account_status', {
    p_actor: actorId, p_user: userId, p_status: status, p_reason: reason,
  })
  if (error) return mapIdentityDbError(error)
  // Login follows the lifecycle: an archived identity cannot sign in; any
  // other status lifts a previous archive ban (access itself is governed by
  // account_status in the database and S&A).
  const { error: banError } = await admin.auth.admin.updateUserById(userId, { ban_duration: status === 'ARCHIVED' ? '876000h' : 'none' })
  if (banError) console.error('[identity] login ban could not be updated; account status still governs access', { userId })
  return { ok: true as const, status: data as string }
}

/** Enterprise access fields (legacy role code / organization context) of an existing identity. */
export async function updateIdentityAccess(actorId: string, userId: string, change: { roleCode?: string | null; organizationId?: string | null; changeOrganization: boolean }, reason: string) {
  const admin = createAdminClient() as any
  const { data, error } = await admin.rpc('identity_admin_update_access', {
    p_actor: actorId, p_user: userId, p_role_code: change.roleCode ?? null,
    p_organization_id: change.organizationId ?? null, p_change_org: change.changeOrganization, p_reason: reason,
  })
  if (error) return mapIdentityDbError(error)
  return { ok: true as const, access: data as { role_code: string; organization_id: string | null; account_scope: string } }
}

/** Business/audit history that forbids a hard delete (archive instead). */
export async function identityHistoryReferences(userId: string): Promise<string[] | null> {
  const admin = createAdminClient() as any
  const { data, error } = await admin.rpc('identity_history_references', { p_user: userId })
  if (error) return null
  return Array.isArray(data) ? data : []
}
