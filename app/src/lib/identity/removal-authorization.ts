import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { authorizeOperation, organizationResource } from '@/lib/security-access/operation'
import { targetProtectionAllows } from '@/lib/security-access/scope'
import { randomUUID } from 'node:crypto'
import { archiveExecute, archivePreview } from './archive'

/**
 * Archive / delete of an identity ("Archive Identities", platform.identity.delete).
 *
 * Every path that removes another person's identity decides here, so the
 * permission can be enforced:
 *   - /api/admin/delete-user-otp/request and /verify-and-delete (User Management
 *     archive; permanent deletion is the canonical identity deletion,
 *     lib/identity/permanent-deletion.ts, decided by the database)
 *   (/api/admin/bulk-delete-users also deletes only through that service)
 *   - organization deletion (/api/organizations/delete/request-otp,
 *     /verify-and-delete and the guarded /api/organizations/delete), which
 *     deletes every member identity of the organization
 *     (authorizeOrganizationIdentityRemoval)
 * The database backstop: API roles can neither delete nor change the lifecycle
 * of public.users (users_protect_access_fields); a hard delete of an identity
 * with history is refused (users_history_delete_guard); once enforced, an
 * archive runs through identity_set_account_status(), which re-asserts
 * platform.identity.delete over the target's organization.
 *
 * Rules (unchanged business behaviour):
 *   - never your own account;
 *   - the decision is made for the TARGET's organization (loaded by the
 *     server; a target without one is judged in the administrator's own
 *     organization, like identity_set_account_status). Until enforced the
 *     historical rule decides: HQ Admin / Super Admin (role level <= 10);
 *   - target protection: until enforced, never a higher legacy role; once
 *     enforced, the administrator must hold every grant of the target
 *     (sa_actor_dominates). A Super Admin account can only be removed by a
 *     Super Admin in every mode.
 */
export const IDENTITY_REMOVAL_PERMISSION = 'platform.identity.delete'

/** Historical removal rule: HQ Admin / Super Admin. */
export const LEGACY_IDENTITY_REMOVAL_MAX_LEVEL = 10

export interface RemovalTarget {
  id: string
  email: string | null
  phone: string | null
  full_name: string | null
  organization_id: string | null
  account_status: string | null
  role_level: number | null
}

export type IdentityRemovalAuthorization =
  | { ok: true; actorRoleLevel: number | null; actorOrganizationId: string | null; target: RemovalTarget }
  | { ok: false; status: 400 | 403 | 404 | 503; error: string; code: string; auditReason: string; decisionId?: string | null }

const roleLevelOf = (relation: any): number | null => {
  const value = Array.isArray(relation) ? relation[0]?.role_level : relation?.role_level
  return typeof value === 'number' ? value : null
}

/** Pure target-protection rule shared by every removal path (exported for tests). */
export function superAdminTargetProtected(actorRoleLevel: number | null, targetRoleLevel: number | null): boolean {
  return targetRoleLevel === 1 && actorRoleLevel !== 1
}

/** Active Root Access of the actor (database answer). False when Root Access is not installed or cannot be read. */
async function actorHoldsRootAccess(admin: any, actorId: string): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc('sa_actor_is_root', { p_actor: actorId })
    return !error && data === true
  } catch {
    return false
  }
}

/** Historical "not a more privileged legacy role" rule. */
export function legacyTargetAllowed(actorRoleLevel: number | null, targetRoleLevel: number | null): boolean {
  if (typeof targetRoleLevel !== 'number') return true
  if (typeof actorRoleLevel !== 'number') return false
  return targetRoleLevel >= actorRoleLevel
}

/**
 * Authorizes removing `targetUserId` for the verified `actorId`. Reads only
 * server-loaded rows; nothing from the request decides scope. Any failure
 * denies. Call it again immediately before the mutation (every submission
 * rechecks current authorization and mode).
 */
