import 'server-only'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { legacyOrDelegatedSecurityAccess } from './delegation'
import { isActiveAccountRecord } from './active-account'
import { createTrace, type Trace } from './diagnostics'
import { authorizeOperation, organizationResource } from './operation'

export interface SecurityActor {
  userId: string
  organizationId: string | null
  admin: any
  /** Request diagnostics (correlation id + phase timings); see diagnostics.ts. */
  trace: Trace
}

type ActorIdentity = { userId: string; organizationId: string | null }

/** Fail-closed infrastructure failure: never presented as a confirmed denial. */
export function unavailableResponse(trace: Trace, reason: string): NextResponse {
  return NextResponse.json(
    { error: 'Security & Access is temporarily unavailable. Please retry.', code: 'sa_unavailable', reason, correlationId: trace.id },
    { status: 503, headers: { 'Retry-After': '5' } },
  )
}

/** Attaches the correlation id and Server-Timing to a response and logs the trace when slow or failed. */
export function finishTrace<T extends Response>(trace: Trace, response: T): T {
  const timing = trace.end(response.status)
  response.headers.set('x-correlation-id', trace.id)
  if (timing) response.headers.set('Server-Timing', timing)
  return response
}

async function loadActor(trace: Trace): Promise<ActorIdentity | NextResponse> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await trace.time('session', () => supabase.auth.getUser())
  if (!user) {
    // A session the auth service could not check (network / 5xx) is not "signed out".
    const status = (authError as any)?.status
    if (authError && ((authError as any).name === 'AuthRetryableFetchError' || (typeof status === 'number' && status >= 500))) {
      trace.fail('session', authError)
      return unavailableResponse(trace, 'session_unavailable')
    }
    return NextResponse.json({ error: 'Your session has expired. Sign in again.', code: 'unauthenticated' }, { status: 401 })
  }
  // One read for the active-account gate and the trusted organization.
  const admin = createAdminClient() as any
  const { data, error }: any = await trace.time('actor', () => admin.from('users').select('is_active, organization_id').eq('id', user.id).maybeSingle())
  if (error) {
    trace.fail('actor', error)
    return unavailableResponse(trace, 'actor_unavailable')
  }
  if (!isActiveAccountRecord(data)) {
    trace.outcome('DENY:ACCOUNT_INACTIVE')
    return NextResponse.json({ error: 'Forbidden', code: 'sa_forbidden', reason: 'ACCOUNT_INACTIVE' }, { status: 403 })
  }
  return { userId: user.id, organizationId: data?.organization_id ?? null }
}

/**
 * Security administration actor: an S&A decision for the security.*
 * permission in the administrator's organization. The Wave 1 rule
 * (manage_authorization, effectively Super Admin) is the legacy evaluator,
 * extended (opt-in setting) by an explicit in-scope assignment: delegation.ts.
 * The governance database functions re-check the actor independently.
 *
 * Outcomes stay distinct: 401 unauthenticated, 403 a recorded policy denial,
 * 503 when authorization could not be evaluated (fail closed, never an allow).
 */
export async function requireSecurityActor(permission: string, trace: Trace = createTrace(`security:${permission}`)): Promise<SecurityActor | NextResponse> {
  const actor = await loadActor(trace)
  if (actor instanceof NextResponse) return actor
  let decision
  try {
    decision = await authorizeOperation({
      actorId: actor.userId,
      permission,
      resource: organizationResource('security_access', actor.organizationId),
      legacy: () => legacyOrDelegatedSecurityAccess(actor.userId, actor.organizationId, permission),
      correlationId: trace.id,
      trace,
    })
  } catch (error) {
    trace.fail('authorize', error)
    return unavailableResponse(trace, 'authorization_unavailable')
  }
  if (decision.unavailable) return unavailableResponse(trace, decision.unavailable)
  if (decision.decision !== 'ALLOW') {
    return NextResponse.json({ error: 'Forbidden', code: 'sa_forbidden', permission, decisionId: decision.decisionId, reason: decision.reasonCode }, { status: 403 })
  }
  return { ...actor, admin: createAdminClient() as any, trace }
}

