import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { currentMigrationMode } from './authorization'
import { isNewAuthoritative } from './enforcement'

export type ReadableOrganizations = { all: true } | { all: false; organizationIds: string[] }

const NONE: ReadableOrganizations = { all: false, organizationIds: [] }
/** PostgREST / Postgres "function does not exist" (migration not applied yet). */
const FUNCTION_MISSING = new Set(['PGRST202', '42883'])

/**
 * Which organizations a list may show for `permission`.
 *
 * NEW_ENFORCED / LEGACY_RETIRED: exactly the organizations for which S&A allows
 * the permission (public.sa_readable_organizations — same membership, scope
 * and delegation rules as a single decision). Any failure returns nothing.
 * Otherwise the route's historical rule decides (`legacy`), e.g. "a Super
 * Admin sees every organization, others only their own".
 */
export async function readableOrganizations(
  userId: string,
  permission: string,
  legacy: () => ReadableOrganizations | Promise<ReadableOrganizations>,
): Promise<ReadableOrganizations> {
  let mode
  try {
    mode = await currentMigrationMode(permission)
  } catch {
    return NONE
  }
  if (!isNewAuthoritative(mode)) return legacy()
  const admin = createAdminClient() as any
  const { data, error } = await admin.rpc('sa_readable_organizations', { p_actor: userId, p_permission: permission })
  // Code-before-migration rollout only: until the Stage 2D migration creates
  // the function, the historical rule keeps deciding (as authorization.ts does
  // for its evaluator). Any other failure returns nothing.
  if (error && FUNCTION_MISSING.has(error.code)) return legacy()
  if (error || !Array.isArray(data)) {
    console.error('[sa-scope] readable organizations unavailable', { permission, code: error?.code })
    return NONE
  }
  // Root Access is an explicit, server-validated GLOBAL grant. The S&A engine
  // materializes it as a list of every organization, which — without this check —
  // would be narrowed to a non-global list and hide platform-level (NULL-organization)
  // records from the one actor entitled to see them. We never infer "global" from
  // a list length: only sa_actor_is_root() (active account + active, unexpired
  // grant, decided in the database) carries that signal. A missing Root Access
  // migration or an expired/revoked grant simply means "not Root".
  let isRoot = false
  try {
    const { data: rootData, error: rootError } = await admin.rpc('sa_actor_is_root', { p_actor: userId })
    isRoot = !rootError && rootData === true
  } catch {
    isRoot = false
  }
  if (isRoot) return { all: true }
  return { all: false, organizationIds: data.map(String) }
}

/** True when `organizationId` is inside the readable set. */
export function canReadOrganization(scope: ReadableOrganizations, organizationId: string | null | undefined): boolean {
  if (scope.all) return true
  return !!organizationId && scope.organizationIds.includes(organizationId)
}

/**
 * Target protection for acting on another identity (delete, password reset).
 *
 * NEW_ENFORCED / LEGACY_RETIRED for `permission`: the actor must hold every
 * grant the target holds, at the same scope (public.sa_actor_dominates).
 * Otherwise the historical "not a more privileged legacy role" rule decides.
 * Any failure denies.
 */
export async function targetProtectionAllows(
  actorId: string,
  targetId: string,
  permission: string,
  legacy: () => boolean | Promise<boolean>,
): Promise<boolean> {
  try {
    const mode = await currentMigrationMode(permission)
    if (!isNewAuthoritative(mode)) return Boolean(await legacy())
    const admin = createAdminClient() as any
    const { data, error } = await admin.rpc('sa_actor_dominates', { p_actor: actorId, p_target: targetId })
    if (error && FUNCTION_MISSING.has(error.code)) return Boolean(await legacy())
    return !error && data === true
  } catch {
    return false
  }
}

/**
 * Narrows a readable set to organizations of the given types (e.g. HQ and WH
 * for warehouse lists), so list filters stay small. 'all' when unrestricted.
 */
export async function readableOrganizationsOfTypes(scope: ReadableOrganizations, types: string[]): Promise<'all' | string[]> {
  if (scope.all) return 'all'
  if (scope.organizationIds.length === 0) return []
  const admin = createAdminClient() as any
  const { data, error } = await admin.from('organizations').select('id').in('org_type_code', types)
  if (error || !Array.isArray(data)) return []
  const readable = new Set(scope.organizationIds)
  return data.map((row: { id: string }) => row.id).filter((id: string) => readable.has(id))
}
