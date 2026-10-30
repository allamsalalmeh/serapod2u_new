import { NextRequest, NextResponse } from 'next/server'
import { employeeHistory, sessionActor } from '@/lib/hr/employment-foundation'
import { isUuid } from '@/lib/hr/employment-messages'

// ─── GET /api/hr/employees/:id/history ── effective-dated employment history of one person (newest first)
// The database decides (hr_employee_history): the employee themself, or explicit HR (hr.employee.view / manage) in the
// employee's company. Legacy compatibility access never counts.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const actor = await sessionActor()
    if (!actor) return NextResponse.json({ success: false, error: 'Not authenticated', code: 'UNAUTHENTICATED' }, { status: 401 })
    const { id } = await params
    if (!isUuid(id)) return NextResponse.json({ success: false, error: 'The request is incomplete.', code: 'INVALID_INPUT' }, { status: 400 })
    const result = await employeeHistory(actor.id, id)
    if (!result.ok) return NextResponse.json({ success: false, error: result.message, code: result.code }, { status: result.status })
    return NextResponse.json({ success: true, data: result.data ?? [] })
}
