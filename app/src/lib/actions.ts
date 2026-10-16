'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { normalizePhone } from '@/lib/utils'
import { SIGNUP_PASSWORD_MIN_LENGTH_MESSAGE } from '@/lib/engagement/registration-link-selection'
import {
  getRegistrationPendingShopDisplayName,
  matchesRegistrationPendingShopSelection,
  sanitizeRegistrationPendingShopRequest,
} from '@/lib/engagement/registration-link-selection'
import { normalizePhoneE164, samePhone } from '@/utils/phone'
import { checkPermissionForUser } from '@/lib/server/permissions'
import { userAllowed } from '@/lib/security-access/operation'
import { ROOT_TARGET_PROTECTED_MESSAGE, rootTargetGuard } from '@/lib/security-access/root-access'
import { legacyOrDelegatedSecurityAccess } from '@/lib/security-access/delegation'
import { isSensitivePermission } from '@/lib/security-access/profiles'
import { sortGroupPolicies } from '@/lib/security-access/group-policies'
import { essAllowedForOrgType, ESS_HQ_ONLY_MESSAGE } from '@/lib/security-access/ess-eligibility'
import { employmentEligibilityError, hqOnlyEmploymentFieldsPresent } from '@/lib/users/employment-eligibility'
import { isManufacturerOrgType, recipientEligibility, type EligibilityModel } from '@/lib/security-access/recipient-eligibility'
import { loadEligibilityModel } from '@/lib/security-access/eligibility-model'
import { essGrantAllowed, validateInitialSelections } from '@/lib/identity/add-user-selections'
import { reconcileEssBaseline, resolveEssIntent } from '@/lib/identity/ess-baseline'
import { loadScopeChoices, validateScopeGrant } from '@/lib/security-access/scope-grant'
import { warehouseSupportFor } from '@/lib/security-access/scope-eligibility'
import { previewOnboardingCandidate } from '@/lib/hr/onboarding'
import { explainOperation, PreflightUnavailableError } from '@/lib/security-access/preflight'
import {
  identityHistoryReferences,
  provisionIdentity,
  setIdentityAccountStatus,
  updateIdentityAccess,
} from '@/lib/identity/provisioning'
import { authorizeIdentityRemoval } from '@/lib/identity/removal-authorization'

/** Organization of an existing user (trusted row), for S&A target scoping. */
const NO_ORGANIZATION_MATCH = '00000000-0000-0000-0000-000000000000'
async function targetUserOrganization(userId: string): Promise<string | null> {
  try {
    const admin = createAdminClient() as any
    const { data, error } = await admin.from('users').select('organization_id').eq('id', userId).maybeSingle()
    if (error) return NO_ORGANIZATION_MATCH // fail closed under S&A; legacy mode unaffected
    return data?.organization_id ?? null
  } catch {
    return NO_ORGANIZATION_MATCH
  }
}
import { hasLinkedShopProfile } from '@/lib/engagement/point-claim-settings'
import { resolveRegistrationLinkSelection } from '@/lib/engagement/registration-link-resolution'
import { sanitizeRoadtourRegistrationContext } from '@/lib/roadtour/registration-context'
import { createShopOrganization } from '@/lib/shop-requests/create-shop'
import {
  assertShopCreationAllowed,
  isShopIdentityConflictError,
  type ShopIdentityConfirmations,
} from '@/lib/shop-requests/shop-identity-guard'
import { resolveRoadtourByToken } from '@/lib/roadtour/server'
import { getRoadtourExperienceForCategory } from '@/lib/roadtour/experience-registry'
import {
  upsertProgramMembershipsForUserAndOrganization,
  upsertUserProgramMembership,
  type LoyaltyParticipantType,
  type LoyaltyProgramCode,
} from '@/lib/server/loyalty-memberships'
import {
  findCodeByVerificationToken,
  logNotificationEvent as logRegistrationNotificationEvent,
  markCodeUsed as markRegistrationCodeUsed,
} from '@/server/auth/registrationVerificationService'
import {
  getDisallowedSelfServiceFields,
  pickAdminEditableUserFields,
  pickSelfServiceProfileFields,
} from '@/lib/security/user-profile-updates'
import { referenceEligibilityError } from '@/lib/users/reference-eligibility'

