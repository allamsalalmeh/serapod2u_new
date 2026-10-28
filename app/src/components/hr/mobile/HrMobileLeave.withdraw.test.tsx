// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// UI/UX reconciliation 2026-10-26 (Wave 1 LV-08): an employee can withdraw their own pending request on My Leave;
// approved leave shows that only HR can cancel it. Success only for a stored 'cancelled' row.
const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))
vi.mock('./HrMobileContext', () => ({
  useHrMobile: () => ({ userProfile: { id: 'me' }, isManager: false, isAdmin: false, canViewOrgChart: false, organizationId: 'org-1' }),
}))

const own = [
  { id: 'p1', leave_type_id: 'lt-1', start_date: '2026-11-02', end_date: '2026-11-02', total_days: 1, status: 'pending', reason: 'x', is_half_day: false, created_at: '2026-10-26', hr_leave_types: { name: 'Annual' } },
  { id: 'a1', leave_type_id: 'lt-1', start_date: '2026-11-09', end_date: '2026-11-09', total_days: 1, status: 'approved', reason: 'y', is_half_day: false, created_at: '2026-10-25', hr_leave_types: { name: 'Annual' } },
]
const updates: { row: any; filters: any[] }[] = []
let updateResult: any = { data: [{ id: 'p1', status: 'cancelled' }], error: null }
function query(table: string) {
  const q: any = {
    select: () => q, eq: () => q, neq: () => q, order: () => q, limit: () => q,
    update: (row: any) => { const entry = { row, filters: [] as any[] }; updates.push(entry); const u: any = { eq: (...a: any[]) => { entry.filters.push(a); return u }, select: async () => updateResult }; return u },
    then: (resolve: any) => resolve({ data: table === 'hr_leave_requests' ? own : [], error: null }),
  }
  return q
}
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: (t: string) => query(t) }) }))

import HrMobileLeave from './HrMobileLeave'

afterEach(cleanup)
beforeEach(() => { toast.mockReset(); updates.length = 0; updateResult = { data: [{ id: 'p1', status: 'cancelled' }], error: null } })

async function openRequests() {
  render(<HrMobileLeave />)
  fireEvent.click(await screen.findByText('Requests'))
}

describe('HrMobileLeave — withdraw', () => {
  it('withdraws only the own pending request and confirms the stored cancellation', async () => {
    await openRequests()
    const buttons = screen.getAllByRole('button', { name: 'Withdraw request' })
    expect(buttons).toHaveLength(1)
    expect(screen.getByText('Approved leave can only be cancelled by HR.')).toBeTruthy()
    fireEvent.click(buttons[0])
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Request withdrawn' })))
    expect(updates[0].row).toEqual({ status: 'cancelled' })
    expect(updates[0].filters).toEqual(expect.arrayContaining([['id', 'p1'], ['employee_id', 'me']]))
  })

  it('reports a refusal (row hidden or not changed) as an error', async () => {
    updateResult = { data: [], error: null }
    await openRequests()
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw request' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Request not withdrawn', variant: 'destructive' })))
  })
})
