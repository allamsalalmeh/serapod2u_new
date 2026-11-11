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
