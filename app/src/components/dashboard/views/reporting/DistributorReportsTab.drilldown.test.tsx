// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pdfBuilder = vi.fn(async () => ({ blob: new Blob(['%PDF']), filename: 'Serapod_Distributor_Report_2026-09_MTD.pdf' }))
vi.mock('@/lib/reporting/distributor-analytics-pdf', () => ({ buildDistributorAnalyticsPdf: pdfBuilder }))

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
import { buildDistributorDrilldown } from '@/lib/reporting/distributor-drilldown'
import type { EligibleWindowOrder } from '@/lib/reporting/distributor-analytics-source'

const NOW = new Date('2026-09-07T10:00:00+08:00')

const dist = (id: string, name: string, code: string, p: Partial<DistributorAggregate>): DistributorAggregate => ({
  distributorId: id, name, orgCode: code, isActive: true, currentOrders: 0, currentValue: 0, previousOrders: 0, previousValue: 0,
  firstOrderAt: '2025-01-01T00:00:00.000Z', lastOrderAt: '2026-08-01T00:00:00.000Z', lifetimeOrders: 10, ...p,
})

/** September: 3 active (none new), 3 inactive. August: 2 active incl. 1 new. */
const DATA: Record<string, { distributors: DistributorAggregate[]; orders: EligibleWindowOrder[] }> = {
  '2026-09': {
    distributors: [
      dist('d1', 'Infy Tech Distribution', 'INFY', { currentOrders: 4, currentValue: 20000, previousOrders: 2, previousValue: 9000, lastOrderAt: '2026-09-05T02:00:00.000Z' }),
      dist('d2', 'Sahabat Vape', 'SHBT', { currentOrders: 2, currentValue: 12000, previousOrders: 1, previousValue: 3000, lastOrderAt: '2026-09-04T02:00:00.000Z' }),
      dist('d3', 'Maju Jaya', 'MAJU', { currentOrders: 1, currentValue: 4944, lastOrderAt: '2026-09-02T02:00:00.000Z' }),
      dist('d4', 'Quiet One', 'Q1', { previousOrders: 2, previousValue: 5000 }),
      dist('d5', 'Quiet Two', 'Q2', { previousOrders: 1, previousValue: 1000 }),
      dist('d6', 'Quiet Three', 'Q3', { previousOrders: 1, previousValue: 700 }),
    ],
    orders: [],
  },
  '2026-08': {
    distributors: [
      dist('d1', 'Infy Tech Distribution', 'INFY', { currentOrders: 2, currentValue: 9000 }),
      dist('d7', 'Brand New Sdn Bhd', 'BNEW', { currentOrders: 1, currentValue: 2500, firstOrderAt: '2026-08-12T02:00:00.000Z', lastOrderAt: '2026-08-12T02:00:00.000Z', lifetimeOrders: 1 }),
    ],
    orders: [],
  },
}
// Seven September orders, twelve thousand-ish each distributor as above.
for (const [month, set] of Object.entries(DATA)) {
  for (const row of set.distributors) {
    for (let i = 0; i < row.currentOrders; i++) {
      set.orders.push({
        orderId: `${month}-${row.distributorId}-${i}`, orderNo: `SO${month.replace('-', '')}${row.distributorId}${i}`,
        orderDate: `${month}-0${i + 1}`, createdAt: `${month}-0${i + 1}T02:00:00.000Z`, updatedAt: null, status: 'approved',
        distributorId: row.distributorId, distributorName: row.name, distributorCode: row.orgCode,
        orderValue: row.currentValue / row.currentOrders, lineCount: 1, createdById: null,
      })
    }
  }
}

function aggregateFor(month: string, distributorId = ALL_DISTRIBUTORS, status = 'all'): DistributorAnalyticsAggregate {
  const period = resolveDistributorReportPeriod(month, NOW)
  const rows = DATA[month].distributors.filter((r) => distributorId === ALL_DISTRIBUTORS || r.distributorId === distributorId)
  const sum = (key: keyof DistributorAggregate) => rows.reduce((s, r) => s + (r[key] as number), 0)
  return {
    ...emptyAggregate(month, period, distributorId, 'All Distributors', status),
    current: { orders: sum('currentOrders'), orderValue: sum('currentValue'), activeDistributors: rows.filter((r) => r.currentOrders > 0).length },
    previous: { orders: sum('previousOrders'), orderValue: sum('previousValue'), activeDistributors: rows.filter((r) => r.previousOrders > 0).length },
    distributors: rows,
    // Every fixture order is 'approved': the status mix and the approved-stage windows follow from them.
    statusBreakdown: [{ status: 'approved', orders: sum('currentOrders'), orderValue: sum('currentValue') }],
    approved: {
      current: summarizeApprovedWindow(DATA[month].orders
        .filter((o) => rows.some((r) => r.distributorId === o.distributorId))
        .map((o) => ({ status: o.status, distributorId: o.distributorId, orderValue: o.orderValue }))),
      previous: summarizeApprovedWindow([]),
    },
  }
}

const drillRequests: URLSearchParams[] = []

