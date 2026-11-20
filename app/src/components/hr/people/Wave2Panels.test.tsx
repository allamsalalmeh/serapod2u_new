// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))

import EmploymentHistoryPanel from './EmploymentHistoryPanel'
import ReportingLinesReviewDialog from './ReportingLinesReviewDialog'

const fetchMock = vi.fn()
beforeEach(() => { toast.mockReset(); fetchMock.mockReset(); (globalThis as any).fetch = fetchMock })
afterEach(cleanup)
const respond = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: async () => body })

describe('EmploymentHistoryPanel (Wave 2)', () => {
  it('lists versions with kind, effective date and reason', async () => {
    fetchMock.mockReturnValue(respond(200, { success: true, data: [
      { version_no: 2, change_kind: 'transfer', effective_date: '2026-10-01', recorded_at: '2026-10-25T00:00:00Z', status: 'active', employment_type: 'Full-time',
        department_name: 'Sales', position_name: 'Executive', manager_name: 'M One', hire_date: '2026-01-05', end_date: null,
        changed_columns: ['department_id'], reason: 'Transfer to Sales', actor_name: 'H One' },
    ] }))
    render(<EmploymentHistoryPanel userId="u-1" />)
    expect(await screen.findByText('Transfer (department / position)')).toBeTruthy()
    expect(screen.getByText('Reason: Transfer to Sales')).toBeTruthy()
    expect(screen.getByText(/Changed: department/)).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/hr/employees/u-1/history')
  })
  it('shows the refusal message instead of an empty history', async () => {
    fetchMock.mockReturnValue(respond(403, { success: false, error: 'You do not have HR authority for this employee.' }))
    render(<EmploymentHistoryPanel userId="u-2" />)
    expect((await screen.findByRole('alert')).textContent).toContain('HR authority')
  })
})

describe('ReportingLinesReviewDialog (Wave 2)', () => {
  const finding = { employee_user_id: 'e-4', employee_name: 'E Four', employee_no: 13, manager_user_id: 'm-3', manager_name: 'M Three (former)',
    issue_code: 'MANAGER_INACTIVE', expected_manager_user_id: 'm-1', expected_manager_name: 'M One' }

  it('lists findings with readable labels and preselects the position-suggested manager', async () => {
    fetchMock.mockReturnValueOnce(respond(200, { success: true, data: [finding] }))
    render(<ReportingLinesReviewDialog open onOpenChange={() => {}} managers={[{ id: 'm-1', name: 'M One' }]} />)
    expect(await screen.findByText('Reports to a former or inactive employee')).toBeTruthy()
    expect(screen.getByText(/position hierarchy suggests M One/)).toBeTruthy()
  })
  it('requires a reason and never reports success for a refused change', async () => {
    fetchMock.mockReturnValueOnce(respond(200, { success: true, data: [finding] }))
    render(<ReportingLinesReviewDialog open onOpenChange={() => {}} managers={[{ id: 'm-1', name: 'M One' }]} />)
    fireEvent.click(await screen.findByText('Apply'))
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Reason required' }))
    fetchMock.mockReturnValueOnce(respond(400, { success: false, error: 'The selected manager is a former or inactive employee.' }))
    fireEvent.change(screen.getByLabelText(/Reason for the change/), { target: { value: 'Previous manager resigned' } })
    fireEvent.click(screen.getByText('Apply'))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Reporting line not changed' })))
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Reporting line updated' }))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ action: 'set', employee_user_id: 'e-4', manager_user_id: 'm-1', reason: 'Previous manager resigned' })
  })
  it('says so when there is nothing to fix', async () => {
    fetchMock.mockReturnValueOnce(respond(200, { success: true, data: [] }))
    render(<ReportingLinesReviewDialog open onOpenChange={() => {}} managers={[]} />)
    expect(await screen.findByText('No reporting-line issues found.')).toBeTruthy()
  })
})
