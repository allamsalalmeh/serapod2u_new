import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { essGrantAllowed } from '@/lib/identity/add-user-selections'
import { validateScopeGrant } from '@/lib/security-access/scope-grant'
import { actorAlsoHolds, governanceError, requireSecurityActor, requireSelfServiceActor } from '@/lib/security-access/admin-api'

export const dynamic = 'force-dynamic'

const uuid = z.string().uuid()
const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('submit'),
    targetUserId: uuid.optional(), roleId: uuid, organizationId: uuid,
    scopeIds: z.array(uuid).min(1).max(20),
    effectiveFrom: z.string().datetime().nullable().optional(),
    effectiveUntil: z.string().datetime().nullable().optional(),
    reason: z.string().trim().min(10).max(1000),
  }),
  z.object({ action: z.literal('decide'), requestId: uuid, approve: z.boolean(), reason: z.string().trim().max(1000).optional() }),
  z.object({ action: z.literal('cancel'), requestId: uuid }),
])

/**
 * Lists requests: approvers (security.access_request.approve) see all, others
 * see the requests they raised or that target them.
 */
export async function GET() {
  const actor = await requireSelfServiceActor()
  if (actor instanceof NextResponse) return actor
  const approver = await actorAlsoHolds(actor as any, 'security.access_request.approve')
  let query = actor.admin.from('sa_access_requests')
    .select('id,requester_id,target_user_id,request_type,role_id,organization_id,scope_ids,reason,effective_from,effective_until,status,approver_id,decided_at,decision_reason,resulting_assignment_id,created_at')
    .order('created_at', { ascending: false }).limit(200)
  if (!approver) query = query.or(`requester_id.eq.${actor.userId},target_user_id.eq.${actor.userId}`)
  const { data, error } = await query
  if (error) return NextResponse.json({ error: 'Unable to load access requests' }, { status: 500 })
  return NextResponse.json({ requests: data || [], canApprove: approver })
}

export async function POST(request: NextRequest) {
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 400 })
  const body = parsed.data
  if (body.action === 'decide') {
    // Approval authority; the database also forbids self-approval and grants
    // access only once the approval completes.
    const actor = await requireSecurityActor('security.access_request.approve')
    if (actor instanceof NextResponse) return actor
    const { data, error } = await actor.admin.rpc('sa_decide_access_request', {
      p_actor: actor.userId, p_request: body.requestId, p_approve: body.approve, p_reason: body.reason ?? null,
    })
    if (error) return governanceError(error)
    return NextResponse.json({ ok: true, assignmentId: data ?? null })
  }
  const actor = await requireSelfServiceActor()
  if (actor instanceof NextResponse) return actor
  if (body.action === 'cancel') {
    const { error } = await actor.admin.rpc('sa_cancel_access_request', { p_actor: actor.userId, p_request: body.requestId })
    if (error) return governanceError(error)
    return NextResponse.json({ ok: true })
  }
  const ess = await essGrantAllowed(actor.admin, body.roleId, body.organizationId)
  if (!ess.ok) return NextResponse.json({ error: ess.message, code: ess.code ?? 'ESS_HQ_ONLY' }, { status: ess.code === 'CATALOGUE_UNAVAILABLE' ? 503 : 400 })
  const scope = await validateScopeGrant(actor.admin, { actorId: null, roleId: body.roleId, organizationId: body.organizationId, scopeIds: body.scopeIds })
  if (!scope.ok) return NextResponse.json({ error: scope.message, code: scope.code }, { status: scope.status })
  const { data, error } = await actor.admin.rpc('sa_submit_access_request', {
    p_actor: actor.userId, p_target: body.targetUserId ?? actor.userId, p_role: body.roleId, p_org: body.organizationId,
    p_scope_ids: body.scopeIds, p_from: body.effectiveFrom ?? null, p_until: body.effectiveUntil ?? null, p_reason: body.reason,
  })
  if (error) return governanceError(error)
  return NextResponse.json({ ok: true, requestId: data })
}
