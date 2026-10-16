import { NextRequest, NextResponse } from 'next/server'
import { requireSecurityActor } from '@/lib/security-access/admin-api'
import { loadPersonAccess } from '@/lib/security-access/directory'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One person's memberships and Group Policy assignments (security.access.view), for Edit User. Same visibility rules as
 * the People & Access directory: only memberships in organizations the administrator may view are returned, each with
 * its own grant eligibility. Read-only; no credentials, contact, banking or HR data.
 */
export async function GET(_request: NextRequest, context: { params: Promise<{ userId: string }> }) {
  const actor = await requireSecurityActor('security.access.view')
  if (actor instanceof NextResponse) return actor
  const { userId } = await context.params
  if (!UUID.test(userId)) return NextResponse.json({ error: 'Invalid request', code: 'invalid_request' }, { status: 400 })
  const result = await loadPersonAccess(actor.admin, actor.userId, userId)
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status })
  const res = NextResponse.json({ ok: true, viewerId: actor.userId, ...result.value })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
