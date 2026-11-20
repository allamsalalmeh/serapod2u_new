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

/** Revoke → reason → Confirm Revoke in the revoke dialog. */
const revokeWith = async (roleName: string, reason: string) => {
  await userEvent.click(screen.getByRole('button', { name: new RegExp(`Revoke ${roleName}`) }))
  const dialog = within(screen.getByRole('dialog', { name: 'Revoke access' }))
  await userEvent.type(dialog.getByRole('textbox', { name: /Reason for revoking/ }), reason)
  await userEvent.click(dialog.getByRole('button', { name: 'Confirm Revoke' }))
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
    expect(within(row).getByText('1 assigned')).toBeTruthy()
    expect(within(row).getByText('2 system-assigned')).toBeTruthy()
    expect(within(row).getByText('1 legacy-based')).toBeTruthy()
    expect(screen.queryByText('CRM User')).toBeNull()
    expect(screen.getByRole('button', { name: /^Everyone\s*6$/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: /^With assigned policies\s*1$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Temporary access\s*1$/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Inactive/ })).toBeNull()      // account status lives in More filters now
  })

  it('filters, searches and shows an empty state', async () => {
    await mountPanel(data)
    await userEvent.click(screen.getByRole('button', { name: /^With assigned policies\s*1$/ }))
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
    // Assigned policies is open, grouped by module.
    expect(screen.getByRole('button', { name: /^Assigned policies, 1, collapse/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Assigned policies: Supply Chain, 1 role, collapse/ })).toBeTruthy()
    expect(screen.getAllByText('Order Approver').length).toBeGreaterThan(0)
    // Automatic and legacy access start folded.
    const automatic = screen.getByRole('button', { name: /^System-assigned access, 2, expand/ })
    expect(screen.queryByText('Employee Self-Service')).toBeNull()
    await userEvent.click(automatic)
    await userEvent.click(screen.getByRole('button', { name: /^System-assigned access: HR & Payroll, 1 role, expand/ }))
    expect(screen.getAllByText('Employee Self-Service').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Managed by HR / User Management').length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('button', { name: /^System-assigned access: Customer & Growth, 1 role/ }))
    expect(screen.getByText('Set up from the legacy role during migration')).toBeTruthy()
    // The legacy compatibility role is in its own section, not mixed with automatic access.
    expect(screen.queryByText('Legacy HQ')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^Legacy-based access, 1, expand/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Legacy-based access: Shared \/ Cross-module, 1 role/ }))
    expect(screen.getAllByText('Legacy HQ').length).toBeGreaterThan(0)
  })

  it('revoke keeps its audited call; automatic access explains the override first', async () => {
    const onChanged = vi.fn()
    const fetchMock = await mountPanel(data, onChanged)
    await userEvent.click(screen.getByRole('button', { name: /^Jafar Admin/ }))
    await revokeWith('Order Approver', 'No longer approves orders')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/security-access/assignments', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ action: 'revoke', assignmentId: 'a3', reason: 'No longer approves orders' }),
    })))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())

    await userEvent.click(screen.getByRole('button', { name: /^System-assigned access, 2/ }))
    await userEvent.click(screen.getByRole('button', { name: /^System-assigned access: HR & Payroll/ }))
    await userEvent.click(screen.getByRole('button', { name: /Revoke Employee Self-Service/ }))
    expect(screen.getByRole('dialog', { name: 'Revoke access' }).textContent).toMatch(/automatic access \(Managed by HR \/ User Management\).*will not be re-added/)
    const dialog = within(screen.getByRole('dialog', { name: 'Revoke access' }))
    await userEvent.type(dialog.getByRole('textbox', { name: /Reason for revoking/ }), 'No longer approves orders')
    await userEvent.click(dialog.getByRole('button', { name: 'Confirm Revoke' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/security-access/assignments', expect.objectContaining({
      body: JSON.stringify({ action: 'revoke', assignmentId: 'a5', reason: 'No longer approves orders' }),
    })))
  })

  it('offers restore only for automatic access an administrator revoked', async () => {
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
    await userEvent.click(screen.getByRole('button', { name: /^Legacy-based access, 2, expand/ }))
    for (const group of screen.getAllByRole('button', { name: /^Legacy-based access: .*expand/ })) await userEvent.click(group)
    expect(screen.getByText('System-assigned access revoked by an administrator')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Revoke Legacy Manager/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Restore Legacy Manager/ }))
    const dialog = within(screen.getByRole('dialog', { name: 'Restore automatic access' }))
    expect(screen.getByRole('dialog', { name: 'Restore automatic access' }).textContent).toMatch(/Legacy Manager.*Serapod HQ/)
    await userEvent.type(dialog.getByRole('textbox', { name: /Reason for restoring/ }), 'Revoked by mistake')
    await userEvent.click(dialog.getByRole('button', { name: 'Confirm Restore' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/security-access/assignments', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ action: 'restore', assignmentId: 'a9', reason: 'Revoked by mistake' }),
    })))
    await screen.findByText('Legacy Manager restored to automatic management for Jafar Admin.')
    expect(onChanged).toHaveBeenCalled()
  })

  it('restore: a too-short reason ("test") is explained and nothing is sent; a refusal stays in the dialog, never success', async () => {
    const onChanged = vi.fn()
    const restorable = {
      ...data,
      restorableAssignmentIds: ['a9'],
      people: data.people.map((p: any) => p.id !== 'u1' ? p : { ...p, membership: p.membership.map((m: any) => ({
        ...m, assignments: [...m.assignments, assignment('a9', 'r-legacy', 'manual', { status: 'revoked', role: { ...role('r-legacy'), id: 'r-legacy-2', name: 'Legacy Manager' } })],
      })) }),
    }
    const refuse: Handler = async () => ({ ok: false, status: 409, json: async () => ({ error: 'The person\'s legacy role has changed since this access was revoked.' }) })
    const fetchMock = await mountPanel(restorable, onChanged, refuse)
    const restorePosts = () => fetchMock.mock.calls.filter((c: any) => c[1]?.method === 'POST' && JSON.parse(c[1].body).action === 'restore')
    await userEvent.click(screen.getByRole('button', { name: /^Jafar Admin/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Legacy-based access, 2, expand/ }))
    for (const group of screen.getAllByRole('button', { name: /^Legacy-based access: .*expand/ })) await userEvent.click(group)
    await userEvent.click(screen.getByRole('button', { name: /Restore Legacy Manager/ }))
    const dialog = within(screen.getByRole('dialog', { name: 'Restore automatic access' }))
    await userEvent.type(dialog.getByRole('textbox', { name: /Reason for restoring/ }), 'test')
    await userEvent.click(dialog.getByRole('button', { name: 'Confirm Restore' }))
    expect(dialog.getByText('Enter a reason of at least 5 characters.')).toBeTruthy()
    expect((dialog.getByRole('button', { name: 'Confirm Restore' }) as HTMLButtonElement).disabled).toBe(true)
    expect(restorePosts()).toEqual([])
    await userEvent.type(dialog.getByRole('textbox', { name: /Reason for restoring/ }), ' — returning')
    await userEvent.click(dialog.getByRole('button', { name: 'Confirm Restore' }))
    expect((await dialog.findByRole('alert')).textContent).toBe('The person\'s legacy role has changed since this access was revoked. Nothing was changed.')
    expect(restorePosts()).toHaveLength(1)
    expect(screen.queryByText(/restored to automatic management/)).toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Restore automatic access' })).toBeNull()
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
    expect(crm.textContent).toMatch(/Already held — system-assigned access/)
    const order = screen.getByRole('option', { name: /Order Approver/ })
    expect(order.getAttribute('aria-disabled')).toBe('true')
    expect(order.textContent).toMatch(/Already held — assigned by an administrator/)
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
    membership: [{ id: 'mvo', organization_id: DIST, status: 'active', is_primary: true, grantable: false, grant_blocked_reason: 'not_authorized', organization: { org_name: 'North Distributor', org_type_code: 'DIST' }, assignments: [] }] }
  const hq = (n: number): any => ({ id: `hq${n}`, full_name: `Bulk Person ${String(n).padStart(3, '0')}`, email: `bulk${n}@dev.com`, role_code: 'USER', is_active: true, organization_id: HQ,
    organization: { org_name: 'Serapod HQ', org_type_code: 'HQ' }, membership: [{ id: `mh${n}`, organization_id: HQ, status: 'active', is_primary: true, grantable: true, organization: { org_name: 'Serapod HQ', org_type_code: 'HQ' }, assignments: [] }] })
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
    const inactiveMem = { ...hq(2), id: 'im', full_name: 'Inactive Membership', membership: [{ id: 'x', organization_id: HQ, status: 'inactive', is_primary: true, grantable: false, grant_blocked_reason: 'membership_not_active', organization: { org_name: 'Serapod HQ', org_type_code: 'HQ' }, assignments: [] }] }
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
        { id: 'mA', organization_id: HQ, status: 'active', is_primary: true, organization: { org_name: 'Serapod HQ', org_type_code: 'HQ' }, assignments: [
          assignment('g1', 'r-order', 'manual', { scopes: [{ scope: { id: 'own-hq', display_name: 'Own record' } }] }),
          assignment('g2', 'r-gl', 'manual', { status: 'revoked', effective_until: '2026-10-01T10:00:00Z' }),
          assignment('g3', 'r-crm', 'access_request', { effective_until: past }),
          assignment('g4', 'r-pfa', 'manual', { effective_until: '2099-01-01T00:00:00Z' }),
        ] },
        { id: 'mB', organization_id: DIST, status: 'suspended', is_primary: false, organization: { org_name: longOrg, org_type_code: 'DIST' }, assignments: [] },
      ],
    }],
  }

  it('shows each membership with organization, type, status and Primary; raw role codes without active legacy policies stay out of daily access', async () => {
    await mountPanel(fixture)
    await userEvent.click(screen.getByRole('button', { name: /^Averyvery/ }))
    const headerOf = (org: string) => within(within(screen.getByRole('region', { name: `Membership: ${org}` })).getByRole('heading', { name: org }).parentElement!.parentElement!)
    const primary = headerOf('Serapod HQ')
    expect(primary.getByText('Headquarters')).toBeTruthy()
    expect(primary.getByText('Active')).toBeTruthy()
    expect(primary.getByText('Primary')).toBeTruthy()
    expect(primary.queryByText(/Legacy role code/)).toBeNull()
    const primaryRegion = within(screen.getByRole('region', { name: 'Membership: Serapod HQ' }))
    expect(primaryRegion.queryByRole('group', { name: 'Legacy Access' })).toBeNull()
    const second = headerOf(longOrg)
    expect(second.getByText('Distributor')).toBeTruthy()
    expect(second.getByText('Suspended')).toBeTruthy()
    expect(second.queryByText('Primary')).toBeNull()
    expect(second.queryByText(/Legacy role code/)).toBeNull()
    expect(screen.queryAllByText(/Legacy role code:/)).toHaveLength(0)
  })

  it('shows only current grants; revoked/expired grants are not listed (their records stay in Audit → Access changes)', async () => {
    await mountPanel(fixture)
    await userEvent.click(screen.getByRole('button', { name: /^Averyvery/ }))
    // The default Assigned policies list is current (in-window active) grants only.
    expect(screen.getByText(/2 active · \d+ modules?/)).toBeTruthy()
    const rowOf = (name: string) => within(screen.getAllByText(name)[0].closest('li')!)
    expect(rowOf('Order Approver').getByText('Active')).toBeTruthy()
    expect(rowOf('Payroll Finance Approver').getByText('Temporary')).toBeTruthy()
    expect(rowOf('Payroll Finance Approver').getByText(/^Until /)).toBeTruthy()
    for (const name of ['Order Approver', 'Payroll Finance Approver']) expect(rowOf(name).getByRole('button', { name: new RegExp(`Revoke ${name}`) })).toBeTruthy()
    // Revoked and expired grants are not mixed into the active list.
    expect(screen.queryByText('GL Clerk')).toBeNull()
    expect(screen.queryByText('CRM User')).toBeNull()
    // No Access history in the daily view: a short pointer to the protected audit viewer, no list and no Restore.
    expect(screen.queryByRole('button', { name: /Access history/ })).toBeNull()
    expect(screen.getByText(/2 revoked or expired entries not shown — no longer grants access\. The records are kept in Audit → Access changes\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull()
  })

  it('uses the shared scope labels so repeated "Own record" scopes are told apart', async () => {
    await mountPanel(fixture)
    await userEvent.click(screen.getByRole('button', { name: /^Averyvery/ }))
    expect(screen.getByText('Own record · Serapod HQ')).toBeTruthy()
  })

  it('Revoke does not toggle the surrounding accordion and keeps the explicit single-entry wording', async () => {
    await mountPanel(fixture)
    await userEvent.click(screen.getByRole('button', { name: /^Averyvery/ }))
    await userEvent.click(screen.getByRole('button', { name: /Revoke Order Approver/ }))
    expect(screen.getByRole('dialog', { name: 'Revoke access' }).textContent).toMatch(/Only this entry is revoked; other granted, automatic or legacy access stays/)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: /^Assigned policies, 2, collapse/ })).toBeTruthy()
    expect(screen.getByText(/2 revoked or expired entries not shown/)).toBeTruthy()
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
    expect(row.getByText('0 assigned')).toBeTruthy()
    expect(row.getByText('0 system-assigned')).toBeTruthy()
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
    await mountPanel(world(people), vi.fn(), mutatingRevoke(people))
    await userEvent.click(screen.getByRole('button', { name: /^Rohani Reconcile/ }))
    expect(screen.getByRole('button', { name: /^Assigned policies: Supply Chain, 2 roles, collapse/ })).toBeTruthy()
    await revokeWith('Order Approver', 'No longer needed')
    await waitFor(() => expect(screen.getByRole('button', { name: /^Assigned policies: Supply Chain, 1 role, collapse/ })).toBeTruthy())
    expect(screen.getAllByText('Order Viewer').length).toBeGreaterThan(0)
    expect(screen.queryByText('Order Approver')).toBeNull()
    expect(screen.getByText(/1 revoked or expired entry not shown/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Rohani Reconcile, 1 active role, collapse/ })).toBeTruthy()
  })

  it('removing the last grant drops the module heading, shows a concise empty state and keeps the person', async () => {
    const people = [person([mkAsg('oa1', ORDER_APPROVER)])]
    await mountPanel(world(people), vi.fn(), mutatingRevoke(people))
    await userEvent.click(screen.getByRole('button', { name: /^Rohani Reconcile/ }))
    expect(screen.getByRole('button', { name: /^Assigned policies: Supply Chain, 1 role, collapse/ })).toBeTruthy()
    await revokeWith('Order Approver', 'No longer needed')
    await waitFor(() => expect(screen.getByText(/No active assigned policies/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: /^Assigned policies: Supply Chain/ })).toBeNull()
    expect(screen.getByText(/1 revoked or expired entry not shown/)).toBeTruthy()
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
    await mountPanel(world(people), vi.fn(), refuse)
    await userEvent.click(screen.getByRole('button', { name: /^Rohani Reconcile/ }))
    await revokeWith('Order Approver', 'Reason here')
    await screen.findByText('Revoke refused by the database. Nothing was changed.')
    expect(screen.getAllByText('Order Approver').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /Access history/ })).toBeNull()
    expect(screen.getByRole('button', { name: /^Rohani Reconcile, 1 active role, collapse/ })).toBeTruthy()
  })

  it('keeps a future-start grant out of the active list as a discoverable Scheduled entry', async () => {
    const people = [person([mkAsg('fa1', FUTURE_APPROVER, { effective_from: future })])]
    await mountPanel(world(people))
    const row = within(screen.getByRole('button', { name: /^Rohani Reconcile, 0 active roles, expand/ }).closest('li')!)
    expect(row.getByText('0 assigned')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /^Rohani Reconcile/ }))
    expect(screen.getByText(/No active assigned policies/)).toBeTruthy()
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
    expect(gl.textContent).toMatch(/Already held — assigned by an administrator · Scope: Alma/)
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
    membership: [{ id: 'm7', organization_id: HQ, status: 'active', is_primary: true, organization: { org_name: 'Serapod HQ', org_type_code: 'HQ' }, assignments }, ...extra] })
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
    const dual = admin([], [{ id: 'm7b', organization_id: DIST, status: 'active', is_primary: false, organization: { org_name: 'North Distributor', org_type_code: 'DIST' }, assignments: [g('b9', 'r-sa-fa', { scopes: [distScope] })] }])
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
    await revokeWith('Security & Access Full Access', 'No longer administers access')
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

