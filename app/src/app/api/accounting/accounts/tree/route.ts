import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { fetchPostedLines, toNum } from '@/lib/accounting/report-data'

/**
 * GET /api/accounting/accounts/tree
 * All GL accounts of the company (active and inactive) with their balance:
 * net debit minus credit of posted journal lines up to today (or ?as_at=YYYY-MM-DD).
 * The page builds the Chart of Accounts tree from this (see lib/accounting/coa-tree).
 */
export async function GET(request: NextRequest) {
  try {
    if (process.env.NEXT_PUBLIC_ACCOUNTING_ENABLED !== 'true') {
      return NextResponse.json({ error: 'Accounting module is not enabled' }, { status: 403 })
    }

    const supabase = await createClient() as any
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: userData } = await supabase.from('users').select('organization_id').eq('id', user.id).maybeSingle()
    if (!userData?.organization_id) {
      return NextResponse.json({ error: 'User has no organization' }, { status: 400 })
    }
    if (!(await financeAllowed(user.id, 'finance.ledger.view', () => true, userData.organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { data: companyId, error: companyError } = await supabase
      .rpc('get_company_id', { p_org_id: userData.organization_id })
    if (companyError || !companyId) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 })
    }

    const { data: accounts, error: accError } = await supabase
      .from('gl_accounts')
      .select('id, code, name, account_type, subtype, parent_account_id, is_active')
      .eq('company_id', companyId)
      .order('code', { ascending: true })
    if (accError) return NextResponse.json({ error: accError.message }, { status: 500 })

    const asAt = request.nextUrl.searchParams.get('as_at')
    const { lines, error: linesError } = await fetchPostedLines(supabase, {
      companyId,
      toDate: asAt && /^\d{4}-\d{2}-\d{2}$/.test(asAt) ? asAt : null,
    })
    if (linesError) return NextResponse.json({ error: linesError }, { status: 500 })

    const balances: Record<string, number> = {}
    for (const l of lines) {
      balances[l.account_id] = (balances[l.account_id] || 0) + toNum(l.debit_amount) - toNum(l.credit_amount)
    }
    for (const id of Object.keys(balances)) balances[id] = Math.round(balances[id] * 100) / 100

    return NextResponse.json({ accounts: accounts || [], balances })
  } catch (error) {
    console.error('Error in chart of accounts tree API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