/**
 * True when the actor also holds `permission`. Used only to shape read models
 * (which controls to show); it authorizes nothing, so it is explain-only and
 * writes no audit row. Any failure answers false.
 */
export async function actorAlsoHolds(actor: SecurityActor, permission: string): Promise<boolean> {
  const decision = await authorizeOperation({
    actorId: actor.userId,
    permission,
    resource: organizationResource('security_access', actor.organizationId),
    legacy: () => legacyOrDelegatedSecurityAccess(actor.userId, actor.organizationId, permission),
    explainOnly: true,
  }).catch(() => null)
  return decision?.decision === 'ALLOW' && !decision.unavailable
}

/**
 * Self-service governance (request access, delegate one's own rights): only
 * an authenticated, active account is required here; the database functions
 * require an active business membership and enforce every invariant.
 */
export async function requireSelfServiceActor(trace: Trace = createTrace('security:self-service')): Promise<SecurityActor | NextResponse> {
  const actor = await loadActor(trace)
  if (actor instanceof NextResponse) return actor
  return { ...actor, admin: createAdminClient() as any, trace }
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
  [/sa_grant_beyond_authority/, 403, 'You can grant a sensitive permission only while holding it yourself in that organization.'],
  [/sa_grant_scope_beyond_authority/, 403, 'You can grant a scope only inside an organization where you hold the grant authority. Organization-independent scopes are granted by a central Super Admin.'],
  [/sod_violation/, 409, 'This conflicts with a segregation-of-duties rule.'],
  [/sa_membership_required/, 400, 'The person has no active business membership in that organization.'],
  [/sa_target_inactive/, 400, 'The person\'s account is inactive.'],
  [/sa_scope_(required|outside_membership)/, 400, 'Choose at least one scope inside the membership organization.'],
  [/sa_scope_not_eligible/, 400, 'That scope is not available for this account. An HQ account can receive the HQ scope or one of its own warehouses only.'],
  [/sa_scope_wildcard_prohibited/, 400, 'Wildcard scopes are not allowed.'],
  [/sa_compat_role_not_assignable|sa_role_not_(assignable|requestable)/, 400, 'This role cannot be assigned manually.'],
  [/sa_temporary_access_too_long/, 400, 'Temporary access exceeds the maximum allowed period.'],
  [/sa_access_request_not_pending|sa_review_item_already_decided|sa_review_campaign_closed/, 409, 'This item has already been decided.'],
  [/sa_review_items_pending/, 409, 'Every review item must be decided before completing the review.'],
  [/sa_not_enforcement_ready/, 409, 'This operation is not fully wired for enforcement yet.'],
  [/sa_retire_requires_new_enforced/, 409, 'Retire legacy only after New Enforced.'],
  [/sa_profile_not_applicable/, 400, 'This Group Policy is not eligible for the organization type of that membership.'],
  [/sa_role_already_held/, 409, 'This person already holds that role. Nothing to grant.'],
  // One live grant per person + policy + membership (20261108100000): a concurrent grant or restore lost the race.
  [/sa_role_assignments_live_identity_uidx/, 409, 'This person already holds that policy in this organization. Nothing was changed.'],
  [/sa_assignment_not_restorable/, 409, 'Only automatic access an administrator revoked can be restored. Grant other roles again instead.'],
  [/sa_compat_role_stale/, 409, 'The person\'s legacy role has changed since this access was revoked, so it cannot be restored.'],
  [/sa_assignment_not_found/, 404, 'That access assignment no longer exists.'],
  [/sa_reason_required/, 400, 'A reason is required.'],
  [/sa_note_too_long/, 400, 'The note is too long (at most 500 characters).'],
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