describe('Revoked Group Policy grants leave People & Access (no Restore in the daily view)', () => {
  const restoreStatus = (extra: any = {}) => ({ eligible: true, code: null, message: null, effectiveFrom: null, effectiveUntil: null, ...extra })
  /** Jafar (HQ) with one revoked administrator grant (GL Clerk) the server still reports as restorable. */
  const world = (revoked: any) => ({
    ...data,
    people: data.people.map((p: any) => p.id !== 'u1' ? p : { ...p, membership: p.membership.map((m: any) => ({
      ...m, assignments: [...m.assignments, revoked],
    })) }),
  })

  it('a revoked grant is neither listed nor restorable here, even when the restore endpoint would accept it; nothing is posted', async () => {
    const revoked = assignment('a8', 'r-gl', 'manual', { status: 'revoked', effective_until: '2026-10-01T00:00:00Z', restore: restoreStatus() })
    const fetchMock = await mountPanel(world(revoked))
    await userEvent.click(screen.getByRole('button', { name: /^Jafar Admin/ }))
    expect(screen.queryByText('GL Clerk')).toBeNull()
    expect(screen.queryByRole('button', { name: /Restore GL Clerk/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Access history/ })).toBeNull()
    expect(screen.getByText(/1 revoked or expired entry not shown/)).toBeTruthy()
    expect(fetchMock.mock.calls.some(([, init]: any[]) => init?.method === 'POST')).toBe(false)
  })
})

