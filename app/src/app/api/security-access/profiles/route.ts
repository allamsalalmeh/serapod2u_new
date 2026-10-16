import { NextRequest, NextResponse } from 'next/server'
import { actorAlsoHolds, requireSecurityActor } from '@/lib/security-access/admin-api'
import { loadProfiles, profileActionSchema, runProfileAction } from '@/lib/security-access/profiles'

export const dynamic = 'force-dynamic'

/** Group Policies with drafts and holder counts (security.access.view). */
export async function GET() {
  const actor = await requireSecurityActor('security.access.view')
  if (actor instanceof NextResponse) return actor
  const result = await loadProfiles(actor.admin, actor.userId)
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status })
  // Whether the Assign profile entry point is offered; the grant itself is re-checked by the assignments route and the database.
  const canAssign = await actorAlsoHolds(actor, 'security.role.assign').catch(() => false)
  return NextResponse.json({ ok: true, ...result.value, capabilities: { canAssign } }, { headers: { 'Cache-Control': 'no-store' } })
}

/**
 * Profile lifecycle (create, copy, draft, submit, preview, publish, retire).
 * Authority: security.role.manage; viewing holders needs security.access.view
 * and is limited by the database to the organizations the actor may view. The
 * database functions re-check the actor, forbid editing standard profiles,
 * keep drafts out of authorization, re-run holder SoD checks and audit.
 */
export async function POST(request: NextRequest) {
  const parsed = profileActionSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid policy request', code: 'invalid_request' }, { status: 400 })
  const actor = await requireSecurityActor(parsed.data.action === 'holders' ? 'security.access.view' : 'security.role.manage')
  if (actor instanceof NextResponse) return actor
  const result = await runProfileAction(actor.admin, actor.userId, parsed.data)
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status })
  return NextResponse.json({ ok: true, result: result.value })
}
