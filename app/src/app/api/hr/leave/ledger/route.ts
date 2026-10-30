import { NextRequest } from 'next/server'
import { invalid, leaveLedger, respond, sessionActor, unauthenticated } from '@/lib/hr/wave3/server'
import { isUuid } from '@/lib/hr/wave3/messages'

/**
 * GET /api/hr/leave/ledger?employee_user_id[&year] — the append-only leave ledger of one employee: the employee
 * themself, explicit HR leave authority ('hr.leave.approve') of their company, or their direct manager with Manager
 * Self-Service leave view ('hr.mss.leave_view'). The database decides.
 */
export async function GET(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    const q = new URL(request.url).searchParams
    const emp = q.get('employee_user_id') ?? actor.id
    const yearRaw = q.get('year')
    const year = yearRaw ? Number(yearRaw) : null
    if (!isUuid(emp) || (year !== null && (!Number.isInteger(year) || year < 2000 || year > 2100))) return invalid()
    return respond(await leaveLedger(actor.id, emp, year))
}
