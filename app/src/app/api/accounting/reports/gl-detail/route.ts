import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import {
  fetchPostedLines, fiscalYearStart, getCompanyHeader, headerAccountIds, isoDate, toNum,
} from '@/lib/accounting/report-data'

/**
 * GET /api/accounting/reports/gl-detail
 *
 * General ledger in the legacy UBS / SQL Account layout, one block per account:
 *
 *   ACCOUNT NO. : 1000/100        SHARE CAPITAL
 *   DATE  REF.  DESCRIPTION                 DEBIT   CREDIT   BALANCE
 *               BALANCE B/F                                    0.00
 *   ...lines with running balance (debit − credit)...
 *               (totals)                    x.xx     y.yy     z.zz
 *
 * Query params:
 *   account_id – optional; omit for all accounts with activity or a non-zero B/F
 *   from, to   – period; `from` defaults to the start of the fiscal year containing `to`
 *
 * Balance brought forward:
 *   - balance sheet accounts: all postings before `from`
 *   - income / expense accounts: postings from the fiscal year start to the day before `from`
 *     (P&L accounts start each fiscal year at zero, as in UBS)
 *
 * Also returns `accountsList` (all leaf accounts) for the account picker.
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
    const accountId = searchParams.get('account_id') || null
    const toDate = searchParams.get('to') || isoDate(new Date())

    const [company, { start: fyStart, fiscalYear }] = await Promise.all([
      getCompanyHeader(db, orgId),
      fiscalYearStart(db, orgId, toDate),
    ])
    const fromDate = searchParams.get('from') || fyStart
    // P&L accounts restart at the beginning of the fiscal year that contains `from`
    const { start: plStart } = fromDate === fyStart ? { start: fyStart } : await fiscalYearStart(db, orgId, fromDate)

    const { data: allAccounts, error: accError } = await db
      .from('gl_accounts')
      .select('id, code, name, account_type, parent_account_id')
      .eq('company_id', orgId)
      .order('code', { ascending: true })
    if (accError) return NextResponse.json({ error: accError.message }, { status: 500 })

    const accounts = (allAccounts || []) as any[]
    const headers = headerAccountIds(accounts)
    const leafAccounts = accounts.filter((a) => !headers.has(a.id))
    const byId: Record<string, any> = {}
    for (const a of leafAccounts) byId[a.id] = a

    if (accountId && !byId[accountId]) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }

    const { lines, error: linesError } = await fetchPostedLines(db, {
      companyId: orgId,
      toDate,
      accountId: accountId || undefined,
      columns: '*',
    })
    if (linesError) return NextResponse.json({ error: linesError }, { status: 500 })

    type Block = {
      id: string; code: string; name: string; account_type: string
      openingBalance: number
      lines: { date: string; ref: string; description: string; memo: string | null; debit: number; credit: number; balance: number }[]
      totalDebit: number; totalCredit: number; closingBalance: number
    }
    const blocks: Record<string, Block> = {}
    const blockFor = (a: any) => {
      if (!blocks[a.id]) {
        blocks[a.id] = {
          id: a.id, code: a.code, name: a.name, account_type: a.account_type,
          openingBalance: 0, lines: [], totalDebit: 0, totalCredit: 0, closingBalance: 0,
        }
      }
      return blocks[a.id]
    }

    // 1) Split into balance brought forward and period lines
    for (const l of lines) {
      const acc = byId[l.account_id]
      if (!acc) continue
      const dr = toNum(l.debit_amount)
      const cr = toNum(l.credit_amount)
      const date: string = l.journal_date
      const isBS = BS_TYPES.includes(acc.account_type)

      if (date < fromDate) {
        if (isBS || date >= plStart) blockFor(acc).openingBalance += dr - cr
        continue
      }
      const b = blockFor(acc)
      b.totalDebit += dr
      b.totalCredit += cr
      b.lines.push({
        date,
        ref: l.journal_number || '',
        description: l.description || l.line_description || '',
        memo: l.entity_name || null,
        debit: dr,
        credit: cr,
        balance: 0,
      })
    }

    // 2) Running balance per account, in date order (stable within a date)
    for (const b of Object.values(blocks)) {
      b.lines.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0))
      let running = b.openingBalance
      for (const ln of b.lines) {
        running += ln.debit - ln.credit
        ln.balance = running
      }
      b.closingBalance = running
    }

    const result = Object.values(blocks)
      .filter((b) => b.lines.length > 0 || Math.abs(b.openingBalance) >= 0.005)
      .sort((x, y) => x.code.localeCompare(y.code))

    return NextResponse.json({
      company,
      fromDate,
      toDate,
      fiscalYearLabel: fiscalYear?.name || null,
      accounts: result,
      accountsList: leafAccounts.map((a) => ({ id: a.id, code: a.code, name: a.name, account_type: a.account_type })),
      lineCount: result.reduce((n, b) => n + b.lines.length, 0),
    })
  } catch (error) {
    console.error('Error in GL detail API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
