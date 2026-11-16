import { describe, expect, it } from 'vitest'
import {
  orderTermsSummary,
  paymentTermChangeErrorMessage,
  paymentTermFlow,
  paymentTermKind,
  paymentTermLockText,
  termIdForOrder,
  termSourceLabel,
  type PaymentTermOption,
} from './payment-terms'

const options: PaymentTermOption[] = [
  { id: 'a', term_code: '50_50', term_name: '50/50 Split', deposit_percentage: 50, balance_percentage: 50, is_default: true },
  { id: 'b', term_code: '30_70', term_name: '30/70 Split', deposit_percentage: 30, balance_percentage: 70 },
  { id: 'c', term_code: '100_0', term_name: 'Full Prepayment', deposit_percentage: 100, balance_percentage: 0 },
  { id: 'd', term_code: '0_100', term_name: 'Cash on Delivery', deposit_percentage: 0, balance_percentage: 100 },
]

describe('paymentTermKind', () => {
  it('splits only between 0% and 100% deposit', () => {
    expect(paymentTermKind(30)).toBe('split')
    expect(paymentTermKind(100)).toBe('full_prepayment')
    expect(paymentTermKind(0)).toBe('after_invoice')
  })
})

describe('paymentTermFlow', () => {
  it('shows no balance request for full prepayment and cash on delivery', () => {
    expect(paymentTermFlow(options[2])).toContain('No balance request')
    expect(paymentTermFlow(options[3])).toContain('no balance request')
    expect(paymentTermFlow(options[1])).toContain('Balance Request (70%')
  })
})

describe('termIdForOrder', () => {
  it('prefers the saved term id, else matches the split (fractions or percents)', () => {
    expect(termIdForOrder(options, { term_id: 'c', deposit_pct: 1, balance_pct: 0 })).toBe('c')
    expect(termIdForOrder(options, { deposit_pct: 0.3, balance_pct: 0.7 })).toBe('b')
    expect(termIdForOrder(options, { deposit_pct: '0.30000000000000000000', balance_pct: '0.70000000000000000000' })).toBe('b')
    expect(termIdForOrder(options, { deposit_pct: 0.2, balance_pct: 0.8 })).toBeNull()
    expect(termIdForOrder(options, null)).toBeNull()
  })
})

describe('orderTermsSummary', () => {
  it('reads fractions or percents and computes amounts', () => {
    expect(orderTermsSummary({ term_name: '30/70 Split', deposit_pct: 0.3, balance_pct: 0.7 }, 4200)).toMatchObject({
      name: '30/70 Split', kind: 'split', depositPercentage: 30, balancePercentage: 70, depositAmount: 1260, balanceAmount: 2940,
    })
    expect(orderTermsSummary({ deposit_pct: '1.0000', balance_pct: '0' }, 100)).toMatchObject({ kind: 'full_prepayment', depositAmount: 100, balanceAmount: 0 })
    expect(orderTermsSummary(null, 1000)).toMatchObject({ name: '50/50 Split', depositAmount: 500, balanceAmount: 500 })
  })
})

describe('termSourceLabel / lock / errors', () => {
  it('names the partner by order type and shows overrides', () => {
    expect(termSourceLabel({ source: 'partner' }, 'D2H')).toBe("From the distributor's master data")
    expect(termSourceLabel({ source: 'partner' }, 'H2M')).toBe("From the manufacturer's master data")
    expect(termSourceLabel({ source: 'override', changed_by_name: 'Admin Dev', changed_at: '2026-11-15T10:00:00Z' }, 'H2M')).toBe('Changed by Admin Dev on 15/11/2026')
    expect(termSourceLabel({}, 'D2H')).toBe('Saved on the order')
  })
  it('explains locks and errors', () => {
    expect(paymentTermLockText(null)).toBeNull()
    expect(paymentTermLockText('invoice_issued')).toContain('invoice')
    expect(paymentTermChangeErrorMessage({ message: 'payment_terms_locked', details: 'po_acknowledged' })).toContain('purchase order')
    expect(paymentTermChangeErrorMessage({ message: 'reason_required' })).toContain('reason')
  })
})
