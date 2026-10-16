import { describe, expect, it } from 'vitest'
import {
  buildSalesReport,
  buildSettlementReport,
  buildShippingReport,
  periodRange,
  type SalesLine,
  type SettlementRow,
  type ShippingLine,
} from './tiktok-reports'

const NOW = new Date('2026-10-15T04:00:00Z') // Thu 15 Oct 2026, 12:00 Malaysia time
const myt = (local: string) => new Date(`${local}+08:00`).toISOString()
const shops = [{ id: 'sera', name: 'SeraOutdoor' }, { id: 'ell', name: 'Ellbow' }]

describe('periodRange', () => {
  it('builds Malaysia days, Monday weeks and months', () => {
    const day = periodRange('day', '2026-10-14', NOW)
    expect(day).toMatchObject({ start: '2026-10-14', end: '2026-10-15', label: 'Wed, 14 Oct 2026', isCurrent: false, prevDate: '2026-10-13', nextDate: '2026-10-15' })
    expect(day.startIso).toBe('2026-10-13T16:00:00.000Z')
    expect(day.prevCutoffIso).toBe(day.startIso)

    const week = periodRange('week', '2026-10-15', NOW)
    expect(week).toMatchObject({ start: '2026-10-12', end: '2026-10-19', label: '12 – 18 Oct 2026', isCurrent: true, nextDate: null })
    expect(periodRange('week', '2026-10-01', NOW).label).toBe('28 Sep – 4 Oct 2026')
    expect(periodRange('week', '2026-01-01', NOW).label).toBe('29 Dec 2025 – 4 Jan 2026')

    const month = periodRange('month', '2026-10-15', NOW)
    expect(month).toMatchObject({ start: '2026-10-01', end: '2026-11-01', label: 'October 2026', prevDate: '2026-09-01', compareLabel: 'vs same point last month' })
    expect(periodRange('month', '2026-01-20', NOW)).toMatchObject({ start: '2026-01-01', prevDate: '2025-12-01' })
  })

  it('compares an unfinished period with the same stretch of the previous one', () => {
    const today = periodRange('day', '2026-10-15', NOW)
    expect(today.prevStartIso).toBe(myt('2026-10-14T00:00:00'))
    expect(today.prevCutoffIso).toBe(myt('2026-10-14T12:00:00'))
    const month = periodRange('month', '2026-10-15', NOW)
    expect(month.prevCutoffIso).toBe(myt('2026-09-15T12:00:00'))
    const fullMonth = periodRange('month', '2026-08-10', NOW)
    expect(fullMonth.prevCutoffIso).toBe(myt('2026-08-01T00:00:00'))
  })
})

describe('buildSalesReport', () => {
  const line = (over: Partial<SalesLine>): SalesLine => ({
    shop_id: 'sera', order_id: '1', product_name: 'Camping Chair', seller_sku: 'CHAIR', order_status: 'Completed',
    quantity: 1, subtotal_after_discount: '10.10', created_time: myt('2026-10-14T09:00:00'), ...over,
  })
  const range = periodRange('week', '2026-10-15', NOW)
  const lines = [
    line({ order_id: '1', quantity: 2, subtotal_after_discount: '20.20' }),
    line({ order_id: '1', product_name: 'Table', seller_sku: 'T1L', subtotal_after_discount: '0.10' }),
    line({ order_id: '2', shop_id: 'ell', product_name: 'Cat Food', seller_sku: 'CF', subtotal_after_discount: '30.00', created_time: myt('2026-10-12T00:00:00') }),
    line({ order_id: '3', order_status: 'Canceled', subtotal_after_discount: '99' }),
    line({ order_id: '4', order_status: 'Unpaid', subtotal_after_discount: '99' }),
    line({ order_id: '5', subtotal_after_discount: '99', created_time: myt('2026-10-19T00:00:00') }),
    line({ order_id: '9', subtotal_after_discount: '25.15', created_time: myt('2026-10-06T10:00:00') }),
    line({ order_id: '8', subtotal_after_discount: '50', created_time: myt('2026-10-08T13:00:00') }),
  ]

  it('counts sold orders in the period, without cancelled or unpaid ones', () => {
    const r = buildSalesReport({ range, shops, lines, now: NOW })
    expect(r.totals).toEqual({ sales: 50.3, orders: 2, items: 4, aov: 25.15, cancelled: 1 })
    expect(r.cancelRate).toBeCloseTo(1 / 3)
  })

  it('compares with the same days of last week only', () => {
    const r = buildSalesReport({ range, shops, lines, now: NOW })
    expect(r.previous.sales).toBe(25.15)
    expect(r.change.sales).toBeCloseTo((50.3 - 25.15) / 25.15)
  })

  it('makes a daily trend up to today, products and the shop split', () => {
    const r = buildSalesReport({ range, shops, lines, now: NOW })
    expect(r.trend.map(p => p.label)).toEqual(['Mon 12', 'Tue 13', 'Wed 14', 'Thu 15'])
    expect(r.trend.map(p => p.sales)).toEqual([30, 0, 20.3, 0])
    expect(r.trend[2].orders).toBe(1)
    expect(r.topProducts.map(p => p.product)).toEqual(['Cat Food', 'Camping Chair', 'Table'])
    expect(r.lowProducts).toEqual([])
    expect(r.shops).toEqual([
      { shop: 'SeraOutdoor', sales: 20.3, orders: 1, items: 3, cancelled: 1 },
      { shop: 'Ellbow', sales: 30, orders: 1, items: 1, cancelled: 0 },
    ])
  })

  it('makes an hourly trend for a day and no shop split for one shop', () => {
    const r = buildSalesReport({ range: periodRange('day', '2026-10-14', NOW), shops: [shops[0]], lines, now: NOW })
    expect(r.trend).toHaveLength(24)
    expect(r.trend[9]).toMatchObject({ label: '9am', sales: 20.3, orders: 1 })
    expect(r.shops).toEqual([])
  })
})

