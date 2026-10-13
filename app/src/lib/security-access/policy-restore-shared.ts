/**
 * One-click Restore of a revoked Group Policy grant — the part both the server and the People & Access screen need.
 * The database decides (sa_policy_restore_blocker, re-checked inside sa_restore_policy_grant); this only turns its
 * answer into words. Display only: nothing here allows or refuses a restore.
 */

export interface RestoreStatus {
  /** True when the database currently sees no reason to refuse (authority is checked when the restore is submitted). */
  eligible: boolean
  /** The database's reason (sa_restore_* / sa_*), or null when eligible. */
  code: string | null
  /** Why Restore is unavailable, for the administrator; null when eligible. */
  message: string | null
  /** The validity the restored grant would carry: the original start (only if still ahead) and the original end. */
  effectiveFrom: string | null
  effectiveUntil: string | null
}

const USE_GRANT = 'Use Grant Policy to grant it again.'

/** Why a revoked grant cannot be restored, keyed by the database reason. Unknown reasons fall back to a neutral text. */
export const RESTORE_BLOCKER_TEXT: Record<string, string> = {
  sa_restore_not_revoked: 'Only a revoked grant can be restored.',
  sa_restore_not_explicit_revoke: `This grant ended without an administrator revoke (it expired, or was ended by an access review or the employee lifecycle). ${USE_GRANT}`,
  sa_restore_already_restored: 'This grant has already been restored. The restored grant is listed separately.',
  sa_restore_validity_expired: `This temporary grant's original end date has passed, and a restore never extends it. ${USE_GRANT}`,
  sa_restore_validity_unknown: `The original validity of this grant is not recorded, so it cannot be restored safely. ${USE_GRANT}`,
  sa_restore_superseded: 'A newer grant of this policy for this membership has replaced this one. Restore the newest entry instead.',
  sa_restore_membership_changed: `The person's membership in this organization has changed. ${USE_GRANT}`,
  sa_role_already_held: 'This person already holds this policy in this organization.',
  sa_role_not_assignable: 'This Group Policy is no longer active.',
  sa_profile_not_applicable: 'This Group Policy is no longer eligible for this organization type.',
  sa_membership_required: 'The person no longer has an active membership in this organization.',
  sa_target_inactive: "The person's account is inactive or suspended.",
  sa_scope_required: `The original data scope is no longer recorded. ${USE_GRANT}`,
  sa_scope_outside_membership: `The original data scope is no longer valid for this organization. ${USE_GRANT}`,
  sa_assignment_not_found: 'This grant no longer exists.',
}
export const RESTORE_FALLBACK_TEXT = `This grant cannot be restored. ${USE_GRANT}`

export const restoreBlockerText = (code: string | null | undefined): string => (code && RESTORE_BLOCKER_TEXT[code]) || RESTORE_FALLBACK_TEXT

/**
 * One row of sa_policy_restore_status → the screen's status. Automatic access (sa_restore_automatic) returns null: it
 * keeps its own Restore (back to lifecycle management), so this flow never shows anything for it.
 */
export function restoreStatusFromRow(row: { blocker?: string | null; effective_from?: string | null; effective_until?: string | null }): RestoreStatus | null {
  const code = row.blocker ?? null
  if (code === 'sa_restore_automatic') return null
  return {
    eligible: code === null,
    code,
    message: code === null ? null : restoreBlockerText(code),
    effectiveFrom: row.effective_from && new Date(row.effective_from).getTime() > Date.now() ? row.effective_from : null,
    effectiveUntil: row.effective_until ?? null,
  }
}
