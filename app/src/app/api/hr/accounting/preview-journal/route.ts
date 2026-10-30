import { hrCan } from '@/lib/server/hrAccess'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/hr/accounting/preview-journal
 * Simulate GL posting for a payroll run — returns journal lines + totals without inserting.
 *
 * Body: { payroll_run_id: string, posting_date?: string }
 */
export async function POST(request: NextRequest) {
    try {
        const supabase = await createClient() as any
        const { data: { user }, error: authError } = await supabase.auth.getUser()
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const { data: userData } = await supabase
            .from('users')
            .select('organization_id, roles!inner(role_level)')
            .eq('id', user.id)
            .single()

        if (!userData) return NextResponse.json({ error: 'User not found' }, { status: 404 })

        const { data: companyId } = await supabase.rpc('get_company_id', {
            p_org_id: userData.organization_id,
        })
        if (!companyId) return NextResponse.json({ error: 'Company not found' }, { status: 404 })
        if (!(await hrCan({ userId: user.id, organizationId: userData.organization_id, roleCode: null, roleLevel: (userData.roles as any)?.role_level ?? null },
            'finance.payroll_integration.manage'))) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
        }

        const body = await request.json()
        const { payroll_run_id, posting_date } = body
        if (!payroll_run_id) {
            return NextResponse.json({ error: 'payroll_run_id is required' }, { status: 400 })
        }

        const pDate = posting_date || new Date().toISOString().split('T')[0]

        // ── 1. Load payroll run ──────────────────────────────────────
        const { data: run, error: runErr } = await supabase
            .from('hr_payroll_runs')
            .select('*')
            .eq('id', payroll_run_id)
            .single()

        if (runErr || !run) {
            return NextResponse.json({ error: 'Payroll run not found' }, { status: 404 })
        }

        // ── 2. Load run items (aggregates) ───────────────────────────
        const { data: items, error: itemsErr } = await supabase
            .from('hr_payroll_run_items')
            .select('basic_salary, overtime_amount, allowances_amount, epf_employee, socso_employee, eis_employee, pcb_amount, epf_employer, socso_employer, eis_employer, net_amount, gross_amount')
            .eq('payroll_run_id', payroll_run_id)

        if (itemsErr) {
            return NextResponse.json({ error: itemsErr.message }, { status: 500 })
        }

        if (!items || items.length === 0) {
            return NextResponse.json({
                success: true,
                lines: [],
                totals: { debit: 0, credit: 0, balanced: true },
                employee_count: 0,
                message: 'No payroll items found for this run',
            })
        }

        // ── 3. Aggregate amounts ─────────────────────────────────────
        const agg = {
            basic_salary: 0,
            overtime_amount: 0,
            allowances_amount: 0,
            epf_employee: 0,
            socso_employee: 0,
            eis_employee: 0,
            pcb_amount: 0,
            epf_employer: 0,
            socso_employer: 0,
            eis_employer: 0,
            net_amount: 0,
            gross_salary: 0,
        }

        for (const item of items) {
            agg.basic_salary += Number(item.basic_salary || 0)
            agg.overtime_amount += Number(item.overtime_amount || 0)
            agg.allowances_amount += Number(item.allowances_amount || 0)
            agg.epf_employee += Number(item.epf_employee || 0)
            agg.socso_employee += Number(item.socso_employee || 0)
            agg.eis_employee += Number(item.eis_employee || 0)
            agg.pcb_amount += Number(item.pcb_amount || 0)
            agg.epf_employer += Number(item.epf_employer || 0)
            agg.socso_employer += Number(item.socso_employer || 0)
            agg.eis_employer += Number(item.eis_employer || 0)
            agg.net_amount += Number(item.net_amount || 0)
            agg.gross_salary += Number(item.gross_amount || 0)  // column is gross_amount
        }

        // ── 4. Load component GL mappings ────────────────────────────
        const { data: components } = await supabase
            .from('payroll_components')
            .select(`
        id, code, name, category,
        payroll_component_gl_map (
          debit_gl_account_id,
          credit_gl_account_id,
          is_active
        )
      `)
            .eq('company_id', companyId)
            .eq('is_active', true)

        // Build a code→mapping lookup
        const mappingByCode: Record<string, { debit_id: string | null; credit_id: string | null }> = {}
        for (const comp of (components || [])) {
            const activeMap = (comp.payroll_component_gl_map || []).find((m: any) => m.is_active)
            if (activeMap) {
                mappingByCode[comp.code] = {
                    debit_id: activeMap.debit_gl_account_id,
                    credit_id: activeMap.credit_gl_account_id,
                }
            }
        }

        // ── 5. Load GL account names for display ─────────────────────
        const allAccountIds = new Set<string>()
        for (const m of Object.values(mappingByCode)) {
            if (m.debit_id) allAccountIds.add(m.debit_id)
            if (m.credit_id) allAccountIds.add(m.credit_id)
        }

        // Get clearing account
        const { data: clearingRow } = await supabase
            .from('payroll_clearing_accounts')
            .select('gl_account_id')
            .eq('company_id', companyId)
            .eq('account_type', 'CLEARING')
            .eq('is_default', true)
            .eq('is_active', true)
            .maybeSingle()

        if (clearingRow?.gl_account_id) allAccountIds.add(clearingRow.gl_account_id)

        const { data: accountRows } = await supabase
            .from('gl_accounts')
            .select('id, code, name, account_type')
            .in('id', Array.from(allAccountIds))

        const accountMap: Record<string, { code: string; name: string; account_type: string }> = {}
        for (const a of (accountRows || [])) {
            accountMap[a.id] = { code: a.code, name: a.name, account_type: a.account_type }
        }

        // ── 6. Build preview lines ───────────────────────────────────
        type PreviewLine = {
            component: string
            description: string
            account_code: string
            account_name: string
            debit: number
            credit: number
            missing_mapping?: boolean
        }

        const lines: PreviewLine[] = []
        const missingMappings: string[] = []
        const periodLabel = run.period_start
            ? new Date(run.period_start).toLocaleDateString('en', { month: 'short', year: 'numeric' })
            : ''

        // Helper to add a line
        function addLine(code: string, label: string, amount: number, side: 'debit' | 'credit') {
            if (amount <= 0) return
            const m = mappingByCode[code]
            const accountId = side === 'debit' ? m?.debit_id : m?.credit_id
            if (!accountId) {
                missingMappings.push(`${label} (${side} side)`)
                lines.push({
                    component: code,
                    description: `${label} - ${periodLabel}`,
                    account_code: '???',
                    account_name: `[No ${side} mapping]`,
                    debit: side === 'debit' ? amount : 0,
                    credit: side === 'credit' ? amount : 0,
                    missing_mapping: true,
                })
                return
            }
            const acct = accountMap[accountId]
            lines.push({
                component: code,
                description: `${label} - ${periodLabel}`,
                account_code: acct?.code || '???',
                account_name: acct?.name || 'Unknown',
                debit: side === 'debit' ? amount : 0,
                credit: side === 'credit' ? amount : 0,
            })
        }

        // Earnings DR
        addLine('BASIC', 'Basic Salary', agg.basic_salary, 'debit')
        addLine('OT', 'Overtime', agg.overtime_amount, 'debit')
        addLine('ALLOWANCE', 'Allowances', agg.allowances_amount, 'debit')

        // Net Salary CR (uses BASIC credit mapping → Net Salary Payable)
        addLine('BASIC', 'Net Salary Payable', agg.net_amount, 'credit')

        // Statutory deductions CR
        addLine('EPF_EE', 'EPF Employee', agg.epf_employee, 'credit')
        addLine('SOCSO_EE', 'SOCSO Employee', agg.socso_employee, 'credit')
        addLine('EIS_EE', 'EIS Employee', agg.eis_employee, 'credit')
        addLine('PCB', 'PCB / Income Tax', agg.pcb_amount, 'credit')

        // Employer contributions (DR expense + CR payable)
        addLine('EPF_ER', 'Employer EPF', agg.epf_employer, 'debit')
        addLine('EPF_ER', 'EPF Payable', agg.epf_employer, 'credit')
        addLine('SOCSO_ER', 'Employer SOCSO', agg.socso_employer, 'debit')
        addLine('SOCSO_ER', 'SOCSO Payable', agg.socso_employer, 'credit')
        addLine('EIS_ER', 'Employer EIS', agg.eis_employer, 'debit')
        addLine('EIS_ER', 'EIS Payable', agg.eis_employer, 'credit')

        // ── 7. Calculate totals & balance checking ───────────────────
        let totalDebit = 0
        let totalCredit = 0
        for (const l of lines) {
            totalDebit += l.debit
            totalCredit += l.credit
        }

        const imbalance = Math.round((totalDebit - totalCredit) * 100) / 100
        let clearingLine: PreviewLine | null = null
        if (imbalance !== 0 && clearingRow?.gl_account_id) {
            const acct = accountMap[clearingRow.gl_account_id]
            clearingLine = {
                component: 'CLEARING',
                description: `Payroll Clearing (auto-balance)`,
                account_code: acct?.code || '2300',
                account_name: acct?.name || 'Payroll Clearing',
                debit: imbalance < 0 ? Math.abs(imbalance) : 0,
                credit: imbalance > 0 ? imbalance : 0,
            }
            lines.push(clearingLine)
            totalDebit += clearingLine.debit
            totalCredit += clearingLine.credit
        }

        return NextResponse.json({
            success: true,
            payroll_run_id,
            posting_date: pDate,
            period: periodLabel,
            employee_count: items.length,
            lines,
            totals: {
                debit: Math.round(totalDebit * 100) / 100,
                credit: Math.round(totalCredit * 100) / 100,
                balanced: Math.round(totalDebit * 100) === Math.round(totalCredit * 100),
            },
            missing_mappings: missingMappings,
            has_clearing: !!clearingLine,
        })
    } catch (error) {
        console.error('Error in preview-journal:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
