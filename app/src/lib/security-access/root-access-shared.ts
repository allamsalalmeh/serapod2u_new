/**
 * Root Access (Full System Administrator): constants and wording shared by the server route, the People & Access
 * screen and tests. Authorizes nothing: the database (sa_grant_root_access / sa_revoke_root_access and the canonical
 * evaluator) decides every grant, revocation and access decision.
 */

/** Typed by the administrator to confirm a grant; the server refuses a grant without it. */
export const ROOT_ACCESS_CONFIRMATION = 'GRANT ROOT ACCESS'

export const ROOT_REASON_MIN = 10
export const ROOT_REASON_MAX = 500
/** An expiry must leave at least this long (mirrors the database rule). */
export const ROOT_MIN_DURATION_MINUTES = 15

export const ROOT_ACCESS_WARNING =
  'Root Access grants full system-wide administrative privileges across all modules and organizations. This includes managing users, roles, permissions and system configuration. Sensitive operations may still require additional verification.'

/** Modules Root Access covers (display). Coverage itself is every active permission, so new modules are included automatically. */
export const ROOT_ACCESS_MODULES = [
  'Supply Chain', 'Customer & Growth', 'RoadTour and Event Management', 'HR & Payroll', 'Finance', 'Reporting and Analytics',
  'Notifications', 'Platform & Security', 'User Management', 'Security & Access', 'System Configuration',
] as const

export const ROOT_ACCESS_ORGANIZATIONS = 'HQ, branches, business units, warehouses, distributors, manufacturers and shops'

/** Root Access status of one person, as the directory reports it (active grants only). */
export interface RootAccessInfo {
  grantId: string
  method: 'grant' | 'bootstrap'
  grantedAt: string
  grantedBy: { id: string; name: string | null; email: string | null } | null
  effectiveUntil: string | null
  reason: string
}

/** Viewer capability reported with the directory. `available` is false until the migration is applied. */
export interface RootAccessCapability { available: boolean; viewerIsRoot: boolean; activeCount: number | null }

/** Database refusal codes → HTTP status and a message safe to show. */
export const ROOT_ACCESS_REFUSALS: Record<string, { status: number; message: string }> = {
  root_actor_required: { status: 403, message: 'Only a Root Administrator can grant or revoke Root Access.' },
  root_authority_required: { status: 403, message: 'Only an active Root Administrator can grant or revoke Root Access. Level 1 / Super Admin and Group Policies are not enough.' },
  root_self_grant_prohibited: { status: 403, message: 'You cannot grant Root Access to yourself.' },
  root_self_revoke_prohibited: { status: 403, message: 'You cannot revoke your own Root Access. Another Root Administrator must do it.' },
  root_last_administrator: { status: 409, message: 'This is the last active Root Administrator, so Root Access cannot be revoked.' },
  root_target_not_found: { status: 404, message: 'Person not found.' },
  root_target_inactive: { status: 400, message: 'The person\'s account is inactive.' },
  root_target_not_internal: { status: 400, message: 'Root Access can be granted only to internal staff with an active HQ membership.' },
  root_already_active: { status: 409, message: 'This person already holds Root Access. Nothing was changed.' },
  root_not_active: { status: 409, message: 'This person does not hold active Root Access.' },
  root_reason_required: { status: 400, message: `A reason of ${ROOT_REASON_MIN}–${ROOT_REASON_MAX} characters is required.` },
  root_expiry_invalid: { status: 400, message: `An expiry must be at least ${ROOT_MIN_DURATION_MINUTES} minutes from now.` },
  root_request_key_conflict: { status: 409, message: 'This request was already used for a different grant. Reload and try again.' },
}

export function rootRefusal(code: string | null | undefined): { status: number; message: string } {
  return (code && ROOT_ACCESS_REFUSALS[code]) || { status: 400, message: 'Root Access could not be changed.' }
}

/** True while the grant has no expiry or its expiry is still ahead (same rule as the evaluator). */
export function rootAccessCurrent(info: Pick<RootAccessInfo, 'effectiveUntil'> | null | undefined, now: Date = new Date()): boolean {
  return !!info && (!info.effectiveUntil || new Date(info.effectiveUntil).getTime() > now.getTime())
}
