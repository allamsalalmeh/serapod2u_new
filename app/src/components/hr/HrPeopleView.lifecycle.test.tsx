// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { toast, rows, calls } = vi.hoisted(() => ({ toast: vi.fn(), rows: [] as any[], calls: [] as Array<[string, unknown[]]> }))

// Chainable Supabase stand-in that records every builder call (scoping + "read only" assertions).
const query = () => {
  const q: any = {}
  for (const m of ['select', 'eq', 'in', 'order', 'neq', 'update', 'insert', 'delete', 'upsert']) q[m] = (...args: unknown[]) => { calls.push([m, args]); return q }
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve)
  return q
}

vi.mock('@/lib/hooks/useSupabaseAuth', () => ({ useSupabaseAuth: () => ({ supabase: { from: () => query() }, isReady: true }) }))
vi.mock('@/lib/actions/departments', () => ({ listDepartments: async () => ({ success: true, data: [
  { id: 'dept-ops', dept_name: 'Operations', dept_code: 'OPS' }, { id: 'dept-fin', dept_name: 'Finance', dept_code: 'FIN' }] }) }))
vi.mock('@/lib/api/hr', () => ({ fetchHrPositions: async () => ({ success: true, data: [] }), updateUserHr: vi.fn() }))
vi.mock('@/lib/utils/imageCompression', () => ({ compressAvatar: vi.fn() }))
vi.mock('@/components/hr/commission/EmployeeCommissionPanel', () => ({ default: () => null }))
vi.mock('@/lib/hr/commission/use-commission-access', () => ({ useCommissionAccess: () => ({ can: () => false }) }))
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }), toast }))

import HrPeopleView, { employeeCategory } from './HrPeopleView'

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
type Spec = { n: number; name: string; onboarding: 'completed' | 'pending' | 'reset'; account?: string; active?: boolean; dept?: string; employment?: string }
const person = ({ n, name, onboarding, account = 'ACTIVE', active = account === 'ACTIVE', dept = 'dept-ops', employment = 'active' }: Spec) => ({
  id: id(n), full_name: name, email: `p${n}@example.test`, phone: null, avatar_url: null, role_code: 'USER', is_active: active,
  account_status: account, account_status_changed_at: account === 'ARCHIVED' ? '2026-10-20T08:00:00Z' : null,
  department_id: dept, manager_user_id: null, position_id: null, employee_no: 900 + n, employment_type: 'Full-time',
  roles: { role_name: 'User', role_level: 50 }, positions: null,
  hr_employees: [{ organization_id: 'org-a', onboarding_status: onboarding, hire_date: '2026-01-05', hire_date_confirmed: onboarding !== 'pending',
    status: employment, end_date: account === 'ARCHIVED' ? '2026-10-20' : null }],
})
// Realistic lifecycle: archived accounts are always is_active = false (identity_users_projection).
const population = () => [
  person({ n: 1, name: 'Ada Onboarded', onboarding: 'completed' }),
  person({ n: 2, name: 'Ben Pending', onboarding: 'pending' }),
  person({ n: 3, name: 'Cara Reset', onboarding: 'reset' }),
  person({ n: 4, name: 'Deanna Finance', onboarding: 'completed', account: 'ARCHIVED', dept: 'dept-fin', employment: 'resigned' }),
  person({ n: 5, name: 'Evan Former', onboarding: 'reset', account: 'ARCHIVED', employment: 'terminated' }),
  person({ n: 6, name: 'Faye Suspended', onboarding: 'completed', account: 'SUSPENDED' }),
]