describe('buildSettlementReport', () => {
  const range = periodRange('month', '2026-10-15', NOW)
  const order = (over: Partial<SettlementRow>): SettlementRow => ({
    shop_id: 'sera', transaction_type: 'Order', related_order_id: '1', settled_date: '2026-10-05',
    total_revenue: '100.00', total_fees: '-21.10', total_settlement_amount: '78.90', customer_refund: null,
    fee_breakdown: {
      tiktok_shop_commission_fee: -8, transaction_fee: -3.5, seller_shipping_fee: -4.6, actual_shipping_fee: -7.6,
      customer_shipping_fee: 3, affiliate_commission: -2, affiliate_commission_amount_before_pit: -2, bonus_cashback_service_fee: -3,
    },
    ...over,
  })
  const settlements = [
    order({}),
    order({ related_order_id: '2', shop_id: 'ell', total_revenue: '50.05', total_fees: '-10.00', total_settlement_amount: '40.05', customer_refund: '-5', fee_breakdown: { tiktok_shop_commission_fee: -4, gmv_max_ad_fee: -6 } }),
    order({ transaction_type: 'GMV payment for TikTok Ads', related_order_id: null, total_revenue: null, total_fees: null, total_settlement_amount: '-12.34', fee_breakdown: {} }),
    order({ related_order_id: '7', settled_date: '2026-09-30', total_settlement_amount: '999' }),
  ]
  const payouts = [
    { shop_id: 'sera', reference_id: 'w1', transaction_type: 'Withdrawal', request_date: '2026-10-08', amount: '-500.00', status: 'Transferred' },
    { shop_id: 'sera', reference_id: 'w0', transaction_type: 'Withdrawal', request_date: '2026-09-20', amount: '-100.00', status: 'Transferred' },
    { shop_id: 'sera', reference_id: 'wf', transaction_type: 'Withdrawal', request_date: '2026-10-12', amount: '-50.00', status: 'Failed' },
    { shop_id: 'sera', reference_id: 'e1', transaction_type: 'Earnings', request_date: '2026-10-08', amount: '70.00', status: 'Transferred' },
    { shop_id: 'sera', reference_id: 'e2', transaction_type: 'Earnings', request_date: '2026-10-10', amount: '78.90', status: 'Transferred' },
    { shop_id: 'sera', reference_id: 'e3', transaction_type: 'Earnings', request_date: '2026-10-11', amount: '1.10', status: 'Transferred' },
  ]
  const unsettled = [
    { shop_id: 'sera', order_id: '10', reason: 'Waiting for package delivery', est_settlement: '30.10', synced_at: '2026-10-15T03:00:00Z' },
    { shop_id: 'ell', order_id: '11', reason: 'Order delivered and awaiting settlement', est_settlement: '12.00', synced_at: '2026-10-15T02:00:00Z' },
    { shop_id: 'ell', order_id: '12', reason: 'Waiting for package delivery', est_settlement: '7.00', synced_at: '2026-10-15T02:00:00Z' },
  ]
  const timings = [
    { shop_id: 'sera', order_id: '1', created_time: myt('2026-09-30T10:00:00'), delivered_time: myt('2026-10-02T15:00:00') },
    { shop_id: 'ell', order_id: '2', created_time: myt('2026-09-28T10:00:00'), delivered_time: myt('2026-10-01T09:00:00') },
  ]
  const report = () => buildSettlementReport({ range, shops, settlements, payouts, unsettled, timings })

  it('reconciles gross revenue through every fee group to the net settlement, to the sen', () => {
    const r = report()
    expect(r.revenue).toBe(150.05)
    expect(r.net).toBe(106.61)
    expect(r.deductions).toBe(-43.44)
    const lines = Object.fromEntries(r.waterfall.map(l => [l.key, l.amount]))
    expect(lines).toEqual({
      revenue: 150.05, commission: -12, transaction: -3.5, shipping: -4.6, affiliate: -2, ads: -6, other_fees: -3, adjustments: -12.34,
    })
    const sum = r.waterfall.reduce((s, l) => s + Math.round(l.amount * 100), 0)
    expect(sum).toBe(Math.round(r.net * 100))
    expect(r.ordersSettled).toBe(2)
    expect(r.refunds).toBe(5)
  })

  it('shows money paid to the bank, and what settled since the last withdrawal', () => {
    const r = report()
    expect(r.paidToBank).toBe(500)
    expect(r.withdrawals).toEqual([{ shop: 'SeraOutdoor', date: '2026-10-08', amount: 500, status: 'Transferred', reference: 'w1' }])
    expect(r.balances).toEqual([
      { shop: 'SeraOutdoor', lastWithdrawal: '2026-10-08', settledSince: 80 },
      { shop: 'Ellbow', lastWithdrawal: null, settledSince: 0 },
    ])
  })

  it('adds up pending orders by reason and the settlement timing', () => {
    const r = report()
    expect(r.pending).toEqual({
      orders: 3,
      amount: 49.1,
      reasons: [
        { reason: 'Waiting for package delivery', orders: 2, amount: 37.1 },
        { reason: 'Order delivered and awaiting settlement', orders: 1, amount: 12 },
      ],
      syncedAt: '2026-10-15T02:00:00Z',
    })
    expect(r.timing).toEqual({ orders: 2, deliveryToSettledDays: 3.5, orderToSettledDays: 6 })
    expect(r.shops[1]).toEqual({ shop: 'Ellbow', revenue: 50.05, deductions: -10, net: 40.05, paidToBank: 0, pending: 19 })
  })
})

