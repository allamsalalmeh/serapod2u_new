// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// UI/UX reconciliation 2026-10-26: the HR attendance screen is one workspace with tabs (Operations · Policy & shifts ·
// My clock-in) instead of one long page, and `?tab=` deep-links any section or operations tab (UAT guides, menu).
let search = new URLSearchParams()
vi.mock('next/navigation', () => ({ useSearchParams: () => search }))
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a> }))
const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))
vi.mock('@/hooks/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => true }) }))
vi.mock('./OvertimeRulesCard', () => ({ default: () => <div>Overtime rules card</div> }))
const { operationsProps, api } = vi.hoisted(() => ({
  operationsProps: [] as any[],
  api: {
    fetchAttendancePolicy: vi.fn(async () => ({ success: true, data: null })),
    fetchAttendanceShifts: vi.fn(async () => ({ success: true, data: [] })),
    fetchAttendanceEntries: vi.fn(async () => ({ success: true, data: [] })),
    clockAttendance: vi.fn(async () => ({ success: true })),
    createCorrectionRequest: vi.fn(), createAttendanceShift: vi.fn(), deleteAttendanceShift: vi.fn(),
    updateAttendancePolicy: vi.fn(), updateAttendanceShift: vi.fn(),
  },
}))
vi.mock('./HrAttendanceOperationsView', () => ({
  OPERATIONS_TABS: ['board', 'exceptions', 'corrections', 'manual', 'import', 'overtime', 'report'],
  default: (props: any) => { operationsProps.push(props); return <div>Operations tab {props.initialTab}</div> },
}))
vi.mock('@/lib/api/attendance', () => api)

import HrAttendanceClockView, { resolveAttendanceTab } from './HrAttendanceClockView'

const profile = { id: 'h1', role_code: 'STAFF', roles: { role_level: 50 }, department_id: null, organizations: { id: 'org-1' } }
afterEach(cleanup)
beforeEach(() => { search = new URLSearchParams(); operationsProps.length = 0; toast.mockReset(); api.clockAttendance.mockClear() })

const openTab = (name: RegExp) => { const t = screen.getByRole('tab', { name }); fireEvent.mouseDown(t); fireEvent.click(t) }

describe('resolveAttendanceTab', () => {
  it('maps sections and operations tabs; anything else opens the daily board', () => {
    expect(resolveAttendanceTab('setup')).toEqual({ section: 'setup', operations: 'board' })
    expect(resolveAttendanceTab('my')).toEqual({ section: 'my', operations: 'board' })
    expect(resolveAttendanceTab('import')).toEqual({ section: 'operations', operations: 'import' })
    expect(resolveAttendanceTab('overtime')).toEqual({ section: 'operations', operations: 'overtime' })
    expect(resolveAttendanceTab('nonsense')).toEqual({ section: 'operations', operations: 'board' })
    expect(resolveAttendanceTab(null)).toEqual({ section: 'operations', operations: 'board' })
  })
})

describe('HrAttendanceClockView (HR attendance workspace)', () => {
  it('opens on Operations with the daily board and points employees to My Attendance', async () => {
    render(<HrAttendanceClockView userProfile={profile} />)
    expect(screen.getByRole('heading', { name: 'Attendance Operations' })).toBeTruthy()
    expect(screen.getByText('Operations tab board')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'My Attendance' }).getAttribute('href')).toBe('/hr/mobile/attendance')
    // Policy and shift administration is not stacked under the operations any more.
    expect(screen.queryByText('Attendance Policy')).toBeNull()
  })

  it('deep-links an operations tab (?tab=import)', () => {
    search = new URLSearchParams('tab=import')
    render(<HrAttendanceClockView userProfile={profile} />)
    expect(screen.getByText('Operations tab import')).toBeTruthy()
    expect(operationsProps.at(-1)).toMatchObject({ initialTab: 'import' })
  })

  it('deep-links Policy & shifts (?tab=setup): policy, overtime rules and shifts with an empty-state hint', async () => {
    search = new URLSearchParams('tab=setup')
    render(<HrAttendanceClockView userProfile={profile} />)
    expect(await screen.findByText('Attendance Policy')).toBeTruthy()
    expect(screen.getByText('Overtime rules card')).toBeTruthy()
    expect(await screen.findByText('No shifts configured.')).toBeTruthy()
  })

  it('keeps the HR person\'s own clock under "My clock-in" with an honest result message', async () => {
    render(<HrAttendanceClockView userProfile={profile} />)
    openTab(/My clock-in/)
    const clockIn = await screen.findByRole('button', { name: 'Clock In' })
    await waitFor(() => expect((clockIn as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(clockIn)
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Clocked in', description: 'Recorded with the server time.' })))
  })

  it('reports a refused clock-in as not recorded (never as success)', async () => {
    api.clockAttendance.mockResolvedValueOnce({ success: false, error: 'You are already clocked in.' } as any)
    render(<HrAttendanceClockView userProfile={profile} />)
    openTab(/My clock-in/)
    const clockIn = await screen.findByRole('button', { name: 'Clock In' })
    await waitFor(() => expect((clockIn as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(clockIn)
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Not recorded', variant: 'destructive' })))
  })
})
