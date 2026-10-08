import 'server-only'
import type { RootAccessCapability, RootAccessInfo } from './root-access-shared'

/** PostgREST / Postgres "relation or function does not exist" (migration 20261026100000 not applied yet). */
const MISSING = new Set(['PGRST202', 'PGRST205', '42883', '42P01'])
export const isRootMigrationMissing = (error: any) => MISSING.has(String(error?.code ?? ''))

const GRANT_SELECT = 'id,user_id,grant_method,granted_at,effective_until,reason,granted_by_user:users!sa_root_access_grants_granted_by_fkey(id,full_name,email)'

/**
 * Active Root Access for the given people (expired or revoked grants are not returned). Read-only, service role.
 * `available` is false when the migration is not applied (no badges, no Root option) or the read failed.
 */
export async function loadRootAccess(admin: any, userIds: string[], now: Date = new Date()): Promise<{ available: boolean; byUser: Map<string, RootAccessInfo> }> {
  const byUser = new Map<string, RootAccessInfo>()
  if (userIds.length === 0) return { available: true, byUser }
  let data: any[] | null = null
  let error: any = null
  try {
    ({ data, error } = await admin.from('sa_root_access_grants').select(GRANT_SELECT).in('user_id', userIds).eq('status', 'active'))
  } catch (thrown) {
    error = thrown
  }
  if (error) {
    if (!isRootMigrationMissing(error)) console.error('[security-access] root access status unavailable', { code: error?.code })
    return { available: false, byUser }
  }
  for (const row of data || []) {
    if (row.effective_until && new Date(row.effective_until).getTime() <= now.getTime()) continue
    const by = Array.isArray(row.granted_by_user) ? row.granted_by_user[0] : row.granted_by_user
    byUser.set(row.user_id, {
      grantId: row.id,
      method: row.grant_method === 'bootstrap' ? 'bootstrap' : 'grant',
      grantedAt: row.granted_at,
      grantedBy: by ? { id: by.id, name: by.full_name ?? null, email: by.email ?? null } : null,
      effectiveUntil: row.effective_until ?? null,
      reason: row.reason,
    })
  }
  return { available: true, byUser }
}

/** Whether the viewer currently holds Root Access (database answer, same rule as the evaluator). Display only. */
export async function rootAccessCapability(admin: any, viewerId: string): Promise<RootAccessCapability> {
  const [mine, count] = await Promise.all([
    admin.rpc('sa_actor_is_root', { p_actor: viewerId }),
    admin.rpc('sa_active_root_count', { p_excluding: null }),
  ])
  if (mine.error || count.error) return { available: false, viewerIsRoot: false, activeCount: null }
  return { available: true, viewerIsRoot: mine.data === true, activeCount: typeof count.data === 'number' ? count.data : null }
}

/** Attaches `root_access` (active grant or null) to each person row. */
export function withRootAccess<T extends { id: string }>(people: T[], byUser: Map<string, RootAccessInfo>): Array<T & { root_access: RootAccessInfo | null }> {
  return people.map(p => ({ ...p, root_access: byUser.get(p.id) ?? null }))
}

export type RootTargetGuard = { ok: true } | { ok: false; reason: 'root_target_protected' | 'unavailable' }

/**
 * Target protection for changing ANOTHER person's account (profile, login phone, status, role, organization): an account
 * that holds Root Access (any not-yet-ended grant, also while the account is inactive) may be changed only by another
 * active Root Administrator. Mirrors sa_actor_dominates, which already protects delete and password reset. Fails closed
 * on any read error except "Root Access is not installed" (then nobody holds it).
 */
export async function rootTargetGuard(admin: any, actorId: string, targetId: string, now: Date = new Date()): Promise<RootTargetGuard> {
  if (!targetId || actorId === targetId) return { ok: true }
  try {
    const { data, error } = await admin.from('sa_root_access_grants').select('effective_until').eq('user_id', targetId).eq('status', 'active')
    if (error) return isRootMigrationMissing(error) ? { ok: true } : { ok: false, reason: 'unavailable' }
    const protectedTarget = (data || []).some((row: any) => !row.effective_until || new Date(row.effective_until).getTime() > now.getTime())
    if (!protectedTarget) return { ok: true }
    const { data: actorIsRoot, error: rootError } = await admin.rpc('sa_actor_is_root', { p_actor: actorId })
    if (rootError) return { ok: false, reason: 'unavailable' }
    return actorIsRoot === true ? { ok: true } : { ok: false, reason: 'root_target_protected' }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

export const ROOT_TARGET_PROTECTED_MESSAGE = 'This account holds Root Access. Only another Root Administrator can change it.'
