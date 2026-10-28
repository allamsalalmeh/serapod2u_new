// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// UI/UX reconciliation 2026-10-26: a refused or failed read (e.g. no explicit HR attendance authority, or the Wave 3
// migration missing) is shown once, in place, with a retry — not as a burst of red toasts and not as "nothing found".
const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))

import HrAttendanceOperationsView from './HrAttendanceOperationsView'

let refuse = true
beforeEach(() => {
  toast.mockReset(); refuse = true
  globalThis.fetch = vi.fn(async () => refuse
    ? new Response(JSON.stringify({ success: false, error: 'You do not have HR authority for attendance in this company.', code: 'FORBIDDEN' }), { status: 403 })
    : new Response(JSON.stringify({ success: true, data: [] }))) as any
})
afterEach(cleanup)

const openTab = async (name: RegExp) => { const t = await screen.findByRole('tab', { name }); fireEvent.mouseDown(t); fireEvent.click(t) }

describe('HrAttendanceOperationsView load states', () => {
  it('shows a refused read in place on each tab and raises no toast', async () => {
    render(<HrAttendanceOperationsView />)
    expect(await screen.findByText('You do not have HR authority for attendance in this company.')).toBeTruthy()
    await openTab(/Exceptions/)
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0))
    expect(screen.queryByText(/No exceptions for this filter/)).toBeNull()
    await openTab(/Overtime/)
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0))
    expect(screen.queryByText(/No overtime requests for this filter/)).toBeNull()
    expect(toast).not.toHaveBeenCalled()
  })

  it('"Try again" reloads and clears the message once the server answers', async () => {
    render(<HrAttendanceOperationsView />)
    await screen.findByText('You do not have HR authority for attendance in this company.')
    refuse = false
    fireEvent.click(screen.getAllByRole('button', { name: /Try again/ })[0])
    await waitFor(() => expect(screen.queryByText('You do not have HR authority for attendance in this company.')).toBeNull())
    expect(await screen.findByText('No employees visible for this date.')).toBeTruthy()
  })

  it('opens the tab it is asked for (deep link)', async () => {
    refuse = false
    render(<HrAttendanceOperationsView initialTab="corrections" />)
    expect(await screen.findByText(/Your own requests never appear here/)).toBeTruthy()
  })
})
