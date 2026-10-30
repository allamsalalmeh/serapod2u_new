// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// UI/UX reconciliation 2026-10-26 (Wave 2 HI-02): an effective-dated employment change is recorded from the HR
// Profile → History tab instead of a developer-console call. Only changed fields are sent; the database decides.
const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))

import EmploymentHistoryPanel, { buildEmploymentChange } from './EmploymentHistoryPanel'

const options = {
  departments: [{ id: 'd-ops', dept_name: 'Operations' }],
  positions: [{ id: 'p-lead', name: 'Team Lead' }],
  managers: [{ id: 'm1', name: 'Manager One' }, { id: 'e3', name: 'Self' }],
}
let posts: { url: string; body: any }[] = []
let postResult: any = { success: true, data: { status: 'changed', version_no: 3 } }
beforeEach(() => {
  toast.mockReset(); posts = []; postResult = { success: true, data: { status: 'changed', version_no: 3 } }
  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    if (init?.method === 'POST') { posts.push({ url: String(url), body: JSON.parse(init.body) }); return new Response(JSON.stringify(postResult), { status: postResult.success ? 200 : 403 }) }
    return new Response(JSON.stringify({ success: true, data: [] }))
  }) as any
})
afterEach(cleanup)

describe('buildEmploymentChange', () => {
  it('sends only changed fields; "none" clears a reference', () => {
    expect(buildEmploymentChange({ department: '', position: '', manager: '', type: '', probationEnd: '', status: '' })).toEqual({})
    expect(buildEmploymentChange({ department: 'd-ops', position: 'none', manager: '', type: 'Contract', probationEnd: '', status: '' }))
      .toEqual({ department_id: 'd-ops', position_id: null, employment_type: 'Contract' })
  })
})

describe('EmploymentHistoryPanel — record change', () => {
  it('is read-only without change options (employee / viewer)', async () => {
    render(<EmploymentHistoryPanel userId="e3" />)
    await screen.findByText('No employment history recorded yet.')
    expect(screen.queryByText(/Record employment change/)).toBeNull()
  })

  it('records a back-dated transfer with a reason and reloads the history', async () => {
    const onChanged = vi.fn()
    render(<EmploymentHistoryPanel userId="e3" change={options} onChanged={onChanged} />)
    fireEvent.click(await screen.findByText(/Record employment change/))
    // The employee is never offered as their own manager.
    expect(screen.queryByRole('option', { name: 'Self' })).toBeNull()
    const save = screen.getByRole('button', { name: 'Record change' }) as HTMLButtonElement
    expect(save.disabled).toBe(true) // nothing changed yet
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'd-ops' } })
    fireEvent.change(screen.getByLabelText('Effective date'), { target: { value: '2026-10-01' } })
    expect(save.disabled).toBe(true) // reason still missing
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'Transfer approved by GM' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(posts[0]).toEqual({ url: '/api/hr/employees/e3/employment', body: { changes: { department_id: 'd-ops' }, effective_date: '2026-10-01', reason: 'Transfer approved by GM' } }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Employment change recorded' })))
    expect(onChanged).toHaveBeenCalled()
  })

  it('shows the database refusal (e.g. own record) and keeps the form open', async () => {
    postResult = { success: false, error: 'You cannot change your own HR record.' }
    render(<EmploymentHistoryPanel userId="e3" change={options} />)
    fireEvent.click(await screen.findByText(/Record employment change/))
    fireEvent.change(screen.getByLabelText('Employment type'), { target: { value: 'Contract' } })
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'UAT HI-02 check' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record change' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Change not recorded', description: 'You cannot change your own HR record.', variant: 'destructive' })))
    expect(screen.getByRole('button', { name: 'Record change' })).toBeTruthy()
  })
})
