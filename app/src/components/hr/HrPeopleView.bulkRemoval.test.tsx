// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { toast, rows } = vi.hoisted(() => ({ toast: vi.fn(), rows: [] as any[] }))

// Chainable Supabase query stand-in: awaiting it yields the current synthetic rows.
const query = () => {
  const q: any = {}
  for (const method of ['select', 'eq', 'in', 'order', 'neq', 'update', 'insert', 'delete', 'upsert']) q[method] = () => q
  q.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve)
  return q
}

vi.mock('@/lib/hooks/useSupabaseAuth', () => ({ useSupabaseAuth: () => ({ supabase: { from: () => query() }, isReady: true }) }))
vi.mock('@/lib/actions/departments', () => ({ listDepartments: async () => ({ success: true, data: [] }) }))
vi.mock('@/lib/api/hr', () => ({ fetchHrPositions: async () => ({ success: true, data: [] }), updateUserHr: vi.fn() }))
vi.mock('@/lib/utils/imageCompression', () => ({ compressAvatar: vi.fn() }))
vi.mock('@/components/hr/commission/EmployeeCommissionPanel', () => ({ default: () => null }))
vi.mock('@/lib/hr/commission/use-commission-access', () => ({ useCommissionAccess: () => ({ can: () => false }) }))
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }), toast }))

import HrPeopleView from './HrPeopleView'

const ORG = 'org-a'
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const person = (n: number, name: string, over: Record<string, unknown> = {}) => ({
  id: id(n), full_name: name, email: `p${n}@example.test`, phone: null, avatar_url: null, role_code: 'USER',
  is_active: true, account_status: 'ACTIVE', account_status_changed_at: null,
  department_id: null, manager_user_id: null, position_id: null, employee_no: 900 + n, employment_type: 'Full-time',
  roles: { role_name: 'User', role_level: 50 }, positions: null,
  hr_employees: [{ organization_id: ORG, onboarding_status: 'completed', hire_date: '2026-01-05', hire_date_confirmed: true, status: 'active', end_date: null }],
  ...over,
})
const former = (n: number, name: string) => person(n, name, {
  is_active: false, account_status: 'ARCHIVED', account_status_changed_at: '2026-10-20T08:00:00Z',
  hr_employees: [{ organization_id: ORG, onboarding_status: 'completed', hire_date: '2026-01-05', hire_date_confirmed: true, status: 'resigned', end_date: '2026-10-20' }],
})

const eligibility = (row: any, over: Record<string, unknown> = {}) => ({
  user_id: row.id, full_name: row.full_name, email: row.email, employee_no: row.employee_no,
  organization_id: ORG, organization_name: 'HQ', account_status: 'ACTIVE',
  onboarding_status: 'completed', employment_status: 'active',
  classification: 'DELETE_ELIGIBLE', delete_allowed: true, archive_allowed: true, releasable: true,
  blockers: [], warnings: [], detail: null, ...over,
})

let fetchMock: ReturnType<typeof vi.fn>
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))

function mockFetch(handler: { execute?: () => unknown } = {}) {
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/identity/permanent-delete?entry=hr') return json({ success: true, data: { permission: true } })
    if (url === '/api/hr/employees/registration') return json({ success: true, data: { permission: false, phase: 'pre_go_live' } })
    if (url === '/api/hr/employees/bulk-removal/preview') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const targets = (body.user_ids as string[]).map(userId => {
        const row = rows.find(candidate => candidate.id === userId)!
        return eligibility(row, userId === id(2) ? {
          classification: 'ARCHIVE_ELIGIBLE', delete_allowed: false,
          blockers: [{ code: 'PROTECTED_RECORDS', message: 'Referenced by 2 Supply Chain records' }],
        } : {})
      })
      return json({
        success: true,
        data: {
          targets,
          summary: {
            total: targets.length,
            deleteEligible: targets.filter(target => target.classification === 'DELETE_ELIGIBLE').length,
            archiveEligible: targets.filter(target => target.classification === 'ARCHIVE_ELIGIBLE').length,
            blocked: 0, unverified: 0,
          },
        },
      })
    }
    if (url === '/api/hr/employees/bulk-removal/plan') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const count = body.plan.length
      const targets = body.plan.map((entry: any) => eligibility(rows.find(row => row.id === entry.user_id), entry.action === 'archive'
        ? { classification: 'ARCHIVE_ELIGIBLE', delete_allowed: false } : {}))
      return json({
        success: true,
        data: {
          token: 'signed-token', request_id: id(90), phrase: `REMOVE ${count} ${count === 1 ? 'EMPLOYEE' : 'EMPLOYEES'}`,
          plan_ref: 'ABCDEF12', expires_at: new Date(Date.now() + 600_000).toISOString(), targets,
          summary: { total: count, deleteEligible: count, archiveEligible: 0, blocked: 0, unverified: 0 },
        },
      })
    }
    if (url === '/api/hr/employees/bulk-removal' && init?.method === 'POST') {
      return json(handler.execute?.() ?? { success: true, complete: true, data: {} })
    }
    return json({ success: true, data: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
}

beforeEach(() => {
  rows.splice(0, rows.length, person(1, 'Alice Able'), person(2, 'Bob Baker'), person(3, 'Cara Current'), former(4, 'Deanna Former'))
  toast.mockClear()
  globalThis.crypto.randomUUID = (() => '00000000-0000-0000-0000-0000000000f1') as any
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const toolbar = () => screen.queryByTestId('bulk-actions')
const tabButton = (label: string) => screen.findByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) })

