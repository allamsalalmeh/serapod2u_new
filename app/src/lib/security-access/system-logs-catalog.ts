import type { CatalogEntry } from './catalog'
import { SYSTEM_LOG_PERMISSION } from '@/lib/system-logs/contract'

/**
 * System Logs: read diagnostic errors and recorded user activity. Seeded in SHADOW by
 * supabase/migrations/20261017110000_sa_system_logs_view_permission.sql (system-logs-catalog.test.ts keeps both in step).
 *
 * A new key on purpose: viewing Settings (platform.settings.manage), User Management (platform.user.manage) or
 * Security & Access audit (security.audit.view) never implies reading other users' diagnostics. The compatibility
 * audience is the central Super Admin only (role level 1); while the key is not enforced, the route's historical rule
 * is that same audience. The standard Group Policy "System Log Viewer" holds this one permission, is published and
 * assigned to no one; Platform & Settings Full Access is deliberately NOT extended.
 */
export const SYSTEM_LOGS_PERMISSION = SYSTEM_LOG_PERMISSION
export const SYSTEM_LOGS_ROLE = 'system-log-viewer'
export const SYSTEM_LOGS_ROLE_NAME = 'System Log Viewer'

export const SYSTEM_LOGS_CATALOG: readonly CatalogEntry[] = [
  { key: SYSTEM_LOGS_PERMISSION, description: 'View System Logs: diagnostic errors and recorded user activity for organizations in scope',
    sensitivity: 'security_sensitive', compat: { maxRoleLevel: 1 } },
] as const

export const SYSTEM_LOGS_PERMISSION_KEYS: readonly string[] = SYSTEM_LOGS_CATALOG.map(entry => entry.key)

/** GET /api/system-logs, /api/system-logs/[id] and the System Logs page decide through S&A (lib/system-logs/access.ts). */
export const SYSTEM_LOGS_ENFORCEMENT_READY: readonly string[] = [SYSTEM_LOGS_PERMISSION]
