import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { LEDGER_JOURNAL_STATUSES } from '@/lib/accounting/report-data'

/**
 * GET /api/accounting/cash/cashflow — Cash flow analysis
 * 
 * Uses GL journal lines to compute inflows/outflows for bank-linked GL accounts
 * over a date range. Provides operating/investing/financing classification
 * based on account types.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: userData } = await supabase
      .from('users')
      .select('organization_id')
      .eq('id', user.id)
      .single()

    if (!userData?.organization_id) {
      return NextResponse.json({ error: 'User has no organization' }, { status: 400 })
    }
    if (!(await financeAllowed(user.id, 'finance.report.view_sensitive', () => true, userData.organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const orgId = userData.organization_id
    const { searchParams } = new URL(request.url)
    const fromDate = searchParams.get('from') || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10)
    const toDate = searchParams.get('to') || new Date().toISOString().slice(0, 10)

    // 1. Get all bank accounts with their GL account links
    const { data: bankAccounts, error: bankErr } = await supabase
      .from('bank_accounts')
      .select('id, account_name, bank_name, gl_account_id, opening_balance, current_balance, is_active')
      .eq('company_id', orgId)
      .eq('is_active', true)
      .order('account_name')

    if (bankErr) {
      console.error('Error fetching bank accounts:', bankErr)
      return NextResponse.json({ error: bankErr.message }, { status: 500 })
    }

    const cashGLAccountIds = (bankAccounts || []).map((b: any) => b.gl_account_id).filter(Boolean)

    // Also include the default cash account from gl_settings
    const { data: glSettings } = await supabase
      .from('gl_settings')
      .select('cash_account_id')
      .eq('company_id', orgId)
      .single()

    if (glSettings?.cash_account_id && !cashGLAccountIds.includes(glSettings.cash_account_id)) {
      cashGLAccountIds.push(glSettings.cash_account_id)
    }

    if (cashGLAccountIds.length === 0) {
      return NextResponse.json({
        summary: { opening_balance: 0, total_inflows: 0, total_outflows: 0, net_change: 0, closing_balance: 0 },
        by_account: [],
        by_category: { operating: { inflows: 0, outflows: 0, net: 0 }, investing: { inflows: 0, outflows: 0, net: 0 }, financing: { inflows: 0, outflows: 0, net: 0 } },
        period: { from: fromDate, to: toDate },
      })
    }

    // 2. Fetch GL journal lines for cash accounts in the period
    // Using v_gl_journal_lines view
    const { data: journalLines, error: jlErr } = await supabase
      .from('v_gl_journal_lines')
      .select('account_id, account_code, account_name, account_type, debit_amount, credit_amount, journal_date, entity_type, entity_name')
      .eq('company_id', orgId)
      .in('account_id', cashGLAccountIds)
      .gte('journal_date', fromDate)
      .lte('journal_date', toDate)
      .in('journal_status', [...LEDGER_JOURNAL_STATUSES])

    if (jlErr) {
      console.error('Error fetching journal lines:', jlErr)
      return NextResponse.json({ error: jlErr.message }, { status: 500 })
    }

    // 3. Also get counter-party account info for each journal to classify cash flow
    // We need journal lines from the SAME journals but for NON-cash accounts
    // to determine if it's operating/investing/financing
    // For now, use entity_type as a proxy for classification
    let totalInflows = 0
    let totalOutflows = 0
    const operating = { inflows: 0, outflows: 0, net: 0 }
    const investing = { inflows: 0, outflows: 0, net: 0 }
    const financing = { inflows: 0, outflows: 0, net: 0 }

    // For ASSET accounts (cash/bank), debit = inflow, credit = outflow
    const movements: any[] = []
    for (const line of (journalLines || [])) {
      const debit = Number(line.debit_amount) || 0
      const credit = Number(line.credit_amount) || 0
      const inflow = debit
      const outflow = credit

      totalInflows += inflow
      totalOutflows += outflow

      // Classify based on entity_type (proxy for cash flow category)
      // Operating: sales, purchases, receipts, payments
      // Investing: asset purchases (rare in this system)
      // Financing: equity, loans
      const entityType = (line.entity_type || '').toLowerCase()
      let category = 'operating'
      if (['equity', 'loan', 'capital'].some(k => entityType.includes(k))) {
        category = 'financing'
      } else if (['asset', 'investment', 'fixed'].some(k => entityType.includes(k))) {
        category = 'investing'
      }

      if (category === 'operating') { operating.inflows += inflow; operating.outflows += outflow }
      else if (category === 'investing') { investing.inflows += inflow; investing.outflows += outflow }
      else { financing.inflows += inflow; financing.outflows += outflow }

      movements.push({
        date: line.journal_date,
        account_code: line.account_code,
        account_name: line.account_name,
        entity: line.entity_name,
        inflow,
        outflow,
        category,
      })
    }

    operating.net = operating.inflows - operating.outflows
    investing.net = investing.inflows - investing.outflows
    financing.net = financing.inflows - financing.outflows
    const netChange = totalInflows - totalOutflows

    // 4. Compute opening balance — sum of bank_accounts opening_balance
    //    plus any journal line activity before the from date
    const totalOpeningBalance = (bankAccounts || []).reduce((sum: number, b: any) => sum + (parseFloat(b.opening_balance) || 0), 0)

    // Get pre-period activity
    const { data: prePeriodLines } = await supabase
      .from('v_gl_journal_lines')
      .select('debit_amount, credit_amount')
      .eq('company_id', orgId)
      .in('account_id', cashGLAccountIds)
      .lt('journal_date', fromDate)
      .in('journal_status', [...LEDGER_JOURNAL_STATUSES])

    let prePeriodNet = 0
    for (const l of (prePeriodLines || [])) {
      prePeriodNet += (Number(l.debit_amount) || 0) - (Number(l.credit_amount) || 0)
    }

    const openingBalance = totalOpeningBalance + prePeriodNet
    const closingBalance = openingBalance + netChange

    // 5. Per-account breakdown
    const acctMap: Record<string, { name: string; inflows: number; outflows: number }> = {}
    for (const m of movements) {
      if (!acctMap[m.account_code]) {
        acctMap[m.account_code] = { name: m.account_name, inflows: 0, outflows: 0 }
      }
      acctMap[m.account_code].inflows += m.inflow
      acctMap[m.account_code].outflows += m.outflow
    }

    const byAccount = Object.entries(acctMap).map(([code, v]) => ({
      account_code: code,
      account_name: v.name,
      inflows: v.inflows,
      outflows: v.outflows,
      net: v.inflows - v.outflows,
    }))

    return NextResponse.json({
      summary: {
        opening_balance: openingBalance,
        total_inflows: totalInflows,
        total_outflows: totalOutflows,
        net_change: netChange,
        closing_balance: closingBalance,
      },
      by_account: byAccount,
      by_category: { operating, investing, financing },
      bank_accounts: (bankAccounts || []).map((b: any) => ({
        id: b.id,
        account_name: b.account_name,
        bank_name: b.bank_name,
        current_balance: b.current_balance,
      })),
      period: { from: fromDate, to: toDate },
      movement_count: movements.length,
    })
  } catch (error) {
    console.error('Error in cashflow API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
