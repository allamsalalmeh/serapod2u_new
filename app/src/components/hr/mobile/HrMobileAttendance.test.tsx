// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Wave 3: the mobile screen never writes attendance itself. Clocking, corrections and overtime go through the HR
// routes (the database records server time), and success is shown only for a stored result.
const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))
vi.mock('./HrMobileContext', () => ({ useHrMobile: () => ({ userProfile: { id: 'me' }, organizationId: 'org-1' }) }))
const supabaseFrom = vi.fn()
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: supabaseFrom }) }))

import HrMobileAttendance from './HrMobileAttendance'

const today = new Date().toISOString().slice(0, 10)
const overview = (open = false) => ({
  timezone: 'Asia/Kuala_Lumpur', today,
  open_entry: open ? { id: 'e1', clock_in_at: new Date().toISOString(), work_date: today } : null,
  entries: [{ id: 'e0', work_date: today, clock_in_at: '2026-10-20T01:00:00Z', clock_out_at: '2026-10-20T10:00:00Z', worked_minutes: 480,
              attendance_flag: 'late', source: 'mobile', review_state: 'pending', break_minutes: 60,
              exceptions: [{ id: 'x1', code: 'late_arrival', status: 'open', resolution: null }], pending_correction: false }],
  day_exceptions: [], corrections: [], shifts: [],
})
let posts: { url: string; body: any }[] = []
let postResult: (url: string) => { status: number; body: any } = () => ({ status: 200, body: { success: true, data: { status: 'clocked_in' } } })
let open = false

beforeEach(() => {
  toast.mockReset(); posts = []; open = false; supabaseFrom.mockReset()
  postResult = () => ({ status: 200, body: { success: true, data: { status: 'clocked_in' } } })
  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    const u = String(url)
    if (init?.method === 'POST') {
      posts.push({ url: u, body: JSON.parse(init.body) })
      const r = postResult(u)
      return new Response(JSON.stringify(r.body), { status: r.status })
    }
    if (u.startsWith('/api/hr/attendance/me')) return new Response(JSON.stringify({ success: true, data: overview(open) }))
    return new Response(JSON.stringify({ success: true, data: [] }))
  }) as any
})
afterEach(cleanup)

describe('HrMobileAttendance (Wave 3)', () => {
  it('clocks in through the API with the mobile channel and device time as information only', async () => {
    render(<HrMobileAttendance />)
    fireEvent.click(await screen.findByText('CLOCK IN'))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].url).toBe('/api/hr/attendance/clock')
    expect(posts[0].body).toMatchObject({ action: 'clock_in', source: 'mobile' })
    expect(typeof posts[0].body.client_at).toBe('string')
    expect(supabaseFrom).not.toHaveBeenCalled()
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: '✅ Clocked in' })))
  })

  it('shows the server refusal and no success when clocking is refused', async () => {
    postResult = () => ({ status: 409, body: { success: false, error: 'You are already clocked in.', code: 'ALREADY_CLOCKED_IN' } })
    render(<HrMobileAttendance />)
    fireEvent.click(await screen.findByText('CLOCK IN'))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Not recorded', description: 'You are already clocked in.', variant: 'destructive' })))
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: '✅ Clocked in' }))
  })

  it('offers clock-out when an entry is open', async () => {
    open = true
    render(<HrMobileAttendance />)
    fireEvent.click(await screen.findByText('CLOCK OUT'))
    await waitFor(() => expect(posts[0]?.body).toMatchObject({ action: 'clock_out' }))
  })

  it('history shows the review state; a correction is submitted for review with a reason', async () => {
    render(<HrMobileAttendance />)
    fireEvent.click(await screen.findByText('History'))
    expect(await screen.findByText(/under review/)).toBeTruthy()
    expect(screen.getByText(/Late arrival — open/)).toBeTruthy()
    fireEvent.click(screen.getByText('Request correction'))
    const form = await screen.findByTestId('correction-form')
    const submit = Array.from(form.querySelectorAll('button')).find((b) => /submit for review/i.test(b.textContent || ''))!
    expect((submit as HTMLButtonElement).disabled).toBe(true)            // reason required
    fireEvent.change(form.querySelector('textarea')!, { target: { value: 'Reader was offline' } })
    fireEvent.change(form.querySelectorAll('input[type="time"]')[0], { target: { value: '09:05' } })
    postResult = () => ({ status: 200, body: { success: true, data: { status: 'pending' } } })
    fireEvent.click(submit)
    await waitFor(() => expect(posts[0]).toMatchObject({ url: '/api/hr/attendance/corrections', body: { action: 'request', entry_id: 'e0', clock_in: '09:05', reason: 'Reader was offline' } }))
  })

  it('overtime is a separate request with an idempotency key', async () => {
    render(<HrMobileAttendance />)
    fireEvent.click(await screen.findByText('Overtime'))
    const form = await screen.findByTestId('ot-form')
    fireEvent.change(form.querySelector('textarea')!, { target: { value: 'Month-end closing' } })
    postResult = () => ({ status: 200, body: { success: true, data: { status: 'submitted', exceeds_recorded_time: true } } })
    fireEvent.click(Array.from(form.querySelectorAll('button')).find((b) => /submit overtime/i.test(b.textContent || ''))!)
    await waitFor(() => expect(posts[0]?.url).toBe('/api/hr/attendance/overtime/requests'))
    expect(posts[0].body).toMatchObject({ action: 'submit', kind: 'post', ot_minutes: 60, reason: 'Month-end closing' })
    expect(posts[0].body.idempotency_key).toBeTruthy()
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringMatching(/more than your recorded time/) })))
  })
})
