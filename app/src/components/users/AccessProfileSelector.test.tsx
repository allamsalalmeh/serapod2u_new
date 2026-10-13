// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import AccessProfileSelector, { scopesForPolicy, type AccessMode, type ProfileChoice } from './AccessProfileSelector'

afterEach(cleanup)

const std = (over: any) => ({ kind: 'standard' as const, ...over })
const cus = (over: any) => ({ kind: 'custom' as const, ...over })
const SC_FA = std({ id: 'sc', name: 'Supply Chain Full Access', roleKey: 'supply-chain-full-access', permissionKeys: ['inventory.stock_count.view', 'inventory.stock_count.post', 'supply_chain.order.approve', 'inventory.transfer.view'] })
const CG_FA = std({ id: 'cg', name: 'Customer & Growth Full Access', roleKey: 'customer-growth-full-access', permissionKeys: ['marketing.campaign.view', 'marketing.campaign.manage', 'customer.crm.view'] })
const PROFILES = [
  SC_FA, CG_FA,
  std({ id: 'wh', name: 'Warehouse Operator', description: 'Operates the warehouse', permissionKeys: ['inventory.stock_count.view'] }),                     // covered by SC Full Access
  std({ id: 'aud', name: 'Stock Auditor', permissionKeys: ['inventory.stock_count.view', 'inventory.audit.run'] }),                                           // NOT covered (extra permission)
  std({ id: 'camp', name: 'Campaign Editor', permissionKeys: ['marketing.campaign.view'] }),                                                                   // covered by CG Full Access
  std({ id: 'blind', name: 'Unlisted Standard' }),                                                                                                             // no published contents: never proven covered
  cus({ id: 'c-count', name: 'Custom Counter', permissionKeys: ['inventory.stock_count.view'] }),                                                               // custom: never replaced
  cus({ id: 'c-mix', name: 'Custom Mixed Duty', permissionKeys: ['inventory.stock_count.view', 'finance.ledger.view'] }),                                      // spans modules
  cus({ id: 'c-fin', name: 'Custom Finance Viewer', permissionKeys: ['finance.ledger.view'] }),
]
const HQ = { id: 's-hq', organization_id: 'hq', scope_type: 'organization', display_name: 'Serapod HQ', kind: 'hq' as const, label: 'Serapod HQ — HQ and all its warehouses', coverage: 'HQ and all its warehouses' }
const ALMA = { id: 's-alma', organization_id: 'alma', scope_type: 'warehouse', display_name: 'Alma', kind: 'warehouse' as const, label: 'Alma — this warehouse only', coverage: 'This warehouse only' }
const SCOPES = [HQ, ALMA]

function Harness(props: Partial<React.ComponentProps<typeof AccessProfileSelector>> & { onState?: (s: any) => void }) {
  const [mode, setMode] = useState<AccessMode>(props.mode ?? '')
  const [items, setItems] = useState<ProfileChoice[]>(props.items ?? [])
  props.onState?.({ mode, items })
  return <AccessProfileSelector profiles={PROFILES} scopes={SCOPES} orgNames={{ hq: 'Serapod HQ', alma: 'Alma' }} organizationName="Serapod HQ" organizationTypeCode="HQ"
    {...props} mode={mode} items={items} onMode={setMode} onItems={setItems} />
}
const tick = (name: string | RegExp) => userEvent.click(screen.getByRole('checkbox', { name }))
const ids = (state: any) => state.items.map((i: any) => i.roleId).sort()
const expand = (module: string) => userEvent.click(screen.getByRole('button', { name: `${module}, expand` }))
/** Opens the module, then its "Choose specific groups instead" fold (Full Access modules). */
const specific = async (module: string) => {
  await expand(module)
  await userEvent.click(within(screen.getByRole('region', { name: module })).getByRole('button', { name: /^Choose specific groups instead/ }))
}

