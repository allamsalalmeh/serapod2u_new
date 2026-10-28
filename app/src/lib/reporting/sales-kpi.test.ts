import { describe, expect, it } from 'vitest'
import { ACTIVE_ORDER_STATUSES, APPROVED_SALES_STATUSES, isActiveOrderStatus, isApprovedSalesStatus, salesClassOf, summarizeSales } from './sales-kpi'

describe('Active Orders classification', () => {
  it('is Approved Sales + Pipeline: submitted and every approved stage, never draft or cancelled', () => {
    expect([...ACTIVE_ORDER_STATUSES]).toEqual(['submitted', 'approved', 'warehouse_packed', 'shipped_distributor', 'closed'])
    for (const s of ACTIVE_ORDER_STATUSES) expect(isActiveOrderStatus(s)).toBe(true)
    for (const s of ['draft', 'cancelled', '', null, undefined]) expect(isActiveOrderStatus(s)).toBe(false)
  })
})

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
      distributorSalesValue: 700.3, distributorSalesOrders: 3,
      shopSalesValue: 300, shopSalesOrders: 1,
      pipelineValue: 50, pipelineOrders: 1,
      cancelledValue: 75, cancelledOrders: 1,
      purchaseValue: 5555, purchaseOrders: 1,
      unclassifiedOrders: 0, unclassifiedValue: 0,
    })
  })

  it('never counts an order without a recognised type as a sale', () => {
    const summary = summarizeSales([
      { status: 'approved', orderType: null, value: 900 },
      { status: 'approved', orderType: 'X2Y', value: 100 },
      { status: 'approved', orderType: 's2d', value: 40 },
    ])
    expect(summary.approvedSalesValue).toBe(40)
    expect(summary.shopSalesValue).toBe(40)
    expect(summary.unclassifiedOrders).toBe(2)
    expect(summary.unclassifiedValue).toBe(1000)
  })

  it('removes an approved order from Approved Sales once it is cancelled', () => {
    const before = summarizeSales([{ status: 'approved', orderType: 'D2H', value: 500 }])
    const after = summarizeSales([{ status: 'cancelled', orderType: 'D2H', value: 500 }])
    expect(before.approvedSalesValue).toBe(500)
    expect(after.approvedSalesValue).toBe(0)
    expect(after.cancelledValue).toBe(500)
  })
})
