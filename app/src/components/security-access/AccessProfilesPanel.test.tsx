// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AccessProfilesPanel from './AccessProfilesPanel'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const profile = (over: any) => ({ id: 'p', roleKey: 'k', name: 'N', description: null, kind: 'custom', status: 'active', version: 1, accountTypes: [], orgTypes: [], copiedFromId: null, permissionKeys: [], holders: 0, visibleHolders: 0, draft: null, ...over })
const PROFILES = [
  profile({ id: 'std', roleKey: 'warehouse-operator', name: 'Warehouse Operator', kind: 'standard', permissionKeys: ['inventory.stock_count.view', 'inventory.stock_count.create'], holders: 4, visibleHolders: 4 }),
  profile({ id: 'cust', roleKey: 'counter', name: 'Counter Staff', kind: 'custom', permissionKeys: ['inventory.stock_count.view'], holders: 2, visibleHolders: 1, accountTypes: ['internal'],
    draft: { id: 'd1', status: 'in_review', name: 'Counter Staff', description: null, accountTypes: ['internal'], orgTypes: [], permissionKeys: ['inventory.stock_count.view', 'inventory.stock_count.create'], submittedBy: 'someone', updatedAt: 'now' } }),
  profile({ id: 'free', roleKey: 'unused', name: 'Unused Profile', kind: 'custom', permissionKeys: ['finance.ledger.view'] }),
  profile({ id: 'newdraft', roleKey: 'brand-new', name: 'Brand New', kind: 'custom', status: 'draft', permissionKeys: [] }),
  profile({ id: 'compat', roleKey: 'legacy-hq', name: 'Legacy HQ', kind: 'compatibility', permissionKeys: ['finance.ledger.view'] }),
]
const PERMS = [
  { permission_key: 'inventory.stock_count.view', status: 'active' }, { permission_key: 'inventory.stock_count.create', status: 'active' },
  { permission_key: 'hr.employee.view', status: 'active' }, { permission_key: 'security.access.view', status: 'active' }, { permission_key: 'finance.ledger.view', status: 'active' },
]
const PREVIEW = { roleId: 'cust', name: 'Counter Staff', version: 1, added: ['inventory.stock_count.create'], removed: [], holderCount: 2, blockingConflicts: 0, selfPublishBlocked: false, impactHash: 'a'.repeat(32), conflicts: [],
  holders: [{ assignmentId: 'a1', name: 'Wati Warehouse', email: 'wati@dev.com', organization: 'Balakong WH', organizationType: 'WH', scopes: ['Balakong WH'] }, { assignmentId: 'a2', name: 'Manu Operator', email: 'manu@dev.com', organization: 'Manu Manufacturing', organizationType: 'MFG', scopes: ['Manu Manufacturing'] }] }

