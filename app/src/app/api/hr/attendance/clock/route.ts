import { NextRequest, NextResponse } from 'next/server'
import { clock, forbiddenSelfService, invalid, respond, selfServiceAllowed, sessionActor, unauthenticated } from '@/lib/hr/wave3/server'
import { isUuid } from '@/lib/hr/wave3/messages'

/**
 * POST /api/hr/attendance/clock — { action: 'clock_in' | 'clock_out', shift_id?, source?: 'web'|'mobile', client_at?, note? }
 *
 * Wave 3 (20261222100000): the DATABASE records the time (server clock), the canonical employee identity and channel,
 * refuses a second open entry, evaluates punctuality against the shift and raises review exceptions. The device time
 * is stored only as information (client_at). Employee Self-Service is required ('hr.self_service.use').
 */
export async function POST(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    if (!(await selfServiceAllowed(actor))) return forbiddenSelfService()
    const body = await request.json().catch(() => ({}))
    const action = body?.action
    if (action !== 'clock_in' && action !== 'clock_out') return invalid('Invalid action')
    const shiftId = body?.shift_id && body.shift_id !== 'none' ? body.shift_id : null
    if (shiftId !== null && !isUuid(shiftId)) return invalid('Invalid shift')
    const source = body?.source === 'mobile' ? 'mobile' : 'web'
    const clientAt = typeof body?.client_at === 'string' && !Number.isNaN(Date.parse(body.client_at)) ? body.client_at : null
    const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : null
    const result = await clock(actor.id, action, shiftId, source, clientAt, note)
    if (!result.ok) return respond(result)
    return NextResponse.json({ success: true, data: result.data })
}
