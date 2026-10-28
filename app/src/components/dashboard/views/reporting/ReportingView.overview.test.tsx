// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildExecutiveOverviewReport, type OverviewOrderInput } from '@/lib/reporting/executive-overview'
import { buildOverviewDrilldown, isOverviewDrilldownMetric } from '@/lib/reporting/executive-overview-drilldown'

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: () => ({}) }) }))
vi.mock('@/components/providers/ThemeProvider', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))
vi.mock('@/lib/hr/commission/use-commission-access', () => ({ useCommissionAccess: () => ({ can: () => false }) }))
vi.mock('@/components/reporting/commission/CommissionReportingTab', () => ({ default: () => null }))
vi.mock('./ConsumerAnalyticsTab', () => ({ default: () => null }))
vi.mock('./DistributorReportsTab', () => ({ default: () => null }))
vi.mock('./OperationsTab', () => ({ default: () => null }))
vi.mock('./ProductsTab', () => ({ default: () => null }))
vi.mock('./ShopReportsTab', () => ({ default: () => null }))

import ReportingView from './ReportingView'

const NOW = new Date('2026-10-20T10:00:00+08:00')
let seq = 0
function o(orderType: string, status: string, orderDate: string, buyer: [string, string, string?], value: number): OverviewOrderInput {
  seq += 1
  return {
    id: `order-${seq}`, orderNo: `SO-${seq}`, orderType, status, orderDate, createdAt: `${orderDate}T03:00:00Z`,
    buyerId: buyer[0], buyerName: buyer[1], buyerType: 'DIST', buyerCode: buyer[2] ?? null,
    items: [{ variantId: 'v1', qty: 1, lineTotal: value }],
  }
}
const ORDERS = [
  o('D2H', 'approved', '2026-09-03', ['d1', 'Infy Tech', 'INFY'], 1200),
  o('D2H', 'closed', '2026-09-18', ['d1', 'Infy Tech', 'INFY'], 800),
  o('S2D', 'shipped_distributor', '2026-09-20', ['s1', 'Kedai Satu'], 150.5),
  o('D2H', 'submitted', '2026-09-21', ['d2', 'Maju Jaya'], 999),
  o('D2H', 'approved', '2026-08-14', ['d2', 'Maju Jaya', 'MAJU'], 640),
]

