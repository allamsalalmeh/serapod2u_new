/**
 * Bank reconciliation helpers (pure): request parsing and the journal that records
 * a bank-only movement (bank charge, interest) so it can be matched.
 */

export const RECON_ACTIONS = ['auto_match', 'match', 'unmatch', 'submit', 'approve', 'return', 'void', 'adjust'] as const
export type ReconAction = (typeof RECON_ACTIONS)[number]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const uuidList = (v: unknown): string[] | null =>
  v === undefined || v === null ? [] : Array.isArray(v) && v.every(isUuid) ? (v as string[]) : null

export type ReconRequest =
  | { action: 'auto_match' | 'submit' | 'approve'; id: string }
  | { action: 'match'; id: string; statementIds: string[]; journalLineIds: string[] }
  | { action: 'unmatch'; id: string; matchGroup: string }
  | { action: 'return' | 'void'; id: string; reason: string }
  | { action: 'adjust'; id: string; statementLineId: string; accountId: string; description: string }

export function parseReconRequest(body: Record<string, unknown>): { ok: true; value: ReconRequest } | { ok: false; error: string } {
  const action = body.action
  if (typeof action !== 'string' || !(RECON_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, error: 'Unknown action' }
  }
  if (!isUuid(body.id)) return { ok: false, error: 'Reconciliation id is required' }
  const id = body.id

  switch (action as ReconAction) {
    case 'auto_match':
    case 'submit':
    case 'approve':
      return { ok: true, value: { action: action as 'auto_match' | 'submit' | 'approve', id } }
    case 'match': {
      const statementIds = uuidList(body.statementIds)
      const journalLineIds = uuidList(body.journalLineIds)
      if (!statementIds || !journalLineIds) return { ok: false, error: 'Invalid line selection' }
      if (statementIds.length + journalLineIds.length < 2) return { ok: false, error: 'Select at least two lines to match' }
      return { ok: true, value: { action: 'match', id, statementIds, journalLineIds } }
    }
    case 'unmatch':
      if (!isUuid(body.matchGroup)) return { ok: false, error: 'Match is required' }
      return { ok: true, value: { action: 'unmatch', id, matchGroup: body.matchGroup } }
    case 'return':
    case 'void': {
      const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
      if (!reason) return { ok: false, error: 'Enter the reason' }
      if (reason.length > 300) return { ok: false, error: 'The reason is too long (300 characters at most)' }
      return { ok: true, value: { action: action as 'return' | 'void', id, reason } }
    }
    case 'adjust': {
      if (!isUuid(body.statementLineId)) return { ok: false, error: 'Select the bank line to record' }
      if (!isUuid(body.accountId)) return { ok: false, error: 'Select the account for the other side' }
      const description = typeof body.description === 'string' ? body.description.trim() : ''
      if (!description) return { ok: false, error: 'Enter a description' }
      return { ok: true, value: { action: 'adjust', id, statementLineId: body.statementLineId, accountId: body.accountId, description } }
    }
  }
  return { ok: false, error: 'Unknown action' }
}

export function parseReconStart(body: Record<string, unknown>):
  { ok: true; value: { bankAccountId: string; periodEnd: string; startDate: string | null } } | { ok: false; error: string } {
  if (!isUuid(body.bank_account_id)) return { ok: false, error: 'Select the bank account' }
  if (typeof body.period_end !== 'string' || !DATE.test(body.period_end)) return { ok: false, error: 'Enter the period end date' }
  const start = body.start_date
  if (start !== undefined && start !== null && start !== '' && (typeof start !== 'string' || !DATE.test(start))) {
    return { ok: false, error: 'Invalid start date' }
  }
  return {
    ok: true,
    value: { bankAccountId: body.bank_account_id, periodEnd: body.period_end, startDate: (start as string) || null },
  }
}

export interface BankLine {
  date: string
  money_in: number
  money_out: number
}

/** A journal recorded from a bank line (Record) that does not yet close it: a draft, or posted but not matched. */
export interface AdjustmentCandidate {
  journal_id: string
  journal_number: string
  status: 'DRAFT' | 'POSTED'
  date: string
  /** Net movement on the bank's GL account: positive = money in. */
  net: number
}

const cents = (v: number) => Math.round(Number(v) * 100)

/**
 * Pairs each open bank line with at most one pending recorded journal of the same date and amount,
 * so a bank line that already has a journal waiting is not recorded a second time. Two identical
 * bank lines on one day need two journals: each journal is used once.
 */
export function allocatePendingAdjustments(
  bankLines: (BankLine & { id: string; match_group?: string | null })[],
  candidates: AdjustmentCandidate[],
): Map<string, AdjustmentCandidate> {
  const result = new Map<string, AdjustmentCandidate>()
  const used = new Set<string>()
  const ordered = [...candidates].sort((a, b) =>
    a.status === b.status ? a.journal_number.localeCompare(b.journal_number) : a.status === 'POSTED' ? -1 : 1)
  for (const line of bankLines) {
    if (line.match_group) continue
    const net = cents(line.money_in) - cents(line.money_out)
    const hit = ordered.find((c) => !used.has(c.journal_id) && c.date === line.date && cents(c.net) === net)
    if (hit) {
      used.add(hit.journal_id)
      result.set(line.id, hit)
    }
  }
  return result
}

/**
 * Journal lines recording a bank-only movement: money out (charge) is
 * Dr other account / Cr bank; money in (interest, refund) is Dr bank / Cr other account.
 */
export function adjustmentJournalLines(line: BankLine, bankGlAccountId: string, otherAccountId: string, description: string) {
  const amount = Math.round((Number(line.money_in) - Number(line.money_out)) * 100) / 100
  if (amount === 0) throw new Error('The bank line has no amount')
  const abs = Math.abs(amount)
  const bank = { account_id: bankGlAccountId, description, debit: amount > 0 ? abs : 0, credit: amount < 0 ? abs : 0 }
  const other = { account_id: otherAccountId, description, debit: amount < 0 ? abs : 0, credit: amount > 0 ? abs : 0 }
  return amount < 0 ? [other, bank] : [bank, other]
}
