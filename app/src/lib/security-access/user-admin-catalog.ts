import type { CatalogEntry } from './catalog'

/**
 * User Administration: administrative password reset. Seeded in SHADOW by
 * supabase/migrations/20261016100000_sa_user_password_reset_permission.sql
 * (user-admin-catalog.test.ts keeps both in step).
 *
 * Resetting another person's login password is credential control, not profile
 * editing: platform.user.manage (open User Management, edit profiles) and
 * platform.user.profile_edit never imply it. While the key is not enforced the
 * route's historical rule decides (HQ Admin, role level exactly 10), so every
 * administrator who can reset today still can. The compatibility rule below is
 * the same audience (role level <= 10; a central Super Admin is level 1).
 *
 * The standard Group Policy "User Password Administrator" holds this one
 * permission and nothing else; it is published but assigned to no one.
 * Platform & Settings Full Access holds it too (that policy is "every Platform
 * & Settings permission" and already carried platform.user.manage, the key the
 * reset route used before).
 */
export const USER_PASSWORD_RESET_PERMISSION = 'platform.user.password_reset'
export const USER_PASSWORD_RESET_ROLE = 'user-password-administrator'
export const USER_PASSWORD_RESET_ROLE_NAME = 'User Password Administrator'

export const USER_ADMIN_CATALOG: readonly CatalogEntry[] = [
  { key: USER_PASSWORD_RESET_PERMISSION, description: 'Reset another user\'s login password (administrative reset)',
    sensitivity: 'security_sensitive', compat: { maxRoleLevel: 10 } },
] as const

export const USER_ADMIN_PERMISSION_KEYS: readonly string[] = USER_ADMIN_CATALOG.map(entry => entry.key)

/** The only path that sets another user's password is POST /api/users/reset-password, which decides through S&A. */
export const USER_ADMIN_ENFORCEMENT_READY: readonly string[] = [USER_PASSWORD_RESET_PERMISSION]
