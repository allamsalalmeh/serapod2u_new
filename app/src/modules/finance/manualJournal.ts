// Manual journal entries and journal reversal.
// The database re-checks everything; these helpers give early, clear errors and
// the running totals shown while a journal is typed.

import { isValidPostingDate } from './postingDate'
import { MAX_REASON_LENGTH, toAmount } from './supplierPayment'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const MAX_DESCRIPTION_LENGTH = 200
export const MAX_JOURNAL_REFERENCE_LENGTH = 100
export const MAX_JOURNAL_LINES = 100

/** Journal types that are reversed from their own module, not from the GL. */
export const NON_REVERSIBLE_JOURNAL_TYPES = ['REVERSAL', 'PAYROLL_RUN', 'PAYROLL_PAYMENT', 'EXPENSE_CLAIM', 'EXPENSE_REIMBURSEMENT']

export interface ManualJournalLine {
  account_id: string
  description: string | null
  debit: number
  credit: number
}

export interface ManualJournalInput {
  journalDate: string
  description: string
  reference: string | null
  lines: ManualJournalLine[]
}

export interface JournalTotals {
  debit: number
  credit: number
  difference: number
  balanced: boolean
}

/** Totals of typed lines, in cents to avoid floating point drift. */
export function journalTotals(lines: Array<{ debit?: unknown; credit?: unknown }>): JournalTotals {
  let debitCents = 0
  let creditCents = 0
  for (const line of lines) {
    const debit = toAmount(line.debit)
    const credit = toAmount(line.credit)
    if (Number.isFinite(debit)) debitCents += Math.round(debit * 100)
    if (Number.isFinite(credit)) creditCents += Math.round(credit * 100)
  }
  return {
    debit: debitCents / 100,
    credit: creditCents / 100,
    difference: (debitCents - creditCents) / 100,
    balanced: debitCents === creditCents && debitCents > 0,
  }
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** Validates a manual journal draft sent by the journal form. */
export function parseManualJournalInput(
  body: Record<string, unknown>,
): { ok: true; value: ManualJournalInput } | { ok: false; error: string } {
  if (!isValidPostingDate(body.journalDate)) {
    return { ok: false, error: 'Enter the journal date (YYYY-MM-DD)' }
  }
  const description = optionalText(body.description)
  if (!description) return { ok: false, error: 'Enter a description' }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, error: `The description must be at most ${MAX_DESCRIPTION_LENGTH} characters` }
  }
  const reference = optionalText(body.reference)
  if (reference && reference.length > MAX_JOURNAL_REFERENCE_LENGTH) {
    return { ok: false, error: `The reference must be at most ${MAX_JOURNAL_REFERENCE_LENGTH} characters` }
  }

  if (!Array.isArray(body.lines) || body.lines.length < 2) {
    return { ok: false, error: 'A journal needs at least two lines' }
  }
  if (body.lines.length > MAX_JOURNAL_LINES) {
    return { ok: false, error: `A journal can have at most ${MAX_JOURNAL_LINES} lines` }
  }

  const lines: ManualJournalLine[] = []
  for (const [index, raw] of body.lines.entries()) {
    const n = index + 1
    const line = (raw ?? {}) as Record<string, unknown>
    if (typeof line.account_id !== 'string' || !UUID.test(line.account_id)) {
      return { ok: false, error: `Line ${n}: choose an account` }
    }
    const debit = line.debit === undefined || line.debit === null || line.debit === '' ? 0 : toAmount(line.debit)
    const credit = line.credit === undefined || line.credit === null || line.credit === '' ? 0 : toAmount(line.credit)
    if (!Number.isFinite(debit) || !Number.isFinite(credit) || debit < 0 || credit < 0) {
      return { ok: false, error: `Line ${n}: enter a valid amount` }
    }
    if ((debit > 0) === (credit > 0)) {
      return { ok: false, error: `Line ${n}: enter either a debit or a credit amount` }
    }
    const lineDescription = optionalText(line.description)
    if (lineDescription && lineDescription.length > MAX_DESCRIPTION_LENGTH) {
      return { ok: false, error: `Line ${n}: the description must be at most ${MAX_DESCRIPTION_LENGTH} characters` }
    }
    lines.push({ account_id: line.account_id, description: lineDescription, debit, credit })
  }

  const totals = journalTotals(lines)
  if (!totals.balanced) {
    return {
      ok: false,
      error: `The journal is not balanced: debit RM ${totals.debit.toFixed(2)}, credit RM ${totals.credit.toFixed(2)}`,
    }
  }

  return { ok: true, value: { journalDate: body.journalDate, description, reference, lines } }
}

export type JournalAction =
  | { action: 'post' }
  | { action: 'reverse'; reason: string; reversalDate: string }

/** Validates a post (manual draft) or reverse (posted journal) request. */
export function parseJournalAction(
  journalId: unknown,
  body: Record<string, unknown>,
): { ok: true; value: JournalAction } | { ok: false; error: string } {
  if (typeof journalId !== 'string' || !UUID.test(journalId)) {
    return { ok: false, error: 'A valid journal id is required' }
  }
  if (body.action === 'post') return { ok: true, value: { action: 'post' } }
  if (body.action !== 'reverse') {
    return { ok: false, error: "action must be 'post' or 'reverse'" }
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) return { ok: false, error: 'Enter the reason for the reversal' }
  if (reason.length > MAX_REASON_LENGTH) {
    return { ok: false, error: `The reason must be at most ${MAX_REASON_LENGTH} characters` }
  }
  if (!isValidPostingDate(body.reversalDate)) {
    return { ok: false, error: 'Enter the reversal date (YYYY-MM-DD)' }
  }
  return { ok: true, value: { action: 'reverse', reason, reversalDate: body.reversalDate } }
}

/** Whether the GL screen offers "Reverse" for a journal. */
export function canReverseJournal(journal: {
  status: string
  journal_type: string
  is_reversal?: boolean | null
  reversal_journal_id?: string | null
}): boolean {
  return (
    journal.status === 'POSTED' &&
    !journal.is_reversal &&
    !journal.reversal_journal_id &&
    !NON_REVERSIBLE_JOURNAL_TYPES.includes(journal.journal_type)
  )
}
