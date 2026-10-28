import { NextRequest } from 'next/server'
import { forbiddenSelfService, invalid, leaveQuote, respond, selfServiceAllowed, sessionActor, unauthenticated } from '@/lib/hr/wave3/server'
import { isIsoDate, isUuid } from '@/lib/hr/wave3/messages'

/**
 * GET /api/hr/leave/quote?leave_type_id&start_date&end_date[&half_day=1][&exclude_request_id]
 * The employee's own leave quote (Employee Self-Service 'hr.self_service.use'): working days by the database (policy
 * workdays, national + work-state public holidays), balance before/after per year, warnings and blocking errors.
 * Nothing is written; the database recalculates and re-checks on submission.
 */
export async function GET(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    if (!(await selfServiceAllowed(actor))) return forbiddenSelfService()
    const q = new URL(request.url).searchParams
    const type = q.get('leave_type_id'), start = q.get('start_date'), end = q.get('end_date'), excl = q.get('exclude_request_id')
    if (!isUuid(type) || !isIsoDate(start) || !isIsoDate(end) || (excl && !isUuid(excl))) return invalid()
    return respond(await leaveQuote(actor.id, type, start, end, q.get('half_day') === '1', excl))
}
