import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getHrAuthContext, hrCan } from '@/lib/server/hrAccess'
import { PAYROLL_STATUTORY_NOT_CERTIFIED, STATUTORY_NOT_CERTIFIED_MESSAGE, isStatutoryCertified } from '@/lib/hr/payroll-calculation'

/**
 * POST /api/hr/payroll/runs/:id/approve
 *
 * Fail-closed (B2B, OD-B2B-1): approval is refused with PAYROLL_STATUTORY_NOT_CERTIFIED until the statutory
 * calculation is certified (hr_settings.config.payroll.statutory_certified = true — set only by an owner-recorded
 * decision, never through an application route). Maker ≠ checker stays enforced in the database
 * (sa_payroll_run_transition_guard).
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id: runId } = await params
        const supabase = (await createClient()) as any
        const ctxResult = await getHrAuthContext(supabase)
        if (!ctxResult.success || !ctxResult.data) return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
        const ctx = ctxResult.data
        if (!ctx.organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        if (!(await hrCan(ctx, 'hr.payroll.approve'))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

        const { data: run, error: runError } = await supabase
            .from('hr_payroll_runs')
            .select('*')
            .eq('id', runId)
            .eq('organization_id', ctx.organizationId)
            .single()
        if (runError || !run) return NextResponse.json({ success: false, error: 'Run not found' }, { status: 404 })
        if (run.status !== 'calculated') return NextResponse.json({ success: false, error: 'Can only approve calculated runs' }, { status: 400 })

        const { data: settingsRow, error: settingsError } = await supabase
            .from('hr_settings')
            .select('config')
            .eq('organization_id', ctx.organizationId)
            .maybeSingle()
        if (settingsError || !isStatutoryCertified(settingsRow?.config)) {
            return NextResponse.json(
                { success: false, error: PAYROLL_STATUTORY_NOT_CERTIFIED, message: STATUTORY_NOT_CERTIFIED_MESSAGE },
                { status: 409 },
            )
        }

        // Approval is authorized above by S&A (hr.payroll.approve). The transition runs with the service role so an
        // approver does not also need payroll-preparation rights on the run rows; direct API transitions remain guarded
        // in the database. approved_by feeds the payroll maker/checker monitor (calculated_by vs approver).
        const admin = createAdminClient() as any
        const approvedAt = new Date().toISOString()
        const { data: updatedRun, error: updateError } = await admin
            .from('hr_payroll_runs')
            .update({
                status: 'approved',
                is_locked: true,
                locked_at: approvedAt,
                approved_by: ctx.userId,
                approved_at: approvedAt,
                posted_at: approvedAt,
                posted_by: ctx.userId,
            })
            .eq('id', runId)
            .eq('organization_id', ctx.organizationId)
            .eq('status', 'calculated')
            .select()
            .single()
        if (updateError || !updatedRun) return NextResponse.json({ success: false, error: 'The run could not be approved' }, { status: 500 })

        const { error: itemsError } = await admin
            .from('hr_payroll_run_items')
            .update({ status: 'approved' })
            .eq('payroll_run_id', runId)
            .eq('organization_id', ctx.organizationId)
        if (itemsError) console.error('Payroll lines could not be marked approved for run', runId)

        const { error: auditError } = await supabase.from('hr_payroll_audit').insert({
            organization_id: ctx.organizationId,
            payroll_run_id: runId,
            actor_user_id: ctx.userId,
            action: 'approve',
            metadata: { approved_at: approvedAt, lines_marked_approved: !itemsError },
        })
        if (auditError) console.error('Payroll audit could not be recorded for run', runId)

        return NextResponse.json({ success: true, data: updatedRun, auditRecorded: !auditError })
    } catch (error: any) {
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}
