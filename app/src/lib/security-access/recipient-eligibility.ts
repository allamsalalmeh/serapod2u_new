import { classifyPermission } from './modules'
import { essAllowedForOrgType, isEssRoleKey, ESS_HQ_ONLY_MESSAGE } from './ess-eligibility'
import { orgTypeLabel } from './directory-labels'

/**
 * Recipient eligibility: may THIS Group Policy be given to a person whose membership is in an organization of THAT type?
 *
 * The one application rule, client-safe and shared by the Add User / Edit User pickers and submissions, People & Access
 * (picker, preflight, grant) and self-service access requests. It mirrors the database rule
 * public.sa_policy_org_type_ineligibility (20261030100000_sa_policy_org_type_eligibility.sql), which is the enforcement:
 * the trigger sa_assignment_eligibility_guard refuses every administrator grant that fails it.
 *
 * It is judged on the TARGET membership's stored organization type — never the grantor's organization and never a
 * submitted value — and is deliberately separate from the grantor's authority (security.role.assign, sensitive
 * permissions), scope eligibility and existing coverage, which are checked on their own. A policy is offered exactly as
 * published or not at all; it is never trimmed.
 *
 * Model 'org_type' (after 20261030100000):
 *   - organization types are classified explicitly (ORG_TYPE_CLASSES); anything else — End User, Independent, unknown —
 *     receives no Group Policy;
 *   - a policy must LIST the organization type (applicable_org_types). An empty list is "unclassified": eligible nowhere;
 *   - applicable account types (internal / partner), when set, must also match;
 *   - every permission must suit the type: internal (HQ, WH) any; Distributor / Shop nothing HQ-only (HR, Security,
 *     Finance, Platform); Manufacturer Manufacturing-only;
 *   - Employee Self Service stays HQ-only.
 * Model 'legacy' (the database has not been migrated yet, so it still applies its old rule): an empty list means any
 * organization, plus the Manufacturer and ESS rules of 20261010100000 / 20261014100000. The application follows the
 * database it talks to so the picker never offers what the database refuses, nor the reverse.
 */
export type EligibilityModel = 'org_type' | 'legacy'

export interface RecipientPolicy {
  roleKey?: string | null
  status?: string | null
  source?: string | null
  accountTypes?: readonly string[] | null
  orgTypes?: readonly string[] | null
  /** Every permission key the published policy holds. */
  permissionKeys?: readonly string[] | null
}

export type IneligibleCode =
  | 'NOT_ASSIGNABLE' | 'ESS_HQ_ONLY' | 'ORG_TYPE_NOT_ASSIGNABLE' | 'POLICY_UNCLASSIFIED' | 'ORG_TYPE_NOT_ELIGIBLE'
  | 'PERMISSION_INCOMPATIBLE' | 'AUDIENCE_NOT_MANUFACTURER' | 'NOT_MANUFACTURING_ONLY'

export type RecipientEligibility = { ok: true } | { ok: false; code: IneligibleCode; message: string }

export type OrgTypeClass = 'internal' | 'partner'
/** Mirror of public.sa_org_type_eligibility (END_USER and INDEP are 'not_assignable' there, i.e. absent here). */
export const ORG_TYPE_CLASSES: Readonly<Record<string, OrgTypeClass>> = { HQ: 'internal', WH: 'internal', MFG: 'partner', DIST: 'partner', SHOP: 'partner' }
/** Organization types a Group Policy may list, in display order. */
export const ELIGIBLE_ORG_TYPES = ['HQ', 'WH', 'MFG', 'DIST', 'SHOP'] as const

export const normalizeOrgType = (orgTypeCode?: string | null) => String(orgTypeCode ?? '').trim().toUpperCase()
export const orgTypeClass = (orgTypeCode?: string | null): OrgTypeClass | null => ORG_TYPE_CLASSES[normalizeOrgType(orgTypeCode)] ?? null

export const MANUFACTURER_NO_POLICY_MESSAGE =
  'No published Group Policy is currently designated for Manufacturer accounts. Manufacturing policies must be published for Manufacturers (and contain only Manufacturing permissions) in Security & Access before they can be assigned here. You can still create the user without a Group Policy.'