export async function createUserWithAuth(userData: {
  email: string
  password: string
  full_name: string
  call_name?: string
  /**
   * Not accepted. Accounts are created without a legacy role/level (see below); any value is rejected, so a
   * crafted payload cannot create a privileged legacy account. Legacy values of existing users change only through
   * the audited access-administration update, never through creation.
   */
  role_code?: string
  organization_id?: string
  phone?: string
  is_active?: boolean
  avatar_url?: string | null
  shop_name?: string | null
  address?: string | null
  referral_phone?: string | null
  bank_id?: string | null
  bank_account_number?: string | null
  bank_account_holder_name?: string | null
  department_id?: string | null
  manager_user_id?: string | null
  position_id?: string | null
  employment_type?: string | null
  join_date?: string | null
  employment_status?: string | null
  can_be_reference?: boolean
  /** Optional initial S&A business role (Security & Access administrators only; re-checked in the database). */
  initial_role_id?: string | null
  /** Several Group Policies, each with its own explicit scope (validated together, all or nothing, in the database). */
  initial_profiles?: Array<{ role_id: string; scope_id: string }> | null
  /**
   * An existing HR employee (central identity) the administrator explicitly linked instead of creating a second account.
   * HQ only; re-verified here against the identity the email/phone resolve to and the HR eligibility rules.
   */
  linked_user_id?: string | null
  /**
   * Employee Self Service (the HQ lifecycle baseline). Omitted = the organization's default (HQ yes, others no);
   * false = excluded (non-employee HQ account); true is rejected for a non-HQ organization. Judged on the stored org type.
   */
  include_ess?: boolean | null
}, _callerInfo?: { id: string, role_code: string }) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: sessionAuthError } = await supabase.auth.getUser()
    if (sessionAuthError || !user) {
      return { success: false, error: 'Unauthorized' }
    }

    const callerUserId = user.id

    // Ordinary creation never takes a legacy role/level, from the form or from a crafted request.
    if (String(userData.role_code ?? '').trim() !== '' || ['legacy_role_code', 'role_level'].some(key => key in (userData as Record<string, unknown>))) {
      return { success: false, error: 'A legacy role or level cannot be set while creating a user. Assign access with Group Policies. Nothing was created.', code: 'LEGACY_ROLE_NOT_ALLOWED' }
    }

    const permissionCheck = await checkPermissionForUser(callerUserId, 'create_users')
    const roleLevel = permissionCheck.context?.role_level
    const hasRoleLevelCreateAccess = typeof roleLevel === 'number' && roleLevel <= 30
    // User administration is an S&A decision for the organization the new
    // user joins (a consumer without an organization: the admin's own).
    if (!(await userAllowed(callerUserId, 'platform.user.manage', () => permissionCheck.allowed || hasRoleLevelCreateAccess,
      { organizationId: (userData as any).organization_id ?? null }))) {
      // Say why (confirmed engine decision) without changing the outcome; an unavailable explanation keeps the plain denial.
      const why = await explainOperation(callerUserId, 'platform.user.manage', (userData as any).organization_id ?? null, () => permissionCheck.allowed || hasRoleLevelCreateAccess).catch(() => null)
      return { success: false, error: why && !why.allowed ? why.reason : 'Forbidden', code: 'FORBIDDEN' }
    }

    const adminClient = createAdminClient()
    if (!adminClient) {
      return {
        success: false,
        error: 'Admin client not available. Check service role key configuration.'
      }
    }

    // Validate every selection BEFORE any side effect (no login, profile or grant exists yet). Rules that need the
    // real organization and policy rows live here; the database re-checks authority, scope and separation of duties.
    const organizationId = userData.organization_id || null
    let groupedProfiles: Array<{ roleId: string; scopeIds: string[] }> | undefined
    if (userData.initial_profiles?.length) {
      const selection = await validateInitialSelections(adminClient, organizationId, userData.initial_profiles, { essExcluded: userData.include_ess === false })
      if (!selection.ok) return { success: false, error: selection.message, code: selection.code }
      // Same scope eligibility the picker offers, policy compatibility and the administrator's authority per scope — before anything is created.
      for (const group of selection.grouped) {
        const scopeCheck = await validateScopeGrant(adminClient, { actorId: callerUserId, roleId: group.roleId, organizationId: organizationId as string, scopeIds: group.scopeIds })
        if (!scopeCheck.ok) return { success: false, error: scopeCheck.message.replace('Nothing was changed.', 'Nothing was created.'), code: scopeCheck.code }
      }
      groupedProfiles = selection.grouped
    } else if (userData.initial_role_id && userData.initial_role_id !== 'self' && organizationId) {
      const ess = await essGrantAllowed(adminClient, userData.initial_role_id, organizationId)
      if (!ess.ok) return { success: false, error: `${ess.message} Nothing was created.`, code: 'ESS_HQ_ONLY' }
    }
    // Employee Self Service intent, from the organization's STORED type (never a submitted type), before any side effect.
    const { data: essOrg } = organizationId
      ? await adminClient.from('organizations').select('org_type_code').eq('id', organizationId).maybeSingle()
      : { data: null }
    const essIntent = resolveEssIntent({ organizationTypeCode: essOrg?.org_type_code ?? null, includeEss: userData.include_ess ?? null, linkedUserId: userData.linked_user_id ?? null })
    if (!essIntent.ok) return { success: false, error: essIntent.message, code: essIntent.code }
    if (userData.include_ess === false && organizationId) {
      // Excluding ESS revokes the automatic baseline: the same authority as any other revoke, checked before anything is created.
      const revokeAllowed = await explainOperation(callerUserId, 'security.role.assign', organizationId, () => legacyOrDelegatedSecurityAccess(callerUserId, organizationId, 'security.role.assign')).catch(() => null)
      if (!revokeAllowed?.allowed) return { success: false, error: 'You cannot exclude Employee Self Service in this organization. Nothing was created.', code: 'FORBIDDEN' }
    }
    {
      // Employment details and the HR employee link are HQ-only: judged on the organization's stored type, before anything is created.
      const carried = hqOnlyEmploymentFieldsPresent(userData as any)
      if (carried.length) {
        const { data: empOrg } = organizationId
          ? await adminClient.from('organizations').select('org_type_code').eq('id', organizationId).maybeSingle()
          : { data: null }
        const empError = employmentEligibilityError(userData as any, empOrg?.org_type_code)
        if (empError) return { success: false, error: `${empError} Nothing was created.`, code: 'EMPLOYMENT_HQ_ONLY' }
      }
    }
    if (Boolean(userData.can_be_reference)) {
      // Reference is HQ-only: judged on the organization's stored type, before anything is created.
      const { data: refOrg } = organizationId
        ? await adminClient.from('organizations').select('org_type_code').eq('id', organizationId).maybeSingle()
        : { data: null }
      const refError = referenceEligibilityError(true, refOrg?.org_type_code)
      if (refError) return { success: false, error: `${refError} Nothing was created.`, code: 'REFERENCE_HQ_ONLY' }
    }
    if (userData.linked_user_id) {
      // The employee link is HQ-only and must be an eligible employee of that organization (same checks as HR onboarding).
      if (!organizationId) return { success: false, error: 'Choose an HQ organization before linking an HR employee.', code: 'INVALID_INPUT' }
      const { data: orgRow } = await adminClient.from('organizations').select('org_type_code').eq('id', organizationId).maybeSingle()
      if (!essAllowedForOrgType(orgRow?.org_type_code)) {
        return { success: false, error: `${ESS_HQ_ONLY_MESSAGE} Employee linking is not available for this organization. Nothing was created.`, code: 'ESS_HQ_ONLY' }
      }
      const preview = await previewOnboardingCandidate(callerUserId, organizationId, userData.linked_user_id)
      if (!preview.ok) return { success: false, error: preview.message, code: preview.code }
      if (!preview.candidate.found || preview.candidate.user_id !== userData.linked_user_id || !preview.candidate.eligible) {
        return { success: false, error: 'The linked employee is not eligible any more. Review the employee link and try again. Nothing was created.', code: 'IDENTITY_LINK_MISMATCH' }
      }
    }

    // Canonical provisioning: resolve the identity from email/phone (never a
    // duplicate), then profile + organization membership + baseline access in
    // one database transaction. A role code above the baseline is access
    // administration and is authorized separately in the database.
    // No legacy role/level is requested: the database gives the no-authority GUEST classification (never the staff-level
    // USER baseline), and the organization alone decides the account scope. Access comes only from Group Policies.
    const provisioned = await provisionIdentity({
      actorId: callerUserId,
      email: userData.email,
      phone: userData.phone || null,
      fullName: userData.full_name,
      callName: userData.call_name ?? null,
      organizationId: userData.organization_id || null,
      accountScope: userData.organization_id ? 'portal' : 'store',
      noLegacyAccess: true,
      password: userData.password,
      hr: {
        departmentId: userData.department_id ?? null,
        managerUserId: userData.manager_user_id ?? null,
        positionId: userData.position_id ?? null,
        employmentType: userData.employment_type ?? null,
        joinDate: userData.join_date ?? null,
      },
      initialAccess: !userData.initial_profiles?.length && userData.initial_role_id && userData.initial_role_id !== 'self'
        ? { roleId: userData.initial_role_id }
        : undefined,
      initialProfiles: groupedProfiles?.map(g => ({ roleId: g.roleId, scopeIds: g.scopeIds })),
      // Never reuse an account silently: an existing person is either linked explicitly (HQ employee) or the request stops.
      requireNewIdentity: true,
      linkUserId: userData.linked_user_id || null,
      source: 'user_management',
    })
    if (!provisioned.ok) {
      return { success: false, error: provisioned.message, code: provisioned.code }
    }
    if (provisioned.outcome === 'REUSED') {
      // The person already has an identity in this organization: nothing is
      // duplicated and nothing about the existing identity is overwritten.
      revalidatePath('/dashboard')
      revalidatePath('/security-access')
      return {
        success: true,
        user_id: provisioned.userId,
        reused: true,
        linked: Boolean(userData.linked_user_id),
        message: userData.linked_user_id
          ? `Linked the existing HR employee; no duplicate account was created${groupedProfiles?.length ? ` and ${groupedProfiles.length} Group Policy ${groupedProfiles.length === 1 ? 'selection' : 'selections'} assigned` : ''}.`
          : `${userData.email} already has an account in this organization; the existing identity was kept.`,
      }
    }

    // Profile details that are not identity or access (compatibility fields).
    const profileUpdateData: Record<string, any> = {}
    if (userData.avatar_url !== undefined) profileUpdateData.avatar_url = userData.avatar_url || null
    if (userData.shop_name !== undefined) profileUpdateData.shop_name = userData.shop_name || null
    if (userData.address !== undefined) profileUpdateData.address = userData.address || null
    if (userData.referral_phone !== undefined) profileUpdateData.referral_phone = userData.referral_phone || null
    // Banking is no longer collected by identity onboarding (Add User wizard);
    // other callers may still pass it until the payee domain exists (Stage 2).
    if (userData.bank_id !== undefined) profileUpdateData.bank_id = userData.bank_id || null
    if (userData.bank_account_number !== undefined) profileUpdateData.bank_account_number = userData.bank_account_number || null
    if (userData.bank_account_holder_name !== undefined) profileUpdateData.bank_account_holder_name = userData.bank_account_holder_name || null
    if (userData.employment_status !== undefined && userData.employment_status && userData.employment_status !== 'active') {
      profileUpdateData.employment_status = userData.employment_status
    }
    if (userData.can_be_reference !== undefined) profileUpdateData.can_be_reference = Boolean(userData.can_be_reference)

    if (Object.keys(profileUpdateData).length > 0) {
      const { error: profileError } = await adminClient
        .from('users')
        .update(profileUpdateData)
        .eq('id', provisioned.userId)
      if (profileError) {
        console.error('Failed to set created user profile fields:', profileError.message)
        return {
          success: false,
          user_id: provisioned.userId,
          partial: true,
          error: `The account was created, but some profile details could not be saved: ${profileError.message}`,
        }
      }
    }

    if (userData.is_active === false) {
      const statusResult = await setIdentityAccountStatus(callerUserId, provisioned.userId, 'DISABLED', 'Created as inactive in User Management')
      if (!statusResult.ok) console.error('Failed to set created user inactive:', statusResult.message)
    } else if (userData.is_active === true) {
      // Explicit, not implied by a default: the Add User flow creates Active accounts.
      // Lifecycle only; this grants no Group Policy, legacy privilege or Employee Self Service.
      const statusResult = await setIdentityAccountStatus(callerUserId, provisioned.userId, 'ACTIVE', 'Created as active in User Management')
      if (!statusResult.ok) {
        console.error('Failed to set created user active:', statusResult.message)
        return { success: false, user_id: provisioned.userId, error: `The account was created, but it could not be activated: ${statusResult.message}` }
      }
    }

    // Employee Self Service: make the stored baseline match the intent and say so truthfully (never report it provisioned when it is not).
    {
      const essResult = await reconcileEssBaseline(adminClient, {
        actorId: callerUserId, userId: provisioned.userId, wanted: essIntent.wanted, hq: essAllowedForOrgType(essOrg?.org_type_code), verifyAssigned: userData.is_active !== false,
      })
      if (essResult.state === 'failed') {
        return { success: false, user_id: provisioned.userId, partial: true, error: `The account was created, but Employee Self Service is not as requested: ${essResult.message} Review it in Security & Access → People & Access.` }
      }
    }

    if (userData.organization_id) {
      try {
        const { data: orgRow } = await adminClient
          .from('organizations')
          .select('org_type_code')
          .eq('id', userData.organization_id)
          .maybeSingle()

        if (orgRow?.org_type_code === 'SHOP' || orgRow?.org_type_code === 'DIST') {
          await upsertUserProgramMembership(adminClient as any, 'cellera', provisioned.userId, 'organization_user', 'legacy_registration', {
            memberOrganizationId: userData.organization_id,
            createdBy: callerUserId,
          })
        }
      } catch (membershipError) {
        console.error('Failed to create Cellera membership for admin-created user:', membershipError)
      }
    }

    // Step 3: Return success (User Management and the Security & Access people views refetch)
    revalidatePath('/dashboard')
    revalidatePath('/security-access')
    return {
      success: true,
      user_id: provisioned.userId,
      message: `User ${userData.email} created successfully`
    }
  } catch (error) {
    console.error('Error creating user:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create user'
    }
  }
}

