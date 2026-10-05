import 'server-only'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkPermissionForUser } from '@/lib/server/permissions'
import { isActiveSecurityAccessAccount } from './active-account'
import { authorizeOperation, organizationResource } from './operation'

export interface SecurityActor {
  userId: string
  organizationId: string | null
  admin: any
}

async function loadActor(): Promise<{ userId: string; organizationId: string | null } | NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isActiveSecurityAccessAccount(user.id))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = createAdminClient() as any
  const { data } = await admin.from('users').select('organization_id').eq('id', user.id).maybeSingle()
  return { userId: user.id, organizationId: data?.organization_id ?? null }
}

/**
 * Security administration actor: an S&A decision for the security.*
 * permission in the administrator's organization. The Wave 1 rule
 * (manage_authorization, effectively Super Admin) is the legacy evaluator.
 * The governance database functions re-check the actor independently.
 */
export async function requireSecurityActor(permission: string): Promise<SecurityActor | NextResponse> {
  const actor = await loadActor()
  if (actor instanceof NextResponse) return actor
  const decision = await authorizeOperation({
    actorId: actor.userId,
    permission,
    resource: organizationResource('security_access', actor.organizationId),
    legacy: async () => (await checkPermissionForUser(actor.userId, 'manage_authorization')).allowed,
  }).catch(() => null)
  if (!decision || decision.decision !== 'ALLOW') {
    return NextResponse.json({ error: 'Forbidden', permission, decisionId: decision?.decisionId }, { status: 403 })
  }
  return { ...actor, admin: createAdminClient() as any }
}

/** True when the actor also holds `permission` (used to shape read models). */
export async function actorAlsoHolds(actor: SecurityActor, permission: string): Promise<boolean> {
  const decision = await authorizeOperation({
    actorId: actor.userId,
    permission,
    resource: organizationResource('security_access', actor.organizationId),
    legacy: async () => (await checkPermissionForUser(actor.userId, 'manage_authorization')).allowed,
  }).catch(() => null)
  return decision?.decision === 'ALLOW'
}

/**
 * Self-service governance (request access, delegate one's own rights): only
 * an authenticated, active account is required here; the database functions
 * require an active business membership and enforce every invariant.
 */
export async function requireSelfServiceActor(): Promise<SecurityActor | NextResponse> {
  const actor = await loadActor()
  if (actor instanceof NextResponse) return actor
  return { ...actor, admin: createAdminClient() as any }
}

const FRIENDLY: Array<[RegExp, number, string]> = [
  [/sa_self_assignment_prohibited/, 403, 'You cannot grant access to yourself.'],
  [/sa_self_approval_prohibited/, 403, 'Requesters and the person receiving access cannot approve the request.'],
  [/sa_self_certification_prohibited/, 403, 'Reviewers cannot certify their own access.'],
  [/sa_self_mitigation_prohibited/, 403, 'You cannot approve an exception for yourself.'],
  [/sa_self_delegation_prohibited/, 400, 'You cannot delegate to yourself.'],
  [/sa_delegation_exceeds_delegator/, 403, 'A delegation cannot exceed the rights the delegator currently holds.'],
  [/sa_delegate_must_be_member/, 400, 'The delegate must be an active member of that organization.'],
  [/sa_delegation_(end_required|too_long)/, 400, 'Delegations must end, within the maximum delegation period.'],
  [/sod_violation/, 409, 'This conflicts with a segregation-of-duties rule.'],
  [/sa_membership_required/, 400, 'The person has no active business membership in that organization.'],
  [/sa_target_inactive/, 400, 'The person\'s account is inactive.'],
  [/sa_scope_(required|outside_membership)/, 400, 'Choose at least one scope inside the membership organization.'],
  [/sa_scope_wildcard_prohibited/, 400, 'Wildcard scopes are not allowed.'],
  [/sa_compat_role_not_assignable|sa_role_not_(assignable|requestable)/, 400, 'This role cannot be assigned manually.'],
  [/sa_temporary_access_too_long/, 400, 'Temporary access exceeds the maximum allowed period.'],
  [/sa_access_request_not_pending|sa_review_item_already_decided|sa_review_campaign_closed/, 409, 'This item has already been decided.'],
  [/sa_review_items_pending/, 409, 'Every review item must be decided before completing the review.'],
  [/sa_not_enforcement_ready/, 409, 'This operation is not fully wired for enforcement yet.'],
  [/sa_retire_requires_new_enforced/, 409, 'Retire legacy only after New Enforced.'],
  [/sa_profile_not_applicable/, 400, 'This profile does not apply to that organization.'],
  [/sa_role_already_held/, 409, 'This person already holds that role. Nothing to grant.'],
  [/sa_assignment_not_restorable/, 409, 'Only automatic access an administrator revoked can be restored. Grant other roles again instead.'],
  [/sa_compat_role_stale/, 409, 'The person\'s legacy role has changed since this access was revoked, so it cannot be restored.'],
  [/sa_assignment_not_found/, 404, 'That access assignment no longer exists.'],
  [/sa_reason_required/, 400, 'A reason is required.'],
  [/sa_authorization_required/, 403, 'Forbidden'],
  [/emergency_access/, 409, 'Emergency access is unavailable until MFA step-up is in place.'],
]

/** Maps governance function errors to safe, meaningful responses. */
export function governanceError(error: any): NextResponse {
  const message = String(error?.message || '')
  for (const [pattern, status, text] of FRIENDLY) {
    if (pattern.test(message)) return NextResponse.json({ error: text, code: message.split(':')[0] }, { status })
  }
  console.error('[security-access] governance operation failed', { code: error?.code })
  return NextResponse.json({ error: 'The operation could not be completed.' }, { status: 400 })
}
