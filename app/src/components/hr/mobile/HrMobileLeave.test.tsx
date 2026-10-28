// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Wave 1 closure: mobile leave must never report a submission or decision the database did not store, and must send
// a half-day period (hr_leave_requests_half_day_chk).
const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))

let isManager = false
vi.mock('./HrMobileContext', () => ({
  useHrMobile: () => ({ userProfile: { id: 'me' }, isManager, isAdmin: false, canViewOrgChart: false, organizationId: 'org-1' }),
}))

type Result = { data: any; error: any }
const state: { inserts: any[]; updates: any[]; insertResult: Result; updateResult: Result; team: any[] } = {
  inserts: [], updates: [], insertResult: { data: [{ id: 'n1', status: 'pending' }], error: null },
  updateResult: { data: [{ id: 't1', status: 'approved' }], error: null }, team: [],
}
function query(table: string) {
  const q: any = {
    _filters: [] as any[],
    select: () => q, eq: (...a: any[]) => { q._filters.push(a); return q }, neq: () => q, order: () => q,
    limit: () => q,
    insert: (row: any) => { state.inserts.push(row); return { select: async () => state.insertResult } },
    update: (row: any) => { state.updates.push(row); const u: any = { eq: () => u, select: async () => state.updateResult }; return u },
    then: (resolve: any) => {
      if (table === 'hr_leave_types') return resolve({ data: [{ id: 'lt-1', name: 'Annual', code: 'AL', max_consecutive_days: null }], error: null })
      if (table === 'hr_leave_requests' && q._filters.some((f: any[]) => f[0] === 'status')) return resolve({ data: state.team, error: null })
      return resolve({ data: [], error: null })
    },
  }
  return q
}
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: (t: string) => query(t) }) }))

import HrMobileLeave from './HrMobileLeave'

afterEach(cleanup)
beforeEach(() => {
  toast.mockReset()
  state.inserts = []; state.updates = []
  state.insertResult = { data: [{ id: 'n1', status: 'pending' }], error: null }
  state.updateResult = { data: [{ id: 't1', status: 'approved' }], error: null }
  state.team = []
  isManager = false
})

async function openApply() {
  render(<HrMobileLeave />)
  fireEvent.click(await screen.findByText('Apply'))
}
function fill(start: string, end: string) {
  const [s, e] = document.querySelectorAll('input[type="date"]') as unknown as HTMLInputElement[]
  fireEvent.change(document.querySelector('select')!, { target: { value: 'lt-1' } })
  fireEvent.change(s, { target: { value: start } })
  fireEvent.change(e, { target: { value: end } })
}
const submitButton = () => screen.getAllByRole('button').find((b) => /submit/i.test(b.textContent || ''))!

describe('HrMobileLeave (Wave 1 closure)', () => {
  it('sends a half-day period and confirms only a stored pending request', async () => {
    await openApply()
    fill('2026-11-02', '2026-11-02')
    fireEvent.click(screen.getByLabelText(/Half-day leave/i))
    fireEvent.click(screen.getByRole('radio', { name: 'Afternoon' }))
    fireEvent.click(submitButton())
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: '✅ Leave Applied' })))
    expect(state.inserts[0]).toMatchObject({ is_half_day: true, half_day_period: 'afternoon', total_days: 0.5, status: 'pending' })
  })

  it('refuses a half day without a period before calling the database', async () => {
    await openApply()
    fill('2026-11-02', '2026-11-02')
    fireEvent.click(screen.getByLabelText(/Half-day leave/i))
    fireEvent.click(submitButton())
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' })))
    expect(state.inserts).toHaveLength(0)
  })

  it('shows the guard message, not success, when the database refuses the submission', async () => {
    state.insertResult = { data: null, error: { message: 'hr_onboarding_pending' } }
    await openApply()
    fill('2026-11-02', '2026-11-03')
    fireEvent.click(submitButton())
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Leave not submitted' })))
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: '✅ Leave Applied' }))
  })

  it('does not report a manager decision that the database did not store', async () => {
    isManager = true
    state.team = [{ id: 't1', employee_id: 'emp-2', leave_type_id: 'lt-1', start_date: '2026-11-02', end_date: '2026-11-02', total_days: 1, status: 'pending', is_half_day: false, reason: null, created_at: '2026-10-24', hr_leave_types: { name: 'Annual' }, users: { full_name: 'Person Two' } }]
    state.updateResult = { data: [], error: null } // RLS hid the row: no direct report / no MSS
    render(<HrMobileLeave />)
    fireEvent.click(await screen.findByText(/Approvals/))
    fireEvent.click(await screen.findByText('Approve'))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Decision not saved' })))
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: '✅ Approved' }))
    expect(state.updates[0]).toEqual({ status: 'approved' }) // the DB stamps approver/time; client sends status only
  })
})

describe('Wave 3 leave quote (server working days)', () => {
  it('shows the database working-day count and blocks submission on a quote error', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, data: {
      working_days: 2, warnings: ['Annual normally needs 3 day(s) notice.'], errors: ['Not enough balance in 2027: 2 day(s) requested, 1 available.'],
      non_working_dates: [{ date: '2027-03-06', day_type: 'rest_day' }], per_year: [{ year: 2027, days: 2, available_after: -1, balance: { has_entitlement: true, available: 1 } }],
    } }))) as any
    try {
      await openApply()
      fill('2027-03-05', '2027-03-08')
      const quote = await screen.findByTestId('leave-quote', {}, { timeout: 2000 })
      expect(quote.textContent).toMatch(/2 working days/)
      expect(quote.textContent).toMatch(/2027-03-06 \(rest day\)/)
      expect(quote.textContent).toMatch(/Not enough balance/)
      expect((submitButton() as HTMLButtonElement).disabled).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

