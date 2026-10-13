import type { CatalogEntry } from './catalog'

/**
 * Identity Foundation permissions (Stage 1). Seeded by
 * supabase/migrations/20260929110000_identity_foundation.sql with exactly
 * these keys, sensitivities and compatibility rules (identity-catalog.test.ts
 * keeps them in lock-step). Modes start SHADOW.
 *
 * platform.user.manage (Final Wave catalogue) remains the identity/profile
 * management permission; it is not duplicated here. Identity/profile editing
 * and access administration stay separate: platform.identity_access.manage is
 * NOT implied by platform.user.manage or hr.employee.manage.
 */
export const IDENTITY_CATALOG: readonly CatalogEntry[] = [
  { key: 'platform.identity.view', description: 'View central identities, principal types, lifecycle state and identity conflicts',
    sensitivity: 'security_sensitive', compat: { maxRoleLevel: 30, legacyPermissions: ['view_users', 'edit_users', 'create_users'] } },
  { key: 'platform.identity.disable', description: 'Suspend, disable or reactivate an identity (account lifecycle)',
    sensitivity: 'security_sensitive', compat: { maxRoleLevel: 30, legacyPermissions: ['edit_users'] } },
  { key: 'platform.identity.delete', description: 'Archive an identity (terminal; history is preserved)',
    sensitivity: 'security_sensitive', compat: { maxRoleLevel: 1 } },
  { key: 'platform.identity_access.manage', description: 'Change enterprise access fields of an identity (legacy role code, organization context, principal upgrade)',
    sensitivity: 'security_sensitive', compat: { maxRoleLevel: 10 } },
] as const

export const IDENTITY_PERMISSION_KEYS = IDENTITY_CATALOG.map(entry => entry.key)

/** Identity operations whose every path is wired (server + database). */
export const IDENTITY_ENFORCEMENT_READY: readonly string[] = [
  'platform.identity.view',
  'platform.identity.disable',
  'platform.identity_access.manage',
]

/**
 * Archive Identities, registered by 20261023100000_sa_identity_delete_enforcement_ready.sql once every removal path
 * decides it for the target's organization (lib/identity/removal-authorization.ts).
 */
export const IDENTITY_ARCHIVE_ENFORCEMENT_READY: readonly string[] = ['platform.identity.delete']
