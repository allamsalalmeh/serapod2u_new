import { describe, expect, it } from 'vitest'
import { APPROVED_SALES_STATUSES, isApprovedSalesStatus, salesClassOf, summarizeSales } from './sales-kpi'

describe('Approved Sales classification', () => {
  it('counts every approved-stage status and nothing before approval', () => {
    expect([...APPROVED_SALES_STATUSES]).toEqual(['approved', 'warehouse_packed', 'shipped_distributor', 'closed'])
    for (const s of ['approved', 'warehouse_packed', 'shipped_distributor', 'closed']) expect(isApprovedSalesStatus(s)).toBe(true)
    for (const s of ['draft', 'submitted', 'cancelled', '', null, undefined]) expect(isApprovedSalesStatus(s)).toBe(false)
    expect(salesClassOf('submitted')).toBe('pipeline')
    expect(salesClassOf('cancelled')).toBe('cancelled')
    expect(salesClassOf('draft')).toBe('draft')
  })

  it('splits approved sales, pipeline, cancelled orders and H2M purchases', () => {
    const summary = summarizeSales([
      { status: 'approved', orderType: 'D2H', value: 100.1 },
      { status: 'warehouse_packed', orderType: 'D2H', value: 200.2 },
      { status: 'shipped_distributor', orderType: 'S2D', value: 300 },
      { status: 'closed', orderType: 'D2H', value: 400 },
      { status: 'submitted', orderType: 'D2H', value: 50 },
      { status: 'draft', orderType: 'D2H', value: 999 },
      { status: 'cancelled', orderType: 'D2H', value: 75 },
      { status: 'approved', orderType: 'H2M', value: 5555 },
      { status: 'submitted', orderType: 'H2M', value: 1 },
    ])
    expect(summary).toEqual({
      approvedSalesValue: 1000.3, approvedSalesOrders: 4,
      pipelineValue: 50, pipelineOrders: 1,
      cancelledValue: 75, cancelledOrders: 1,
      purchaseValue: 5555, purchaseOrders: 1,
    })
  })

  it('removes an approved order from Approved Sales once it is cancelled', () => {
    const before = summarizeSales([{ status: 'approved', orderType: 'D2H', value: 500 }])
    const after = summarizeSales([{ status: 'cancelled', orderType: 'D2H', value: 500 }])
    expect(before.approvedSalesValue).toBe(500)
    expect(after.approvedSalesValue).toBe(0)
    expect(after.cancelledValue).toBe(500)
  })
})
