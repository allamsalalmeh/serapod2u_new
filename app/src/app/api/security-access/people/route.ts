import { NextRequest, NextResponse } from 'next/server'
import { actorAlsoHolds, requireSecurityActor } from '@/lib/security-access/admin-api'
import { directoryQuerySchema, loadDirectory } from '@/lib/security-access/directory'
import { rootAccessCapability } from '@/lib/security-access/root-access'

export const dynamic = 'force-dynamic'

/**
 * People & Access directory (security.access.view): server-side search,
 * organization filter and pagination across the organizations this
 * administrator is authorized for. The authorized set and any organization id
 * supplied are verified in the database; viewing grants nothing.
 */
export async function GET(request: NextRequest) {
  const actor = await requireSecurityActor('security.access.view')
  if (actor instanceof NextResponse) return actor
  const parsed = directoryQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request', code: 'invalid_request' }, { status: 400 })
  const result = await loadDirectory(actor.admin, actor.userId, parsed.data)
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status })
  // A link to User Management is offered only when it exists and this administrator may use it.
  // Whether the Root Access option is offered (display only: the database decides every Root Access change).
  const [canManageUsers, rootAccess] = await Promise.all([
    actorAlsoHolds(actor, 'platform.user.manage').catch(() => false),
    rootAccessCapability(actor.admin, actor.userId).catch(() => ({ available: false, viewerIsRoot: false, activeCount: null })),
  ])
  const res = NextResponse.json({ ok: true, ...result.value, viewerId: actor.userId, capabilities: { userManagement: canManageUsers, rootAccess } })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
