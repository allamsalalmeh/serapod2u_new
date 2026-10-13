// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import PeopleAccessPanel from './PeopleAccessPanel'

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as any
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const HQ = 'org-hq'
const DIST = 'org-dist'
const perms = (...keys: string[]) => keys.map(k => ({ permission: { permission_key: k } }))
const ROLES = [
  { id: 'r-legacy', name: 'Legacy HQ', source: 'legacy', status: 'active', permissions: perms('customer.crm.view', 'finance.ledger.view') },
  { id: 'r-crm', name: 'CRM User', source: 'template', status: 'active', applicable_org_types: ['HQ'], permissions: perms('customer.crm.view') },
  { id: 'r-ess', name: 'Employee Self-Service', source: 'template', status: 'active', applicable_org_types: ['HQ'], permissions: perms('hr.self_service.use') },
  { id: 'r-order', name: 'Order Approver', source: 'template', status: 'active', applicable_org_types: ['HQ'], description: 'Approves orders', permissions: perms('supply_chain.order.approve') },
  { id: 'r-gl', name: 'GL Clerk', source: 'template', status: 'active', applicable_org_types: ['HQ'], permissions: perms('finance.ledger.view', 'finance.module.view') },
  { id: 'r-pfa', name: 'Payroll Finance Approver', source: 'template', status: 'active', applicable_org_types: ['HQ'], permissions: perms('hr.payroll.approve', 'finance.payment.approve') },
]
// Membership organizations carry their stored type, as the directory read model returns them (eligibility is judged on it).
const HQ_ORG = { org_name: 'Serapod HQ', org_type_code: 'HQ' }
const DIST_ORG = { org_name: 'North Distributor', org_type_code: 'DIST' }
const role = (id: string) => { const r = ROLES.find(x => x.id === id)!; return { id: r.id, name: r.name, source: r.source } }
const assignment = (id: string, roleId: string, source: string, extra: any = {}) => ({
  id, status: 'active', source, effective_until: null, role: role(roleId), scopes: [{ scope: { display_name: 'Serapod HQ' } }], ...extra,
})
const data = {
  viewerId: 'viewer',
  organizations: [{ id: HQ, org_name: 'Serapod HQ' }, { id: DIST, org_name: 'North Distributor' }],
  roles: ROLES,
  scopeDefinitions: [
    { id: 'scope-hq', organization_id: HQ, scope_type: 'organization', display_name: 'Serapod HQ' },
    { id: 'scope-dist', organization_id: DIST, scope_type: 'organization', display_name: 'North Distributor' },
  ],
  people: [
    { id: 'u1', full_name: 'Jafar Admin', email: 'jafar@example.test', role_code: 'HQ', is_active: true,
      membership: [{ id: 'm1', organization_id: HQ, organization: HQ_ORG, status: 'active', is_primary: true, assignments: [
        assignment('a1', 'r-legacy', 'derived'), assignment('a2', 'r-crm', 'backfill'), assignment('a5', 'r-ess', 'derived'),
        assignment('a3', 'r-order', 'manual', { effective_until: '2099-01-01T00:00:00Z' }),
      ] }] },
    { id: 'u2', full_name: 'Siti Staff', email: 'siti@example.test', role_code: 'USER', is_active: true,
      membership: [{ id: 'm2', organization_id: HQ, organization: HQ_ORG, status: 'active', is_primary: true, assignments: [assignment('a4', 'r-ess', 'derived')] }] },
    { id: 'u3', full_name: 'Old Leaver', email: 'old@example.test', role_code: 'USER', is_active: false, membership: [] },
    { id: 'u4', full_name: 'Dina Dual', email: 'dina@example.test', role_code: 'USER', is_active: true, membership: [
      { id: 'm4a', organization_id: HQ, organization: HQ_ORG, status: 'active', is_primary: true, assignments: [] },
      { id: 'm4b', organization_id: DIST, organization: DIST_ORG, status: 'active', is_primary: false, membership_type: 'secondary', assignments: [] },
    ] },
    { id: 'u5', full_name: 'Suspended Sam', email: 'sam@example.test', role_code: 'USER', is_active: true,
      membership: [{ id: 'm5', organization_id: HQ, organization: HQ_ORG, status: 'suspended', is_primary: true, assignments: [] }] },
    { id: 'viewer', full_name: 'Me Myself', email: 'me@example.test', role_code: 'SA', is_active: true,
      membership: [{ id: 'mv', organization_id: HQ, organization: HQ_ORG, status: 'active', is_primary: true, assignments: [] }] },
  ],
}


const d0 = data
/** Fake server for GET /api/security-access/people (mirrors sa_directory_page semantics) and other calls. */
type Handler = (url: string, init: any) => any
function serve(people: any[], other?: Handler, opts: { scopeDefinitions?: any[]; organizations?: any[]; failDirectory?: any; requests?: string[]; userManagement?: boolean; scopeChoices?: any[] } = {}) {
  return vi.fn(async (url: string, init: any) => {
    if (String(url).startsWith('/api/security-access/people')) {
      opts.requests?.push(String(url))
      if (opts.failDirectory) return { ok: false, status: opts.failDirectory.status ?? 500, json: async () => opts.failDirectory.body }
      const params = new URL(url, 'http://x').searchParams
      const q = (params.get('q') || '').toLowerCase(), filter = params.get('filter') || 'all', org = params.get('org')
      const category = params.get('category'), orgTypeF = params.get('orgType'), statusF = params.get('status') || 'all', memF = params.get('membership') || 'all'
      const activeMem = (p: any) => (p.membership || []).some((m: any) => m.status === 'active')
      const offset = Number(params.get('offset') || 0), limit = Number(params.get('limit') || 25)
      const act = (p: any) => (p.membership || []).flatMap((m: any) => (m.assignments || []).filter((a: any) => a.status === 'active'))
      const granted = (p: any) => act(p).some((a: any) => !['backfill', 'derived'].includes(a.source) && a.role?.source !== 'legacy')
      const inScope = people.filter(p => (!org || p.organization_id === org || (p.membership || []).some((m: any) => m.organization_id === org))
        && (!category || (category === 'UNCLASSIFIED' ? !p.principal_type : p.principal_type === category))
        && (!orgTypeF || String(p.organization?.org_type_code || '').toUpperCase() === orgTypeF)
        && (statusF === 'all' || (statusF === 'active') === !!p.is_active)
        && (memF === 'all' || (memF === 'has') === activeMem(p)))
      const counts = { all: inScope.length, granted: inScope.filter(granted).length, temporary: inScope.filter(p => act(p).some((a: any) => a.effective_until)).length,
        inactive: inScope.filter(p => !p.is_active).length, none: inScope.filter(p => !(p.membership || []).length).length }
      const rows = inScope.filter(p => (!q || `${p.full_name} ${p.email}`.toLowerCase().includes(q))
        && (filter === 'all' || (filter === 'granted' && granted(p)) || (filter === 'temporary' && act(p).some((a: any) => a.effective_until))
          || (filter === 'inactive' && !p.is_active) || (filter === 'none' && !(p.membership || []).length)))
      return { ok: true, status: 200, json: async () => ({ ok: true, people: rows.slice(offset, offset + limit), total: rows.length, counts, organizations: opts.organizations ?? [], capabilities: { userManagement: opts.userManagement ?? false } }) }
    }
    if (String(url).startsWith('/api/security-access/scope-choices')) {
      // Mirrors GET /scope-choices: the canonical choices for the membership organization (the fixtures define one scope per organization).
      const org = new URL(url, 'http://x').searchParams.get('organizationId')
      if (opts.scopeChoices) return { ok: true, status: 200, json: async () => ({ choices: opts.scopeChoices }) }
      return { ok: true, status: 200, json: async () => ({ choices: (opts.scopeDefinitions ?? d0.scopeDefinitions).filter((x: any) => x.organization_id === org).map((x: any) => ({ ...x, kind: 'organization', label: `${x.display_name} — this organization`, coverage: 'This organization and the organizations beneath it' })) }) }
    }
    return other ? other(url, init) : { ok: true, status: 200, json: async () => ({}) }
  })
}
/** Mounts the panel against a fake directory server and waits for the first page. */
async function mountPanel(d: any, onChanged: () => void = vi.fn(), other?: Handler, opts: Parameters<typeof serve>[2] = {}) {
  const fetchMock = serve(d.people, other, { scopeDefinitions: d.scopeDefinitions, ...opts })
  vi.stubGlobal('fetch', fetchMock)
  render(<PeopleAccessPanel data={d} onChanged={onChanged} />)
  await waitFor(() => expect(screen.queryByText('Loading people…')).toBeNull())
  return fetchMock
}

const openGrantFor = async (name: string) => {
  const row = screen.getByRole('button', { name: new RegExp(`^${name}`) }).closest('li')!
  await userEvent.click(within(row).getByRole('button', { name: new RegExp(`Grant policy to ${name}`) }))
}

