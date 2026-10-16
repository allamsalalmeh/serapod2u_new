// @vitest-environment jsdom
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventManagementOverviewView } from './EventManagementOverviewView'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

const respond = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

describe('EventManagementOverviewView (synthetic fixtures)', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows the Event Management loading state, not counts or an empty state, until the request answers', async () => {
    let resolve!: (value: unknown) => void
    ;(global.fetch as any).mockReturnValueOnce(new Promise((r) => (resolve = r)))
    render(<EventManagementOverviewView organizationId="orgA" />)

    expect(screen.getByText('Loading events…')).toBeTruthy()
    expect(screen.queryByText('Total events')).toBeNull()
    expect(screen.queryByText(/No events yet/)).toBeNull()

    resolve(respond(200, { success: true, data: [] }))
    await waitFor(() => expect(screen.getByText('Event registrations')).toBeTruthy())
    expect(screen.getByText(/No events yet/)).toBeTruthy()
    expect(screen.getByText('Total events')).toBeTruthy()
  })

  it('shows counts and current events after a successful answer', async () => {
    ;(global.fetch as any).mockResolvedValueOnce(
      respond(200, {
        success: true,
        data: [{ id: 'e1', name: 'Ellbow Launch', status: 'active', starts_at: '2026-01-01T00:00:00Z', ends_at: '2026-02-01T00:00:00Z' }],
      }),
    )
    render(<EventManagementOverviewView organizationId="orgA" />)
    await waitFor(() => expect(screen.getByText('Ellbow Launch')).toBeTruthy())
  })

  it('shows a genuine 403 as access denied', async () => {
    ;(global.fetch as any).mockResolvedValueOnce(respond(403, { success: false, error: 'Forbidden', code: 'sa_forbidden' }))
    render(<EventManagementOverviewView organizationId="orgA" />)
    await waitFor(() => expect(screen.getByText(/don’t have access/)).toBeTruthy())
    expect(screen.queryByText('Total events')).toBeNull()
    expect(screen.queryByText(/No events yet/)).toBeNull()
  })

  it('shows a failed request as a failure with retry, not as denied or empty', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce(respond(500, { success: false, error: 'Failed to list events.' }))
      .mockResolvedValueOnce(respond(200, { success: true, data: [] }))
    render(<EventManagementOverviewView organizationId="orgA" />)
    await waitFor(() => expect(screen.getByText('We couldn’t load events.')).toBeTruthy())
    expect(screen.queryByText(/don’t have access/)).toBeNull()
    expect(screen.queryByText(/No events yet/)).toBeNull()
    expect(screen.queryByText('Total events')).toBeNull()

    fireEvent.click(screen.getByText('Try again'))
    await waitFor(() => expect(screen.getByText(/No events yet/)).toBeTruthy())
  })

  it('treats a network error as a failure', async () => {
    ;(global.fetch as any).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    render(<EventManagementOverviewView organizationId="orgA" />)
    await waitFor(() => expect(screen.getByText('We couldn’t load events.')).toBeTruthy())
  })
})
