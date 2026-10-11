// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HrManagerWorkspaceView from './HrManagerWorkspaceView'

let allowed: Record<string, boolean> = {}
vi.mock('@/hooks/useNavAccess', () => ({ useNavAccess: () => ({ allows: (id: string) => allowed[id] === true }) }))

const respond = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

beforeEach(() => { allowed = {} })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Manager Workspace (My Team)', () => {
  it('lists the manager\'s own direct reports and reads no employee id from the client', async () => {
    allowed = { 'hr/my-team': true }
    const fetchMock = vi.fn(async (url: string) => (url.includes('/api/hr/mss/team') ? respond(200, { data: [{ userId: 'e1', fullName: 'Amina', jobTitle: 'Analyst', department: 'Ops' }] }) : respond(404)))
    vi.stubGlobal('fetch', fetchMock)
    render(<HrManagerWorkspaceView />)
    await waitFor(() => expect(screen.getByText('Amina')).toBeTruthy())
    expect(fetchMock).toHaveBeenCalledWith('/api/hr/mss/team', { cache: 'no-store' })
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/employee_id|user_id|organization_id/)
  })

  it('never fetches or renders compensation when the viewer is not granted', async () => {
    allowed = { 'hr/my-team': true }
    const fetchMock = vi.fn(async (url: string) => (url.includes('/api/hr/mss/team') ? respond(200, { data: [{ userId: 'e1', fullName: 'Amina' }] }) : respond(404)))
    vi.stubGlobal('fetch', fetchMock)
    render(<HrManagerWorkspaceView />)
    await waitFor(() => expect(screen.getByText('Amina')).toBeTruthy())
    expect(fetchMock).not.toHaveBeenCalledWith('/api/hr/mss/compensation', expect.anything())
    expect(screen.queryByText(/RM/)).toBeNull()
  })

  it('shows basic salary only when the compensation viewer endpoint returns authorized data', async () => {
    allowed = { 'hr/my-team': true, 'hr/team-compensation': true }
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('/api/hr/mss/team')
        ? respond(200, { data: [{ userId: 'e1', fullName: 'Amina', jobTitle: 'Analyst' }] })
        : respond(200, { data: [{ userId: 'e1', basicSalary: 4500, currency: 'MYR', allowances: [] }] })))
    render(<HrManagerWorkspaceView />)
    await waitFor(() => expect(screen.getByText(/RM\s?4,500/)).toBeTruthy())
  })

  it('renders no salary placeholder when compensation is authorized but returns nothing', async () => {
    allowed = { 'hr/my-team': true, 'hr/team-compensation': true }
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('/api/hr/mss/team')
        ? respond(200, { data: [{ userId: 'e1', fullName: 'Amina' }] })
        : respond(200, { data: [] })))
    const { container } = render(<HrManagerWorkspaceView />)
    await waitFor(() => expect(screen.getByText('Amina')).toBeTruthy())
    expect(container.textContent).not.toMatch(/RM|\$|salary placeholder|—\s*RM/)
  })

  it('shows a clean empty state when the manager has no direct reports', async () => {
    allowed = { 'hr/my-team': true }
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { data: [] })))
    render(<HrManagerWorkspaceView />)
    await waitFor(() => expect(screen.getByText('You have no direct reports right now.')).toBeTruthy())
  })
})