describe('People & Access', () => {
  it('lists people collapsed, with granted / automatic / legacy counts and filter counts', async () => {
    await mountPanel(data)
    const jafar = screen.getByRole('button', { name: /^Jafar Admin, 4 active roles, expand/ })
    expect(jafar.getAttribute('aria-expanded')).toBe('false')
    const row = jafar.closest('li')!
    expect(within(row).getByText('1 granted')).toBeTruthy()
    expect(within(row).getByText('2 automatic')).toBeTruthy()
    expect(within(row).getByText('1 legacy')).toBeTruthy()
    expect(screen.queryByText('CRM User')).toBeNull()
    expect(screen.getByRole('button', { name: /^Everyone\s*6$/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /^With granted policies\s*1$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Temporary access\s*1$/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Inactive/ })).toBeNull()      // account status lives in More filters now
  })

  it('filters, searches and shows an empty state', async () => {
    await mountPanel(data)
    await userEvent.click(screen.getByRole('button', { name: /^With granted policies\s*1$/ }))
    expect(screen.getByRole('button', { name: /^Jafar Admin/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Siti Staff/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^Everyone\s*6$/ }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Search people' }), 'siti')
    await waitFor(() => expect(screen.getAllByRole('button', { name: /active roles?, expand$/ }).length).toBe(1))
    await userEvent.clear(screen.getByRole('textbox', { name: 'Search people' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Search people' }), 'nobody')
    expect(await screen.findByText(/No people match “nobody”/)).toBeTruthy()
  })

  it('separates granted, automatic and legacy access, grouped by module', async () => {
    await mountPanel(data)
    await userEvent.click(screen.getByRole('button', { name: /^Jafar Admin/ }))
    // Granted access is open, grouped by module.
    expect(screen.getByRole('button', { name: /^Granted access, 1, collapse/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Granted access: Supply Chain, 1 role, collapse/ })).toBeTruthy()
    expect(screen.getAllByText('Order Approver').length).toBeGreaterThan(0)
    // Automatic and legacy access start folded.
    const automatic = screen.getByRole('button', { name: /^Automatic access, 2, expand/ })
    expect(screen.queryByText('Employee Self-Service')).toBeNull()
    await userEvent.click(automatic)
    await userEvent.click(screen.getByRole('button', { name: /^Automatic access: HR & Payroll, 1 role, expand/ }))
    expect(screen.getAllByText('Employee Self-Service').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Managed by HR / User Management').length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('button', { name: /^Automatic access: Customer & Growth, 1 role/ }))
    expect(screen.getByText('Set up from the legacy role during migration')).toBeTruthy()
    // The legacy compatibility role is in its own section, not mixed with automatic access.
    expect(screen.queryByText('Legacy HQ')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^Legacy access, 1, expand/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Legacy access: Shared \/ Cross-module, 1 role/ }))
    expect(screen.getAllByText('Legacy HQ').length).toBeGreaterThan(0)
  })

  it('revoke keeps its audited call; automatic access explains the override first', async () => {
    const prompt = vi.fn(() => 'No longer approves orders')
    vi.stubGlobal('prompt', prompt)
    const onChanged = vi.fn()
    const fetchMock = await mountPanel(data, onChanged)
    await userEvent.click(screen.getByRole('button', { name: /^Jafar Admin/ }))
    await userEvent.click(screen.getByRole('button', { name: /Revoke Order Approver/ }))
    expect(fetchMock).toHaveBeenCalledWith('/api/security-access/assignments', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ action: 'revoke', assignmentId: 'a3', reason: 'No longer approves orders' }),
    }))
    expect(onChanged).toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: /^Automatic access, 2/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Automatic access: HR & Payroll/ }))
    await userEvent.click(screen.getByRole('button', { name: /Revoke Employee Self-Service/ }))
    expect(prompt).toHaveBeenLastCalledWith(expect.stringMatching(/automatic access \(Managed by HR \/ User Management\).*will not be re-added/))
    expect(fetchMock).toHaveBeenCalledWith('/api/security-access/assignments', expect.objectContaining({
      body: JSON.stringify({ action: 'revoke', assignmentId: 'a5', reason: 'No longer approves orders' }),
    }))
  })

  it('offers restore only for automatic access an administrator revoked', async () => {
    vi.stubGlobal('prompt', vi.fn(() => 'Revoked by mistake'))
    const onChanged = vi.fn()
    const restorable = {
      ...data,
      restorableAssignmentIds: ['a9'],
      people: data.people.map((p: any) => p.id !== 'u1' ? p : { ...p, membership: p.membership.map((m: any) => ({
        ...m, assignments: [...m.assignments,
          assignment('a9', 'r-legacy', 'manual', { status: 'revoked', role: { ...role('r-legacy'), id: 'r-legacy-2', name: 'Legacy Manager' } }),
          assignment('a8', 'r-gl', 'manual', { status: 'revoked' })],
      })) }),
    }
    const fetchMock = await mountPanel(restorable, onChanged)
    await userEvent.click(screen.getByRole('button', { name: /^Jafar Admin/ }))
    // The revoked manual grant is not restorable (grant it again instead).
    expect(screen.queryByRole('button', { name: /Restore GL Clerk/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^Legacy access, 2, expand/ }))
    for (const group of screen.getAllByRole('button', { name: /^Legacy access: .*expand/ })) await userEvent.click(group)
    expect(screen.getByText('Automatic access revoked by an administrator')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Revoke Legacy Manager/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Restore Legacy Manager/ }))
    expect(fetchMock).toHaveBeenCalledWith('/api/security-access/assignments', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ action: 'restore', assignmentId: 'a9', reason: 'Revoked by mistake' }),
    }))
    expect(onChanged).toHaveBeenCalled()
  })

  it('"Grant policy" keeps the person selected, scrolls the form heading into view and focuses it; searching does not scroll', async () => {
    const scroll = vi.fn(); Element.prototype.scrollIntoView = scroll
    await mountPanel(data)
    await userEvent.type(screen.getByRole('textbox', { name: 'Search people' }), 'Siti')
    await waitFor(() => expect(screen.getByRole('button', { name: /^Siti Staff/ })).toBeTruthy())
    expect(scroll).not.toHaveBeenCalled()
    await openGrantFor('Siti Staff')
    const heading = screen.getByRole('heading', { name: 'Grant a Group Policy' })
    await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1))
    expect(scroll.mock.instances[0]).toBe(heading)
    expect(document.activeElement).toBe(heading)
    expect(screen.getAllByText(/Siti Staff/).length).toBeGreaterThan(0) // person still selected
    expect(heading.className).toContain('scroll-mt-') // clears a sticky header
  })

  it('profile-first: the chosen profile is preselected, held profiles read "Already held", and inapplicable memberships are not selectable', async () => {
    const intent = { roleId: 'r-crm', roleName: 'CRM User', orgTypes: ['HQ'], nonce: 1 }
    const d = { ...data, people: data.people.map(p => p.id === 'u4' ? { ...p, membership: p.membership.map((m: any) => ({ ...m, organization: { org_type_code: m.organization_id === HQ ? 'HQ' : 'DIST' } })) } : p) }
    const fetchMock = serve(d.people)
    vi.stubGlobal('fetch', fetchMock)
    render(<PeopleAccessPanel data={d} onChanged={vi.fn()} grantIntent={intent} />)
    await screen.findByText(/Assigning the policy/)
    expect(screen.getByRole('note').textContent).toMatch(/CRM User/)
    expect(screen.getByRole('combobox', { name: 'Group Policy' }).textContent).toMatch(/CRM User/)
    await userEvent.click(screen.getByRole('combobox', { name: 'Person' }))
    await userEvent.click(await screen.findByRole('option', { name: /Dina Dual/ }))
    expect(screen.getByRole('combobox', { name: 'Group Policy' }).textContent).toMatch(/CRM User/) // survives choosing a person
    await userEvent.click(screen.getByRole('combobox', { name: 'Membership organization' }))
    expect(screen.getByRole('option', { name: /North Distributor/ }).getAttribute('aria-disabled')).toBe('true')
    expect((screen.getByRole('button', { name: /^Grant access$/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(fetchMock.mock.calls.some(c => c[1]?.method === 'POST' && JSON.parse(c[1].body).action !== 'preflight')).toBe(false) // nothing granted by opening (a read-only preflight may run)
  })

  it('shows a role the person already holds as "Already held" and never lets it be granted twice', async () => {
    await mountPanel(data)
    await openGrantFor('Jafar Admin')
    await userEvent.click(screen.getByRole('combobox', { name: 'Group Policy' }))
    // CRM User is held automatically (backfill) and Order Approver is granted: both explained, neither selectable.
    const crm = screen.getByRole('option', { name: /CRM User/ })
    expect(crm.getAttribute('aria-disabled')).toBe('true')
    expect(crm.textContent).toMatch(/Already held — automatic access/)
    const order = screen.getByRole('option', { name: /Order Approver/ })
    expect(order.getAttribute('aria-disabled')).toBe('true')
    expect(order.textContent).toMatch(/Already held — granted by an administrator/)
    expect(screen.getByRole('option', { name: /GL Clerk/ }).getAttribute('aria-disabled')).not.toBe('true')
  })

  it('keeps the grant form closed until asked for; one membership is selected for you', async () => {
    await mountPanel(data)
    expect(screen.queryByText('Group Policy')).toBeNull()
    await openGrantFor('Siti Staff')
    expect(screen.getByText('Group Policy')).toBeTruthy()
    expect(screen.getByText(/Their only active membership — selected for you/)).toBeTruthy()
    const membership = screen.getByRole('combobox', { name: 'Membership organization' })
    expect(membership.textContent).toContain('Serapod HQ')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByText('Group Policy')).toBeNull()
  })

  it('offers only the policies eligible for the chosen MEMBERSHIP organization type and recalculates on a membership change', async () => {
    const ordering = { id: 'r-ordering', role_key: 'order-creator', name: 'Order Creator', source: 'template', status: 'active', applicable_org_types: ['HQ', 'DIST', 'SHOP'], permissions: perms('supply_chain.order.create') }
    await mountPanel({ ...data, roles: [...ROLES, ordering] })
    await openGrantFor('Dina Dual')
    await userEvent.click(screen.getByRole('combobox', { name: 'Membership organization' }))
    await userEvent.click(screen.getByRole('option', { name: /North Distributor/ }))
    // Module only lists modules that still have an eligible policy for a Distributor.
    const moduleSelect = screen.getByRole('combobox', { name: 'Module filter' }) as HTMLSelectElement
    expect(Array.from(moduleSelect.options).map(o => o.text)).toEqual(['All modules', 'Supply Chain'])
    await userEvent.click(screen.getByRole('combobox', { name: 'Group Policy' }))
    expect(screen.getByRole('option', { name: /Order Creator/ })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /GL Clerk/ })).toBeNull()        // HQ-only: not offered to a Distributor membership
    expect(screen.queryByRole('option', { name: /Order Approver/ })).toBeNull()
    expect(screen.getByTestId('ineligible-policies').textContent).toMatch(/Group Policies are not available for Distributor accounts/)
    // The same person's HQ membership: HQ policies are offered again (judged per membership, not per person or grantor).
    await userEvent.click(screen.getByRole('combobox', { name: 'Membership organization' }))
    await userEvent.click(screen.getByRole('option', { name: /Serapod HQ/ }))
    await userEvent.click(screen.getByRole('combobox', { name: 'Group Policy' }))
    expect(screen.getByRole('option', { name: /GL Clerk/ })).toBeTruthy()
  })

  it('requires a choice with several memberships and explains when there are none', async () => {
    await mountPanel(data)
    await openGrantFor('Dina Dual')
    expect(screen.getByText(/2 active memberships — choose the one/)).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Membership organization' }).textContent).not.toContain('Serapod HQ')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))

    // A suspended membership is not eligible and nothing defaults to HQ.
    await userEvent.click(screen.getByRole('button', { name: 'Grant access' }))
    expect(screen.queryByRole('option', { name: /Me Myself/ })).toBeNull()
  })

  it('module only filters the policy list and clears a policy it no longer offers', async () => {
    await mountPanel(data)
    await openGrantFor('Siti Staff')
    const moduleSelect = screen.getByRole('combobox', { name: 'Module filter' }) as HTMLSelectElement
    // Only modules that have grantable roles are offered; legacy roles are never grantable.
    expect(Array.from(moduleSelect.options).map(o => o.text)).toEqual(['All modules', 'Supply Chain', 'Customer & Growth', 'HR & Payroll', 'Finance', 'Shared / Cross-module'])
    await userEvent.selectOptions(moduleSelect, 'finance')
    const roleBox = screen.getByRole('combobox', { name: 'Group Policy' })
    await userEvent.click(roleBox)
    // Finance shows its own roles and the cross-module role that touches Finance.
    expect(screen.getByRole('option', { name: /GL Clerk/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /Payroll Finance Approver/ })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /Order Approver/ })).toBeNull()
    await userEvent.click(screen.getByRole('option', { name: /GL Clerk/ }))
    expect(roleBox.textContent).toContain('GL Clerk')
    // Switching to a module without that role clears it, so a hidden role is never submitted.
    await userEvent.selectOptions(moduleSelect, 'supply_chain')
    expect(screen.getByRole('combobox', { name: 'Group Policy' }).textContent).not.toContain('GL Clerk')
    const submit = screen.getAllByRole('button', { name: 'Grant access' }).find(b => b.closest('section')?.textContent?.includes('Add note (optional)'))!
    expect((submit as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('People & Access across organizations (server-side directory)', () => {
  const MFG = 'org-mfg'
  const mfgOrg = { organization_id: MFG, org_name: 'Manu Manufacturing', org_type_code: 'MFG', people_count: 2 }
  const hqOrg = { organization_id: HQ, org_name: 'Serapod HQ', org_type_code: 'HQ', people_count: 40 }
  const manu = { id: 'manu', full_name: 'Manu Operator', email: 'manu@dev.com', role_code: 'MFG_USER', is_active: true, organization_id: MFG,
    organization: { org_name: 'Manu Manufacturing', org_type_code: 'MFG' },
    membership: [{ id: 'mm', organization_id: MFG, status: 'active', is_primary: true, grantable: true, organization: { org_name: 'Manu Manufacturing', org_type_code: 'MFG' }, assignments: [] }] }
  const nomem = { id: 'nm', full_name: 'No Membership', email: 'nomem@dev.com', role_code: 'MFG_USER', is_active: true, organization_id: MFG,
    organization: { org_name: 'Manu Manufacturing', org_type_code: 'MFG' }, membership: [] }
  const viewOnly = { id: 'vo', full_name: 'View Only', email: 'vo@dev.com', role_code: 'USER', is_active: true, organization_id: DIST,
    organization: { org_name: 'North Distributor', org_type_code: 'DIST' },
    membership: [{ id: 'mvo', organization_id: DIST, organization: DIST_ORG, status: 'active', is_primary: true, grantable: false, grant_blocked_reason: 'not_authorized', organization: { org_name: 'North Distributor', org_type_code: 'DIST' }, assignments: [] }] }
  const hq = (n: number): any => ({ id: `hq${n}`, full_name: `Bulk Person ${String(n).padStart(3, '0')}`, email: `bulk${n}@dev.com`, role_code: 'USER', is_active: true, organization_id: HQ,
    organization: { org_name: 'Serapod HQ', org_type_code: 'HQ' }, membership: [{ id: `mh${n}`, organization_id: HQ, organization: HQ_ORG, status: 'active', is_primary: true, grantable: true, organization: { org_name: 'Serapod HQ', org_type_code: 'HQ' }, assignments: [] }] })
  const base = { viewerId: 'viewer', organizations: [], roles: ROLES, scopeDefinitions: [{ id: 'scope-mfg', organization_id: MFG, scope_type: 'organization', display_name: 'Manu Manufacturing' }] }

  it('finds a manufacturer user by email on the server and shows organization and type distinctly from internal staff', async () => {
    const requests: string[] = []
    const people = [...Array.from({ length: 40 }, (_, i) => hq(i)), manu, nomem]
    await mountPanel({ ...base, people }, vi.fn(), undefined, { organizations: [hqOrg, mfgOrg], requests })
    expect(requests[0]).toMatch(/q=&filter=all&offset=0&limit=25/)
    await userEvent.type(screen.getByRole('textbox', { name: 'Search people' }), 'manu@dev')
    const row = (await screen.findByRole('button', { name: /^Manu Operator/ })).closest('li')!
    expect(requests.some(r => r.includes('q=manu%40dev'))).toBe(true)   // server-side search, not a local filter
    expect(within(row).getByText('Manu Manufacturing')).toBeTruthy()
    expect(within(row).getByText('Manufacturer')).toBeTruthy()
    expect(within(row).getByText('Partner')).toBeTruthy()
    expect(screen.queryByText(/Bulk Person/)).toBeNull()
  })

  it('does not silently truncate: counts reflect the whole scope and "Show more" loads the next server page', async () => {
    const requests: string[] = []
    const people = Array.from({ length: 60 }, (_, i) => hq(i))
    await mountPanel({ ...base, people }, vi.fn(), undefined, { organizations: [hqOrg], requests })
    expect(screen.getByRole('button', { name: /^Everyone\s*60$/ })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /active roles?, expand$/ }).length).toBe(25)
    await userEvent.click(screen.getByRole('button', { name: /Show more/ }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: /active roles?, expand$/ }).length).toBe(50))
    expect(requests.at(-1)).toContain('offset=25')
  })

  it('organization filter narrows the server query and keeps the existing People filters and counts', async () => {
    const requests: string[] = []
    await mountPanel({ ...base, people: [hq(1), manu, nomem] }, vi.fn(), undefined, { organizations: [hqOrg, mfgOrg], requests })
    expect(screen.getByRole('button', { name: /^Everyone\s*3$/ })).toBeTruthy()
    await userEvent.click(screen.getByRole('combobox', { name: 'Organization' }))
    expect(screen.getByRole('option', { name: /All authorized organizations/ })).toBeTruthy()
    await userEvent.click(screen.getByRole('option', { name: /Manu Manufacturing/ }))
    await waitFor(() => expect(requests.at(-1)).toContain(`org=${MFG}`))
    expect(await screen.findByRole('button', { name: /^Everyone\s*2$/ })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'About these counts' }))
    expect(screen.getByRole('dialog', { name: 'About these counts' }).textContent).toMatch(/Counts cover Manu Manufacturing/)
    await userEvent.click(screen.getByRole('button', { name: /More filters/ }))
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Business membership' }), 'none')
    await waitFor(() => expect(screen.getAllByRole('button', { name: /active roles?, expand$/ }).length).toBe(1))
    expect(screen.getByRole('button', { name: /^No Membership/ })).toBeTruthy()
  })

  it('missing membership is neutral: no warning in the row, a short explanation on demand, Grant stays unavailable', async () => {
    await mountPanel({ ...base, people: [manu, nomem] }, vi.fn(), undefined, { organizations: [mfgOrg] })
    const row = within(screen.getByRole('button', { name: /^No Membership/ }).closest('li')!)
    expect(row.queryByRole('button', { name: /^Grant policy/ })).toBeNull()
    expect(row.queryByText(/nothing can be granted until HR/i)).toBeNull()
    expect(row.queryByText(/Cannot grant/)).toBeNull()
    expect(row.queryByRole('alert')).toBeNull()                         // never an error
    const why = row.getByRole('button', { name: /Why Grant policy is unavailable for No Membership/ })
    expect(why.getAttribute('aria-expanded')).toBe('false')
    expect(row.queryByText(/An active business membership is required/)).toBeNull()
    why.focus()                                                          // keyboard focus opens the ⓘ popover
    await waitFor(() => expect(why.getAttribute('aria-expanded')).toBe('true'))
    expect(row.getByRole('dialog').textContent).toBe('An active business membership is required to assign an Group Policy.')
    expect(why.getAttribute('aria-controls')).toBe(row.getByRole('dialog').id)
    await userEvent.keyboard('{Escape}')
    expect(row.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: /^No Membership/ }).getAttribute('aria-expanded')).toBe('false') // never toggles the row
  })

  it('details show a short neutral label and make no claim about other access', async () => {
    await mountPanel({ ...base, people: [nomem] }, vi.fn(), undefined, { organizations: [mfgOrg] })
    await userEvent.click(screen.getByRole('button', { name: /^No Membership/ }))
    expect(screen.getByText('No active business membership')).toBeTruthy()
    expect(screen.queryByText(/No additional S&A access/i)).toBeNull()
    expect(screen.queryByText(/consumer or not yet onboarded/)).toBeNull()
  })

  it('other blockers stay distinct: own row, inactive account, inactive membership, view-only authority', async () => {
    const inactiveAcct = { ...hq(1), id: 'ia', full_name: 'Inactive Account', is_active: false }
    const inactiveMem = { ...hq(2), id: 'im', full_name: 'Inactive Membership', membership: [{ id: 'x', organization_id: HQ, organization: HQ_ORG, status: 'inactive', is_primary: true, grantable: false, grant_blocked_reason: 'membership_not_active', organization: { org_name: 'Serapod HQ', org_type_code: 'HQ' }, assignments: [] }] }
    await mountPanel({ ...base, people: [viewOnly, inactiveAcct, inactiveMem, { ...hq(9), id: 'viewer', full_name: 'Me Myself' }] }, vi.fn(), undefined, { organizations: [mfgOrg] })
    const expectWhy = async (name: string, text: RegExp) => {
      const row = within(screen.getByRole('button', { name: new RegExp(`^${name}`) }).closest('li')!)
      await userEvent.click(row.getByRole('button', { name: /Why Grant policy is unavailable/ }))
      expect(row.getByRole('dialog').textContent).toMatch(text)
    }
    await expectWhy('Me Myself', /cannot grant access to yourself/)
    await expectWhy('Inactive Account', /account is inactive/)
    await expectWhy('Inactive Membership', /membership is not active\. An active business membership is required/)
    await expectWhy('View Only', /not authorized to grant access in their organization/)
  })

  it('offers the User Management link only for partner users, only when it exists for this administrator', async () => {
    const shop = { ...nomem, id: 'sh', full_name: 'Shop Person', principal_type: 'SHOP_STAFF', organization: { org_name: 'Corner Shop', org_type_code: 'SHOP' } }
    const consumer = { ...nomem, id: 'co', full_name: 'Consumer Person', principal_type: 'CONSUMER', organization: { org_name: 'Corner Shop', org_type_code: 'SHOP' }, organization_id: 'x' }
    for (const allowed of [true, false]) {
      await mountPanel({ ...base, people: [shop] }, vi.fn(), undefined, { organizations: [mfgOrg], userManagement: allowed })
      await userEvent.click(screen.getByRole('button', { name: /Why Grant policy is unavailable/ }))
      expect(!!screen.queryByRole('link', { name: 'User Management' })).toBe(allowed)
      expect(screen.getByRole('dialog').textContent).not.toMatch(/HR employee|enrol/i)
      cleanup()
    }
    await mountPanel({ ...base, people: [{ ...hq(3), id: 'st', full_name: 'Staff Person', membership: [] , principal_type: 'INTERNAL_EMPLOYEE' }] }, vi.fn(), undefined, { userManagement: true })
    await userEvent.click(screen.getByRole('button', { name: /Why Grant policy is unavailable/ }))
    expect(screen.queryByRole('link', { name: 'User Management' })).toBeNull()      // not offered for internal staff
    void consumer
  })

  it('a genuine request failure stays a visible error (not folded into the neutral explanations)', async () => {
    await mountPanel({ ...base, people: [] }, vi.fn(), undefined, { failDirectory: { status: 500, body: { error: 'The directory could not be loaded.', code: 'directory_failed' } } })
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be loaded/)
  })

  it('the grant form offers only grantable people (no self, no view-only, no membership-less)', async () => {
    await mountPanel({ ...base, people: [manu, nomem, viewOnly, { ...hq(9), id: 'viewer', full_name: 'Me Myself' }] }, vi.fn(), undefined, { organizations: [mfgOrg] })
    await userEvent.click(screen.getByRole('button', { name: 'Grant access' }))
    await userEvent.click(screen.getByRole('combobox', { name: 'Person' }))
    expect(await screen.findByRole('option', { name: /Manu Operator/ })).toBeTruthy()
    for (const name of [/No Membership/, /View Only/, /Me Myself/]) expect(screen.queryByRole('option', { name })).toBeNull()
  })

  it('shows clear error and empty states', async () => {
    await mountPanel({ ...base, people: [] }, vi.fn(), undefined, { failDirectory: { status: 403, body: { error: 'You are not authorized to view that organization.', code: 'org_forbidden' } } })
    expect((await screen.findByRole('alert')).textContent).toMatch(/not authorized to view that organization/)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    cleanup()
    await mountPanel({ ...base, people: [] })
    expect(await screen.findByText(/No people in all authorized organizations for this view/)).toBeTruthy()
  })

  it('falls back to the own-organization list and says why when the directory migration is missing', async () => {
    await mountPanel({ ...base, people: [hq(1)] }, vi.fn(), undefined, { failDirectory: { status: 409, body: { error: 'needs migration', code: 'directory_migration_missing' } } })
    expect(await screen.findByText(/20261005100000_sa_directory_visibility\.sql/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Bulk Person 001/ })).toBeTruthy()
  })

  describe('filters', () => {
    const org = (id: string, type: string) => ({ org_name: id, org_type_code: type })
    const person = (id: string, name: string, principal: string | null, type: string, extra: any = {}) => ({
      id, full_name: name, email: `${id}@dev.com`, role_code: 'GUEST', is_active: true, organization_id: `org-${type}`, principal_type: principal, organization: org(`org-${type}`, type),
      membership: [], ...extra })
    const mem = (type: string) => [{ id: `m-${type}`, organization_id: `org-${type}`, status: 'active', is_primary: true, grantable: true, organization: org(`org-${type}`, type), assignments: [] }]
    const people = [
      person('shopguest', 'Shop Guest', 'SHOP_STAFF', 'SHOP'),                       // a GUEST role code in a shop: shop staff, NOT a consumer
      person('consumer', 'Consumer Person', 'CONSUMER', 'SHOP'),
      person('manu', 'Manu Operator', 'MANUFACTURER_USER', 'MFG', { membership: mem('MFG') }),
      person('staff', 'Staff Member', 'INTERNAL_EMPLOYEE', 'HQ', { membership: mem('HQ') }),
      person('gone', 'Gone Person', 'INTERNAL_EMPLOYEE', 'HQ', { membership: mem('HQ'), is_active: false }),
      person('mystery', 'Mystery Person', null, 'HQ'),
    ]
    const orgs = [{ organization_id: 'org-SHOP', org_name: 'Corner Shop', org_type_code: 'SHOP', people_count: 2 }, { organization_id: 'org-MFG', org_name: 'Manu Manufacturing', org_type_code: 'MFG', people_count: 1 }, { organization_id: 'org-HQ', org_name: 'Serapod HQ', org_type_code: 'HQ', people_count: 3 }]
    const names = () => screen.queryAllByRole('button', { name: /active roles?, expand$/ }).map(b => b.getAttribute('aria-label')!.split(',')[0]).sort()
    const mountF = (requests: string[] = []) => mountPanel({ ...base, people }, vi.fn(), undefined, { organizations: orgs, requests })

    it('offers the identity categories (not a role-code guess), including an honest Unclassified', async () => {
      await mountF()
      const options = Array.from((screen.getByRole('combobox', { name: 'User category' }) as HTMLSelectElement).options).map(o => o.text)
      expect(options).toEqual(['All categories', 'Internal employee', 'Manufacturer user', 'Distributor user', 'Shop staff', 'Consumer', 'Unclassified'])
      const types = Array.from((screen.getByRole('combobox', { name: 'Organization type' }) as HTMLSelectElement).options).map(o => o.text)
      expect(types).toEqual(['All types', 'Headquarters', 'Manufacturer', 'Distributor', 'Warehouse', 'Shop'])
    })

    it('Shop GUEST and Consumer are different categories; unknown classification is not inferred from membership', async () => {
      await mountF()
      expect(names()).toHaveLength(6)                                                     // "All" = everyone in scope
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'User category' }), 'SHOP_STAFF')
      await waitFor(() => expect(names()).toEqual(['Shop Guest']))
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'User category' }), 'CONSUMER')
      await waitFor(() => expect(names()).toEqual(['Consumer Person']))
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'User category' }), 'UNCLASSIFIED')
      await waitFor(() => expect(names()).toEqual(['Mystery Person']))
      const row = screen.getByRole('button', { name: /^Mystery Person/ }).closest('li')!
      expect(within(row).getByText('Unclassified')).toBeTruthy()
    })

    it('combines filters server-side, keeps counts on the filter scope and resets paging', async () => {
      const requests: string[] = []
      await mountF(requests)
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Organization type' }), 'HQ')
      await userEvent.click(screen.getByRole('button', { name: /More filters/ }))
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Account status' }), 'active')
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Business membership' }), 'has')
      await waitFor(() => expect(names()).toEqual(['Staff Member']))
      const last = new URL(requests.at(-1)!, 'http://x').searchParams
      expect(Object.fromEntries(last)).toMatchObject({ orgType: 'HQ', status: 'active', membership: 'has', offset: '0' })
      expect(screen.getByRole('button', { name: /^Everyone\s*1$/ })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'About these counts' }))
    expect(screen.getByRole('dialog', { name: 'About these counts' }).textContent).toMatch(/Counts cover all authorized organizations with the category, type, organization, status and membership filters applied/)
    })

    it('incompatible selections are predictable: the organization list follows the type and a mismatch resets the organization', async () => {
      await mountF()
      await userEvent.click(screen.getByRole('combobox', { name: 'Organization' }))
      await userEvent.click(screen.getByRole('option', { name: /Corner Shop/ }))
      await waitFor(() => expect(names()).toEqual(['Consumer Person', 'Shop Guest']))
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Organization type' }), 'MFG')   // another type: organization resets
      await waitFor(() => expect(names()).toEqual(['Manu Operator']))
      await userEvent.click(screen.getByRole('combobox', { name: 'Organization' }))
      expect(screen.queryByRole('option', { name: /Corner Shop/ })).toBeNull()
      expect(screen.getByRole('option', { name: /Manu Manufacturing/ })).toBeTruthy()
      await userEvent.keyboard('{Escape}')
      // a category that cannot occur in this type is simply empty, with a way out
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'User category' }), 'CONSUMER')
      expect(await screen.findByText(/No people match these filters in all authorized organizations/)).toBeTruthy()
    })

    it('Clear filters restores the defaults and the full scope', async () => {
      const requests: string[] = []
      await mountF(requests)
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'User category' }), 'CONSUMER')
      await waitFor(() => expect(names()).toEqual(['Consumer Person']))
      await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
      await waitFor(() => expect(names()).toHaveLength(6))
      expect((screen.getByRole('combobox', { name: 'User category' }) as HTMLSelectElement).value).toBe('')
      expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()
      expect(new URL(requests.at(-1)!, 'http://x').searchParams.has('category')).toBe(false)
    })
  })
})

