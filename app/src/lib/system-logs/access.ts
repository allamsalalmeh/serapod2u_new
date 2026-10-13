import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { authorizeOperation, organizationResource } from '@/lib/security-access/operation'
import { readableOrganizations, type ReadableOrganizations } from '@/lib/security-access/scope'
import { SYSTEM_LOG_PERMISSION } from './contract'

export type SystemLogAccess =
  | { allowed: true; scope: ReadableOrganizations; organizationId: string | null; decisionId?: string }
  | { allowed: false; status: 401 | 403 | 503; reason: string; decisionId?: string }

/**
 * Who may read System Logs, and for which organizations. The ONLY gate for the page and the list/detail APIs.
 *
 * Decision: Security & Access permission platform.system_logs.view on the viewer's own organization (loaded here,
 * never from the request). Until the key is enforced, the historical rule decides: an active central Super Admin
 * (role level 1) — the same audience as the compatibility rule. Settings access, User Management or Security & Access
 * administration do NOT imply it.
 *
 * Scope: NEW_ENFORCED → exactly sa_readable_organizations(viewer, key); legacy → every organization for the Super
 * Admin. An empty scope lists nothing (fails closed).
 */
export async function resolveSystemLogAccess(userId: string | null | undefined, options: { probe?: boolean } = {}): Promise<SystemLogAccess> {
  if (!userId) return { allowed: false, status: 401, reason: 'not_authenticated' }
  let profile: { organization_id: string | null; is_active: boolean | null; role_level: number | null } | null = null
  try {
    const admin = createAdminClient() as any
    const { data, error } = await admin.from('users').select('organization_id, is_active, roles:role_code(role_level)').eq('id', userId).maybeSingle()
    if (error) return { allowed: false, status: 503, reason: 'profile_unavailable' }
    const role = Array.isArray(data?.roles) ? data.roles[0] : data?.roles
    profile = data ? { organization_id: data.organization_id ?? null, is_active: data.is_active ?? null, role_level: typeof role?.role_level === 'number' ? role.role_level : null } : null
  } catch {
    return { allowed: false, status: 503, reason: 'profile_unavailable' }
  }
  if (!profile || profile.is_active !== true) return { allowed: false, status: 403, reason: 'inactive_or_unknown' }
  const legacySuperAdmin = profile.role_level === 1
  let decision
  try {
    decision = await authorizeOperation({
      actorId: userId,
      permission: SYSTEM_LOG_PERMISSION,
      resource: organizationResource('system_logs', profile.organization_id),
      legacy: () => legacySuperAdmin,
      // Navigation probes decide without writing an authorization audit row; real reads are recorded.
      ...(options.probe ? { explainOnly: true } : {}),
    })
  } catch {
    return { allowed: false, status: 503, reason: 'authorization_unavailable' }
  }
  if (decision.decision !== 'ALLOW') return { allowed: false, status: 403, reason: decision.reasonCode, decisionId: decision.decisionId }
  if (options.probe) return { allowed: true, scope: { all: false, organizationIds: [] }, organizationId: profile.organization_id }
  const scope = await readableOrganizations(userId, SYSTEM_LOG_PERMISSION, () =>
    legacySuperAdmin ? { all: true } : { all: false, organizationIds: profile!.organization_id ? [profile!.organization_id] : [] })
  return { allowed: true, scope, organizationId: profile.organization_id, decisionId: decision.decisionId }
}

/** Arguments for the service-role read functions (p_orgs / p_all_orgs). */
export function scopeArgs(scope: ReadableOrganizations): { p_orgs: string[] | null; p_all_orgs: boolean } {
  return scope.all ? { p_orgs: null, p_all_orgs: true } : { p_orgs: scope.organizationIds, p_all_orgs: false }
}
