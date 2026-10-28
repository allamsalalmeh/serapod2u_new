import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import {
  fetchPostedLines, fiscalYearStart, getCompanyHeader, headerAccountIds, isoDate, toNum,
} from '@/lib/accounting/report-data'

/**
 * GET /api/accounting/reports/trial-balance
 *
 * Year-to-date trial balance in the legacy UBS / SQL Account layout
 * ("TRIAL BALANCE - FOR THE MONTH OF SEPTEMBER 2024", A/C NO. | DESCRIPTION | DEBIT | CREDIT).
 *
 *   - Balance sheet accounts (asset / liability / equity): cumulative balance up to `as_at`.
 *   - Income / expense accounts: movements from the start of the fiscal year to `as_at`.
 *   - Results of earlier years that were never closed are carried into retained earnings
 *     (the account with subtype 'Retained Earnings', or a separate B/F line), so the
 *     trial balance still balances.
 *
 * Each account shows its NET balance on the debit or credit side.
 *
 * Query params: as_at (default today; `to` accepted as alias), accountType (optional filter)
 */

const BS_TYPES = ['ASSET', 'LIABILITY', 'EQUITY']

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
    const db = supabase as any
    const { searchParams } = new URL(request.url)
    const asAtDate = searchParams.get('as_at') || searchParams.get('to') || isoDate(new Date())
    const accountType = searchParams.get('accountType')

    const [company, { start: fyStart, fiscalYear }] = await Promise.all([
      getCompanyHeader(db, orgId),
      fiscalYearStart(db, orgId, asAtDate),
    ])

    const { data: allAccounts, error: accError } = await db
      .from('gl_accounts')
      .select('id, code, name, account_type, subtype, parent_account_id, is_active')
      .eq('company_id', orgId)
      .order('code', { ascending: true })
    if (accError) return NextResponse.json({ error: accError.message }, { status: 500 })

    const accounts = (allAccounts || []) as any[]
    const byId: Record<string, any> = {}
    for (const a of accounts) byId[a.id] = a
    const headers = headerAccountIds(accounts)

    const { lines, error: linesError } = await fetchPostedLines(db, { companyId: orgId, toDate: asAtDate })
    if (linesError) return NextResponse.json({ error: linesError }, { status: 500 })

    // Net debit-minus-credit per account, plus prior-year P&L not yet closed
    const net: Record<string, number> = {}
    let priorYearsPL = 0 // debit-minus-credit of P&L postings before the fiscal year start

    for (const l of lines) {
      const acc = byId[l.account_id]
      if (!acc) continue
      const dc = toNum(l.debit_amount) - toNum(l.credit_amount)
      if (BS_TYPES.includes(acc.account_type)) {
        net[acc.id] = (net[acc.id] || 0) + dc
      } else if (l.journal_date >= fyStart) {
        net[acc.id] = (net[acc.id] || 0) + dc
      } else {
        priorYearsPL += dc
      }
    }

    const reAccount = accounts.find(
      (a) => a.account_type === 'EQUITY' && String(a.subtype || '').toLowerCase() === 'retained earnings' && !headers.has(a.id)
    )

    type Row = {
      account_id: string | null; code: string; name: string; account_type: string
      debit: number; credit: number
    }
    const toRow = (id: string | null, code: string, name: string, type: string, n: number): Row => ({
      account_id: id, code, name, account_type: type,
      debit: n > 0.004 ? n : 0,
      credit: n < -0.004 ? -n : 0,
    })

    let rows: Row[] = []
    for (const a of accounts) {
      if (headers.has(a.id)) continue
      let n = net[a.id] || 0
      if (reAccount && a.id === reAccount.id) n += priorYearsPL
      if (Math.abs(n) < 0.005) continue
      rows.push(toRow(a.id, a.code, a.name, a.account_type, n))
    }
    if (!reAccount && Math.abs(priorYearsPL) >= 0.005) {
      rows.push(toRow(null, '', 'RETAINED PROFIT/(LOSS) B/F', 'EQUITY', priorYearsPL))
      rows.sort((x, y) => (x.code || '3999').localeCompare(y.code || '3999'))
    }

    if (accountType) rows = rows.filter((r) => r.account_type === accountType)

    const totals = rows.reduce(
      (t, r) => ({ debit: t.debit + r.debit, credit: t.credit + r.credit }),
      { debit: 0, credit: 0 }
    )

    return NextResponse.json({
      company,
      asAtDate,
      fiscalYearStart: fyStart,
      fiscalYearLabel: fiscalYear?.name || null,
      rows,
      totals,
      balanced: Math.abs(totals.debit - totals.credit) < 0.01,
      accountCount: rows.length,
    })
  } catch (error) {
    console.error('Error in trial balance API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
