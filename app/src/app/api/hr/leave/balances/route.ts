import { NextRequest } from 'next/server'
import {
    forbiddenSelfService, invalid, leaveBalancesOverview, myLeaveBalances, respond, selfServiceAllowed, sessionActor, unauthenticated,
} from '@/lib/hr/wave3/server'
import { isUuid } from '@/lib/hr/wave3/messages'

/**
 * GET /api/hr/leave/balances?scope=mine|organization[&year][&organization_id]
 *   mine          — own balances per active leave type with ledger lines (Employee Self-Service 'hr.self_service.use')
 *   organization  — HR overview of every employee's balances (explicit HR leave authority 'hr.leave.approve')
 * Balances are the database projection of the append-only leave ledger (20261223100000).
 */
export async function GET(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    const q = new URL(request.url).searchParams
    const yearRaw = q.get('year')
    const year = yearRaw ? Number(yearRaw) : null
    if (year !== null && (!Number.isInteger(year) || year < 2000 || year > 2100)) return invalid()
    if (q.get('scope') === 'organization') {
        const org = q.get('organization_id') ?? actor.organizationId
        if (!isUuid(org)) return invalid()
        return respond(await leaveBalancesOverview(actor.id, org, year ?? new Date().getFullYear()))
    }
    if (!(await selfServiceAllowed(actor))) return forbiddenSelfService()
    return respond(await myLeaveBalances(actor.id, year))
}
