// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StoreOrdersClient from './StoreOrdersClient'

function mockApi(orders: { status: number; body: unknown }, requests: unknown = { available: true, requests: [] }) {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).startsWith('/api/storefront/orders/mine')) {
      return { ok: orders.status < 400, status: orders.status, json: async () => orders.body }
    }
    return { ok: true, status: 200, json: async () => requests }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('StoreOrdersClient (My Purchases)', () => {
  it('asks signed-out visitors to sign in', async () => {
    mockApi({ status: 401, body: { error: 'Sign in required.' } })
    render(<StoreOrdersClient />)
    expect((await screen.findByRole('link', { name: 'Sign in' })).getAttribute('href')).toBe('/login?next=/store/orders')
  })

  it('reads only Store orders and shows an empty state', async () => {
    const fetchMock = mockApi({ status: 200, body: { orders: [] } })
    render(<StoreOrdersClient />)
    expect(await screen.findByText('No orders yet')).toBeTruthy()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/storefront/orders/mine?channel=store')
  })

  it('lists orders with status, items, tracking, payment and problem reporting', async () => {
    mockApi(
      {
        status: 200,
        body: {
          orders: [
            { orderRef: 'ORD-PAY', status: 'pending_payment', totalAmount: 50, currency: 'MYR', createdAt: '2026-11-02T03:00:00Z', itemCount: 1, preview: ['Cat Treat'] },
            { orderRef: 'ORD-SHIP', status: 'shipped', totalAmount: 98.8, currency: 'MYR', createdAt: '2026-11-01T03:00:00Z', itemCount: 3, preview: ['Cat Treat', 'Mat'], shippingTrackingNo: 'JT123', shippingCourierName: 'J&T' },
            { orderRef: 'ORD-OPEN', status: 'delivered', totalAmount: 20, currency: 'MYR', createdAt: '2026-10-20T03:00:00Z', itemCount: 1, preview: ['Mat'] },
          ],
        },
      },
      { available: true, requests: [{ orderRef: 'ORD-OPEN', requestNo: 'REQ-1', type: 'damaged', status: 'reviewing', staffReply: 'Checking now' }] },
    )
    render(<StoreOrdersClient />)
    expect(await screen.findByText('ORD-PAY')).toBeTruthy()
    expect(screen.getByText('Waiting for payment')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Continue payment/ })).toBeTruthy()
    expect(screen.getByText('On the way')).toBeTruthy()
    expect(screen.getByText('JT123')).toBeTruthy()
    expect(screen.getByText(/Cat Treat, Mat/)).toBeTruthy()
    expect(screen.getByText('Checking now')).toBeTruthy()
    // Paid / shipped orders can be reported; the one with an open request cannot be reported twice.
    expect(screen.getAllByRole('button', { name: 'Report a problem' })).toHaveLength(1)
  })
})