/**
 * Business roles an administrator may grant as initial access in the Add
 * User wizard. Empty unless the caller holds security.role.assign in the
 * organization (the database re-checks it, plus SoD, at provisioning).
 * Compatibility (legacy-*) roles and the employee baseline are never offered.
 */
/**
 * Business roles an administrator may grant while creating a user in this
 * organization, plus whether they may grant at all and whether legacy role
 * codes still grant access here (legacy_authorization.read_only = false).
 */
export async function listInitialAccessRoles(organizationId: string | null) {
  type InitialRole = { id: string; name: string; description: string | null }
  type Denial = { permission: string; code: string; reason: string; /** True when the administrator may not create users here at all. */ cannotCreate: boolean }
  /** Which stage could not answer: the authorization engine itself, or the catalogue / scope reads AFTER authorization succeeded. */
  type FailedStage = 'session' | 'settings' | 'engine' | 'catalogue' | 'scopes'
  const none = (success: boolean, legacyReadOnly = false, extra: { failed?: boolean; failedStage?: FailedStage; denial?: Denial } = {}) => ({ success, roles: [] as InitialRole[], canAssign: false, legacyReadOnly, ...extra })
  // The check could not be completed: never reported as a denial (the form offers Retry and assigns nothing unchecked).
  // Server log carries only the stage and the database error code/message (no identities, tokens or ids).
  const unavailable = (stage: FailedStage, detail?: { code?: string; message?: string } | null) => {
    console.error(`[add-user] assignment preflight failed at stage=${stage}${detail?.code ? ` code=${detail.code}` : ''}${detail?.message ? ` message=${String(detail.message).slice(0, 160)}` : ''}`)
    return none(false, false, { failed: true, failedStage: stage })
  }
  try {
    if (!organizationId) return none(true)
    const supabase = await createClient()
    const { data: { user }, error } = await supabase.auth.getUser()
    if (error || !user) return unavailable('session', error)
    const admin = createAdminClient() as any
    const { data: setting, error: settingError } = await admin.from('sa_settings').select('setting_value').eq('setting_key', 'legacy_authorization.read_only').maybeSingle()
    if (settingError && settingError.code !== 'PGRST205' && settingError.code !== '42P01') return unavailable('settings', settingError)
    const legacyReadOnly = setting?.setting_value === true
    // The same two decisions the creation takes (same engine, permission, target organization and legacy rule), explained.
    const permissionCheck = await checkPermissionForUser(user.id, 'create_users')
    const roleLevel = permissionCheck.context?.role_level
    const userManage = await explainOperation(user.id, 'platform.user.manage', organizationId, () => permissionCheck.allowed || (typeof roleLevel === 'number' && roleLevel <= 30))
    if (!userManage.allowed) return none(true, legacyReadOnly, { denial: { permission: 'platform.user.manage', code: userManage.code, reason: userManage.reason, cannotCreate: true } })
    const roleAssign = await explainOperation(user.id, 'security.role.assign', organizationId, () => legacyOrDelegatedSecurityAccess(user.id, organizationId, 'security.role.assign'))
    if (!roleAssign.allowed) return none(true, legacyReadOnly, { denial: { permission: 'security.role.assign', code: roleAssign.code, reason: roleAssign.reason, cannotCreate: false } })
    const { data, error: rolesError } = await admin.from('sa_business_roles')
      .select('id, name, description, role_key, source')
      .eq('status', 'active').neq('source', 'legacy').neq('role_key', 'employee-self-service')
      .order('name')
    if (rolesError) return unavailable('catalogue', rolesError)
    const roles = (data || []).map((r: any) => ({ id: r.id, name: r.name, description: r.description ?? null })) as InitialRole[]
    // Group Policy metadata (eligibility, sensitivity) and the scopes an administrator may choose
    // for this organization. Without the metadata nothing is offered (see the fail-closed check below).
    let profiles: any[] | undefined
    const deferredProfiles: Array<{ id: string; name: string }> = []
    // Policies not eligible for this organization type (recipient-eligibility.ts): never offered, listed with why so the
    // pickers can explain the gap and Edit User can mark existing grants that no longer qualify.
    const ineligibleProfiles: Array<{ id: string; name: string; code: string; message: string }> = []
    const sensitiveEntries: any[] = []
    let scopes: any[] = []
    let orgNames: Record<string, string> = {}
    let scopesFailure: { code?: string; message?: string } | null = null
    let catalogueFailure: { code?: string; message?: string } | null = null
    let organization: { name: string | null; typeCode: string | null } | null = null
    let eligibilityModel: EligibilityModel = 'org_type'
    try {
      const [{ data: org }, model] = await Promise.all([
        admin.from('organizations').select('org_name, org_type_code').eq('id', organizationId).maybeSingle(),
        loadEligibilityModel(admin),
      ])
      eligibilityModel = model
      organization = org ? { name: org.org_name ?? null, typeCode: org.org_type_code ?? null } : null
      const ids = (data || []).map((r: any) => r.id)
      const { data: extra, error: extraError } = await admin.from('sa_business_roles')
        .select('id, role_key, source, applicable_account_types, applicable_org_types, permissions:sa_business_role_permissions(permission:sa_permissions(permission_key))').in('id', ids)
      if (extraError) catalogueFailure = extraError
      if (!extraError && extra) {
        const byId = new Map<string, any>(extra.map((x: any) => [x.id, x]))
        profiles = []
        for (const r of roles) {
          const x = byId.get(r.id)
          const keys: string[] = (x?.permissions || []).map((p: any) => p?.permission?.permission_key).filter(Boolean)
          const sensitive = keys.some(isSensitivePermission)
          const accountTypes: string[] = x?.applicable_account_types || []
          const orgTypes: string[] = x?.applicable_org_types || []
          // Recipient eligibility, judged on the TARGET organization's stored type (the same rule as submission, People & Access
          // and the database guard). A policy is offered exactly as published, never trimmed.
          const eligibility = recipientEligibility({ roleKey: x?.role_key ?? null, source: x?.source ?? null, accountTypes, orgTypes, permissionKeys: keys }, organization?.typeCode, eligibilityModel)
          if (!eligibility.ok) { ineligibleProfiles.push({ id: r.id, name: r.name, code: eligibility.code, message: eligibility.message }); continue }
          const entry = { ...r, roleKey: x?.role_key ?? null, kind: x?.source === 'template' ? 'standard' : 'custom', permissionKeys: keys, permissionCount: keys.length, accountTypes, orgTypes, warehouseSupport: warehouseSupportFor(keys) }
          if (!sensitive) profiles.push(entry)
          else sensitiveEntries.push(entry)
        }
        // A sensitive (administrative / reset) policy is offered only where the database accepts it AND this administrator holds the same
        // authority Grant Policy requires (sa_actor_may_assign_profile). Before that migration is applied, or without the authority, it stays
        // a post-creation assignment in People & Access. A failed check never offers it.
        const allowedSensitive = await Promise.all(sensitiveEntries.map(async e => {
          const { data: may, error: mayError } = await admin.rpc('sa_actor_may_assign_profile', { p_actor: user.id, p_role: e.id, p_org: organizationId })
          return !mayError && may === true
        }))
        sensitiveEntries.forEach((e, i) => { if (allowedSensitive[i]) profiles!.push(e); else deferredProfiles.push({ id: e.id, name: e.name }) })
      }
      // The shared scope eligibility (scope-eligibility.ts): an HQ recipient is offered the HQ and its own warehouses only; the choices
      // are limited to organizations where this administrator holds the grant authority. Read-only; nothing is created here.
      try {
        const loaded = await loadScopeChoices(admin, organizationId, user.id)
        scopes = (loaded?.choices ?? []).map(c => ({ id: c.scopeId, organization_id: c.targetOrganizationId, scope_type: c.scopeType, display_name: c.name, kind: c.kind, label: c.label, coverage: c.coverage }))
        orgNames = loaded?.orgNames ?? {}
      } catch (scopeError) {
        // A failed read is a failed check, not an empty catalogue.
        scopesFailure = { message: scopeError instanceof Error ? scopeError.message : 'scope read failed' }
      }
    } catch (metadataError) {
      // Without the metadata no picker can be built (fail closed below).
      catalogueFailure = catalogueFailure ?? { message: metadataError instanceof Error ? metadataError.name : 'metadata exception' }
    }
    if (scopesFailure) return unavailable('scopes', scopesFailure)
    // Only policies the eligibility rule has seen are ever offered; never fall back to the unfiltered role list (fail closed).
    if (!profiles && (eligibilityModel === 'org_type' || isManufacturerOrgType(organization?.typeCode))) return unavailable('catalogue', catalogueFailure)
    // The Group Policies link in the empty state is offered only to someone who may open Security & Access (same rule as the page).
    const policiesAccess = await explainOperation(user.id, 'security.access.view', organizationId, () => legacyOrDelegatedSecurityAccess(user.id, organizationId, 'security.access.view')).catch(() => null)
    const canOpenGroupPolicies = Boolean(policiesAccess?.allowed)
    return { success: true, roles, canAssign: true, canOpenGroupPolicies, legacyReadOnly, ...(profiles ? { profiles: sortGroupPolicies(profiles, (p: any) => p.roleKey, (p: any) => p.name), deferredProfiles, ineligibleProfiles } : {}), eligibilityModel, scopes, orgNames, organization, essAllowed: essAllowedForOrgType(organization?.typeCode) }
  } catch (error) {
    if (error instanceof PreflightUnavailableError) return unavailable('engine')
    return unavailable('engine', { message: error instanceof Error ? error.name : 'exception' })
  }
}

