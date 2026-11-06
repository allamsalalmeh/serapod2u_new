import { describe, expect, it } from 'vitest'
import { canReverseJournal, journalTotals, parseJournalAction, parseManualJournalInput } from './manualJournal'

const A = '10000000-0000-0000-0000-000000005100'
const B = '10000000-0000-0000-0000-000000001110'
const J = '60000000-0000-0000-0000-000000000001'

const valid = {
  journalDate: '2026-10-10',
  description: ' Accrual ',
  reference: '',
  lines: [
    { account_id: A, debit: '100.10', description: 'expense' },
    { account_id: B, credit: 100.1 },
  ],
}

describe('manualJournal', () => {
  it('totals lines in cents', () => {
    expect(journalTotals([{ debit: 0.1 }, { debit: 0.2 }, { credit: 0.3 }])).toEqual({
      debit: 0.3, credit: 0.3, difference: 0, balanced: true,
    })
    expect(journalTotals([{ debit: '' }, { credit: '' }]).balanced).toBe(false)
    expect(journalTotals([{ debit: 50 }, { credit: 40 }]).difference).toBe(10)
  })

  it('accepts a balanced journal and trims text', () => {
    const result = parseManualJournalInput(valid)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.description).toBe('Accrual')
      expect(result.value.reference).toBeNull()
      expect(result.value.lines).toEqual([
        { account_id: A, description: 'expense', debit: 100.1, credit: 0 },
        { account_id: B, description: null, debit: 0, credit: 100.1 },
      ])
    }
  })

  it('rejects bad dates, descriptions and line counts', () => {
    expect(parseManualJournalInput({ ...valid, journalDate: '2026-02-30' })).toMatchObject({ ok: false })
    expect(parseManualJournalInput({ ...valid, description: '  ' })).toEqual({ ok: false, error: 'Enter a description' })
    expect(parseManualJournalInput({ ...valid, lines: [valid.lines[0]] })).toEqual({
      ok: false, error: 'A journal needs at least two lines',
    })
  })

  it('rejects lines without an account, with both sides, or negative', () => {
    expect(parseManualJournalInput({ ...valid, lines: [{ account_id: 'x', debit: 1 }, valid.lines[1]] }))
      .toEqual({ ok: false, error: 'Line 1: choose an account' })
    expect(parseManualJournalInput({ ...valid, lines: [{ account_id: A, debit: 1, credit: 1 }, valid.lines[1]] }))
      .toEqual({ ok: false, error: 'Line 1: enter either a debit or a credit amount' })
    expect(parseManualJournalInput({ ...valid, lines: [valid.lines[0], { account_id: B, credit: -5 }] }))
      .toEqual({ ok: false, error: 'Line 2: enter a valid amount' })
  })

  it('rejects an unbalanced journal', () => {
    const result = parseManualJournalInput({ ...valid, lines: [{ account_id: A, debit: 100 }, { account_id: B, credit: 90 }] })
    expect(result).toEqual({ ok: false, error: 'The journal is not balanced: debit RM 100.00, credit RM 90.00' })
  })

  it('parses post and reverse actions', () => {
    expect(parseJournalAction(J, { action: 'post' })).toEqual({ ok: true, value: { action: 'post' } })
    expect(parseJournalAction(J, { action: 'reverse', reason: ' wrong ', reversalDate: '2026-10-20' })).toEqual({
      ok: true, value: { action: 'reverse', reason: 'wrong', reversalDate: '2026-10-20' },
    })
    expect(parseJournalAction(J, { action: 'reverse', reason: '', reversalDate: '2026-10-20' })).toMatchObject({ ok: false })
    expect(parseJournalAction(J, { action: 'reverse', reason: 'x', reversalDate: '20/10/2026' })).toMatchObject({ ok: false })
    expect(parseJournalAction('bad', { action: 'post' })).toMatchObject({ ok: false })
    expect(parseJournalAction(J, { action: 'delete' })).toMatchObject({ ok: false })
  })

  it('offers reverse only for posted, non-reversal, non-HR journals', () => {
    expect(canReverseJournal({ status: 'POSTED', journal_type: 'ADJUSTMENT' })).toBe(true)
    expect(canReverseJournal({ status: 'POSTED', journal_type: 'SUPPLIER_PAYMENT' })).toBe(true)
    expect(canReverseJournal({ status: 'DRAFT', journal_type: 'ADJUSTMENT' })).toBe(false)
    expect(canReverseJournal({ status: 'POSTED', journal_type: 'REVERSAL', is_reversal: true })).toBe(false)
    expect(canReverseJournal({ status: 'POSTED', journal_type: 'PAYROLL_RUN' })).toBe(false)
    expect(canReverseJournal({ status: 'POSTED', journal_type: 'ADJUSTMENT', reversal_journal_id: J })).toBe(false)
  })
})
