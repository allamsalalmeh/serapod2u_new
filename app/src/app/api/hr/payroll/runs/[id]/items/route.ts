import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getHrAuthContext, hrCan } from '@/lib/server/hrAccess'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id: runId } = await params
        const supabase = (await createClient()) as any
        const ctxResult = await getHrAuthContext(supabase)
        if (!ctxResult.success || !ctxResult.data) return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
        const ctx = ctxResult.data
        if (!ctx.organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        if (!(await hrCan(ctx, 'hr.payroll.view'))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

        // Verify run belongs to org
        const { data: run } = await supabase
            .from('hr_payroll_runs')
            .select('id')
            .eq('id', runId)
            .eq('organization_id', ctx.organizationId)
            .single()

        if (!run) return NextResponse.json({ success: false, error: 'Run not found' }, { status: 404 })

        const { data, error } = await supabase
            .from('hr_payroll_run_items')
            .select('*, employee:users(id, full_name, email)')
            .eq('payroll_run_id', runId)
            .order('created_at')

        if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
        return NextResponse.json({ success: true, data: data || [] })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}
