import { ESS_HQ_ONLY_MESSAGE, essAllowedForOrgType, isEssRoleKey } from '@/lib/security-access/ess-eligibility'
import { recipientEligibility, type EligibilityModel, type RecipientPolicy } from '@/lib/security-access/recipient-eligibility'
import { loadEligibilityModel } from '@/lib/security-access/eligibility-model'

/**
 * Server-side validation of the Group Policy selections submitted by Add User, run BEFORE any side effect (no login,
 * profile or grant exists yet). The database re-checks authority, applicability, sensitivity, scope membership and
 * separation of duties inside the provisioning transaction; this layer adds the rules that need the real organization
 * and the real policy rows, and gives direct API callers the same answers as the form.
 */
export interface SubmittedPolicy { role_id: string; scope_id: string }
export interface PolicyRow {
  id: string; role_key: string | null; status: string | null; source: string | null
  /** Recipient-eligibility metadata of the published policy (see recipient-eligibility.ts). */
  applicable_account_types?: string[] | null; applicable_org_types?: string[] | null; permission_keys?: string[] | null
}

const recipientPolicy = (r: PolicyRow): RecipientPolicy => ({ roleKey: r.role_key, status: r.status, source: r.source, accountTypes: r.applicable_account_types, orgTypes: r.applicable_org_types, permissionKeys: r.permission_keys })

/** The published policy rows (with audience and permission keys) the recipient checks need. */
async function loadPolicyRows(admin: any, ids: readonly string[]): Promise<{ rows: any[]; failed: boolean }> {
  if (!ids.length) return { rows: [], failed: false }
  const { data, error } = await admin.from('sa_business_roles')
    .select('id, role_key, status, source, applicable_account_types, applicable_org_types, permissions:sa_business_role_permissions(permission:sa_permissions(permission_key))').in('id', ids)
  if (error) return { rows: [], failed: true }
  return { rows: (data || []).map((r: any) => ({ ...r, permission_keys: (r.permissions || []).map((p: any) => p?.permission?.permission_key).filter(Boolean) })), failed: false }
}

export type SelectionResult =
  | { ok: true; grouped: Array<{ roleId: string; scopeIds: string[] }> }
  | { ok: false; code: 'INVALID_INPUT' | 'ROLE_GRANT_NOT_ALLOWED' | 'ESS_HQ_ONLY' | 'RECIPIENT_NOT_ELIGIBLE' | 'CATALOGUE_UNAVAILABLE'; message: string }

const MAX_ROWS = 20
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function evaluateInitialSelections(input: {
  /** Type code of the organization as stored in the database (never a submitted value). */
  organizationTypeCode: string | null
  roles: ReadonlyMap<string, PolicyRow>
  items: readonly SubmittedPolicy[]
  /** Employee Self Service was excluded: the ESS policy cannot also be requested. */
  essExcluded?: boolean
  /** The rule the database enforces (eligibility-model.ts); defaults to the organization-type rule. */
  model?: EligibilityModel
}): SelectionResult {
  const { items, roles } = input
  if (!items.length || items.length > MAX_ROWS) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Choose between one and twenty Group Policy scopes. Nothing was created.' }
  }
  const seen = new Set<string>()
  const grouped = new Map<string, string[]>()
  for (const item of items) {
    if (!UUID.test(item?.role_id ?? '') || !UUID.test(item?.scope_id ?? '')) {
      return { ok: false, code: 'INVALID_INPUT', message: 'Each Group Policy needs a valid policy and its own scope. Nothing was created.' }
    }
    const pair = `${item.role_id}:${item.scope_id}`
    if (seen.has(pair)) {
      return { ok: false, code: 'INVALID_INPUT', message: 'The same Group Policy and scope were selected twice. Nothing was created.' }
    }
    seen.add(pair)
    const role = roles.get(item.role_id)
    if (!role || role.status !== 'active' || role.source === 'legacy') {
      return { ok: false, code: 'ROLE_GRANT_NOT_ALLOWED', message: 'A selected Group Policy is unknown, not active (draft or retired) or not assignable. Nothing was created.' }
    }
    if (isEssRoleKey(role.role_key) && input.essExcluded) {
      return { ok: false, code: 'INVALID_INPUT', message: 'Employee Self Service was excluded but its policy was also selected. Nothing was created.' }
    }
    if (isEssRoleKey(role.role_key) && !essAllowedForOrgType(input.organizationTypeCode)) {
      return { ok: false, code: 'ESS_HQ_ONLY', message: `${ESS_HQ_ONLY_MESSAGE} Nothing was created.` }
    }
    const eligibility = recipientEligibility(recipientPolicy(role), input.organizationTypeCode, input.model)
    if (!eligibility.ok) {
      return { ok: false, code: 'RECIPIENT_NOT_ELIGIBLE', message: eligibility.code === 'NOT_ASSIGNABLE' ? 'A selected Group Policy is unknown, not active (draft or retired) or not assignable. Nothing was created.' : `${eligibility.message.endsWith('Nothing was created.') ? eligibility.message : `${eligibility.message} Nothing was created.`}` }
    }
    grouped.set(item.role_id, [...(grouped.get(item.role_id) ?? []), item.scope_id])
  }
  return { ok: true, grouped: [...grouped].map(([roleId, scopeIds]) => ({ roleId, scopeIds })) }
}