describe('People & Access redesign: presentation of memberships, status and history', () => {
  const longOrg = 'Persatuan Pengedar Barangan Runcit Dan Pengeluar Makanan Bersekutu Sdn Bhd (Cawangan Utara)'
  const past = '2020-01-01T00:00:00Z'
  const fixture = {
    ...data,
    organizations: [...data.organizations, { id: 'org-long', org_name: longOrg }],
    scopeDefinitions: [
      { id: 'own-hq', organization_id: HQ, scope_type: 'own_record', display_name: 'Own record' },
      { id: 'own-dist', organization_id: DIST, scope_type: 'own_record', display_name: 'Own record' },
    ],
    people: [{
      id: 'u9', full_name: 'Averyveryverylongname Withalongsurname', email: 'averyveryverylongemailaddress.for.layout@subdomain.example-company-name.test', role_code: 'HQ', principal_type: 'INTERNAL_EMPLOYEE', is_active: true,
      membership: [
        { id: 'mA', organization_id: HQ, organization: HQ_ORG, status: 'active', is_primary: true, organization: { org_name: 'Serapod HQ', org_type_code: 'HQ' }, assignments: [
          assignment('g1', 'r-order', 'manual', { scopes: [{ scope: { id: 'own-hq', display_name: 'Own record' } }] }),
          assignment('g2', 'r-gl', 'manual', { status: 'revoked', effective_until: '2026-10-01T10:00:00Z' }),
          assignment('g3', 'r-crm', 'access_request', { effective_until: past }),
          assignment('g4', 'r-pfa', 'manual', { effective_until: '2099-01-01T00:00:00Z' }),
        ] },
        { id: 'mB', organization_id: DIST, organization: DIST_ORG, status: 'suspended', is_primary: false, organization: { org_name: longOrg, org_type_code: 'DIST' }, assignments: [] },
      ],
    }],
  }

  it('shows each membership with its own organization, type, status and Primary; legacy role sits in the primary membership panel', async () => {
    await mountPanel(fixture)
    await userEvent.click(screen.getByRole('button', { name: /^Averyvery/ }))
    const headerOf = (org: string) => within(within(screen.getByRole('region', { name: `Membership: ${org}` })).getByRole('heading', { name: org }).parentElement!.parentElement!)
    const primary = headerOf('Serapod HQ')
    expect(primary.getByText('Headquarters')).toBeTruthy()
    expect(primary.getByText('Active')).toBeTruthy()
    expect(primary.getByText('Primary')).toBeTruthy()
    expect(primary.getByText('Legacy role: HQ')).toBeTruthy()
    const second = headerOf(longOrg)
    expect(second.getByText('Distributor')).toBeTruthy()
    expect(second.getByText('Suspended')).toBeTruthy()
    expect(second.queryByText('Primary')).toBeNull()
    expect(second.queryByText(/Legacy role/)).toBeNull()
    expect(screen.getAllByText(/Legacy role:/)).toHaveLength(1)
  })

  it('shows only current grants by default and keeps revoked/expired grants in a folded Access history', async () => {
    await mountPanel(fixture)
    await userEvent.click(screen.getByRole('button', { name: /^Averyvery/ }))
    // The default Granted access list is current (in-window active) grants only.
    expect(screen.getByText(/2 active · \d+ modules?/)).toBeTruthy()
    const rowOf = (name: string) => within(screen.getAllByText(name)[0].closest('li')!)
    expect(rowOf('Order Approver').getByText('Active')).toBeTruthy()
    expect(rowOf('Payroll Finance Approver').getByText('Temporary')).toBeTruthy()
    expect(rowOf('Payroll Finance Approver').getByText(/^Until /)).toBeTruthy()
    for (const name of ['Order Approver', 'Payroll Finance Approver']) expect(rowOf(name).getByRole('button', { name: new RegExp(`Revoke ${name}`) })).toBeTruthy()
    // Revoked and expired grants are not mixed into the active list.
    expect(screen.queryByText('GL Clerk')).toBeNull()
    expect(screen.queryByText('CRM User')).toBeNull()
    // History loads its details only when opened.
    await userEvent.click(screen.getByRole('button', { name: /^Access history, 2, expand/ }))
    const hRow = (name: string) => within(screen.getAllByText(name)[0].closest('li')!)
    expect(hRow('GL Clerk').getByText('Revoked')).toBeTruthy()
    expect(hRow('GL Clerk').getByText(/^Ended /)).toBeTruthy()
    expect(hRow('CRM User').getByText('Expired')).toBeTruthy()   // status still "active" but its end date has passed
    expect(hRow('CRM User').getByText('Approved request')).toBeTruthy()
    for (const name of ['GL Clerk', 'CRM User']) expect(hRow(name).queryByRole('button', { name: /Revoke/ })).toBeNull()
  })

  it('uses the shared scope labels so repeated "Own record" scopes are told apart', async () => {
    await mountPanel(fixture)
    await userEvent.click(screen.getByRole('button', { name: /^Averyvery/ }))
    expect(screen.getByText('Own record · Serapod HQ')).toBeTruthy()
  })

  it('Revoke does not toggle the surrounding accordion and keeps the explicit single-entry wording', async () => {
    const prompt = vi.fn(() => '')
    vi.stubGlobal('prompt', prompt)
    await mountPanel(fixture)
    await userEvent.click(screen.getByRole('button', { name: /^Averyvery/ }))
    await userEvent.click(screen.getByRole('button', { name: /Revoke Order Approver/ }))
    expect(prompt).toHaveBeenCalledWith(expect.stringMatching(/Only this entry is revoked; other granted, automatic or legacy access stays/))
    expect(screen.getByRole('button', { name: /^Granted access, 2, collapse/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Access history, 2, expand/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Averyvery/ }).getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps multiple memberships visible in the row and the header Grant access button opens and closes the grant form', async () => {
    await mountPanel(fixture)
    const row = within(screen.getByRole('button', { name: /^Averyvery/ }).closest('li')!)
    expect(row.getByText('Serapod HQ')).toBeTruthy()
    expect(row.getByText('+1 more')).toBeTruthy()
    expect(row.getByText('Internal employee')).toBeTruthy()
    const header = screen.getByRole('button', { name: 'Grant access' })
    expect(header.getAttribute('aria-expanded')).toBe('false')
    await userEvent.click(header)
    expect(screen.getByRole('heading', { name: 'Grant a Group Policy' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('heading', { name: 'Grant a Group Policy' })).toBeNull()
  })

  it('an empty person shows no access sections and the summary stays honest', async () => {
    await mountPanel({ ...fixture, people: [fixture.people[0], { ...data.people[3] }] })
    const row = within(screen.getByRole('button', { name: /^Dina Dual/ }).closest('li')!)
    expect(row.getByText('0 granted')).toBeTruthy()
    expect(row.getByText('0 automatic')).toBeTruthy()
    expect(row.queryByText(/legacy$/)).toBeNull()
    expect(row.queryByText(/temporary$/)).toBeNull()
  })
})


describe('People & Access: revoke reconciles the active list and keeps history', () => {
  const future = '2099-01-01T00:00:00Z'
  const mkRole = (id: string, name: string, keys: string[]) => ({ id, name, source: 'template', status: 'active', applicable_org_types: ['HQ'], permissions: keys.map(k => ({ permission: { permission_key: k } })) })
  const mkAsg = (id: string, role: any, extra: any = {}) => ({ id, status: 'active', source: 'manual', effective_until: null, role, scopes: [{ scope: { display_name: 'Serapod HQ' } }], ...extra })
  const ORDER_APPROVER = mkRole('r-oa', 'Order Approver', ['supply_chain.order.approve'])
  const ORDER_VIEWER = mkRole('r-ov', 'Order Viewer', ['supply_chain.order.view'])
  const FUTURE_APPROVER = mkRole('r-fa', 'Future Approver', ['supply_chain.order.approve'])
  const EXTRA_ROLES = [ORDER_APPROVER, ORDER_VIEWER, FUTURE_APPROVER]
  const person = (assignments: any[]) => ({
    id: 'u20', full_name: 'Rohani Reconcile', email: 'rohani@example.test', role_code: 'HQ', principal_type: 'INTERNAL_EMPLOYEE', is_active: true,
    membership: [{ id: 'm20', organization_id: HQ, organization: HQ_ORG, status: 'active', is_primary: true, assignments }],
  })
  const world = (people: any[]) => ({ ...data, roles: [...data.roles, ...EXTRA_ROLES], people })
  const mutatingRevoke = (people: any[]): Handler => async (url, init) => {
    if (String(url).startsWith('/api/security-access/assignments') && init?.body) {
      const { action, assignmentId } = JSON.parse(init.body)
      if (action === 'revoke') for (const p of people) for (const m of (p.membership || [])) for (const a of (m.assignments || [])) if (a.id === assignmentId) a.status = 'revoked'
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }

  it('after revoking one grant, the other grant in the same module stays visible and the summary reconciles', async () => {
    const people = [person([mkAsg('oa1', ORDER_APPROVER), mkAsg('ov1', ORDER_VIEWER)])]
    vi.stubGlobal('prompt', vi.fn(() => 'No longer needed'))
    await mountPanel(world(people), vi.fn(), mutatingRevoke(people))
    await userEvent.click(screen.getByRole('button', { name: /^Rohani Reconcile/ }))
    expect(screen.getByRole('button', { name: /^Granted access: Supply Chain, 2 roles, collapse/ })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Revoke Order Approver/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Granted access: Supply Chain, 1 role, collapse/ })).toBeTruthy())
    expect(screen.getAllByText('Order Viewer').length).toBeGreaterThan(0)
    expect(screen.queryByText('Order Approver')).toBeNull()
    expect(screen.getByRole('button', { name: /^Access history, 1, expand/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Rohani Reconcile, 1 active role, collapse/ })).toBeTruthy()
  })

  it('removing the last grant drops the module heading, shows a concise empty state and keeps the person', async () => {
    const people = [person([mkAsg('oa1', ORDER_APPROVER)])]
    vi.stubGlobal('prompt', vi.fn(() => 'No longer needed'))
    await mountPanel(world(people), vi.fn(), mutatingRevoke(people))
    await userEvent.click(screen.getByRole('button', { name: /^Rohani Reconcile/ }))
    expect(screen.getByRole('button', { name: /^Granted access: Supply Chain, 1 role, collapse/ })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Revoke Order Approver/ }))
    await waitFor(() => expect(screen.getByText(/No active granted policies/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^Granted access: Supply Chain/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^Access history, 1, expand/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Rohani Reconcile, 0 active roles, collapse/ })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Membership: Serapod HQ' })).toBeTruthy()
  })

  it('a failed revoke leaves the grant visible and shows the error, never success', async () => {
    const people = [person([mkAsg('oa1', ORDER_APPROVER)])]
    const refuse: Handler = async (url, init) => {
      if (String(url).startsWith('/api/security-access/assignments') && init?.body) {
        return { ok: false, status: 409, json: async () => ({ error: 'Revoke refused by the database.', code: 'sa_revoke_failed' }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }
    vi.stubGlobal('prompt', vi.fn(() => 'Reason here'))
    await mountPanel(world(people), vi.fn(), refuse)
    await userEvent.click(screen.getByRole('button', { name: /^Rohani Reconcile/ }))
    await userEvent.click(screen.getByRole('button', { name: /Revoke Order Approver/ }))
    await screen.findByText('Revoke refused by the database.')
    expect(screen.getAllByText('Order Approver').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /Access history/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^Rohani Reconcile, 1 active role, collapse/ })).toBeTruthy()
  })

  it('keeps a future-start grant out of the active list as a discoverable Scheduled entry', async () => {
    const people = [person([mkAsg('fa1', FUTURE_APPROVER, { effective_from: future })])]
    await mountPanel(world(people))
    const row = within(screen.getByRole('button', { name: /^Rohani Reconcile, 0 active roles, expand/ }).closest('li')!)
    expect(row.getByText('0 granted')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /^Rohani Reconcile/ }))
    expect(screen.getByText(/No active granted policies/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /^Scheduled access, 1, expand/ }))
    const scheduledRow = within(screen.getAllByText('Future Approver')[0].closest('li')!)
    expect(scheduledRow.getByText('Scheduled')).toBeTruthy()
    expect(scheduledRow.getByText(/^Starts /)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Access history/ })).toBeNull()
  })
})


