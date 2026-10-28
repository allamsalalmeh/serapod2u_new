import { NextRequest } from 'next/server'
import { invalid, periodReport, respond, sessionActor, unauthenticated } from '@/lib/hr/wave3/server'
import { isIsoDate, isUuid } from '@/lib/hr/wave3/messages'

/**
 * GET /api/hr/attendance/report?from&to[&organization_id] — HR period summary per employee (days present, worked
 * minutes, late/early/absence counts, open exceptions, manual/imported entries, approved/pending OT minutes).
 * Explicit HR ('hr.attendance.manage'). Minutes only: no pay values, no payroll calculation.
 */
export async function GET(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    const q = new URL(request.url).searchParams
    const org = q.get('organization_id') ?? actor.organizationId
    const from = q.get('from'), to = q.get('to')
    if (!isUuid(org) || !isIsoDate(from) || !isIsoDate(to)) return invalid()
    return respond(await periodReport(actor.id, org, from, to))
}
