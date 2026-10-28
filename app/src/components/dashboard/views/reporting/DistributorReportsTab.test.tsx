// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import DistributorReportsTab from './DistributorReportsTab'
import {
  ALL_DISTRIBUTORS,
  buildDistributorAnalyticsReport,
  emptyAggregate,
  resolveDistributorReportPeriod,
  type DistributorAnalyticsAggregate,
} from '@/lib/reporting/distributor-analytics'

// The tab is a pure consumer of /api/reporting/distributor-analytics: it renders
// the report DTO and never queries Supabase itself. These tests drive it through
// that contract.
//
// jsdom applies no CSS, so the responsive layers that are mutually exclusive in
// a real browser (the `hidden md:block` desktop table and the `md:hidden` mobile
// cards) are BOTH in the tree here. Assertions therefore use `getAllByText`
// wherever a value is deliberately rendered in both layers.

const NOW = new Date('2026-09-07T10:00:00+08:00')

const INFY = '11111111-1111-4111-8111-111111111111'
const SAHABAT = '22222222-2222-4222-8222-222222222222'
const NEWCO = '33333333-3333-4333-8333-333333333333'

const DISTRIBUTORS = [
  { id: INFY, name: 'Infy Tech Distribution', orgCode: 'INFY', isActive: true },
  { id: SAHABAT, name: 'Sahabat Vape', orgCode: 'SHBT', isActive: true },
  { id: NEWCO, name: 'Newco Supply', orgCode: 'NEWC', isActive: true },
]

function reportFor(month: string, distributorId = ALL_DISTRIBUTORS, status = 'all') {
  const period = resolveDistributorReportPeriod(month, NOW)
  const scoped = distributorId !== ALL_DISTRIBUTORS

  const rows = [
    {
      distributorId: INFY, name: 'Infy Tech Distribution', orgCode: 'INFY', isActive: true,
      currentOrders: 11, currentValue: 1_031_600, previousOrders: 8, previousValue: 870_000,
      firstOrderAt: '2025-01-04T02:00:00.000Z', lastOrderAt: '2026-09-04T02:00:00.000Z', lifetimeOrders: 64,
    },
    {
      distributorId: SAHABAT, name: 'Sahabat Vape', orgCode: 'SHBT', isActive: true,
      currentOrders: 2, currentValue: 905_600, previousOrders: 4, previousValue: 1_120_000,
      firstOrderAt: '2025-02-01T02:00:00.000Z', lastOrderAt: '2026-09-02T02:00:00.000Z', lifetimeOrders: 40,
    },
    {
      // First ever order inside the report window — genuinely New.
      distributorId: NEWCO, name: 'Newco Supply', orgCode: 'NEWC', isActive: true,
      currentOrders: 1, currentValue: 50_000, previousOrders: 0, previousValue: 0,
      firstOrderAt: '2026-09-03T02:00:00.000Z', lastOrderAt: '2026-09-03T02:00:00.000Z', lifetimeOrders: 1,
    },
  ].filter((row) => !scoped || row.distributorId === distributorId)

  const currentOrders = rows.reduce((sum, row) => sum + row.currentOrders, 0)
  const currentValue = rows.reduce((sum, row) => sum + row.currentValue, 0)
  const previousOrders = rows.reduce((sum, row) => sum + row.previousOrders, 0)
  const previousValue = rows.reduce((sum, row) => sum + row.previousValue, 0)

  const aggregate: DistributorAnalyticsAggregate = {
    ...emptyAggregate(month, period, distributorId, scoped
      ? DISTRIBUTORS.find((row) => row.id === distributorId)!.name
      : 'All Distributors', status),
    current: { orders: currentOrders, orderValue: currentValue, activeDistributors: rows.filter((r) => r.currentOrders > 0).length },
    previous: { orders: previousOrders, orderValue: previousValue, activeDistributors: rows.filter((r) => r.previousOrders > 0).length },
    dailyTrend: Array.from({ length: period.dayCount }, (_, index) => ({
      date: `${month}-${String(index + 1).padStart(2, '0')}`,
      orders: 2,
      orderValue: 280_000,
    })),
    distributors: rows,
    statusBreakdown: [
      { status: 'approved', orders: Math.max(currentOrders - 2, 0), orderValue: currentValue },
      { status: 'submitted', orders: Math.min(currentOrders, 2), orderValue: 0 },
    ],
    topProducts: [
      {
        variantId: 'v1', productId: 'p1', productName: 'Cellera Hero',
        variantName: 'Deluxe Cellera Cartridge [ Banana Vanilla ]', productCode: 'BV',
        units: 4200, orderValue: 900_000,
      },
    ],
    recentOrders: [
      {
        orderId: 'o1', orderNo: 'D2H-0001', orderDate: '2026-09-04', createdAt: '2026-09-04T02:00:00.000Z', status: 'approved',
        distributorId: rows[0]?.distributorId ?? INFY, distributorName: rows[0]?.name ?? 'Infy Tech Distribution',
        orderValue: 120_000, itemCount: 6,
      },
    ],
  }
  return buildDistributorAnalyticsReport(aggregate, NOW)
}

