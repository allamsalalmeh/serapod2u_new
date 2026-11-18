import { describe, expect, it } from 'vitest'
import { orderDocumentsCompletion } from './order-completion'

const ack = (doc_type: string, payment_percentage?: number | null) => ({ doc_type, status: 'acknowledged', payment_percentage })
const receipt = (pct: number | null) => ({ doc_type: 'RECEIPT', status: 'completed', payment_percentage: pct })
const d2h = { order_type: 'D2H', status: 'approved' }

describe('orderDocumentsCompletion — D2H', () => {
  it('is complete with the final receipt', () => {
    expect(orderDocumentsCompletion(d2h, [ack('SO'), ack('DO'), ack('INVOICE'), ack('PAYMENT'), receipt(30), receipt(100)]).complete).toBe(true)
  })
  it('is not complete when only part is paid', () => {
    const r = orderDocumentsCompletion(d2h, [ack('SO'), ack('DO'), ack('INVOICE'), ack('PAYMENT'), receipt(50)])
    expect(r).toEqual({ complete: false, reason: 'Partially paid, balance pending' })
  })
  it('names the first missing step', () => {
    expect(orderDocumentsCompletion(d2h, [ack('SO'), { doc_type: 'DO', status: 'pending' }]).reason).toBe('Delivery Order not acknowledged')
    expect(orderDocumentsCompletion(d2h, [ack('SO'), ack('DO'), ack('INVOICE'), receipt(30), { doc_type: 'PAYMENT', status: 'pending' }]).reason)
      .toBe('Payment awaiting acknowledgment')
  })
  it('treats a legacy receipt without % as final', () => {
    expect(orderDocumentsCompletion(d2h, [ack('SO'), ack('DO'), ack('INVOICE'), ack('PAYMENT'), receipt(null)]).complete).toBe(true)
  })
})

describe('orderDocumentsCompletion — H2M', () => {
  const h2m = { order_type: 'H2M', status: 'approved' }
  it('is complete with the final receipt or when closed', () => {
    expect(orderDocumentsCompletion(h2m, [ack('PO'), ack('INVOICE'), ack('PAYMENT'), receipt(100)]).complete).toBe(true)
    expect(orderDocumentsCompletion({ order_type: 'H2M', status: 'closed' }, [ack('PO')]).complete).toBe(true)
  })
  it('waits for the balance', () => {
    expect(orderDocumentsCompletion(h2m, [ack('PO'), ack('INVOICE'), ack('PAYMENT'), receipt(30)]).reason).toBe('Deposit paid, balance pending')
    expect(orderDocumentsCompletion(h2m, [ack('PO'), ack('INVOICE'), receipt(30), { doc_type: 'PAYMENT_REQUEST', status: 'pending' }]).reason)
      .toBe('Balance request awaiting acknowledgment')
  })
  it('cancelled is never complete', () => {
    expect(orderDocumentsCompletion({ order_type: 'H2M', status: 'cancelled' }, [ack('PO'), receipt(100)]).complete).toBe(false)
  })
})
