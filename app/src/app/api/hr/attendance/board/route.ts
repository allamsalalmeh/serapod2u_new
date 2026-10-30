import { NextRequest } from 'next/server'
import { dayBoard, invalid, respond, sessionActor, unauthenticated } from '@/lib/hr/wave3/server'
import { isIsoDate, isUuid } from '@/lib/hr/wave3/messages'

/**
 * GET /api/hr/attendance/board?date=YYYY-MM-DD[&organization_id] — daily attendance board: every employee the caller
 * may see (explicit HR 'hr.attendance.manage' → organization; direct manager with 'hr.mss.attendance_view' → direct
 * reports) with entries, day type, leave and open exceptions.
 */
export async function GET(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    const q = new URL(request.url).searchParams
    const org = q.get('organization_id') ?? actor.organizationId
    const date = q.get('date')
    if (!isUuid(org) || !isIsoDate(date)) return invalid()
    return respond(await dayBoard(actor.id, org, date))
}