describe('HR bulk employee removal', () => {
  it('reuses the row checkboxes for a contextual toolbar with count, clear and remove', async () => {
    mockFetch()
    render(<HrPeopleView organizationId={ORG} canEdit />)
    await screen.findByText('Alice Able')
    expect(toolbar()).toBeNull()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alice Able' }))
    expect(toolbar()?.textContent).toContain('1 employee selected')
    expect(screen.getByRole('button', { name: 'Clear selection' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Remove Selected/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Bob Baker' }))
    expect(toolbar()?.textContent).toContain('2 employees selected')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alice Able' }))
    expect(toolbar()?.textContent).toContain('1 employee selected')

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(toolbar()).toBeNull()
  })

  it('select-all covers only the current filtered list and never the former employees', async () => {
    mockFetch()
    render(<HrPeopleView organizationId={ORG} canEdit />)
    await screen.findByText('Alice Able')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all employees in the current list' }))
    expect(toolbar()?.textContent).toContain('3 employees selected')

    fireEvent.change(screen.getByPlaceholderText('Search employees...'), { target: { value: 'Bob' } })
    expect(await screen.findByText('Bob Baker')).toBeTruthy()
    expect(screen.queryByText('Alice Able')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all employees in the current list' }))
    // Select-all covers only the rows in the current filtered list.
    expect(toolbar()?.textContent).toContain('1 employee selected')

    fireEvent.change(screen.getByPlaceholderText('Search employees...'), { target: { value: '' } })
    fireEvent.click(await tabButton('Former employees'))
    expect((screen.getByRole('checkbox', { name: 'Select all employees in the current list' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Select Deanna Former' }) as HTMLInputElement).disabled).toBe(true)
  })


  it('removes the reviewed selection, clears completed rows and refreshes the lifecycle counts', async () => {
    mockFetch({
      execute: () => {
        // What the canonical services would leave behind: Alice gone, Bob archived, Cara unchanged.
        rows.splice(0, rows.length,
          person(2, 'Bob Baker', {
            is_active: false, account_status: 'ARCHIVED', account_status_changed_at: '2026-10-24T08:00:00Z',
            hr_employees: [{ organization_id: ORG, onboarding_status: 'completed', hire_date: '2026-01-05', hire_date_confirmed: true, status: 'resigned', end_date: '2026-10-24' }],
          }),
          person(3, 'Cara Current'),
          former(4, 'Deanna Former'),
        )
        return {
          success: true, complete: true,
          data: {
            request_id: id(90), complete: true,
            summary: { total: 2, deleted: 1, archived: 1, blocked: 0, failed: 0, stale: 0 },
            results: [
              { user_id: id(1), name: 'Alice Able', action: 'delete', outcome: 'deleted', detail: null },
              { user_id: id(2), name: 'Bob Baker', action: 'archive', outcome: 'archived', detail: null, released: true },
            ],
          },
        }
      },
    })
    render(<HrPeopleView organizationId={ORG} canEdit />)
    await screen.findByText('Alice Able')
    expect((await tabButton('Onboarded')).textContent).toContain('3')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alice Able' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Bob Baker' }))
    fireEvent.click(screen.getByRole('button', { name: /Remove Selected/ }))

    // Bulk preview shows every selected target and the allowed operation for each.
    expect(await screen.findByText('Eligible for permanent deletion')).toBeTruthy()
    expect(screen.getByText('Archive & revoke access (history kept)')).toBeTruthy()
    const previewCall = fetchMock.mock.calls.find(([url]) => url === '/api/hr/employees/bulk-removal/preview')!
    expect(JSON.parse(String(previewCall[1].body)).user_ids.sort()).toEqual([id(1), id(2)].sort())

    fireEvent.click(screen.getByRole('button', { name: /Review confirmation/ }))
    expect(await screen.findByText(/REMOVE 2 EMPLOYEES/)).toBeTruthy()
    expect(lastPlan()).toEqual([
      { user_id: id(1), action: 'delete', employment_end: 'resigned', release_identifiers: false },
      { user_id: id(2), action: 'archive', employment_end: 'resigned', release_identifiers: true },
    ])
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'REMOVE 2 EMPLOYEES' } })
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Bulk clean-up of disposable test accounts' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove employees' }))

    expect(await screen.findByText('Deleted permanently')).toBeTruthy()
    expect(screen.getByText('Archived — access revoked')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)

    // Completed rows leave the selection and the list; counts and rows come from the database again.
    await waitFor(() => expect(toolbar()).toBeNull())
    await waitFor(() => expect(screen.queryByText('Alice Able')).toBeNull())
    expect((await tabButton('Onboarded')).textContent).toContain('1')
    expect((await tabButton('Former employees')).textContent).toContain('2')
    fireEvent.click(await tabButton('Former employees'))
    expect(await screen.findByText('Bob Baker')).toBeTruthy()
    // A hard-deleted identity is never listed as a former employee.
    expect(screen.queryByText('Alice Able')).toBeNull()
  })
})

const lastPlan = () => {
  const call = fetchMock.mock.calls.filter(([url]) => url === '/api/hr/employees/bulk-removal/plan').at(-1)!
  return JSON.parse(String(call[1].body)).plan
}

