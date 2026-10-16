// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AccessProfilesPanel from './AccessProfilesPanel'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const policy = (over: any) => ({ id: 'p', roleKey: 'k', name: 'N', description: null, kind: 'standard', status: 'active', version: 1, accountTypes: [], orgTypes: [], copiedFromId: null, permissionKeys: [], holders: 0, visibleHolders: 0, fullAccess: false, drift: null, draft: null, ...over })
const SUPPLY = ['inventory.stock_count.view', 'supply_chain.order.cancel', 'qr.batch.manage']
const PROFILES = [
  policy({ id: 'wh', roleKey: 'warehouse-operator', name: 'Warehouse Operator', permissionKeys: ['inventory.stock_count.view'] }),
  policy({ id: 'sc', roleKey: 'supply-chain-full-access', name: 'Supply Chain Full Access', fullAccess: true, accountTypes: ['internal'], permissionKeys: SUPPLY,
    drift: { roleKey: 'supply-chain-full-access', recordedCount: 3, liveCount: 3, catalogueNotCovered: ['supply_chain.order.expedite'], liveNotRecorded: [], recordedNotLive: [] } }),
  policy({ id: 'sa', roleKey: 'security-access-full-access', name: 'Security & Access Full Access', fullAccess: true, accountTypes: ['internal'], permissionKeys: ['security.access.view', 'security.role.assign', 'security.role.manage'] }),
  policy({ id: 'ar', roleKey: 'access-reviewer', name: 'Access Reviewer', permissionKeys: ['security.access.view', 'security.audit.view'] }),
  policy({ id: 'am', roleKey: 'adjustment-administrator', name: 'Adjustment Administrator', permissionKeys: ['manufacturing.adjustment.administer'] }),
]
const PERMS = [...SUPPLY, 'security.access.view', 'security.role.assign', 'security.role.manage', 'security.audit.view', 'manufacturing.adjustment.administer', 'supply_chain.order.expedite'].map(permission_key => ({ permission_key, status: 'active' }))

function stub(profiles = PROFILES) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, profiles, migrationReady: true, capabilities: { canAssign: true } }) })))
}
const mount = async (onAssign = vi.fn()) => { render(<AccessProfilesPanel permissions={PERMS} onChanged={vi.fn()} onAssignProfile={onAssign} fallback={<p>x</p>} />); await screen.findByRole('button', { name: /^Standard\s*\d+$/ }); return onAssign }
const openModule = (name: string) => userEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}, \\d+ profiles?, `) }))

describe('Group Policies: module Full Access first', () => {
  it('uses Group Policy wording throughout and never the old name', async () => {
    stub(); await mount()
    expect(screen.getByRole('region', { name: 'Group Policies' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Group Policies' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/Access Profile/)
  })

  it('lists Security & Access as its own group, separate from Platform & Settings', async () => {
    stub(); await mount()
    const names = screen.getAllByRole('button', { name: /profiles?, / }).map(b => b.getAttribute('aria-label')!.split(',')[0])
    expect(names).toEqual(['Supply Chain', 'Customer & Growth', 'HR & Payroll', 'Finance', 'Security & Access', 'Platform & Settings', 'Reporting'])
  })

  it('shows the module Full Access policy first and prominently, followed by the narrower policies', async () => {
    stub(); await mount()
    await openModule('Supply Chain')
    const list = screen.getByRole('list', { name: 'Supply Chain Full Access' })
    const row = within(list).getByRole('button', { name: /^Supply Chain Full Access, 3 permissions/ })
    expect(row).toBeTruthy()
    expect(within(list).getByText('Full Access')).toBeTruthy()
    expect(screen.getByText('Narrower policies')).toBeTruthy()
    // Full Access precedes the narrower policy in document order.
    const order = screen.getAllByRole('button', { name: /, \d+ permissions?/ }).map(b => b.getAttribute('aria-label')!.split(',')[0])
    expect(order.indexOf('Supply Chain Full Access')).toBeLessThan(order.indexOf('Warehouse Operator'))
  })

  it('explains explicit coverage, scope, guards and the post-creation route; reports newer permissions without granting them', async () => {
    stub(); await mount()
    await openModule('Supply Chain')
    await userEvent.click(screen.getByRole('button', { name: /^Supply Chain Full Access, 3 permissions/ }))
    await userEvent.click(screen.getByRole('button', { name: 'About Supply Chain Full Access' }))
    expect(screen.getByText(/explicit, not a wildcard/)).toBeTruthy()
    expect(screen.getByText(/needs a data scope/)).toBeTruthy()
    expect(screen.getByText(/does not create an organization, department or HR\/ESS enrollment/)).toBeTruthy()
    expect(screen.getByText(/1 newer Supply Chain permission not included yet/)).toBeTruthy()
    expect(screen.getByText(/Holders are unchanged until a reviewed update adds it/)).toBeTruthy()
    // Not sensitive: no post-creation note for Supply Chain.
    expect(screen.queryByText(/only when you hold those permissions/)).toBeNull()
    // Copy & Customize and Assign are offered; the original is protected (no edit / retire).
    expect(screen.getByRole('button', { name: /Copy & Customize/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Assign policy Supply Chain Full Access/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Edit|Retire/ })).toBeNull()
  })

  it('sensitive Full Access (Security & Access) says when Add User offers it, and lists its permissions under the existing areas', async () => {
    stub(); await mount()
    await openModule('Security & Access')
    await userEvent.click(screen.getByRole('button', { name: /^Security & Access Full Access, 3 permissions/ }))
    await userEvent.click(screen.getByRole('button', { name: 'About Security & Access Full Access' }))
    expect(screen.getByText(/only when you hold those permissions/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Access Administration, 3 permissions, expand$/ })).toBeTruthy()
  })

  it('assigning goes through the existing flow: it only hands the policy to People & Access', async () => {
    stub(); const onAssign = await mount()
    await openModule('Supply Chain')
    await userEvent.click(screen.getByRole('button', { name: /^Supply Chain Full Access, 3 permissions/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Assign policy Supply Chain Full Access/ }))
    expect(onAssign).toHaveBeenCalledWith(expect.objectContaining({ id: 'sc', roleKey: 'supply-chain-full-access' }))
  })
})