const requested: { month: string; distributor: string; status: string }[] = []

function mockFetch() {
  return vi.fn(async (input: any) => {
    const url = String(input)
    // One request supplies every filter list.
    if (url.includes('/filters')) {
      return {
        ok: true,
        json: async () => ({
          months: [{ key: '2026-09' }, { key: '2026-08' }, { key: '2026-07' }],
          distributors: DISTRIBUTORS,
          statuses: [
            { value: 'submitted', label: 'Submitted' },
            { value: 'approved', label: 'Approved' },
            { value: 'closed', label: 'Closed' },
            { value: 'cancelled', label: 'Cancelled' },
          ],
        }),
      } as any
    }
    const params = new URL(url, 'http://localhost').searchParams
    const month = params.get('month') || '2026-09'
    const distributor = params.get('distributor') || ALL_DISTRIBUTORS
    const status = params.get('status') || 'all'
    requested.push({ month, distributor, status })
    return {
      ok: true,
      json: async () => ({
        report: reportFor(month, distributor, status),
        meta: { source: 'rpc', degraded: false, notice: null, generatedAt: '2026-09-07T02:00:00.000Z' },
      }),
    } as any
  })
}

/** Radix Tabs respond to pointer events, which fireEvent.click does not emit. */
function pointerUser() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
}

const props = { userProfile: { full_name: 'Admin HQ' } }