export const MANUFACTURER_NO_POLICY_TITLE = 'No Manufacturer policy available'
export const MANUFACTURER_NO_POLICY_DETAIL =
  'No published Group Policy is designated for Manufacturer accounts yet, so none can be assigned here. An account created without a Group Policy has no Manufacturing access until one is assigned.'

export const MANUFACTURER_INELIGIBLE_MESSAGE =
  'A selected Group Policy is not designated for Manufacturer accounts (it must be published for Manufacturers and hold only Manufacturing permissions). Nothing was created.'

export const UNCLASSIFIED_MESSAGE =
  'This Group Policy has no eligible organization types yet, so it cannot be granted. Classify it in Security & Access → Group Policies.'

export const isManufacturerOrgType = (orgTypeCode?: string | null) => normalizeOrgType(orgTypeCode) === 'MFG'

const upper = (values?: readonly string[] | null) => (values ?? []).map(v => String(v).toUpperCase())
const lower = (values?: readonly string[] | null) => (values ?? []).map(v => String(v).toLowerCase())

/** True when every permission is a Manufacturing-area permission (and there is at least one). */
export function isManufacturingOnly(permissionKeys?: readonly string[] | null): boolean {
  const keys = permissionKeys ?? []
  return keys.length > 0 && keys.every(k => {
    const c = classifyPermission(k)
    return c.groupId === 'supply_chain' && c.areaId === 'manufacturing'
  })
}

/** Mirror of public.sa_permission_hq_only: only internal (HQ / WH) memberships may hold these. */
export const isHqOnlyPermission = (key: string) => /^(hr\.|security\.|platform\.|finance\.)/.test(key)

/** Mirror of public.sa_permission_allowed_for_org_type. */
export function permissionAllowedForOrgType(key: string, orgTypeCode?: string | null): boolean {
  const type = normalizeOrgType(orgTypeCode)
  const cls = ORG_TYPE_CLASSES[type]
  if (cls === 'internal') return true
  if (cls !== 'partner') return false
  return !isHqOnlyPermission(key) && (type !== 'MFG' || key.startsWith('manufacturing.'))
}

/** The first permission of a policy that an organization type may not hold (null when all suit it). */
export const firstIncompatiblePermission = (permissionKeys: readonly string[] | null | undefined, orgTypeCode?: string | null) =>
  [...(permissionKeys ?? [])].sort().find(k => !permissionAllowedForOrgType(k, orgTypeCode)) ?? null

const no = (code: IneligibleCode, message: string): RecipientEligibility => ({ ok: false, code, message })

function legacyEligibility(policy: RecipientPolicy, orgTypeCode?: string | null): RecipientEligibility {
  const type = normalizeOrgType(orgTypeCode)
  const accountTypes = lower(policy.accountTypes)
  const orgTypes = upper(policy.orgTypes)
  if (isManufacturerOrgType(type)) {
    const declared = accountTypes.includes('partner') || orgTypes.includes('MFG')
    const excluded = (accountTypes.length > 0 && !accountTypes.includes('partner')) || (orgTypes.length > 0 && !orgTypes.includes('MFG'))
    if (!declared || excluded) return no('AUDIENCE_NOT_MANUFACTURER', MANUFACTURER_INELIGIBLE_MESSAGE)
    if (!isManufacturingOnly(policy.permissionKeys)) return no('NOT_MANUFACTURING_ONLY', MANUFACTURER_INELIGIBLE_MESSAGE)
    return { ok: true }
  }
  // public.sa_profile_applicable before 20261030100000 (MFG / DIST / SHOP = partner, everything else internal).
  const accountType = ['MFG', 'DIST', 'SHOP'].includes(type) ? 'partner' : 'internal'
  if ((accountTypes.length && !accountTypes.includes(accountType)) || (orgTypes.length && !orgTypes.includes(type))) {
    return no('ORG_TYPE_NOT_ELIGIBLE', `This Group Policy is not available for ${orgTypeLabel(type)} accounts.`)
  }
  return { ok: true }
}

