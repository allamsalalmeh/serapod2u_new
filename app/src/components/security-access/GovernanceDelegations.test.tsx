// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GovernancePanel from './GovernancePanel'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const DELEGATION = { id: 'd1', delegator_id: 'u1', delegate_id: 'u2', organization_id: 'hq', permission_keys: ['supply_chain.order.approve'], status: 'active', effective_until: '2099-01-01T00:00:00Z' }
const data = { people: [{ id: 'u1', full_name: 'Aisha Admin' }, { id: 'u2', full_name: 'Siti Staff' }], actors: [], organizations: [{ id: 'hq', org_name: 'Serapod HQ' }], roles: [] }

async function openDelegations(reply: any = { ok: true }) {
  const posts: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(init.body)); return { ok: reply.ok !== false, status: reply.status ?? 200, json: async () => reply } }
    return { ok: true, status: 200, json: async () => (String(url).includes('/delegations') ? { delegations: [DELEGATION] } : {}) }
  }))
  render(<GovernancePanel section="delegations" data={data} governance={{}} />)
  await screen.findByRole('button', { name: 'Revoke' })
  return posts
}

describe('Governance → Delegations: revoke reason', () => {
  it('a too-short reason ("test") is explained and nothing is sent', async () => {
    const posts = await openDelegations()
    vi.spyOn(window, 'prompt').mockReturnValue('test')
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(await screen.findByText('A reason of at least 5 characters is required. The delegation was not revoked.')).toBeTruthy()
    expect(posts).toEqual([])
  })

  it('cancelling the prompt stays silent and sends nothing', async () => {
    const posts = await openDelegations()
    vi.spyOn(window, 'prompt').mockReturnValue(null)
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(screen.queryByText(/reason of at least/)).toBeNull()
    expect(posts).toEqual([])
  })

  it('a valid reason revokes exactly that delegation with the trimmed reason', async () => {
    const posts = await openDelegations()
    vi.spyOn(window, 'prompt').mockReturnValue('  Covering period ended  ')
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(posts).toEqual([{ action: 'revoke', delegationId: 'd1', reason: 'Covering period ended' }]))
    expect(await screen.findByText('Delegation revoked.')).toBeTruthy()
  })
})
