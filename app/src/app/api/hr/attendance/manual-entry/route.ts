import { NextRequest } from 'next/server'
import { invalid, manualEntry, respond, sessionActor, unauthenticated } from '@/lib/hr/wave3/server'
import { isClockTime, isIsoDate, isUuid } from '@/lib/hr/wave3/messages'

/**
 * POST /api/hr/attendance/manual-entry — HR records attendance on behalf of an employee.
 * { employee_user_id, work_date, clock_in 'HH:MM', clock_out? 'HH:MM', break_minutes?, shift_id?, reason }
 * Explicit HR ('hr.attendance.manage') in the employee's company; never one's own attendance; reason mandatory; no
 * overlap, no future date; recorded immediately with an independent review item for a SECOND HR person (maker-checker).
 */
export async function POST(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return unauthenticated()
    const b = await request.json().catch(() => ({}))
    const reason = typeof b?.reason === 'string' ? b.reason.trim() : ''
    if (reason.length < 5) return invalid('Enter a reason (at least 5 characters).', 'REASON_REQUIRED')
    const breakMinutes = b?.break_minutes === undefined || b?.break_minutes === null || b?.break_minutes === '' ? null : Number(b.break_minutes)
    if (!isUuid(b?.employee_user_id) || !isIsoDate(b?.work_date) || !isClockTime(b?.clock_in)
        || (b?.clock_out && !isClockTime(b.clock_out)) || (b?.shift_id && !isUuid(b.shift_id))
        || (breakMinutes !== null && (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 600))) return invalid()
    return respond(await manualEntry(actor.id, {
        employeeId: b.employee_user_id, workDate: b.work_date, clockIn: b.clock_in, clockOut: b.clock_out || null,
        breakMinutes, shiftId: b.shift_id || null, reason,
    }))
}
