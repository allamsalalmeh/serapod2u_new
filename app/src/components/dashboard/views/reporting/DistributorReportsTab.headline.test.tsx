// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/reporting/distributor-analytics-pdf', () => ({ buildDistributorAnalyticsPdf: vi.fn() }))

import DistributorReportsTab from './DistributorReportsTab'
import {
  ALL_DISTRIBUTORS,
  buildDistributorAnalyticsReport,
  emptyAggregate,
  resolveDistributorReportPeriod,
  summarizeApprovedWindow,
  type DistributorAggregate,
  type DistributorAnalyticsAggregate,
} from '@/lib/reporting/distributor-analytics'

const NOW = new Date('2026-10-27T10:00:00+08:00')

const dist = (id: string, p: Partial<DistributorAggregate>): DistributorAggregate => ({
  distributorId: id, name: `Distributor ${id}`, orgCode: id.toUpperCase(), isActive: true,
  currentOrders: 0, currentValue: 0, previousOrders: 0, previousValue: 0,
  firstOrderAt: '2025-01-01T00:00:00.000Z', lastOrderAt: '2026-08-20T00:00:00.000Z', lifetimeOrders: 10, ...p,
})

/**
 * Shaped like the August 2026 screen: 6 approved + 1 packed (RM32,064), 13 submitted (RM71,200),
 * 22 cancelled, 6 active distributors of which 3 have an approved order. July: 3 approved orders.
 */
const APPROVED_AUG = [
  ...[4000, 4000, 4000, 4000, 4000, 4000].map((v, i) => ({ status: 'approved', distributorId: ['d1', 'd2', 'd3'][i % 3], orderValue: v })),
  { status: 'warehouse_packed', distributorId: 'd1', orderValue: 8064 },
]
const APPROVED_JUL = [
  { status: 'approved', distributorId: 'd1', orderValue: 5600 },
  { status: 'closed', distributorId: 'd2', orderValue: 5600 },
  { status: 'approved', distributorId: 'd4', orderValue: 0 },
]

function aggregate(opts: { submitted: boolean; approvedRead: boolean }): DistributorAnalyticsAggregate {
  const month = '2026-08'
  const period = resolveDistributorReportPeriod(month, NOW)
  const submittedOrders = opts.submitted ? 13 : 0
  const submittedValue = opts.submitted ? 71200 : 0
  return {
    ...emptyAggregate(month, period, ALL_DISTRIBUTORS, 'All Distributors', 'all'),
    current: { orders: 7 + submittedOrders, orderValue: 32064 + submittedValue, activeDistributors: opts.submitted ? 6 : 3, ordersCreated: 7 + submittedOrders + 22 },
    previous: { orders: 5, orderValue: 15000, activeDistributors: 4, ordersCreated: 9 },
    distributors: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'].map((id, i) => dist(id, { currentOrders: i < 3 || opts.submitted ? 2 : 0, currentValue: 1000, previousOrders: 1, previousValue: 1000 })),
    statusBreakdown: [
      { status: 'approved', orders: 6, orderValue: 24000 },
      { status: 'warehouse_packed', orders: 1, orderValue: 8064 },
      ...(opts.submitted ? [{ status: 'submitted', orders: 13, orderValue: 71200 }] : []),
      { status: 'cancelled', orders: 22, orderValue: 88000 },
    ],
    ...(opts.approvedRead ? { approved: { current: summarizeApprovedWindow(APPROVED_AUG), previous: summarizeApprovedWindow(APPROVED_JUL) } } : {}),
  }
}

let current = aggregate({ submitted: true, approvedRead: true })
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/filters')) {
      return { ok: true, json: async () => ({ months: [{ key: '2026-08' }], distributors: [], statuses: [] }) } as any
    }
    return { ok: true, json: async () => ({ report: buildDistributorAnalyticsReport(current, NOW), meta: { source: 'rpc', degraded: false, notice: null } }) } as any
  }))
  window.history.replaceState(null, '', '/reporting?month=2026-08')
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function renderHeadline() {
  render(<DistributorReportsTab userProfile={{ full_name: 'Admin HQ' }} month="2026-08" onMonthChange={() => {}} />)
  await waitFor(() => expect(screen.getByTestId('distributor-headline-kpis')).toBeTruthy())
  return screen.getByTestId('distributor-headline-kpis')
}
const text = (id: string) => screen.getByTestId(id).textContent ?? ''

