import { describe, expect, it } from 'vitest'
import { adjustmentJournalLines, parseReconRequest, parseReconStart } from './reconciliation'

const ID = '11111111-1111-4111-8111-111111111111'
const ID2 = '22222222-2222-4222-8222-222222222222'

describe('parseReconRequest', () => {
  it('accepts simple actions and rejects unknown ones', () => {
    expect(parseReconRequest({ action: 'submit', id: ID })).toEqual({ ok: true, value: { action: 'submit', id: ID } })
    expect(parseReconRequest({ action: 'delete', id: ID }).ok).toBe(false)
    expect(parseReconRequest({ action: 'submit', id: 'x' }).ok).toBe(false)
  })

  it('needs two lines to match and a reason to void', () => {
    expect(parseReconRequest({ action: 'match', id: ID, statementIds: [ID2] }).ok).toBe(false)
    expect(parseReconRequest({ action: 'match', id: ID, statementIds: [ID2], journalLineIds: [ID] })).toMatchObject({ ok: true })
    expect(parseReconRequest({ action: 'void', id: ID, reason: '  ' }).ok).toBe(false)
  })
})

describe('parseReconStart', () => {
  it('requires account and period end; start date optional', () => {
    expect(parseReconStart({ bank_account_id: ID, period_end: '2026-11-30' })).toEqual({
      ok: true, value: { bankAccountId: ID, periodEnd: '2026-11-30', startDate: null },
    })
    expect(parseReconStart({ bank_account_id: ID }).ok).toBe(false)
  })
})

describe('adjustmentJournalLines', () => {
  it('records a bank charge as Dr expense / Cr bank', () => {
    expect(adjustmentJournalLines({ date: '2026-11-10', money_in: 0, money_out: 15 }, 'bank', 'fees', 'SMS fee')).toEqual([
      { account_id: 'fees', description: 'SMS fee', debit: 15, credit: 0 },
      { account_id: 'bank', description: 'SMS fee', debit: 0, credit: 15 },
    ])
  })

  it('records interest received as Dr bank / Cr income', () => {
    expect(adjustmentJournalLines({ date: '2026-11-10', money_in: 2.5, money_out: 0 }, 'bank', 'interest', 'Interest')).toEqual([
      { account_id: 'bank', description: 'Interest', debit: 2.5, credit: 0 },
      { account_id: 'interest', description: 'Interest', debit: 0, credit: 2.5 },
    ])
  })
})
