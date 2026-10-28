import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getHrAuthContext, hrCan } from '@/lib/server/hrAccess'
import {
    PAYROLL_CALCULATION_FAILED,
    buildPayrollLine,
    eligibilityForPeriod,
    isStatutoryCertified,
    readStatutoryRates,
    summarizePayrollLines,
    validatePayrollLine,
    type CompensationRow,
    type EmploymentRow,
    type PayrollLine,
} from '@/lib/hr/payroll-calculation'

/**
 * POST /api/hr/payroll/runs/:id/calculate — PROVISIONAL calculation, fail-closed (B2B).
 *
 * Every eligible employee gets a line or the run is NOT calculated: any read or line error returns 422 with the list
 * of problems, the run stays draft and no header totals are written. Lines use the real hr_payroll_run_items columns.
 * Leavers (employment ended before the period) and employees not onboarded are excluded and reported.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id: runId } = await params
        const supabase = (await createClient()) as any
        const ctxResult = await getHrAuthContext(supabase)
        if (!ctxResult.success || !ctxResult.data) return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
        const ctx = ctxResult.data
        if (!ctx.organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        if (!(await hrCan(ctx, 'hr.payroll.prepare'))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

        const { data: run, error: runError } = await supabase
            .from('hr_payroll_runs')
            .select('*')
            .eq('id', runId)
            .eq('organization_id', ctx.organizationId)
            .single()
        if (runError || !run) return NextResponse.json({ success: false, error: 'Run not found' }, { status: 404 })
        if (run.status !== 'draft') return NextResponse.json({ success: false, error: 'Can only calculate draft runs' }, { status: 400 })
        const period = { period_start: run.period_start as string, period_end: run.period_end as string }

        // Statutory rates: one config document per organization (hr_settings has no config_key column).
        const { data: settingsRow, error: settingsError } = await supabase
            .from('hr_settings')
            .select('config')
            .eq('organization_id', ctx.organizationId)
            .maybeSingle()
        if (settingsError) return failed([{ step: 'statutory_settings', message: 'Statutory settings could not be read' }])
        const rates = readStatutoryRates(settingsRow?.config)

        const { data: activeComps, error: compError } = await supabase
            .from('hr_employee_compensation')
            .select('employee_id, basic_salary, hourly_rate, ot_eligible, effective_date, end_date, salary_band:hr_salary_bands(ot_rate, ot_eligible)')
            .eq('organization_id', ctx.organizationId)
            .eq('status', 'active')
        if (compError) return failed([{ step: 'compensation', message: 'Compensation could not be read' }])

        const { data: employment, error: employmentError } = await supabase
            .from('hr_employees')
            .select('user_id, onboarding_status, status, end_date')
            .eq('organization_id', ctx.organizationId)
        if (employmentError) return failed([{ step: 'employment', message: 'Employment records could not be read' }])
        const byUser = new Map<string, EmploymentRow>((employment || []).map((e: EmploymentRow) => [e.user_id, e]))

        const excluded: Array<{ employee_user_id: string; reason: string }> = []
        const comps: CompensationRow[] = []
        const seen = new Set<string>()
        for (const comp of (activeComps || []) as CompensationRow[]) {
            const decision = eligibilityForPeriod(byUser.get(comp.employee_id), comp, period)
            if (!decision.eligible) { excluded.push({ employee_user_id: comp.employee_id, reason: decision.reason }); continue }
            if (seen.has(comp.employee_id)) {
                return failed([{ employee_user_id: comp.employee_id, step: 'compensation', message: 'More than one active compensation record covers this period' }])
            }
            seen.add(comp.employee_id)
            comps.push(comp)
        }
        if (comps.length === 0) {
            return NextResponse.json({ success: false, error: 'No eligible employees (onboarded, employed in the period, with active compensation)', excluded }, { status: 400 })
        }

        const lines: PayrollLine[] = []
        const errors: Array<{ employee_user_id?: string; step: string; message: string }> = []
        for (const comp of comps) {
            const [allowancesRes, deductionsRes, timesheetsRes] = await Promise.all([
                supabase.from('hr_employee_allowances').select('amount')
                    .eq('employee_id', comp.employee_id).eq('organization_id', ctx.organizationId)
                    .lte('effective_date', period.period_end).or(`end_date.is.null,end_date.gte.${period.period_start}`),
                supabase.from('hr_employee_deductions').select('amount')
                    .eq('employee_id', comp.employee_id).eq('organization_id', ctx.organizationId)
                    .lte('effective_date', period.period_end).or(`end_date.is.null,end_date.gte.${period.period_start}`),
                supabase.from('hr_timesheets').select('total_minutes, overtime_minutes')
                    .eq('user_id', comp.employee_id).eq('organization_id', ctx.organizationId).eq('status', 'approved')
                    .gte('period_start', period.period_start).lte('period_end', period.period_end),
            ])
            if (allowancesRes.error) { errors.push({ employee_user_id: comp.employee_id, step: 'allowances', message: 'Allowances could not be read' }); continue }
            if (deductionsRes.error) { errors.push({ employee_user_id: comp.employee_id, step: 'deductions', message: 'Deductions could not be read' }); continue }
            if (timesheetsRes.error) { errors.push({ employee_user_id: comp.employee_id, step: 'timesheets', message: 'Approved timesheets could not be read' }); continue }
            const line = buildPayrollLine({
                organizationId: ctx.organizationId, runId, compensation: comp, rates,
                allowances: allowancesRes.data || [], deductions: deductionsRes.data || [], timesheets: timesheetsRes.data || [],
            })
            const problem = validatePayrollLine(line)
            if (problem) { errors.push({ employee_user_id: comp.employee_id, step: 'line', message: problem }); continue }
            lines.push(line)
        }
        if (errors.length > 0) return failed(errors, excluded)

        // Replace the draft's lines in one statement each; a failure leaves the run draft (recalculate to retry).
        const { error: clearError } = await supabase.from('hr_payroll_run_items').delete()
            .eq('payroll_run_id', runId).eq('organization_id', ctx.organizationId)
        if (clearError) return failed([{ step: 'clear_previous_lines', message: 'Previous lines could not be removed' }], excluded)
        const { data: written, error: insertError } = await supabase.from('hr_payroll_run_items').insert(lines).select('id')
        if (insertError || (written || []).length !== lines.length) {
            return failed([{ step: 'write_lines', message: 'Payroll lines could not be written; the run was not calculated' }], excluded)
        }

        const totals = summarizePayrollLines(lines)
        const { data: updatedRun, error: updateError } = await supabase
            .from('hr_payroll_runs')
            .update({ status: 'calculated', ...totals, calculated_at: new Date().toISOString(), calculated_by: ctx.userId })
            .eq('id', runId)
            .eq('organization_id', ctx.organizationId)
            .eq('status', 'draft')
            .select()
            .single()
        if (updateError || !updatedRun) {
            return failed([{ step: 'run_status', message: 'The run could not be marked calculated' }], excluded)
        }

        const { error: auditError } = await supabase.from('hr_payroll_audit').insert({
            organization_id: ctx.organizationId,
            payroll_run_id: runId,
            actor_user_id: ctx.userId,
            action: 'calculate',
            metadata: { employee_count: lines.length, excluded, ...totals, provisional: true, statutory_certified: isStatutoryCertified(settingsRow?.config) },
        })
        if (auditError) console.error('Payroll audit could not be recorded for run', runId)

        return NextResponse.json({
            success: true,
            data: { ...updatedRun, employee_count: lines.length },
            provisional: true,
            statutoryCertified: isStatutoryCertified(settingsRow?.config),
            excluded,
            auditRecorded: !auditError,
        })
    } catch (error: any) {
        console.error('Payroll calculation error:', error)
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 })
    }
}

function failed(errors: Array<{ employee_user_id?: string; step: string; message: string }>, excluded: unknown[] = []) {
    return NextResponse.json(
        { success: false, error: PAYROLL_CALCULATION_FAILED, message: 'The run was not calculated. Fix the listed problems and calculate again.', errors, excluded },
        { status: 422 },
    )
}
