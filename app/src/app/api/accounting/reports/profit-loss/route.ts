import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * GET /api/accounting/reports/profit-loss
 *
 * Trading and Profit & Loss Account (layout follows the legacy UBS / SQL Account report):
 *
 *   SALES
 *   COST OF GOODS SOLD
 *   GROSS PROFIT/(LOSS)
 *   OTHER INCOMES
 *   EXPENSES            (grouped by parent/header account, else by subtype)
 *   NET PROFIT/(LOSS)
 *   RETAINED PROFIT/(LOSS) B/F
 *   RETAINED PROFIT/(LOSS) C/F
 *
 * Each line carries the current period amount and a comparative amount
 * (same date range one year earlier, or none). Percentages are computed on the client
 * against total sales of the same column.
 *
 * Query params:
 *   from, to       – period (YYYY-MM-DD). If `from` is missing, the fiscal year that
 *                    contains `to` is used; failing that, 1 January of `to`'s year.
 *   compare        – 'prev_year' (default) | 'none'
 *
 * Classification (uses gl_accounts.account_type + subtype, no schema change):
 *   INCOME  + subtype 'Other Income'                 → OTHER INCOMES
 *   INCOME  (anything else)                          → SALES
 *   EXPENSE + subtype 'Direct Cost' / 'Cost of Sales'→ COST OF GOODS SOLD
 *   EXPENSE (anything else)                          → EXPENSES
 *
 * Schema: gl_accounts has NO is_header column; headers are accounts referenced
 * by another account's parent_account_id.
 */

type Amounts = { current: number; compare: number }
interface PLLine { code: string; name: string; current: number; compare: number }
interface PLGroup { key: string; label: string; accounts: PLLine[]; current: number; compare: number }
interface PLSection { key: 'sales' | 'cogs' | 'other_income' | 'expenses'; label: string; groups: PLGroup[]; current: number; compare: number }

const COGS_SUBTYPES = ['direct cost', 'cost of sales', 'cost of goods sold', 'cogs']
const OTHER_INCOME_SUBTYPES = ['other income']

function isoDate(d: Date) {
  return d.toISOString().split('T')[0]
}

function shiftYear(date: string, years: number) {
  const [y, m, d] = date.split('-').map(Number)
  // Clamp 29 Feb to 28 Feb in non-leap target years
  const target = new Date(Date.UTC(y + years, m - 1, 1))
  const lastDay = new Date(Date.UTC(y + years, m, 0)).getUTCDate()
  target.setUTCDate(Math.min(d, lastDay))
  return isoDate(target)
}

