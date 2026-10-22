import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
    isRegistrationAction, isUuid, registrationActorCheck, registrationExecute, registrationPreview,
} from '@/lib/hr/employee-registration'

// ─── GET  /api/hr/employees/registration               ── may the caller delete/reset registrations here?
// ─── GET  /api/hr/employees/registration?user_id=…     ── eligibility preview for one employee
// ─── POST /api/hr/employees/registration               ── Delete Employee / Reset HR Registration
//
// Always in the caller's own organization. The database decides everything on
// every call (hr_employee_registration_preview / _execute): explicit
// 'hr.employee.delete' grant, target in the organization, no self action, HR
// not live, dependency blockers re-checked under row locks, preview token,
// request id (a repeat returns the recorded outcome), append-only audit.

async function currentActor() {
    const supabase = (await createClient()) as any
    const { data: { user }, error } = await supabase.auth.getUser()
    if (error || !user) return null
    const { data: profile } = await supabase.from('users').select('id, organization_id').eq('id', user.id).single()
    return profile?.id && profile.organization_id ? { id: profile.id as string, organizationId: profile.organization_id as string } : null
}

export async function GET(request: NextRequest) {
    try {
        const actor = await currentActor()
        if (!actor) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const userId = new URL(request.url).searchParams.get('user_id')
        if (!userId) {
            const check = await registrationActorCheck(actor.id, actor.organizationId)
            if (!check.ok) return NextResponse.json({ success: false, error: check.message, code: check.code }, { status: check.status })
            return NextResponse.json({ success: true, data: check.check })
        }
        if (!isUuid(userId)) return NextResponse.json({ success: false, error: 'The request is incomplete.' }, { status: 400 })

        const preview = await registrationPreview(actor.id, actor.organizationId, userId)
        if (!preview.ok) return NextResponse.json({ success: false, error: preview.message, code: preview.code }, { status: preview.status })
        return NextResponse.json({ success: true, data: preview.preview })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const actor = await currentActor()
        if (!actor) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const body = await request.json().catch(() => ({}))
        const { user_id, action, request_id, preview_token, reason } = body
        if (!isUuid(user_id) || !isRegistrationAction(action) || !isUuid(request_id)
            || typeof preview_token !== 'string' || !preview_token || typeof reason !== 'string') {
            return NextResponse.json({ success: false, error: 'The request is incomplete.' }, { status: 400 })
        }
        if (reason.trim().length < 10) {
            return NextResponse.json({ success: false, error: 'Enter a reason of at least 10 characters.', code: 'REASON_REQUIRED' }, { status: 400 })
        }

        const executed = await registrationExecute({
            actorId: actor.id,
            organizationId: actor.organizationId,
            userId: user_id,
            action,
            requestId: request_id,
            previewToken: preview_token,
            reason: reason.trim(),
        })
        if (!executed.ok) return NextResponse.json({ success: false, error: executed.message, code: executed.code }, { status: executed.status })

        const result = executed.result
        if (result.status === 'stale') {
            return NextResponse.json({ success: false, error: result.message, code: 'PREVIEW_STALE' }, { status: 409 })
        }
        if (result.status === 'blocked') {
            return NextResponse.json({ success: false, error: 'Not allowed for this employee. Nothing was changed.', code: 'BLOCKED', data: result }, { status: 409 })
        }
        return NextResponse.json({ success: true, data: result })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }
}