export async function updateUserWithAuth(userId: string, userData: {
  full_name?: string
  call_name?: string | null
  role_code?: string
  organization_id?: string
  phone?: string
  signature_url?: string | null
  is_active?: boolean
  avatar_url?: string
  location?: string
  shop_name?: string
  address?: string
  referral_phone?: string
  bank_id?: string
  bank_account_number?: string
  bank_account_holder_name?: string
  department_id?: string | null
  manager_user_id?: string | null
  position_id?: string | null
  employment_type?: string | null
  join_date?: string | null
  employment_status?: string | null
  can_be_reference?: boolean
}, _callerInfo?: { id: string, role_code: string }) {
  try {
    const adminClient = createAdminClient()

    // Use server client to get current user from cookies
    const supabase = await createClient()

    // Check permissions: Current user must have edit_users OR updating themselves
    const { data: { user: currentUser }, error: authError } = await supabase.auth.getUser()

    if (!currentUser || authError) {
      return { success: false, error: 'Not authenticated. Please refresh the page and try again.' }
    }

    const isSelfUpdate = currentUser.id === userId
    const permissionCheck = await checkPermissionForUser(currentUser.id, 'edit_users')
    const roleLevel = permissionCheck.context?.role_level
    const hasRoleLevelEditAccess = typeof roleLevel === 'number' && roleLevel <= 30
    const isAuthorized = isSelfUpdate || await userAllowed(currentUser.id, 'platform.user.manage',
      () => permissionCheck.allowed || hasRoleLevelEditAccess, { organizationId: await targetUserOrganization(userId) })

    if (!isAuthorized) {
      return { success: false, error: 'Unauthorized' }
    }
    // A Root Administrator's account (login phone, status, role, organization, profile) is changed only by another Root
    // Administrator, never by a narrower administrator (account takeover / lock-out path).
    if (!isSelfUpdate) {
      const rootGuard = await rootTargetGuard(adminClient, currentUser.id, userId)
      if (!rootGuard.ok) {
        return { success: false, error: rootGuard.reason === 'root_target_protected' ? ROOT_TARGET_PROTECTED_MESSAGE : 'Access could not be verified. Please retry.' }
      }
    }

    const requestedUpdate = userData as Record<string, unknown>
    if (isSelfUpdate) {
      const disallowedFields = getDisallowedSelfServiceFields(requestedUpdate)
      if (disallowedFields.length > 0) {
        return {
          success: false,
          error: `Self-service cannot update protected fields: ${disallowedFields.join(', ')}`,
        }
      }
    }

    const authorizedUserData = (isSelfUpdate
      ? pickSelfServiceProfileFields(requestedUpdate)
      : pickAdminEditableUserFields(requestedUpdate)) as typeof userData

    // Reference is HQ-only. Judged on the organization the user will belong to after this update (stored type, not a
    // submitted one). Turning it off, or leaving an existing value untouched, is always allowed.
    if (!isSelfUpdate && authorizedUserData.can_be_reference === true) {
      let targetOrgId = authorizedUserData.organization_id !== undefined ? (authorizedUserData.organization_id || null) : undefined
      if (targetOrgId === undefined) {
        const { data: row } = await adminClient.from('users').select('organization_id').eq('id', userId).maybeSingle()
        targetOrgId = (row as any)?.organization_id ?? null
      }
      const { data: refOrg } = targetOrgId
        ? await adminClient.from('organizations').select('org_type_code').eq('id', targetOrgId).maybeSingle()
        : { data: null }
      const refError = referenceEligibilityError(true, refOrg?.org_type_code)
      if (refError) return { success: false, error: refError, code: 'REFERENCE_HQ_ONLY' }
    }

    // Enterprise access fields and the account lifecycle are not profile data:
    // they change only through the identity functions, which re-authorize in
    // the database (platform.identity_access.manage / platform.identity.disable,
    // no role above the actor's own level, source AND destination organization).
    let organizationChanged = false
    if (!isSelfUpdate && (authorizedUserData.role_code !== undefined
      || authorizedUserData.organization_id !== undefined
      || authorizedUserData.is_active !== undefined)) {
      const { data: current, error: currentError } = await adminClient
        .from('users')
        .select('role_code, organization_id, is_active')
        .eq('id', userId)
        .maybeSingle()
      if (currentError || !current) {
        return { success: false, error: 'User not found' }
      }

      const nextRoleCode = authorizedUserData.role_code !== undefined && authorizedUserData.role_code !== ''
        ? authorizedUserData.role_code
        : current.role_code
      const nextOrganizationId = authorizedUserData.organization_id !== undefined
        ? (authorizedUserData.organization_id || null)
        : current.organization_id
      const roleChanged = nextRoleCode !== current.role_code
      organizationChanged = nextOrganizationId !== current.organization_id

      if (roleChanged || organizationChanged) {
        const accessAllowed = await userAllowed(currentUser.id, 'platform.identity_access.manage',
          () => typeof roleLevel === 'number' && roleLevel <= 10,
          { organizationId: current.organization_id ?? await targetUserOrganization(currentUser.id) })
        if (!accessAllowed) {
          return { success: false, error: 'Changing a user\'s role or organization requires access-administration rights.' }
        }
        const accessResult = await updateIdentityAccess(currentUser.id, userId, {
          roleCode: roleChanged ? nextRoleCode : null,
          organizationId: nextOrganizationId,
          changeOrganization: organizationChanged,
        }, 'User Management edit')
        if (!accessResult.ok) return { success: false, error: accessResult.message }
      }

      if (authorizedUserData.is_active !== undefined && Boolean(authorizedUserData.is_active) !== Boolean(current.is_active)) {
        const statusAllowed = await userAllowed(currentUser.id, 'platform.identity.disable',
          () => permissionCheck.allowed || hasRoleLevelEditAccess,
          { organizationId: current.organization_id ?? await targetUserOrganization(currentUser.id) })
        if (!statusAllowed) return { success: false, error: 'Unauthorized' }
        const statusResult = await setIdentityAccountStatus(currentUser.id, userId,
          authorizedUserData.is_active ? 'ACTIVE' : 'DISABLED', 'User Management edit')
        if (!statusResult.ok) return { success: false, error: statusResult.message }
      }

      delete (authorizedUserData as any).role_code
      delete (authorizedUserData as any).organization_id
      delete (authorizedUserData as any).is_active
    }

    // Update Auth User metadata (full_name/display_name) - sync to Supabase Auth user_metadata
    if (authorizedUserData.full_name !== undefined) {
      try {
        const { error: authMetaError } = await adminClient.auth.admin.updateUserById(userId, {
          user_metadata: { full_name: authorizedUserData.full_name }
        })

        if (authMetaError) {
          console.error('Auth user_metadata update failed:', authMetaError.message)
          // Don't fail the whole operation for metadata sync failure
          console.warn('Continuing despite metadata sync failure...')
        } else {
          console.log('✅ Auth user_metadata.full_name synced to:', authorizedUserData.full_name)
        }
      } catch (metaErr) {
        console.error('Auth metadata update exception:', metaErr)
        // Don't fail the whole operation for metadata sync failure
      }
    }

    // Update Auth User (Phone) - handle both setting and clearing phone
    // We make this BLOCKING to ensure consistency between Auth and Database
    if (authorizedUserData.phone !== undefined) {
      try {
        if (authorizedUserData.phone && authorizedUserData.phone.trim()) {
          // Setting/updating phone number
          const phone = normalizePhone(authorizedUserData.phone) // Returns E.164 with + prefix

          const { data: authData, error: authError } = await adminClient.auth.admin.updateUserById(userId, {
            phone: phone,
            phone_confirm: true
          })

          if (authError) {
            console.error('Auth phone update failed:', authError.message)
            return { success: false, error: `Failed to update phone in Auth: ${authError.message}` }
          }

          // Verify the update actually happened
          if (authData?.user?.phone !== phone) {
            console.warn(`Auth phone mismatch after update. Expected: ${phone}, Got: ${authData?.user?.phone}`)

            // Check if digits match (ignoring formatting differences)
            const expectedDigits = phone.replace(/\D/g, '')
            const gotDigits = (authData?.user?.phone || '').replace(/\D/g, '')

            if (expectedDigits !== gotDigits) {
              console.error('Auth phone update failed silently (digits mismatch)')
              return { success: false, error: 'Failed to update phone in Auth (Silent Failure). Please try again.' }
            }
          }

          console.log('✅ Auth phone updated to:', phone)
        } else {
          // Clearing/removing phone number - set to empty string or null
          const { error: authError } = await adminClient.auth.admin.updateUserById(userId, {
            phone: '',
            phone_confirm: false
          })

          if (authError) {
            console.error('Auth phone clear failed:', authError.message)
            return { success: false, error: `Failed to clear phone in Auth: ${authError.message}` }
          } else {
            console.log('✅ Auth phone cleared')
          }
        }
      } catch (authErr) {
        console.error('Auth phone update exception:', authErr)
        return { success: false, error: `Auth phone update exception: ${authErr}` }
      }
    }

    // Update Public User - prepare data for database update
    // Phone is normalized to E.164 format with + prefix for consistency, or null if cleared
    const updateData: any = { ...authorizedUserData }
    if (updateData.call_name !== undefined) {
      updateData.call_name = updateData.call_name || null
    }
    if (updateData.phone && updateData.phone.trim()) {
      updateData.phone = normalizePhone(updateData.phone)
      // An edited number is not a verified number (the database clears
      // phone_verified_at on change); verification is an OTP flow.
    } else if (updateData.phone !== undefined) {
      updateData.phone = null // Explicitly set to null when cleared
      updateData.phone_verified_at = null
    }


    if (updateData.department_id || updateData.manager_user_id || updateData.position_id) {
      const { data: targetUser, error: targetError } = await adminClient
        .from('users')
        .select('id, organization_id')
        .eq('id', userId)
        .single()

      if (targetError || !targetUser) {
        return { success: false, error: 'User not found' }
      }

      const targetOrgId = targetUser.organization_id

      if (updateData.department_id) {
        const { data: dept } = await adminClient
          .from('departments')
          .select('id, organization_id')
          .eq('id', updateData.department_id)
          .single()

        if (!dept || dept.organization_id !== targetOrgId) {
          return { success: false, error: 'Invalid department for this organization' }
        }
      }

      if (updateData.manager_user_id) {
        const { data: manager } = await adminClient
          .from('users')
          .select('id, organization_id')
          .eq('id', updateData.manager_user_id)
          .single()

        if (!manager || manager.organization_id !== targetOrgId) {
          return { success: false, error: 'Invalid manager for this organization' }
        }
      }

      if (updateData.position_id) {
        const { data: position } = await adminClient
          .from('hr_positions')
          .select('id, organization_id')
          .eq('id', updateData.position_id)
          .single()

        if (!position || position.organization_id !== targetOrgId) {
          return { success: false, error: 'Invalid position for this organization' }
        }
      }
    }

    if (organizationChanged || updateData.organization_id !== undefined || updateData.referral_phone !== undefined) {
      const { data: existingUser, error: existingUserError } = await adminClient
        .from('users')
        .select(`
          organization_id,
          referral_phone,
          role_code,
          account_scope,
          roles(role_level),
          organizations!fk_users_organization(org_type_code)
        `)
        .eq('id', userId)
        .single()

      if (existingUserError) {
        return { success: false, error: 'Failed to resolve current user profile for confirmation logic' }
      }

      const nextOrganizationId = updateData.organization_id !== undefined
        ? updateData.organization_id
        : existingUser?.organization_id || null
      const nextReferralPhone = updateData.referral_phone !== undefined
        ? updateData.referral_phone
        : existingUser?.referral_phone || null

      let nextOrganizationTypeCode = (existingUser?.organizations as any)?.org_type_code || null

      if (nextOrganizationId && nextOrganizationId !== existingUser?.organization_id) {
        const { data: organizationData, error: organizationError } = await adminClient
          .from('organizations')
          .select('org_type_code')
          .eq('id', nextOrganizationId)
          .maybeSingle()

        if (organizationError) {
          return { success: false, error: 'Failed to resolve selected organization for confirmation logic' }
        }

        nextOrganizationTypeCode = organizationData?.org_type_code || null

        // Prevent accidental HQ Admin → Shop move when saving own profile.
        // Intentional User Management transfers (edit_users by another admin) remain allowed.
        if (isSelfUpdate && nextOrganizationTypeCode === 'SHOP') {
          const { getShopOrgReassignmentBlockReason } = await import('@/lib/auth/employment-org-guard')
          const blockReason = getShopOrgReassignmentBlockReason({
            currentOrgTypeCode: (existingUser?.organizations as any)?.org_type_code || null,
            currentRoleCode: existingUser?.role_code,
            currentRoleLevel: (existingUser?.roles as any)?.role_level ?? null,
            currentAccountScope: existingUser?.account_scope,
            nextOrgTypeCode: 'SHOP',
          })
          if (blockReason) {
            return { success: false, error: blockReason }
          }
        }
      } else if (!nextOrganizationId) {
        nextOrganizationTypeCode = null
      }

      if (hasLinkedShopProfile({
        organization_id: nextOrganizationId,
        organizationTypeCode: nextOrganizationTypeCode,
        referral_phone: nextReferralPhone,
      })) {
        updateData.consumer_claim_confirmed_at = null
      }
    }

    // Use adminClient to ensure update happens even if RLS is tricky (though RLS should allow self update)
    const { error: dbError } = await adminClient
      .from('users')
      .update(updateData)
      .eq('id', userId)

    if (dbError) {
      console.error('Database update error:', dbError)
      return { success: false, error: `Failed to update database user: ${dbError.message}` }
    }

    revalidatePath('/dashboard')
    return { success: true }

  } catch (error) {
    console.error('Error updating user:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function login(formData: FormData) {
  const supabase = await createClient()

  // type-casting here for convenience
  // in practice, you should validate your inputs
  const data = {
    email: formData.get('email') as string,
    password: formData.get('password') as string,
  }

  const { data: authData, error } = await supabase.auth.signInWithPassword(data)

  if (error) {
    redirect('/error')
  }

  // Update last_login_at and capture IP immediately after successful login
  if (authData?.user?.id) {
    try {
      // Capture client IP address from headers
      let clientIp: string | null = null

      // Note: In server actions, we can't directly access request headers
      // The IP will be captured via middleware or we'll use a client-side approach
      // For now, we'll set a placeholder and update it via a client-side call
      // after successful login

      await supabase
        .from('users')
        .update({
          last_login_at: new Date().toISOString(),
          last_login_ip: clientIp // Will be updated by client-side IP capture
        })
        .eq('id', authData.user.id)
    } catch (loginError) {
      console.error('Failed to update last_login_at:', loginError)
      // Don't fail the login if this fails
    }
  }

  revalidatePath('/', 'layout')
  redirect('/dashboard')
}

export async function signup(formData: FormData) {
  const supabase = await createClient()

  // type-casting here for convenience
  // in practice, you should validate your inputs
  const data = {
    email: formData.get('email') as string,
    password: formData.get('password') as string,
  }

  const { error } = await supabase.auth.signUp(data)

  if (error) {
    redirect('/error')
  }

  revalidatePath('/', 'layout')
  redirect('/dashboard')
}

/**
 * Account lifecycle change (activate / suspend / disable) by an authorized
 * administrator. Replaces direct browser writes to users.is_active, which the
 * database now rejects for API roles.
 */
export async function setUserAccountStatus(userId: string, status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED', reason: string) {
  try {
    const supabase = await createClient()
    const { data: { user }, error } = await supabase.auth.getUser()
    if (error || !user) return { success: false, error: 'Unauthorized' }
    if (user.id === userId) return { success: false, error: 'You cannot change the status of your own account.' }
    // Server actions accept any runtime argument: archiving is Archive
    // Identities (the User Management delete flow), never this lifecycle path.
    if (!['ACTIVE', 'SUSPENDED', 'DISABLED'].includes(status)) return { success: false, error: 'Invalid account status' }

    const permissionCheck = await checkPermissionForUser(user.id, 'edit_users')
    const roleLevel = permissionCheck.context?.role_level
    const legacyAllowed = () => permissionCheck.allowed || (typeof roleLevel === 'number' && roleLevel <= 30)
    if (!(await userAllowed(user.id, 'platform.identity.disable', legacyAllowed, { organizationId: await targetUserOrganization(userId) }))) {
      return { success: false, error: 'Forbidden' }
    }
    // Suspending or disabling an account ends its Root Access in effect: only another Root Administrator may change a
    // Root account (identity_set_account_status enforces the same rule and protects the last Root Administrator).
    const rootGuard = await rootTargetGuard(createAdminClient(), user.id, userId)
    if (!rootGuard.ok) {
      return { success: false, error: rootGuard.reason === 'root_target_protected' ? ROOT_TARGET_PROTECTED_MESSAGE : 'Authorization service unavailable' }
    }
    const result = await setIdentityAccountStatus(user.id, userId, status, reason)
    if (!result.ok) return { success: false, error: result.message }
    revalidatePath('/dashboard')
    return { success: true, status: result.status }
  } catch (error) {
    console.error('Error changing account status:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function deleteUserWithAuth(userId: string, _callerInfo?: { id: string, role_code: string }) {
  try {
    const adminClient = createAdminClient()

    if (!adminClient) {
      return {
        success: false,
        error: 'Admin client not available. Check service role key configuration.'
      }
    }

    const supabase = await createClient()

    // Verify caller has permission to delete users
    let isAuthorized = false

    // Try to get current user from session first
    const { data: { user: currentUser }, error: sessionAuthError } = await supabase.auth.getUser()

    if (currentUser && !sessionAuthError) {
      const permissionCheck = await checkPermissionForUser(currentUser.id, 'delete_users')
      isAuthorized = await userAllowed(currentUser.id, 'platform.user.manage', () => permissionCheck.allowed,
        { organizationId: await targetUserOrganization(userId) })
    }

    if (!isAuthorized) {
      return {
        success: false,
        error: 'Unauthorized: Only administrators can delete users'
      }
    }

    // Removing an identity is Archive Identities (platform.identity.delete)
    // for the target's organization, with self and target protection — the
    // same decision as the User Management delete flow. Managing users alone
    // does not authorize it.
    const removal = await authorizeIdentityRemoval(currentUser!.id, userId)
    if (!removal.ok) {
      return { success: false, error: removal.status === 403 ? 'Unauthorized: Only administrators can delete users' : removal.error }
    }

    // Business or audit history must survive account removal: such an
    // identity is archived (account lifecycle), never hard-deleted. Checked
    // before any cleanup so nothing is removed on refusal; the database
    // (users_history_delete_guard) enforces the same rule.
    const historyReferences = await identityHistoryReferences(userId)
    if (historyReferences === null) {
      return { success: false, error: 'Unable to verify this user\'s history; nothing was deleted.' }
    }
    if (historyReferences.length > 0) {
      return {
        success: false,
        code: 'IDENTITY_HAS_HISTORY',
        error: 'This user is referenced by business or audit history and cannot be deleted. Deactivate or archive the account instead.',
      }
    }

    // First, get user's email and phone for consumer_activations lookup
    const { data: targetUser } = await adminClient
      .from('users')
      .select('email, phone')
      .eq('id', userId)
      .single()

    // Step 1: Delete audit_logs first to avoid foreign key constraint
    // Use admin client to bypass RLS policies
    const { error: auditError } = await adminClient
      .from('audit_logs')
      .delete()
      .eq('user_id', userId)

    if (auditError) {
      console.error('Failed to delete audit logs:', auditError)
      // Don't fail on audit log deletion - continue with user deletion
    }

    // Step 2: Delete points_transactions for this user
    const { error: pointsError } = await adminClient
      .from('points_transactions')
      .delete()
      .eq('user_id', userId)

    if (pointsError) {
      console.error('Failed to delete points_transactions:', pointsError)
      // Continue anyway
    }

    // Step 3: Delete consumer_activations for this user by email or phone
    if (targetUser?.email) {
      const { error: activationsEmailError } = await adminClient
        .from('consumer_activations')
        .delete()
        .eq('consumer_email', targetUser.email)

      if (activationsEmailError) {
        console.error('Failed to delete consumer_activations by email:', activationsEmailError)
      }
    }

    if (targetUser?.phone) {
      const { error: activationsPhoneError } = await adminClient
        .from('consumer_activations')
        .delete()
        .eq('consumer_phone', targetUser.phone)

      if (activationsPhoneError) {
        console.error('Failed to delete consumer_activations by phone:', activationsPhoneError)
      }
    }

    // Step 4: Set null on consumer_qr_scans for this user (FK has SET NULL rule)
    const { error: scansError } = await adminClient
      .from('consumer_qr_scans')
      .update({ consumer_id: null })
      .eq('consumer_id', userId)

    if (scansError) {
      console.error('Failed to nullify consumer_qr_scans:', scansError)
    }

    const transferOperations = [
      { table: 'documents', column: 'created_by', value: currentUser?.id, label: 'documents.created_by' },
      { table: 'documents', column: 'acknowledged_by', value: null, label: 'documents.acknowledged_by' },
      { table: 'document_files', column: 'uploaded_by', value: currentUser?.id, label: 'document_files.uploaded_by' },
      { table: 'orders', column: 'created_by', value: currentUser?.id, label: 'orders.created_by' },
      { table: 'orders', column: 'approved_by', value: null, label: 'orders.approved_by' },
      { table: 'orders', column: 'updated_by', value: null, label: 'orders.updated_by' },
    ]

    for (const operation of transferOperations) {
      if (operation.value === undefined) continue

      const { error } = await adminClient
        .from(operation.table)
        .update({ [operation.column]: operation.value })
        .eq(operation.column, userId)

      if (error) {
        console.error(`Failed to transfer ${operation.label}:`, error)
      }
    }

    // Step 5: Delete user from public.users table using admin client to bypass RLS
    const { error: dbError } = await adminClient
      .from('users')
      .delete()
      .eq('id', userId)

    if (dbError) {
      console.error('Database delete error:', dbError)
      return {
        success: false,
        error: `Failed to delete user from database: ${dbError.message}`
      }
    }

    // Step 6: Delete user from Supabase Auth
    const { error: authError } = await adminClient.auth.admin.deleteUser(userId)

    if (authError) {
      console.error('Failed to delete auth user (but database user deleted):', authError)
      // We still return success since the main user record is deleted
      // The auth record will be orphaned but won't cause issues
      return {
        success: true,
        warning: 'User deleted from database but auth deletion failed',
        message: 'User deleted successfully'
      }
    }

    // Step 7: Return success
    revalidatePath('/dashboard')
    return {
      success: true,
      message: 'User deleted successfully from both database and auth'
    }
  } catch (error) {
    console.error('Error deleting user:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete user'
    }
  }
}

/**
 * Identity resolution for self-service consumer registration. Returns a
 * user-facing refusal, or null when a new identity may be created.
 */
async function resolveConsumerRegistrationIdentity(adminClient: any, email: string, phone: string | undefined): Promise<string | null> {
  const { data, error } = await adminClient.rpc('identity_resolve', { p_email: email, p_phone: phone ?? null })
  if (error) return 'Registration is temporarily unavailable. Please try again.'
  const outcome = data?.outcome
  if (outcome === 'NO_MATCH') return null
  if (outcome === 'INVALID_INPUT') return 'Please check your email address and mobile number.'
  if (outcome === 'MATCH' && data?.matched_by !== 'phone') return 'An account with this email already exists. Please sign in instead.'
  if (outcome === 'MATCH') return 'This mobile number is already registered. Please sign in with it instead.'
  if (outcome === 'IDENTITY_ARCHIVED') return 'This account is no longer active. Please contact support.'
  // Conflict / ambiguous / unverified-phone match: the phone belongs to someone else.
  await adminClient.rpc('identity_record_conflict', {
    p_code: outcome, p_resolution: data, p_email: email, p_phone: phone ?? null,
    p_source: 'consumer_signup', p_actor: null, p_details: { stage: 'resolve' },
  })
  return 'This mobile number is already registered to another account. Please sign in, or contact support.'
}

export async function registerConsumer(userData: {
  email: string
  password: string
  full_name: string
  phone?: string
  location?: string
  reference_user_id?: string
  referral_phone?: string
  address?: string
  organization_id?: string
  shop_name?: string
  registration_org_id?: string
  verification_token?: string
}) {
  try {
    const adminClient = createAdminClient()
    if (!adminClient) {
      return {
        success: false,
        error: 'System configuration error'
      }
    }

    const phone = userData.phone ? normalizePhone(userData.phone) : undefined
    const normalizedEmail = userData.email.trim().toLowerCase()

    if (!userData.password || userData.password.length < 6) {
      return {
        success: false,
        error: SIGNUP_PASSWORD_MIN_LENGTH_MESSAGE,
      }
    }

    if (!phone) {
      return {
        success: false,
        error: 'A verified mobile number is required for registration.'
      }
    }

    if (!userData.verification_token) {
      return {
        success: false,
        error: 'Email verification is required before registration can be completed.'
      }
    }

    const verificationCode = await findCodeByVerificationToken(adminClient, userData.verification_token)
    if (!verificationCode) {
      return {
        success: false,
        error: 'Your email verification session has expired. Please request a new verification code.'
      }
    }

    const verifiedEmail = String((verificationCode.meta as any)?.email || '').trim().toLowerCase()
    const phoneE164 = normalizePhoneE164(userData.phone || '')
    if (verificationCode.phone_normalized !== phoneE164 || verifiedEmail !== normalizedEmail) {
      return {
        success: false,
        error: 'The verified details do not match the current registration form. Please verify again.'
      }
    }

    const verifiedMeta = (verificationCode.meta as any) || {}
    const verifiedReferenceUserId = String(verifiedMeta.reference_user_id || '').trim()
    const verifiedReferralPhone = String(verifiedMeta.referral_phone || '').trim()
    const verifiedOrganizationId = String(verifiedMeta.shop_organization_id || '').trim()
    const verifiedShopName = String(verifiedMeta.shop_name || '').trim()
    const verifiedPendingShopRequest = sanitizeRegistrationPendingShopRequest(verifiedMeta.pending_shop_request)
    const verifiedRoadtourContext = sanitizeRoadtourRegistrationContext(verifiedMeta.roadtour_context)

    if (verifiedReferenceUserId && userData.reference_user_id?.trim() && userData.reference_user_id.trim() !== verifiedReferenceUserId) {
      return {
        success: false,
        error: 'Your selected reference changed after verification. Please request a new verification code and try again.'
      }
    }

    if (verifiedOrganizationId && userData.organization_id?.trim() && userData.organization_id.trim() !== verifiedOrganizationId) {
      return {
        success: false,
        error: 'Your selected shop changed after verification. Please request a new verification code and try again.'
      }
    }

    if (verifiedPendingShopRequest) {
      if (userData.organization_id?.trim()) {
        return {
          success: false,
          error: 'Your selected shop changed after verification. Please request a new verification code and try again.'
        }
      }

      if (userData.shop_name?.trim() && !matchesRegistrationPendingShopSelection(userData.shop_name, verifiedPendingShopRequest)) {
        return {
          success: false,
          error: 'Your selected shop changed after verification. Please request a new verification code and try again.'
        }
      }
    }

    if (verifiedReferralPhone && userData.referral_phone?.trim() && !samePhone(userData.referral_phone, verifiedReferralPhone)) {
      return {
        success: false,
        error: 'Your selected reference changed after verification. Please request a new verification code and try again.'
      }
    }

    const linkSelection = await resolveRegistrationLinkSelection(adminClient, {
      organizationId: verifiedOrganizationId || userData.organization_id,
      shopName: verifiedShopName || userData.shop_name,
      referenceUserId: verifiedReferenceUserId || userData.reference_user_id,
      referralPhone: verifiedReferralPhone || userData.referral_phone,
      pendingShopRequest: verifiedPendingShopRequest,
    })

    if (!linkSelection.ok) {
      return {
        success: false,
        error: 'Your selected reference and shop must be verified again. Please request a new verification code and try again.'
      }
    }

    let finalOrganizationId = linkSelection.organizationId
    let finalShopDisplayName = linkSelection.shopDisplayName

    // Legacy pending-shop registration carries no "different outlet" confirmation, so
    // strong duplicates AND shared-contact/address candidates stop registration here,
    // before the auth user is created. createShopOrganization re-runs the same guard.
    const pendingShopIdentityConfirmations: ShopIdentityConfirmations = {
      confirmDifferentOutlet: false,
      confirmSimilarName: true,
    }
    if (!finalOrganizationId && linkSelection.pendingShopRequest) {
      try {
        await assertShopCreationAllowed(adminClient, linkSelection.pendingShopRequest, pendingShopIdentityConfirmations)
      } catch (guardError) {
        if (isShopIdentityConflictError(guardError)) {
          return {
            success: false,
            error: guardError.decision.body.code === 'SHOP_DUPLICATE_BLOCKED'
              ? guardError.message
              : 'We found existing shops using the same phone, email or address. Please select your shop from the list, or use Create New Shop to confirm it is a different outlet.',
          }
        }
        throw guardError
      }
    }

    // One human = one central identity: resolve before creating a login. An
    // existing person signs in instead; a phone that already belongs to
    // another person is never attached to a second identity (recorded for
    // review, never merged).
    const identityCheck = await resolveConsumerRegistrationIdentity(adminClient, normalizedEmail, phone)
    if (identityCheck) return { success: false, error: identityCheck }

    // Create user with auto-confirm to bypass rate limits and verification
    const { data: authUser, error: authError } = await adminClient.auth.admin.createUser({
      email: normalizedEmail,
      password: userData.password,
      email_confirm: true,
      phone: phone,
      phone_confirm: !!phone,
      user_metadata: {
        full_name: userData.full_name,
        phone: phone, // Ensure phone is in metadata for the trigger
        location: userData.location
      }
    })

    if (authError) {
      return {
        success: false,
        error: authError.message
      }
    }

    if (!authUser?.user) {
      return {
        success: false,
        error: 'User creation failed'
      }
    }

    if (!finalOrganizationId && linkSelection.pendingShopRequest) {
      try {
        const { organization } = await createShopOrganization(adminClient, {
          form: linkSelection.pendingShopRequest,
          createdBy: authUser.user.id,
          identityConfirmations: pendingShopIdentityConfirmations,
        })

        finalOrganizationId = organization.id
        finalShopDisplayName = getRegistrationPendingShopDisplayName(linkSelection.pendingShopRequest)
      } catch (shopCreateError) {
        try {
          await adminClient.auth.admin.deleteUser(authUser.user.id)
        } catch (deleteError) {
          console.error('Failed to rollback auth user after shop creation error:', deleteError)
        }

        return {
          success: false,
          error: shopCreateError instanceof Error ? shopCreateError.message : 'Failed to create shop during registration.',
        }
      }
    }

    // Explicitly sync user profile to ensure it exists before login
    const { error: syncError } = await adminClient
      .rpc('sync_user_profile', {
        p_user_id: authUser.user.id,
        p_email: normalizedEmail,
        p_full_name: userData.full_name,
        p_phone: phone,
        p_role_code: 'GUEST' // Default role for consumer registrations
      })

    if (syncError) {
      console.warn('Manual sync_user_profile failed, relying on trigger:', syncError)
      // Don't fail the registration, as the trigger might still work
    }

    const profileUpdates: Record<string, any> = {}
    if (userData.location) profileUpdates.location = userData.location
    profileUpdates.reference_user_id = linkSelection.referenceUserId
    profileUpdates.referral_phone = linkSelection.referralPhone
    if (userData.address) profileUpdates.address = userData.address
    profileUpdates.organization_id = finalOrganizationId
    profileUpdates.shop_name = finalShopDisplayName

    if (Object.keys(profileUpdates).length > 0) {
      const { error: profileError } = await adminClient
        .from('users')
        .update(profileUpdates)
        .eq('id', authUser.user.id)

      if (profileError) {
        console.warn('Registration profile enrichment failed:', profileError)
      }
    }

    try {
      let programCode: LoyaltyProgramCode = 'cellera'
      let enrollmentSource: 'legacy_registration' | 'roadtour' = 'legacy_registration'
      let firstRoadtourRunId: string | null = null
      let firstCampaignId: string | null = null
      let ownerOrganizationId: string | null = userData.registration_org_id || null

      if (verifiedRoadtourContext?.token) {
        const roadtour = await resolveRoadtourByToken(verifiedRoadtourContext.token)
        const experience = getRoadtourExperienceForCategory(roadtour?.product_category)
        programCode = experience?.key === 'pet_food' ? 'ellbow' : 'cellera'
        enrollmentSource = 'roadtour'
        firstRoadtourRunId = (roadtour as any)?.roadtour_run_id || null
        firstCampaignId = verifiedRoadtourContext.campaign_id || (roadtour as any)?.campaign_id || null
        ownerOrganizationId = verifiedRoadtourContext.org_id || ownerOrganizationId
      }

      const participantType: LoyaltyParticipantType = finalOrganizationId ? 'shop_staff' : 'consumer'
      await upsertProgramMembershipsForUserAndOrganization({
        admin: adminClient as any,
        programCode,
        userId: authUser.user.id,
        memberOrganizationId: finalOrganizationId,
        participantType,
        enrollmentSource,
        context: {
          ownerOrganizationId,
          firstRoadtourRunId,
          firstCampaignId,
          createdBy: authUser.user.id,
        },
      })
    } catch (membershipError) {
      console.error('Registration loyalty membership upsert failed:', membershipError)
    }

    let bonusAwarded = false
    let bonusPoints = 0
    let bonusMode: string | null = null

    if (userData.registration_org_id) {
      try {
        const { data: settings } = await (adminClient as any)
          .from('user_registration_bonus_settings')
          .select('*')
          .eq('org_id', userData.registration_org_id)
          .eq('enabled', true)
          .maybeSingle()

        if (settings) {
          bonusPoints = settings.bonus_points || 0
          bonusMode = settings.bonus_mode || null

          const bonusRow = {
            org_id: userData.registration_org_id,
            user_id: authUser.user.id,
            settings_id: settings.id,
            status: settings.bonus_mode === 'instant' ? 'awarded' : 'pending',
            bonus_mode: settings.bonus_mode,
            bonus_points: settings.bonus_points,
            min_valid_scans_per_month: settings.min_valid_scans_per_month,
            required_consecutive_months: settings.required_consecutive_months,
            only_unique_qr_scans: settings.only_unique_qr_scans,
            allow_grace_month: settings.allow_grace_month,
            bonus_expiry_days: settings.bonus_expiry_days,
            max_bonus_claims_per_user: settings.max_bonus_claims_per_user,
            registration_source: 'premium_loyalty',
            registered_at: new Date().toISOString(),
            qualified_at: settings.bonus_mode === 'instant' ? new Date().toISOString() : null,
            awarded_at: settings.bonus_mode === 'instant' ? new Date().toISOString() : null,
          }

          let awardedTransactionId: string | null = null

          if (settings.bonus_mode === 'instant') {
            const { data: balanceData } = await (adminClient as any)
              .from('v_consumer_points_balance')
              .select('current_balance')
              .eq('user_id', authUser.user.id)
              .maybeSingle()

            const currentBalance = Number(balanceData?.current_balance || 0)
            const { data: txnData, error: txnError } = await (adminClient as any)
              .from('points_transactions')
              .insert({
                company_id: userData.registration_org_id,
                consumer_phone: phone,
                consumer_email: normalizedEmail,
                transaction_type: 'adjust',
                points_amount: settings.bonus_points,
                balance_after: currentBalance + settings.bonus_points,
                description: 'Welcome bonus credited upon successful registration.',
                transaction_date: new Date().toISOString(),
                user_id: authUser.user.id,
                created_by: authUser.user.id,
                // Taxonomy dual-write (Phase 1)
                point_category: 'registration',
                point_indicator: 'welcome_bonus',
                point_owner_type: 'consumer',
                point_direction: 'earn',
              })
              .select('id')
              .single()

            if (txnError) {
              console.warn('Failed to award instant registration bonus:', txnError)
            } else {
              awardedTransactionId = txnData?.id || null
              bonusAwarded = true
            }
          }

          await (adminClient as any)
            .from('user_registration_bonus_progress')
            .upsert({
              ...bonusRow,
              awarded_transaction_id: awardedTransactionId,
            }, { onConflict: 'org_id,user_id' })
        }
      } catch (bonusError) {
        console.warn('Registration bonus setup unavailable or failed:', bonusError)
      }
    }

    await markRegistrationCodeUsed(adminClient, verificationCode.id, authUser.user.id)
    await logRegistrationNotificationEvent(adminClient, {
      eventType: 'registration_completed',
      phone,
      userId: authUser.user.id,
      status: 'completed',
      meta: {
        email: normalizedEmail,
        org_id: userData.registration_org_id || null,
        reference_user_id: linkSelection.referenceUserId,
        shop_organization_id: finalOrganizationId,
        registration_source: verifiedRoadtourContext ? 'roadtour' : 'premium_loyalty',
        roadtour_context: verifiedRoadtourContext,
      },
    })

    return {
      success: true,
      user: authUser.user,
      bonus: {
        awarded: bonusAwarded,
        points: bonusPoints,
        mode: bonusMode,
      },
    }
  } catch (error) {
    console.error('Error registering consumer:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to register consumer'
    }
  }
}
