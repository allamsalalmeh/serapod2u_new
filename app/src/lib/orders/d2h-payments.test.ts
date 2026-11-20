import { describe, expect, it } from 'vitest'
import { d2hExpectedPendingAmount, d2hPaymentErrorMessage, d2hPaymentStatus } from './d2h-payments'

describe('d2hPaymentStatus', () => {
  it('names each state', () => {
    expect(d2hPaymentStatus({ order_total: 3600, paid: 0, verified: 0, order_status: 'approved' }).label).toBe('Not paid yet')
    expect(d2hPaymentStatus({ order_total: 3600, paid: 1080, verified: 0, order_status: 'approved' }).label).toBe('Partially paid: RM 1,080.00 of RM 3,600.00')
    expect(d2hPaymentStatus({ order_total: 3600, paid: 3600, verified: 1080, order_status: 'approved' }).label).toBe('Paid — pending Finance verification')
    expect(d2hPaymentStatus({ order_total: 3600, paid: 3600, verified: 3600, order_status: 'closed' }).label).toBe('Closed — paid and verified')
    expect(d2hPaymentStatus({ order_total: 3600, paid: 1080, verified: 0, order_status: 'cancelled' }).label).toBe('Cancelled')
  })
})

describe('d2hExpectedPendingAmount', () => {
  const split = { kind: 'split', depositAmount: 307.2 }
  it('first payment of a split term: the deposit, not the order total', () => {
    expect(d2hExpectedPendingAmount({ paid: 0, outstanding: 1024 }, split)).toBe(307.2)
  })
  it('later payments: what is outstanding', () => {
    expect(d2hExpectedPendingAmount({ paid: 307.2, outstanding: 716.8 }, split)).toBe(716.8)
  })
  it('single-payment terms: what is outstanding', () => {
    expect(d2hExpectedPendingAmount({ paid: 0, outstanding: 1024 }, { kind: 'full_prepayment', depositAmount: 1024 })).toBe(1024)
    expect(d2hExpectedPendingAmount({ paid: 0, outstanding: 1024 }, null)).toBe(1024)
  })
  it('never above what is outstanding', () => {
    expect(d2hExpectedPendingAmount({ paid: 0, outstanding: 200 }, split)).toBe(200)
  })
})

describe('d2hPaymentErrorMessage', () => {
  it('explains database errors', () => {
    expect(d2hPaymentErrorMessage({ message: 'invalid_payment_amount', details: 'outstanding=2520.00' })).toContain('RM 2520.00')
    expect(d2hPaymentErrorMessage({ message: 'payment_proof_required' })).toContain('proof')
    expect(d2hPaymentErrorMessage({ message: 'payment_already_pending' })).toContain('waiting')
  })
})
