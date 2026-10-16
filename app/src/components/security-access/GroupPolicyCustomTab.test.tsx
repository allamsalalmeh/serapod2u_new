// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AccessProfilesPanel from './AccessProfilesPanel'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const policy = (over: any) => ({ id: 'p', roleKey: 'k', name: 'N', description: null, kind: 'standard', status: 'active', version: 1, accountTypes: [], orgTypes: [], copiedFromId: null, permissionKeys: [], holders: 0, visibleHolders: 0, fullAccess: false, drift: null, draft: null, ...over })
const STANDARD = [
  policy({ id: 'wh', roleKey: 'warehouse-operator', name: 'Warehouse Operator', permissionKeys: ['inventory.stock_count.view'] }),
  policy({ id: 'qr', roleKey: 'qr-manager', name: 'QR Manager', permissionKeys: ['qr.batch.manage'] }),
]
const CUSTOM_A = policy({ id: 'c1', roleKey: 'wh-custom', name: 'Warehouse Counter', kind: 'custom', permissionKeys: ['inventory.stock_count.view'] })
const CUSTOM_B = policy({ id: 'c2', roleKey: 'qr-custom', name: 'Ledger Reviewer', kind: 'custom', permissionKeys: ['finance.ledger.view'] })
const PERMS = [...STANDARD, CUSTOM_A, CUSTOM_B].flatMap(p => p.permissionKeys).map((permission_key: string) => ({ permission_key, status: 'active' }))

async function mount(custom: any[]) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, profiles: [...STANDARD, ...custom], migrationReady: true, capabilities: { canAssign: true } }) })))
  render(<AccessProfilesPanel permissions={PERMS} onChanged={vi.fn()} onAssignProfile={vi.fn()} fallback={<p>x</p>} />)
  await screen.findByRole('button', { name: /^Standard\s*\d+$/ })
}
const headers = () => screen.queryAllByRole('button').filter(b => b.hasAttribute('aria-controls') && /profiles?, /.test(b.getAttribute('aria-label') || ''))

describe('Group Policies Custom tab', () => {
  it('shows only module headers holding custom policies, and Standard is restored on return', async () => {
    await mount([CUSTOM_A])
    const standardHeaders = headers().length
    expect(standardHeaders).toBeGreaterThan(2)
    await userEvent.click(screen.getByRole('button', { name: /^Custom\s*1$/ }))
    expect(headers().map(h => h.getAttribute('aria-label'))).toEqual([expect.stringMatching(/^Supply Chain, 1 profile, /)])
    await userEvent.click(screen.getByRole('button', { name: /^Standard\s*2$/ }))
    expect(headers().length).toBe(standardHeaders)
  })

  it('lists several custom policies across groups', async () => {
    await mount([CUSTOM_A, CUSTOM_B])
    await userEvent.click(screen.getByRole('button', { name: /^Custom\s*2$/ }))
    expect(headers()).toHaveLength(2)
  })

  it('shows a compact empty state with a way back to Standard when there are no custom policies', async () => {
    await mount([])
    await userEvent.click(screen.getByRole('button', { name: /^Custom\s*0$/ }))
    expect(screen.getByText('No custom Group Policies yet.')).toBeTruthy()
    expect(headers()).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Browse Standard policies' }))
    expect(headers().length).toBeGreaterThan(0)
  })

  it('shows a filtered-results message, not the empty state, when search hides existing custom policies', async () => {
    await mount([CUSTOM_A])
    await userEvent.click(screen.getByRole('button', { name: /^Custom\s*1$/ }))
    await userEvent.type(screen.getByPlaceholderText('Search policies or permissions'), 'zzzz')
    expect(screen.getByText(/No policies match/)).toBeTruthy()
    expect(screen.queryByText('No custom Group Policies yet.')).toBeNull()
    expect(headers()).toHaveLength(0)
  })
})