beforeEach(() => {
  requested.length = 0
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  vi.stubGlobal('fetch', mockFetch())
  // Recharts measures its container; jsdom reports zero, so give it a size.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  // Radix Select drives its listbox through Pointer Capture and scrollIntoView,
  // neither of which jsdom implements; without these the dropdown never opens.
  window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
  window.HTMLElement.prototype.setPointerCapture = vi.fn()
  window.HTMLElement.prototype.releasePointerCapture = vi.fn()
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  window.history.replaceState(null, '', '/reporting')
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function renderTab() {
  render(<DistributorReportsTab {...props} />)
  await waitFor(() => expect(screen.getByText('This Period vs Previous Period')).toBeTruthy())
}

describe('default entry', () => {
  it('opens on the current month with its MTD range and comparison, and no Apply button', async () => {
    await renderTab()

    expect(screen.getByText('September 2026')).toBeTruthy()
    expect(screen.getAllByText(/Report Period: 01 Sep 2026 – 07 Sep 2026/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Comparing with: 01 Aug 2026 – 07 Aug 2026/).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull()
    expect(requested).toEqual([{ month: '2026-09', distributor: 'all', status: 'all' }])
  })

  it('leads with approved KPIs and an approved period comparison — no Active Order Value, never Total Amount', async () => {
    await renderTab()

    const headline = screen.getByTestId('distributor-headline-kpis')
    for (const label of ['Approved Sales', 'Approved Orders', 'Active Distributors', 'Average Approved Order Value']) {
      expect(within(headline).getByText(label)).toBeTruthy()
    }
    expect(within(headline).queryByText('Active Order Value')).toBeNull()
    expect(within(headline).queryByText(/cancelled/i)).toBeNull()
    expect(screen.queryByText('Active Order Value')).toBeNull()
    expect(screen.queryByText('Avg Order Value')).toBeNull()
    expect(screen.getAllByText('Approved Sales').length).toBeGreaterThan(1) // card + comparison row
    expect(screen.getByTestId('active-kpi-definition').textContent).toMatch(/Draft and cancelled orders never count/)
    expect(screen.getAllByText('Total Orders Created').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Active Distributors').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Returning Rate').length).toBeGreaterThan(0)
    expect(screen.queryByText('Total Amount (RM)')).toBeNull()
  })

  it('offers no rolling-period preset anywhere in the report', async () => {
    await renderTab()
    for (const label of ['Last 3 Months', 'Last 6 Months', 'Last 12 Months', 'This Month', 'Last Month']) {
      expect(screen.queryByText(label)).toBeNull()
    }
  })

  it('moves Approval Rate out of the strategic KPI row into Order Processing Health', async () => {
    const user = pointerUser()
    await renderTab()
    // Not among the Overview KPI cards.
    expect(screen.queryByText('Approval Rate')).toBeNull()

    await user.click(screen.getByRole('tab', { name: /Relationship & Risk/ }))
    await waitFor(() => expect(screen.getByText('Order Processing Health')).toBeTruthy())
    expect(screen.getByText('Approval Rate')).toBeTruthy()
  })
})

describe('scope changes reload automatically and survive sub-tab switches', () => {
  it('reloads when the reporting month changes, with no Apply step', async () => {
    const user = pointerUser()
    await renderTab()

    await user.click(screen.getByTitle('Previous month'))
    await waitFor(() => expect(requested).toHaveLength(2))
    expect(requested[1]).toEqual({ month: '2026-08', distributor: 'all', status: 'all' })
    // A closed month reports the complete calendar month.
    await waitFor(() => expect(screen.getAllByText(/01 Aug 2026 – 31 Aug 2026/).length).toBeGreaterThan(0))
  })

  it('keeps month, distributor and status while moving between sub-tabs', async () => {
    const user = pointerUser()
    await renderTab()

    await user.click(screen.getByTitle('Previous month'))
    await waitFor(() => expect(requested).toHaveLength(2))

    await user.click(screen.getByRole('tab', { name: /Performance/ }))
    await waitFor(() => expect(screen.getByText('Daily Sell-In Trend')).toBeTruthy())
    await user.click(screen.getByRole('tab', { name: /Relationship & Risk/ }))
    await waitFor(() => expect(screen.getByText('Relationship Summary')).toBeTruthy())
    await user.click(screen.getByRole('tab', { name: /Overview/ }))
    await waitFor(() => expect(screen.getByText('Key Management Insights')).toBeTruthy())

    // The month held: switching sub-tabs must not reset the scope or refetch.
    expect(screen.getByText('August 2026')).toBeTruthy()
    expect(requested).toHaveLength(2)
  })

  it('writes month, distributor and status to the URL and drops the retired parameters', async () => {
    await renderTab()
    const params = new URLSearchParams(window.location.search)
    expect(params.get('month')).toBe('2026-09')
    expect(params.get('distributor')).toBe('all')
    expect(params.get('status')).toBe('all')
    expect(params.get('dateRange')).toBeNull()
    expect(params.get('orderType')).toBeNull()
  })
})

describe('single distributor mode', () => {
  it('scopes the report and hides the all-distributor sections', async () => {
    const user = pointerUser()
    await renderTab()

    await user.click(screen.getByLabelText('Distributor'))
    await user.click(await screen.findByRole('option', { name: 'Infy Tech Distribution' }))

    await waitFor(() => expect(requested).toHaveLength(2))
    expect(requested[1]).toEqual({ month: '2026-09', distributor: INFY, status: 'all' })

    await user.click(screen.getByRole('tab', { name: /Performance/ }))
    await waitFor(() => expect(screen.getByText('Daily Sell-In Trend')).toBeTruthy())

    // A leaderboard and a contribution split of one distributor say nothing.
    expect(screen.queryByText('Distributor Leaderboard')).toBeNull()
    expect(screen.queryByText('Distributor Contribution')).toBeNull()
    // Replaced by the account's own history, and Top Products is scoped by name.
    expect(screen.getByText('Recent Orders — Infy Tech Distribution')).toBeTruthy()
    expect(screen.getByText('Top Products — Infy Tech Distribution')).toBeTruthy()
  })
})

describe('status filter', () => {
  it('applies one status to the whole report, both windows included', async () => {
    const user = pointerUser()
    await renderTab()

    await user.click(screen.getByLabelText('Status'))
    await user.click(await screen.findByRole('option', { name: 'Approved' }))

    await waitFor(() => expect(requested).toHaveLength(2))
    // One request carries the status; the server applies it to the report
    // window and the comparison window alike.
    expect(requested[1]).toEqual({ month: '2026-09', distributor: 'all', status: 'approved' })
  })
})

describe('performance sub-tab', () => {
  it('shows a daily trend for the report window only — never a 12-month trend', async () => {
    const user = pointerUser()
    await renderTab()
    await user.click(screen.getByRole('tab', { name: /Performance/ }))

    await waitFor(() => expect(screen.getByText('Daily Sell-In Trend')).toBeTruthy())
    expect(screen.getByText(/01 Sep 2026 – 07 Sep 2026 — month to date/)).toBeTruthy()
    expect(screen.queryByText(/12 month/i)).toBeNull()
    expect(screen.queryByText(/Monthly Sell-In Trend/i)).toBeNull()
  })

  it('ranks the leaderboard by Order Value in both the desktop and mobile layers', async () => {
    const user = pointerUser()
    await renderTab()
    await user.click(screen.getByRole('tab', { name: /Performance/ }))
    await waitFor(() => expect(screen.getByText('Distributor Leaderboard')).toBeTruthy())

    // Rendered once for the desktop table and once for the mobile card list.
    expect(screen.getAllByText('Infy Tech Distribution').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('RM 1,031,600.00').length).toBeGreaterThanOrEqual(2)
  })

  it('labels top products canonically, never by raw UUID', async () => {
    const user = pointerUser()
    await renderTab()
    await user.click(screen.getByRole('tab', { name: /Performance/ }))
    await waitFor(() => expect(screen.getByText('Top Products Across Distributors')).toBeTruthy())

    expect(screen.getAllByText('Cellera Hero / Banana Vanilla – BV').length).toBeGreaterThan(0)
    expect(screen.queryByText('v1')).toBeNull()
  })
})

describe('relationship & risk sub-tab', () => {
  it('reports New, Returning, Inactive and At Risk with the corrected definitions', async () => {
    const user = pointerUser()
    await renderTab()
    await user.click(screen.getByRole('tab', { name: /Relationship & Risk/ }))
    await waitFor(() => expect(screen.getByText('Relationship Summary')).toBeTruthy())

    const summary = screen.getByText('Relationship Summary').closest('div[class*="sera-sc-panel"]')!
    // Newco alone is New — Infy and Sahabat both traded before this period.
    expect(within(summary as HTMLElement).getByText('New')).toBeTruthy()
    expect(within(summary as HTMLElement).getByText('Returning')).toBeTruthy()
    expect(within(summary as HTMLElement).getByText('Inactive This Period')).toBeTruthy()
    expect(within(summary as HTMLElement).getByText('At Risk')).toBeTruthy()
    // "Churned" is not a claim one missed month can support.
    expect(screen.queryByText(/Churn/i)).toBeNull()
  })

  it('filters the action list when an action card is clicked, and clears again', async () => {
    const user = pointerUser()
    await renderTab()
    await user.click(screen.getByRole('tab', { name: /Relationship & Risk/ }))
    await waitFor(() => expect(screen.getByText('Distributor Action Plan')).toBeTruthy())

    // The label appears on the summary tile and again on every row carrying
    // that action; the tile is the first in DOM order.
    await user.click(screen.getAllByRole('button', { name: /Grow \/ Support/ })[0])
    expect(screen.getByRole('button', { name: /Clear Grow \/ Support filter/ })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /Clear Grow \/ Support filter/ }))
    expect(screen.queryByRole('button', { name: /Clear Grow \/ Support filter/ })).toBeNull()
  })
})