let fetchMock: ReturnType<typeof vi.fn>
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))
function mockFetch(permission = true) {
  fetchMock = vi.fn((url: string) => {
    if (url === '/api/identity/permanent-delete?entry=hr') return json({ success: true, data: { permission } })
    if (url === '/api/hr/employees/registration') return json({ success: true, data: { permission: false, phase: 'pre_go_live' } })
    return json({ success: true, data: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
}

const tabButton = (label: string) => screen.findByRole('button', { name: new RegExp(`^${label}\\s*\\d+$`) })
const badge = async (label: string) => Number((await tabButton(label)).textContent?.replace(label, '').trim())
const listed = () => screen.queryAllByRole('button', { name: /^Actions for / }).map(b => b.getAttribute('aria-label')!.replace('Actions for ', ''))
const names = () => Array.from(document.querySelectorAll('.min-w-0 > .text-sm.font-medium')).map(e => e.textContent)

// Radix Select needs Pointer Capture and scrollIntoView, which jsdom lacks; it is driven by keyboard here.
async function chooseStatus(name: string) {
  const trigger = screen.getByRole('combobox', { name: 'Account status' })
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  fireEvent.keyDown(await screen.findByRole('option', { name }), { key: 'Enter' })
}

beforeEach(() => {
  window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
  window.HTMLElement.prototype.setPointerCapture = vi.fn()
  window.HTMLElement.prototype.releasePointerCapture = vi.fn()
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  rows.splice(0, rows.length, ...population())
  calls.splice(0, calls.length)
  toast.mockClear()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('employeeCategory — one lifecycle rule for counts and lists', () => {
  it('archived is former whatever the onboarding state; reset / suspended / terminated alone are not', () => {
    expect(employeeCategory({ account_status: 'ARCHIVED', onboarding_status: 'completed' })).toBe('former')
    expect(employeeCategory({ account_status: 'ARCHIVED', onboarding_status: 'reset' })).toBe('former')
    expect(employeeCategory({ account_status: 'ARCHIVED', onboarding_status: 'pending' })).toBe('former')
    expect(employeeCategory({ account_status: 'ACTIVE', onboarding_status: 'reset' })).toBe('awaiting')
    expect(employeeCategory({ account_status: 'ACTIVE', onboarding_status: 'pending' })).toBe('awaiting')
    expect(employeeCategory({ account_status: 'SUSPENDED', onboarding_status: 'completed' })).toBe('completed')
    expect(employeeCategory({ account_status: 'DISABLED', onboarding_status: 'completed' })).toBe('completed')
  })
})

describe('HR People: Onboarded / Awaiting onboarding / Former employees', () => {
  it('counts and lists agree; two archived (inactive) employees are listed under Former despite the Active default', async () => {
    mockFetch()
    render(<HrPeopleView organizationId="org-a" canEdit />)
    expect(await badge('Onboarded')).toBe(2)          // Ada + Faye (suspended, still employed)
    expect(await badge('Awaiting onboarding')).toBe(2) // Ben (pending) + Cara (reset)
    expect(await badge('Former employees')).toBe(2)    // Deanna + Evan
    // Onboarded with the default Active filter: Ada only; the header says it is filtered.
    await waitFor(() => expect(names()).toEqual(['Ada Onboarded']))
    expect(screen.getByText(/1 of 2 shown \(filtered\)/)).toBeTruthy()

    fireEvent.click(await tabButton('Former employees'))
    await waitFor(() => expect(names()).toEqual(['Deanna Finance', 'Evan Former']))
    expect(screen.getByText(/2 shown/)).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Account status' })).toBeNull() // the tab decides the population
    expect(screen.getAllByText(/^Former/).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('EMP-0904')).toBeTruthy() // employee number kept
    expect(screen.getAllByText('Archived 2026-10-20').length).toBe(2)
  })

  it('pending and reset appear only in Awaiting; completed only in Onboarded; archived in neither', async () => {
    mockFetch()
    render(<HrPeopleView organizationId="org-a" canEdit />)
    await waitFor(() => expect(names()).toEqual(['Ada Onboarded']))
    fireEvent.click(await tabButton('Awaiting onboarding'))
    await waitFor(() => expect(names()).toEqual(['Ben Pending', 'Cara Reset']))
    expect(names()).not.toContain('Evan Former')     // archived with onboarding "reset" is NOT awaiting
    fireEvent.click(await tabButton('Onboarded'))
    await waitFor(() => expect(names()).toEqual(['Ada Onboarded']))
    expect(names()).not.toContain('Deanna Finance')  // archived with onboarding "completed" is NOT onboarded
  })

  it('a suspended (still employed) employee stays in Onboarded under the status filter, never in Former', async () => {
    mockFetch()
    render(<HrPeopleView organizationId="org-a" canEdit />)
    await waitFor(() => expect(names()).toEqual(['Ada Onboarded']))
    await chooseStatus('Suspended / Disabled')
    await waitFor(() => expect(names()).toEqual(['Faye Suspended']))
    fireEvent.click(await tabButton('Former employees'))
    await waitFor(() => expect(names()).not.toContain('Faye Suspended'))
  })

  it('switching tabs resets the incompatible status filter but keeps search', async () => {
    mockFetch()
    render(<HrPeopleView organizationId="org-a" canEdit />)
    await waitFor(() => expect(names()).toEqual(['Ada Onboarded']))
    await chooseStatus('Suspended / Disabled')
    fireEvent.click(await tabButton('Former employees'))
    fireEvent.click(await tabButton('Onboarded'))
    await waitFor(() => expect(names()).toEqual(['Ada Onboarded'])) // back to the Active default
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'deanna' } })
    fireEvent.click(await tabButton('Former employees'))
    await waitFor(() => expect(names()).toEqual(['Deanna Finance']))
    expect(screen.getByText(/1 of 2 shown \(filtered\)/)).toBeTruthy()
  })

  it('department filtering works in Former; the filtered empty state is distinct from "none found"', async () => {
    mockFetch()
    render(<HrPeopleView organizationId="org-a" canEdit />)
    fireEvent.click(await tabButton('Former employees'))
    await waitFor(() => expect(names()).toHaveLength(2))
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'nobody-matches' } })
    expect(await screen.findByText('No former employees match the current filters.')).toBeTruthy()
    expect(screen.queryByText(/Add Employee" to register/)).toBeNull()
  })

  it('context-specific empty states for every tab', async () => {
    rows.splice(0, rows.length)
    mockFetch()
    render(<HrPeopleView organizationId="org-a" canEdit />)
    expect(await screen.findByText(/No onboarded employees found/)).toBeTruthy()
    fireEvent.click(await tabButton('Awaiting onboarding'))
    expect(await screen.findByText('No employees awaiting onboarding.')).toBeTruthy()
    fireEvent.click(await tabButton('Former employees'))
    expect(await screen.findByText('No former employees found.')).toBeTruthy()
  })

  it('a permanently deleted person (no identity / employment row) appears nowhere and counts nothing', async () => {
    rows.splice(0, rows.length, ...population().filter(r => r.id !== id(2)))
    mockFetch()
    render(<HrPeopleView organizationId="org-a" canEdit />)
    expect(await badge('Awaiting onboarding')).toBe(1)
    expect(await badge('Former employees')).toBe(2)
    for (const tab of ['Onboarded', 'Awaiting onboarding', 'Former employees']) {
      fireEvent.click(await tabButton(tab))
      await waitFor(() => expect(names()).not.toContain('Ben Pending'))
    }
  })

  it('the list is scoped to the organization AND its employment records (no non-HR or cross-organization identity)', async () => {
    mockFetch()
    render(<HrPeopleView organizationId="org-a" canEdit />)
    await waitFor(() => expect(calls.some(([m]) => m === 'select')).toBe(true))
    const select = calls.find(([m, a]) => m === 'select' && String(a[0]).includes('hr_employees'))!
    expect(String(select[1][0])).toContain('hr_employees!hr_employees_user_id_fkey!inner')
    expect(calls).toContainEqual(['eq', ['organization_id', 'org-a']])
    expect(calls).toContainEqual(['eq', ['hr_employees.organization_id', 'org-a']])
  })

  it('former rows are historical: no bulk selection, no onboarding/edit actions, read-only profile; viewing mutates nothing', async () => {
    mockFetch()
    render(<HrPeopleView organizationId="org-a" canEdit />)
    fireEvent.click(await tabButton('Former employees'))
    await waitFor(() => expect(names()).toHaveLength(2))
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes.every(b => (b as HTMLButtonElement).disabled)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Deanna Finance' }))
    expect(screen.queryByText('Complete onboarding')).toBeNull()
    expect(screen.queryByText('Edit Employee')).toBeNull()
    expect(screen.queryByText(/Archive & Revoke Access/)).toBeNull()
    fireEvent.click(screen.getByText('Deanna Finance'))
    expect(await screen.findByText('Former employee — historical record, view only.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Save Profile/ })).toBeNull()
    expect(calls.filter(([m]) => ['update', 'insert', 'delete', 'upsert'].includes(m))).toEqual([])
    expect(fetchMock.mock.calls.filter(([, init]) => init && (init as RequestInit).method && (init as RequestInit).method !== 'GET')).toEqual([])
  })

  it('a former employee is never offered as a manager in bulk edits', async () => {
    mockFetch()
    render(<HrPeopleView organizationId="org-a" canEdit />)
    await waitFor(() => expect(names()).toEqual(['Ada Onboarded']))
    fireEvent.click(within(document.body).getAllByRole('checkbox')[1])
    const reportsTo = await screen.findByText('Reports To', { selector: 'label' })
    fireEvent.click(within(reportsTo.parentElement!).getByRole('combobox'))
    expect(screen.queryByRole('option', { name: 'Deanna Finance' })).toBeNull()
    expect(screen.getByRole('option', { name: 'Ada Onboarded' })).toBeTruthy()
  })
})
