import { NextRequest, NextResponse } from 'next/server'
import { reassignDirectReports, reportingLineReview, sessionActor, setReportingLine } from '@/lib/hr/employment-foundation'
import { isUuid } from '@/lib/hr/employment-messages'

// ─── GET  /api/hr/reporting-lines[?organization_id=…] ── reporting-line findings (former/inactive or other-company
//         managers, cycles, missing manager, divergence from the position hierarchy). Read-only.
// ─── POST /api/hr/reporting-lines ── { action: 'set', employee_user_id, manager_user_id|null, reason }
//                                     { action: 'reassign', from_manager_user_id, to_manager_user_id|null, employee_user_ids?, reason }
// The database decides: explicit HR authority (hr.employee.view for the review, hr.employee.manage for changes) in the
// organization concerned; HR never changes their own line; every change is validated, versioned and logged with the reason.
// The organization defaults to the caller's own; another organization is accepted only if the DATABASE grants scope.

export async function GET(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return NextResponse.json({ success: false, error: 'Not authenticated', code: 'UNAUTHENTICATED' }, { status: 401 })
    const requested = new URL(request.url).searchParams.get('organization_id')
    const org = requested ?? actor.organizationId
    if (!isUuid(org)) return NextResponse.json({ success: false, error: 'The request is incomplete.', code: 'INVALID_INPUT' }, { status: 400 })
    const result = await reportingLineReview(actor.id, org)
    if (!result.ok) return NextResponse.json({ success: false, error: result.message, code: result.code }, { status: result.status })
    return NextResponse.json({ success: true, data: result.data ?? [] })
}

export async function POST(request: NextRequest) {
    const actor = await sessionActor()
    if (!actor) return NextResponse.json({ success: false, error: 'Not authenticated', code: 'UNAUTHENTICATED' }, { status: 401 })
    const body = await request.json().catch(() => ({}))
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
    const incomplete = () => NextResponse.json({ success: false, error: 'The request is incomplete.', code: 'INVALID_INPUT' }, { status: 400 })
    const optionalUuid = (v: unknown) => v === null || v === undefined || v === '' || isUuid(v)
    if (reason.length < 5) {
        return NextResponse.json({ success: false, error: 'Enter a reason (at least 5 characters).', code: 'REASON_REQUIRED' }, { status: 400 })
    }

    if (body?.action === 'set') {
        if (!isUuid(body.employee_user_id) || !optionalUuid(body.manager_user_id)) return incomplete()
        const result = await setReportingLine(actor.id, body.employee_user_id, body.manager_user_id || null, reason)
        if (!result.ok) return NextResponse.json({ success: false, error: result.message, code: result.code }, { status: result.status })
        return NextResponse.json({ success: true, data: result.data })
    }
    if (body?.action === 'reassign') {
        const ids = body.employee_user_ids
        if (!isUuid(body.from_manager_user_id) || !optionalUuid(body.to_manager_user_id)
            || (ids !== undefined && ids !== null && (!Array.isArray(ids) || ids.length === 0 || !ids.every(isUuid)))) return incomplete()
        const result = await reassignDirectReports(actor.id, body.from_manager_user_id, body.to_manager_user_id || null, reason, ids ?? null)
        if (!result.ok) return NextResponse.json({ success: false, error: result.message, code: result.code }, { status: result.status })
        return NextResponse.json({ success: true, data: result.data })
    }
    return incomplete()
}
