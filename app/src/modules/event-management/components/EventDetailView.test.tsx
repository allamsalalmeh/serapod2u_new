// @vitest-environment jsdom
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventDetailView } from './EventDetailView'

const EVENT = { id: 'e1', name: 'Ellbow Launch', status: 'active', starts_at: '2026-01-01T00:00:00Z', ends_at: '2026-02-01T00:00:00Z', timezone: 'Asia/Kuala_Lumpur', organization_id: 'orgA' }

function mockApis() {
  ;(global.fetch as any).mockImplementation(async (url: string) => {
    const data = url.endsWith('/e1') ? EVENT : url.endsWith('/stats') ? { total: 0, staff: 0, booth: 0, staffComparison: [] } : []
    return { ok: true, json: async () => ({ data }) }
  })
}

describe('EventDetailView (admin, synthetic fixtures)', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
    mockApis()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders the four event tabs as real links with the URL tab active and a back link to Events', async () => {
    render(<EventDetailView organizationId="orgA" eventId="e1" tab="event-visitors" />)
    await waitFor(() => expect(screen.getByText('Ellbow Launch')).toBeTruthy())

    const tabs = ['Overview', 'Visitors', 'Staff & QR', 'Settings'].map((name) => screen.getByRole('link', { name }))
    expect(tabs.map((t) => t.getAttribute('href'))).toEqual([
      '/marketing/event-management/e1',
      '/marketing/event-management/e1/visitors',
      '/marketing/event-management/e1/staff-qr',
      '/marketing/event-management/e1/settings',
    ])
    expect(tabs[1].getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Events' }).getAttribute('href')).toBe('/marketing/event-management/events')
    // the Visitors tab body (search + export) is what renders
    expect(screen.getByPlaceholderText(/Search name, phone or email/)).toBeTruthy()
  })
})
