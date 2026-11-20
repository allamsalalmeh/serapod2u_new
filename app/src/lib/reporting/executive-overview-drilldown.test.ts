import { describe, expect, it } from 'vitest'
import { buildExecutiveOverviewReport, type OverviewOrderInput } from './executive-overview'
import { buildOverviewDrilldown, isOverviewDrilldownMetric } from './executive-overview-drilldown'

const NOW = new Date('2026-10-20T10:00:00+08:00')

let seq = 0
function o(orderType: string | null, status: string, orderDate: string, buyer: [string | null, string, string, string?], value: number, qty = 1): OverviewOrderInput {
  seq += 1
  return {
    id: `o${seq}`, orderNo: `SO-${String(seq).padStart(3, '0')}`, orderType, status, orderDate, createdAt: `${orderDate}T03:00:00Z`,
    buyerId: buyer[0], buyerName: buyer[1], buyerType: buyer[2], buyerCode: buyer[3] ?? null,
    items: [{ variantId: 'v1', qty, lineTotal: value }],
  }
}
const DA: [string, string, string, string] = ['d1', 'Dist Alpha', 'DIST', 'DA01']
const DB: [string, string, string, string] = ['d2', 'Dist Alpha', 'DIST', 'DB02'] // same NAME, different organisation
const S1: [string, string, string, string] = ['s1', 'Kedai Satu', 'SHOP', 'KS01']
const HQ: [string, string, string] = ['hq', 'HQ', 'HQ']
const NOBUYER: [null, string, string] = [null, '', '']

const SEPTEMBER = [
  o('D2H', 'approved', '2026-09-01', DA, 1000, 10), // first day of the month
  o('D2H', 'warehouse_packed', '2026-09-15', DA, 250.255, 2), // same buyer, second order
  o('D2H', 'shipped_distributor', '2026-09-20', DB, 500, 5),
  o('S2D', 'closed', '2026-09-30', S1, 200, 4), // last day of the month
  o('D2H', 'submitted', '2026-09-10', DA, 7000, 70), // pipeline — excluded
  o('D2H', 'draft', '2026-09-10', DA, 9000, 90), // draft — excluded
  o('S2D', 'cancelled', '2026-09-11', S1, 300, 3), // cancelled — excluded
  o('H2M', 'approved', '2026-09-05', HQ, 50000, 500), // purchase — excluded
  o(null, 'approved', '2026-09-06', DA, 123, 1), // unclassified — excluded
  o('D2H', 'approved', '2026-08-31', DB, 800, 8), // previous month — excluded
  o('D2H', 'approved', '2026-10-01', DB, 999, 9), // next month — excluded
]
const card = (month = '2026-09', orders = SEPTEMBER) => buildExecutiveOverviewReport({ month, orders, now: NOW }).summary