describe('Add User → Group Policies picker', () => {
  it('classifies the account and keeps the choice explicit (nothing preselected)', () => {
    render(<Harness />)
    expect(screen.getByText(/Internal staff/)).toBeTruthy()
    expect((screen.getByRole('radio', { name: 'Assign Group Policies' }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('radio', { name: 'No Group Policy for now' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByRole('list', { name: 'Selected Group Policies' })).toBeNull()
    cleanup()
    render(<Harness organizationName="Manu" organizationTypeCode="MFG" />)
    expect(screen.getByText(/Partner account/)).toBeTruthy()
  })

  it('names the Employee Self Service choice only for HQ; it never appears for other organization types', () => {
    render(<Harness essAllowed />)
    expect(screen.getByText('Basic access for HQ staff.')).toBeTruthy()
    expect(screen.queryByRole('radio')).toBeNull()                       // no mutually exclusive choice for HQ
    cleanup()
    render(<Harness essAllowed={false} />)
    expect(screen.queryByText(/Employee Self Service/)).toBeNull()
    expect(screen.getByRole('radio', { name: 'No Group Policy for now' })).toBeTruthy()
  })

  it('has no separate “Add policy” step: choosing Assign Group Policies shows the checkbox hierarchy, nothing selected', async () => {
    let state: any
    render(<Harness onState={s => { state = s }} />)
    await userEvent.click(screen.getByRole('radio', { name: 'Assign Group Policies' }))
    expect(screen.queryByRole('button', { name: /Add (a|another)? ?policy/ })).toBeNull()
    expect(screen.getByRole('tab', { name: /^Standard/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /^Custom/ })).toBeTruthy()
    expect(state.items).toEqual([])
    const sc = screen.getByRole('checkbox', { name: 'Supply Chain — Full Access' }) as HTMLInputElement
    expect(sc.checked).toBe(false)
    expect(sc.value).toBe('sc')                                                         // identified by the stable id, not the label
    // every module starts collapsed
    expect(screen.getAllByRole('button', { name: /, (expand|collapse)$/ }).every(b => b.getAttribute('aria-expanded') === 'false')).toBe(true)
  })

  it('arrow on the left expands, checkbox on the right selects: neither does the other’s job, and collapsing keeps the selection', async () => {
    let state: any
    render(<Harness mode="profiles" onState={s => { state = s }} />)
    const toggle = screen.getByRole('button', { name: 'Supply Chain, expand' })
    const box = screen.getByRole('checkbox', { name: 'Supply Chain — Full Access' })
    const header = toggle.parentElement!
    expect(header.firstElementChild).toBe(toggle)                                       // arrow first (left)
    expect(header.contains(box) && !toggle.contains(box)).toBe(true)                    // checkbox a sibling, never inside the toggle
    expect(Array.from(header.children).indexOf(box.closest('label')!)).toBeGreaterThan(0)
    await userEvent.click(box)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')                          // selecting does not expand
    await userEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect((box as HTMLInputElement).checked).toBe(true)                                // expanding does not change the selection
    await userEvent.click(toggle)
    expect(state.items).toEqual([{ roleId: 'sc', scopeId: '' }])                        // collapsing does not clear it
    expect((box as HTMLInputElement).checked).toBe(true)
  })

  it('Supply Chain Full Access + Customer & Growth Full Access produce exactly two assignments, sharing one scope control', async () => {
    let state: any
    render(<Harness mode="profiles" onState={s => { state = s }} />)
    await tick('Supply Chain — Full Access')
    await tick('Customer & Growth — Full Access')
    expect(state.items).toEqual([{ roleId: 'sc', scopeId: '' }, { roleId: 'cg', scopeId: '' }])      // ticked, scope still explicit
    const control = screen.getAllByRole('group', { name: /^Data scope for/ })
    expect(control).toHaveLength(1)                                                                  // identical valid scopes → one shared control
    await userEvent.click(within(control[0]).getByRole('checkbox', { name: HQ.label }))
    expect(state.items).toEqual([{ roleId: 'sc', scopeId: 's-hq' }, { roleId: 'cg', scopeId: 's-hq' }])
    // narrower policies of those modules were NOT assigned
    expect(ids(state)).toEqual(['cg', 'sc'])
  })

  it('inspecting Full Access contents is read-only and adds no grants', async () => {
    let state: any
    render(<Harness mode="profiles" onState={s => { state = s }} />)
    await expand('Supply Chain')
    expect(screen.getByText(/Included permissions \(read-only\)/)).toBeTruthy()
    const stock = screen.getByRole('button', { name: /^Stock Count, 2 permissions, expand$/ })
    await userEvent.click(stock)
    expect(screen.getByText('inventory.stock_count.post')).toBeTruthy()
    // the contents hold no checkboxes of their own
    expect(within(screen.getByRole('region', { name: 'Supply Chain' })).getAllByRole('checkbox').map(c => (c as HTMLInputElement).value)).toEqual(['sc'])
    expect(screen.queryByRole('checkbox', { name: 'inventory.stock_count.post' })).toBeNull()
    expect(state.items).toEqual([])
  })

  it('switching to Full Access replaces only what is proven covered, keeps the rest, and explains it', async () => {
    let state: any
    render(<Harness mode="profiles" onState={s => { state = s }} />)
    await specific('Supply Chain')
    await tick('Warehouse Operator')
    await tick('Stock Auditor')
    expect(ids(state)).toEqual(expect.arrayContaining(['wh', 'aud']))
    await tick('Supply Chain — Full Access')
    // Warehouse Operator ⊂ Full Access → replaced. Stock Auditor has a permission Full Access lacks → kept.
    expect(ids(state)).toContain('sc')
    expect(ids(state)).not.toContain('wh')
    expect(ids(state)).toContain('aud')
    expect(screen.getByRole('status').textContent).toMatch(/Supply Chain — Full Access replaced Warehouse Operator/)
  })

  it('never treats a custom policy or a policy of unknown contents as covered', async () => {
    let state: any
    render(<Harness mode="profiles" onState={s => { state = s }} />)
    await userEvent.click(screen.getByRole('tab', { name: /^Custom/ }))
    await expand('Supply Chain')
    await tick('Custom Counter')
    await userEvent.click(screen.getByRole('tab', { name: /^Standard/ }))
    await tick('Supply Chain — Full Access')
    expect(ids(state)).toEqual(['c-count', 'sc'])                                       // Standard Full Access did not select (or drop) Custom
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('choosing specific groups after Full Access removes that module’s Full Access explicitly', async () => {
    let state: any
    render(<Harness mode="profiles" onState={s => { state = s }} />)
    await tick('Supply Chain — Full Access')
    await tick('Customer & Growth — Full Access')
    await specific('Supply Chain')
    expect(within(screen.getByRole('region', { name: 'Supply Chain' })).getByText('Included in Full Access')).toBeTruthy()   // Warehouse Operator
    await tick('Stock Auditor')
    expect(ids(state)).toEqual(['aud', 'cg'])                                           // Supply Chain Full Access removed, other module untouched
    expect(screen.getByRole('status').textContent).toMatch(/Supply Chain — Full Access was removed because you chose specific groups/)
  })

  it('Standard and Custom selections persist across tabs and are summarised once each', async () => {
    let state: any
    render(<Harness mode="profiles" onState={s => { state = s }} />)
    await tick('Supply Chain — Full Access')
    await userEvent.click(screen.getByRole('tab', { name: /^Custom/ }))
    await expand('Finance')
    await tick('Custom Finance Viewer')
    await userEvent.click(screen.getByRole('tab', { name: /^Standard/ }))
    expect((screen.getByRole('checkbox', { name: 'Supply Chain — Full Access' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('tab', { name: /^Custom.*1 selected/ })).toBeTruthy()
    expect(ids(state)).toEqual(['c-fin', 'sc'])
    const rows = within(screen.getByRole('list', { name: 'Selected Group Policies' })).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
  })

  it('Custom shows only custom policies; a cross-module policy appears once under Shared / Cross-module; empty groups are hidden', async () => {
    render(<Harness mode="profiles" />)
    await userEvent.click(screen.getByRole('tab', { name: /^Custom/ }))
    await expand('Shared / Cross-module'); await expand('Supply Chain'); await expand('Finance')
    expect(screen.queryByRole('checkbox', { name: 'Warehouse Operator' })).toBeNull()
    expect(screen.getAllByRole('checkbox', { name: 'Custom Mixed Duty' })).toHaveLength(1)
    expect(within(screen.getByRole('region', { name: 'Shared / Cross-module' })).getByRole('checkbox', { name: 'Custom Mixed Duty' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Customer & Growth' })).toBeNull()      // no custom policy there → no header
    cleanup()
    render(<Harness mode="profiles" profiles={PROFILES.filter(p => p.kind === 'standard')} />)
    await userEvent.click(screen.getByRole('tab', { name: /^Custom/ }))
    expect(screen.getByText(/No custom Group Policy is available/)).toBeTruthy()
  })

  it('a module without an eligible Full Access policy says “Choose groups”, has no select-all box, and expands to its own child choices', async () => {
    let state: any
    render(<Harness mode="profiles" profiles={PROFILES.filter(p => p.id !== 'cg')} onState={s => { state = s }} />)
    const cg = screen.getByRole('region', { name: 'Customer & Growth' })
    expect(within(cg).getByText('Choose groups')).toBeTruthy()
    expect(within(cg).queryByRole('checkbox')).toBeNull()                                // nothing misleading before it is opened
    await expand('Customer & Growth')
    expect(within(cg).queryByRole('checkbox', { name: /Full Access/ })).toBeNull()
    expect(within(cg).queryByRole('button', { name: /Choose specific groups/ })).toBeNull()   // no fold, nothing implicit
    await userEvent.click(within(cg).getByRole('checkbox', { name: 'Campaign Editor' }))
    expect(state.items.map((i: any) => i.roleId)).toEqual(['camp'])
    expect(within(cg).getByText('1 selected')).toBeTruthy()
  })

  it('search narrows what is shown without changing the selection', async () => {
    let state: any
    render(<Harness mode="profiles" onState={s => { state = s }} />)
    await tick('Supply Chain — Full Access')
    await userEvent.type(screen.getByRole('textbox', { name: 'Search Group Policies' }), 'campaign')
    expect(screen.queryByRole('checkbox', { name: 'Supply Chain — Full Access' })).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Campaign Editor' })).toBeTruthy()
    expect(state.items).toEqual([{ roleId: 'sc', scopeId: '' }])
    expect(screen.getByText(/1 selected policy is hidden by this search and still selected/)).toBeTruthy()
    await userEvent.clear(screen.getByRole('textbox', { name: 'Search Group Policies' }))
    expect((screen.getByRole('checkbox', { name: 'Supply Chain — Full Access' }) as HTMLInputElement).checked).toBe(true)
  })

  it('uses separate scope controls when policies need different scopes, and removes a policy from the summary list', async () => {
    const profiles = [...PROFILES.slice(0, 3), std({ id: 'fin', name: 'Finance Poster', permissionKeys: ['finance.ledger.post'], warehouseSupport: { level: 'none' as const, supported: 0, total: 1 } })]
    let state: any
    render(<Harness mode="profiles" profiles={profiles} onState={s => { state = s }} />)
    await specific('Supply Chain')
    await tick('Warehouse Operator')
    await expand('Finance')
    await tick('Finance Poster')
    const controls = screen.getAllByRole('group', { name: /^Data scope for/ })
    expect(controls).toHaveLength(2)
    expect(within(controls[1]).getByText(/only option, selected/)).toBeTruthy()          // HQ is Finance Poster’s only valid scope
    expect(state.items).toEqual([{ roleId: 'wh', scopeId: '' }, { roleId: 'fin', scopeId: 's-hq' }])
    await userEvent.click(within(controls[0]).getByRole('checkbox', { name: ALMA.label }))
    expect(state.items).toEqual([{ roleId: 'wh', scopeId: 's-alma' }, { roleId: 'fin', scopeId: 's-hq' }])
    await userEvent.click(screen.getByRole('button', { name: 'Remove Finance Poster' }))
    expect(ids(state)).toEqual(['wh'])
  })

  it('a policy with no valid scope blocks with an accurate message, never a global grant', async () => {
    render(<Harness mode="profiles" scopes={[]} />)
    await tick('Supply Chain — Full Access')
    expect(screen.getByRole('alert').textContent).toMatch(/No data scope is available for Supply Chain Full Access/)
  })

  it('the same policy may hold several scopes, never the same policy-and-scope pair twice', async () => {
    let state: any
    render(<Harness mode="profiles" onState={s => { state = s }} />)
    await tick('Supply Chain — Full Access')
    await userEvent.click(screen.getByRole('checkbox', { name: HQ.label }))
    await userEvent.click(screen.getByRole('checkbox', { name: ALMA.label }))
    expect(state.items).toEqual([{ roleId: 'sc', scopeId: 's-hq' }, { roleId: 'sc', scopeId: 's-alma' }])
    await userEvent.click(screen.getByRole('checkbox', { name: HQ.label }))
    expect(state.items).toEqual([{ roleId: 'sc', scopeId: 's-alma' }])
  })

  it('tells identically named scopes apart with the shared scope-label helper', async () => {
    const same = [{ id: 's-bal', organization_id: 'o', scope_type: 'warehouse', display_name: 'Balakong' }, { id: 's-org', organization_id: 'o', scope_type: 'organization', display_name: 'Balakong' }]
    render(<Harness mode="profiles" scopes={same} orgNames={{ o: 'Main WH' }} />)
    await tick('Supply Chain — Full Access')
    const labels = within(screen.getByRole('group', { name: /^Data scope for/ })).getAllByRole('checkbox').map(c => (c as HTMLInputElement).labels?.[0]?.textContent)
    expect(labels).toEqual(expect.arrayContaining(['Balakong (Warehouse)', 'Balakong (Organization)']))
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('supports keyboard use: separate expand buttons, labelled checkboxes, arrow keys between tabs', async () => {
    render(<Harness mode="profiles" />)
    screen.getByRole('tab', { name: /^Standard/ }).focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: /^Custom/ }).getAttribute('aria-selected')).toBe('true')
    await userEvent.keyboard('{ArrowLeft}')
    await userEvent.tab()                                                               // search box
    expect(screen.getByRole('tabpanel')).toBeTruthy()
    const box = screen.getByRole('checkbox', { name: 'Supply Chain — Full Access' })
    box.focus(); await userEvent.keyboard(' ')
    expect((box as HTMLInputElement).checked).toBe(true)
  })

  it('filters scopes by the policy’s supported scope types when the catalogue states them', () => {
    const orgOnly = { id: 'org-only', name: 'Org Only Policy', scopeTypes: ['organization'] }
    expect(scopesForPolicy(orgOnly, SCOPES).map(s => s.id)).toEqual(['s-hq'])
    expect(scopesForPolicy({ id: 'x', name: 'X' }, SCOPES).map(s => s.id)).toEqual(['s-hq', 's-alma'])
    expect(scopesForPolicy(undefined, SCOPES)).toEqual([])
  })

  it('does not claim to be the complete effective access', () => {
    render(<Harness mode="self" />)
    expect(screen.getByRole('button', { name: 'About the access summary' })).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Access summary' })).getByText(/No Group Policy selected/)).toBeTruthy()
  })

  it('explains an empty profile list instead of showing an empty picker', async () => {
    render(<Harness profiles={[]} scopes={[]} mode="profiles" />)
    expect(screen.getByText(/No Group Policy can be assigned here for this organization and account type/)).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /^Standard/ })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Search Group Policies' })).toBeNull()
    expect(document.getElementById('user-dialog-access-reason')).toBeNull()
  })

  it('never asks the administrator for an access reason (the audit context is generated on the server)', async () => {
    render(<Harness mode="profiles" items={[{ roleId: 'wh', scopeId: 's-hq' }]} />)
    expect(document.getElementById('user-dialog-access-reason')).toBeNull()
    expect(screen.queryByText(/Reason \(recorded/)).toBeNull()
  })

  it('shows a concise Manufacturer empty state, never switches the choice, and keeps explicit no-policy creation', async () => {
    render(<Harness profiles={[]} scopes={[]} mode="" organizationTypeCode="MFG" organizationName="Hong Kong Vapehome" />)
    expect(screen.getByText('No Manufacturer policy available')).toBeTruthy()
    expect(screen.getByText(/An account created without a Group Policy has no Manufacturing access/)).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Open Group Policies' })).toBeNull()      // actor cannot open S&A → no link
    expect((screen.getByRole('radio', { name: 'No Group Policy for now' }) as HTMLInputElement).checked).toBe(false)   // not silently chosen
    expect((screen.getByRole('radio', { name: 'Assign Group Policies' }) as HTMLInputElement).checked).toBe(false)
    await userEvent.click(screen.getByRole('radio', { name: 'No Group Policy for now' }))
    expect(screen.queryByText('No Manufacturer policy available')).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Access summary' })).getByText(/No Group Policy selected/)).toBeTruthy()
    cleanup()
    render(<Harness profiles={[]} scopes={[]} mode="" organizationTypeCode="MFG" groupPoliciesHref="/security-access?tab=roles" />)
    expect((screen.getByRole('link', { name: 'Open Group Policies' }) as HTMLAnchorElement).getAttribute('href')).toBe('/security-access?tab=roles')
  })

  describe('Manufacturer scope availability', () => {
    const MFA = [cus({ id: 'mfa', name: 'Manufacturing Full Access — Manufacturer', permissionKeys: ['manufacturing.order.view'] })]
    const OWN = [{ id: 'own', organization_id: 'mf', scope_type: 'organization', display_name: 'MF004', kind: 'organization' as const, label: 'MF004 — this organization', coverage: 'This organization' }]

    it('a Manufacturer whose own scope exists gets exactly that scope, displayed (never global)', async () => {
      let state: any
      render(<Harness profiles={MFA} scopes={OWN} mode="profiles" organizationTypeCode="MFG" orgNames={{ mf: 'MF004' }} onState={s => { state = s }} />)
      await userEvent.click(screen.getByRole('tab', { name: /^Custom/ }))
      await userEvent.click(screen.getByRole('button', { name: /, expand$/ }))
      await tick('Manufacturing Full Access — Manufacturer')
      expect(state.items).toEqual([{ roleId: 'mfa', scopeId: 'own' }])
      expect(screen.getByText(/only option, selected/)).toBeTruthy()
    })

    it('with no scope defined for the organization it fails closed and says why', async () => {
      let state: any
      render(<Harness profiles={MFA} scopes={[]} mode="profiles" organizationTypeCode="MFG" onState={s => { state = s }} />)
      await userEvent.click(screen.getByRole('tab', { name: /^Custom/ }))
      await userEvent.click(screen.getByRole('button', { name: /, expand$/ }))
      await tick('Manufacturing Full Access — Manufacturer')
      expect(state.items).toEqual([{ roleId: 'mfa', scopeId: '' }])
      expect(screen.getByRole('alert').textContent).toMatch(/No data scope is available/)
    })
  })

  it('shows validation errors passed by the form, visibly (not inside a tooltip)', () => {
    render(<Harness mode="profiles" items={[{ roleId: 'wh', scopeId: 's-hq' }]} errors={{ items: 'Choose a data scope for Warehouse Operator.' }} />)
    expect(screen.getAllByRole('alert').map(a => a.textContent)).toEqual(['Choose a data scope for Warehouse Operator.'])
  })

  it('shows the missing scope in the access summary as not chosen, never as a scope', () => {
    render(<Harness mode="profiles" items={[{ roleId: 'sc', scopeId: '' }]} />)
    expect(within(screen.getByRole('region', { name: 'Access summary' })).getByText(/scope: not chosen yet/)).toBeTruthy()
  })
})

describe('Add User → Group Policies: sensitive Full Access policies', () => {
  it('explains that deferred policies are assigned after the person exists, and offers no way to pick them here', async () => {
    render(<Harness mode="profiles" deferredProfiles={[{ id: 'sa', name: 'Security & Access Full Access' }, { id: 'fin', name: 'Finance Full Access' }]} />)
    // The explanation lives in the accessible ⓘ popover; only the count stays visible.
    expect(screen.getByText(/2 policies are not offered here/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Policies not offered while creating a person' }))
    expect(screen.getByText(/only when you hold those permissions/)).toBeTruthy()
    expect(screen.getByText(/Security & Access Full Access, Finance Full Access/)).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: /Finance Full Access|Finance — Full Access/ })).toBeNull()
  })

  it('shows no note when nothing is deferred', () => {
    render(<Harness mode="profiles" />)
    expect(screen.queryByText(/not offered here/)).toBeNull()
  })
})

describe('Add User → HQ scope picker (canonical choices)', () => {
  const BAL = { id: 's-bal', organization_id: 'bal', scope_type: 'warehouse', display_name: 'Balakong', kind: 'warehouse' as const, label: 'Balakong — this warehouse only', coverage: 'This warehouse only' }
  const HQ_SCOPES = [HQ, ALMA, BAL]
  const HQ_PROFILES = [
    std({ id: 'stock', name: 'Stock Operator', permissionKeys: ['inventory.stock_count.view'], warehouseSupport: { level: 'full' as const, supported: 1, total: 1 } }),
    std({ id: 'mixed', name: 'Supply Chain Full Access', roleKey: 'supply-chain-full-access', permissionKeys: ['inventory.stock_count.view', 'inventory.stock_count.post'], warehouseSupport: { level: 'partial' as const, supported: 12, total: 30 } }),
    std({ id: 'fin', name: 'Finance Poster', permissionKeys: ['finance.ledger.post'], warehouseSupport: { level: 'none' as const, supported: 0, total: 1 } }),
  ]
  const setup = (extra: any = {}) => render(<Harness profiles={HQ_PROFILES} scopes={HQ_SCOPES} organizationName="Serapod HQ" organizationTypeCode="HQ" essAllowed mode="profiles" {...extra} />)

  it('shows only the HQ and its warehouses, with the approved labels, and nothing preselected', async () => {
    setup(); await specific('Supply Chain'); await tick('Stock Operator')
    const control = screen.getByRole('group', { name: 'Data scope for Stock Operator' })
    expect(within(control).getAllByRole('checkbox').map(c => (c as HTMLInputElement).labels?.[0]?.textContent)).toEqual([HQ.label, ALMA.label, BAL.label])
    expect(within(control).getAllByRole('checkbox').every(c => !(c as HTMLInputElement).checked)).toBe(true)
  })
  it('keeps the chosen coverage in the access summary', async () => {
    setup(); await specific('Supply Chain'); await tick('Stock Operator')
    await userEvent.click(screen.getByRole('checkbox', { name: HQ.label }))
    expect(within(screen.getByRole('region', { name: 'Access summary' })).getByText(/covers: HQ and all its warehouses/)).toBeTruthy()
  })
  it('puts the longer scope explanation in the accessible ⓘ popover', async () => {
    setup(); await specific('Supply Chain'); await tick('Stock Operator')
    expect(screen.getByRole('button', { name: 'About scopes' })).toBeTruthy()
  })
  it('does not offer a warehouse scope for a policy no warehouse can limit, and says why', async () => {
    setup(); await expand('Finance'); await tick('Finance Poster')
    const control = screen.getByRole('group', { name: 'Data scope for Finance Poster' })
    expect(within(control).queryByRole('checkbox')).toBeNull()                            // only HQ is valid → shown, not a choice
    expect(within(control).getByText(/Serapod HQ — HQ and all its warehouses/)).toBeTruthy()
    expect(screen.queryByText(/cannot be assigned to one warehouse/)).toBeNull()          // long note is in the ⓘ, not on the page
    await userEvent.click(screen.getByRole('button', { name: 'About scopes' }))
    expect(screen.getByText(/cannot be assigned to one warehouse/)).toBeTruthy()
  })
  it('flags a policy only partly limited by a warehouse (nothing is removed from it)', async () => {
    setup(); await tick('Supply Chain — Full Access')
    expect(screen.queryByText(/A warehouse scope covers 12/)).toBeNull()                 // only while a warehouse scope is chosen
    await userEvent.click(screen.getByRole('checkbox', { name: ALMA.label }))
    expect(screen.getByText(/A warehouse scope covers 12 of this policy's 30 permissions\./)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'About scopes' }))
    expect(screen.getByText(/does not grant them/)).toBeTruthy()
  })
  it('a single valid choice is displayed and selected automatically', async () => {
    let state: any
    render(<Harness profiles={HQ_PROFILES} scopes={[BAL]} organizationName="Balakong" organizationTypeCode="WH" mode="profiles" onState={s => { state = s }} />)
    await specific('Supply Chain'); await tick('Stock Operator')
    expect(screen.getByText(/only option, selected/)).toBeTruthy()
    expect(state.items).toEqual([{ roleId: 'stock', scopeId: 's-bal' }])
  })
  it('scopesForPolicy drops warehouse choices for an unsupported policy only', () => {
    expect(scopesForPolicy(HQ_PROFILES[2], HQ_SCOPES).map(s => s.id)).toEqual(['s-hq'])
    expect(scopesForPolicy(HQ_PROFILES[0], HQ_SCOPES).map(s => s.id)).toEqual(['s-hq', 's-alma', 's-bal'])
  })
})

describe('organization-type eligibility in Add User', () => {
  it('explains the policies that are not available for the organization type, without offering them', async () => {
    render(<Harness organizationTypeCode="SHOP" organizationName="Corner Shop" profiles={[]} mode="profiles"
      ineligibleProfiles={[{ id: 'gl', name: 'GL Clerk', message: 'This Group Policy is not available for Shop accounts.' }]} />)
    expect(screen.getByTestId('ineligible-policies').textContent).toMatch(/1 Group Policy is not available for Shop accounts/)
    expect(screen.queryByRole('checkbox', { name: /GL Clerk/ })).toBeNull()
    expect(screen.getByText(/No Group Policy can be assigned here/)).toBeTruthy()
  })
})
