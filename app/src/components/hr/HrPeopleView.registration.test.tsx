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
  hr_employees: [{ organization_id: 'org-a', onboarding_status: status, hire_date: '2026-01-05', hire_date_confirmed: true }],
})
const preview = (over: Record<string, unknown> = {}) => ({
  employee: { user_id: EMP, full_name: 'Tess Tester', employee_no: 42, onboarding_status: 'completed' },
  phase: 'pre_go_live', categories: {}, kept: { login: true, access_assignments: 2, employee_no: 42 },
  blockers: { delete: [], reset: [] }, delete_allowed: true, reset_allowed: true, preview_token: 'tok-1', ...over,
})

let fetchMock: ReturnType<typeof vi.fn>
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))

function mockFetch(handlers: { permission?: boolean; preview?: () => unknown; execute?: () => [unknown, number] }) {
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/hr/employees/registration' && (!init || !init.method || init.method === 'GET')) {
      return json({ success: true, data: { permission: handlers.permission ?? true, phase: 'pre_go_live' } })
    }
    if (url.startsWith('/api/hr/employees/registration?user_id=')) return json({ success: true, data: handlers.preview?.() ?? preview() })
    if (url === '/api/hr/employees/registration' && init?.method === 'POST') {
      const [body, status] = handlers.execute?.() ?? [{ success: true, data: { status: 'completed', employee_no: 42 } }, 200]
      return json(body, status)
    }
    return json({ success: true, data: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
}

const openMenu = async () => fireEvent.click(await screen.findByRole('button', { name: 'Actions for Tess Tester' }))

beforeEach(() => {
  rows.splice(0, rows.length, row('completed'))
  toast.mockClear()
  globalThis.crypto.randomUUID = (() => '00000000-0000-0000-0000-00000000f001') as any
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('HR People: Remove HR Registration / Reset HR Registration', () => {
  it('shows Reset and Remove only when the server says the caller holds the permission', async () => {
    mockFetch({ permission: false })
    render(<HrPeopleView organizationId="org-a" canEdit />)
    await openMenu()
    expect(screen.getByText('Edit Employee')).toBeTruthy()
    expect(screen.queryByText('Remove HR Registration')).toBeNull()
    expect(screen.queryByText('Reset HR Registration')).toBeNull()
  })

  it('remove registration: server preview → reason + confirmation → server execution → toast and list refresh', async () => {
    mockFetch({})
    render(<HrPeopleView organizationId="org-a" canEdit />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/hr/employees/registration'))
    await openMenu()
    fireEvent.click(await screen.findByText('Remove HR Registration'))
    expect(await screen.findByText('Allowed')).toBeTruthy()
    expect(screen.getAllByText('EMP-0042').length).toBeGreaterThan(0)
    expect(fetchMock).toHaveBeenCalledWith(`/api/hr/employees/registration?user_id=${encodeURIComponent(EMP)}`)

    const confirm = screen.getAllByRole('button', { name: 'Remove HR Registration' }).at(-1)!
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'Test record onboarded by mistake' } })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm that/ }))
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false))
    rows.splice(0, rows.length, row('pending'))
    fireEvent.click(confirm)

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'HR registration removed' })))
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(JSON.parse(post[1].body)).toEqual({ user_id: EMP, action: 'delete', request_id: '00000000-0000-0000-0000-00000000f001',
      preview_token: 'tok-1', reason: 'Test record onboarded by mistake' })
    // List reloaded: the person left the Onboarded view.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Actions for Tess Tester' })).toBeNull())
  })

  it('blocked removal explains why, offers Reset instead, and never enables Remove', async () => {
    mockFetch({ preview: () => preview({ delete_allowed: false,
      blockers: { delete: [{ code: 'HR_RECORDS', message: 'This employee has 3 attendance records.' }], reset: [] } }) })
    render(<HrPeopleView organizationId="org-a" canEdit />)
    await openMenu()
    fireEvent.click(await screen.findByText('Remove HR Registration'))
    expect(await screen.findByText('This employee has 3 attendance records.')).toBeTruthy()
    expect(screen.queryByLabelText('Reason (required)')).toBeNull()
    expect((screen.getAllByRole('button', { name: 'Remove HR Registration' }).at(-1) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /Reset HR Registration instead/ }))
    expect(await screen.findByText('Allowed')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Reset HR Registration' }).length).toBeGreaterThan(0)
  })

  it('a server refusal at execution is shown as an error, not a success', async () => {
    mockFetch({ execute: () => [{ success: false, code: 'BLOCKED', error: 'Not allowed for this employee. Nothing was changed.' }, 409] })
    render(<HrPeopleView organizationId="org-a" canEdit />)
    await openMenu()
    fireEvent.click(await screen.findByText('Remove HR Registration'))
    await screen.findByText('Allowed')
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'Test record onboarded by mistake' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm that/ }))
    const confirm = screen.getAllByRole('button', { name: 'Remove HR Registration' }).at(-1)!
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(confirm)
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Not changed', variant: 'destructive' })))
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'HR registration removed' }))
    expect(await screen.findByText('Not allowed for this employee. Nothing was changed.')).toBeTruthy()
  })
})
