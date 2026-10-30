import { NextRequest, NextResponse } from 'next/server'
import { employmentChange, sessionActor } from '@/lib/hr/employment-foundation'
import { isUuid } from '@/lib/hr/employment-messages'

// ─── POST /api/hr/employees/:id/employment ── one controlled, effective-dated employment change
// Body: { changes: { department_id?, position_id?, manager_user_id?, employment_type?, probation_end?, status? },
//         effective_date: 'YYYY-MM-DD' (today or earlier), reason: string }
// The database (hr_employment_change) asserts explicit hr.employee.manage in the employee's company, refuses self-change,
// future dates, ending employment (offboarding is Archive & Revoke Access) and other-company references, validates the
// manager, and writes the version with the business effective date and the reason.
const ALLOWED = new Set(['department_id', 'position_id', 'manager_user_id', 'employment_type', 'probation_end', 'status'])
const DATE = /^\d{4}-\d{2}-\d{2}$/

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const actor = await sessionActor()
    if (!actor) return NextResponse.json({ success: false, error: 'Not authenticated', code: 'UNAUTHENTICATED' }, { status: 401 })
    const { id } = await params
    const body = await request.json().catch(() => ({}))
    const changes = body?.changes
    const effectiveDate = body?.effective_date
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
    if (!isUuid(id) || !changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).length === 0
        || typeof effectiveDate !== 'string' || !DATE.test(effectiveDate)) {
        return NextResponse.json({ success: false, error: 'The request is incomplete.', code: 'INVALID_INPUT' }, { status: 400 })
    }
    if (Object.keys(changes).some((k) => !ALLOWED.has(k))) {
        return NextResponse.json({ success: false, error: 'One of the fields cannot be changed here.', code: 'FIELD_NOT_ALLOWED' }, { status: 400 })
    }
    for (const k of ['department_id', 'position_id', 'manager_user_id']) {
        const v = (changes as Record<string, unknown>)[k]
        if (v !== undefined && v !== null && v !== '' && !isUuid(v)) {
            return NextResponse.json({ success: false, error: 'The request is incomplete.', code: 'INVALID_INPUT' }, { status: 400 })
        }
    }
    if (reason.length < 5) {
        return NextResponse.json({ success: false, error: 'Enter a reason (at least 5 characters).', code: 'REASON_REQUIRED' }, { status: 400 })
    }
    const result = await employmentChange(actor.id, id, changes, effectiveDate, reason)
    if (!result.ok) return NextResponse.json({ success: false, error: result.message, code: result.code }, { status: result.status })
    return NextResponse.json({ success: true, data: result.data })
}