describe('Executive Overview drill-down — Confirmed Sales Orders', () => {
  it('lists exactly the orders the card counts, newest first, and reconciles', () => {
    const d = buildOverviewDrilldown({ metric: 'confirmed_orders', month: '2026-09', orders: SEPTEMBER, now: NOW })
    expect(card().approvedSalesOrders).toBe(4)
    expect(d.headline).toBe(4)
    expect(d.total).toBe(4)
    expect(d.reconciled).toBe(true)
    expect(d.rows.map((r) => r.orderDate)).toEqual(['2026-09-30', '2026-09-20', '2026-09-15', '2026-09-01'])
    expect(d.rows.map((r) => r.status)).toEqual(['closed', 'shipped_distributor', 'warehouse_packed', 'approved'])
    expect(d.rows.every((r) => ['D2H', 'S2D'].includes(r.orderType))).toBe(true)
    expect(d.period).toMatchObject({ month: '2026-09', label: 'September 2026', startDate: '2026-09-01', endDate: '2026-09-30' })
  })

  it('carries the buyer, reference and line-sum value of each order', () => {
    const d = buildOverviewDrilldown({ metric: 'confirmed_orders', month: '2026-09', orders: SEPTEMBER, now: NOW })
    const packed = d.rows.find((r) => r.status === 'warehouse_packed')!
    expect(packed).toMatchObject({ buyerId: 'd1', buyerName: 'Dist Alpha', buyerCode: 'DA01', value: 250.26, units: 2 })
    expect(d.totalValue).toBeCloseTo(card().approvedSalesValue, 2)
  })

  it('follows the selected month: August and October return their own orders only', () => {
    const aug = buildOverviewDrilldown({ metric: 'confirmed_orders', month: '2026-08', orders: SEPTEMBER, now: NOW })
    expect(aug.rows.map((r) => r.orderDate)).toEqual(['2026-08-31'])
    const oct = buildOverviewDrilldown({ metric: 'confirmed_orders', month: '2026-10', orders: SEPTEMBER, now: NOW })
    expect(oct.rows.map((r) => r.orderDate)).toEqual(['2026-10-01'])
    expect(oct.period.isCurrentMonth).toBe(true)
    expect(oct.headline).toBe(card('2026-10').approvedSalesOrders)
  })

  it('returns an explicit empty list for a month without confirmed orders', () => {
    const d = buildOverviewDrilldown({ metric: 'confirmed_orders', month: '2026-06', orders: SEPTEMBER, now: NOW })
    expect(d).toMatchObject({ total: 0, headline: 0, reconciled: true, rows: [], pageCount: 1, page: 0 })
  })

  it('pages on the server and clamps out-of-range pages', () => {
    const many = Array.from({ length: 30 }, (_, i) => o('D2H', 'approved', `2026-09-${String((i % 28) + 1).padStart(2, '0')}`, DA, 10))
    const first = buildOverviewDrilldown({ metric: 'confirmed_orders', month: '2026-09', orders: many, pageSize: 25, now: NOW })
    expect(first).toMatchObject({ total: 30, pageCount: 2, page: 0, reconciled: true })
    expect(first.rows).toHaveLength(25)
    const second = buildOverviewDrilldown({ metric: 'confirmed_orders', month: '2026-09', orders: many, pageSize: 25, page: 1, now: NOW })
    expect(second.rows).toHaveLength(5)
    expect(new Set([...first.rows, ...second.rows].map((r) => r.orderId)).size).toBe(30)
    expect(buildOverviewDrilldown({ metric: 'confirmed_orders', month: '2026-09', orders: many, pageSize: 25, page: 99, now: NOW }).page).toBe(1)
    expect(buildOverviewDrilldown({ metric: 'confirmed_orders', month: '2026-09', orders: many, pageSize: 10_000, now: NOW }).pageSize).toBe(100)
  })

  it('narrows to one buyer by organisation id, never by name', () => {
    const d = buildOverviewDrilldown({ metric: 'confirmed_orders', month: '2026-09', orders: SEPTEMBER, buyerId: 'd1', now: NOW })
    expect(d.rows.map((r) => r.buyerId)).toEqual(['d1', 'd1'])
    expect(d).toMatchObject({ headline: 2, total: 2, reconciled: true, buyer: { id: 'd1', name: 'Dist Alpha' } })
  })
})

describe('Executive Overview drill-down — Active Buyers', () => {
  it('lists each buyer organisation once and reconciles with the card', () => {
    const d = buildOverviewDrilldown({ metric: 'active_buyers', month: '2026-09', orders: SEPTEMBER, now: NOW })
    expect(card().activeBuyers).toBe(3)
    expect(d).toMatchObject({ headline: 3, total: 3, reconciled: true })
    // d1 placed two confirmed orders: one row, both orders.
    expect(d.rows.filter((r) => r.buyerId === 'd1')).toHaveLength(1)
    expect(d.rows.find((r) => r.buyerId === 'd1')).toMatchObject({ orders: 2, value: 1250.26, buyerCode: 'DA01', lastOrderDate: '2026-09-15', orderTypes: ['D2H'] })
    // Two organisations with the same name stay two buyers.
    expect(d.rows.filter((r) => r.buyerName === 'Dist Alpha').map((r) => r.buyerId).sort()).toEqual(['d1', 'd2'])
    expect(d.rows.map((r) => r.buyerId)).not.toContain('hq')
  })

  it('counts only confirmed orders per buyer — pipeline, cancelled and other months are excluded', () => {
    const d = buildOverviewDrilldown({ metric: 'active_buyers', month: '2026-09', orders: SEPTEMBER, now: NOW })
    expect(d.rows.find((r) => r.buyerId === 's1')).toMatchObject({ orders: 1, value: 200 })
    expect(d.rows.find((r) => r.buyerId === 'd2')).toMatchObject({ orders: 1, value: 500 })
    expect(d.rows.reduce((sum, r) => sum + r.orders, 0)).toBe(card().approvedSalesOrders)
  })

  it('never invents a buyer for an order without a buyer organisation, and says so', () => {
    const orders = [...SEPTEMBER, o('D2H', 'approved', '2026-09-12', NOBUYER, 40)]
    const d = buildOverviewDrilldown({ metric: 'active_buyers', month: '2026-09', orders, now: NOW })
    expect(card('2026-09', orders).activeBuyers).toBe(3)
    expect(d).toMatchObject({ total: 3, headline: 3, reconciled: true, ordersWithoutBuyer: 1 })
  })

  it('switching months re-derives the buyers for that month', () => {
    expect(buildOverviewDrilldown({ metric: 'active_buyers', month: '2026-08', orders: SEPTEMBER, now: NOW }).rows.map((r) => r.buyerId)).toEqual(['d2'])
    expect(buildOverviewDrilldown({ metric: 'active_buyers', month: '2026-07', orders: SEPTEMBER, now: NOW }).total).toBe(0)
  })
})