const requests: string[] = []
beforeEach(() => {
  requests.length = 0
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  window.history.replaceState(null, '', '/reporting?tab=overview&month=2026-09')
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = new URL(String(input), 'http://localhost')
    requests.push(`${url.pathname}${url.search}`)
    const month = url.searchParams.get('month')!
    if (url.pathname === '/api/reporting/stats') {
      const report = buildExecutiveOverviewReport({ month, orders: ORDERS, now: NOW })
      return new Response(JSON.stringify({ report, earliestMonth: '2026-08' }), { status: 200 })
    }
    if (url.pathname === '/api/reporting/stats/drilldown') {
      const metric = url.searchParams.get('metric')
      if (!isOverviewDrilldownMetric(metric)) return new Response('{}', { status: 400 })
      if (month === '2026-07') return new Response(JSON.stringify({ error: 'Database unavailable' }), { status: 500 })
      const drilldown = buildOverviewDrilldown({
        metric, month, orders: ORDERS, now: NOW, buyerId: url.searchParams.get('buyer'),
        page: Number(url.searchParams.get('page') ?? 0), pageSize: Number(url.searchParams.get('pageSize') ?? 25),
      })
      return new Response(JSON.stringify({ drilldown }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function renderOverview() {
  render(<ReportingView userProfile={{ full_name: 'Tester' }} />)
  await screen.findByText('Confirmed Sales Orders')
  await waitFor(() => expect(screen.getByRole('button', { name: 'View Confirmed Sales Orders details' })).toBeTruthy())
}

describe('Executive Overview cards', () => {
  it('no longer renders the Shop Sales (S2D) or Approved Sales Value cards', async () => {
    await renderOverview()
    expect(screen.queryByText('Shop Sales (S2D)')).toBeNull()
    expect(screen.queryByText('Approved Sales Value')).toBeNull()
    expect(screen.queryByText('D2H + S2D')).toBeNull()
  })

  it('keeps every other headline and sales card, with their values', async () => {
    await renderOverview()
    for (const title of ['H2M Purchases Value', 'Distributor Sales (D2H)', 'Confirmed Sales Orders', 'Total Units Sold', 'Active Buyers', 'Sales Pipeline Value', 'Cancelled Orders']) {
      expect(screen.getByText(title)).toBeTruthy()
    }
    expect(screen.getByText('2 approved orders')).toBeTruthy() // D2H orders in September
    expect(screen.getByText('1 distributors · 1 shops')).toBeTruthy()
  })

  it('lays the cards out without an empty grid cell', async () => {
    await renderOverview()
    const headline = screen.getByTestId('overview-headline-grid')
    expect(headline.children).toHaveLength(2)
    expect(headline.className).toContain('sm:grid-cols-2')
    expect(headline.className).not.toContain('grid-cols-3')
    const detail = screen.getByTestId('overview-detail-grid')
    const spans = Array.from(detail.children).map((el) => (el as HTMLElement).className)
    expect(spans).toHaveLength(5)
    // xl: 6 columns = 2+2+2 / 3+3; sm: 2 columns with the fifth card spanning both.
    const xl = spans.map((c) => Number(/xl:col-span-(\d)/.exec(c)?.[1]))
    expect(xl).toEqual([2, 2, 2, 3, 3])
    expect(spans[4]).toContain('sm:col-span-2')
  })

  it('marks only the two drill-down cards as interactive', async () => {
    await renderOverview()
    const interactive = document.querySelectorAll('[data-drilldown="true"]')
    expect(Array.from(interactive).map((el) => el.getAttribute('aria-label'))).toEqual([
      'View Confirmed Sales Orders details',
      'View Active Buyers details',
    ])
    expect((interactive[0] as HTMLElement).className).toContain('cursor-pointer')
  })
})

describe('Confirmed Sales Orders drill-down', () => {
  it('opens a modal for the selected month whose rows reconcile with the card', async () => {
    await renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'View Confirmed Sales Orders details' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Confirmed Sales Orders — September 2026')).toBeTruthy()
    await within(dialog).findByTestId('overview-drilldown-table')
    const rows = within(dialog).getAllByTestId('overview-drilldown-row')
    expect(rows).toHaveLength(3)
    expect(within(dialog).getByTestId('overview-drilldown-total').textContent).toBe('3 orders')
    expect(rows[0].textContent).toContain('SO-3')
    expect(rows[0].textContent).toContain('Kedai Satu')
    expect(rows[0].textContent).toContain('Shipped')
    expect(rows[0].textContent).toContain('RM 150.50')
    expect(rows[2].textContent).toContain('RM 1,200.00')
    expect(within(dialog).queryByText(/do not reconcile/)).toBeNull()
    expect(requests).toContain('/api/reporting/stats/drilldown?metric=confirmed_orders&month=2026-09&page=0&pageSize=25')
  })

  it('links each order to its existing Supply Chain detail page', async () => {
    await renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'View Confirmed Sales Orders details' }))
    const link = await screen.findByRole('link', { name: 'View order SO-1' })
    expect(link.getAttribute('href')).toBe('/supply-chain/orders/order-1')
  })

  it('opens from the keyboard and closes with Escape, keeping the month', async () => {
    await renderOverview()
    const card = screen.getByRole('button', { name: 'View Confirmed Sales Orders details' })
    fireEvent.keyDown(card, { key: 'Enter' })
    const dialog = await screen.findByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(window.location.search).toContain('month=2026-09')
    expect(window.location.search).toContain('tab=overview')
  })

  it('reads the newly selected month the next time it opens', async () => {
    await renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }))
    await waitFor(() => expect(requests).toContain('/api/reporting/stats?month=2026-08'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'View Confirmed Sales Orders details' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'View Confirmed Sales Orders details' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Confirmed Sales Orders — August 2026')).toBeTruthy()
    await within(dialog).findByTestId('overview-drilldown-table')
    expect(within(dialog).getAllByTestId('overview-drilldown-row').map((r) => r.textContent?.includes('Maju Jaya'))).toEqual([true])
  })

  it('shows an empty state for a month without confirmed orders', async () => {
    window.history.replaceState(null, '', '/reporting?tab=overview&month=2026-06')
    render(<ReportingView userProfile={{}} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'View Confirmed Sales Orders details' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'View Confirmed Sales Orders details' }))
    const empty = await screen.findByTestId('overview-drilldown-empty')
    expect(empty.textContent).toContain('No confirmed sales orders in June 2026')
  })

  it('shows an error state with retry when the records cannot be loaded', async () => {
    window.history.replaceState(null, '', '/reporting?tab=overview&month=2026-07')
    render(<ReportingView userProfile={{}} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'View Confirmed Sales Orders details' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'View Confirmed Sales Orders details' }))
    const alert = await within(await screen.findByRole('dialog')).findByRole('alert')
    expect(alert.textContent).toContain('Database unavailable')
    expect(within(alert).getByRole('button', { name: /Retry/ })).toBeTruthy()
  })
})

