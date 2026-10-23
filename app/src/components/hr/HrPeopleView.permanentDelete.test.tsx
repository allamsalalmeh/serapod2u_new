// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { toast, rows } = vi.hoisted(() => ({ toast: vi.fn(), rows: [] as any[] }))

// A chainable stand-in for the Supabase query builder: every call returns itself; awaiting it yields the rows.
const query = () => {
  const q: any = {}
  for (const m of ['select', 'eq', 'in', 'order', 'neq']) q[m] = () => q
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve)
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

const EMP = '00000000-0000-0000-0000-00000000e001'
const row = (status: 'completed' | 'reset' | 'pending') => ({
  id: EMP, full_name: 'Tess Tester', email: 'tess@example.test', phone: null, avatar_url: null, role_code: 'USER', is_active: true,
  department_id: null, manager_user_id: null, position_id: null, employee_no: 42, employment_type: 'Full-time',
  roles: { role_name: 'User', role_level: 50 }, positions: null,
  hr_employees: [{ organization_id: 'org-a', onboarding_status: status, hire_date: '2026-01-05', hire_date_confirmed: status !== 'pending' }],
})
const preview = (over: Record<string, unknown> = {}) => ({
  target: { user_id: EMP, full_name: 'Tess Tester', email: 'tess@example.test', phone: null, organization_name: 'HQ', employee_no: 42, has_identity: true, has_login: true },
  employment: [{ employment_id: 'e-1', employee_no: 42, onboarding_status: 'pending' }],
  cleanup: [{ table: 'hr_employees', count: 1, label: 'HR employment record (employee number)' }], retained: [],
  blockers: [], confirmation_phrase: 'tess@example.test', preview_token: 'tok-1', allowed: true, ...over,
})

let fetchMock: ReturnType<typeof vi.fn>
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))

function mockFetch(handlers: { permission?: boolean; preview?: () => unknown; execute?: () => [unknown, number] }) {
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/identity/permanent-delete?entry=hr') return json({ success: true, data: { permission: handlers.permission ?? true } })
    if (url.startsWith('/api/identity/permanent-delete?entry=hr&user_id=')) return json({ success: true, data: handlers.preview?.() ?? preview() })
    if (url === '/api/identity/permanent-delete' && init?.method === 'POST') {
      const [body, status] = handlers.execute?.() ?? [{ success: true, data: { status: 'completed', deletionId: 'd-1', authVerified: true } }, 200]
      return json(body, status)
    }
    if (url === '/api/hr/employees/registration') return json({ success: true, data: { permission: false, phase: 'pre_go_live' } })
    return json({ success: true, data: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
}

const openMenu = async () => fireEvent.click(await screen.findByRole('button', { name: 'Actions for Tess Tester' }))
const showAwaiting = async () => fireEvent.click(await screen.findByText(/Awaiting onboarding/))

beforeEach(() => {
  rows.splice(0, rows.length, row('completed'))
  toast.mockClear()
  globalThis.crypto.randomUUID = (() => '00000000-0000-0000-0000-00000000f001') as any
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('HR People: Delete Employee Permanently (canonical identity deletion)', () => {
  it('is offered only when the server says the caller may use it', async () => {
    mockFetch({ permission: false })
    render(<HrPeopleView organizationId="org-a" canEdit />)
    await openMenu()
    expect(screen.queryByText('Delete Employee Permanently')).toBeNull()
  })

  it('is offered for a PENDING employee too (onboarding state does not decide eligibility)', async () => {
    rows.splice(0, rows.length, row('pending'))
    mockFetch({})
    render(<HrPeopleView organizationId="org-a" canEdit={false} />)
    await showAwaiting()
    await openMenu()
    expect(screen.getByText('Delete Employee Permanently')).toBeTruthy()
    expect(screen.queryByText('Remove HR Registration')).toBeNull()
  })

  it('preview → reason + typed phrase + confirmation → shared endpoint (entry=hr) → success only when verified → list refresh', async () => {
    mockFetch({})
    render(<HrPeopleView organizationId="org-a" canEdit />)
    await openMenu()
    fireEvent.click(await screen.findByText('Delete Employee Permanently'))
    expect(await screen.findByText(/Eligible — irreversible/)).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(`/api/identity/permanent-delete?entry=hr&user_id=${encodeURIComponent(EMP)}`, expect.anything())

    const confirm = screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'Duplicate test account before go-live' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /deleted permanently/ }))
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'wrong@example.test' } })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'TESS@example.test' } })
    await waitFor(() => expect(confirm.disabled).toBe(false))
    rows.splice(0, rows.length)
    fireEvent.click(confirm)

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Deleted permanently' })))
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(post[0]).toBe('/api/identity/permanent-delete')
    expect(JSON.parse(post[1].body)).toEqual({ user_id: EMP, entry: 'hr', request_id: '00000000-0000-0000-0000-00000000f001',
      preview_token: 'tok-1', reason: 'Duplicate test account before go-live', confirmation: 'TESS@example.test' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Actions for Tess Tester' })).toBeNull())
  })

  it('blocked: explains why and never enables deletion', async () => {
    mockFetch({ preview: () => preview({ allowed: false, blockers: [{ code: 'PROTECTED_RECORDS', message: 'Referenced by 2 Supply Chain records (orders.created_by).' }] }) })
    render(<HrPeopleView organizationId="org-a" canEdit />)
    await openMenu()
    fireEvent.click(await screen.findByText('Delete Employee Permanently'))
    expect(await screen.findByText(/Referenced by 2 Supply Chain records/)).toBeTruthy()
    expect(screen.queryByLabelText('Reason (required)')).toBeNull()
    expect((screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('an unverified login removal is an error, not a success', async () => {
    mockFetch({ execute: () => [{ success: false, code: 'AUTH_CLEANUP_REQUIRED', error: 'The login could not be confirmed as removed.' }, 502] })
    render(<HrPeopleView organizationId="org-a" canEdit />)
    await openMenu()
    fireEvent.click(await screen.findByText('Delete Employee Permanently'))
    await screen.findByText(/Eligible — irreversible/)
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'Duplicate test account before go-live' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /deleted permanently/ }))
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'tess@example.test' } })
    const confirm = screen.getByRole('button', { name: 'Delete permanently' }) as HTMLButtonElement
    await waitFor(() => expect(confirm.disabled).toBe(false))
    fireEvent.click(confirm)
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Not deleted', variant: 'destructive' })))
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Deleted permanently' }))
    expect(await screen.findByText('The login could not be confirmed as removed.')).toBeTruthy()
  })
})
