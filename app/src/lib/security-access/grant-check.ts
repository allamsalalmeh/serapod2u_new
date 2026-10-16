import 'server-only'
import { essGrantAllowed } from '@/lib/identity/add-user-selections'
import { validateScopeGrant } from './scope-grant'
import { findHeldGrant } from './grant-identity'

/**
 * The application checks of ONE administrator grant (actor + person + policy + membership organization + scopes), shared
 * by the form's preflight and by the submission so both judge exactly the same input. Identity is the authenticated
 * actor id and the person's canonical user id — never an e-mail, a name, a membership or an organization id. Read-only;
 * the submission re-runs this and the database (sa_assign_role, grant/scope guards, separation of duties) decides again.
 */
export interface GrantInput { userId: string; roleId: string; organizationId: string; scopeIds: readonly string[] }

export type GrantCheck =
  | { ok: true; /** False when the sensitive-permission rule could not be pre-checked (migration not applied); the database still enforces it. */ sensitiveChecked: boolean }
  | { ok: false; code: string; message: string; status: number }

export const SELF_GRANT_MESSAGE = 'You cannot grant access to yourself.'
export const SENSITIVE_MESSAGE = 'This policy includes sensitive permissions you do not hold in this organization, so you cannot grant it here.'
const UNAVAILABLE = (code: string): GrantCheck => ({ ok: false, code, message: 'This grant could not be checked right now. Nothing was changed. Try again.', status: 503 })

export async function checkGrant(admin: any, actorId: string, input: GrantInput): Promise<GrantCheck> {
  if (actorId === input.userId) return { ok: false, code: 'SELF_GRANT', message: SELF_GRANT_MESSAGE, status: 403 }
  // Employee Self Service is HQ-only; decided from the organization's stored type, never from the client.
  const ess = await essGrantAllowed(admin, input.roleId, input.organizationId)
  if (!ess.ok) return ess.code === 'CATALOGUE_UNAVAILABLE' ? UNAVAILABLE('CATALOGUE_UNAVAILABLE') : { ok: false, code: ess.code ?? 'ESS_HQ_ONLY', message: ess.message, status: 400 }
  // An identical active grant is never added again (that would replace the existing grant's scopes).
  const held = await findHeldGrant(admin, input)
  if (held.held) return { ok: false, code: 'ROLE_ALREADY_HELD', message: held.message, status: 409 }
  // Same scope eligibility the picker offers, policy compatibility and the administrator's authority per scope.
  const scope = await validateScopeGrant(admin, { actorId, roleId: input.roleId, organizationId: input.organizationId, scopeIds: input.scopeIds })
  if (!scope.ok) return { ok: false, code: scope.code, message: scope.message, status: scope.status }
  // Sensitive permissions: the same predicate as the database grant guard (20261015100000). Missing function → unknown, left to the database.
  const { data: may, error } = await admin.rpc('sa_actor_may_assign_profile', { p_actor: actorId, p_role: input.roleId, p_org: input.organizationId })
  if (error) return { ok: true, sensitiveChecked: false }
  if (may !== true) return { ok: false, code: 'GRANT_BEYOND_AUTHORITY', message: SENSITIVE_MESSAGE, status: 403 }
  return { ok: true, sensitiveChecked: true }
}

/** Optional administrator note: trimmed, blank = none. */
export const normalizeNote = (note?: string | null): string | null => {
  const text = (note ?? '').trim()
  return text ? text : null
}

/**
 * Text recorded when no note is given and the database still requires one (before 20261020100000 is applied). Same
 * wording as public.sa_grant_description, so a generated description is never mistaken for an administrator's note.
 */
export async function grantDescription(admin: any, input: GrantInput & { effectiveUntil?: string | null }): Promise<string> {
  // Names only make the text readable; an unreadable one falls back to its id.
  const pick = async (table: string, field: string, id: string): Promise<string> => {
    try {
      const { data } = await admin.from(table).select(field).eq('id', id).maybeSingle()
      return (data && data[field]) || id
    } catch { return id }
  }
  const [policy, person, org] = await Promise.all([
    pick('sa_business_roles', 'name', input.roleId),
    pick('users', 'email', input.userId),
    pick('organizations', 'org_name', input.organizationId),
  ])
  let scopes: any[] = []
  try { scopes = (await admin.from('sa_scope_definitions').select('id, display_name').in('id', Array.from(input.scopeIds))).data || [] } catch { /* ids below */ }
  const scopeText = (scopes.length ? scopes.map(s => s.display_name || s.id) : Array.from(input.scopeIds)).sort().join(', ') || 'none'
  const until = input.effectiveUntil ? `until ${new Date(input.effectiveUntil).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'no end date'
  return `Group Policy "${policy}" granted to ${person} in ${org} (scope: ${scopeText}; ${until}). No note provided.`
}
