// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StoreAffiliateClient from './StoreAffiliateClient'

const program = { open: true, joinMode: 'approval', commissionPercent: 5, attributionDays: 30, confirmAfterDays: 7, minPayoutAmount: 50, terms: 'Be honest.' }
const account = { code: 'AMINAH-7K2Q', name: 'Aminah', status: 'approved', statusLabel: 'Active', reviewNote: '', bankName: 'Maybank', bankAccountNo: '1234567890', bankAccountName: 'Aminah' }

function mockApi(me: unknown, status = 200, products: unknown[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: status < 400,
    status,
    json: async () => (String(url).includes('links=1') ? { products } : me),
  })))
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return [] }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('StoreAffiliateClient', () => {
  it('asks signed-out visitors to sign in', async () => {
    mockApi({ error: 'Unauthorized' }, 401)
    render(<StoreAffiliateClient />)
    expect((await screen.findByRole('link', { name: 'Sign in to join' })).getAttribute('href')).toBe('/login?next=/store/affiliate')
  })

  it('shows the rate, the steps and the application form before joining', async () => {
    mockApi({ signedIn: true, email: 'a@mail.com', program, affiliate: null })
    render(<StoreAffiliateClient />)
    expect(await screen.findByText('5%')).toBeTruthy()
    expect(screen.getByText('Share your link')).toBeTruthy()
    expect(screen.getByText('Be honest.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Apply now' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the waiting state while the application is reviewed', async () => {
    mockApi({ signedIn: true, program, affiliate: { ...account, status: 'pending' }, totals: { pending: 0, confirmed: 0, paid: 0, cancelled: 0, orders: 0 }, commissions: [], payouts: [] })
    render(<StoreAffiliateClient />)
    expect(await screen.findByText('Waiting for approval')).toBeTruthy()
    expect(screen.queryByText('AMINAH-7K2Q')).toBeNull()
  })

  it('shows the code, earnings, link maker and orders once approved', async () => {
    mockApi(
      {
        signedIn: true,
        program,
        affiliate: account,
        totals: { pending: 2.44, confirmed: 1, paid: 10, cancelled: 0, orders: 3 },
        commissions: [{ order: '…AB12', channel: 'Store', subId: 'tiktok', goods: 48.8, percent: 5, amount: 2.44, status: 'pending', orderedAt: '2026-11-02T03:00:00Z' }],
        payouts: [{ amount: 10, count: 2, reference: 'REF1', paidAt: '2026-11-01T03:00:00Z' }],
      },
      200,
      [{ id: 'p1', name: 'Ellbow Cat Treat', imageUrl: null, channel: 'store', path: '/store/products/p1' }],
    )
    render(<StoreAffiliateClient />)
    expect(await screen.findByText('AMINAH-7K2Q')).toBeTruthy()
    expect(screen.getByText('RM 2.44', { selector: 'p' })).toBeTruthy()
    expect(screen.getByText('tiktok')).toBeTruthy()
    expect(screen.getByText('Ref REF1 · 2 orders')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('Ellbow Cat Treat')).toBeTruthy())
    expect(screen.getByText(/^https?:\/\/.*\/store\?ref=AMINAH-7K2Q$/)).toBeTruthy()
  })
})
