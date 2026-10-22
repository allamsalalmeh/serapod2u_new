import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import {
  dayBefore, fetchPostedLines, getCompanyHeader, headerAccountIds, isoDate,
  resolveFiscalYear, shiftYear, toNum,
} from '@/lib/accounting/report-data'

/**
 * GET /api/accounting/reports/balance-sheet
 *
 * Balance sheet in the legacy UBS / SQL Account layout:
 *
 *   FIXED ASSETS
 *   CURRENT ASSETS
 *   CURRENT LIABILITIES
 *   NET CURRENT ASSETS
 *   (LONG TERM LIABILITIES)
 *   FINANCED BY
 *     CAPITAL           (share capital, other equity)
 *     RETAINED EARNING  (retained-earnings accounts + all P&L results to date)
 *
 * Each line is a group: the parent (header) account when the account has one,
 * otherwise the account itself. The client's "Detailed" mode lists the accounts
 * under each group (= the UBS supporting schedules).
 *
 * Query params:
 *   as_at    – statement date (YYYY-MM-DD), default today
 *   compare  – 'prev_fy_end' (default: day before the fiscal year containing as_at,
 *              else one year earlier) | 'none'
 *
 * Classification (account_type + subtype, no schema change):
 *   ASSET     + subtype containing fixed / non-current / property / plant → FIXED ASSETS
 *   ASSET     (else)                                                     → CURRENT ASSETS
 *   LIABILITY + subtype containing non-current / long                    → LONG TERM LIABILITIES
 *   LIABILITY (else)                                                     → CURRENT LIABILITIES
 *   EQUITY    + subtype 'Retained Earnings'                              → RETAINED EARNING
 *   EQUITY    (else)                                                     → CAPITAL
 */

interface BSLine { code: string; name: string; current: number; compare: number }
interface BSGroup { key: string; label: string; accounts: BSLine[]; current: number; compare: number }
interface BSSection { key: string; label: string; groups: BSGroup[]; current: number; compare: number }