describe('Distributor Analytics headline — approved first', () => {
  it('shows exactly four cards with approved figures as the headline values', async () => {
    const grid = await renderHeadline()
    expect(grid.children).toHaveLength(4)
    expect(text('kpi-approved-sales')).toContain('RM32.1K')
    expect(within(screen.getByTestId('kpi-approved-orders')).getByText('7')).toBeTruthy()
    expect(within(screen.getByTestId('kpi-active-distributors')).getByText('6')).toBeTruthy()
    expect(text('kpi-avg-approved-order-value')).toContain('RM4.6K') // 32,064 ÷ 7
  })

  it('compares approved with approved, against the comparison range', async () => {
    await renderHeadline()
    // July approved: RM11,200 over 3 orders → +186.3% value, +133.3% orders.
    expect(text('kpi-approved-sales')).toContain('186.3%')
    expect(text('kpi-approved-orders')).toContain('133.3%')
    expect(text('kpi-active-distributors')).toContain('50.0%') // 6 vs 4
    expect(text('kpi-approved-sales')).toContain('vs 01 Jul 2026 – 31 Jul 2026')
  })

  it('shows the submitted orders under each card, with the approved-stage breakdown', async () => {
    await renderHeadline()
    expect(text('kpi-approved-sales-footer')).toMatch(/Submitted\s*RM71\.2K/)
    expect(text('kpi-approved-sales-footer')).toContain('6 approved + 1 packed order')
    expect(text('kpi-approved-orders-footer')).toMatch(/Submitted Orders\s*13/)
    expect(text('kpi-approved-orders-footer')).toContain('7 approved-stage orders')
    expect(text('kpi-active-distributors-footer')).toMatch(/With Approved Orders\s*3/)
    expect(text('kpi-avg-approved-order-value-footer')).toMatch(/Submitted Avg\. Order Value\s*RM5\.5K/) // 71,200 ÷ 13
  })

  it('never includes cancelled orders in these KPIs', async () => {
    const grid = await renderHeadline()
    expect(grid.textContent).not.toMatch(/cancel/i)
    expect(text('kpi-approved-sales')).not.toContain('88') // the RM88,000 cancelled value
    expect(text('kpi-approved-orders')).not.toMatch(/\b42\b|\b22\b/)
  })

  it('hides the submitted lines when there are no submitted orders', async () => {
    current = aggregate({ submitted: false, approvedRead: true })
    await renderHeadline()
    expect(screen.getByTestId('distributor-headline-kpis').textContent).not.toMatch(/Submitted/)
    expect(screen.queryByTestId('kpi-approved-orders-footer')).toBeNull()
    expect(screen.queryByTestId('kpi-avg-approved-order-value-footer')).toBeNull()
    expect(text('kpi-approved-sales-footer')).toContain('6 approved + 1 packed order')
    current = aggregate({ submitted: true, approvedRead: true })
  })

  it('without the approved read: current figures from the status mix, no invented growth or distributor count', async () => {
    current = aggregate({ submitted: true, approvedRead: false })
    await renderHeadline()
    expect(text('kpi-approved-sales')).toContain('RM32.1K')
    expect(text('kpi-approved-sales')).toContain('No baseline')
    expect(screen.queryByTestId('kpi-active-distributors-footer')).toBeNull()
    current = aggregate({ submitted: true, approvedRead: true })
  })

  it('This Period vs Previous Period compares approved figures, not Active Order Value', async () => {
    await renderHeadline()
    const table = screen.getByText('This Period vs Previous Period').closest('[class*="rounded"]') as HTMLElement
    const rows = within(table).getAllByRole('row').slice(1).map((row) => Array.from(row.querySelectorAll('td')).map((td) => td.textContent?.trim()))
    expect(rows.slice(0, 3)).toEqual([
      ['Approved Orders', '7', '3', expect.stringContaining('133.3%')],
      ['Approved Sales', 'RM 32,064.00', 'RM 11,200.00', expect.stringContaining('186.3%')],
      ['Average Approved Order Value', 'RM 4,580.57', 'RM 3,733.33', expect.stringContaining('22.7%')],
    ])
    const labels = rows.map((row) => row[0])
    expect(labels).not.toContain('Active Order Value')
    expect(labels).not.toContain('Active Orders')
    expect(labels).not.toContain('Avg Order Value')
    expect(labels).toEqual(expect.arrayContaining(['Total Orders Created', 'Active Distributors', 'Returning Rate']))
  })

  it('the Approved Orders card opens the approved drill-down', async () => {
    await renderHeadline()
    const card = screen.getByRole('button', { name: 'View Approved Orders details' })
    expect(within(screen.getByTestId('distributor-headline-kpis')).getByText('Approved Orders')).toBeTruthy()
    expect(card.getAttribute('aria-haspopup')).toBe('dialog')
  })
})