it('accepts only the two supported metrics', () => {
  expect(isOverviewDrilldownMetric('confirmed_orders')).toBe(true)
  expect(isOverviewDrilldownMetric('active_buyers')).toBe(true)
  expect(isOverviewDrilldownMetric('cancelled_orders')).toBe(true)
  expect(isOverviewDrilldownMetric('approved_sales_value')).toBe(false)
  expect(isOverviewDrilldownMetric(null)).toBe(false)
})

describe('Executive Overview drill-down — Cancelled Orders', () => {
  const CANCELLED = [
    ...SEPTEMBER,
    o('D2H', 'cancelled', '2026-09-30', DA, 120.125, 2), // last day of the month
    o('H2M', 'cancelled', '2026-09-12', HQ, 4000), // purchase — excluded
    o(null, 'cancelled', '2026-09-13', DA, 40), // unclassified — excluded
    o('S2D', 'cancelled', '2026-08-31', S1, 77), // previous month — excluded
    o('D2H', 'cancelled', '2026-10-01', DB, 88), // next month — excluded
  ]

  it('lists exactly the cancelled D2H/S2D orders the card counts and reconciles count and value', () => {
    const summary = card('2026-09', CANCELLED)
    const d = buildOverviewDrilldown({ metric: 'cancelled_orders', month: '2026-09', orders: CANCELLED, now: NOW })
    expect(summary.cancelledOrders).toBe(2)
    expect(d).toMatchObject({ headline: 2, total: 2, headlineValue: summary.cancelledValue, totalValue: summary.cancelledValue, reconciled: true })
    expect(d.rows.map((r) => [r.orderDate, r.orderType, r.status])).toEqual([
      ['2026-09-30', 'D2H', 'cancelled'],
      ['2026-09-11', 'S2D', 'cancelled'],
    ])
    expect(d.rows[0]).toMatchObject({ buyerName: 'Dist Alpha', buyerCode: 'DA01', value: 120.13 })
    expect(d.definition).toContain('not the date of cancellation')
  })

  it('follows the selected month and returns an explicit empty list', () => {
    const aug = buildOverviewDrilldown({ metric: 'cancelled_orders', month: '2026-08', orders: CANCELLED, now: NOW })
    expect(aug.rows.map((r) => r.orderDate)).toEqual(['2026-08-31'])
    expect(aug.headline).toBe(card('2026-08', CANCELLED).cancelledOrders)
    const jun = buildOverviewDrilldown({ metric: 'cancelled_orders', month: '2026-06', orders: CANCELLED, now: NOW })
    expect(jun).toMatchObject({ total: 0, headline: 0, totalValue: 0, headlineValue: 0, reconciled: true, rows: [] })
  })

  it('leaves the confirmed orders list unchanged', () => {
    const d = buildOverviewDrilldown({ metric: 'confirmed_orders', month: '2026-09', orders: CANCELLED, now: NOW })
    expect(d.rows.every((r) => r.status !== 'cancelled')).toBe(true)
    expect(d.total).toBe(4)
    expect(d.headlineValue).toBeNull()
  })
})
