import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSecurityActor } from '@/lib/security-access/admin-api'
import { isRootMigrationMissing, rootAccessCapability } from '@/lib/security-access/root-access'
import { ROOT_ACCESS_CONFIRMATION, ROOT_REASON_MAX, ROOT_REASON_MIN, rootRefusal } from '@/lib/security-access/root-access-shared'

export const dynamic = 'force-dynamic'

const uuid = z.string().uuid()
const reason = z.string().trim().min(ROOT_REASON_MIN).max(ROOT_REASON_MAX)
// Unknown fields (an "actorId", a scope, permissions...) are dropped: the actor is always the signed-in session and
// Root Access has no scope or permission list to choose.
const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('grant'),
    userId: uuid,
    reason,
    effectiveUntil: z.string().datetime().nullable().optional(),
    confirmation: z.literal(ROOT_ACCESS_CONFIRMATION),
    requestKey: uuid,
  }),
  z.object({ action: z.literal('revoke'), userId: uuid, reason }),
])

const MIGRATION_MISSING = { error: 'Root Access needs the database migration 20261026100000_sa_root_access.sql, which has not been applied here yet.', code: 'root_access_migration_missing' }

/** The viewer's Root Access capability (display only; every change is decided again by the database). */
export async function GET() {
  const actor = await requireSecurityActor('security.access.view')
  if (actor instanceof NextResponse) return actor
  const capability = await rootAccessCapability(actor.admin, actor.userId)
  const res = NextResponse.json({ ok: true, ...capability })
  res.headers.set('Cache-Control', 'no-store')
  return res
}

/**
 * Grants or revokes Root Access (Full System Administrator).
 *
 * The route requires a signed-in, active Security & Access viewer (security.access.view); the authority itself is
 * decided only in the database: sa_grant_root_access / sa_revoke_root_access require the actor to be an active Root
 * Administrator (legacy level 1 is not enough), refuse self-grant, self-revoke and removing the last Root
 * Administrator, serialize every change, and write every grant, revocation AND refused attempt to the access change
 * log. A grant additionally needs the typed confirmation phrase and an idempotency key (a retried submission returns
 * the original grant). Revoking Root Access never touches the person's Group Policies.
 */
export async function POST(request: NextRequest) {
  const actor = await requireSecurityActor('security.access.view')
  if (actor instanceof NextResponse) return actor
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    const confirmationMissing = parsed.error.issues.some(i => i.path[0] === 'confirmation')
    return NextResponse.json(confirmationMissing
      ? { error: `Type ${ROOT_ACCESS_CONFIRMATION} to confirm.`, code: 'root_confirmation_required' }
      : { error: 'Invalid request', code: 'invalid_request', issues: parsed.error.flatten() }, { status: 400 })
  }
  const body = parsed.data

  const { data, error } = body.action === 'grant'
    ? await actor.admin.rpc('sa_grant_root_access', {
      p_actor: actor.userId, p_target: body.userId, p_reason: body.reason, p_until: body.effectiveUntil ?? null, p_request_key: body.requestKey,
    })
    : await actor.admin.rpc('sa_revoke_root_access', { p_actor: actor.userId, p_target: body.userId, p_reason: body.reason })

  if (error) {
    if (isRootMigrationMissing(error)) return NextResponse.json(MIGRATION_MISSING, { status: 409 })
    console.error('[security-access] root access change failed', { action: body.action, code: error?.code })
    return NextResponse.json({ error: 'Root Access could not be changed. Nothing was changed.', code: 'root_access_failed' }, { status: 500 })
  }
  if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') {
    return NextResponse.json({ error: 'Root Access could not be changed. Nothing was changed.', code: 'root_access_failed' }, { status: 500 })
  }
  if (!data.ok) {
    const refusal = rootRefusal(data.code)
    return NextResponse.json({ error: refusal.message, code: data.code ?? 'root_access_refused' }, { status: refusal.status })
  }
  return NextResponse.json({ ok: true, action: body.action, grantId: data.grant_id ?? null, replayed: data.replayed === true, effectiveUntil: data.effective_until ?? null })
}
