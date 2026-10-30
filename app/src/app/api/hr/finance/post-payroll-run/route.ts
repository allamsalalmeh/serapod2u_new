import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { canManageHr, getHrAuthContext, hrCan } from '@/lib/server/hrAccess'

export async function POST(request: NextRequest) {
    try {
        const supabase = (await createClient()) as any
        const ctxResult = await getHrAuthContext(supabase)
        if (!ctxResult.success || !ctxResult.data) {
            return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
        }

        const ctx = ctxResult.data
        if (!ctx.organizationId) {
            return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        }

        if (!(await hrCan(ctx, 'hr.payroll.release'))) {
            return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
        }

        // B2B (P-F03 containment): this second payroll GL path (hr_post_payroll_run_to_gl, separate idempotency store)
        // is disabled so a run cannot be posted twice. The canonical path is /api/hr/payroll/post-to-gl
        // (post_payroll_run_to_gl). The database function is NOT changed or revoked here (Phase B / Finance owner).
        return NextResponse.json({
            success: false,
            error: 'PAYROLL_GL_ROUTE_RETIRED',
            message: 'This payroll posting route is retired. Use Payroll → Post to GL (the canonical payroll posting path).',
        }, { status: 410 })
    } catch (error: any) {
        console.error('Failed to post payroll run to GL:', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}
