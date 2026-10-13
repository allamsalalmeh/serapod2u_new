// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AccessProfilesPanel from './AccessProfilesPanel'
import { InfoPopover } from './ui'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const policy = (over: any) => ({ id: 'p', roleKey: 'k', name: 'N', description: null, kind: 'standard', status: 'active', version: 1, accountTypes: [], orgTypes: [], copiedFromId: null, permissionKeys: [], holders: 0, visibleHolders: 0, fullAccess: false, drift: null, draft: null, ...over })
const PROFILES = [
  policy({ id: 'sc', roleKey: 'supply-chain-full-access', name: 'Supply Chain Full Access', description: 'All supply chain permissions.', fullAccess: true, accountTypes: ['internal'], version: 2,
    permissionKeys: ['supply_chain.document.acknowledge', 'supply_chain.document.manage', 'supply_chain.order.approve', 'inventory.stock_count.view', 'inventory.stock_count.post', 'qr.batch.manage'] }),
  policy({ id: 'wh', roleKey: 'warehouse-operator', name: 'Warehouse Operator', description: 'Counts stock.', permissionKeys: ['inventory.stock_count.view'], holders: 3, visibleHolders: 3 }),
  policy({ id: 'mix', roleKey: 'mixed', name: 'Mixed Duty', kind: 'custom', permissionKeys: ['inventory.stock_count.view', 'finance.ledger.view', 'finance.report.view_sensitive'] }),
]
const PERMS = PROFILES.flatMap(p => p.permissionKeys).map(permission_key => ({ permission_key, status: 'active' }))
function stub() {
  vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => init?.body
    ? { ok: true, status: 200, json: async () => ({ ok: true, result: { total: 3, visible: 3, holders: [] } }) }
    : { ok: true, status: 200, json: async () => ({ ok: true, profiles: PROFILES, migrationReady: true, capabilities: { canAssign: true } }) }))
}
const mount = async (onAssign = vi.fn()) => { render(<AccessProfilesPanel permissions={PERMS} onChanged={vi.fn()} onAssignProfile={onAssign} fallback={<p>x</p>} />); await screen.findByRole('button', { name: /^Standard\s*\d+$/ }); return onAssign }
const btn = (name: RegExp | string) => screen.getByRole('button', { name })
const expanded = (b: HTMLElement) => b.getAttribute('aria-expanded')

