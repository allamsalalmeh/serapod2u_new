import { NextRequest } from 'next/server'
import {
    forbiddenSelfService, invalid, overtimeCancel, overtimeDecide, overtimeList, overtimeSubmit, respond, selfServiceAllowed, sessionActor,
    unauthenticated,
} from '@/lib/hr/wave3/server'
import { isClockTime, isIsoDate, isUuid } from '@/lib/hr/wave3/messages'

/**
 * Overtime requests (Wave 3, B5 — separate from attendance, D-014; independent approval, D-030).
 *
 * GET  ?scope=mine|queue[&status][&organization_id]
 *      mine  — the caller's own requests with status history (Employee Self-Service 'hr.self_service.use')
 *      queue — requests the caller may decide: explicit HR ('hr.attendance.manage') → organization; a direct manager
 *              with the requested MSS overtime approval → direct reports. Never the caller's own.
 * POST { action: 'submit', request_date, ot_minutes, reason, kind: 'pre'|'post', attendance_entry_id?, planned_start?,
 *        planned_end?, idempotency_key? }   — day type, policy-cap and recorded-time checks by the database
 * POST { action: 'approve'|'reject', id, comment?, approved_minutes? }   — requester ≠ approver; rejection needs a comment
 * POST { action: 'cancel', id, reason? }  — employee: own draft/submitted; approved: HR only, with a reason
 * No auto-approval, no pay calculation (payroll consumption is Phase B).
 */
export async function GET(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    const q = new URL(request.url).searchParams
    const scope = q.get('scope') === 'queue' ? 'queue' : 'mine'
    const status = q.get('status') || null
    if (status && !['draft', 'submitted', 'approved', 'rejected', 'cancelled'].includes(status)) return invalid()
    const org = q.get('organization_id') ?? actor.organizationId
    if (scope === 'queue' && !isUuid(org)) return invalid()
    if (scope === 'mine' && !(await selfServiceAllowed(actor))) return forbiddenSelfService()
    return respond(await overtimeList(actor.id, scope, status, scope === 'queue' ? org : null))
}

export async function POST(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    const b = await request.json().catch(() => ({}))
    const action = b?.action
    if (action === 'submit') {
        if (!(await selfServiceAllowed(actor))) return forbiddenSelfService()
        const minutes = Number(b.ot_minutes ?? b.minutes)
        const reason = typeof b.reason === 'string' ? b.reason.trim() : ''
        const kind = b.kind === 'pre' ? 'pre' : 'post'
        if (reason.length < 5) return invalid('Enter a reason (at least 5 characters).', 'REASON_REQUIRED')
        if (!isIsoDate(b.request_date) || !Number.isInteger(minutes)
            || (b.attendance_entry_id && !isUuid(b.attendance_entry_id))
            || (b.planned_start && !isClockTime(b.planned_start)) || (b.planned_end && !isClockTime(b.planned_end))
            || (b.idempotency_key !== undefined && (typeof b.idempotency_key !== 'string' || b.idempotency_key.length > 100))) return invalid()
        return respond(await overtimeSubmit(actor.id, {
            date: b.request_date, minutes, reason, kind, entryId: b.attendance_entry_id || null,
            plannedStart: b.planned_start || null, plannedEnd: b.planned_end || null, idempotencyKey: b.idempotency_key || null,
        }))
    }
    if (action === 'approve' || action === 'reject') {
        if (!isUuid(b.id)) return invalid()
        const approved = b.approved_minutes === undefined || b.approved_minutes === null || b.approved_minutes === '' ? null : Number(b.approved_minutes)
        if (approved !== null && !Number.isInteger(approved)) return invalid()
        const comment = typeof b.comment === 'string' && b.comment.trim() ? b.comment.trim().slice(0, 1000) : null
        return respond(await overtimeDecide(actor.id, b.id, action === 'approve' ? 'approved' : 'rejected', comment, approved))
    }
    if (action === 'cancel') {
        if (!isUuid(b.id)) return invalid()
        const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 1000) : null
        return respond(await overtimeCancel(actor.id, b.id, reason))
    }
    return invalid('Invalid action')
}