describe('Active Buyers drill-down', () => {
  it('lists each buyer once with its confirmed orders and sales, reconciling with the card', async () => {
    await renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'View Active Buyers details' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Active Buyers — September 2026')).toBeTruthy()
    await within(dialog).findByTestId('overview-drilldown-table')
    const rows = within(dialog).getAllByTestId('overview-drilldown-row')
    expect(rows).toHaveLength(2) // Infy Tech placed two orders but is one buyer; Maju Jaya only has pipeline.
    expect(within(dialog).getByTestId('overview-drilldown-total').textContent).toBe('2 buyers')
    expect(rows[0].textContent).toContain('Infy Tech')
    expect(rows[0].textContent).toContain('INFY')
    expect(rows[0].textContent).toContain('RM 2,000.00')
    expect(within(rows[0]).getAllByRole('cell')[2].textContent).toBe('2')
    expect(dialog.textContent).not.toContain('Maju Jaya')
    expect(within(dialog).getByRole('link', { name: 'View buyer Infy Tech' }).getAttribute('href')).toBe('/supply-chain/organizations/d1')
  })

  it("opens a buyer's confirmed orders and returns to the buyer list", async () => {
    await renderOverview()
    fireEvent.click(screen.getByRole('button', { name: 'View Active Buyers details' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(await within(dialog).findByRole('button', { name: 'View confirmed orders for Infy Tech' }))
    await within(dialog).findByText('Confirmed Sales Orders · Infy Tech — September 2026')
    await waitFor(() => expect(within(dialog).getAllByTestId('overview-drilldown-row')).toHaveLength(2))
    expect(requests).toContain('/api/reporting/stats/drilldown?metric=confirmed_orders&month=2026-09&page=0&pageSize=25&buyer=d1')
    fireEvent.click(within(dialog).getByRole('button', { name: /Back to Active Buyers/ }))
    await within(dialog).findByText('Active Buyers — September 2026')
  })

  it('switches months: August lists August buyers only', async () => {
    window.history.replaceState(null, '', '/reporting?tab=overview&month=2026-08')
    render(<ReportingView userProfile={{}} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'View Active Buyers details' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'View Active Buyers details' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Active Buyers — August 2026')).toBeTruthy()
    await within(dialog).findByTestId('overview-drilldown-table')
    expect(within(dialog).getAllByTestId('overview-drilldown-row').map((r) => r.textContent?.includes('Maju Jaya'))).toEqual([true])
  })
})
