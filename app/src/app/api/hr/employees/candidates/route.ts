import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getHrAuthContext, hrCan } from '@/lib/server/hrAccess'
import { ONBOARDING_BLOCK_MESSAGES, previewOnboardingCandidate, resolveForOnboarding, searchOnboardingCandidates } from '@/lib/hr/onboarding'

// ─── GET  /api/hr/employees/candidates?q=name             ── name search (selection aid only)
// ─── POST /api/hr/employees/candidates {email?, phone?}    ── canonical identity resolution + preview
// ─── POST /api/hr/employees/candidates {user_id}           ── preview of a selected person
//
// Names never decide identity: a name search only lists people of the HR
// administrator's organization to pick from; matching by identifier goes
// through identity_resolve. Previews are minimal and masked, and the database
// re-checks 'hr.employee.manage' for the caller's organization.

async function context() {
    const supabase = (await createClient()) as any
    const ctxResult = await getHrAuthContext(supabase)
    if (!ctxResult.success || !ctxResult.data) return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
    const ctx = ctxResult.data
    if (!ctx.organizationId) return { error: NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 }) }
    if (!(await hrCan(ctx, 'hr.employee.manage', () => (ctx.roleLevel ?? 99) <= 20))) {
        return { error: NextResponse.json({ success: false, error: 'Insufficient permissions' }, { status: 403 }) }
    }
    return { ctx: { ...ctx, organizationId: ctx.organizationId as string } }
}

export async function GET(request: NextRequest) {
    try {
        const { ctx, error } = await context()
        if (error) return error
        const q = (new URL(request.url).searchParams.get('q') || '').trim().slice(0, 80)
        const result = await searchOnboardingCandidates(ctx.userId, ctx.organizationId, q)
        if (!result.ok) return NextResponse.json({ success: false, error: result.message, code: result.code }, { status: result.status })
        return NextResponse.json({ success: true, data: result.candidates })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    try {
        const { ctx, error } = await context()
        if (error) return error
        const body = await request.json().catch(() => ({}))

        if (typeof body.user_id === 'string' && body.user_id) {
            const preview = await previewOnboardingCandidate(ctx.userId, ctx.organizationId, body.user_id)
            if (!preview.ok) return NextResponse.json({ success: false, error: preview.message, code: preview.code }, { status: preview.status })
            if (!preview.candidate.found) return NextResponse.json({ success: false, error: 'Person not found', code: 'NOT_FOUND' }, { status: 404 })
            return NextResponse.json({ success: true, data: withMessage('EXISTING', preview.candidate) })
        }

        const resolved = await resolveForOnboarding(ctx.userId, ctx.organizationId,
            typeof body.email === 'string' ? body.email : null, typeof body.phone === 'string' ? body.phone : null)
        if (!resolved.ok) return NextResponse.json({ success: false, error: resolved.message, code: resolved.code }, { status: resolved.status })
        if (resolved.outcome === 'NEW_PERSON') return NextResponse.json({ success: true, data: { outcome: 'NEW_PERSON' } })
        return NextResponse.json({ success: true, data: withMessage('EXISTING', resolved.candidate) })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }
}

function withMessage(outcome: 'EXISTING', candidate: any) {
    return {
        outcome,
        candidate,
        block_message: candidate?.block_code ? (ONBOARDING_BLOCK_MESSAGES[candidate.block_code] ?? 'This person cannot be onboarded here.') : null,
    }
}
