import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

// ─── Types ────────────────────────────────────────────────────────

type AuditStatus = 'configured' | 'partial' | 'missing'

interface AuditCheck {
    key: string
    label: string
    status: AuditStatus
    detail: string
    link?: string
    linkLabel?: string
    autoSetupKey?: string
    count?: number
    blocker?: boolean        // if true, blocks module usage
}

interface AuditSection {
    section: string
    icon: string
    checks: AuditCheck[]
}

// ─── Helpers ──────────────────────────────────────────────────────

async function getOrgContext(supabase: any) {
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) return null

    const { data: userData } = await supabase
        .from('users')
        .select('organization_id, roles!inner(role_level)')
        .eq('id', user.id)
        .single()

    if (!userData) return null

    // Resolve company_id (for GL tables which use company_id not org_id)
    const { data: companyId } = await supabase
        .rpc('get_company_id', { p_org_id: userData.organization_id })

    return {
        user,
        orgId: userData.organization_id,
        companyId: companyId || userData.organization_id,
        roleLevel: userData.roles.role_level,
    }
}

// ─── GET /api/finance/config/audit ────────────────────────────────

export async function GET() {
    try {
        const supabase = await createClient() as any
        const ctx = await getOrgContext(supabase)
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        if (!(await financeAllowed(ctx.user.id, 'finance.module.view', () => true, ctx.orgId))) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const { companyId } = ctx

        // ═══ Parallel DB queries ═══
        const [
            currencySettingsRes,
            fiscalYearsRes,
            fiscalPeriodsRes,
            glAccountsCountRes,
            glSettingsRes,
            postingRulesRes,
            bankAccountsRes,
            taxCodesRes,
            glJournalsCountRes,
        ] = await Promise.all([
            supabase.from('accounting_currency_settings').select('id, base_currency_code, base_currency_name, decimal_places').eq('company_id', companyId).maybeSingle(),
            supabase.from('fiscal_years').select('id, fiscal_year_name, status, start_date, end_date').eq('company_id', companyId).order('start_date', { ascending: false }),
            supabase.from('fiscal_periods').select('id, status, period_type').eq('company_id', companyId),
            supabase.from('gl_accounts').select('id, account_type, is_active', { count: 'exact' }).eq('company_id', companyId).eq('is_active', true),
            supabase.from('gl_settings').select('*, cash_account_id, ar_control_account_id, ap_control_account_id, supplier_deposit_account_id, sales_revenue_account_id, cogs_account_id, inventory_account_id, customer_deposit_account_id, posting_mode').eq('company_id', companyId).maybeSingle(),
            supabase.from('gl_posting_rules').select('id, document_type, is_active').eq('company_id', companyId),
            supabase.from('bank_accounts').select('id, is_active, is_default, gl_account_id').eq('company_id', companyId),
            supabase.from('tax_codes').select('id, tax_type, is_active').eq('company_id', companyId),
            supabase.from('gl_journals').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
        ])

        // ═══ Parse results ═══
        const currSettings = currencySettingsRes.data
        const fiscalYears = fiscalYearsRes.data || []
        const fiscalPeriods = fiscalPeriodsRes.data || []
        const glAccounts = glAccountsCountRes.data || []
        const glAccountCount = glAccountsCountRes.count || glAccounts.length
        const glSettings = glSettingsRes.data
        const postingRules = postingRulesRes.data || []
        const bankAccounts = bankAccountsRes.data || []
        const taxCodes = taxCodesRes.data || []
        const journalCount = glJournalsCountRes.count || 0

        // Derived checks
        const openFiscalYears = fiscalYears.filter((fy: any) => fy.status === 'open')
        const openPeriods = fiscalPeriods.filter((fp: any) => fp.status === 'open')
        const activeBanks = bankAccounts.filter((ba: any) => ba.is_active)
        const banksWithGL = activeBanks.filter((ba: any) => ba.gl_account_id)
        const activePostingRules = postingRules.filter((pr: any) => pr.is_active)
        const activeTaxCodes = taxCodes.filter((tc: any) => tc.is_active)

        // GL account type check — min required: 1 asset, 1 liability, 1 equity, 1 income, 1 expense
        const accountTypes = new Set(glAccounts.map((a: any) => a.account_type))
        const requiredTypes = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']
        const missingTypes = requiredTypes.filter(t => !accountTypes.has(t))

        // Control accounts check
        const controlAcctFields = [
            { key: 'cash_account_id', label: 'Cash' },
            { key: 'ar_control_account_id', label: 'AR Control' },
            { key: 'ap_control_account_id', label: 'AP Control' },
            { key: 'sales_revenue_account_id', label: 'Sales Revenue' },
            { key: 'cogs_account_id', label: 'COGS' },
            { key: 'inventory_account_id', label: 'Inventory' },
            { key: 'customer_deposit_account_id', label: 'Customer Deposits' },
        ]
        const configuredControls = controlAcctFields.filter(f => glSettings?.[f.key])
        const missingControls = controlAcctFields.filter(f => !glSettings?.[f.key])

        // ═══ Build audit sections ═══
        const sections: AuditSection[] = [
            // ─── A) Company & Fiscal Setup ───
            {
                section: 'Company & Fiscal Setup',
                icon: 'building',
                checks: [
                    {
                        key: 'currency',
                        label: 'Base Currency',
                        status: currSettings?.base_currency_code ? 'configured' : 'missing',
                        detail: currSettings?.base_currency_code
                            ? `${currSettings.base_currency_name} (${currSettings.base_currency_code})`
                            : 'No base currency set — all amounts need a currency',
                        link: 'finance/settings/currency',
                        linkLabel: 'Currency Settings',
                        autoSetupKey: 'default_currency',
                        blocker: true,
                    },
                    {
                        key: 'fiscal_year',
                        label: 'Fiscal Year',
                        status: fiscalYears.length > 0 ? (openFiscalYears.length > 0 ? 'configured' : 'partial') : 'missing',
                        detail: fiscalYears.length > 0
                            ? openFiscalYears.length > 0
                                ? `${fiscalYears.length} fiscal year(s), ${openFiscalYears.length} open`
                                : `${fiscalYears.length} fiscal year(s) but none are open`
                            : 'No fiscal year defined — journals cannot be posted',
                        count: fiscalYears.length,
                        link: 'finance/settings/fiscal-year',
                        linkLabel: 'Fiscal Year & Periods',
                        autoSetupKey: 'default_fiscal_year',
                        blocker: true,
                    },
                    {
                        key: 'fiscal_periods',
                        label: 'Fiscal Periods',
                        status: openPeriods.length > 0 ? 'configured' : fiscalPeriods.length > 0 ? 'partial' : 'missing',
                        detail: openPeriods.length > 0
                            ? `${fiscalPeriods.length} period(s), ${openPeriods.length} open`
                            : fiscalPeriods.length > 0
                                ? `${fiscalPeriods.length} period(s) but none are open`
                                : 'No fiscal periods — create a fiscal year first',
                        count: fiscalPeriods.length,
                        link: 'finance/settings/fiscal-year',
                        linkLabel: 'Fiscal Year & Periods',
                        blocker: true,
                    },
                ],
            },

            // ─── B) Chart of Accounts ───
            {
                section: 'Chart of Accounts',
                icon: 'book',
                checks: [
                    {
                        key: 'gl_accounts',
                        label: 'GL Accounts',
                        status: glAccountCount > 0 ? (missingTypes.length === 0 ? 'configured' : 'partial') : 'missing',
                        detail: glAccountCount > 0
                            ? missingTypes.length === 0
                                ? `${glAccountCount} active account(s) — all 5 account types present`
                                : `${glAccountCount} active account(s) — missing types: ${missingTypes.join(', ')}`
                            : 'No GL accounts — seed the default chart of accounts',
                        count: glAccountCount,
                        link: 'finance/gl/chart-of-accounts',
                        linkLabel: 'Chart of Accounts',
                        autoSetupKey: 'seed_chart_of_accounts',
                        blocker: true,
                    },
                    {
                        key: 'default_accounts',
                        label: 'Default Posting Accounts',
                        status: configuredControls.length === controlAcctFields.length
                            ? 'configured'
                            : configuredControls.length > 0
                                ? 'partial'
                                : 'missing',
                        detail: configuredControls.length === controlAcctFields.length
                            ? `All ${controlAcctFields.length} control accounts mapped`
                            : configuredControls.length > 0
                                ? `${configuredControls.length}/${controlAcctFields.length} mapped — missing: ${missingControls.map(c => c.label).join(', ')}`
                                : 'No control accounts mapped — posting will fail',
                        count: configuredControls.length,
                        link: 'finance/settings/default-accounts',
                        linkLabel: 'Default Accounts',
                        blocker: true,
                    },
                ],
            },

            // ─── C) Posting Rules ───
            {
                section: 'Posting Rules',
                icon: 'cog',
                checks: [
                    {
                        key: 'posting_mode',
                        label: 'Posting Mode',
                        status: 'configured',
                        detail: 'Manual: documents are posted from Pending Postings',
                        link: 'finance/settings/posting-rules',
                        linkLabel: 'Posting Rules',
                    },
                    {
                        key: 'posting_rules',
                        label: 'Document Posting Rules',
                        status: 'configured',
                        detail: 'Not used: postings follow the Default Accounts',
                        count: activePostingRules.length,
                        link: 'finance/settings/default-accounts',
                        linkLabel: 'Default Accounts',
                    },
                ],
            },

            // ─── D) Receivables Setup ───
            {
                section: 'Receivables Setup',
                icon: 'trending',
                checks: [
                    {
                        key: 'ar_control',
                        label: 'AR Control Account',
                        status: glSettings?.ar_control_account_id ? 'configured' : 'missing',
                        detail: glSettings?.ar_control_account_id
                            ? 'AR control account mapped'
                            : 'No AR control account — customer invoices cannot post to GL',
                        link: 'finance/settings/default-accounts',
                        linkLabel: 'Default Accounts',
                        blocker: true,
                    },
                    {
                        key: 'tax_codes',
                        label: 'Tax Setup (SST)',
                        status: activeTaxCodes.length > 0 ? 'configured' : 'partial',
                        detail: activeTaxCodes.length > 0
                            ? `${activeTaxCodes.length} active tax code(s)`
                            : 'No tax codes configured — invoices will be zero-rated',
                        count: activeTaxCodes.length,
                        link: 'finance/settings/default-accounts',
                        linkLabel: 'Tax Settings',
                        autoSetupKey: 'default_tax_codes',
                    },
                ],
            },

            // ─── E) Payables Setup ───
            {
                section: 'Payables Setup',
                icon: 'wallet',
                checks: [
                    {
                        key: 'ap_control',
                        label: 'AP Control Account',
                        status: glSettings?.ap_control_account_id ? 'configured' : 'missing',
                        detail: glSettings?.ap_control_account_id
                            ? 'AP control account mapped'
                            : 'No AP control account — supplier bills cannot post to GL',
                        link: 'finance/settings/default-accounts',
                        linkLabel: 'Default Accounts',
                        blocker: true,
                    },
                    {
                        key: 'supplier_clearing',
                        label: 'Supplier Deposit Account',
                        status: glSettings?.supplier_deposit_account_id ? 'configured' : 'partial',
                        detail: glSettings?.supplier_deposit_account_id
                            ? 'Supplier deposit/clearing account mapped'
                            : 'No supplier clearing account — deposits will not be tracked',
                        link: 'finance/settings/default-accounts',
                        linkLabel: 'Default Accounts',
                    },
                ],
            },

            // ─── F) Cash & Banking ───
            {
                section: 'Cash & Banking',
                icon: 'landmark',
                checks: [
                    {
                        key: 'bank_accounts',
                        label: 'Bank Accounts',
                        status: activeBanks.length > 0 ? 'configured' : 'missing',
                        detail: activeBanks.length > 0
                            ? `${activeBanks.length} active bank account(s)`
                            : 'No bank accounts — payments and receipts need a bank',
                        count: activeBanks.length,
                        link: 'finance/cash/bank-accounts',
                        linkLabel: 'Bank Accounts',
                        blocker: true,
                    },
                    {
                        key: 'bank_gl_mapping',
                        label: 'Bank → GL Mapping',
                        status: banksWithGL.length === activeBanks.length && activeBanks.length > 0
                            ? 'configured'
                            : banksWithGL.length > 0
                                ? 'partial'
                                : activeBanks.length > 0
                                    ? 'missing'
                                    : 'missing',
                        detail: activeBanks.length > 0
                            ? banksWithGL.length === activeBanks.length
                                ? 'All bank accounts linked to GL'
                                : `${banksWithGL.length}/${activeBanks.length} banks linked to GL accounts`
                            : 'Add bank accounts first',
                        link: 'finance/cash/bank-accounts',
                        linkLabel: 'Bank Accounts',
                    },
                    {
                        key: 'cash_account',
                        label: 'Cash Control Account',
                        status: glSettings?.cash_account_id ? 'configured' : 'missing',
                        detail: glSettings?.cash_account_id
                            ? 'Cash control account mapped'
                            : 'No cash account — receipts/payments cannot post',
                        link: 'finance/settings/default-accounts',
                        linkLabel: 'Default Accounts',
                    },
                ],
            },
        ]

        // ═══ Summary stats ═══
        const allChecks = sections.flatMap(s => s.checks)
        const summary = {
            total: allChecks.length,
            configured: allChecks.filter(c => c.status === 'configured').length,
            partial: allChecks.filter(c => c.status === 'partial').length,
            missing: allChecks.filter(c => c.status === 'missing').length,
            blockers: allChecks.filter(c => c.blocker && c.status !== 'configured').length,
        }

        return NextResponse.json({ sections, summary, orgId: ctx.orgId, companyId })
    } catch (error) {
        console.error('Error in Finance config audit:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}

// ─── POST /api/finance/config/audit — Auto-Setup actions ─────────

export async function POST(request: Request) {
    try {
        const supabase = await createClient() as any
        const ctx = await getOrgContext(supabase)
        if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        if (!(await financeAllowed(ctx.user.id, 'finance.settings.manage', () => ctx.roleLevel <= 20, ctx.orgId))) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

        const body = await request.json()
        const { action } = body
        const { companyId } = ctx

        // ── Default Currency (MYR) ──
        if (action === 'default_currency') {
            const { error } = await supabase
                .from('accounting_currency_settings')
                .upsert({
                    company_id: companyId,
                    base_currency_code: 'MYR',
                    base_currency_name: 'Malaysian Ringgit',
                    base_currency_symbol: 'RM',
                    decimal_places: 2,
                    thousand_separator: ',',
                    decimal_separator: '.',
                    symbol_position: 'before',
                }, { onConflict: 'company_id' })
            if (error) return NextResponse.json({ error: error.message }, { status: 400 })
            return NextResponse.json({ success: true, message: 'Base currency set to MYR (Malaysian Ringgit)' })
        }

        // ── Default Fiscal Year (current calendar year) ──
        if (action === 'default_fiscal_year') {
            const year = new Date().getFullYear()
            const startDate = `${year}-01-01`
            const endDate = `${year}-12-31`

            // Check if fiscal year already exists
            const { data: existing } = await supabase
                .from('fiscal_years')
                .select('id')
                .eq('company_id', companyId)
                .eq('fiscal_year_code', `FY${year}`)
                .maybeSingle()

            if (existing) {
                return NextResponse.json({ success: true, message: `Fiscal year FY${year} already exists` })
            }

            // Create fiscal year
            const { data: fy, error: fyError } = await supabase
                .from('fiscal_years')
                .insert({
                    company_id: companyId,
                    fiscal_year_name: `Fiscal Year ${year}`,
                    fiscal_year_code: `FY${year}`,
                    start_date: startDate,
                    end_date: endDate,
                    status: 'open',
                })
                .select('id')
                .single()

            if (fyError) return NextResponse.json({ error: fyError.message }, { status: 400 })

            // Create 12 monthly periods
            const periods = []
            for (let m = 0; m < 12; m++) {
                const pStart = new Date(year, m, 1)
                const pEnd = new Date(year, m + 1, 0) // last day of month
                const monthName = pStart.toLocaleDateString('en-US', { month: 'long' })
                periods.push({
                    company_id: companyId,
                    fiscal_year_id: fy.id,
                    period_number: m + 1,
                    period_name: `${monthName} ${year}`,
                    start_date: pStart.toISOString().split('T')[0],
                    end_date: pEnd.toISOString().split('T')[0],
                    status: 'open',
                    period_type: 'normal',
                })
            }

            const { error: periodError } = await supabase.from('fiscal_periods').insert(periods)
            if (periodError) return NextResponse.json({ error: periodError.message }, { status: 400 })

            return NextResponse.json({
                success: true,
                message: `Fiscal year FY${year} created with 12 monthly periods (all open)`,
            })
        }

        // ── Seed Chart of Accounts ──
        if (action === 'seed_chart_of_accounts') {
            // Delegate to existing seed endpoint
            const seedRes = await fetch(
                `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/accounting/accounts/seed`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Cookie': request.headers.get('cookie') || '',
                    },
                }
            )
            const seedData = await seedRes.json()
            if (!seedRes.ok) return NextResponse.json({ error: seedData.error || 'Seed failed' }, { status: 400 })
            return NextResponse.json({ success: true, message: seedData.message || 'Default chart of accounts seeded successfully' })
        }

        // ── Default Posting Rules ──
        if (action === 'default_posting_rules') {
            const rules = [
                {
                    rule_code: 'SALES_INVOICE',
                    rule_name: 'Sales Invoice Posting',
                    description: 'Auto-post sales invoices: DR AR Control, CR Sales Revenue',
                    document_type: 'SALES_INVOICE',
                    posting_config: { debit: 'ar_control', credit: 'sales_revenue' },
                    is_active: true,
                },
                {
                    rule_code: 'RECEIPT',
                    rule_name: 'Receipt Posting',
                    description: 'Auto-post receipts: DR Cash/Bank, CR AR Control',
                    document_type: 'RECEIPT',
                    posting_config: { debit: 'cash', credit: 'ar_control' },
                    is_active: true,
                },
                {
                    rule_code: 'SUPPLIER_DEPOSIT',
                    rule_name: 'Supplier Deposit Posting',
                    description: 'Auto-post supplier deposits: DR Supplier Deposit, CR Cash/Bank',
                    document_type: 'SUPPLIER_DEPOSIT',
                    posting_config: { debit: 'supplier_deposit', credit: 'cash' },
                    is_active: true,
                },
                {
                    rule_code: 'SUPPLIER_PAYMENT',
                    rule_name: 'Supplier Payment Posting',
                    description: 'Auto-post supplier payments: DR AP Control, CR Cash/Bank',
                    document_type: 'SUPPLIER_PAYMENT',
                    posting_config: { debit: 'ap_control', credit: 'cash' },
                    is_active: true,
                },
            ]

            for (const rule of rules) {
                await supabase
                    .from('gl_posting_rules')
                    .upsert({ company_id: companyId, ...rule }, { onConflict: 'company_id,rule_code' })
            }

            // Also set posting mode to AUTO
            await supabase
                .from('gl_settings')
                .upsert({ company_id: companyId, posting_mode: 'AUTO' }, { onConflict: 'company_id' })

            return NextResponse.json({ success: true, message: `4 default posting rules created, posting mode set to AUTO` })
        }

        // ── Default Tax Codes (Malaysia SST) ──
        if (action === 'default_tax_codes') {
            const codes = [
                { code: 'SR', description: 'Standard Rate (SST 10%)', tax_type: 'SST', rate_percent: 10 },
                { code: 'SR6', description: 'Service Tax (SST 6%)', tax_type: 'SST', rate_percent: 6 },
                { code: 'ZR', description: 'Zero Rated', tax_type: 'ZERO_RATED', rate_percent: 0 },
                { code: 'EX', description: 'Exempt', tax_type: 'EXEMPT', rate_percent: 0 },
                { code: 'OS', description: 'Out of Scope', tax_type: 'EXEMPT', rate_percent: 0 },
            ]

            for (const tc of codes) {
                await supabase
                    .from('tax_codes')
                    .upsert({
                        company_id: companyId,
                        code: tc.code,
                        description: tc.description,
                        tax_type: tc.tax_type,
                        rate_percent: tc.rate_percent,
                        is_active: true,
                    }, { onConflict: 'company_id,code' })
            }

            return NextResponse.json({ success: true, message: '5 Malaysia SST tax codes created (SR 10%, SR6 6%, ZR, EX, OS)' })
        }

        return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    } catch (error) {
        console.error('Error in Finance config auto-setup:', error)
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
}