describe('Grant Policy: scope selection and existing grants', () => {
  const HQC = { id: 'scope-hq', organization_id: HQ, scope_type: 'organization', display_name: 'Serapod HQ', kind: 'hq', label: 'Serapod HQ — HQ and all its warehouses', coverage: 'HQ and all its warehouses' }
  const ALMA = { id: 'scope-alma', organization_id: 'wh-alma', scope_type: 'warehouse', display_name: 'Alma', kind: 'warehouse', label: 'Alma — this warehouse only', coverage: 'This warehouse only' }
  const BAL = { id: 'scope-bal', organization_id: 'wh-bal', scope_type: 'warehouse', display_name: 'Balakong', kind: 'warehouse', label: 'Balakong — this warehouse only', coverage: 'This warehouse only' }
  const scopeBox = () => screen.getByRole('combobox', { name: 'Scope' })

  it('selects the only valid scope for you, shows a concise label and keeps the long explanation in the ⓘ', async () => {
    await mountPanel(data, vi.fn(), undefined, { scopeChoices: [HQC] })
    await openGrantFor('Siti Staff')
    await waitFor(() => expect(scopeBox().textContent).toContain('Serapod HQ — HQ and all its warehouses'))
    expect(screen.getByText(/\(only option\)/)).toBeTruthy()
    expect(screen.queryByText(/Choose it explicitly/)).toBeNull()
    expect(screen.queryByText(/Only one scope is valid/)).toBeNull()                      // long text is not on the page
    await userEvent.click(screen.getByRole('button', { name: 'About scopes' }))
    expect(screen.getByText(/Only one scope is valid for this policy and membership/)).toBeTruthy()
  })

  it('offers the HQ and each warehouse, selects none of them, and clears a warehouse the next policy cannot use', async () => {
    await mountPanel(data, vi.fn(), undefined, { scopeChoices: [HQC, ALMA, BAL] })
    await openGrantFor('Siti Staff')
    await waitFor(() => expect(scopeBox().hasAttribute('disabled')).toBe(false))
    expect(scopeBox().textContent).not.toContain('Alma')                                  // several valid scopes: the admin chooses
    await userEvent.click(scopeBox())
    expect(screen.getAllByRole('option', { name: /HQ and all its warehouses|this warehouse only/ }).map(o => o.textContent?.split(/(?<=only|warehouses)/)[0])).toEqual(['Serapod HQ — HQ and all its warehouses', 'Alma — this warehouse only', 'Balakong — this warehouse only'])
    await userEvent.click(screen.getByRole('option', { name: /Alma/ }))
    await userEvent.click(screen.getByRole('combobox', { name: 'Group Policy' }))
    await userEvent.click(screen.getByRole('option', { name: /GL Clerk/ }))              // Finance-only: no warehouse can limit it
    await waitFor(() => expect(scopeBox().textContent).toContain('HQ and all its warehouses'))   // only the HQ remains valid → selected, Alma cleared
    expect(scopeBox().textContent).not.toContain('Alma')
  })

  it('does not list a policy already granted for the whole HQ (a warehouse grant would add nothing); a narrower held grant stays listed as held', async () => {
    const hqScope = { scope: { id: 'scope-hq', scope_type: 'organization', scope_value: HQ, display_name: 'Serapod HQ' } }
    const almaScope = { scope: { id: 'scope-alma', scope_type: 'warehouse', scope_value: 'wh-alma', display_name: 'Alma' } }
    const held = { ...data.people[0], membership: [{ ...data.people[0].membership[0], organization: { org_name: 'Serapod HQ', org_type_code: 'HQ' }, assignments: [
      assignment('a3', 'r-order', 'manual', { scopes: [hqScope] }), assignment('a6', 'r-gl', 'manual', { scopes: [almaScope] })] }] }
    await mountPanel({ ...data, people: [held, ...data.people.slice(1)] }, vi.fn(), undefined, { scopeChoices: [HQC, ALMA] })
    await openGrantFor('Jafar Admin')
    await userEvent.click(screen.getByRole('combobox', { name: 'Group Policy' }))
    expect(screen.queryByRole('option', { name: /Order Approver/ })).toBeNull()
    expect(screen.getByText(/1 policy not listed: this person’s current access in this organization already includes every permission it holds/)).toBeTruthy()
    const gl = screen.getByRole('option', { name: /GL Clerk/ })
    expect(gl.getAttribute('aria-disabled')).toBe('true')
    expect(gl.textContent).toMatch(/Already held — granted by an administrator · Scope: Alma/)
  })
})

