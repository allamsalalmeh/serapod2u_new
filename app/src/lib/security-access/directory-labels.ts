/**
 * Organization-type vocabulary for the People & Access directory (display only).
 * Internal staff vs partner is a presentation hint derived from the
 * organization type; it never grants or restricts anything.
 */
const ORG_TYPES: Record<string, { label: string; partner: boolean }> = {
  HQ: { label: 'Headquarters', partner: false },
  WH: { label: 'Warehouse', partner: false },
  MFG: { label: 'Manufacturer', partner: true },
  DIST: { label: 'Distributor', partner: true },
  SHOP: { label: 'Shop', partner: true },
}

export function orgTypeLabel(code?: string | null): string {
  const key = String(code || '').toUpperCase()
  return ORG_TYPES[key]?.label ?? (key ? key : 'Organization')
}

export const isPartnerOrgType = (code?: string | null) => ORG_TYPES[String(code || '').toUpperCase()]?.partner === true

/** Why granting is unavailable for a membership (from sa_directory_visible_memberships). */
export const GRANT_BLOCKED_TEXT: Record<string, string> = {
  self: 'You cannot grant access to yourself.',
  membership_not_active: 'This membership is not active, so a business role cannot be granted. Memberships come from HR / User Management.',
  account_inactive: 'This account is inactive.',
  not_authorized: 'You may view this person but are not authorized to grant access in their organization.',
}

/** User category labels (users.principal_type, as User Management/identity classify people). */
export const CATEGORY_LABELS: Record<string, string> = {
  INTERNAL_EMPLOYEE: 'Internal employee', DISTRIBUTOR_USER: 'Distributor user', MANUFACTURER_USER: 'Manufacturer user',
  SHOP_STAFF: 'Shop staff', CONSUMER: 'Consumer', UNCLASSIFIED: 'Unclassified',
}
export const categoryLabel = (code?: string | null) => (code ? CATEGORY_LABELS[code] ?? code : CATEGORY_LABELS.UNCLASSIFIED)
/** Organization types offered as a filter, in User Management's vocabulary. */
export const ORG_TYPE_OPTIONS = ['HQ', 'MFG', 'DIST', 'WH', 'SHOP'] as const

export type GrantBlock = 'no_membership' | 'membership_inactive' | 'account_inactive' | 'self' | 'not_authorized'

/** Neutral, accurate explanations of why Grant is unavailable (never an error and never an account-health claim). */
export const GRANT_BLOCK_TEXT: Record<GrantBlock, string> = {
  no_membership: 'An active business membership is required to assign an Group Policy.',
  membership_inactive: 'This membership is not active. An active business membership is required to assign an Group Policy.',
  account_inactive: 'This account is inactive, so an Group Policy cannot be assigned.',
  self: 'You cannot grant access to yourself.',
  not_authorized: 'You can view this person, but you are not authorized to grant access in their organization.',
}

/** Why a person's Grant action is unavailable (null when it is available). Order: self, inactive account, membership, authority. */
export function grantBlock(person: { id: string; is_active?: boolean | null; membership?: any[] }, viewerId?: string | null): GrantBlock | null {
  const memberships = person.membership || []
  if (memberships.some(m => m.status === 'active' && m.grantable !== false)) return person.id === viewerId ? 'self' : person.is_active === false ? 'account_inactive' : null
  if (person.id === viewerId) return 'self'
  if (person.is_active === false) return 'account_inactive'
  const active = memberships.filter(m => m.status === 'active')
  if (memberships.length === 0) return 'no_membership'
  if (active.length === 0) return 'membership_inactive'
  const reason = active.find(m => m.grant_blocked_reason)?.grant_blocked_reason
  return reason === 'self' ? 'self' : reason === 'account_inactive' ? 'account_inactive' : reason === 'membership_not_active' ? 'membership_inactive' : 'not_authorized'
}
