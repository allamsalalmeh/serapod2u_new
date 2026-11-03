import { describe, expect, it } from 'vitest'
import { buildStoreStatusEmail, storeStatusEmailFor } from './order-status-email'
import { REFUND_WINDOW_DAYS, refundWindowEndsAt, refundWindowOpen } from './refund-window'

describe('storeStatusEmailFor', () => {
  it('emails Store customers on delivered, cancelled and refunds that returned money', () => {
    expect(storeStatusEmailFor({ salesChannel: 'store', fromStatus: 'shipped', toStatus: 'delivered' })).toBe('delivered')
    expect(storeStatusEmailFor({ salesChannel: null, fromStatus: 'paid', toStatus: 'cancelled' })).toBe('cancelled')
    expect(storeStatusEmailFor({ salesChannel: 'store', fromStatus: 'delivered', toStatus: 'refunded', moneyReturned: true })).toBe('refunded')
    expect(storeStatusEmailFor({ salesChannel: 'store', fromStatus: 'delivered', toStatus: 'refunded', moneyReturned: false })).toBeNull()
  })

  it('never emails for Outdoor orders, unchanged status or other moves', () => {
    expect(storeStatusEmailFor({ salesChannel: 'outdoor', fromStatus: 'shipped', toStatus: 'delivered' })).toBeNull()
    expect(storeStatusEmailFor({ salesChannel: 'store', fromStatus: 'delivered', toStatus: 'delivered' })).toBeNull()
    expect(storeStatusEmailFor({ salesChannel: 'store', fromStatus: 'paid', toStatus: 'processing' })).toBeNull()
    expect(storeStatusEmailFor({ salesChannel: 'store', fromStatus: 'processing', toStatus: 'shipped' })).toBeNull()
  })
})

describe('buildStoreStatusEmail', () => {
  const order = { order_ref: 'ORD-1', customer_name: 'Aminah Ali', total_amount: 48.8, currency: 'MYR' }

  it('delivered: thanks, how to report a problem, shop again', () => {
    const email = buildStoreStatusEmail('delivered', order)
    expect(email.subject).toBe('Order ORD-1 has been delivered')
    expect(email.text).toContain('Hi Aminah,')
    expect(email.text).toContain('store@serapod.com within 7 days')
    expect(email.html).toContain('Shop again')
  })

  it('cancelled says whether money went back', () => {
    expect(buildStoreStatusEmail('cancelled', order).text).toContain('You have not been charged.')
    expect(buildStoreStatusEmail('cancelled', order, { moneyReturned: true }).text).toMatch(/We have refunded RM\s?48\.80/)
  })

  it('refunded states the amount', () => {
    const email = buildStoreStatusEmail('refunded', order)
    expect(email.subject).toBe('Refund for order ORD-1')
    expect(email.text).toMatch(/We have refunded RM\s?48\.80/)
  })
})

describe('refund window', () => {
  const delivered = '2026-11-01T10:00:00Z'
  it('stays open for 7 days after delivery', () => {
    expect(REFUND_WINDOW_DAYS).toBe(7)
    expect(refundWindowEndsAt(delivered)?.toISOString()).toBe('2026-11-08T10:00:00.000Z')
    expect(refundWindowOpen(delivered, Date.parse('2026-11-08T09:59:00Z'))).toBe(true)
    expect(refundWindowOpen(delivered, Date.parse('2026-11-08T10:01:00Z'))).toBe(false)
  })

  it('does not block when the delivery time is unknown', () => {
    expect(refundWindowEndsAt(null)).toBeNull()
    expect(refundWindowOpen(undefined)).toBe(true)
  })
})
