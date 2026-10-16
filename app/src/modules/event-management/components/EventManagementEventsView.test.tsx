// @vitest-environment jsdom
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventManagementEventsView } from './EventManagementEventsView'

describe('EventManagementEventsView (admin, synthetic fixtures)', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('lists events fetched from the admin API', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 'e1', name: 'Ellbow Launch', status: 'active', starts_at: '2026-01-01T00:00:00Z', ends_at: '2026-02-01T00:00:00Z', organization_id: 'orgA' }],
      }),
    })

    render(<EventManagementEventsView organizationId="orgA" />)

    await waitFor(() => expect(screen.getAllByText('Ellbow Launch').length).toBeGreaterThan(0))
    expect(screen.getByText('New Event')).toBeTruthy()
    expect(screen.getByText('Event Management')).toBeTruthy()
    // desktop table + mobile list both deep-link into the event's own page
    const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(links).toContain('/marketing/event-management/e1')
  })

  it('shows the empty state when there are no events', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
    render(<EventManagementEventsView organizationId="orgA" />)
    await waitFor(() => expect(screen.getByText(/No events yet/)).toBeTruthy())
  })
})
