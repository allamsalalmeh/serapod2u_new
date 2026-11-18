import { describe, expect, it } from 'vitest'
import { agingBucket, buildAging, daysBetween, invoiceBalance, pickPayableInvoiceDocs } from './subledger'

describe('invoiceBalance', () => {
  it('holds money received before the invoice is posted as an advance', () => {
    expect(invoiceBalance({ total: 11200, settled: 5600, posted: false })).toEqual({
      total: 11200, settled: 5600, outstanding: 0, unappliedAdvance: 5600, overpaid: 0, status: 'PARTIAL',
    })
  })

  it('counts every receipt against a posted invoice', () => {
    expect(invoiceBalance({ total: 11200, settled: 7600, posted: true })).toMatchObject({
      outstanding: 3600, unappliedAdvance: 0, status: 'PARTIAL',
    })
    expect(invoiceBalance({ total: 11200, settled: 11200, posted: true })).toMatchObject({
      outstanding: 0, status: 'PAID',
    })
    expect(invoiceBalance({ total: 500, settled: 0, posted: true })).toMatchObject({
      outstanding: 500, status: 'UNPAID',
    })
  })
})

describe('aging', () => {
  it('counts whole days and picks the bucket', () => {
    expect(daysBetween('2026-11-01', '2026-11-10')).toBe(9)
    expect(daysBetween('2026-11-10', '2026-11-01')).toBe(0)
    expect(agingBucket(30)).toBe('current')
    expect(agingBucket(31)).toBe('d31_60')
    expect(agingBucket(90)).toBe('d61_90')
    expect(agingBucket(91)).toBe('d91_120')
    expect(agingBucket(121)).toBe('over_120')
  })

  it('groups open amounts and advances by party', () => {
    const { rows, totals } = buildAging([
      { partyId: 'a', partyName: 'Alpha', invoiceDate: '2026-11-01', outstanding: 1000, unappliedAdvance: 0 },
      { partyId: 'a', partyName: 'Alpha', invoiceDate: '2026-08-01', outstanding: 200, unappliedAdvance: 0 },
      { partyId: 'a', partyName: 'Alpha', invoiceDate: null, outstanding: 0, unappliedAdvance: 300 },
      { partyId: 'b', partyName: 'Beta', invoiceDate: '2026-10-01', outstanding: 0, unappliedAdvance: 0 },
    ], '2026-11-10')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ current: 1000, d91_120: 200, total: 1200, advances: 300, net: 900, openInvoices: 2 })
    expect(totals).toMatchObject({ total: 1200, advances: 300, net: 900 })
  })
})

describe('pickPayableInvoiceDocs', () => {
  it('uses the balance request for split orders and the invoice for single-payment orders', () => {
    const docs = [
      { id: 'inv-split', doc_type: 'INVOICE', order_id: 'split' },
      { id: 'req-split', doc_type: 'PAYMENT_REQUEST', order_id: 'split' },
      { id: 'inv-cod', doc_type: 'INVOICE', order_id: 'cod' },
      { id: 'inv-cod-2', doc_type: 'INVOICE', order_id: 'cod' },
    ]
    expect(pickPayableInvoiceDocs(docs).map((d) => d.id)).toEqual(['req-split', 'inv-cod'])
  })
})
