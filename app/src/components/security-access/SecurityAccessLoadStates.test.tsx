// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('./PeopleAccessPanel', () => ({ default: () => <div>people-panel</div> }))
vi.mock('./RolesPoliciesPanel', () => ({ default: () => <div>roles-panel</div> }))
vi.mock('./GovernancePanel', () => ({ default: () => <div>governance-panel</div> }))
vi.mock('./TechnicalAccessPanel', () => ({ default: () => <div>technical-panel</div>, LegacyCompatibilityPanel: () => null }))
vi.mock('./AccessSimulator', () => ({ default: () => <div>simulator-panel</div> }))
vi.mock('./AccessChangeLog', () => ({ default: () => <div>changes-panel</div>, ParityEvidence: () => <div>parity-panel</div> }))
vi.mock('./DecisionLog', () => ({ default: () => <div>decisions-panel</div> }))
import SecurityAccessView from './SecurityAccessView'

const ok = { schemaReady: true, metrics: { businessIdentities: 4, activeAssignments: 7 }, modes: [], decisions: [], permissions: [], roles: [], people: [], organizations: [], actors: [], recentDecisions: [] }
const respond = (status: number, body: any) => ({ ok: status < 300, status, headers: new Headers(), json: async () => body })
function serve(overview: Array<[number, any]>) {
  const queue = [...overview]
  global.fetch = vi.fn(async (url: string) => {
    if (String(url).includes('/governance')) return respond(403, { error: 'Forbidden' })
    const [status, body] = queue.length > 1 ? queue.shift()! : queue[0]
    return respond(status, body)
  }) as any
}
beforeEach(() => { cleanup(); window.history.replaceState(null, '', '/security-access') })

describe('Security & Access load states', () => {
  it('a confirmed denial shows "Access denied", no data and no migration text', async () => {
    serve([[403, { error: 'Forbidden', code: 'sa_forbidden' }]])
    render(<SecurityAccessView userProfile={{ id: 'u1', organization_id: 'o1' }} />)
    expect(await screen.findByText('Access denied')).toBeTruthy()
    expect(screen.queryByText(/migration/i)).toBeNull()
    expect(screen.queryByText(/No permissions are registered/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
  })

  it('an infrastructure failure shows "unavailable" with Retry, and Retry recovers', async () => {
    serve([[503, { error: 'Security & Access is temporarily unavailable. Please retry.', code: 'sa_unavailable' }], [200, ok]])
    render(<SecurityAccessView userProfile={{ id: 'u1', organization_id: 'o1' }} />)
    expect(await screen.findByText('Security & Access is temporarily unavailable')).toBeTruthy()
    expect(screen.queryByText('Forbidden')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(screen.getByText('Active memberships')).toBeTruthy())
    expect(screen.getByText('4')).toBeTruthy()
  })

  it('a verified missing dependency names it; no generic "Forbidden" prefix', async () => {
    serve([[200, { schemaReady: false, missingDependency: ['permissions'], error: 'The Security & Access schema has not been applied in this environment.' }]])
    render(<SecurityAccessView userProfile={{ id: 'u1', organization_id: 'o1' }} />)
    expect(await screen.findByText(/Missing: permissions\./)).toBeTruthy()
    expect(screen.queryByText(/^Forbidden/)).toBeNull()
  })

  it('an expired session asks to sign in again', async () => {
    serve([[401, { error: 'Your session has expired. Sign in again.', code: 'unauthenticated' }]])
    render(<SecurityAccessView userProfile={{ id: 'u1', organization_id: 'o1' }} />)
    expect(await screen.findByText('Session expired')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy()
  })
})
