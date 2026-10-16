import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { canManageHr, getHrAuthContext, hrCan } from '@/lib/server/hrAccess'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        const { id: runId } = await params
        const supabase = (await createClient()) as any
        const ctxResult = await getHrAuthContext(supabase)
        if (!ctxResult.success || !ctxResult.data) return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
        const ctx = ctxResult.data
        if (!ctx.organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
        if (!(await hrCan(ctx, 'hr.payroll.prepare'))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

        // Get the run
        const { data: run, error: runError } = await supabase
            .from('hr_payroll_runs')
            .select('*')
            .eq('id', runId)
            .eq('organization_id', ctx.organizationId)
            .single()

        if (runError || !run) return NextResponse.json({ success: false, error: 'Run not found' }, { status: 404 })
        if (run.status !== 'draft') return NextResponse.json({ success: false, error: 'Can only calculate draft runs' }, { status: 400 })

        // Get statutory config
        const { data: settingsRow } = await supabase
            .from('hr_settings')
            .select('config')
            .eq('organization_id', ctx.organizationId)
            .eq('config_key', 'statutory_rates')
            .single()

        const rates = settingsRow?.config || {
            epf_employee_rate: 11, epf_employer_rate: 13,
            socso_employee_rate: 0.5, socso_employer_rate: 1.75,
            eis_employee_rate: 0.2, eis_employer_rate: 0.2,
            pcb_enabled: true
        }

        // Get all active employees with compensation
        const { data: activeComps, error: compError } = await supabase
            .from('hr_employee_compensation')
            .select('*, salary_band:hr_salary_bands(*)')
            .eq('organization_id', ctx.organizationId)
            .eq('status', 'active')

        if (compError) return NextResponse.json({ success: false, error: compError.message }, { status: 500 })

        // Payroll covers employees HR has onboarded; employment anchors awaiting
        // onboarding (or reset) have no payroll lines.
        const { data: onboarded, error: onboardedError } = await supabase
            .from('hr_employees')
            .select('user_id')
            .eq('organization_id', ctx.organizationId)
            .eq('onboarding_status', 'completed')
        if (onboardedError) return NextResponse.json({ success: false, error: onboardedError.message }, { status: 500 })
        const onboardedIds = new Set((onboarded || []).map((e: any) => e.user_id))
        const comps = (activeComps || []).filter((comp: any) => onboardedIds.has(comp.employee_id))
        if (comps.length === 0) return NextResponse.json({ success: false, error: 'No onboarded employees with active compensation found' }, { status: 400 })

        // Delete existing items for this run (recalculate)
        await supabase.from('hr_payroll_run_items').delete().eq('payroll_run_id', runId)

        let totalGross = 0, totalNet = 0, totalDeductions = 0, totalEmployerContrib = 0

        for (const comp of comps) {
            const basicSalary = comp.basic_salary || 0

            // Get employee allowances
            const { data: allowances } = await supabase
                .from('hr_employee_allowances')
                .select('amount')
                .eq('employee_id', comp.employee_id)
                .eq('organization_id', ctx.organizationId)
                .lte('effective_date', run.period_end)
                .or(`end_date.is.null,end_date.gte.${run.period_start}`)

            const allowancesAmount = (allowances || []).reduce((s: number, a: any) => s + (a.amount || 0), 0)

            // Get employee deductions (non-statutory)
            const { data: deductions } = await supabase
                .from('hr_employee_deductions')
                .select('amount')
                .eq('employee_id', comp.employee_id)
                .eq('organization_id', ctx.organizationId)
                .lte('effective_date', run.period_end)
                .or(`end_date.is.null,end_date.gte.${run.period_start}`)

            const otherDeductions = (deductions || []).reduce((s: number, d: any) => s + (d.amount || 0), 0)

            // Get approved timesheet work/OT minutes for period
            const { data: timesheets } = await supabase
                .from('hr_timesheets')
                .select('total_work_minutes, total_overtime_minutes')
                .eq('user_id', comp.employee_id)
                .eq('organization_id', ctx.organizationId)
                .eq('status', 'approved')
                .gte('period_start', run.period_start)
                .lte('period_end', run.period_end)

            const workMinutes = (timesheets || []).reduce((s: number, t: any) => s + (t.total_work_minutes || 0), 0)
            const overtimeMinutes = (timesheets || []).reduce((s: number, t: any) => s + (t.total_overtime_minutes || 0), 0)

            // Calculate OT
            const otRate = comp.salary_band?.ot_rate || 1.5
            const otEligible = comp.salary_band?.ot_eligible || false
            const hourlyRate = comp.hourly_rate || (basicSalary / (22 * 8)) // 22 working days * 8 hours
            const overtimeAmount = otEligible ? (overtimeMinutes / 60) * hourlyRate * otRate : 0

            const grossSalary = basicSalary + allowancesAmount + overtimeAmount

            // Statutory calculations
            const epfEmployee = Math.round(grossSalary * (rates.epf_employee_rate || 11) / 100 * 100) / 100
            const epfEmployer = Math.round(grossSalary * (rates.epf_employer_rate || 13) / 100 * 100) / 100
            const socsoEmployee = Math.round(grossSalary * (rates.socso_employee_rate || 0.5) / 100 * 100) / 100
            const socsoEmployer = Math.round(grossSalary * (rates.socso_employer_rate || 1.75) / 100 * 100) / 100
            const eisEmployee = Math.round(grossSalary * (rates.eis_employee_rate || 0.2) / 100 * 100) / 100
            const eisEmployer = Math.round(grossSalary * (rates.eis_employer_rate || 0.2) / 100 * 100) / 100

            // Simple PCB approximation (placeholder — real implementation needs LHDN schedule)
            let pcbAmount = 0
            if (rates.pcb_enabled) {
                const annualIncome = grossSalary * 12
                if (annualIncome > 34000) {
                    const taxableAfterRelief = annualIncome - 9000 - epfEmployee * 12 // personal + EPF relief
                    if (taxableAfterRelief > 70000) pcbAmount = Math.round(((taxableAfterRelief - 70000) * 0.21 + 4600) / 12 * 100) / 100
                    else if (taxableAfterRelief > 50000) pcbAmount = Math.round(((taxableAfterRelief - 50000) * 0.16 + 1600) / 12 * 100) / 100
                    else if (taxableAfterRelief > 35000) pcbAmount = Math.round(((taxableAfterRelief - 35000) * 0.08 + 600) / 12 * 100) / 100
                    else if (taxableAfterRelief > 20000) pcbAmount = Math.round(((taxableAfterRelief - 20000) * 0.03 + 150) / 12 * 100) / 100
                    else if (taxableAfterRelief > 5000) pcbAmount = Math.round((taxableAfterRelief - 5000) * 0.01 / 12 * 100) / 100
                }
            }

            const totalEmployeeDeductions = epfEmployee + socsoEmployee + eisEmployee + pcbAmount + otherDeductions
            const netSalary = grossSalary - totalEmployeeDeductions
            const employerContributions = epfEmployer + socsoEmployer + eisEmployer

            const { error: itemError } = await supabase
                .from('hr_payroll_run_items')
                .insert({
                    payroll_run_id: runId,
                    employee_id: comp.employee_id,
                    basic_salary: basicSalary,
                    overtime_amount: Math.round(overtimeAmount * 100) / 100,
                    allowances_amount: allowancesAmount,
                    work_minutes: workMinutes,
                    overtime_minutes: overtimeMinutes,
                    gross_salary: Math.round(grossSalary * 100) / 100,
                    epf_employee: epfEmployee,
                    epf_employer: epfEmployer,
                    socso_employee: socsoEmployee,
                    socso_employer: socsoEmployer,
                    eis_employee: eisEmployee,
                    eis_employer: eisEmployer,
                    pcb_amount: pcbAmount,
                    other_deductions: otherDeductions,
                    other_allowances: 0,
                    deductions: Math.round(totalEmployeeDeductions * 100) / 100,
                    employer_contributions: Math.round(employerContributions * 100) / 100,
                    net_salary: Math.round(netSalary * 100) / 100,
                    status: 'calculated'
                })

            if (itemError) console.error(`Error computing for employee ${comp.employee_id}:`, itemError.message)

            totalGross += grossSalary
            totalNet += netSalary
            totalDeductions += totalEmployeeDeductions
            totalEmployerContrib += employerContributions
        }

        // Update run
        const { data: updatedRun, error: updateError } = await supabase
            .from('hr_payroll_runs')
            .update({
                status: 'calculated',
                total_gross: Math.round(totalGross * 100) / 100,
                total_net: Math.round(totalNet * 100) / 100,
                total_deductions: Math.round(totalDeductions * 100) / 100,
                total_employer_contributions: Math.round(totalEmployerContrib * 100) / 100,
                employee_count: comps.length,
                calculated_at: new Date().toISOString(),
                calculated_by: ctx.userId
            })
            .eq('id', runId)
            .select()
            .single()

        if (updateError) return NextResponse.json({ success: false, error: updateError.message }, { status: 500 })

        // Audit
        await supabase.from('hr_payroll_audit').insert({
            organization_id: ctx.organizationId,
            payroll_run_id: runId,
            action: 'calculate',
            performed_by: ctx.userId,
            details: { employee_count: comps.length, total_gross: totalGross, total_net: totalNet }
        })

        return NextResponse.json({ success: true, data: updatedRun })
    } catch (error: any) {
        console.error('Payroll calculation error:', error)
        return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
    }
}
