import { NextRequest } from 'next/server'
import { invalid, leaveUnpaidDays, respond, sessionActor, unauthenticated } from '@/lib/hr/wave3/server'
import { isIsoDate, isUuid } from '@/lib/hr/wave3/messages'

/**
 * GET /api/hr/leave/unpaid?from&to[&organization_id] — approved UNPAID leave in working days per employee for a period
 * (payroll readiness; no pay calculation). Explicit HR leave authority ('hr.leave.approve').
 */
export async function GET(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    const q = new URL(request.url).searchParams
    const org = q.get('organization_id') ?? actor.organizationId
    const from = q.get('from'), to = q.get('to')
    if (!isUuid(org) || !isIsoDate(from) || !isIsoDate(to)) return invalid()
    return respond(await leaveUnpaidDays(actor.id, org, from, to))
}