describe('Group Policies hierarchy: module → policy → category → permissions', () => {
  it('starts fully collapsed and opens one level at a time, independently', async () => {
    stub(); await mount()
    const module = btn(/^Supply Chain, 2 profiles, /)
    expect(expanded(module)).toBe('false')
    expect(screen.queryByText('Supply Chain Full Access')).toBeNull()
    await userEvent.click(module)
    const full = btn(/^Supply Chain Full Access, 6 permissions/)
    expect(expanded(full)).toBe('false')
    expect(expanded(btn(/^Warehouse Operator, 1 permission/))).toBe('false')      // sibling policy untouched
    await userEvent.click(full)
    // categories show counts and stay collapsed
    const orders = btn(/^Orders & Documents, 3 permissions, expand$/)
    const stock = btn(/^Stock Count, 2 permissions, expand$/)
    const qr = btn(/^QR & Traceability, 1 permission, expand$/)
    for (const c of [orders, stock, qr]) expect(expanded(c)).toBe('false')
    expect(screen.queryByText('Approve Orders')).toBeNull()
    await userEvent.click(orders)
    expect(expanded(orders)).toBe('true')
    expect(expanded(stock)).toBe('false')                                          // independent
    const list = within(document.getElementById(orders.getAttribute('aria-controls')!)!)
    expect(list.getAllByRole('listitem').map(li => li.textContent)).toEqual(expect.arrayContaining(['Approve Orders']))
    expect(list.getAllByRole('listitem')).toHaveLength(3)
    await userEvent.click(orders)
    expect(screen.queryByText('Approve Orders')).toBeNull()
    expect(expanded(btn(/^Supply Chain Full Access, 6 permissions/))).toBe('true') // closing a category keeps the policy open
  })

  it('Expand all / Collapse all inside a policy control only its categories', async () => {
    stub(); await mount()
    await userEvent.click(btn(/^Supply Chain, 2 profiles, /))
    await userEvent.click(btn(/^Supply Chain Full Access, 6 permissions/))
    await userEvent.click(btn(/^Warehouse Operator, 1 permission/))
    const fullItem = btn(/^Supply Chain Full Access, 6/).closest('li')!
    await userEvent.click(within(fullItem).getByRole('button', { name: /Expand all categories of Supply Chain Full Access/ }))
    for (const name of [/^Orders & Documents/, /^Stock Count/, /^QR & Traceability/]) expect(expanded(within(fullItem).getByRole('button', { name }))).toBe('true')
    const whItem = btn(/^Warehouse Operator, 1/).closest('li')!
    expect(expanded(within(whItem).getByRole('button', { name: /^Stock Count/ }))).toBe('false')     // other policy unaffected
    expect((within(fullItem).getByRole('button', { name: /Expand all categories/ }) as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(within(fullItem).getByRole('button', { name: /Collapse all categories of Supply Chain Full Access/ }))
    for (const name of [/^Orders & Documents/, /^Stock Count/, /^QR & Traceability/]) expect(expanded(within(fullItem).getByRole('button', { name }))).toBe('false')
    expect(expanded(btn(/^Supply Chain Full Access, 6/))).toBe('true')
  })

  it('a policy spanning modules keeps the existing mapping: categories are prefixed with their module and counted once', async () => {
    stub(); await mount()
    await userEvent.click(btn(/^Custom\s*1$/))
    await userEvent.click(btn(/^Shared \/ Cross-module, 1 profile/))
    await userEvent.click(btn(/^Mixed Duty, 3 permissions/))
    expect(btn(/^Supply Chain · Stock Count, 1 permission, expand$/)).toBeTruthy()
    expect(btn(/^Finance · General Ledger, 1 permission, expand$/)).toBeTruthy()
    expect(btn(/^Finance · Financial Reports, 1 permission, expand$/)).toBeTruthy()
    expect(screen.getByText(/Permission categories · 3 · 3 permissions/)).toBeTruthy()
  })

  it('narrower policies stay separate policies under the module, with their own counts', async () => {
    stub(); await mount()
    await userEvent.click(btn(/^Supply Chain, 2 profiles, /))
    expect(screen.getByText('Narrower policies')).toBeTruthy()
    expect(btn(/^Warehouse Operator, 1 permission/)).toBeTruthy()
    await userEvent.click(btn(/^Warehouse Operator, 1 permission/))
    expect(screen.getByText(/Permission categories · 1 · 1 permission$/)).toBeTruthy()
  })
})

describe('Group Policies: actions and information icon', () => {
  it('policy actions never toggle the accordion; 0 holders is inert; eligible policies keep Assign policy', async () => {
    stub(); const onAssign = await mount()
    await userEvent.click(btn(/^Supply Chain, 2 profiles, /))
    await userEvent.click(btn(/^Supply Chain Full Access, 6 permissions/))
    for (const el of screen.getAllByText('0 holders')) expect(el.closest('button')).toBeNull()
    await userEvent.click(btn(/^Assign policy Supply Chain Full Access/))
    expect(onAssign).toHaveBeenCalledTimes(1)
    expect(expanded(btn(/^Supply Chain Full Access, 6/))).toBe('true')
    await userEvent.click(btn(/Copy & Customize/))
    expect(screen.getByRole('dialog', { name: /Copy & Customize/ })).toBeTruthy()
    expect(expanded(btn(/^Supply Chain Full Access, 6/))).toBe('true')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.click(btn(/^Warehouse Operator, 1 permission/))
    await userEvent.click(btn(/Show holders \(3\) of Warehouse Operator/))
    expect(expanded(btn(/^Warehouse Operator, 1/))).toBe('true')
    expect(btn(/Hide holders \(3\) of Warehouse Operator/)).toBeTruthy()
  })

  it('shows the description and notes only in the popover, and the icon does not toggle the policy', async () => {
    stub(); await mount()
    await userEvent.click(btn(/^Supply Chain, 2 profiles, /))
    expect(screen.queryByText('All supply chain permissions.')).toBeNull()
    const info = btn('About Supply Chain Full Access')
    await userEvent.click(info)
    expect(screen.getByText('All supply chain permissions.')).toBeTruthy()
    expect(screen.getByText(/explicit, not a wildcard/)).toBeTruthy()
    expect(expanded(btn(/^Supply Chain Full Access, 6/))).toBe('false')       // accordion untouched
    expect(expanded(info)).toBe('true')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByText('All supply chain permissions.')).toBeNull()
    expect(document.activeElement).toBe(info)
  })

  it('popover opens on hover (and stays open while the pointer is inside it), on keyboard focus and on tap; outside click closes it', async () => {
    vi.useFakeTimers()
    try {
      render(<><InfoPopover label="About thing"><p>Long explanation</p></InfoPopover><button>outside</button></>)
      const info = screen.getByRole('button', { name: 'About thing' })
      fireEvent.mouseEnter(info.parentElement!)
      expect(screen.getByText('Long explanation')).toBeTruthy()
      fireEvent.mouseLeave(info.parentElement!); fireEvent.mouseEnter(screen.getByRole('dialog'))   // moves onto the popover
      act(() => { vi.advanceTimersByTime(300) })
      expect(screen.getByText('Long explanation')).toBeTruthy()
      fireEvent.mouseLeave(info.parentElement!)
      act(() => { vi.advanceTimersByTime(300) })
      expect(screen.queryByText('Long explanation')).toBeNull()
      act(() => info.focus())
      expect(screen.getByText('Long explanation')).toBeTruthy()
      act(() => info.blur())
      expect(screen.queryByText('Long explanation')).toBeNull()
      fireEvent.click(info)                                                        // tap
      act(() => info.blur())
      expect(screen.getByText('Long explanation')).toBeTruthy()                    // pinned open by the tap
      fireEvent.pointerDown(screen.getByRole('button', { name: 'outside' }))
      expect(screen.queryByText('Long explanation')).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('uses an information icon (not a warning icon) with an accessible name', async () => {
    stub(); await mount()
    await userEvent.click(btn(/^Supply Chain, 2 profiles, /))
    const info = btn('About Supply Chain Full Access')
    expect(info.querySelector('svg')?.getAttribute('class')).toMatch(/lucide-info/)
    expect(info.querySelector('svg')?.getAttribute('class')).not.toMatch(/alert|triangle|circle-alert/)
    expect(info.getAttribute('aria-haspopup')).toBe('dialog')
  })
})
