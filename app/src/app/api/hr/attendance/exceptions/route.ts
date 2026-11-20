import { NextRequest } from 'next/server'
import { invalid, resolveException, respond, reviewQueue, runDetection, sessionActor, unauthenticated } from '@/lib/hr/wave3/server'
import { isIsoDate, isUuid } from '@/lib/hr/wave3/messages'

/**
 * Attendance exceptions (Wave 3 auto-validation, D-012): normal attendance needs no approval; only exceptions are
 * reviewed — by explicit HR ('hr.attendance.manage') or the direct manager ('hr.mss.attendance_view' to see; the
 * requested 'hr.mss.attendance_approve' to resolve). Never one's own; an HR manual entry is confirmed by another HR person.
 *
 * GET  ?status=open|resolved|cleared&from&to[&organization_id]
 * POST { action: 'resolve', id, resolution: 'acknowledged'|'excused'|'dismissed', note? }
 * POST { action: 'detect', from, to[, organization_id] }   (HR: re-run detection for a date range, idempotent)
 */
export async function GET(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    const q = new URL(request.url).searchParams
    const org = q.get('organization_id') ?? actor.organizationId
    const from = q.get('from'), to = q.get('to')
    if (!isUuid(org) || (from && !isIsoDate(from)) || (to && !isIsoDate(to))) return invalid()
    return respond(await reviewQueue(actor.id, org, 'exceptions', q.get('status') || null, from, to))
}

export async function POST(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    const b = await request.json().catch(() => ({}))
    if (b?.action === 'resolve') {
        if (!isUuid(b.id) || !['acknowledged', 'excused', 'dismissed'].includes(b.resolution)) return invalid()
        const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 1000) : null
        return respond(await resolveException(actor.id, b.id, b.resolution, note))
    }
    if (b?.action === 'detect') {
        const org = b.organization_id ?? actor.organizationId
        if (!isUuid(org) || !isIsoDate(b.from) || !isIsoDate(b.to)) return invalid()
        return respond(await runDetection(actor.id, org, b.from, b.to))
    }
    return invalid('Invalid action')
}
