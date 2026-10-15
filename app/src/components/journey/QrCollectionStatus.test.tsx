// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import QrCollectionStatus from './QrCollectionStatus'
import { buildQrCollectionEntries, phoneLast4 } from '@/lib/consumer/qr-collection-info'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/security-access/operation', () => ({ userAllowed: vi.fn() }))

const hqPayload = {
  success: true,
  code: 'ORD-HM-0526-01-47650-e128d9fc2403',
  product_name: 'Cellera Hero',
  variant_name: 'Teh',
  collections: [
    { lane: 'shop', collected_at: '2026-10-06T10:31:42Z', points: 10, shop_name: 'Mrpanda Vape Store', person_name: 'Shop Staff A', phone_last4: '3686' },
  ],
  view_count: 3,
  last_viewed_at: '2026-10-14T10:05:00Z',
}

function mockFetch(response: { ok: boolean; json?: unknown; contentType?: string }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: response.ok,
    headers: { get: () => response.contentType ?? 'application/json' },
    json: async () => response.json,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('QrCollectionStatus', () => {
  it('shows only the collected badge to guests and never calls the HQ endpoint', () => {
    const fetchMock = mockFetch({ ok: true, json: hqPayload })
    render(<QrCollectionStatus qrCode="ORD-1" isAuthenticated={false} allCollected anyCollected />)

    expect(screen.getByText('Points for this QR code have already been collected')).toBeTruthy()
    expect(screen.queryByText('Who collected?')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('renders nothing while points are still available to a guest', () => {
    render(<QrCollectionStatus qrCode="ORD-1" isAuthenticated={false} allCollected={false} anyCollected={false} />)
    expect(screen.queryByTestId('qr-collection-status')).toBeNull()
  })

  it('lets HQ staff open who collected the code', async () => {
    const fetchMock = mockFetch({ ok: true, json: hqPayload })
    render(<QrCollectionStatus qrCode="ORD-HM-0526-01-47650-e128d9fc2403" isAuthenticated allCollected anyCollected />)

    const button = await screen.findByText('Who collected?')
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/qr-collection?code=ORD-HM-0526-01-47650-e128d9fc2403', expect.any(Object))
    expect(screen.queryByTestId('qr-collection-details')).toBeNull()

    fireEvent.click(button)
    expect(screen.getByText('Mrpanda Vape Store')).toBeTruthy()
    expect(screen.getByText(/Shop Staff A/)).toBeTruthy()
    expect(screen.getByText(/\*\*\*3686/)).toBeTruthy()
    expect(screen.getByText('+10 pts')).toBeTruthy()
  })

  it('hides the button from signed-in users without HQ access', async () => {
    const fetchMock = mockFetch({ ok: false, json: { error: 'Forbidden' } })
    render(<QrCollectionStatus qrCode="ORD-1" isAuthenticated allCollected anyCollected />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.getByText('Points for this QR code have already been collected')).toBeTruthy()
    expect(screen.queryByText('Who collected?')).toBeNull()
  })

  it('ignores an HTML redirect response for consumer accounts', async () => {
    const fetchMock = mockFetch({ ok: true, json: hqPayload, contentType: 'text/html' })
    render(<QrCollectionStatus qrCode="ORD-1" isAuthenticated allCollected anyCollected />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.queryByText('Who collected?')).toBeNull()
  })
})

describe('qr collection helpers', () => {
  it('keeps only the last four phone digits', () => {
    expect(phoneLast4('+60 12-345 3686')).toBe('3686')
    expect(phoneLast4('12')).toBeNull()
    expect(phoneLast4(null)).toBeNull()
  })

  it('lists collected rows only, newest first, with shop and person names', () => {
    const entries = buildQrCollectionEntries(
      [
        { claim_lane: 'shop', collected_points: true, points_amount: 10, points_collected_at: '2026-10-06T10:31:42Z', scanned_at: null, shop_id: 's1', consumer_id: 'u1', consumer_name: null, consumer_phone: null },
        { claim_lane: 'consumer', collected_points: false, points_amount: null, points_collected_at: null, scanned_at: '2026-10-14T10:00:00Z', shop_id: null, consumer_id: null, consumer_name: null, consumer_phone: null },
        { claim_lane: 'consumer', collected_points: true, points_amount: 5, points_collected_at: '2026-10-07T01:00:00Z', scanned_at: null, shop_id: null, consumer_id: null, consumer_name: 'Ali', consumer_phone: '0129998888' },
      ],
      new Map([['s1', 'Mrpanda Vape Store']]),
      new Map([['u1', { full_name: 'Shop Staff A', phone: '60123453686' }]]),
    )

    expect(entries).toEqual([
      { lane: 'consumer', collected_at: '2026-10-07T01:00:00Z', points: 5, shop_name: null, person_name: 'Ali', phone_last4: '8888' },
      { lane: 'shop', collected_at: '2026-10-06T10:31:42Z', points: 10, shop_name: 'Mrpanda Vape Store', person_name: 'Shop Staff A', phone_last4: '3686' },
    ])
  })
})
