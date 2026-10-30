import { NextRequest } from 'next/server'
import { forbiddenSelfService, invalid, myAttendance, respond, selfServiceAllowed, sessionActor, unauthenticated } from '@/lib/hr/wave3/server'
import { isIsoDate } from '@/lib/hr/wave3/messages'

/**
 * GET /api/hr/attendance/me[?from=YYYY-MM-DD&to=YYYY-MM-DD] — the signed-in employee's attendance history (entries
 * with their review exceptions, day-level exceptions, correction requests, open entry, shifts). Employee
 * Self-Service ('hr.self_service.use'); the database returns only the caller's own records.
 */
export async function GET(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    if (!(await selfServiceAllowed(actor))) return forbiddenSelfService()
    const q = new URL(request.url).searchParams
    const from = q.get('from'), to = q.get('to')
    if ((from && !isIsoDate(from)) || (to && !isIsoDate(to))) return invalid('Invalid date')
    return respond(await myAttendance(actor.id, from, to))
}