export function recipientEligibility(policy: RecipientPolicy, orgTypeCode?: string | null, model: EligibilityModel = 'org_type'): RecipientEligibility {
  if (policy.status != null && policy.status !== 'active') return no('NOT_ASSIGNABLE', 'The Group Policy is not active.')
  if (policy.source === 'legacy') return no('NOT_ASSIGNABLE', 'Compatibility policies cannot be assigned.')
  if (isEssRoleKey(policy.roleKey) && !essAllowedForOrgType(orgTypeCode)) return no('ESS_HQ_ONLY', ESS_HQ_ONLY_MESSAGE)
  if (model === 'legacy') return legacyEligibility(policy, orgTypeCode)

  const type = normalizeOrgType(orgTypeCode)
  const label = orgTypeLabel(type)
  const cls = ORG_TYPE_CLASSES[type]
  const mfg = type === 'MFG'
  if (!cls) return no('ORG_TYPE_NOT_ASSIGNABLE', type ? `${label} accounts cannot receive Group Policies.` : 'The organization type is not known, so no Group Policy can be granted.')
  const orgTypes = upper(policy.orgTypes)
  const accountTypes = lower(policy.accountTypes)
  if (!orgTypes.length) return mfg ? no('AUDIENCE_NOT_MANUFACTURER', MANUFACTURER_INELIGIBLE_MESSAGE) : no('POLICY_UNCLASSIFIED', UNCLASSIFIED_MESSAGE)
  if (!orgTypes.includes(type) || (accountTypes.length > 0 && !accountTypes.includes(cls))) {
    return mfg ? no('AUDIENCE_NOT_MANUFACTURER', MANUFACTURER_INELIGIBLE_MESSAGE) : no('ORG_TYPE_NOT_ELIGIBLE', `This Group Policy is not available for ${label} accounts.`)
  }
  // A Manufacturer policy must hold at least one Manufacturing permission (an empty policy is never designated for them).
  if (mfg && !isManufacturingOnly(policy.permissionKeys)) return no('NOT_MANUFACTURING_ONLY', MANUFACTURER_INELIGIBLE_MESSAGE)
  const bad = firstIncompatiblePermission(policy.permissionKeys, type)
  if (bad) return no('PERMISSION_INCOMPATIBLE', `This Group Policy holds a permission ${label} accounts cannot receive (${bad}).`)
  return { ok: true }
}

export const isEligibleForRecipient = (policy: RecipientPolicy, orgTypeCode?: string | null, model?: EligibilityModel) =>
  recipientEligibility(policy, orgTypeCode, model).ok

/** Splits a list of policies for the recipient organization; ineligible ones are dropped, never trimmed. */
export function filterPoliciesForRecipient<T extends RecipientPolicy>(policies: readonly T[], orgTypeCode?: string | null, model?: EligibilityModel): T[] {
  return policies.filter(p => isEligibleForRecipient(p, orgTypeCode, model))
}

/** Eligible policies plus the ineligible ones with why — for "not available for this account" explanations. */
export function partitionPoliciesForRecipient<T extends RecipientPolicy>(policies: readonly T[], orgTypeCode?: string | null, model?: EligibilityModel) {
  const eligible: T[] = []
  const ineligible: Array<{ policy: T; code: IneligibleCode; message: string }> = []
  for (const p of policies) {
    const r = recipientEligibility(p, orgTypeCode, model)
    if (r.ok) eligible.push(p)
    else ineligible.push({ policy: p, code: r.code, message: r.message })
  }
  return { eligible, ineligible }
}

/** One sentence for an empty / filtered picker, by organization type. */
export function unavailablePoliciesNote(count: number, orgTypeCode?: string | null): string | null {
  if (count <= 0) return null
  const type = normalizeOrgType(orgTypeCode)
  if (!ORG_TYPE_CLASSES[type]) return `${orgTypeLabel(type)} accounts cannot receive Group Policies.`
  return `${count} ${count === 1 ? 'Group Policy is' : 'Group Policies are'} not available for ${orgTypeLabel(type)} accounts (each policy lists the organization types it may be granted to).`
}
