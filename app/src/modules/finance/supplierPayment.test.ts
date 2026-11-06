import { describe, expect, it } from 'vitest'
import { isSupplierPaymentType, parsePaymentDocumentAction, parseSupplierPaymentInput, toAmount } from './supplierPayment'

const BANK = '20000000-0000-0000-0000-000000000002'

describe('supplierPayment', () => {
  it('recognises supplier payment types only', () => {
    expect(isSupplierPaymentType('SUPPLIER_DEPOSIT_PAYMENT')).toBe(true)
    expect(isSupplierPaymentType('SUPPLIER_BALANCE_PAYMENT')).toBe(true)
    expect(isSupplierPaymentType('SUPPLIER_INVOICE_RECOGNITION')).toBe(false)
    expect(isSupplierPaymentType(undefined)).toBe(false)
  })

  it('rounds amounts to cents and rejects non-numbers', () => {
    expect(toAmount('420.005')).toBe(420.01)
    expect(toAmount(300)).toBe(300)
    expect(toAmount('')).toBeNaN()
    expect(toAmount('abc')).toBeNaN()
  })

  it('accepts a partial payment with bank and reference', () => {
    const r = parseSupplierPaymentInput({ amount: '200', bankAccountId: BANK, reference: ' TT001 ', closesDocument: false })
    expect(r).toEqual({ ok: true, value: { amount: 200, bankAccountId: BANK, reference: 'TT001', closesDocument: false } })
  })

  it('defaults to the default bank and closing the document', () => {
    const r = parseSupplierPaymentInput({ amount: 420 })
    expect(r).toEqual({ ok: true, value: { amount: 420, bankAccountId: null, reference: null, closesDocument: true } })
  })

  it('rejects zero, negative or missing amounts', () => {
    expect(parseSupplierPaymentInput({ amount: 0 }).ok).toBe(false)
    expect(parseSupplierPaymentInput({ amount: -5 }).ok).toBe(false)
    expect(parseSupplierPaymentInput({}).ok).toBe(false)
  })

  it('accepts close and reopen with a reason', () => {
    expect(parsePaymentDocumentAction(BANK, { action: 'close', reason: ' Discount agreed ' }))
      .toEqual({ ok: true, value: { action: 'close', reason: 'Discount agreed' } })
    expect(parsePaymentDocumentAction(BANK, { action: 'reopen', reason: 'Closed by mistake' }).ok).toBe(true)
  })

  it('rejects a close or reopen without a reason, with a bad id or a bad action', () => {
    expect(parsePaymentDocumentAction(BANK, { action: 'close', reason: '  ' }).ok).toBe(false)
    expect(parsePaymentDocumentAction('x', { action: 'close', reason: 'r' }).ok).toBe(false)
    expect(parsePaymentDocumentAction(BANK, { action: 'delete', reason: 'r' }).ok).toBe(false)
    expect(parsePaymentDocumentAction(BANK, { action: 'close', reason: 'a'.repeat(301) }).ok).toBe(false)
  })

  it('rejects a malformed bank id or an overlong reference', () => {
    expect(parseSupplierPaymentInput({ amount: 1, bankAccountId: 'x' }).ok).toBe(false)
    expect(parseSupplierPaymentInput({ amount: 1, reference: 'a'.repeat(101) }).ok).toBe(false)
  })
})
