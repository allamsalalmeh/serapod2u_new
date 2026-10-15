// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSalesReport, buildSettlementReport, buildShippingReport, periodRange } from '@/lib/marketplace/tiktok-reports'
import TikTokReportsPanel from './TikTokReportsPanel'

const NOW = new Date('2026-10-15T04:00:00Z')
const shops = [{ id: 'sera', name: 'SeraOutdoor' }, { id: 'ell', name: 'Ellbow' }]
const range = periodRange('day', '2026-10-15', NOW)
const envelope = (kind: string, data: unknown) => ({
    kind, period: 'day', date: '2026-10-15', range, shops, lastSyncAt: '2026-10-15T03:23:00Z', generatedAt: NOW.toISOString(), data,
})

const sales = envelope('sales', buildSalesReport({
    range, shops, now: NOW,
    lines: [{ shop_id: 'sera', order_id: '1', product_name: 'Camping Chair', seller_sku: 'CHAIR', order_status: 'Completed', quantity: 2, subtotal_after_discount: '1234.50', created_time: '2026-10-15T01:00:00Z' }],
}))
const settlement = envelope('settlement', buildSettlementReport({
    range, shops, payouts: [], unsettled: [], timings: [],
    settlements: [{ shop_id: 'sera', transaction_type: 'Order', related_order_id: '1', settled_date: '2026-10-15', total_revenue: 100, total_fees: -20, total_settlement_amount: 80, customer_refund: null, fee_breakdown: { tiktok_shop_commission_fee: -20 } }],
}))
const shipping = envelope('shipping', buildShippingReport({
    range, shops, settlements: [], now: NOW,
    lines: [{ shop_id: 'sera', order_id: '583001', order_status: 'Shipped', order_substatus: 'In transit', shipping_provider: 'J&T Express', tracking_number: 'JNT777', quantity: 1, created_time: '2026-10-14T01:00:00Z', paid_time: '2026-10-14T01:00:00Z', shipped_time: '2026-10-15T01:00:00Z', delivered_time: null, cancelled_time: null }],
}))

describe('TikTokReportsPanel', () => {
    const fetchMock = vi.fn()

    beforeEach(() => {
        vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
        fetchMock.mockReset()
        fetchMock.mockImplementation(async (url: string) => {
            const params = new URL(url, 'http://x').searchParams
            const kind = params.get('report')
            const base = kind === 'settlement' ? settlement : kind === 'shipping' ? shipping : sales
            const period = params.get('period') as 'day' | 'week' | 'month'
            const date = params.get('date') as string
            const report = { ...base, period, date, range: periodRange(period, date, NOW) }
            return { ok: true, json: async () => ({ report }) }
        })
        vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
        cleanup()
        vi.unstubAllGlobals()
    })

    const shopList = [{ id: 'sera', shop_name: 'SeraOutdoor' }, { id: 'ell', shop_name: 'Ellbow' }]

    it('opens on today\'s sales for all shops with an Excel link', async () => {
        render(<TikTokReportsPanel shops={shopList} defaultShopId="sera" />)
        await waitFor(() => expect(screen.getAllByText('RM 1,234.50').length).toBeGreaterThan(0))
        const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://x')
        expect(url.pathname).toBe('/api/ecommerce/tiktok-shop/reports')
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ shop_id: 'all', report: 'sales', period: 'day' })
        expect(screen.getByText(periodRange('day', url.searchParams.get('date')!, NOW).label)).toBeTruthy()
        expect(screen.getByText('Camping Chair')).toBeTruthy()
        expect(screen.getByRole('link', { name: 'Excel' }).getAttribute('href')).toContain('format=xlsx')
    })

    it('steps back a whole month after switching from day to month', async () => {
        render(<TikTokReportsPanel shops={shopList} defaultShopId="sera" />)
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        const today = new URL(String(fetchMock.mock.calls[0][0]), 'http://x').searchParams.get('date')!

        await userEvent.click(screen.getByRole('tab', { name: 'Month' }))
        await waitFor(() => expect(screen.getByText(periodRange('month', today, NOW).label)).toBeTruthy())
        await userEvent.click(screen.getByRole('button', { name: 'Previous period' }))

        const previous = periodRange('month', today, NOW).prevDate
        await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(`period=month&date=${previous}`))
        await waitFor(() => expect(screen.getByText(periodRange('month', previous, NOW).label)).toBeTruthy())
    })

    it('shows the settlement chain and the shipped orders with tracking numbers', async () => {
        render(<TikTokReportsPanel shops={shopList} defaultShopId="sera" />)
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

        await userEvent.click(screen.getByRole('tab', { name: 'Settlement' }))
        await waitFor(() => expect(screen.getByText('From sales to bank')).toBeTruthy())
        expect(screen.getByText('TikTok commission')).toBeTruthy()
        expect(screen.getAllByText('RM 80.00').length).toBeGreaterThan(0)

        await userEvent.click(screen.getByRole('tab', { name: 'Shipping' }))
        await waitFor(() => expect(screen.getByText('JNT777')).toBeTruthy())
        expect(screen.getByText('583001')).toBeTruthy()

        await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Shop' }), 'sera')
        await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain('shop_id=sera&report=shipping'))
    })
})
