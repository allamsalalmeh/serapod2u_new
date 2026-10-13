/**
 * Employee Self Service (ESS) is available to HQ users only.
 *
 * Client-safe rule shared by the Add User flow, the server-side creation checks and the S&A assignment API. The UI only
 * hides what cannot be used; the decision is always taken again on the server from the organization's real type
 * (never from a submitted organization-type value).
 */
export const ESS_ROLE_KEY = 'employee-self-service'

export const ESS_HQ_ONLY_MESSAGE = 'Employee Self Service is available to HQ users only.'

export const isEssRoleKey = (roleKey?: string | null) => roleKey === ESS_ROLE_KEY

/** The organization type that may use ESS. Exact match on the stored organization type code. */
export const isHqOrgType = (orgTypeCode?: string | null) => String(orgTypeCode ?? '').trim().toUpperCase() === 'HQ'

export const essAllowedForOrgType = (orgTypeCode?: string | null) => isHqOrgType(orgTypeCode)

export interface PolicyLike { id: string; roleKey?: string | null }

/** ESS policies are never offered for a non-HQ organization; every other policy is untouched. */
export function filterPoliciesForOrgType<T extends PolicyLike>(policies: readonly T[], orgTypeCode?: string | null): T[] {
  return essAllowedForOrgType(orgTypeCode) ? policies.slice() : policies.filter(p => !isEssRoleKey(p.roleKey))
}
