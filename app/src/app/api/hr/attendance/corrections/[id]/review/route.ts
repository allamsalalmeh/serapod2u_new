import { NextRequest } from 'next/server'
import { decideCorrection, invalid, respond, sessionActor, unauthenticated } from '@/lib/hr/wave3/server'
import { isUuid } from '@/lib/hr/wave3/messages'

/**
 * POST /api/hr/attendance/corrections/:id/review — { action: 'approved' | 'rejected', comment? }
 * Wave 3: decided by the database (explicit HR 'hr.attendance.manage' of the employee's company, or the direct manager
 * with Manager Self-Service attendance approval once S&A provides it). Never the requester or the employee; a
 * rejection needs a comment; the entry is corrected with server-side recalculation, originals audited.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    if (!isUuid(id)) return invalid()
    const body = await request.json().catch(() => ({}))
    const action = body?.action
    if (action !== 'approved' && action !== 'rejected') return invalid('Invalid action')
    const raw = body?.comment ?? body?.note
    const comment = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 1000) : null
    return respond(await decideCorrection(actor.id, id, action, comment))
}
