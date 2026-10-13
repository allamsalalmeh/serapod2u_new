/**
 * Identity resolution contract (outcomes of public.identity_resolve and the
 * blocked outcomes of public.identity_provision). The database holds the only
 * rule set; this module names the outcomes and explains them to people.
 *
 *   no email/phone match                → NO_MATCH  (create one identity)
 *   email and phone → the same identity → MATCH     (reuse)
 *   email matches, phone new            → MATCH     (reuse; phone not attached)
 *   verified phone matches, email new   → MATCH     (reuse; email not attached)
 *   unverified phone matches only       → IDENTITY_VERIFICATION_REQUIRED
 *   email → A, phone → B                → IDENTITY_CONFLICT (never merged)
 */

export type IdentityResolutionOutcome =
  | 'NO_MATCH'
  | 'MATCH'
  | 'INVALID_INPUT'
  | 'IDENTITY_CONFLICT'
  | 'IDENTITY_AMBIGUOUS_EMAIL'
  | 'IDENTITY_AMBIGUOUS_PHONE'
  | 'IDENTITY_VERIFICATION_REQUIRED'
  | 'IDENTITY_ARCHIVED'

export type IdentityBlockCode =
  | Exclude<IdentityResolutionOutcome, 'NO_MATCH' | 'MATCH' | 'INVALID_INPUT'>
  | 'IDENTITY_INACTIVE'
  | 'IDENTITY_PRINCIPAL_UPGRADE_REQUIRED'
  | 'IDENTITY_ORG_MOVE_REQUIRED'
  /** Add User: the email/phone already belong to an account and no HR link to it was chosen. Nothing is created. */
  | 'IDENTITY_ALREADY_EXISTS'
  /** Add User: the chosen employee link no longer matches the identity the email/phone resolve to. */
  | 'IDENTITY_LINK_MISMATCH'

export const HUMAN_PRINCIPAL_TYPES = [
  'INTERNAL_EMPLOYEE',
  'DISTRIBUTOR_USER',
  'MANUFACTURER_USER',
  'SHOP_STAFF',
  'CONSUMER',
] as const
export type HumanPrincipalType = typeof HUMAN_PRINCIPAL_TYPES[number]

/** Non-human principals live in sa_service_identities, never in public.users. */
export type NonHumanPrincipalType = 'SERVICE_IDENTITY' | 'INTEGRATION_PRINCIPAL'

export const ACCOUNT_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED', 'ARCHIVED'] as const
export type AccountStatus = typeof ACCOUNT_STATUSES[number]

/** Mirrors identity_derive_principal_type(). */
export function derivePrincipalType(accountScope: string | null | undefined, orgTypeCode: string | null | undefined): HumanPrincipalType {
  if (accountScope !== 'portal') return 'CONSUMER'
  if (orgTypeCode === 'DIST') return 'DISTRIBUTOR_USER'
  if (orgTypeCode === 'MFG') return 'MANUFACTURER_USER'
  if (orgTypeCode === 'SHOP') return 'SHOP_STAFF'
  return 'INTERNAL_EMPLOYEE'
}

export interface IdentityResolution {
  outcome: IdentityResolutionOutcome
  userId: string | null
  matchedBy: 'email' | 'phone' | 'email+phone' | null
  matchedUserIds: string[]
  hasProfile: boolean | null
}

export function parseResolution(data: any): IdentityResolution {
  return {
    outcome: (data?.outcome ?? 'INVALID_INPUT') as IdentityResolutionOutcome,
    userId: data?.user_id ?? null,
    matchedBy: data?.matched_by ?? null,
    matchedUserIds: Array.isArray(data?.matched_user_ids) ? data.matched_user_ids : [],
    hasProfile: typeof data?.has_profile === 'boolean' ? data.has_profile : null,
  }
}

export const IDENTITY_BLOCK_MESSAGES: Record<IdentityBlockCode, string> = {
  IDENTITY_CONFLICT:
    'The email and the phone number belong to two different people in the system. Nothing was created or merged; an identity conflict was recorded for review.',
  IDENTITY_AMBIGUOUS_EMAIL:
    'This email address is already shared by more than one account. Nothing was created; an identity conflict was recorded for review.',
  IDENTITY_AMBIGUOUS_PHONE:
    'This phone number is already shared by more than one account. Use the person\'s email address, or resolve the duplicate first.',
  IDENTITY_VERIFICATION_REQUIRED:
    'This phone number belongs to an existing account but has not been verified. Use the person\'s email address, or verify the phone first.',
  IDENTITY_ARCHIVED:
    'This person already has an archived account. A Super Admin can reactivate it; a second account is never created for the same person.',
  IDENTITY_INACTIVE:
    'This person already has an account that is suspended or disabled. Reactivate it instead of creating a new one.',
  IDENTITY_PRINCIPAL_UPGRADE_REQUIRED:
    'This person already has a consumer account. Converting a consumer into an enterprise user is an access-administration step and was not done automatically.',
  IDENTITY_ORG_MOVE_REQUIRED:
    'This person already has an account in another organization. Moving them is an access-administration step and was not done automatically.',
  IDENTITY_ALREADY_EXISTS:
    'An account already exists for this email or phone number, so no second account was created. Open the existing user instead.',
  IDENTITY_LINK_MISMATCH:
    'The email or phone number no longer matches the linked employee. Nothing was created; review the employee link and try again.',
}

export function isIdentityBlockCode(code: unknown): code is IdentityBlockCode {
  return typeof code === 'string' && code in IDENTITY_BLOCK_MESSAGES
}
