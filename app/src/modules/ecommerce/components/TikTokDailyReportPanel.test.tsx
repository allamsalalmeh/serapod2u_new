// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDailyReport } from '@/lib/marketplace/tiktok-daily-report'
import TikTokDailyReportPanel from './TikTokDailyReportPanel'

const report = buildDailyReport({
    slot: 'packing',
    now: new Date('2026-10-07T01:35:00Z'),
    shops: [{ id: 'sera', name: 'SeraOutdoor' }],
    lines: [
        { shop_id: 'sera', order_id: '5801', package_id: 'p1', seller_sku: 'PROMO - HB (1) FREE T1L (1)', product_name: null, variation: 'Black', quantity: 2, order_substatus: 'Awaiting collection', created_time: '2026-10-06T05:00:00Z' },
    ],
})

describe('TikTokDailyReportPanel', () => {
    const fetchMock = vi.fn()

    beforeEach(() => {
        fetchMock.mockReset()
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ report }) })
        vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
        cleanup()
        vi.unstubAllGlobals()
    })

    it('shows items and parcels with download links for the selected shop', async () => {
        render(<TikTokDailyReportPanel shopId="sera" shopName="SeraOutdoor" shopCount={2} />)

        await waitFor(() => expect(screen.getByText('HIGHBACK')).toBeTruthy())
        expect(screen.getByText('TUMBLER 1L')).toBeTruthy()
        expect(screen.getByText('5801')).toBeTruthy()
        expect(fetchMock.mock.calls[0][0]).toBe('/api/ecommerce/tiktok-shop/daily-report?shop_id=sera&slot=packing&format=json')
        expect(screen.getByRole('link', { name: 'Excel' }).getAttribute('href')).toBe('/api/ecommerce/tiktok-shop/daily-report?shop_id=sera&slot=packing&format=xlsx')
        expect(screen.getByRole('link', { name: 'Text' }).getAttribute('href')).toContain('format=txt')
    })

    it('asks for a day when switching to shipped, and can cover all shops', async () => {
        render(<TikTokDailyReportPanel shopId="sera" shopName="SeraOutdoor" shopCount={2} />)
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

        await userEvent.click(screen.getByRole('button', { name: 'Shipped' }))
        await userEvent.selectOptions(screen.getByRole('combobox'), 'all')

        await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)?.[0])).toMatch(/shop_id=all&slot=shipped&format=json&date=\d{4}-\d{2}-\d{2}$/))
        expect(screen.getByRole('link', { name: 'Excel' }).getAttribute('href')).toMatch(/shop_id=all&slot=shipped&format=xlsx&date=/)
    })
})
