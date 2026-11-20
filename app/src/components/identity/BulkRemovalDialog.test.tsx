// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import BulkRemovalDialog from './BulkRemovalDialog'

const ORG = '11111111-1111-1111-1111-111111111111'
const A = '00000000-0000-0000-0000-0000000000a1'
const B = '00000000-0000-0000-0000-0000000000b1'
const C = '00000000-0000-0000-0000-0000000000c1'

const row = (userId: string, name: string, over: Record<string, unknown> = {}) => ({
  user_id: userId, full_name: name, email: `${name.split(' ')[0].toLowerCase()}@example.test`, employee_no: 100,
  organization_id: ORG, organization_name: 'HQ', account_status: 'ACTIVE',
  onboarding_status: 'completed', employment_status: 'active',
  classification: 'DELETE_ELIGIBLE', delete_allowed: true, archive_allowed: true, releasable: true,
  blockers: [], warnings: [], detail: null, ...over,
})

const targets = [
  { id: A, name: 'Alice Able', employeeNo: 101 },
  { id: B, name: 'Bob Baker', employeeNo: 102 },
  { id: C, name: 'Cara Blocked', employeeNo: 103 },
]

const rows = () => [
  row(A, 'Alice Able', { employee_no: 101 }),
  row(B, 'Bob Baker', {
    employee_no: 102, classification: 'ARCHIVE_ELIGIBLE', delete_allowed: false,
    blockers: [{ code: 'PROTECTED_RECORDS', message: 'Referenced by 2 Supply Chain records' }],
  }),
  row(C, 'Cara Blocked', {
    employee_no: 103, classification: 'BLOCKED', delete_allowed: false, archive_allowed: false, releasable: false,
    blockers: [{ code: 'PROTECTED_ROOT', message: 'This person holds Root Access.' }],
  }),
]

const summary = () => ({ total: 3, deleteEligible: 1, archiveEligible: 1, blocked: 1, unverified: 0 })
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))

let fetchMock: ReturnType<typeof vi.fn>
type Handler = {
  preview?: () => unknown
  plan?: (plan: Array<{ user_id: string; action: string; release_identifiers: boolean }>) => unknown
  execute?: () => [unknown, number]
}

