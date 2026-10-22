/**
 * Shared data helpers for the financial statement API routes
 * (trial balance, balance sheet, GL detail).
 *
 * - fetchPostedLines: pages through v_gl_journal_lines so a full year of postings
 *   is not silently truncated by the PostgREST row cap (default 1000).
 * - resolveFiscalYear: the fiscal year that contains a date (from fiscal_years).
 * - getCompanyHeader: company name + registration no. for the report header.
 */

export interface PostedLine {
  account_id: string
  debit_amount: number | string | null
  credit_amount: number | string | null
  journal_date: string
  [key: string]: any
}

export interface FiscalYearInfo {
  name: string | null
  startDate: string
  endDate: string
}

const PAGE = 1000

export function isoDate(d: Date) {
  return d.toISOString().split('T')[0]
}

export function dayBefore(date: string) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return isoDate(d)
}

export function shiftYear(date: string, years: number) {
  const [y, m, d] = date.split('-').map(Number)
  const lastDay = new Date(Date.UTC(y + years, m, 0)).getUTCDate()
  return isoDate(new Date(Date.UTC(y + years, m - 1, Math.min(d, lastDay))))
}

/**
 * All POSTED journal lines for a company, optionally filtered by account / date range.
 * Ordered by date, journal and line so paging is stable.
 */
export async function fetchPostedLines(
  supabase: any,
  opts: {
    companyId: string
    columns?: string
    accountId?: string
    fromDate?: string | null
    toDate?: string | null
    beforeDate?: string | null
  }
): Promise<{ lines: PostedLine[]; error: string | null }> {
  const columns = opts.columns || 'account_id, debit_amount, credit_amount, journal_date'
  const lines: PostedLine[] = []

  for (let offset = 0; ; offset += PAGE) {
    let q = supabase
      .from('v_gl_journal_lines')
      .select(columns)
      .eq('company_id', opts.companyId)
      .eq('journal_status', 'POSTED')

    if (opts.accountId) q = q.eq('account_id', opts.accountId)
    if (opts.fromDate) q = q.gte('journal_date', opts.fromDate)
    if (opts.toDate) q = q.lte('journal_date', opts.toDate)
    if (opts.beforeDate) q = q.lt('journal_date', opts.beforeDate)

    const { data, error } = await q
      .order('journal_date', { ascending: true })
      .order('journal_id', { ascending: true })
      .order('line_number', { ascending: true })
      .range(offset, offset + PAGE - 1)

    if (error) return { lines, error: error.message }
    lines.push(...((data as PostedLine[]) || []))
    if (!data || data.length < PAGE) break
  }

  return { lines, error: null }
}

/** Fiscal year containing `date`, or null when none is defined. */
export async function resolveFiscalYear(supabase: any, orgId: string, date: string): Promise<FiscalYearInfo | null> {
  try {
    const { data: companyId } = await supabase.rpc('get_company_id', { p_org_id: orgId })
    const { data: fy } = await supabase
      .from('fiscal_years')
      .select('fiscal_year_name, start_date, end_date')
      .eq('company_id', companyId || orgId)
      .lte('start_date', date)
      .gte('end_date', date)
      .order('start_date', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!fy?.start_date) return null
    return { name: fy.fiscal_year_name || null, startDate: fy.start_date, endDate: fy.end_date }
  } catch {
    return null
  }
}

/** Start of the fiscal year containing `date`; falls back to 1 January. */
export async function fiscalYearStart(supabase: any, orgId: string, date: string) {
  const fy = await resolveFiscalYear(supabase, orgId, date)
  return { start: fy?.startDate || `${date.slice(0, 4)}-01-01`, fiscalYear: fy }
}

export async function getCompanyHeader(supabase: any, orgId: string) {
  const { data: org } = await supabase
    .from('organizations')
    .select('org_name, registration_no')
    .eq('id', orgId)
    .maybeSingle()
  return { name: org?.org_name || null, registrationNo: org?.registration_no || null }
}

export const toNum = (v: unknown) => Number(v) || 0

/** Header accounts are those referenced as parent by another account. */
export function headerAccountIds(accounts: { parent_account_id: string | null }[]) {
  return new Set(accounts.map((a) => a.parent_account_id).filter(Boolean) as string[])
}
