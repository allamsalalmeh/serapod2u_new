import { describe, expect, it } from 'vitest'
import { d2hPaymentErrorMessage, d2hPaymentStatus } from './d2h-payments'

describe('d2hPaymentStatus', () => {
  it('names each state', () => {
    expect(d2hPaymentStatus({ order_total: 3600, paid: 0, verified: 0, order_status: 'approved' }).label).toBe('Not paid yet')
    expect(d2hPaymentStatus({ order_total: 3600, paid: 1080, verified: 0, order_status: 'approved' }).label).toBe('Partially paid: RM 1,080.00 of RM 3,600.00')
    expect(d2hPaymentStatus({ order_total: 3600, paid: 3600, verified: 1080, order_status: 'approved' }).label).toBe('Paid — pending Finance verification')
    expect(d2hPaymentStatus({ order_total: 3600, paid: 3600, verified: 3600, order_status: 'closed' }).label).toBe('Closed — paid and verified')
    expect(d2hPaymentStatus({ order_total: 3600, paid: 1080, verified: 0, order_status: 'cancelled' }).label).toBe('Cancelled')
  })
})

describe('d2hPaymentErrorMessage', () => {
  it('explains database errors', () => {
    expect(d2hPaymentErrorMessage({ message: 'invalid_payment_amount', details: 'outstanding=2520.00' })).toContain('RM 2520.00')
    expect(d2hPaymentErrorMessage({ message: 'payment_proof_required' })).toContain('proof')
    expect(d2hPaymentErrorMessage({ message: 'payment_already_pending' })).toContain('waiting')
  })
})