describe('empty state', () => {
  it('says so plainly, with no NaN and no misleading -100%', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('/filters')) {
        return { ok: true, json: async () => ({ months: [{ key: '2026-09' }], distributors: DISTRIBUTORS, statuses: [] }) } as any
      }
      return {
        ok: true,
        json: async () => ({
          report: buildDistributorAnalyticsReport(emptyAggregate('2026-09', resolveDistributorReportPeriod('2026-09', NOW)), NOW),
          meta: { source: 'rpc', degraded: false, notice: null, generatedAt: '2026-09-07T02:00:00.000Z' },
        }),
      } as any
    }))

    await renderTab()

    expect(screen.getAllByText('No distributor order activity recorded for the selected period.').length).toBeGreaterThan(0)
    expect(screen.queryByText(/NaN/)).toBeNull()
    expect(screen.queryByText(/Infinity/)).toBeNull()
    expect(screen.queryByText(/-100.0%/)).toBeNull()
  })
})

describe('degraded source notice', () => {
  it('surfaces the server notice when the reporting function is not installed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: any) => {
      const url = String(input)
      if (url.includes('/filters')) {
        return { ok: true, json: async () => ({ months: [{ key: '2026-09' }], distributors: DISTRIBUTORS, statuses: [] }) } as any
      }
      return {
        ok: true,
        json: async () => ({
          report: reportFor('2026-09'),
          meta: { source: 'fallback', degraded: true, notice: 'Reporting function not installed yet.', generatedAt: '2026-09-07T02:00:00.000Z' },
        }),
      } as any
    }))

    await renderTab()
    expect(screen.getByText('Reporting function not installed yet.')).toBeTruthy()
  })
})