function mockFetch(handler: Handler = {}) {
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/hr/employees/bulk-removal/preview') {
      const requestBody = JSON.parse(String(init?.body ?? '{}'))
      const requested: string[] = Array.isArray(requestBody.user_ids) ? requestBody.user_ids : []
      const preview = (handler.preview?.() as { targets?: unknown[]; summary?: unknown } | undefined)
        ?? {
          targets: rows().filter(row => requested.includes(row.user_id)),
          summary: {
            total: requested.length,
            deleteEligible: rows().filter(row => requested.includes(row.user_id) && row.classification === 'DELETE_ELIGIBLE').length,
            archiveEligible: rows().filter(row => requested.includes(row.user_id) && row.classification === 'ARCHIVE_ELIGIBLE').length,
            blocked: rows().filter(row => requested.includes(row.user_id) && row.classification === 'BLOCKED').length,
            unverified: 0,
          },
        }
      return json({ success: true, data: preview })
    }
    if (url === '/api/hr/employees/bulk-removal/plan') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const count = body.plan.length
      return json({
        success: true,
        data: {
          token: 'signed-token', request_id: '00000000-0000-0000-0000-0000000000f1',
          phrase: `REMOVE ${count} ${count === 1 ? 'EMPLOYEE' : 'EMPLOYEES'}`, plan_ref: 'ABCDEF12',
          expires_at: new Date(Date.now() + 600_000).toISOString(), targets: rows(), summary: summary(),
          ...(handler.plan?.(body.plan) as object ?? {}),
        },
      })
    }
    if (url === '/api/hr/employees/bulk-removal' && init?.method === 'POST') {
      const [body, status] = handler.execute?.() ?? [{
        success: true, complete: true,
        data: {
          request_id: '00000000-0000-0000-0000-0000000000f1', complete: true,
          summary: { total: 2, deleted: 1, archived: 1, blocked: 0, failed: 0, stale: 0, conflict: 0, unconfirmed: 0 },
          results: [
            { user_id: A, name: 'Alice Able', action: 'delete', outcome: 'deleted', detail: null },
            { user_id: B, name: 'Bob Baker', action: 'archive', outcome: 'archived', detail: null, released: true },
          ],
        },
      }, 200]
      return json(body, status)
    }
    return json({ success: true, data: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
}

const renderDialog = (over: Partial<ComponentProps<typeof BulkRemovalDialog>> = {}) => {
  const onCompleted = vi.fn()
  const onClose = vi.fn()
  const notify = vi.fn()
  render(<BulkRemovalDialog targets={targets} onClose={onClose} onCompleted={onCompleted} notify={notify} {...over} />)
  return { onCompleted, onClose, notify }
}

const lastBody = (path: string) => {
  const call = fetchMock.mock.calls.filter(([url]) => url === path).at(-1)!
  return JSON.parse(String(call[1].body))
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('BulkRemovalDialog', () => {
  it('shows the authoritative plan for every selected employee and only offers allowed actions', async () => {
    mockFetch()
    renderDialog()
    expect(await screen.findByText('Alice Able')).toBeTruthy()
    expect(screen.getByText('Bob Baker')).toBeTruthy()
    expect(screen.getByText('Cara Blocked')).toBeTruthy()
    expect(screen.getByText('Eligible for permanent deletion')).toBeTruthy()
    expect(screen.getByText('Archive & revoke access (history kept)')).toBeTruthy()
    expect(screen.getByText('Blocked — no removal permitted')).toBeTruthy()
    expect(screen.getByText(/2 Supply Chain records/)).toBeTruthy()
    expect(screen.getByText(/holds Root Access/)).toBeTruthy()

    const alice = screen.getByLabelText('Operation for Alice Able') as HTMLSelectElement
    expect(Array.from(alice.options).map(option => option.value)).toEqual(['delete', 'archive', 'skip'])
    const bob = screen.getByLabelText('Operation for Bob Baker') as HTMLSelectElement
    expect(Array.from(bob.options).map(option => option.value)).toEqual(['archive', 'skip'])
    const cara = screen.getByLabelText('Operation for Cara Blocked') as HTMLSelectElement
    expect(Array.from(cara.options).map(option => option.value)).toEqual(['skip'])
    expect(cara.value).toBe('skip')
    // Nothing is executed when the dialog opens: only the read-only preview was requested.
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/hr/employees/bulk-removal/preview'])
  })

  it('binds the confirmed plan, requires the exact server phrase, and defaults identifier release on', async () => {
    mockFetch()
    const { onCompleted } = renderDialog()
    await screen.findByText('Alice Able')
    fireEvent.click(screen.getByRole('button', { name: /Review confirmation/ }))
    expect(await screen.findByText(/REMOVE 2 EMPLOYEES/)).toBeTruthy()

    const planBody = lastBody('/api/hr/employees/bulk-removal/plan')
    expect(planBody.plan).toEqual([
      { user_id: A, action: 'delete', employment_end: 'resigned', release_identifiers: false },
      { user_id: B, action: 'archive', employment_end: 'resigned', release_identifiers: true },
    ])
    expect(screen.getByText(/identifiers released/)).toBeTruthy()
    expect(screen.getByLabelText(/Reason \(required for permanent deletion\)/)).toBeTruthy()

    const confirm = screen.getByRole('button', { name: 'Remove employees' }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'REMOVE 2 EMPLOYEE' } })
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/hr/employees/bulk-removal')).toHaveLength(0)

    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'REMOVE 2 EMPLOYEES' } })
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Duplicate test accounts created before go-live' } })
    await waitFor(() => expect(confirm.disabled).toBe(false))
    fireEvent.click(confirm)
    await waitFor(() => expect(onCompleted).toHaveBeenCalled())

    const execution = lastBody('/api/hr/employees/bulk-removal')
    expect(execution).toMatchObject({
      request_id: '00000000-0000-0000-0000-0000000000f1', batch_token: 'signed-token',
      confirmation: 'REMOVE 2 EMPLOYEES', reason: 'Duplicate test accounts created before go-live',
    })
    expect(execution.plan).toEqual(planBody.plan)
    expect(await screen.findByText('Deleted permanently')).toBeTruthy()
    expect(screen.getByText('Archived — access revoked')).toBeTruthy()
    expect(onCompleted).toHaveBeenCalledWith({
      complete: true,
      outcomes: [
        { userId: A, name: 'Alice Able', outcome: 'deleted' },
        { userId: B, name: 'Bob Baker', outcome: 'archived' },
      ],
    })
  })

  it('allows identifier release to be turned off before confirming', async () => {
    mockFetch()
    renderDialog()
    await screen.findByText('Alice Able')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Release email and phone for archived employees' }))
    fireEvent.click(screen.getByRole('button', { name: /Review confirmation/ }))
    await screen.findByText(/REMOVE 2 EMPLOYEES/)
    const planBody = lastBody('/api/hr/employees/bulk-removal/plan')
    expect(planBody.plan[1]).toMatchObject({ user_id: B, action: 'archive', release_identifiers: false })
  })


  it('keeps the reason optional for an archive-only plan and shows the employment outcome per employee', async () => {
    mockFetch({
      preview: () => ({
        targets: [row(B, 'Bob Baker', {
          employee_no: 102, classification: 'ARCHIVE_ELIGIBLE', delete_allowed: false,
          blockers: [{ code: 'PROTECTED_RECORDS', message: 'Referenced by 2 Supply Chain records' }],
        })],
        summary: { total: 1, deleteEligible: 0, archiveEligible: 1, blocked: 0, unverified: 0 },
      }),
    })
    renderDialog({ targets: [targets[1]] })
    await screen.findByText('Bob Baker')
    const outcome = screen.getByLabelText('Employment outcome for Bob Baker') as HTMLSelectElement
    expect(outcome.value).toBe('resigned')
    fireEvent.change(outcome, { target: { value: 'terminated' } })

    fireEvent.click(screen.getByRole('button', { name: /Review confirmation/ }))
    expect(await screen.findByText(/REMOVE 1 EMPLOYEE/)).toBeTruthy()
    expect((screen.getByLabelText('Reason (optional)') as HTMLTextAreaElement).value).toBe('')
    expect(lastBody('/api/hr/employees/bulk-removal/plan').plan)
      .toEqual([{ user_id: B, action: 'archive', employment_end: 'terminated', release_identifiers: true }])

    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'REMOVE 1 EMPLOYEE' } })
    const confirm = screen.getByRole('button', { name: 'Remove employees' }) as HTMLButtonElement
    await waitFor(() => expect(confirm.disabled).toBe(false))
  })

  it('cannot confirm when every selected employee is blocked', async () => {
    mockFetch({
      preview: () => ({
        targets: [row(C, 'Cara Blocked', {
          classification: 'BLOCKED', delete_allowed: false, archive_allowed: false,
          blockers: [{ code: 'PROTECTED_ROOT', message: 'This person holds Root Access.' }],
        })],
        summary: { total: 1, deleteEligible: 0, archiveEligible: 0, blocked: 1, unverified: 0 },
      }),
    })
    renderDialog({ targets: [targets[2]] })
    await screen.findByText('Cara Blocked')
    expect((screen.getByRole('button', { name: /Review confirmation/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders an accurate mixed result and never presents it as full success', async () => {
    mockFetch({
      execute: () => ([{
        success: false, complete: false,
        data: {
          request_id: '00000000-0000-0000-0000-0000000000f1', complete: false,
          summary: { total: 3, deleted: 1, archived: 1, blocked: 0, failed: 1, stale: 0, conflict: 0, unconfirmed: 0 },
          results: [
            { user_id: A, name: 'Alice Able', action: 'delete', outcome: 'deleted', detail: null },
            { user_id: B, name: 'Bob Baker', action: 'archive', outcome: 'archived', detail: null, released: true },
            { user_id: C, name: 'Cara Blocked', action: 'archive', outcome: 'failed', detail: 'The archive did not complete.' },
          ],
        },
      }, 200]),
    })
    const { onCompleted, notify } = renderDialog()
    await screen.findByText('Alice Able')
    fireEvent.click(screen.getByRole('button', { name: /Review confirmation/ }))
    await screen.findByText(/REMOVE 2 EMPLOYEES/)
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'REMOVE 2 EMPLOYEES' } })
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Batch clean-up of test accounts' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove employees' }))

    expect(await screen.findByText('Failed — not completed')).toBeTruthy()
    expect(screen.getByText('Deleted permanently')).toBeTruthy()
    expect(screen.getByText('Archived — access revoked')).toBeTruthy()
    expect(screen.getByText(/The archive did not complete/)).toBeTruthy()
    expect(screen.getByText('Deleted')).toBeTruthy()
    expect(screen.getByText('Failed')).toBeTruthy()
    expect(onCompleted).toHaveBeenCalledWith({
      complete: false,
      outcomes: [
        { userId: A, name: 'Alice Able', outcome: 'deleted' },
        { userId: B, name: 'Bob Baker', outcome: 'archived' },
        { userId: C, name: 'Cara Blocked', outcome: 'failed' },
      ],
    })
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Bulk removal finished with exceptions' }))
  })

  it('returns to a fresh preview when the server says the plan or eligibility changed', async () => {
    mockFetch({
      execute: () => ([{ success: false, code: 'PREVIEW_STALE', error: 'Some selected employees changed since the preview.' }, 409]),
    })
    renderDialog()
    await screen.findByText('Alice Able')
    fireEvent.click(screen.getByRole('button', { name: /Review confirmation/ }))
    await screen.findByText(/REMOVE 2 EMPLOYEES/)
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'REMOVE 2 EMPLOYEES' } })
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Batch clean-up of test accounts' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove employees' }))

    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/hr/employees/bulk-removal/preview')).toHaveLength(2))
    expect(await screen.findByRole('button', { name: /Review confirmation/ })).toBeTruthy()
    expect(screen.queryByLabelText(/to confirm/)).toBeNull()
  })
})

  it('reports a transient conflict as unchanged and retries only that employee with its reviewed operation', async () => {
    mockFetch({
      execute: () => ([{
        success: false, complete: false,
        data: {
          request_id: '00000000-0000-0000-0000-0000000000f1', complete: false,
          summary: { total: 1, deleted: 0, archived: 0, blocked: 0, failed: 0, stale: 0, conflict: 1, unconfirmed: 0 },
          results: [{
            user_id: A, name: 'Alice Able', action: 'delete', outcome: 'conflict', retryable: true,
            detail: 'Another operation briefly held this person\'s records. Nothing was changed for this person; a fresh review and retry is safe.',
          }],
        },
      }, 200]),
    })
    // Review only Alice so the retry subset is unambiguous.
    renderDialog({ targets: [targets[0]] })
    await screen.findByText('Alice Able')
    fireEvent.click(screen.getByRole('button', { name: /Review confirmation/ }))
    await screen.findByText(/REMOVE 1 EMPLOYEE/)
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'REMOVE 1 EMPLOYEE' } })
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Bulk clean-up of test accounts' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove employees' }))

    expect(await screen.findByText('Temporary conflict — unchanged')).toBeTruthy()
    expect(screen.getByText(/Nothing was changed for this person/)).toBeTruthy()
    expect(screen.getByText('Conflict')).toBeTruthy()
    const retry = screen.getByRole('button', { name: 'Retry unchanged employees (1)' })
    fireEvent.click(retry)

    // A fresh authoritative preview for just the unchanged employee, with the operation preserved.
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/hr/employees/bulk-removal/preview')).toHaveLength(2))
    const lastPreview = fetchMock.mock.calls.filter(([url]) => url === '/api/hr/employees/bulk-removal/preview').at(-1)!
    expect(JSON.parse(String(lastPreview[1].body)).user_ids).toEqual([A])
    const operation = (await screen.findByLabelText('Operation for Alice Able')) as HTMLSelectElement
    expect(operation.value).toBe('delete')
    expect(screen.queryByLabelText(/to confirm/)).toBeNull()
    expect(screen.getByRole('button', { name: /Review confirmation/ })).toBeTruthy()
  })


