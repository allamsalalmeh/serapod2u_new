import 'server-only'
import { checkGrant } from './grant-check'
import { RESTORE_BLOCKER_TEXT, restoreStatusFromRow, type RestoreStatus } from './policy-restore-shared'

/**
 * One-click Restore of a revoked Group Policy grant (People & Access → Access history). The restore is a NEW grant
 * made by the database (sa_restore_policy_grant, migration 20261108100000) through the ordinary grant pipeline; the
 * revoked grant stays in history unchanged. The application runs the same pre-checks as Grant Policy (checkGrant) on
 * the original grant's person, policy, organization and scopes, then the database re-checks everything under a lock.
 */

const isMissingFunction = (error: any) =>
  ['PGRST202', '42883'].includes(String(error?.code)) || /could not find the function|does not exist/i.test(String(error?.message || ''))

export const RESTORE_UNAVAILABLE_MESSAGE = 'Restore is not available yet: the database update 20261108100000_sa_policy_grant_restore.sql has not been applied here. Use Grant Policy instead. Nothing was changed.'

/**
 * Adds `restore` (RestoreStatus) to every revoked, administrator-granted assignment of these people. Display only.
 * `available` is false when the status could not be read (migration not applied, or a failed read): the screen then
 * offers no Restore for administrator grants, and the server would refuse one anyway.
 */
export async function withRestoreStatus<T extends { membership?: any[] }>(admin: any, people: T[]): Promise<{ people: T[]; available: boolean }> {
  const ids = Array.from(new Set(people.flatMap(p => (p.membership || []).flatMap((m: any) => (m.assignments || [])
    .filter((a: any) => a.status === 'revoked').map((a: any) => String(a.id))))))
  if (!ids.length) return { people, available: true }
  let rows: any[] | null = null
  try {
    const { data, error } = await admin.rpc('sa_policy_restore_status', { p_assignments: ids.slice(0, 500) })
    rows = error ? null : (data || [])
  } catch { rows = null }
  if (!rows) return { people, available: false }
  const byId = new Map<string, RestoreStatus | null>(rows.map((r: any) => [String(r.assignment_id), restoreStatusFromRow(r)]))
  return {
    available: true,
    people: people.map(p => ({
      ...p,
      membership: (p.membership || []).map((m: any) => ({
        ...m,
        assignments: (m.assignments || []).map((a: any) => (byId.get(String(a.id)) ? { ...a, restore: byId.get(String(a.id)) } : a)),
      })),
    })),
  }
}

export type RestoreOutcome =
  | { ok: true; assignmentId: string; restoredFrom: string }
  | { ok: false; status: number; code: string; message: string }
  /** A database refusal not described here; the route maps it like every other governance error. */
  | { ok: false; databaseError: any }

const one = (v: any) => (Array.isArray(v) ? v[0] : v)

export async function restorePolicyGrant(admin: any, actorId: string, assignmentId: string): Promise<RestoreOutcome> {
  const { data: original, error } = await admin.from('sa_role_assignments')
    .select('id, user_id, role_id, status, membership:sa_organization_memberships!sa_role_assignments_membership_id_fkey(organization_id), scopes:sa_assignment_scopes(scope_id)')
    .eq('id', assignmentId).maybeSingle()
  if (error) return { ok: false, status: 503, code: 'RESTORE_CHECK_UNAVAILABLE', message: 'This restore could not be checked right now. Nothing was changed. Try again.' }
  if (!original) return { ok: false, status: 404, code: 'sa_assignment_not_found', message: RESTORE_BLOCKER_TEXT.sa_assignment_not_found }
  if (original.status !== 'revoked') return { ok: false, status: 409, code: 'sa_restore_not_revoked', message: RESTORE_BLOCKER_TEXT.sa_restore_not_revoked }
  const organizationId = one(original.membership)?.organization_id
  const scopeIds: string[] = (original.scopes || []).map((s: any) => String(s.scope_id))
  if (!organizationId || !scopeIds.length) return { ok: false, status: 409, code: 'sa_scope_required', message: RESTORE_BLOCKER_TEXT.sa_scope_required }

  // Exactly the checks of an ordinary grant of the same person, policy, organization and scopes (self-grant, ESS,
  // already held, scope eligibility and authority, sensitive permissions), evaluated now — never a stored answer.
  const check = await checkGrant(admin, actorId, { userId: original.user_id, roleId: original.role_id, organizationId, scopeIds })
  if (!check.ok) return { ok: false, status: check.status, code: check.code, message: check.message }

  const { data, error: restoreError } = await admin.rpc('sa_restore_policy_grant', { p_actor: actorId, p_assignment: assignmentId })
  if (restoreError) {
    if (isMissingFunction(restoreError)) return { ok: false, status: 503, code: 'RESTORE_UNAVAILABLE', message: RESTORE_UNAVAILABLE_MESSAGE }
    const code = /\b(sa_[a-z_]+)/.exec(String(restoreError.message || ''))?.[1]
    if (code && RESTORE_BLOCKER_TEXT[code]) {
      return { ok: false, status: code === 'sa_assignment_not_found' ? 404 : 409, code, message: `${RESTORE_BLOCKER_TEXT[code]} Nothing was changed.` }
    }
    return { ok: false, databaseError: restoreError }
  }
  return { ok: true, assignmentId: String(data), restoredFrom: assignmentId }
}