const isFixedAsset = (st: string) => /fixed|non-current|property|plant/.test(st)
const isLongTermLiability = (st: string) => /non-current|long/.test(st)
const isZero = (n: number) => Math.abs(n) < 0.005

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
    const asAtDate = searchParams.get('as_at') || searchParams.get('asAt') || isoDate(new Date())
    const compareMode = searchParams.get('compare') === 'none' ? 'none' : 'prev_fy_end'

    const [company, fiscalYear] = await Promise.all([
      getCompanyHeader(db, orgId),
      resolveFiscalYear(db, orgId, asAtDate),
    ])
    const compareAt = compareMode === 'none'
      ? null
      : fiscalYear ? dayBefore(fiscalYear.startDate) : shiftYear(asAtDate, -1)

    // ── Accounts ───────────────────────────────────────────────────
    const { data: allAccounts, error: accError } = await db
      .from('gl_accounts')
      .select('id, code, name, account_type, subtype, parent_account_id')
      .eq('company_id', orgId)
      .order('code', { ascending: true })
    if (accError) return NextResponse.json({ error: accError.message }, { status: 500 })

    const accounts = (allAccounts || []) as any[]
    const byId: Record<string, any> = {}
    for (const a of accounts) byId[a.id] = a
    const headers = headerAccountIds(accounts)

    // ── Postings up to the statement date ─────────────────────────
    const { lines, error: linesError } = await fetchPostedLines(db, { companyId: orgId, toDate: asAtDate })
    if (linesError) return NextResponse.json({ error: linesError }, { status: 500 })

    const cur: Record<string, number> = {} // natural-sign balance at as_at
    const cmp: Record<string, number> = {} // natural-sign balance at compare date
    let plCur = 0                          // cumulative profit/(loss) at as_at
    let plCmp = 0

    for (const l of lines) {
      const acc = byId[l.account_id]
      if (!acc) continue
      const dr = toNum(l.debit_amount)
      const cr = toNum(l.credit_amount)
      const inCompare = compareAt !== null && l.journal_date <= compareAt

      if (acc.account_type === 'INCOME' || acc.account_type === 'EXPENSE') {
        const profit = cr - dr // income increases, expense decreases profit
        plCur += profit
        if (inCompare) plCmp += profit
        continue
      }
      const signed = acc.account_type === 'ASSET' ? dr - cr : cr - dr
      cur[acc.id] = (cur[acc.id] || 0) + signed
      if (inCompare) cmp[acc.id] = (cmp[acc.id] || 0) + signed
    }

    // ── Sections ───────────────────────────────────────────────────
    const mk = (key: string, label: string): BSSection => ({ key, label, groups: [], current: 0, compare: 0 })
    const fixedAssets = mk('fixed_assets', 'FIXED ASSETS')
    const currentAssets = mk('current_assets', 'CURRENT ASSETS')
    const currentLiabilities = mk('current_liabilities', 'CURRENT LIABILITIES')
    const longTermLiabilities = mk('long_term_liabilities', 'LONG TERM LIABILITIES')
    const financing = mk('financing', 'FINANCED BY')
    const retained: BSGroup = { key: 'retained', label: 'RETAINED EARNING', accounts: [], current: 0, compare: 0 }

    const addTo = (section: BSSection, a: any, c: number, p: number) => {
      const parent = a.parent_account_id ? byId[a.parent_account_id] : null
      const key = parent ? `p:${parent.id}` : `a:${a.id}`
      const label = String(parent ? parent.name : a.name).toUpperCase()
      let g = section.groups.find((x) => x.key === key)
      if (!g) {
        g = { key, label, accounts: [], current: 0, compare: 0 }
        section.groups.push(g)
      }
      g.accounts.push({ code: a.code, name: a.name, current: c, compare: p })
      g.current += c; g.compare += p
      section.current += c; section.compare += p
    }

    for (const a of accounts) {
      if (headers.has(a.id) || !['ASSET', 'LIABILITY', 'EQUITY'].includes(a.account_type)) continue
      const c = cur[a.id] || 0
      const p = cmp[a.id] || 0
      if (isZero(c) && isZero(p)) continue
      const st = String(a.subtype || '').toLowerCase()

      if (a.account_type === 'EQUITY' && st === 'retained earnings') {
        retained.accounts.push({ code: a.code, name: a.name, current: c, compare: p })
        retained.current += c; retained.compare += p
      } else if (a.account_type === 'ASSET') {
        addTo(isFixedAsset(st) ? fixedAssets : currentAssets, a, c, p)
      } else if (a.account_type === 'LIABILITY') {
        addTo(isLongTermLiability(st) ? longTermLiabilities : currentLiabilities, a, c, p)
      } else {
        addTo(financing, a, c, p) // share capital and other equity
      }
    }

    // Profit/(loss) not yet closed into a retained-earnings account
    if (!isZero(plCur) || !isZero(plCmp)) {
      retained.accounts.push({ code: '', name: 'Accumulated profit/(loss) to date', current: plCur, compare: plCmp })
      retained.current += plCur; retained.compare += plCmp
    }
    if (retained.accounts.length > 0) {
      financing.groups.push(retained)
      financing.current += retained.current
      financing.compare += retained.compare
    }

    const pair = (c: number, p: number) => ({ current: c, compare: p })
    const netCurrentAssets = pair(currentAssets.current - currentLiabilities.current, currentAssets.compare - currentLiabilities.compare)
    const netAssets = pair(
      fixedAssets.current + netCurrentAssets.current - longTermLiabilities.current,
      fixedAssets.compare + netCurrentAssets.compare - longTermLiabilities.compare
    )

    const hasData = [fixedAssets, currentAssets, currentLiabilities, longTermLiabilities, financing]
      .some((x) => x.groups.length > 0)

    return NextResponse.json({
      company,
      asAtDate,
      compareMode,
      compareAt,
      fiscalYearLabel: fiscalYear?.name || null,
      sections: { fixedAssets, currentAssets, currentLiabilities, longTermLiabilities, financing },
      totals: {
        totalAssets: pair(fixedAssets.current + currentAssets.current, fixedAssets.compare + currentAssets.compare),
        totalLiabilities: pair(currentLiabilities.current + longTermLiabilities.current, currentLiabilities.compare + longTermLiabilities.compare),
        netCurrentAssets,
        netAssets,
        financing: pair(financing.current, financing.compare),
      },
      balanced: Math.abs(netAssets.current - financing.current) < 0.01,
      hasData,
    })
  } catch (error) {
    console.error('Error in balance sheet API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
