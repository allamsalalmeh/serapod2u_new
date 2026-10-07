// @vitest-environment jsdom
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventManagementLandingView } from './EventManagementLandingView'

describe('EventManagementLandingView (admin, synthetic fixtures)', () => {
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

    render(<EventManagementLandingView organizationId="orgA" />)

    await waitFor(() => expect(screen.getByText('Ellbow Launch')).toBeTruthy())
    expect(screen.getByText('New Event')).toBeTruthy()
    expect(screen.getByText(/Event Management/)).toBeTruthy()
  })

  it('shows the empty state when there are no events', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) })
    render(<EventManagementLandingView organizationId="orgA" />)
    await waitFor(() => expect(screen.getByText(/No events yet/)).toBeTruthy())
  })
})
