// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// B2A: the web leave view must never report a decision the database did not store, and never offers self-approval.
const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))

const request = (id: string, employeeId: string, status = 'pending') => ({
  id, employeeId, employeeName: `Person ${id}`, employeeAvatar: null, departmentId: '', departmentName: '', leaveTypeId: 'lt-1',
  leaveTypeName: 'Annual', leaveTypeColor: '#000', startDate: '2026-11-02', endDate: '2026-11-02', totalDays: 1, isHalfDay: false,
  halfDayPeriod: null, reason: 'family', attachmentUrl: null, status, approvals: [], createdAt: '2026-10-24T00:00:00Z', updatedAt: '2026-10-24T00:00:00Z',
})
const repo = {
  getLeaveRequests: vi.fn(), getLeaveTypes: vi.fn(async () => []), getLeaveBalances: vi.fn(async () => []),
  getPublicHolidays: vi.fn(async () => []), updateLeaveRequestStatus: vi.fn(), createLeaveRequest: vi.fn(),
}
vi.mock('@/modules/hr/leave/supabaseRepository', () => ({ SupabaseLeaveRepository: vi.fn(() => repo) }))

import HrLeaveRequestsView from './HrLeaveRequestsView'

afterEach(cleanup)
beforeEach(() => {
  toast.mockReset()
  repo.updateLeaveRequestStatus.mockReset()
  repo.getLeaveRequests.mockResolvedValue([request('own', 'me'), request('other', 'emp-2'), request('legacy', 'emp-3', 'Approved')])
})

const view = () => render(<HrLeaveRequestsView organizationId="org-1" userId="me" />)

describe('HrLeaveRequestsView decisions (B2A)', () => {
  it('offers Approve/Reject only on other people\'s pending requests and renders legacy statuses', async () => {
    view()
    await screen.findByText('Person other')
    expect(screen.getAllByText('Approve')).toHaveLength(1)
    expect(screen.getByText('Person legacy')).toBeTruthy() // a legacy status value ('Approved') renders instead of crashing
  })

  it('shows an error, not success, when the database refuses the decision', async () => {
    repo.updateLeaveRequestStatus.mockRejectedValue(new Error('hr_leave_not_authorized'))
    view()
    fireEvent.click(await screen.findByText('Approve'))
    fireEvent.click(screen.getAllByText('Approve').at(-1)!)
    await waitFor(() => expect(toast).toHaveBeenCalled())
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Decision not saved', variant: 'destructive' }))
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Leave approved' }))
  })

  it('shows an error when the stored status differs from the requested one', async () => {
    repo.updateLeaveRequestStatus.mockResolvedValue(request('other', 'emp-2', 'pending'))
    view()
    fireEvent.click(await screen.findByText('Approve'))
    fireEvent.click(screen.getAllByText('Approve').at(-1)!)
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Decision not saved' })))
  })

  it('confirms only a decision the database stored', async () => {
    repo.updateLeaveRequestStatus.mockResolvedValue(request('other', 'emp-2', 'approved'))
    view()
    fireEvent.click(await screen.findByText('Approve'))
    fireEvent.click(screen.getAllByText('Approve').at(-1)!)
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Leave approved' })))
  })
})