describe('responsive contract', () => {
  // jsdom applies no CSS, so viewport width cannot be measured here. What CAN
  // be enforced is the structure that prevents horizontal overflow at 375px:
  // every wide table is desktop-only, scrolls inside its own container, and has
  // a mobile card layer standing in for it.
  const wideSections = [
    { tab: /Performance/, heading: 'Distributor Leaderboard' },
    { tab: /Performance/, heading: 'Top Products Across Distributors' },
    { tab: /Relationship & Risk/, heading: 'Distributor Health / Risk' },
    { tab: /Relationship & Risk/, heading: 'Distributor Action Plan' },
  ]

  for (const section of wideSections) {
    it(`keeps "${section.heading}" inside a scroll container with a mobile card layer`, async () => {
      const user = pointerUser()
      await renderTab()
      await user.click(screen.getByRole('tab', { name: section.tab }))
      await waitFor(() => expect(screen.getByText(section.heading)).toBeTruthy())

      const card = screen.getByText(section.heading).closest('div[class*="sera-sc-panel"]') as HTMLElement
      const table = card.querySelector('table')!
      const scroller = table.closest('div[class*="overflow-x-auto"]')

      // The table never widens the page: it scrolls inside its own container.
      expect(scroller).not.toBeNull()
      // That container is hidden below the desktop breakpoint...
      expect(scroller!.className).toMatch(/\bhidden\b/)
      // ...and a card list renders in its place.
      expect(card.querySelector('div[class*=":hidden"]')).not.toBeNull()
    })
  }

  it('stacks the header controls and gives every one an accessible label', async () => {
    await renderTab()
    // Each control is labelled, so the stacked mobile header stays readable.
    expect(screen.getByLabelText('Reporting Month')).toBeTruthy()
    expect(screen.getByLabelText('Distributor')).toBeTruthy()
    expect(screen.getByLabelText('Status')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Refresh/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Download PDF/ })).toBeTruthy()
  })

  it('makes the sub-tab strip horizontally scrollable rather than wrapping', async () => {
    await renderTab()
    const list = screen.getByRole('tablist')
    expect(list.className).toMatch(/overflow-x-auto/)
    expect(screen.getAllByRole('tab')).toHaveLength(3)
  })
})
