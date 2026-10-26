import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))

import { paymentMethodLabel } from './index'

describe('paymentMethodLabel', () => {
  it('names the methods Stripe Checkout offers', () => {
    expect(paymentMethodLabel('stripe')).toBe('Card / FPX / GrabPay')
  })

  it('keeps the other gateways unchanged', () => {
    expect(paymentMethodLabel('billplz')).toBe('FPX / e-Wallet (Billplz)')
    expect(paymentMethodLabel('toyyibpay')).toBe('FPX (ToyyibPay)')
  })
})