describe('Grant a Group Policy: optional note, preflight and guidance', () => {
  const HQC = { id: 'scope-hq', organization_id: HQ, scope_type: 'organization', display_name: 'Serapod HQ', kind: 'hq', label: 'Serapod HQ — HQ and all its warehouses', coverage: 'HQ and all its warehouses' }
  const posts = (fetchMock: any, action: string) => fetchMock.mock.calls.filter((c: any) => c[1]?.method === 'POST' && JSON.parse(c[1].body).action === action).map((c: any) => JSON.parse(c[1].body))
  const submitButton = () => screen.getAllByRole('button', { name: /^(Grant access|Granting…)$/ }).find(b => b.closest('section')?.textContent?.includes('Add note (optional)') || b.closest('section')?.textContent?.includes('Note (optional)'))! as HTMLButtonElement
  type Reply = { status: number; body: any }
  /** Fake assignments API: preflight and grant answers per test; replies may be deferred to test late responses. */
  const api = (preflight: (body: any) => Reply | Promise<Reply>, grant: (body: any) => Reply = () => ({ status: 200, body: { ok: true, assignmentId: 'new', noteRecorded: false } })) =>
    async (url: string, init: any) => {
      if (url !== '/api/security-access/assignments') return { ok: true, status: 200, json: async () => ({}) }
      const body = JSON.parse(init.body)
      const r = body.action === 'preflight' ? await preflight(body) : grant(body)
      return { ok: r.status < 400, status: r.status, json: async () => r.body }
    }
  const allowed = () => ({ status: 200, body: { ok: true, allowed: true, sensitiveChecked: true } })
  const chooseGl = async () => {
    await userEvent.click(screen.getByRole('combobox', { name: 'Group Policy' }))
    await userEvent.click(screen.getByRole('option', { name: /GL Clerk/ }))
  }

  it('an authorized administrator grants to another person WITHOUT a note: Grant access is enabled once the check passes', async () => {
    const onChanged = vi.fn()
    const fetchMock = await mountPanel(data, onChanged, api(allowed), { scopeChoices: [HQC] })
    await openGrantFor('Siti Staff')
    expect(screen.queryByRole('textbox', { name: /Reason/ })).toBeNull()                       // no mandatory reason any more
    expect(screen.getByText('Choose a Group Policy to continue.')).toBeTruthy()                  // concise, neutral
    expect(screen.queryByText(/You cannot grant access to yourself/)).toBeNull()               // generic guidance is not shown as an error
    await chooseGl()
    await waitFor(() => expect(submitButton().disabled).toBe(false))
    expect(screen.getByText(/Ready to grant/)).toBeTruthy()
    expect(posts(fetchMock, 'preflight')).toEqual([{ action: 'preflight', userId: 'u2', organizationId: HQ, roleId: 'r-gl', scopeIds: ['scope-hq'] }])
    await userEvent.click(submitButton())
    await waitFor(() => expect(screen.getByText(/Access granted to Siti Staff and recorded in the access change log\.$/)).toBeTruthy())
    const [grant] = posts(fetchMock, 'grant')
    // Same person, organization, policy and scope as the preflight; identity is the canonical user id.
    expect(grant).toEqual({ action: 'grant', userId: 'u2', organizationId: HQ, roleId: 'r-gl', scopeIds: ['scope-hq'], effectiveUntil: null, note: null })
    expect(onChanged).toHaveBeenCalled()
  })

  it('records an optional note when one is added', async () => {
    const fetchMock = await mountPanel(data, vi.fn(), api(allowed, () => ({ status: 200, body: { ok: true, assignmentId: 'new', noteRecorded: true } })), { scopeChoices: [HQC] })
    await openGrantFor('Siti Staff')
    await chooseGl()
    await userEvent.click(screen.getByRole('button', { name: 'Add note (optional)' }))
    await userEvent.type(screen.getByRole('textbox', { name: /Note \(optional\)/ }), '  Ticket SA-42  ')
    await waitFor(() => expect(submitButton().disabled).toBe(false))
    await userEvent.click(submitButton())
    await waitFor(() => expect(screen.getByText(/recorded in the access change log with your note/)).toBeTruthy())
    expect(posts(fetchMock, 'grant')[0].note).toBe('Ticket SA-42')
  })

  it('shows the actual reason when the server refuses this exact grant, and keeps Grant access disabled', async () => {
    const fetchMock = await mountPanel(data, vi.fn(), api(() => ({ status: 200, body: { ok: true, allowed: false, code: 'GRANT_BEYOND_AUTHORITY', reason: 'This policy includes sensitive permissions you do not hold in this organization, so you cannot grant it here.' } })), { scopeChoices: [HQC] })
    await openGrantFor('Siti Staff')
    await chooseGl()
    await screen.findByText(/sensitive permissions you do not hold/)
    expect(submitButton().disabled).toBe(true)
    expect(posts(fetchMock, 'grant')).toEqual([])
  })

  it('a failed check keeps the button unavailable and offers Retry', async () => {
    let fail = true
    await mountPanel(data, vi.fn(), api(() => fail ? { status: 503, body: { error: 'This grant could not be checked right now. Nothing was changed. Try again.', code: 'CATALOGUE_UNAVAILABLE' } } : allowed()), { scopeChoices: [HQC] })
    await openGrantFor('Siti Staff')
    await chooseGl()
    await screen.findByText(/could not be checked right now/)
    expect(submitButton().disabled).toBe(true)
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(submitButton().disabled).toBe(false))
  })

  it('losing the grant authority after opening the form reads as a denial, not as a failed check', async () => {
    await mountPanel(data, vi.fn(), api(() => ({ status: 403, body: { error: 'Forbidden', code: 'sa_forbidden' } })), { scopeChoices: [HQC] })
    await openGrantFor('Siti Staff')
    await chooseGl()
    await screen.findByText('You no longer hold the authority to assign Group Policies.')
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(submitButton().disabled).toBe(true)
  })

  it('changing the person drops the earlier check and ignores its late answer', async () => {
    const pending: Array<{ body: any; resolve: (r: Reply) => void }> = []
    const fetchMock = await mountPanel(data, vi.fn(), api(body => new Promise<Reply>(resolve => pending.push({ body, resolve }))), { scopeChoices: [HQC] })
    await openGrantFor('Siti Staff')
    await chooseGl()
    await waitFor(() => expect(pending.length).toBe(1))
    expect(screen.getByText('Checking this grant…')).toBeTruthy()
    expect(submitButton().disabled).toBe(true)                                                    // unavailable while pending
    // Switch to Jafar (same HQ membership) before Siti's answer arrives.
    await userEvent.click(screen.getByRole('combobox', { name: 'Person' }))
    await userEvent.click(await screen.findByRole('option', { name: /Jafar Admin/ }))
    await chooseGl()
    await waitFor(() => expect(pending.length).toBe(2))
    expect(pending[1].body.userId).toBe('u1')
    pending[0].resolve(allowed())                                                                  // late answer for Siti
    await new Promise(r => setTimeout(r, 20))
    expect(submitButton().disabled).toBe(true)
    expect(screen.getByText('Checking this grant…')).toBeTruthy()
    pending[1].resolve({ status: 200, body: { ok: true, allowed: false, code: 'SOD', reason: 'Denied for Jafar.' } })
    await screen.findByText('Denied for Jafar.')
    expect(posts(fetchMock, 'grant')).toEqual([])
  })

  it('a failed submission shows the error, never success, keeps the form and checks again', async () => {
    const onChanged = vi.fn()
    let checks = 0
    const fetchMock = await mountPanel(data, onChanged, api(() => { checks += 1; return allowed() }, () => ({ status: 409, body: { error: 'This conflicts with a segregation-of-duties rule.', code: 'sod_violation' } })), { scopeChoices: [HQC] })
    await openGrantFor('Siti Staff')
    await chooseGl()
    await waitFor(() => expect(submitButton().disabled).toBe(false))
    await userEvent.click(submitButton())
    await screen.findByText('This conflicts with a segregation-of-duties rule. Nothing was changed.')
    expect(screen.queryByText(/Access granted/)).toBeNull()
    expect(screen.getByRole('heading', { name: 'Grant a Group Policy' })).toBeTruthy()
    expect(onChanged).not.toHaveBeenCalled()
    await waitFor(() => expect(checks).toBe(2))
    expect(posts(fetchMock, 'grant')).toHaveLength(1)
  })

  it('the person picker never offers the signed-in administrator, and the general rules live in the ⓘ', async () => {
    await mountPanel(data, vi.fn(), api(allowed), { scopeChoices: [HQC] })
    await userEvent.click(screen.getByRole('button', { name: 'Grant access' }))
    await userEvent.click(screen.getByRole('combobox', { name: 'Person' }))
    expect(screen.queryByRole('option', { name: /Me Myself/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'About granting a Group Policy' }))
    expect(screen.getByText(/Nobody can grant access to themselves/)).toBeTruthy()
    expect(screen.getByText(/A note is optional/)).toBeTruthy()
  })
})

