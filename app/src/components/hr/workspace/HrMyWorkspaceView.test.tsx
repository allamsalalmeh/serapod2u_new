// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HrMyWorkspaceView from './HrMyWorkspaceView'

let allowed: Record<string, boolean> = {}
vi.mock('@/hooks/useNavAccess', () => ({ useNavAccess: () => ({ allows: (id: string) => allowed[id] === true }) }))
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a> }))

const respond = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const employment = { name: 'Ben Ops', employeeNo: 7, jobTitle: 'Ops Lead', department: 'Operations', manager: 'Aisha', employmentType: 'full_time', employmentStatus: 'active', organization: 'Serapod HQ', hireDate: '2024-01-01' }

beforeEach(() => { allowed = {} })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('My Workspace', () => {
  it('shows the employee\'s own employment and opens the existing employee screens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { state: 'ready', employment })))
    render(<HrMyWorkspaceView userName="Ben Ops" />)
    await waitFor(() => expect(screen.getByText('My Employment')).toBeTruthy())
    expect(screen.getByText('Ops Lead')).toBeTruthy()
    expect(screen.getByRole('link', { name: /My Attendance/ }).getAttribute('href')).toBe('/hr/mobile/attendance')
    expect(screen.getByRole('link', { name: /My Leave/ }).getAttribute('href')).toBe('/hr/mobile/leave')
    expect(screen.getByRole('link', { name: /My Payslips/ }).getAttribute('href')).toBe('/hr/mobile/payslip')
  })

  it('reads only the signed-in person\'s record: the request carries no employee id', async () => {
    const fetchMock = vi.fn(async () => respond(200, { state: 'ready', employment }))
    vi.stubGlobal('fetch', fetchMock)
    render(<HrMyWorkspaceView />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith('/api/hr/self-service/me', { cache: 'no-store' })
  })

  it('never shows administrative setup links to an employee', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { state: 'ready', employment })))
    const { container } = render(<HrMyWorkspaceView />)
    await waitFor(() => expect(screen.getByText('My Employment')).toBeTruthy())
    expect(container.textContent).not.toMatch(/HR Setup|Departments|Payroll configuration|HR Settings|Configuration|Approval Rules|HR administration/)
    expect(screen.queryByRole('link', { name: /HR administration/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /Organization Chart/ })).toBeNull() // needs the staff directory permission
  })

  it('offers the organization chart and the HR administration shortcut only when allowed', async () => {
    allowed = { 'hr/people/org-chart/staff': true, hr: true }
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { state: 'ready', employment })))
    render(<HrMyWorkspaceView />)
    await waitFor(() => expect(screen.getByRole('link', { name: /Organization Chart/ })).toBeTruthy())
    expect(screen.getByRole('link', { name: /HR administration/ }).getAttribute('href')).toBe('/hr')
  })

  it('announces a pending setup ONCE; affected cards only say "Pending setup" and are clearly unavailable', async () => {
    allowed = { 'hr/people/org-chart/staff': true }
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { state: 'pending' })))
    const { container } = render(<HrMyWorkspaceView />)
    await waitFor(() => expect(screen.getAllByText('Your employee setup is pending. Contact HR.')).toHaveLength(1))
    expect(container.textContent!.split('Your employee setup is pending').length - 1).toBe(1)
    expect(screen.queryByText('My Employment')).toBeNull()
    expect(screen.getAllByText('Pending setup')).toHaveLength(3)
    // accessible disabled semantics, not links, no dead destinations
    const disabled = container.querySelectorAll('[aria-disabled="true"]')
    expect(disabled).toHaveLength(3)
    expect(disabled[0].getAttribute('aria-label')).toBe('My Attendance, unavailable: pending setup')
    expect(container.querySelectorAll('a[href^="/hr/mobile"]').length).toBe(0)
    expect(container.querySelectorAll('a[href*="settings"], a[href*="configuration"]').length).toBe(0)
    // the organization chart is independently authorized and stays usable
    expect(screen.getByRole('link', { name: 'Organization Chart' }).getAttribute('href')).toBe('/hr/people/org-chart')
  })

  it('does not fade pending cards to an unreadable state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { state: 'pending' })))
    const { container } = render(<HrMyWorkspaceView />)
    await waitFor(() => expect(screen.getAllByText('Pending setup').length).toBe(3))
    expect(container.innerHTML).not.toMatch(/opacity-(?:[1-6]\d?|[1-9])\b/)
  })

  it('uses the shared module landing shell (no nested page padding or centring) and a two-column pair grid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { state: 'ready', employment })))
    const { container } = render(<HrMyWorkspaceView />)
    await waitFor(() => expect(screen.getByText('My Employment')).toBeTruthy())
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toBe('sera-module-landing')
    expect(root.className).not.toMatch(/\bp-\d|max-w|mx-auto/)
    expect(container.querySelector('.sera-module-landing__grid--pair')).toBeTruthy()
  })

  it('reports a failed load as temporary and not as a denial or a pending setup', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(503)))
    render(<HrMyWorkspaceView />)
    await waitFor(() => expect(screen.getByText(/couldn’t load your employment details/)).toBeTruthy())
    expect(screen.queryByText(/pending/)).toBeNull()
    expect(screen.queryByText(/don’t have access/)).toBeNull()
    expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy()
  })

  it('shows the ordinary denial when the server refuses (403)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(403)))
    render(<HrMyWorkspaceView />)
    await waitFor(() => expect(screen.getByText(/You don’t have access to this page/)).toBeTruthy())
  })
})
