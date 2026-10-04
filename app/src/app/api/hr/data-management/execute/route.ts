import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { hrResetExecute, isHrResetKind, isUuid } from '@/lib/hr/data-reset'

// ─── POST /api/hr/data-management/execute ── run an approved reset preview
//
// The database (hr_reset_execute) re-checks everything in one transaction:
// Super Admin + explicit 'hr.data.reset' grant, pre-go-live, typed
// confirmation, reason, preview token (stale previews are refused), request
// id (a repeated submission returns the recorded outcome), dependency
// blockers, snapshot before mutation, permanent audit record.

export async function POST(request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const body = await request.json().catch(() => ({}))
        const { organization_id, kind, request_id, preview_token, reason, confirmation } = body
        if (!isUuid(organization_id) || !isHrResetKind(kind) || !isUuid(request_id)
            || typeof preview_token !== 'string' || !preview_token
            || typeof reason !== 'string' || typeof confirmation !== 'string') {
            return NextResponse.json({ success: false, error: 'The reset request is incomplete.' }, { status: 400 })
        }
        if (reason.trim().length < 10) {
            return NextResponse.json({ success: false, error: 'Enter a reason of at least 10 characters.', code: 'REASON_REQUIRED' }, { status: 400 })
        }

        const executed = await hrResetExecute({
            actorId: user.id,
            organizationId: organization_id,
            kind,
            requestId: request_id,
            previewToken: preview_token,
            reason: reason.trim(),
            confirmation,
        })
        if (!executed.ok) return NextResponse.json({ success: false, error: executed.message, code: executed.code }, { status: executed.status })

        const result = executed.result
        if (result.status === 'stale') {
            return NextResponse.json({ success: false, error: result.message, code: 'PREVIEW_STALE' }, { status: 409 })
        }
        if (result.status === 'blocked') {
            return NextResponse.json({ success: false, error: 'The reset is blocked. Nothing was changed.', code: 'BLOCKED', data: result }, { status: 409 })
        }
        return NextResponse.json({ success: true, data: result })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }
}