describe('Grant a Group Policy: contextual person preselection', () => {
  const HQC = { id: 'scope-hq', organization_id: HQ, scope_type: 'organization', display_name: 'Serapod HQ', kind: 'hq', label: 'Serapod HQ — HQ and all its warehouses', coverage: 'HQ and all its warehouses' }
  const DISTC = { id: 'scope-dist', organization_id: DIST, scope_type: 'organization', display_name: 'North Distributor', kind: 'organization', label: 'North Distributor — this organization', coverage: 'This organization' }
  const personField = () => screen.getByRole('combobox', { name: 'Person' })
  const membershipField = () => screen.getByRole('combobox', { name: 'Membership organization' })
  const policyField = () => screen.getByRole('combobox', { name: 'Group Policy' })
  const nonPreflightPosts = (fetchMock: any) => fetchMock.mock.calls.filter((c: any) => c[1]?.method === 'POST' && JSON.parse(c[1].body).action !== 'preflight')
  const preflights = (fetchMock: any) => fetchMock.mock.calls.filter((c: any) => c[1]?.method === 'POST' && JSON.parse(c[1].body).action === 'preflight').map((c: any) => JSON.parse(c[1].body))
  const isGrantSearch = (url: string) => String(url).startsWith('/api/security-access/people') && new URL(url, 'http://x').searchParams.get('limit') === '20'
  /** The directory server, with the grant form's person search (limit 20) answered by `search` (deferred or altered rows). */
  const mountWith = async (search: (url: string, init: any, real: () => Promise<any>) => Promise<any>, other?: Handler, opts: Parameters<typeof serve>[2] = {}) => {
    const base = serve(data.people, other, { scopeDefinitions: data.scopeDefinitions, ...opts })
    const fetchMock = vi.fn((url: string, init: any) => (isGrantSearch(url) ? search(url, init, () => base(url, init)) : base(url, init)))
    vi.stubGlobal('fetch', fetchMock)
    render(<PeopleAccessPanel data={data} onChanged={vi.fn()} />)
    await waitFor(() => expect(screen.queryByText('Loading people…')).toBeNull())
    return fetchMock
  }
  const allowedPreflight = (url: string, init: any) => url === '/api/security-access/assignments' && JSON.parse(init.body).action === 'preflight'
    ? { ok: true, status: 200, json: async () => ({ ok: true, allowed: true }) } : { ok: true, status: 200, json: async () => ({}) }

  it('contextual Grant policy preselects the clicked person and their only eligible membership; nothing is granted', async () => {
    const fetchMock = await mountPanel(data)
    await userEvent.click(screen.getByRole('button', { name: /^Siti Staff/ }))   // expanded record, as in UAT
    await openGrantFor('Siti Staff')
    expect(personField().textContent).toMatch(/Siti Staff/)
    expect(personField().textContent).toMatch(/siti@example\.test/)
    expect(membershipField().textContent).toMatch(/Serapod HQ/)
    expect(screen.getByText('Their only active membership — selected for you.')).toBeTruthy()
    expect(screen.getByText('Choose a Group Policy to continue.')).toBeTruthy()
    expect(nonPreflightPosts(fetchMock)).toEqual([])
  })

  it('a person with several eligible memberships must choose the membership', async () => {
    await mountPanel(data)
    await openGrantFor('Dina Dual')
    expect(personField().textContent).toMatch(/Dina Dual/)
    expect(membershipField().textContent).toMatch(/Choose a membership/)
    expect(screen.getByText('2 active memberships — choose the one this access is for.')).toBeTruthy()
    expect(screen.getByText('Choose a membership organization to continue.')).toBeTruthy()
  })

  /** Mounts against a mutable copy of the fixtures, so a person's row can change on the server after the form opened. */
  const mountMutable = async () => {
    const d = { ...data, people: data.people.map(p => ({ ...p })) }
    const fetchMock = serve(d.people, undefined, { scopeDefinitions: d.scopeDefinitions })
    vi.stubGlobal('fetch', fetchMock)
    render(<PeopleAccessPanel data={d} onChanged={vi.fn()} />)
    await waitFor(() => expect(screen.queryByText('Loading people…')).toBeNull())
    const replace = (id: string, f: (p: any) => any) => { const i = d.people.findIndex(p => p.id === id); d.people[i] = f(d.people[i]) }
    return { replace }
  }

  it('keeps the person selected and explains when their fresher row has no eligible membership', async () => {
    const { replace } = await mountMutable()
    await openGrantFor('Siti Staff')
    expect(membershipField().textContent).toMatch(/Serapod HQ/)
    // Meanwhile the membership stops being grantable here; the directory refresh brings the fresher row.
    replace('u2', p => ({ ...p, membership: p.membership.map((m: any) => ({ ...m, grantable: false, grant_blocked_reason: 'not_authorized' })) }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Search people' }), 'Siti')
    await waitFor(() => expect(membershipField().textContent).toMatch(/No active membership/))
    expect(personField().textContent).toMatch(/Siti Staff/)
    expect((membershipField() as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/not authorized to grant access in their organization/)).toBeTruthy()
  })

  it('page-level Grant access opens with no person selected', async () => {
    await mountPanel(data)
    await userEvent.click(screen.getByRole('button', { name: 'Grant access' }))
    expect(personField().textContent).toMatch(/Search a person you can grant to/)
    expect(membershipField().textContent).toMatch(/Choose a person first/)
  })

  it('switching to another person, and close/reopen, never keeps the previous person, membership or policy', async () => {
    await mountPanel(data, vi.fn(), undefined, { scopeChoices: [HQC] })
    await openGrantFor('Siti Staff')
    await userEvent.click(policyField())
    await userEvent.click(screen.getByRole('option', { name: /GL Clerk/ }))
    expect(policyField().textContent).toMatch(/GL Clerk/)
    await openGrantFor('Dina Dual')
    expect(personField().textContent).toMatch(/Dina Dual/)
    expect(personField().textContent).not.toMatch(/Siti/)
    expect(membershipField().textContent).toMatch(/Choose a membership/)
    expect(policyField().textContent).not.toMatch(/GL Clerk/)
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    await userEvent.click(screen.getByRole('button', { name: 'Grant access' }))
    expect(personField().textContent).toMatch(/Search a person you can grant to/)
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    await openGrantFor('Siti Staff')
    expect(personField().textContent).toMatch(/Siti Staff/)
    expect(membershipField().textContent).toMatch(/Serapod HQ/)
  })

  it('a late person-search response (without the person) does not clear the contextual selection', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    await mountWith(async (_u, _i, real) => {
      await gate
      const res = await real(); const body = await res.json()
      return { ...res, json: async () => ({ ...body, people: body.people.filter((p: any) => p.id !== 'u2') }) }
    })
    await openGrantFor('Siti Staff')
    expect(personField().textContent).toMatch(/Siti Staff/)
    release()
    await waitFor(() => expect(screen.queryByText('Searching…')).toBeNull())
    await new Promise(r => setTimeout(r, 50))
    expect(personField().textContent).toMatch(/Siti Staff/)
    expect(membershipField().textContent).toMatch(/Serapod HQ/)
  })

  it('auto-selects the only eligible membership when it arrives after the person was chosen', async () => {
    const { replace } = await mountMutable()
    await openGrantFor('Dina Dual')
    expect(membershipField().textContent).toMatch(/Choose a membership/)
    // The HQ membership ends; the directory refresh leaves exactly one eligible membership.
    replace('u4', p => ({ ...p, membership: p.membership.filter((m: any) => m.organization_id === DIST) }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Search people' }), 'Dina')
    await waitFor(() => expect(membershipField().textContent).toMatch(/North Distributor/))
    expect(personField().textContent).toMatch(/Dina Dual/)
  })

  it('changing the membership resets the policy and scope', async () => {
    const d = { ...data, roles: [...ROLES, { id: 'r-any', name: 'Any Org Viewer', source: 'template', status: 'active', applicable_org_types: ['HQ', 'DIST'], permissions: perms('customer.crm.view') }] }
    const fetchMock = serve(d.people, allowedPreflight, { scopeDefinitions: d.scopeDefinitions })
    const choices = (url: string, init: any) => {
      if (String(url).startsWith('/api/security-access/scope-choices')) {
        const org = new URL(url, 'http://x').searchParams.get('organizationId')
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: org === HQ ? [HQC] : [DISTC] }) })
      }
      return fetchMock(url, init)
    }
    const spy = vi.fn(choices)
    vi.stubGlobal('fetch', spy)
    render(<PeopleAccessPanel data={d} onChanged={vi.fn()} />)
    await waitFor(() => expect(screen.queryByText('Loading people…')).toBeNull())
    await openGrantFor('Dina Dual')
    await userEvent.click(membershipField())
    await userEvent.click(screen.getByRole('option', { name: /Serapod HQ/ }))
    await userEvent.click(policyField())
    await userEvent.click(screen.getByRole('option', { name: /Any Org Viewer/ }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Scope' }).textContent).toMatch(/Serapod HQ/))
    await userEvent.click(membershipField())
    await userEvent.click(screen.getByRole('option', { name: /North Distributor/ }))
    expect(policyField().textContent).not.toMatch(/Any Org Viewer/)
    expect(screen.getByRole('combobox', { name: 'Scope' }).textContent).not.toMatch(/Serapod HQ/)
    expect(nonPreflightPosts(spy)).toEqual([])
  })

  it('a preselected person is not an authorization decision: a refused preflight keeps Grant access disabled and nothing is posted', async () => {
    const refuse = (url: string, init: any) => url === '/api/security-access/assignments' && JSON.parse(init.body).action === 'preflight'
      ? { ok: true, status: 200, json: async () => ({ ok: true, allowed: false, reason: 'You cannot grant this policy in this organization.' }) } : { ok: true, status: 200, json: async () => ({}) }
    const fetchMock = await mountPanel(data, vi.fn(), refuse, { scopeChoices: [HQC] })
    await openGrantFor('Siti Staff')
    await userEvent.click(policyField())
    await userEvent.click(screen.getByRole('option', { name: /GL Clerk/ }))
    await screen.findByText('You cannot grant this policy in this organization.')
    expect(preflights(fetchMock)).toEqual([{ action: 'preflight', userId: 'u2', organizationId: HQ, roleId: 'r-gl', scopeIds: ['scope-hq'] }])
    const submit = screen.getAllByRole('button', { name: 'Grant access' }).find(b => b.closest('section')?.textContent?.includes('Add note (optional)'))! as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    await userEvent.click(submit)
    expect(nonPreflightPosts(fetchMock)).toEqual([])
  })

  it('an allowed preflight still grants only on the explicit Grant access click', async () => {
    const fetchMock = await mountPanel(data, vi.fn(), allowedPreflight, { scopeChoices: [HQC] })
    await openGrantFor('Siti Staff')
    await userEvent.click(policyField())
    await userEvent.click(screen.getByRole('option', { name: /GL Clerk/ }))
    await screen.findByText(/Ready to grant/)
    expect(nonPreflightPosts(fetchMock)).toEqual([])
    const submit = screen.getAllByRole('button', { name: 'Grant access' }).find(b => b.closest('section')?.textContent?.includes('Add note (optional)'))!
    await userEvent.click(submit)
    await waitFor(() => expect(nonPreflightPosts(fetchMock).length).toBe(1))
    expect(JSON.parse(nonPreflightPosts(fetchMock)[0][1].body)).toMatchObject({ action: 'grant', userId: 'u2', organizationId: HQ, roleId: 'r-gl' })
  })
})

describe('Revoke access dialog', () => {
  const mkRole = (id: string, name: string, keys: string[], extra: any = {}) => ({ id, name, source: 'template', status: 'active', applicable_org_types: ['HQ'], permissions: keys.map(k => ({ permission: { permission_key: k } })), ...extra })
  const ECOM = mkRole('r-ecom', 'E-Commerce Administrator', ['customer.ecommerce.manage'])
  const ORDERS = mkRole('r-orders', 'Order Viewer', ['supply_chain.order.view'])
  const LEGACY = mkRole('r-leg', 'Legacy HQ Admin', ['customer.crm.view'], { source: 'legacy' })
  const ESS_ROLE = mkRole('r-ess2', 'Employee Self-Service', ['hr.self_service.use'])
  const ORG = { org_name: 'Serapod Technology Sdn Bhd', org_type_code: 'HQ' }
  const mk = (id: string, r: any, source: string) => ({ id, status: 'active', source, effective_until: null, role: { id: r.id, name: r.name, source: r.source }, scopes: [{ scope: { id: 'scope-hq', display_name: 'Serapod Technology Sdn Bhd' } }] })
  const alif = () => ({
    id: 'u-alif', full_name: 'Alif Dev', email: 'alif@dev.com', role_code: 'HQ', principal_type: 'INTERNAL_EMPLOYEE', is_active: true,
    membership: [{ id: 'm-alif', organization_id: HQ, organization: ORG, status: 'active', is_primary: true, assignments: [
      mk('g-ecom', ECOM, 'manual'), mk('g-orders', ORDERS, 'manual'), mk('auto-ess', ESS_ROLE, 'derived'), mk('leg-1', LEGACY, 'derived'),
    ] }],
  })
  const world = (people: any[]) => ({ ...data, roles: [...data.roles, ECOM, ORDERS, LEGACY, ESS_ROLE], people })
  const revokePosts = (fetchMock: any) => fetchMock.mock.calls.filter((c: any) => c[1]?.method === 'POST' && JSON.parse(c[1].body).action === 'revoke').map((c: any) => JSON.parse(c[1].body))
  /** Revoke API backed by the fixture: marks only the posted assignment revoked; `reply` overrides the answer. */
  const api = (people: any[], reply?: (body: any) => { status: number; body: any } | Promise<{ status: number; body: any }>): Handler => async (url, init) => {
    if (String(url) !== '/api/security-access/assignments') return { ok: true, status: 200, json: async () => ({}) }
    const body = JSON.parse(init.body)
    const r = reply ? await reply(body) : { status: 200, body: { ok: true, assignmentId: body.assignmentId } }
    if (r.status < 400 && body.action === 'revoke') for (const p of people) for (const m of p.membership) for (const a of m.assignments) if (a.id === body.assignmentId) a.status = 'revoked'
    return { ok: r.status < 400, status: r.status, json: async () => r.body }
  }
  const openAlifRevoke = async () => {
    await userEvent.click(screen.getByRole('button', { name: /^Alif Dev/ }))
    await userEvent.click(screen.getByRole('button', { name: /Revoke E-Commerce Administrator/ }))
    return within(screen.getByRole('dialog', { name: 'Revoke access' }))
  }
  const statusOf = (people: any[]) => Object.fromEntries(people[0].membership[0].assignments.map((a: any) => [a.id, a.status]))

  it('shows the policy, person, organization and scope; revokes exactly the selected grant and refreshes the summary', async () => {
    const people = [alif()]
    const onChanged = vi.fn()
    const fetchMock = await mountPanel(world(people), onChanged, api(people))
    const row = () => screen.getByRole('button', { name: /^Alif Dev/ })
    expect(within(row().closest('li')!).getByText('2 assigned')).toBeTruthy()
    const dialog = await openAlifRevoke()
    const text = screen.getByRole('dialog', { name: 'Revoke access' }).textContent!
    expect(text).toMatch(/E-Commerce Administrator/)
    expect(text).toMatch(/Alif Dev/)
    expect(text).toMatch(/alif@dev\.com/)
    expect(text).toMatch(/Organization\s*Serapod Technology Sdn Bhd/)
    expect(text).toMatch(/Data scope/)
    expect(text).not.toMatch(/automatic access \(/)   // an administrator grant: no automatic-override warning
    await userEvent.type(dialog.getByRole('textbox', { name: /Reason for revoking/ }), '  Moved off the e-commerce team  ')
    await userEvent.click(dialog.getByRole('button', { name: 'Confirm Revoke' }))
    await screen.findByText('E-Commerce Administrator revoked for Alif Dev. Any other access this person holds is unchanged.')
    expect(screen.queryByRole('dialog', { name: 'Revoke access' })).toBeNull()
    expect(revokePosts(fetchMock)).toEqual([{ action: 'revoke', assignmentId: 'g-ecom', reason: 'Moved off the e-commerce team' }])
    expect(onChanged).toHaveBeenCalled()
    await waitFor(() => expect(within(row().closest('li')!).getByText('1 assigned')).toBeTruthy())
    // Other granted, automatic and legacy access are untouched.
    expect(statusOf(people)).toEqual({ 'g-ecom': 'revoked', 'g-orders': 'active', 'auto-ess': 'active', 'leg-1': 'active' })
    expect(screen.getAllByText('Order Viewer').length).toBeGreaterThan(0)
  })

  it.each([['too short ("test")', 'test'], ['whitespace padded to look long', '   abc    ']])('a %s reason is explained and nothing is sent', async (_n, reason) => {
    const people = [alif()]
    const fetchMock = await mountPanel(world(people), vi.fn(), api(people))
    const dialog = await openAlifRevoke()
    await userEvent.type(dialog.getByRole('textbox', { name: /Reason for revoking/ }), reason)
    await userEvent.click(dialog.getByRole('button', { name: 'Confirm Revoke' }))
    expect(dialog.getByText('Enter a reason of at least 5 characters.')).toBeTruthy()
    expect((dialog.getByRole('button', { name: 'Confirm Revoke' }) as HTMLButtonElement).disabled).toBe(true)
    expect(dialog.getByRole('textbox', { name: /Reason for revoking/ }).getAttribute('aria-invalid')).toBe('true')
    expect(revokePosts(fetchMock)).toEqual([])
    // Completing the reason enables Confirm again.
    await userEvent.type(dialog.getByRole('textbox', { name: /Reason for revoking/ }), 'more detail')
    expect((dialog.getByRole('button', { name: 'Confirm Revoke' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it.each([
    ['unauthorized actor', 403, 'You are not authorized to change access in this organization.'],
    ['already revoked', 409, 'This access was already revoked. Nothing was changed.'],
    ['database failure', 500, 'The revoke could not be completed.'],
  ])('%s: the error stays in the dialog, nothing is shown as revoked', async (_n, status, error) => {
    const people = [alif()]
    const onChanged = vi.fn()
    const fetchMock = await mountPanel(world(people), onChanged, api(people, () => ({ status, body: { error } })))
    const dialog = await openAlifRevoke()
    await userEvent.type(dialog.getByRole('textbox', { name: /Reason for revoking/ }), 'Moved off the team')
    await userEvent.click(dialog.getByRole('button', { name: 'Confirm Revoke' }))
    const alert = await dialog.findByRole('alert')
    expect(alert.textContent).toContain(error)
    expect(alert.textContent).toMatch(/Nothing was changed\.$/)
    expect(screen.queryByText(/revoked for Alif Dev/)).toBeNull()
    expect(onChanged).not.toHaveBeenCalled()
    expect(revokePosts(fetchMock)).toHaveLength(1)
    expect(statusOf(people)['g-ecom']).toBe('active')
  })

  it('prevents a duplicate submission while the revoke runs and shows progress', async () => {
    const people = [alif()]
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const fetchMock = await mountPanel(world(people), vi.fn(), api(people, async (body) => { await gate; return { status: 200, body: { ok: true, assignmentId: body.assignmentId } } }))
    const dialog = await openAlifRevoke()
    await userEvent.type(dialog.getByRole('textbox', { name: /Reason for revoking/ }), 'Moved off the team')
    await userEvent.click(dialog.getByRole('button', { name: 'Confirm Revoke' }))
    const busy = dialog.getByRole('button', { name: 'Revoking…' }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    await userEvent.click(busy)
    expect((dialog.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true)
    release()
    await screen.findByText(/E-Commerce Administrator revoked for Alif Dev/)
    expect(revokePosts(fetchMock)).toHaveLength(1)
  })

  it('Cancel and Escape close without revoking anything', async () => {
    const people = [alif()]
    const fetchMock = await mountPanel(world(people), vi.fn(), api(people))
    const dialog = await openAlifRevoke()
    await userEvent.type(dialog.getByRole('textbox', { name: /Reason for revoking/ }), 'Moved off the team')
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Revoke access' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Revoke E-Commerce Administrator/ }))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Revoke access' })).toBeNull()
    expect(revokePosts(fetchMock)).toEqual([])
    expect(statusOf(people)['g-ecom']).toBe('active')
  })
})

describe('Access classification (assigned, system-assigned, legacy-based, history)', () => {
  const orgScope = [{ scope: { id: 'scope-hq', scope_type: 'organization', display_name: 'Serapod HQ' } }]
  const entry = (id: string, source: string, role: any, extra: any = {}) => ({ id, status: 'active', source, effective_from: null, effective_until: null, role, scopes: orgScope, ...extra })
  const LEGACY_USER = { id: 'r-legacy-user', role_key: 'legacy-user', name: 'Legacy USER', source: 'legacy', status: 'active' }
  const ESS = { id: 'r-ess', role_key: 'employee-self-service', name: 'Employee Self-Service', source: 'template', status: 'active' }
  const CATALOGUE_USER = { id: 'r-cat', role_key: 'catalog-viewer', name: 'Catalogue User', source: 'template', status: 'active' }
  const CG_FULL = { id: 'r-cg', role_key: 'customer-growth-full-access', name: 'Customer & Growth Full Access', source: 'template', status: 'active' }
  const alif = (assignments: any[], m: any = {}) => ({ ...data, people: [{ id: 'alif', full_name: 'Alif', email: 'alif@dev.test', role_code: 'USER', is_active: true,
    membership: [{ id: 'ma', organization_id: HQ, organization: HQ_ORG, status: 'active', is_primary: true, assignments, ...m }] }] })
  const ALIF = [
    entry('x1', 'backfill', LEGACY_USER), entry('x2', 'derived', ESS, { scopes: [{ scope: { id: 'own', scope_type: 'own_record', display_name: 'Own record' } }] }),
    entry('x3', 'backfill', CATALOGUE_USER), entry('x4', 'manual', CG_FULL),
    entry('x5', 'manual', { ...CG_FULL, id: 'r-cg-old', name: 'Old Growth Grant' }, { status: 'revoked' }),
  ]
  const open = async (d: any) => { await mountPanel(d); await userEvent.click(screen.getByRole('button', { name: /^Alif/ })) }

  it('classifies an explicit grant, system-assigned access and a legacy-based policy; a revoked grant is not listed (Alif)', async () => {
    await mountPanel(alif(ALIF))
    const row = within(screen.getByRole('button', { name: /^Alif/ }).closest('li')!)
    // Only current entries are counted: the revoked grant is in none of the three totals.
    expect(row.getByText('1 assigned')).toBeTruthy()
    expect(row.getByText('2 system-assigned')).toBeTruthy()
    expect(row.getByText('1 legacy-based')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /^Alif/ }))
    expect(screen.getByRole('button', { name: /^Assigned policies, 1, collapse/ })).toBeTruthy()
    expect(screen.getAllByText('Customer & Growth Full Access').length).toBeGreaterThan(0)
    expect(screen.getByText('Administrator assignment')).toBeTruthy()
    // Revoked grant: never in the active list and no history list in the daily view.
    expect(screen.queryByText('Old Growth Grant')).toBeNull()
    expect(screen.getByText(/1 revoked or expired entry not shown/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^System-assigned access, 2, expand/ })).toBeTruthy()
    // Legacy-based access is effective, not historical, and says where it comes from.
    await userEvent.click(screen.getByRole('button', { name: /^Legacy-based access, 1, expand/ }))
    for (const g of screen.getAllByRole('button', { name: /^Legacy-based access: .*expand/ })) await userEvent.click(g)
    expect(screen.getAllByText('Legacy USER').length).toBeGreaterThan(0)
    expect(screen.getByText('From legacy role code (migration)')).toBeTruthy()
    const legacySection = screen.getByRole('button', { name: /^Legacy-based access, 1, collapse/ }).parentElement!
    expect(within(legacySection).getByText(/^1 active · /)).toBeTruthy()
    expect(within(legacySection).queryByText(/historical/)).toBeNull()
  })

  it('separates the S&A access model from Legacy Access: S&A policy, role code and legacy-based policy each in their own section (Alif)', async () => {
    await open(alif(ALIF))
    const membership = screen.getByRole('region', { name: 'Membership: Serapod HQ' })
    const sa = within(membership).getByRole('group', { name: 'S&A Access' })
    const legacy = within(membership).getByRole('group', { name: 'Legacy Access' })
    expect(within(sa).getByText('Access managed through the Security & Access policy system.')).toBeTruthy()
    expect(within(legacy).getByText(/Legacy role information retained for compatibility\. The legacy-based policy below still grants its permissions\./)).toBeTruthy()
    // The explicit S&A policy and system-assigned access live under S&A Access, never under Legacy Access.
    expect(within(sa).getAllByText('Customer & Growth Full Access').length).toBeGreaterThan(0)
    expect(within(sa).getByRole('button', { name: /^Assigned policies, 1, collapse/ })).toBeTruthy()
    expect(within(sa).getByRole('button', { name: /^System-assigned access, 2, expand/ })).toBeTruthy()
    expect(within(legacy).queryByText('Customer & Growth Full Access')).toBeNull()
    expect(within(legacy).queryByRole('button', { name: /^(Assigned policies|System-assigned access)/ })).toBeNull()
    // The role code appears only in Legacy Access — not in the membership header, not under S&A Access.
    expect(within(membership).getAllByText(/Legacy role code/)).toHaveLength(1)
    expect(within(legacy).getByText('Legacy role code: USER')).toBeTruthy()
    expect(within(sa).queryByText(/Legacy role code/)).toBeNull()
    // Legacy-based access keeps its active status (it still grants).
    expect(within(legacy).getByRole('button', { name: /^Legacy-based access, 1, expand/ })).toBeTruthy()
    expect(within(legacy).getByText(/^1 active · 1 module$/)).toBeTruthy()
    // System-assigned access keeps its real sources.
    await userEvent.click(within(sa).getByRole('button', { name: /^System-assigned access, 2, expand/ }))
    for (const g of within(sa).getAllByRole('button', { name: /^System-assigned access: .*expand/ })) await userEvent.click(g)
    expect(within(sa).getByText('Managed by HR / User Management')).toBeTruthy()
    expect(within(sa).getByText('Set up from the legacy role during migration')).toBeTruthy()
    // Order: S&A Access → Legacy Access; no Access history list.
    expect(sa.compareDocumentPosition(legacy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(membership).queryByRole('button', { name: /Access history/ })).toBeNull()
  })

  it('a retired legacy policy leaves daily access while assigned access stays visible', async () => {
    const retired = [entry('x1', 'backfill', { ...LEGACY_USER, status: 'deprecated' }), entry('x4', 'manual', CG_FULL)]
    await mountPanel(alif(retired))
    const row = within(screen.getByRole('button', { name: /^Alif/ }).closest('li')!)
    expect(row.getByText('1 assigned')).toBeTruthy()
    expect(row.queryByText(/legacy-based/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /^Alif/ }))
    const membership = within(screen.getByRole('region', { name: 'Membership: Serapod HQ' }))
    expect(membership.queryByRole('group', { name: 'Legacy Access' })).toBeNull()
    expect(membership.queryByText('Legacy role code: USER')).toBeNull()
    expect(membership.getByRole('group', { name: 'S&A Access' })).toBeTruthy()
  })

  it('a secondary membership without legacy-based access has no Legacy Access section', async () => {
    const d = alif(ALIF)
    d.people[0].membership.push({ id: 'mb', organization_id: DIST, organization: DIST_ORG, status: 'active', is_primary: false, assignments: [entry('y1', 'manual', CG_FULL)] })
    await open(d)
    const second = screen.getByRole('region', { name: 'Membership: North Distributor' })
    expect(within(second).getByRole('group', { name: 'S&A Access' })).toBeTruthy()
    expect(within(second).queryByRole('group', { name: 'Legacy Access' })).toBeNull()
  })

  it('shows the legacy role code as operational membership metadata, not as a grant or as history', async () => {
    await open(alif(ALIF))
    expect(screen.getByText('Legacy role code: USER')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'About the legacy role code' }))
    expect(screen.getByText(/It is not itself a Security & Access grant/)).toBeTruthy()
    expect(screen.queryByText(/Original|Historical role/i)).toBeNull()
  })

  it('treats a legacy-* compatibility role as legacy-based even when the role source is not returned', async () => {
    await open(alif([entry('x1', 'backfill', { ...LEGACY_USER, source: undefined })]))
    expect(screen.getByRole('button', { name: /^Legacy-based access, 1, expand/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^System-assigned access/ })).toBeNull()
  })

  it('does not count a current entry as active when it grants nothing (inactive policy, no scope, inactive membership)', async () => {
    await open(alif([entry('x4', 'manual', CG_FULL), entry('x6', 'manual', { ...CG_FULL, id: 'r-off', name: 'Retired Policy', status: 'inactive' }), entry('x7', 'manual', { ...CG_FULL, id: 'r-ns', name: 'Unscoped Policy' }, { scopes: [] })]))
    expect(screen.getByText(/^1 active · 2 not in effect · /)).toBeTruthy()
    expect(screen.getByText('Policy not active — grants nothing')).toBeTruthy()
    expect(screen.getByText('No data scope — grants nothing')).toBeTruthy()
    cleanup()
    await open(alif([entry('x4', 'manual', CG_FULL)], { status: 'suspended' }))
    expect(screen.getByText(/^0 active · 1 not in effect · /)).toBeTruthy()
    expect(screen.getByText('Membership not active — grants nothing')).toBeTruthy()
  })

  it('marks a current entry whose only data scope is inactive as not in effect', async () => {
    await open(alif([entry('x8', 'manual', CG_FULL, { scopes: [{ scope: { id: 'old', scope_type: 'organization', display_name: 'Closed Branch', status: 'inactive' } }] })]))
    expect(screen.getByText(/^0 active · 1 not in effect · /)).toBeTruthy()
    expect(screen.getByText('Data scope not active — grants nothing')).toBeTruthy()
  })

  it('shows the organization scope of an organization-scoped grant', async () => {
    await open(alif([entry('x4', 'manual', CG_FULL)]))
    expect(screen.getAllByText('Serapod HQ').length).toBeGreaterThan(0)
    expect(screen.queryByText(/grants nothing/)).toBeNull()
  })
})
