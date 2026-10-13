import { NextResponse } from 'next/server'
import { requireSelfServiceActor } from '@/lib/security-access/admin-api'
import { evaluateNavSnapshot, loadNavActor } from '@/lib/server/nav-access'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * GET /api/security-access/me/navigation
 *
 * The caller's own answers for every navigation destination (HR, Customer & Growth, RoadTour), decided by the same
 * canonical evaluation the server pages use (current migration mode per permission). The snapshot is bound to the
 * verified account and its own organization; nothing is taken from the request. No decision audit rows are written.
 *
 *   401  not signed in (expired login)
 *   403  the account is not active: nothing is available
 *   503  the permission checks could not be completed: NOT a denial, the client keeps nothing visible and may retry
 *
 * Hiding a destination is never authorization: every route, API and mutation decides again on the server.
 */
export async function GET() {
  const actor = await requireSelfServiceActor()
  if (actor instanceof NextResponse) return actor
  try {
    const navActor = await loadNavActor(actor.userId)
    if (!navActor) return NextResponse.json({ status: 'unavailable' }, { status: 503, headers: NO_STORE })
    const snapshot = await evaluateNavSnapshot(navActor)
    return NextResponse.json({ status: 'ready', snapshot }, { headers: NO_STORE })
  } catch {
    return NextResponse.json({ status: 'unavailable' }, { status: 503, headers: NO_STORE })
  }
}