describe('Grant a Group Policy: existing Full Access coverage', () => {
  const hqScope = { scope: { id: 'scope-hq', scope_type: 'organization', scope_value: HQ, display_name: 'Serapod HQ' } }
  const distScope = { scope: { id: 'scope-dist', scope_type: 'organization', scope_value: DIST, display_name: 'North Distributor' } }
  const almaScope = { scope: { id: 'scope-alma', scope_type: 'warehouse', scope_value: 'wh-alma', display_name: 'Alma' } }
  const COV_ROLES = [
    ...ROLES,
    { id: 'r-fin-fa', role_key: 'finance-full-access', name: 'Finance Full Access', source: 'template', status: 'active', applicable_org_types: ['HQ'], permissions: perms('finance.module.view', 'finance.ledger.view', 'finance.payment.approve', 'finance.cash.prepare') },
    { id: 'r-bank', name: 'Bank Statement Preparer', source: 'template', status: 'active', applicable_org_types: ['HQ'], permissions: perms('finance.cash.prepare') },
    { id: 'r-sa-fa', role_key: 'security-access-full-access', name: 'Security & Access Full Access', source: 'template', status: 'active', applicable_org_types: ['HQ'], permissions: perms('security.access.manage', 'security.role.manage') },
    { id: 'r-plat-fa', role_key: 'platform-settings-full-access', name: 'Platform & Settings Full Access', source: 'template', status: 'active', applicable_org_types: ['HQ'], permissions: perms('platform.user.manage', 'platform.user.password_reset') },
    { id: 'r-pwd', name: 'User Password Administrator', source: 'template', status: 'active', applicable_org_types: ['HQ'], permissions: perms('platform.user.password_reset') },
    { id: 'r-hr-fa', role_key: 'hr-payroll-full-access', name: 'HR & Payroll Full Access', source: 'template', status: 'active', applicable_org_types: ['HQ'], permissions: perms('hr.payroll.approve', 'hr.self_service.use') },
    // A custom policy named like Full Access that holds a single permission.
    { id: 'r-fake', name: 'Supply Chain Full Access (custom)', source: 'template', status: 'active', applicable_org_types: ['HQ'], permissions: perms('supply_chain.order.view') },
  ]
  const g = (id: string, roleId: string, extra: any = {}) => {
    const r = COV_ROLES.find(x => x.id === roleId)!
    return { id, status: 'active', source: 'manual', effective_from: null, effective_until: null, role: { id: r.id, name: r.name, source: r.source }, scopes: [hqScope], ...extra }
  }
  const admin = (assignments: any[], extra: any[] = []) => ({ id: 'u7', full_name: 'Ada Admin', email: 'admin@dev.test', role_code: 'HQ', is_active: true,
    membership: [{ id: 'm7', organization_id: HQ, organization: HQ_ORG, status: 'active', is_primary: true, organization: { org_name: 'Serapod HQ', org_type_code: 'HQ' }, assignments }, ...extra] })
  const EXAMPLE = [g('b1', 'r-bank'), g('b2', 'r-sa-fa'), g('b3', 'r-pwd'), g('b4', 'r-plat-fa')]
  const world = (people: any[]) => ({ ...data, roles: COV_ROLES, people: [...people, ...data.people] })
  const moduleNames = () => Array.from((screen.getByRole('combobox', { name: 'Module filter' }) as HTMLSelectElement).options).map(o => o.textContent)
  const policyNames = async () => {
    await userEvent.click(screen.getByRole('combobox', { name: 'Group Policy' }))
    const names = screen.queryAllByRole('option').map(o => o.textContent || '')
    await userEvent.keyboard('{Escape}')
    return names
  }

  it('hides modules already covered by Full Access, keeps partial and unheld modules, and explains why', async () => {
    const fetchMock = await mountPanel(world([admin(EXAMPLE)]))
    await openGrantFor('Ada Admin')
    const mods = moduleNames()
    expect(mods).not.toContain('Security & Access')
    expect(mods).not.toContain('Platform & Settings')
    for (const m of ['All modules', 'Supply Chain', 'Customer & Growth', 'HR & Payroll', 'Finance', 'Shared / Cross-module']) expect(mods).toContain(m)
    expect(screen.getByText(/Some modules are unavailable because this person already has Full Access for the selected organization and scope\./)).toBeTruthy()
    expect(screen.getByText(/Not offered: Security & Access, Platform & Settings\./)).toBeTruthy()
    // Even with All modules: policies the existing access already contains are not offered; partial Finance ones are.
    const names = await policyNames()
    for (const hidden of ['Security & Access Full Access', 'Platform & Settings Full Access', 'User Password Administrator', 'Bank Statement Preparer']) expect(names.some(n => n.startsWith(hidden))).toBe(false)
    for (const kept of ['Finance Full Access', 'GL Clerk', 'Order Approver', 'Supply Chain Full Access (custom)']) expect(names.some(n => n.startsWith(kept))).toBe(true)
    // Viewing existing access only shows the summary; nothing is granted or revoked.
    await userEvent.click(screen.getByRole('button', { name: 'View existing access' }))
    expect((screen.getByRole('textbox', { name: 'Search people' }) as HTMLInputElement).value).toBe('admin@dev.test')
    await waitFor(() => expect(screen.getByRole('button', { name: /^Ada Admin/ }).getAttribute('aria-expanded')).toBe('true'))
    expect(fetchMock.mock.calls.some(c => c[1]?.method === 'POST' && ['grant', 'revoke', 'restore'].includes(JSON.parse(c[1].body).action))).toBe(false)
  })

  it('partial access never hides a module, and a similarly named custom policy is not Full Access', async () => {
    await mountPanel(world([admin([g('b1', 'r-bank'), g('b5', 'r-fake')])]))
    await openGrantFor('Ada Admin')
    expect(moduleNames()).toEqual(expect.arrayContaining(['Finance', 'Supply Chain']))
    expect(screen.queryByText(/Some modules are unavailable/)).toBeNull()
  })

  it('revoked, expired or future-start Full Access leaves the module available', async () => {
    for (const extra of [{ status: 'revoked' }, { status: 'expired' }, { effective_until: '2020-01-01T00:00:00Z' }, { effective_from: '2099-01-01T00:00:00Z' }]) {
      await mountPanel(world([admin([g('b2', 'r-sa-fa', extra)])]))
      await openGrantFor('Ada Admin')
      expect(moduleNames()).toContain('Security & Access')
      expect(screen.queryByText(/Some modules are unavailable/)).toBeNull()
      cleanup()
    }
  })

  it('evaluates several Full Access grants together (a cross-module policy is hidden only when both modules are covered)', async () => {
    await mountPanel(world([admin([g('b7', 'r-fin-fa')])]))
    await openGrantFor('Ada Admin')
    expect(moduleNames()).not.toContain('Finance')
    expect((await policyNames()).some(n => n.startsWith('Payroll Finance Approver'))).toBe(true)
    cleanup()
    await mountPanel(world([admin([g('b7', 'r-fin-fa'), g('b8', 'r-hr-fa')])]))
    await openGrantFor('Ada Admin')
    expect(moduleNames()).not.toContain('Finance')
    expect(moduleNames()).not.toContain('HR & Payroll')
    expect((await policyNames()).some(n => n.startsWith('Payroll Finance Approver'))).toBe(false)
  })

  it('scope-limited Full Access does not hide the module for a wider scope or another organization', async () => {
    // Warehouse-only Full Access: an HQ-wide grant would still add access.
    await mountPanel(world([admin([g('b2', 'r-sa-fa', { scopes: [almaScope] })])]))
    await openGrantFor('Ada Admin')
    expect(moduleNames()).toContain('Security & Access')
    cleanup()
    // Full Access on the Distributor membership only: offered for HQ, hidden for the Distributor.
    const dual = admin([], [{ id: 'm7b', organization_id: DIST, organization: DIST_ORG, status: 'active', is_primary: false, organization: { org_name: 'North Distributor', org_type_code: 'DIST' }, assignments: [g('b9', 'r-sa-fa', { scopes: [distScope] })] }])
    await mountPanel(world([dual]))
    await openGrantFor('Ada Admin')
    await userEvent.click(screen.getByRole('combobox', { name: 'Membership organization' }))
    await userEvent.click(screen.getByRole('option', { name: /Serapod HQ/ }))
    expect(moduleNames()).toContain('Security & Access')
    await userEvent.click(screen.getByRole('combobox', { name: 'Membership organization' }))
    await userEvent.click(screen.getByRole('option', { name: /North Distributor/ }))
    expect(moduleNames()).not.toContain('Security & Access')
  })

  it('switching the person recalculates the modules and resets a module that is no longer offered', async () => {
    await mountPanel(world([admin(EXAMPLE)]))
    await openGrantFor('Siti Staff')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Module filter' }), 'security_access')
    expect((screen.getByRole('combobox', { name: 'Module filter' }) as HTMLSelectElement).value).toBe('security_access')
    await userEvent.click(screen.getByRole('combobox', { name: 'Person' }))
    await userEvent.click(await screen.findByRole('option', { name: /Ada Admin/ }))
    await waitFor(() => expect(moduleNames()).not.toContain('Security & Access'))
    expect((screen.getByRole('combobox', { name: 'Module filter' }) as HTMLSelectElement).value).toBe('all')
    await userEvent.click(screen.getByRole('combobox', { name: 'Person' }))
    await userEvent.click(await screen.findByRole('option', { name: /Siti Staff/ }))
    await waitFor(() => expect(moduleNames()).toContain('Security & Access'))
  })

  it('after a revoke the module is offered again without a page reload, and the Group Policy and Scope selectors keep working', async () => {
    vi.stubGlobal('prompt', vi.fn(() => 'No longer administers access'))
    const person = admin(EXAMPLE)
    const revokeApi: Handler = (_url, init) => {
      const body = JSON.parse(init.body)
      if (body.action === 'revoke') { person.membership[0].assignments.find((a: any) => a.id === body.assignmentId)!.status = 'revoked'; return { ok: true, status: 200, json: async () => ({ ok: true }) } }
      return { ok: true, status: 200, json: async () => ({ ok: true, allowed: true }) }
    }
    await mountPanel(world([person]), vi.fn(), revokeApi)
    await openGrantFor('Ada Admin')
    expect(moduleNames()).not.toContain('Security & Access')
    await userEvent.click(screen.getByRole('button', { name: /^Ada Admin/ }))
    await userEvent.click(screen.getByRole('button', { name: /Revoke Security & Access Full Access/ }))
    await waitFor(() => expect(moduleNames()).toContain('Security & Access'))
    expect(moduleNames()).not.toContain('Platform & Settings')   // the other Full Access still applies
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Module filter' }), 'security_access')
    await userEvent.click(screen.getByRole('combobox', { name: 'Group Policy' }))
    await userEvent.click(screen.getByRole('option', { name: /Security & Access Full Access/ }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Scope' }).textContent).toContain('Serapod HQ'))
    // Only the revoked entry changed.
    expect(person.membership[0].assignments.filter((a: any) => a.status === 'active').map((a: any) => a.id)).toEqual(['b1', 'b3', 'b4'])
  })
})

describe('One-click Restore of a revoked Group Policy grant (Access history)', () => {
  const restoreStatus = (extra: any = {}) => ({ eligible: true, code: null, message: null, effectiveFrom: null, effectiveUntil: null, ...extra })
  /** Jafar (HQ) with one revoked administrator grant (GL Clerk) the server reports as restorable. */
  const world = (revoked: any, membership: any = {}) => ({
    ...data,
    people: data.people.map((p: any) => p.id !== 'u1' ? p : { ...p, membership: p.membership.map((m: any) => ({
      ...m, ...membership, assignments: [...m.assignments, revoked],
    })) }),
  })
  const openHistory = async () => {
    await userEvent.click(screen.getByRole('button', { name: /^Jafar Admin/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Access history, 1, expand/ }))
  }

  it('Restore → Confirm Restore creates a new grant: the dialog shows person, policy, organization, scope and validity, and the screen refreshes', async () => {
    const onChanged = vi.fn()
    const revoked = assignment('a8', 'r-gl', 'manual', { status: 'revoked', effective_until: '2026-10-01T00:00:00Z', restore: restoreStatus({ effectiveUntil: '2099-06-30T00:00:00Z' }) })
    const w = world(revoked)
    let release: () => void = () => {}
    const posts: any[] = []
    const fetchMock = await mountPanel(w, onChanged, async (url: string, init: any) => {
      if (url === '/api/security-access/assignments' && init?.method === 'POST') {
        posts.push(JSON.parse(init.body))
        await new Promise<void>(r => { release = r })
        // The server created a new active grant; the revoked entry stays.
        const m = w.people.find((p: any) => p.id === 'u1')!.membership[0]
        m.assignments.push(assignment('a8-new', 'r-gl', 'manual', { effective_until: '2099-06-30T00:00:00Z' }))
        return { ok: true, status: 200, json: async () => ({ ok: true, assignmentId: 'a8-new', restoredFrom: 'a8' }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    })
    await openHistory()
    expect(screen.queryByRole('button', { name: /Revoke GL Clerk/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^Restore GL Clerk/ }))
    const dialog = within(screen.getByRole('dialog', { name: 'Restore revoked access' }))
    expect(dialog.getByText('Jafar Admin')).toBeTruthy()
    expect(dialog.getByText('jafar@example.test')).toBeTruthy()
    expect(dialog.getByText('GL Clerk')).toBeTruthy()
    expect(dialog.getAllByText('Serapod HQ').length).toBe(2) // organization and data scope
    expect(dialog.getByText(/the original end date \(not extended\)/)).toBeTruthy()
    expect(dialog.getByText(/permissions apply, including any changes made since this access was revoked/)).toBeTruthy()

    const directoryCalls = () => fetchMock.mock.calls.filter(c => String(c[0]).startsWith('/api/security-access/people')).length
    const before = directoryCalls()
    await userEvent.click(dialog.getByRole('button', { name: 'Confirm Restore' }))
    // Processing: actions are disabled, a second click sends nothing.
    const busy = dialog.getByRole('button', { name: 'Restoring…' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect((dialog.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(busy)
    expect(posts).toEqual([{ action: 'restore_grant', assignmentId: 'a8' }])
    release()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText(/GL Clerk restored for Jafar Admin as a new grant\. The revoked entry stays in Access history\./)).toBeTruthy()
    expect(onChanged).toHaveBeenCalled()
    await waitFor(() => expect(directoryCalls()).toBeGreaterThan(before))
    // Granted access now lists the new grant; Access history still holds the revoked one.
    await waitFor(() => expect(screen.getByRole('button', { name: /Revoke GL Clerk/ })).toBeTruthy())
    expect(screen.getByText('Revoked')).toBeTruthy()
  })

  it('an ineligible revoked grant explains why instead of offering Restore (expired temporary grant → Grant Policy)', async () => {
    const revoked = assignment('a8', 'r-gl', 'manual', { status: 'revoked', restore: restoreStatus({ eligible: false, code: 'sa_restore_validity_expired',
      message: "This temporary grant's original end date has passed, and a restore never extends it. Use Grant Policy to grant it again." }) })
    const fetchMock = await mountPanel(world(revoked))
    await openHistory()
    expect(screen.queryByRole('button', { name: /^Restore GL Clerk/ })).toBeNull()
    expect(screen.getByText('Restore unavailable')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Why GL Clerk cannot be restored/ }))
    expect(screen.getByText(/original end date has passed.*Use Grant Policy/)).toBeTruthy()
    expect(fetchMock.mock.calls.some(c => c[1]?.method === 'POST')).toBe(false)
  })

  it('no Restore where the administrator may not grant (membership not grantable) or when the server sent no restore status', async () => {
    await mountPanel(world(assignment('a8', 'r-gl', 'manual', { status: 'revoked', restore: restoreStatus() }), { grantable: false }))
    await openHistory()
    expect(screen.queryByRole('button', { name: /^Restore GL Clerk/ })).toBeNull()
    cleanup()
    await mountPanel(world(assignment('a8', 'r-gl', 'manual', { status: 'revoked' })))
    await openHistory()
    expect(screen.queryByRole('button', { name: /^Restore GL Clerk/ })).toBeNull()
    expect(screen.queryByText('Restore unavailable')).toBeNull()
  })

  it('a refusal by the server is shown in the dialog and changes nothing', async () => {
    const onChanged = vi.fn()
    await mountPanel(world(assignment('a8', 'r-gl', 'manual', { status: 'revoked', restore: restoreStatus() })), onChanged, async (url: string, init: any) =>
      url === '/api/security-access/assignments' && init?.method === 'POST'
        ? { ok: false, status: 409, json: async () => ({ error: 'This person already holds this policy in this organization. Nothing was changed.', code: 'sa_role_already_held' }) }
        : { ok: true, status: 200, json: async () => ({}) })
    await openHistory()
    await userEvent.click(screen.getByRole('button', { name: /^Restore GL Clerk/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirm Restore' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/already holds this policy/)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(onChanged).not.toHaveBeenCalled()
  })
})
