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
const row = (status: 'completed' | 'reset' | 'pending', over: Record<string, unknown> = {}) => ({
  id: EMP, full_name: 'Tess Tester', email: 'tess@example.test', phone: null, avatar_url: null, role_code: 'USER', is_active: true,
  department_id: null, manager_user_id: null, position_id: null, employee_no: 42, employment_type: 'Full-time',
  roles: { role_name: 'User', role_level: 50 }, positions: null,
  hr_employees: [{ organization_id: 'org-a', onboarding_status: status, hire_date: '2026-01-05', hire_date_confirmed: status !== 'pending', status: 'active', end_date: null }],
  ...over,
})
const preview = (over: Record<string, unknown> = {}) => ({
  target: { user_id: EMP, full_name: 'Tess Tester', email: 'tess@example.test', phone: null, organization_name: 'HQ', employee_no: 42, has_identity: true, has_login: true },
  employment: [{ employment_id: 'e-1', employee_no: 42, onboarding_status: 'pending' }],
  cleanup: [{ table: 'hr_employees', count: 1, label: 'HR employment record (employee number)' }], retained: [],
  blockers: [], confirmation_phrase: 'tess@example.test', preview_token: 'tok-1', allowed: true, ...over,
})

let fetchMock: ReturnType<typeof vi.fn>
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
const archivePreview = (over: Record<string, unknown> = {}) => ({
  target: { user_id: EMP, full_name: 'Tess Tester', email: 'tess@example.test', phone: null, organization_name: 'HQ', employee_no: 42 },
  employment: [{ employee_no: 42, onboarding_status: 'completed', status: 'active' }],
  archived: false, identifiers_released: false, releasable: true, blockers: [], warnings: [{ code: 'SESSIONS_REVOKED', count: 1, message: '1 active sign-in session(s) will be ended immediately.' }],
  confirmation_phrase: 'tess@example.test', preview_token: 'tok-a', archive_allowed: true, release_allowed: false, ...over,
})

function mockFetch(handlers: { preview?: () => unknown; execute?: () => [unknown, number] } = {}) {
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/identity/permanent-delete?entry=hr') return json({ success: true, data: { permission: true } })
    if (url.startsWith('/api/identity/archive?entry=hr&user_id=')) return json({ success: true, data: handlers.preview?.() ?? archivePreview() })
    if (url === '/api/identity/archive' && init?.method === 'POST') {
      const [body, status] = handlers.execute?.() ?? [{ success: true, data: { status: 'completed', actionId: 'a-1', released: true } }, 200]
      return json(body, status)
    }
    if (url === '/api/hr/employees/registration') return json({ success: true, data: { permission: true, phase: 'pre_go_live' } })
    return json({ success: true, data: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
}

const openMenu = async () => fireEvent.click(await screen.findByRole('button', { name: 'Actions for Tess Tester' }))
const tab = (name: RegExp) => screen.findByRole('button', { name })

beforeEach(() => {
  rows.splice(0, rows.length, row('completed'))
  toast.mockClear()
  globalThis.crypto.randomUUID = (() => '00000000-0000-0000-0000-00000000f001') as any
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('HR People: former employees (Archive & Revoke Access)', () => {
  it('an archived person appears only under Former employees — never Onboarded or Awaiting onboarding, whatever the onboarding state', async () => {
    rows.splice(0, rows.length, row('reset', { account_status: 'ARCHIVED' }))
    mockFetch()
    render(<HrPeopleView organizationId="org-a" canEdit />)
    expect((await tab(/Former employees/)).textContent).toContain('1')
    expect((await tab(/Awaiting onboarding/)).textContent).toContain('0')
    expect(screen.queryByRole('button', { name: 'Actions for Tess Tester' })).toBeNull()
    fireEvent.click(await tab(/Awaiting onboarding/))
    expect(screen.queryByRole('button', { name: 'Actions for Tess Tester' })).toBeNull()
    fireEvent.click(await tab(/Former employees/))
    await openMenu()
    expect(screen.getByText(/Release Email/)).toBeTruthy()
    expect(screen.queryByText('Reset HR Registration')).toBeNull()
    expect(screen.queryByText('Complete onboarding')).toBeNull()
    expect(screen.queryByText(/Archive & Revoke Access/)).toBeNull()
  })

  it('archive: preview → employment end + release + reason + typed phrase → shared endpoint (entry=hr) → list refresh', async () => {
    mockFetch()
    render(<HrPeopleView organizationId="org-a" canEdit />)
    await openMenu()
    fireEvent.click(await screen.findByText(/Archive & Revoke Access/))
    expect(await screen.findByText(/This is not a deletion/)).toBeTruthy()
    expect(screen.getByText(/1 active sign-in session/)).toBeTruthy()
    const confirm = screen.getByRole('button', { name: /Archive & revoke access/ }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Terminated'))
    fireEvent.click(screen.getByRole('checkbox', { name: /Release email and phone/ }))
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'Contract ended last Friday' } })
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'tess@example.test' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /should lose all access/ }))
    await waitFor(() => expect(confirm.disabled).toBe(false))
    rows.splice(0, rows.length, row('completed', { account_status: 'ARCHIVED' }))
    fireEvent.click(confirm)
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Archived — access revoked' })))
    const post = fetchMock.mock.calls.find(([url, init]) => url === '/api/identity/archive' && init?.method === 'POST')!
    expect(JSON.parse(post[1].body)).toEqual({ action: 'archive', user_id: EMP, entry: 'hr', request_id: '00000000-0000-0000-0000-00000000f001',
      preview_token: 'tok-a', reason: 'Contract ended last Friday', confirmation: 'tess@example.test', release_identifiers: true, employment_end: 'terminated' })
    // Reloaded: the person left the Onboarded list.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Actions for Tess Tester' })).toBeNull())
  })

  it('a blocked archive explains why and never enables the action', async () => {
    mockFetch({ preview: () => archivePreview({ archive_allowed: false, blockers: [{ code: 'PROTECTED_ROOT', message: 'This person holds Root Access.' }] }) })
    render(<HrPeopleView organizationId="org-a" canEdit />)
    await openMenu()
    fireEvent.click(await screen.findByText(/Archive & Revoke Access/))
    expect(await screen.findByText('This person holds Root Access.')).toBeTruthy()
    expect((screen.getByRole('button', { name: /Archive & revoke access/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})
