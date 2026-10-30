import { NextRequest } from 'next/server'
import {
    cancelCorrection, forbiddenSelfService, invalid, requestCorrection, respond, reviewQueue, selfServiceAllowed, sessionActor, unauthenticated,
} from '@/lib/hr/wave3/server'
import { isClockTime, isIsoDate, isUuid } from '@/lib/hr/wave3/messages'

/**
 * Attendance corrections (Wave 3, D-013 controlled approval).
 *
 * GET  ?status=pending|approved|rejected|cancelled[&organization_id] — the corrections the caller may review
 *      (explicit HR 'hr.attendance.manage' → organization; direct manager → direct reports). Never the caller's own.
 * POST { action: 'request', entry_id? | work_date, clock_in?, clock_out?, break_minutes?, reason, employee_user_id? }
 *      An employee corrects their OWN entry or reports a missing day (Employee Self-Service 'hr.self_service.use').
 *      With employee_user_id (≠ caller) it is an HR adjustment on behalf (explicit HR; another person decides).
 * POST { action: 'cancel', id } — the requester withdraws a pending correction.
 * Original values are kept on the correction and in the attendance audit; the database decides every rule.
 */
export async function GET(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    const q = new URL(request.url).searchParams
    const org = q.get('organization_id') ?? actor.organizationId
    if (!isUuid(org)) return invalid()
    return respond(await reviewQueue(actor.id, org, 'corrections', q.get('status') || null, null, null))
}

export async function POST(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    const body = await request.json().catch(() => ({}))
    if (body?.action === 'cancel') {
        if (!isUuid(body.id)) return invalid()
        return respond(await cancelCorrection(actor.id, body.id))
    }
    if (body?.action !== 'request' && body?.action !== undefined) return invalid('Invalid action')
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < 5) return invalid('Enter a reason (at least 5 characters).', 'REASON_REQUIRED')
    const entryId = body?.entry_id ?? null
    const workDate = body?.work_date ?? null
    const onBehalf = body?.employee_user_id && body.employee_user_id !== actor.id ? body.employee_user_id : null
    const clockIn = body?.clock_in || null, clockOut = body?.clock_out || null
    const breakMinutes = body?.break_minutes === undefined || body?.break_minutes === null || body?.break_minutes === '' ? null : Number(body.break_minutes)
    if ((entryId !== null && !isUuid(entryId)) || (entryId === null && !isIsoDate(workDate)) || (onBehalf !== null && !isUuid(onBehalf))
        || (clockIn !== null && !isClockTime(clockIn)) || (clockOut !== null && !isClockTime(clockOut))
        || (breakMinutes !== null && (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 600))) return invalid()
    if (!onBehalf && !(await selfServiceAllowed(actor))) return forbiddenSelfService()
    return respond(await requestCorrection(actor.id, {
        entryId, workDate: entryId ? null : workDate, clockIn, clockOut, breakMinutes, reason, onBehalfOf: onBehalf,
    }))
}