beforeEach(() => {
  drillRequests.length = 0
  pdfBuilder.mockClear()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = new URL(String(input), 'http://localhost')
    const p = url.searchParams
    const month = p.get('month') || '2026-09'
    if (url.pathname.endsWith('/filters')) {
      return { ok: true, json: async () => ({ months: [{ key: '2026-09' }, { key: '2026-08' }], distributors: [], statuses: [] }) } as any
    }
    const aggregate = aggregateFor(month, p.get('distributor') || ALL_DISTRIBUTORS, p.get('status') || 'all')
    if (url.pathname.endsWith('/drilldown')) {
      drillRequests.push(p)
      const drilldown = buildDistributorDrilldown({ aggregate, metric: p.get('metric') as any, orders: DATA[month].orders, now: NOW })
      return { ok: true, json: async () => ({ drilldown, meta: { source: 'rpc' } }) } as any
    }
    return { ok: true, json: async () => ({ report: buildDistributorAnalyticsReport(aggregate, NOW), meta: { source: 'rpc', degraded: false, notice: null, generatedAt: NOW.toISOString() } }) } as any
  }))
  window.history.replaceState(null, '', '/reporting')
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function renderTab() {
  render(<DistributorReportsTab userProfile={{ full_name: 'Admin HQ' }} />)
  await waitFor(() => expect(screen.getByText('Key Management Insights')).toBeTruthy())
}

const drawer = () => screen.findByTestId('metric-drilldown')
const rowsIn = (el: HTMLElement) => within(within(el).getByTestId('drilldown-table')).getAllByRole('row').slice(1)

describe('clickable dashboard metrics', () => {
  it('6. Approved Orders and Active Distributors cards are interactive; Concentration and At Risk are not', async () => {
    await renderTab()
    for (const label of ['Approved Orders', 'Active Distributors', 'New Distributors', 'Inactive This Period', 'Returning Distributors']) {
      const card = screen.getByRole('button', { name: `View ${label} details` })
      expect(card.getAttribute('tabindex')).toBe('0')
      expect(card.className).toContain('cursor-pointer')
    }
    expect(screen.getByTestId('insight-concentration').getAttribute('role')).toBeNull()
    expect(screen.getByTestId('insight-at_risk').getAttribute('role')).toBeNull()
  })

  it('7. Approved Orders opens exactly the 7 counted approved orders for the current scope', async () => {
    await renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'View Approved Orders details' }))
    const panel = await drawer()
    await waitFor(() => expect(within(panel).getByText('Approved Orders — September 2026')).toBeTruthy())
    await waitFor(() => expect(rowsIn(panel)).toHaveLength(7))
    expect(within(panel).getByTestId('drilldown-summary').textContent).toContain('Approved Orders: 7')
    expect(within(panel).getByTestId('drilldown-summary').textContent).toContain('Approved Sales: RM36.9K')
    expect(within(panel).queryByRole('alert')).toBeNull()
    const link = within(panel).getAllByRole('link')[0] as HTMLAnchorElement
    expect(link.getAttribute('href')).toMatch(/^\/supply-chain\/orders\//)
    expect(Object.fromEntries(drillRequests[0])).toEqual({ metric: 'approved_orders', month: '2026-09', distributor: 'all', status: 'all' })
  })

  it('8. Active Distributors opens the 3 active distributors', async () => {
    await renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'View Active Distributors details' }))
    const panel = await drawer()
    await waitFor(() => expect(rowsIn(panel)).toHaveLength(3))
    expect(within(panel).getByText('Active Distributors — September 2026')).toBeTruthy()
    expect(rowsIn(panel).map((r) => r.textContent)).toEqual([
      expect.stringContaining('Infy Tech Distribution'), expect.stringContaining('Sahabat Vape'), expect.stringContaining('Maju Jaya'),
    ])
    expect(within(panel).getByTestId('drilldown-count').textContent).toBe('3 distributors')
  })

  it('10. Inactive This Period opens with the keyboard and lists the 3 inactive distributors', async () => {
    await renderTab()
    fireEvent.keyDown(screen.getByRole('button', { name: 'View Inactive This Period details' }), { key: 'Enter' })
    const panel = await drawer()
    await waitFor(() => expect(rowsIn(panel)).toHaveLength(3))
    expect(within(panel).getByText('Inactive Distributors — September 2026')).toBeTruthy()
  })

  it('15. an empty metric opens the empty-state drawer', async () => {
    await renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'View New Distributors details' }))
    const panel = await drawer()
    await waitFor(() => expect(within(panel).getByText('No new distributors for this reporting period.')).toBeTruthy())
    expect(within(panel).getByTestId('drilldown-summary').textContent).toContain('New Distributors: 0')
  })

  it('16. after a filter change the next drill-down reflects the new scope, not stale rows', async () => {
    await renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'View New Distributors details' }))
    let panel = await drawer()
    await waitFor(() => expect(within(panel).getByText('No new distributors for this reporting period.')).toBeTruthy())
    fireEvent.keyDown(panel, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('metric-drilldown')).toBeNull())

    fireEvent.click(screen.getByTitle('Previous month'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'View New Distributors details' }).textContent).toContain('1'))
    fireEvent.click(screen.getByRole('button', { name: 'View New Distributors details' }))
    panel = await drawer()
    await waitFor(() => expect(rowsIn(panel)).toHaveLength(1))
    expect(within(panel).getByText('New Distributors — August 2026')).toBeTruthy()
    expect(rowsIn(panel)[0].textContent).toContain('Brand New Sdn Bhd')
    expect(drillRequests.at(-1)!.get('month')).toBe('2026-08')
  })

  it('18. Download PDF still builds the report PDF from the same report', async () => {
    const createObjectURL = vi.fn(() => 'blob:pdf')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))
    await renderTab()
    fireEvent.click(screen.getByRole('button', { name: /Download PDF/ }))
    await waitFor(() => expect(pdfBuilder).toHaveBeenCalledTimes(1))
    const [report] = pdfBuilder.mock.calls[0] as any[]
    expect(report.summary).toMatchObject({ activeOrders: 7, activeOrderValue: 36944, activeDistributors: 3 })
    expect(report).not.toHaveProperty('drilldown')
  })
})
