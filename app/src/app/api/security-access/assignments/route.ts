import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { governanceError, requireSecurityActor } from '@/lib/security-access/admin-api'
import { checkGrant, grantDescription, normalizeNote } from '@/lib/security-access/grant-check'
import { restorePolicyGrant } from '@/lib/security-access/policy-restore'

export const dynamic = 'force-dynamic'

const uuid = z.string().uuid()
const target = { userId: uuid, roleId: uuid, organizationId: uuid, scopeIds: z.array(uuid).min(1).max(20) }
const schema = z.discriminatedUnion('action', [
  // Read-only: the same checks as 'grant' for the same input, so the form can explain a refusal before submission.
  z.object({ action: z.literal('preflight'), ...target }),
  z.object({
    action: z.literal('grant'),
    ...target,
    effectiveFrom: z.string().datetime().nullable().optional(),
    effectiveUntil: z.string().datetime().nullable().optional(),
    // Optional administrator note (blank = none). `reason` is the former name, still accepted from older clients.
    note: z.string().max(500).nullable().optional(),
    reason: z.string().max(500).nullable().optional(),
  }),
  z.object({ action: z.literal('revoke'), assignmentId: uuid, reason: z.string().trim().min(5).max(500) }),
  z.object({ action: z.literal('restore'), assignmentId: uuid, reason: z.string().trim().min(5).max(500) }),
  // One-click restore of a revoked administrator grant: a NEW grant from the revoked one (no form, no reason).
  z.object({ action: z.literal('restore_grant'), assignmentId: uuid }),
])

/**
 * Grants, revokes or restores a business role assignment. Authority:
 * security.role.assign in the administrator's scope, re-evaluated on every
 * request (a preflight never carries over). sa_assign_role /
 * sa_revoke_assignment / sa_restore_assignment re-check the actor, forbid
 * self-assignment, require a membership and scopes inside it, enforce SoD, and
 * audit every change. A grant's note is optional; without one the database
 * records a generated description (flagged reason_generated). Revoke and
 * restore still require a reason. Restore only returns automatic access an
 * administrator revoked to its lifecycle owner. restore_grant re-grants a
 * revoked administrator grant as a new grant (sa_restore_policy_grant) after
 * the same application checks as a grant; the revoked grant is left as is.
 */
export async function POST(request: NextRequest) {
  const actor = await requireSecurityActor('security.role.assign')
  if (actor instanceof NextResponse) return actor
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', issues: parsed.error.flatten() }, { status: 400 })
  const body = parsed.data
  if (body.action === 'preflight' || body.action === 'grant') {
    const input = { userId: body.userId, roleId: body.roleId, organizationId: body.organizationId, scopeIds: body.scopeIds }
    const check = await checkGrant(actor.admin, actor.userId, input)
    if (body.action === 'preflight') {
      // A refusal is a normal answer (200); only an unavailable check is an error, so the form can offer Retry.
      if (!check.ok && check.status === 503) return NextResponse.json({ error: check.message, code: check.code }, { status: 503 })
      return NextResponse.json(check.ok ? { ok: true, allowed: true, sensitiveChecked: check.sensitiveChecked } : { ok: true, allowed: false, code: check.code, reason: check.message })
    }
    if (!check.ok) return NextResponse.json({ error: check.message, code: check.code }, { status: check.status })
    const note = normalizeNote(body.note ?? body.reason)
    const assign = (text: string | null) => actor.admin.rpc('sa_assign_role', {
      p_actor: actor.userId, p_user: body.userId, p_role: body.roleId, p_org: body.organizationId,
      p_scope_ids: body.scopeIds, p_from: body.effectiveFrom ?? null, p_until: body.effectiveUntil ?? null, p_reason: text,
    })
    let { data, error } = await assign(note)
    // Before 20261020100000 the database still requires text. The refused call changed nothing (one transaction), so retry
    // once with a server-generated description that says no note was given — never an invented reason.
    if (error && !note && /sa_reason_required/.test(String(error.message))) {
      ({ data, error } = await assign(await grantDescription(actor.admin, { ...input, effectiveUntil: body.effectiveUntil ?? null })))
    }
    if (error) return governanceError(error)
    return NextResponse.json({ ok: true, assignmentId: data, noteRecorded: note !== null })
  }
  if (body.action === 'restore_grant') {
    const outcome = await restorePolicyGrant(actor.admin, actor.userId, body.assignmentId)
    if (outcome.ok) return NextResponse.json({ ok: true, assignmentId: outcome.assignmentId, restoredFrom: outcome.restoredFrom })
    if ('databaseError' in outcome) return governanceError(outcome.databaseError)
    return NextResponse.json({ error: outcome.message, code: outcome.code }, { status: outcome.status })
  }
  const { error } = await actor.admin.rpc(body.action === 'restore' ? 'sa_restore_assignment' : 'sa_revoke_assignment',
    { p_actor: actor.userId, p_assignment: body.assignmentId, p_reason: body.reason })
  if (error) return governanceError(error)
  return NextResponse.json({ ok: true, assignmentId: body.assignmentId })
}