describe('buildShippingReport', () => {
  const range = periodRange('day', '2026-10-14', NOW)
  const line = (over: Partial<ShippingLine>): ShippingLine => ({
    shop_id: 'sera', order_id: '1', order_status: 'Shipped', order_substatus: 'In transit', shipping_provider: 'J&T Express',
    tracking_number: 'JNT1', quantity: 1, created_time: myt('2026-10-13T08:00:00'), paid_time: myt('2026-10-13T09:00:00'),
    shipped_time: myt('2026-10-14T08:00:00'), delivered_time: null, cancelled_time: null, ...over,
  })
  const lines = [
    line({}),
    line({ order_id: '1', tracking_number: 'JNT1' }),
    line({ order_id: '2', shop_id: 'ell', paid_time: myt('2026-10-12T07:00:00'), shipped_time: myt('2026-10-14T10:00:00'), shipping_provider: 'Ninja Van', tracking_number: 'NV2' }),
    line({ order_id: '3', paid_time: myt('2026-10-10T10:00:00'), shipped_time: myt('2026-10-11T10:00:00'), delivered_time: myt('2026-10-14T16:00:00'), order_substatus: 'Delivered' }),
    line({ order_id: '4', order_status: 'To ship', order_substatus: 'Awaiting shipment', paid_time: myt('2026-10-12T10:00:00'), shipped_time: null, tracking_number: null }),
    line({ order_id: '5', order_status: 'To ship', paid_time: myt('2026-10-15T08:00:00'), shipped_time: null }),
    line({ order_id: '6', order_status: 'Canceled', shipped_time: null, cancelled_time: myt('2026-10-14T11:00:00') }),
  ]
  const settlements: SettlementRow[] = [{
    shop_id: 'sera', transaction_type: 'Order', related_order_id: '3', settled_date: '2026-10-14', total_revenue: 10, total_fees: -5, total_settlement_amount: 5, customer_refund: null,
    fee_breakdown: { seller_shipping_fee: -4.6, actual_shipping_fee: -9.6, customer_shipping_fee: 3, platform_shipping_fee_discount: 2.5, actual_return_shipping_fee: -0.5 },
  }]

  it('counts shipped, delivered, cancelled and what is waiting to be packed', () => {
    const r = buildShippingReport({ range, shops, lines, settlements, now: NOW })
    expect(r).toMatchObject({ shipped: 2, delivered: 1, cancelled: 1, toPack: 2, toPackLate: 1 })
    expect(r.speed).toEqual({ within24: 1, within48: 0, over48: 1, medianHours: 37 })
    expect(r.within24h).toBe(0.5)
    expect(r.deliveryDays).toBe(3.3)
  })

  it('lists shipped orders with the tracking number, couriers and the shipping money', () => {
    const r = buildShippingReport({ range, shops, lines, settlements, now: NOW })
    expect(r.orders.map(o => [o.shop, o.orderId, o.tracking, o.hoursToShip])).toEqual([['Ellbow', '2', 'NV2', 51], ['SeraOutdoor', '1', 'JNT1', 23]])
    expect(r.couriers).toEqual([
      { courier: 'J&T Express', shipped: 1, delivered: 0, medianDeliveryDays: null },
      { courier: 'Ninja Van', shipped: 1, delivered: 0, medianDeliveryDays: null },
    ])
    expect(r.money).toEqual({ buyerPaid: 3, subsidy: 2.5, courierCost: -9.6, returns: -0.5, other: 0, net: -4.6 })
    expect(r.shops[0]).toEqual({ shop: 'SeraOutdoor', shipped: 1, delivered: 1, toPack: 2, medianHours: 23 })
  })
})
