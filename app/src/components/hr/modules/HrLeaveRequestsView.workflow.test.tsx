// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// UI/UX reconciliation 2026-10-26 (Wave 1 LV-08, Wave 3 W3-LV-05): the HR leave screen offers every decision the
// database allows — approve/reject (always visible, also on touch screens), withdraw one's own pending request, HR
// cancellation of approved leave — groups balances in a tab (deep link ?tab=balances) and quotes working days from
// the database instead of a browser-only count.
let search = new URLSearchParams()
vi.mock('next/navigation', () => ({ useSearchParams: () => search }))
const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))
vi.mock('./HrLeaveBalancesPanel', () => ({ default: () => <div>Balances panel</div> }))

const request = (id: string, employeeId: string, status = 'pending') => ({
  id, employeeId, employeeName: `Person ${id}`, employeeAvatar: null, departmentId: '', departmentName: '', leaveTypeId: 'lt-1',
  leaveTypeName: 'Annual', leaveTypeColor: '#000', startDate: '2026-11-02', endDate: '2026-11-02', totalDays: 1, isHalfDay: false,
  halfDayPeriod: null, reason: 'family', attachmentUrl: null, status, approvals: [], createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z',
})
const repo = {
  getLeaveRequests: vi.fn(), getLeaveTypes: vi.fn(async () => [{ id: 'lt-1', name: 'Annual', code: 'AL', status: 'active', color: '#000' }]),
  getLeaveBalances: vi.fn(async () => []), getPublicHolidays: vi.fn(async () => []), updateLeaveRequestStatus: vi.fn(), createLeaveRequest: vi.fn(),
}
vi.mock('@/modules/hr/leave/supabaseRepository', () => ({ SupabaseLeaveRepository: vi.fn(() => repo) }))

import HrLeaveRequestsView from './HrLeaveRequestsView'

afterEach(cleanup)
beforeEach(() => {
  search = new URLSearchParams(); toast.mockReset(); repo.updateLeaveRequestStatus.mockReset(); repo.createLeaveRequest.mockReset()
  repo.getLeaveRequests.mockResolvedValue([request('own', 'me'), request('other', 'emp-2'), request('done', 'emp-3', 'approved'), request('mine-ok', 'me', 'approved')])
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 503 })) as any
})
const view = () => render(<HrLeaveRequestsView organizationId="org-1" userId="me" />)

describe('HrLeaveRequestsView — HR leave workflow', () => {
  it('shows Approve/Reject without hover (touch screens) and never on the viewer\'s own request', async () => {
    view()
    const card = (await screen.findByText('Person other')).closest('[class*="group"]') as HTMLElement
    const approve = within(card).getByText('Approve')
    expect(approve.parentElement?.className ?? '').not.toMatch(/opacity-0/)
    const own = screen.getByText('Person own').closest('[class*="group"]') as HTMLElement
    expect(within(own).queryByText('Approve')).toBeNull()
  })

  it('lets the employee withdraw their own pending request (stored status must be cancelled)', async () => {
    repo.updateLeaveRequestStatus.mockResolvedValue(request('own', 'me', 'cancelled'))
    view()
    const own = (await screen.findByText('Person own')).closest('[class*="group"]') as HTMLElement
    fireEvent.click(within(own).getByText('Withdraw'))
    fireEvent.click(screen.getAllByRole('button', { name: 'Withdraw' }).at(-1)!)
    await waitFor(() => expect(repo.updateLeaveRequestStatus).toHaveBeenCalledWith('own', 'cancelled', undefined))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Request withdrawn' })))
  })

  it('offers HR cancellation only on other people\'s approved leave and reports a refusal as an error', async () => {
    repo.updateLeaveRequestStatus.mockRejectedValue(new Error('hr_leave_not_authorized'))
    view()
    const done = (await screen.findByText('Person done')).closest('[class*="group"]') as HTMLElement
    const mine = screen.getByText('Person mine-ok').closest('[class*="group"]') as HTMLElement
    expect(within(mine).queryByText('Cancel leave')).toBeNull()
    fireEvent.click(within(done).getByText('Cancel leave'))
    expect(screen.getByText('Cancel approved leave (HR)')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel leave' }).at(-1)!)
    await waitFor(() => expect(repo.updateLeaveRequestStatus).toHaveBeenCalledWith('done', 'cancelled', undefined))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Leave not cancelled', variant: 'destructive' })))
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Approved leave cancelled' }))
  })

  it('opens the balances tab from the menu deep link (?tab=balances) and hides the request list there', async () => {
    search = new URLSearchParams('tab=balances')
    view()
    expect(await screen.findByText('Balances panel')).toBeTruthy()
    expect(screen.queryByText('Person other')).toBeNull()
    expect(screen.queryByRole('button', { name: /New Request/ })).toBeNull()
  })

  it('shows a load failure with a retry instead of "No leave requests found"', async () => {
    repo.getLeaveRequests.mockRejectedValueOnce(new Error('network down'))
    view()
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText('No leave requests found')).toBeNull()
  })

  it('uses the database working-day quote in New Request and blocks submission on a quote error', async () => {
    globalThis.fetch = vi.fn(async (url: any) => String(url).startsWith('/api/hr/leave/quote')
      ? new Response(JSON.stringify({ success: true, data: { working_days: 2, warnings: [], errors: ['Not enough balance in 2026: 2 day(s) requested, 1 available.'], non_working_dates: [{ date: '2026-11-07', day_type: 'rest_day' }], per_year: [] } }))
      : new Response(JSON.stringify({ success: false }), { status: 503 })) as any
    view()
    fireEvent.click(await screen.findByRole('button', { name: /New Request/ }))
    const [start, end] = Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[]
    fireEvent.change(start, { target: { value: '2026-11-06' } })
    fireEvent.change(end, { target: { value: '2026-11-09' } })
    fireEvent.change(screen.getByPlaceholderText(/Describe the reason/), { target: { value: 'Family trip' } })
    expect(await screen.findByText('Working days (company calendar)', {}, { timeout: 3000 })).toBeTruthy()
    expect(screen.getByText(/Not enough balance in 2026/)).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Submit Request' }) as HTMLButtonElement).disabled).toBe(true)
    // The fake drop zone is gone; the dialog says plainly that documents are not uploaded here.
    expect(screen.queryByText(/Drag & drop/)).toBeNull()
  })
})