type H = (body: any) => any
function stub(post: H = () => ({ ok: true, result: {} }), profiles: any[] = PROFILES, list: any = { migrationReady: true }) {
  const fetchMock = vi.fn(async (url: string, init: any) => {
    if (!init?.body) return list.status ? { ok: false, status: list.status, json: async () => list.body } : { ok: true, status: 200, json: async () => ({ ok: true, profiles, ...list }) }
    const out = post(JSON.parse(init.body))
    return { ok: !out.status || out.status < 400, status: out.status ?? 200, json: async () => out.body ?? out }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
/** Profiles sit under collapsed module headers: open the module, then the profile. */
const openProfile = async (module: string, name: RegExp) => {
  const header = screen.getByRole('button', { name: new RegExp(`^${module}, \\d+ profiles?, `) })
  if (header.getAttribute('aria-expanded') !== 'true') await userEvent.click(header)
  await userEvent.click(screen.getByRole('button', { name }))
}
const posts = (f: any) => f.mock.calls.filter((c: any) => c[1]?.body).map((c: any) => JSON.parse(c[1].body))
const mount = async (onChanged = vi.fn()) => { render(<AccessProfilesPanel permissions={PERMS} onChanged={onChanged} fallback={<p>read-only fallback</p>} />); await screen.findByRole('button', { name: /^Standard\s*\d+$/ }); return onChanged }

describe('Access Profiles', () => {
  it('separates Standard, Custom and Compatibility; standard originals only offer Copy & Customize', async () => {
    stub()
    await mount()
    expect(screen.getByRole('button', { name: /^Custom\s*3$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Compatibility\s*1$/ })).toBeTruthy()
    await openProfile('Supply Chain', /^Warehouse Operator/)
    expect(screen.getByRole('button', { name: /Copy & Customize/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Edit|Continue draft|Retire/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^Compatibility\s*1$/ }))
    await openProfile('Finance', /^Legacy HQ/)
    expect(screen.getByText(/Managed by the lifecycle; not editable/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Copy|Edit|Retire|holders/ })).toBeNull()
  })

  it('Copy & Customize posts a reasoned copy and moves to the custom view', async () => {
    const f = stub()
    await mount()
    await openProfile('Supply Chain', /^Warehouse Operator/)
    await userEvent.click(screen.getByRole('button', { name: /Copy & Customize/ }))
    const dialog = within(screen.getByRole('dialog'))
    const create = dialog.getByRole('button', { name: 'Create copy' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    await userEvent.type(dialog.getByLabelText(/Reason/), 'Counter staff need create')
    await userEvent.click(create)
    await waitFor(() => expect(posts(f)).toHaveLength(1))
    expect(posts(f)[0]).toEqual({ action: 'copy', sourceId: 'std', roleKey: 'warehouse-operator-custom', name: 'Warehouse Operator (custom)', reason: 'Counter staff need create' })
    expect(await screen.findByText(/Copy created as a draft/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Custom\s*3$/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('shows holders and scopes, and an assigned profile cannot be retired', async () => {
    stub((b: any) => b.action === 'holders' ? { ok: true, result: { total: 2, visible: 1, holders: [PREVIEW.holders[0]] } } : { ok: true, result: {} })
    await mount()
    await userEvent.click(screen.getByRole('button', { name: /^Custom\s*3$/ }))
    await openProfile('Supply Chain', /^Counter Staff/)
    expect((screen.getByRole('button', { name: /^Retire Counter Staff/ }) as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: /Show holders of Counter Staff/ }))
    expect(await screen.findByText(/1 more in organizations you cannot view/)).toBeTruthy()
    expect(screen.getByText(/Wati Warehouse/)).toBeTruthy()
    expect(screen.getByText(/Balakong WH \(Warehouse\) · Scope: Balakong WH/)).toBeTruthy()
    await openProfile('Finance', /^Unused Profile/)
    expect((screen.getByRole('button', { name: /^Retire Unused Profile/ }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('a never-published copy is marked as a draft that cannot be assigned', async () => {
    stub()
    await mount()
    await userEvent.click(screen.getByRole('button', { name: /^Custom\s*3$/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Expand all/ }))
    expect(screen.getByText('Draft · not assignable')).toBeTruthy()
    expect(screen.getByText('Change in review')).toBeTruthy()
  })

  it('publishing shows the impact and needs a reason and confirmation when people hold the profile', async () => {
    const f = stub((b: any) => b.action === 'preview' ? { ok: true, result: PREVIEW } : { ok: true, result: { published: true } })
    const onChanged = await mount()
    await userEvent.click(screen.getByRole('button', { name: /^Custom\s*3$/ }))
    await openProfile('Supply Chain', /^Counter Staff/)
    await userEvent.click(screen.getByRole('button', { name: /Review & publish/ }))
    const dialog = within(await screen.findByRole('dialog'))
    expect(await dialog.findByText(/Added \(1\)/)).toBeTruthy()
    expect(dialog.getByText(/Affected people \(2\)/)).toBeTruthy()
    expect(dialog.getByText(/Manu Manufacturing \(Manufacturer\) · Scope: Manu Manufacturing/)).toBeTruthy()
    const publish = dialog.getByRole('button', { name: 'Publish' }) as HTMLButtonElement
    expect(publish.disabled).toBe(true)
    await userEvent.type(dialog.getByLabelText(/Reason/), 'too short')
    await userEvent.click(dialog.getByRole('checkbox'))
    expect(publish.disabled).toBe(true)                                 // reason under 10 characters
    await userEvent.type(dialog.getByLabelText(/Reason/), ' but now long enough')
    expect(publish.disabled).toBe(false)
    await userEvent.click(publish)
    await waitFor(() => expect(posts(f).some((b: any) => b.action === 'publish')).toBe(true))
    expect(posts(f).find((b: any) => b.action === 'publish')).toEqual({ action: 'publish', roleId: 'cust', impactHash: 'a'.repeat(32), reason: 'too short but now long enough' })
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('blocks publication on a holder SoD conflict or when the submitter would publish their own change', async () => {
    stub((b: any) => b.action === 'preview' ? { ok: true, result: { ...PREVIEW, blockingConflicts: 1, conflicts: [{ ruleKey: 'count-vs-receive', enforcement: 'enforce', mitigated: false }] } } : { ok: true, result: {} })
    await mount()
    await userEvent.click(screen.getByRole('button', { name: /^Custom\s*3$/ }))
    await openProfile('Supply Chain', /^Counter Staff/)
    await userEvent.click(screen.getByRole('button', { name: /Review & publish/ }))
    const dialog = within(await screen.findByRole('dialog'))
    expect((await dialog.findByRole('alert')).textContent).toMatch(/1 separation-of-duties conflict would block/)
    await userEvent.type(dialog.getByLabelText(/Reason/), 'a perfectly good reason')
    await userEvent.click(dialog.getByRole('checkbox'))
    expect((dialog.getByRole('button', { name: 'Publish' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a stale preview is rejected with a way to review a fresh one', async () => {
    let n = 0
    stub((b: any) => b.action === 'preview' ? { ok: true, result: { ...PREVIEW, impactHash: n++ ? 'b'.repeat(32) : 'a'.repeat(32) } } : { status: 409, body: { code: 'stale_preview', error: 'The profile or its holders changed since this impact preview.' } })
    await mount()
    await userEvent.click(screen.getByRole('button', { name: /^Custom\s*3$/ }))
    await openProfile('Supply Chain', /^Counter Staff/)
    await userEvent.click(screen.getByRole('button', { name: /Review & publish/ }))
    const dialog = within(await screen.findByRole('dialog'))
    await userEvent.type(await dialog.findByLabelText(/Reason/), 'a perfectly good reason')
    await userEvent.click(dialog.getByRole('checkbox'))
    await userEvent.click(dialog.getByRole('button', { name: 'Publish' }))
    await userEvent.click(await dialog.findByRole('button', { name: 'Refresh preview' }))
    await waitFor(() => expect((dialog.getByRole('checkbox') as HTMLInputElement).checked).toBe(false))
  })

  it('the editor saves explicit permissions only, disables HR/security permissions for partner profiles, and warns about sensitive ones', async () => {
    const f = stub((b: any) => b.action === 'create' ? { ok: true, result: 'new-id' } : { ok: true, result: {} })
    await mount()
    await userEvent.click(screen.getByRole('button', { name: /^Custom\s*3$/ }))
    await userEvent.click(screen.getByRole('button', { name: 'New profile' }))
    const dialog = within(screen.getByRole('dialog'))
    await userEvent.type(dialog.getByLabelText('Name'), 'Mfg Operator')
    expect((dialog.getByLabelText(/Profile key/) as HTMLInputElement).value).toBe('mfg-operator')
    await userEvent.click(dialog.getByRole('checkbox', { name: 'Partner account' }))
    expect(dialog.getByText(/Partner profiles cannot include HR/)).toBeTruthy()
    await userEvent.click(dialog.getByRole('button', { name: /^Supply Chain/ }))
    await userEvent.click(dialog.getByRole('checkbox', { name: /View Stock Count/ }))
    await userEvent.click(dialog.getByRole('button', { name: /^HR & Payroll/ }))
    expect((dialog.getByRole('checkbox', { name: /View Employee/ }) as HTMLInputElement).disabled).toBe(true)
    await userEvent.click(dialog.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(posts(f)).toHaveLength(1))
    expect(posts(f)[0]).toEqual({ action: 'create', roleKey: 'mfg-operator', name: 'Mfg Operator', description: '', accountTypes: ['partner'], orgTypes: [], permissionKeys: ['inventory.stock_count.view'] })
  })

  it('selecting listed permissions in an area is explicit and never reaches other areas or modules', async () => {
    const f = stub()
    await mount()
    await userEvent.click(screen.getByRole('button', { name: /^Custom\s*3$/ }))
    await userEvent.click(screen.getByRole('button', { name: 'New profile' }))
    const dialog = within(screen.getByRole('dialog'))
    await userEvent.type(dialog.getByLabelText('Name'), 'Counter Only')
    await userEvent.click(dialog.getByRole('button', { name: /^Supply Chain/ }))
    await userEvent.click(dialog.getByRole('button', { name: /Select listed in Stock Count/ }))
    expect(dialog.getByText(/Permissions · 2 selected/)).toBeTruthy()
    await userEvent.click(dialog.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(posts(f)).toHaveLength(1))
    expect(posts(f)[0].permissionKeys).toEqual(['inventory.stock_count.create', 'inventory.stock_count.view'])
  })

  it('explains a missing migration and falls back to the read-only list', async () => {
    stub(() => ({}), [], { status: 409, body: { code: 'profiles_migration_missing', error: 'needs 20261005110000_sa_access_profiles.sql' } })
    render(<AccessProfilesPanel permissions={PERMS} onChanged={vi.fn()} fallback={<p>read-only fallback</p>} />)
    expect(await screen.findByText(/20261005110000_sa_access_profiles\.sql/)).toBeTruthy()
    expect(screen.getByText('read-only fallback')).toBeTruthy()
  })

  it('starts with every module header collapsed, in the shared taxonomy order, and nothing hidden behind them', async () => {
    stub()
    await mount()
    const headers = screen.getAllByRole('button', { name: /, \d+ profiles?, (expand|collapse)$/ })
    expect(headers.map(h => h.getAttribute('aria-label')!.split(',')[0])).toEqual(['Supply Chain', 'Customer & Growth', 'HR & Payroll', 'Finance', 'Platform & Security', 'Reporting'])
    for (const h of headers) expect(h.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /^Warehouse Operator/ })).toBeNull()
    await userEvent.click(headers[0])
    expect(screen.getByRole('button', { name: /^Warehouse Operator, 2 permissions, expand$/ }).getAttribute('aria-expanded')).toBe('false')
  })

  it('a module with no profile explains itself informatively (no invented profiles, no error)', async () => {
    stub()
    await mount()
    await userEvent.click(screen.getByRole('button', { name: /^HR & Payroll, 0 profiles, expand$/ }))
    expect(screen.getByText(/No standard profiles in HR & Payroll\./)).toBeTruthy()
    expect(screen.getByText(/1 permission in this module is not in any profile yet — that is informational/)).toBeTruthy()
  })

  it('Expand all / Collapse all work from the keyboard and group permissions by module → area', async () => {
    stub()
    await mount()
    await userEvent.tab()
    const expand = screen.getByRole('button', { name: 'Expand all' })
    expand.focus()
    await userEvent.keyboard('{Enter}')
    const profile = screen.getByRole('button', { name: /^Warehouse Operator, 2 permissions, collapse$/ })
    expect(profile.getAttribute('aria-expanded')).toBe('true')
    const details = within(profile.closest('li')!)
    expect(details.getByText(/^Supply Chain/)).toBeTruthy()        // module
    expect(details.getByText('Stock Count')).toBeTruthy()           // functional area
    const collapse = screen.getByRole('button', { name: 'Collapse all' })
    collapse.focus()
    await userEvent.keyboard(' ')
    expect(screen.getByRole('button', { name: /^Supply Chain, \d+ profiles?, expand$/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Warehouse Operator/ })).toBeNull()
  })

  it('search reveals matching paths and the normal expansion returns when it is cleared', async () => {
    stub()
    await mount()
    await userEvent.click(screen.getByRole('button', { name: /^Supply Chain, \d+ profiles?, expand$/ }))      // the user's own expansion
    await userEvent.type(screen.getByRole('textbox', { name: 'Search profiles' }), 'create stock count')
    expect(screen.getByRole('status').textContent).toMatch(/Showing 1 matching profile/)
    // matched through a permission: its module and details are revealed, others are not listed
    expect(screen.getByRole('button', { name: /^Warehouse Operator, 2 permissions, collapse$/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Finance, / })).toBeNull()
    await userEvent.clear(screen.getByRole('textbox', { name: 'Search profiles' }))
    expect(screen.getByRole('button', { name: /^Supply Chain, \d+ profiles?, collapse$/ })).toBeTruthy()            // still open as the user left it
    expect(screen.getByRole('button', { name: /^Warehouse Operator, 2 permissions, expand$/ })).toBeTruthy()          // its details were not permanently opened
    expect(screen.getByRole('button', { name: /^Finance, 0 profiles, expand$/ })).toBeTruthy()
  })

  it('a profile spanning modules is listed once under Shared / Cross-module with its holders counted once', async () => {
    const cross = profile({ id: 'x', roleKey: 'x', name: 'Payroll Finance Approver', kind: 'standard', permissionKeys: ['hr.payroll.approve', 'finance.payment.approve'], holders: 3, visibleHolders: 3 })
    stub(undefined, [...PROFILES, cross])
    await mount()
    const header = screen.getByRole('button', { name: /^Shared \/ Cross-module, 1 profile, expand$/ })
    expect(screen.getByText(/1 profile · 3 assignments/)).toBeTruthy()
    await userEvent.click(header)
    expect(screen.getAllByText('Payroll Finance Approver')).toHaveLength(1)
    expect(screen.getByText(/listed once here/)).toBeTruthy()
    // still discoverable through each module it touches
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Module' }), 'finance')
    expect(screen.getByRole('button', { name: /^Shared \/ Cross-module, 1 profile/ })).toBeTruthy()
  })
})