function dayBefore(date: string) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return isoDate(d)
}

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
    const toDate = searchParams.get('to') || isoDate(new Date())
    const compareMode = searchParams.get('compare') === 'none' ? 'none' : 'prev_year'

    // ── Company header (name + registration no.) ───────────────────
    const { data: org } = await (supabase as any)
      .from('organizations')
      .select('org_name, registration_no')
      .eq('id', orgId)
      .maybeSingle()

    // ── Period: explicit `from`, else the fiscal year containing `to` ──
    let fromDate = searchParams.get('from')
    let fiscalYearLabel: string | null = null
    if (!fromDate) {
      try {
        const { data: companyId } = await (supabase as any).rpc('get_company_id', { p_org_id: orgId })
        const { data: fy } = await (supabase as any)
          .from('fiscal_years')
          .select('fiscal_year_name, start_date, end_date')
          .eq('company_id', companyId || orgId)
          .lte('start_date', toDate)
          .gte('end_date', toDate)
          .order('start_date', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (fy?.start_date) {
          fromDate = fy.start_date
          fiscalYearLabel = fy.fiscal_year_name || null
        }
      } catch {
        // fall through to calendar-year default
      }
    }
    if (!fromDate) fromDate = `${toDate.slice(0, 4)}-01-01`

    const compareFrom = compareMode === 'prev_year' ? shiftYear(fromDate, -1) : null
    const compareTo = compareMode === 'prev_year' ? shiftYear(toDate, -1) : null

    // ── Accounts ───────────────────────────────────────────────────
    const { data: allAccounts, error: accError } = await (supabase as any)
      .from('gl_accounts')
      .select('id, code, name, account_type, subtype, parent_account_id')
      .eq('company_id', orgId)
      .order('code', { ascending: true })

    if (accError) {
      return NextResponse.json({ error: accError.message }, { status: 500 })
    }

    const accounts = (allAccounts || []) as any[]
    const byId: Record<string, any> = {}
    for (const a of accounts) byId[a.id] = a
    const parentIds = new Set(accounts.map((a) => a.parent_account_id).filter(Boolean))
    const plLeaves = accounts.filter(
      (a) => ['INCOME', 'EXPENSE'].includes(a.account_type) && !parentIds.has(a.id)
    )
    const retainedEarningsIds = new Set(
      accounts
        .filter((a) => a.account_type === 'EQUITY' && (a.subtype || '').toLowerCase() === 'retained earnings')
        .map((a) => a.id)
    )

    // ── Journal lines: everything up to `to` (B/F needs history) ─────
    // Paged: PostgREST caps a single response (default 1000 rows), which would
    // silently truncate a real year of postings.
    const PAGE = 1000
    const lines: any[] = []
    for (let offset = 0; ; offset += PAGE) {
      const { data: page, error: linesError } = await (supabase as any)
        .from('v_gl_journal_lines')
        .select('account_id, debit_amount, credit_amount, journal_date')
        .eq('company_id', orgId)
        .eq('journal_status', 'POSTED')
        .lte('journal_date', toDate)
        // Stable order so pages neither overlap nor skip rows
        .order('journal_date', { ascending: true })
        .order('journal_id', { ascending: true })
        .order('line_number', { ascending: true })
        .range(offset, offset + PAGE - 1)

      if (linesError) {
        return NextResponse.json({ error: linesError.message }, { status: 500 })
      }
      lines.push(...((page as any[]) || []))
      if (!page || page.length < PAGE) break
    }

    // Natural-sign amount per account: income = credit − debit, expense = debit − credit
    const current: Record<string, number> = {}
    const compare: Record<string, number> = {}
    let retainedBF = 0 // P&L result before `from` + retained-earnings postings before `from`

    for (const l of lines) {
      const acc = byId[l.account_id]
      if (!acc) continue
      const dr = Number(l.debit_amount) || 0
      const cr = Number(l.credit_amount) || 0
      const date: string = l.journal_date

      if (acc.account_type === 'INCOME' || acc.account_type === 'EXPENSE') {
        const signed = acc.account_type === 'INCOME' ? cr - dr : dr - cr
        if (date >= fromDate && date <= toDate) {
          current[acc.id] = (current[acc.id] || 0) + signed
        }
        if (compareFrom && compareTo && date >= compareFrom && date <= compareTo) {
          compare[acc.id] = (compare[acc.id] || 0) + signed
        }
        if (date < fromDate) {
          retainedBF += acc.account_type === 'INCOME' ? signed : -signed
        }
      } else if (retainedEarningsIds.has(acc.id) && date < fromDate) {
        retainedBF += cr - dr
      }
    }

    // ── Build sections ─────────────────────────────────────────────
    const sectionOf = (a: any): PLSection['key'] => {
      const st = (a.subtype || '').toLowerCase()
      if (a.account_type === 'INCOME') return OTHER_INCOME_SUBTYPES.includes(st) ? 'other_income' : 'sales'
      return COGS_SUBTYPES.includes(st) ? 'cogs' : 'expenses'
    }

    const sectionDefs: { key: PLSection['key']; label: string }[] = [
      { key: 'sales', label: 'SALES' },
      { key: 'cogs', label: 'COST OF GOODS SOLD' },
      { key: 'other_income', label: 'OTHER INCOMES' },
      { key: 'expenses', label: 'EXPENSES' },
    ]

    const sections: Record<string, PLSection> = {}
    for (const s of sectionDefs) sections[s.key] = { key: s.key, label: s.label, groups: [], current: 0, compare: 0 }

    for (const a of plLeaves) {
      const cur = current[a.id] || 0
      const cmp = compare[a.id] || 0
      if (Math.abs(cur) < 0.005 && Math.abs(cmp) < 0.005) continue

      const sKey = sectionOf(a)
      const section = sections[sKey]
      const parent = a.parent_account_id ? byId[a.parent_account_id] : null
      const groupKey = parent ? `p:${parent.id}` : `s:${(a.subtype || section.label).toUpperCase()}`
      const groupLabel = parent
        ? String(parent.name).toUpperCase()
        : sKey === 'expenses'
          ? (a.subtype && a.subtype.toLowerCase() !== 'header' ? String(a.subtype).toUpperCase() : 'EXPENSES')
          : section.label

      let group = section.groups.find((g) => g.key === groupKey)
      if (!group) {
        group = { key: groupKey, label: groupLabel, accounts: [], current: 0, compare: 0 }
        section.groups.push(group)
      }
      group.accounts.push({ code: a.code, name: a.name, current: cur, compare: cmp })
      group.current += cur
      group.compare += cmp
      section.current += cur
      section.compare += cmp
    }

    const amt = (cur: number, cmp: number): Amounts => ({ current: cur, compare: cmp })
    const s = sections
    const grossProfit = amt(s.sales.current - s.cogs.current, s.sales.compare - s.cogs.compare)
    const afterOtherIncome = amt(grossProfit.current + s.other_income.current, grossProfit.compare + s.other_income.compare)
    const netProfit = amt(afterOtherIncome.current - s.expenses.current, afterOtherIncome.compare - s.expenses.compare)

    const hasData = sectionDefs.some((d) => sections[d.key].groups.length > 0)

    return NextResponse.json({
      company: {
        name: org?.org_name || null,
        registrationNo: org?.registration_no || null,
      },
      fromDate,
      toDate,
      fiscalYearLabel,
      compareMode,
      compareFrom,
      compareTo,
      sections: sectionDefs.map((d) => sections[d.key]),
      totals: {
        sales: amt(s.sales.current, s.sales.compare),
        cogs: amt(s.cogs.current, s.cogs.compare),
        grossProfit,
        otherIncome: amt(s.other_income.current, s.other_income.compare),
        afterOtherIncome,
        expenses: amt(s.expenses.current, s.expenses.compare),
        netProfit,
        retainedBF: { current: retainedBF, compare: null },
        retainedCF: { current: retainedBF + netProfit.current, compare: null },
      },
      retainedBFAsAt: dayBefore(fromDate),
      hasData,

      // Backward-compatible fields (older callers)
      income: [...s.sales.groups, ...s.other_income.groups].flatMap((g) =>
        g.accounts.map((a) => ({ code: a.code, name: a.name, amount: a.current }))
      ),
      expenses: [...s.cogs.groups, ...s.expenses.groups].flatMap((g) =>
        g.accounts.map((a) => ({ code: a.code, name: a.name, amount: a.current }))
      ),
      totalIncome: s.sales.current + s.other_income.current,
      totalExpense: s.cogs.current + s.expenses.current,
      netProfitLoss: netProfit.current,
    })
  } catch (error) {
    console.error('Error in P&L API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
