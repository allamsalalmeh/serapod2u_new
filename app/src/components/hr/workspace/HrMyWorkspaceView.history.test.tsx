// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HrMyWorkspaceView from './HrMyWorkspaceView'
import { splitProfilePayload, statutoryFormatError, WORK_STATES } from '@/lib/hr/employment-messages'

// UI/UX reconciliation 2026-10-26 (Wave 2 HS-01): the employee sees their own effective-dated history in My Workspace
// (read-only), instead of a developer-console call. And the HR Profile can now record the statutory work state.
vi.mock('@/hooks/useNavAccess', () => ({ useNavAccess: () => ({ allows: () => false }) }))
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const employment = { name: 'Ben Ops', employeeNo: 7, jobTitle: 'Ops Lead', department: 'Operations', manager: 'Aisha', employmentType: 'full_time', employmentStatus: 'active', organization: 'Serapod HQ', hireDate: '2024-01-01' }
const version = { version_no: 2, change_kind: 'transfer', effective_date: '2026-10-01', recorded_at: '2026-10-26T01:00:00Z', status: 'active', employment_type: 'Full-time', department_name: 'Operations', position_name: 'Ops Lead', manager_name: 'Aisha', hire_date: '2024-01-01', end_date: null, changed_columns: ['department_id'], reason: 'Transfer', actor_name: 'HR One' }

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('My Workspace — my employment history', () => {
  it('loads the signed-in person\'s own history on request, read-only', async () => {
    const fetchMock = vi.fn(async (url: string) => url === '/api/hr/self-service/me'
      ? new Response(JSON.stringify({ state: 'ready', employment }))
      : new Response(JSON.stringify({ success: true, data: [version] })))
    vi.stubGlobal('fetch', fetchMock)
    render(<HrMyWorkspaceView userName="Ben Ops" userId="u-ben" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Show my employment history' }))
    expect(await screen.findByText('Transfer (department / position)')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/hr/employees/u-ben/history')
    expect(screen.queryByText(/Record employment change/)).toBeNull()
  })

  it('offers no history control while the employee setup is pending', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ state: 'pending' }))))
    render(<HrMyWorkspaceView userId="u-ben" />)
    await waitFor(() => expect(screen.getByText(/employee setup is pending/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /employment history/ })).toBeNull()
  })
})

describe('HR Profile work state (statutory)', () => {
  it('is saved to the statutory profile as the database code and validated against the database list', () => {
    expect(splitProfilePayload({ work_state: 'kul' }).statutory).toEqual({ work_state: 'KUL' })
    expect(splitProfilePayload({ work_state: '' }).statutory).toEqual({ work_state: null })
    expect(statutoryFormatError('work_state', 'WP')).not.toBeNull()
    expect(WORK_STATES.map(s => s.code)).toEqual(['JHR', 'KDH', 'KTN', 'MLK', 'NSN', 'PHG', 'PNG', 'PRK', 'PLS', 'SBH', 'SWK', 'SGR', 'TRG', 'KUL', 'LBN', 'PJY'])
  })
})