/** Loads the real organization type and policy rows, then evaluates. `admin` is the service-role client. */
export async function validateInitialSelections(admin: any, organizationId: string | null, items: readonly SubmittedPolicy[], options: { essExcluded?: boolean } = {}): Promise<SelectionResult> {
  if (!organizationId) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Group Policies need an organization. Nothing was created.' }
  }
  const { data: org } = await admin.from('organizations').select('org_type_code').eq('id', organizationId).maybeSingle()
  if (!org) return { ok: false, code: 'INVALID_INPUT', message: 'The organization was not found. Nothing was created.' }
  const ids = Array.from(new Set(items.map(i => i?.role_id).filter(Boolean)))
  const { rows, failed } = await loadPolicyRows(admin, ids)
  if (failed) return { ok: false, code: 'CATALOGUE_UNAVAILABLE', message: 'The Group Policy catalogue could not be checked. Nothing was created. Try again.' }
  const roles = new Map<string, PolicyRow>(rows.map((r: any) => [r.id, r]))
  const model = await loadEligibilityModel(admin)
  return evaluateInitialSelections({ organizationTypeCode: org.org_type_code ?? null, roles, items, essExcluded: options.essExcluded, model })
}

/**
 * Direct S&A grant / access-request path: the same recipient eligibility as Add User (recipient-eligibility.ts —
 * organization-type eligibility, ESS HQ-only, Manufacturer Manufacturing-only). The organization type is read from the
 * database, never the client. Does not look at existing grants and does not judge the assigning administrator's authority.
 * (Name kept for its callers; it checks the full recipient rule, not only ESS.)
 */
export async function essGrantAllowed(admin: any, roleId: string, organizationId: string): Promise<{ ok: true } | { ok: false; message: string; code?: string }> {
  const { data: org } = await admin.from('organizations').select('org_type_code').eq('id', organizationId).maybeSingle()
  const { data: found, error: roleError } = await admin.from('sa_business_roles')
    .select('id, role_key, status, source, applicable_account_types, applicable_org_types, permissions:sa_business_role_permissions(permission:sa_permissions(permission_key))').eq('id', roleId).maybeSingle()
  if (roleError) return { ok: false, code: 'CATALOGUE_UNAVAILABLE', message: 'The Group Policy catalogue could not be checked. Try again.' }
  const role = found ? { ...found, permission_keys: (found.permissions || []).map((p: any) => p?.permission?.permission_key).filter(Boolean) } : null
  if (!role) return { ok: true } // unknown role: the database rejects it with its own error
  const eligibility = recipientEligibility(recipientPolicy(role), org?.org_type_code, await loadEligibilityModel(admin))
  if (eligibility.ok) return { ok: true }
  // Status / source are judged by the database (sa_assign_role); only the audience rules are decided here.
  if (eligibility.code === 'NOT_ASSIGNABLE') return { ok: true }
  return { ok: false, code: eligibility.code === 'ESS_HQ_ONLY' ? 'ESS_HQ_ONLY' : 'RECIPIENT_NOT_ELIGIBLE', message: eligibility.message }
}
