import { allocatePendingAdjustments, type AdjustmentCandidate } from '@/modules/finance/reconciliation'

/**
 * Journals recorded from bank lines (the reconciliation's Record button) that do not close the
 * line yet: drafts waiting to be posted, or posted journals not matched in any reconciliation.
 * Read with the admin client, always filtered by the caller's company.
 */
export const RECON_REFERENCE_PREFIX = 'Bank reconciliation'

interface BankLineRow {
  id: string
  side: 'BANK' | 'BOOK'
  date: string
  money_in: number
  money_out: number
  match_group: string | null
}

export async function loadPendingAdjustments(
  admin: any,
  companyId: string,
  bankGlAccountId: string,
  lines: BankLineRow[],
): Promise<Map<string, AdjustmentCandidate>> {
  const bankLines = lines.filter((l) => l.side === 'BANK' && !l.match_group)
  if (bankLines.length === 0) return new Map()
  const dates = [...new Set(bankLines.map((l) => l.date))]

  const { data: journals, error } = await admin
    .from('gl_journals')
    .select('id, journal_number, status, journal_date')
    .eq('company_id', companyId)
    .eq('is_manual', true)
    .in('status', ['DRAFT', 'POSTED'])
    .in('journal_date', dates)
    .ilike('reference', `${RECON_REFERENCE_PREFIX}%`)
  if (error) throw error
  if (!journals?.length) return new Map()

  const { data: jLines, error: linesError } = await admin
    .from('gl_journal_lines')
    .select('id, journal_id, debit_amount, credit_amount')
    .in('journal_id', journals.map((j: any) => j.id))
    .eq('account_id', bankGlAccountId)
  if (linesError) throw linesError

  const lineIds = (jLines || []).map((l: any) => l.id)
  const { data: matched } = lineIds.length
    ? await admin.from('bank_recon_matches').select('journal_line_id').in('journal_line_id', lineIds)
    : { data: [] }
  const matchedIds = new Set((matched || []).map((m: any) => m.journal_line_id))

  const candidates: AdjustmentCandidate[] = []
  for (const j of journals) {
    const own = (jLines || []).filter((l: any) => l.journal_id === j.id)
    if (own.length === 0) continue
    if (j.status === 'POSTED' && own.some((l: any) => matchedIds.has(l.id))) continue
    const net = own.reduce((s: number, l: any) => s + Number(l.debit_amount || 0) - Number(l.credit_amount || 0), 0)
    candidates.push({ journal_id: j.id, journal_number: j.journal_number, status: j.status, date: j.journal_date, net })
  }
  return allocatePendingAdjustments(bankLines, candidates)
}