export async function authorizeIdentityRemoval(actorId: string, targetUserId: string): Promise<IdentityRemovalAuthorization> {
  if (!targetUserId || typeof targetUserId !== 'string') {
    return { ok: false, status: 400, error: 'targetUserId is required', code: 'target_required', auditReason: 'missing target' }
  }
  if (targetUserId === actorId) {
    return { ok: false, status: 400, error: 'Cannot delete your own account', code: 'self_removal', auditReason: 'self removal refused' }
  }

  const admin = createAdminClient() as any
  const [actorRes, targetRes] = await Promise.all([
    admin.from('users').select('organization_id, roles:role_code(role_level)').eq('id', actorId).maybeSingle(),
    admin.from('users').select('id, email, phone, full_name, organization_id, account_status, roles:role_code(role_level)').eq('id', targetUserId).maybeSingle(),
  ])
  if (actorRes.error || targetRes.error) {
    return { ok: false, status: 503, error: 'Authorization service unavailable', code: 'sa_unavailable', auditReason: 'user lookup failed' }
  }
  const actorRoleLevel = roleLevelOf(actorRes.data?.roles)
  const actorOrganizationId: string | null = actorRes.data?.organization_id ?? null
  const row = targetRes.data

  // A missing target is judged in the administrator's own organization, so its
  // existence is not revealed to someone without authority.
  const decision = await authorizeOperation({
    actorId,
    permission: IDENTITY_REMOVAL_PERMISSION,
    resource: organizationResource('user', row?.organization_id ?? actorOrganizationId, row ? { id: row.id } : {}),
    legacy: () => typeof actorRoleLevel === 'number' && actorRoleLevel <= LEGACY_IDENTITY_REMOVAL_MAX_LEVEL,
  }).catch(() => null)
  if (!decision || decision.unavailable) {
    return { ok: false, status: 503, error: 'Authorization service unavailable', code: 'sa_unavailable', auditReason: 'authorization unavailable', decisionId: decision?.decisionId ?? null }
  }
  if (decision.decision !== 'ALLOW') {
    return {
      ok: false, status: 403, error: 'Forbidden', code: 'sa_forbidden', decisionId: decision.decisionId,
      auditReason: `Security & Access denied ${IDENTITY_REMOVAL_PERMISSION} for the target's organization (legacy role_level=${actorRoleLevel}, reason=${decision.reasonCode})`,
    }
  }
  if (!row) {
    return { ok: false, status: 404, error: 'Target user not found', code: 'target_not_found', auditReason: 'target not found' }
  }

  const target: RemovalTarget = {
    id: row.id, email: row.email ?? null, phone: row.phone ?? null, full_name: row.full_name ?? null,
    organization_id: row.organization_id ?? null, account_status: row.account_status ?? null, role_level: roleLevelOf(row.roles),
  }
  // A Root Administrator is not bound by the legacy Super Admin rule: dominance (sa_actor_dominates, where Root
  // dominates every account) decides, and a Root target stays protected from anyone but another Root Administrator.
  const protectedTarget = (superAdminTargetProtected(actorRoleLevel, target.role_level) && !(await actorHoldsRootAccess(admin, actorId)))
    || !(await targetProtectionAllows(actorId, target.id, IDENTITY_REMOVAL_PERMISSION,
      () => legacyTargetAllowed(actorRoleLevel, target.role_level)))
  if (protectedTarget) {
    return {
      ok: false, status: 403, error: 'You cannot delete a user with higher privileges than your own.', code: 'target_protected',
      auditReason: `Target has higher privilege (target role_level=${target.role_level}, requester role_level=${actorRoleLevel})`,
    }
  }
  return { ok: true, actorRoleLevel, actorOrganizationId, target }
}

export type OrganizationIdentityRemovalAuthorization =
  | { ok: true; memberCount: number }
  | { ok: false; status: 403 | 503; error: string; code: string; auditReason: string; decisionId?: string | null }

/**
 * Deleting an organization (hard_delete_organization) also deletes every
 * public.users row of that organization — check_organization_dependencies
 * treats members as "deleted with the org", not as a blocker. Each member is
 * therefore an identity removal: the same per-target decision (permission for
 * the member's organization, self refusal, target protection) must allow every
 * one of them, or nothing is deleted. An organization without members needs
 * no identity decision. Call it again immediately before the deletion.
 */
export async function authorizeOrganizationIdentityRemoval(actorId: string, organizationId: string): Promise<OrganizationIdentityRemovalAuthorization> {
  const admin = createAdminClient() as any
  const { data, error } = await admin.from('users').select('id').eq('organization_id', organizationId)
  if (error || !Array.isArray(data)) {
    return { ok: false, status: 503, error: 'Authorization service unavailable', code: 'sa_unavailable', auditReason: 'organization member lookup failed' }
  }
  const memberIds: string[] = data.map((row: any) => row.id)
  for (let i = 0; i < memberIds.length; i += 10) {
    const chunk = memberIds.slice(i, i + 10)
    const decisions = await Promise.all(chunk.map((id) => authorizeIdentityRemoval(actorId, id)))
    const refused = decisions.find((decision) => !decision.ok)
    if (refused && !refused.ok) {
      if (refused.status === 503) return { ok: false, status: 503, error: refused.error, code: refused.code, auditReason: refused.auditReason, decisionId: refused.decisionId ?? null }
      return {
        ok: false, status: 403, code: 'member_removal_forbidden', decisionId: refused.decisionId ?? null,
        error: 'This organization has user accounts you are not authorized to remove (Archive Identities). Nothing was deleted.',
        auditReason: `Organization deletion would remove ${memberIds.length} member identit${memberIds.length === 1 ? 'y' : 'ies'}; refused: ${refused.auditReason}`,
      }
    }
  }
  return { ok: true, memberCount: memberIds.length }
}

/**
 * Archive (OTP-confirmed User Management path) is the canonical Archive &
 * Revoke Access (lib/identity/archive.ts → identity_archive_execute): one
 * database transaction ends employment, archives the account (S&A leaver
 * sync), bans the login and revokes sessions, refresh and one-time tokens.
 * The UUID, name and history are kept; the email and phone stay reserved
 * (releasing them is a separate, explicit action). The database decides
 * authority and protections again; nothing changes on refusal.
 */
export async function archiveIdentityKeepingIdentifiers(actorId: string, targetUserId: string): Promise<{ error: string | null; status?: number }> {
  const reason = 'Archived by administrator (OTP verified; history retained; identifiers reserved)'
  const preview = await archivePreview(actorId, targetUserId, 'user_management')
  if (!preview.ok) return { error: preview.message, status: preview.status }
  if (!preview.preview.archive_allowed) {
    const why = preview.preview.blockers.map(b => b.message || b.code).join(' ')
    return { error: why || 'This account cannot be archived.', status: 409 }
  }
  const executed = await archiveExecute({
    actorId, userId: targetUserId, entry: 'user_management', requestId: randomUUID(),
    previewToken: preview.preview.preview_token, reason,
    // The OTP is this path's confirmation; the phrase is the one the server just previewed.
    confirmation: preview.preview.confirmation_phrase, releaseIdentifiers: false, employmentEnd: 'resigned',
  })
  if (!executed.ok) return { error: executed.message, status: executed.status }
  if (executed.outcome.status !== 'completed') {
    return { error: executed.outcome.status === 'stale' ? 'The account changed during the request; nothing was changed. Try again.' : 'This account cannot be archived.', status: 409 }
  }
  return { error: null }
}
