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
  { id: 'r-crm', name: 'CRM User', source: 'template', status: 'active', permissions: perms('customer.crm.view') },
  { id: 'r-ess', name: 'Employee Self-Service', source: 'template', status: 'active', permissions: perms('hr.self_service.use') },
  { id: 'r-order', name: 'Order Approver', source: 'template', status: 'active', description: 'Approves orders', permissions: perms('supply_chain.order.approve') },
  { id: 'r-gl', name: 'GL Clerk', source: 'template', status: 'active', permissions: perms('finance.ledger.view', 'finance.module.view') },
  { id: 'r-pfa', name: 'Payroll Finance Approver', source: 'template', status: 'active', permissions: perms('hr.payroll.approve', 'finance.payment.approve') },
]
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
      membership: [{ id: 'm1', organization_id: HQ, status: 'active', is_primary: true, assignments: [
        assignment('a1', 'r-legacy', 'derived'), assignment('a2', 'r-crm', 'backfill'), assignment('a5', 'r-ess', 'derived'),
        assignment('a3', 'r-order', 'manual', { effective_until: '2099-01-01T00:00:00Z' }),
      ] }] },
    { id: 'u2', full_name: 'Siti Staff', email: 'siti@example.test', role_code: 'USER', is_active: true,
      membership: [{ id: 'm2', organization_id: HQ, status: 'active', is_primary: true, assignments: [assignment('a4', 'r-ess', 'derived')] }] },
    { id: 'u3', full_name: 'Old Leaver', email: 'old@example.test', role_code: 'USER', is_active: false, membership: [] },
    { id: 'u4', full_name: 'Dina Dual', email: 'dina@example.test', role_code: 'USER', is_active: true, membership: [
      { id: 'm4a', organization_id: HQ, status: 'active', is_primary: true, assignments: [] },
      { id: 'm4b', organization_id: DIST, status: 'active', is_primary: false, membership_type: 'secondary', assignments: [] },
    ] },
    { id: 'u5', full_name: 'Suspended Sam', email: 'sam@example.test', role_code: 'USER', is_active: true,
      membership: [{ id: 'm5', organization_id: HQ, status: 'suspended', is_primary: true, assignments: [] }] },
    { id: 'viewer', full_name: 'Me Myself', email: 'me@example.test', role_code: 'SA', is_active: true,
      membership: [{ id: 'mv', organization_id: HQ, status: 'active', is_primary: true, assignments: [] }] },
  ],
}


/** Fake server for GET /api/security-access/people (mirrors sa_directory_page semantics) and other calls. */
type Handler = (url: string, init: any) => any
function serve(people: any[], other?: Handler, opts: { organizations?: any[]; failDirectory?: any; requests?: string[]; userManagement?: boolean } = {}) {
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
    return other ? other(url, init) : { ok: true, status: 200, json: async () => ({}) }
  })
}
/** Mounts the panel against a fake directory server and waits for the first page. */
async function mountPanel(d: any, onChanged: () => void = vi.fn(), other?: Handler, opts: Parameters<typeof serve>[2] = {}) {
  const fetchMock = serve(d.people, other, opts)
  vi.stubGlobal('fetch', fetchMock)
  render(<PeopleAccessPanel data={d} onChanged={onChanged} />)
  await waitFor(() => expect(screen.queryByText('Loading people…')).toBeNull())
  return fetchMock
}

const openGrantFor = async (name: string) => {
  const row = screen.getByRole('button', { name: new RegExp(`^${name}`) }).closest('li')!
  await userEvent.click(within(row).getByRole('button', { name: new RegExp(`Grant role to ${name}`) }))
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
    expect(screen.getByRole('button', { name: /^With granted roles\s*1$/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Temporary access\s*1$/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Inactive/ })).toBeNull()      // account status lives in More filters now
  })

  it('filters, searches and shows an empty state', async () => {
    await mountPanel(data)
    await userEvent.click(screen.getByRole('button', { name: /^With granted roles\s*1$/ }))
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

  it('shows a role the person already holds as "Already held" and never lets it be granted twice', async () => {
    await mountPanel(data)
    await openGrantFor('Jafar Admin')
    await userEvent.click(screen.getByRole('combobox', { name: 'Business role' }))
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
    expect(screen.queryByText('Business role')).toBeNull()
    await openGrantFor('Siti Staff')
    expect(screen.getByText('Business role')).toBeTruthy()
    expect(screen.getByText(/Their only active membership — selected for you/)).toBeTruthy()
    const membership = screen.getByRole('combobox', { name: 'Membership organization' })
    expect(membership.textContent).toContain('Serapod HQ')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByText('Business role')).toBeNull()
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

  it('module only filters the role list and clears a role it no longer offers', async () => {
    await mountPanel(data)
    await openGrantFor('Siti Staff')
    const moduleSelect = screen.getByRole('combobox', { name: 'Module filter' }) as HTMLSelectElement
    // Only modules that have grantable roles are offered; legacy roles are never grantable.
    expect(Array.from(moduleSelect.options).map(o => o.text)).toEqual(['All modules', 'Supply Chain', 'Customer & Growth', 'HR & Payroll', 'Finance', 'Shared / Cross-module'])
    await userEvent.selectOptions(moduleSelect, 'finance')
    const roleBox = screen.getByRole('combobox', { name: 'Business role' })
    await userEvent.click(roleBox)
    // Finance shows its own roles and the cross-module role that touches Finance.
    expect(screen.getByRole('option', { name: /GL Clerk/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /Payroll Finance Approver/ })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /Order Approver/ })).toBeNull()
    await userEvent.click(screen.getByRole('option', { name: /GL Clerk/ }))
    expect(roleBox.textContent).toContain('GL Clerk')
    // Switching to a module without that role clears it, so a hidden role is never submitted.
    await userEvent.selectOptions(moduleSelect, 'supply_chain')
    expect(screen.getByRole('combobox', { name: 'Business role' }).textContent).not.toContain('GL Clerk')
    const submit = screen.getAllByRole('button', { name: 'Grant access' }).find(b => b.closest('section')?.textContent?.includes('Reason'))!
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
    expect(screen.getByText(/Counts cover Manu Manufacturing/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /More filters/ }))
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Business membership' }), 'none')
    await waitFor(() => expect(screen.getAllByRole('button', { name: /active roles?, expand$/ }).length).toBe(1))
    expect(screen.getByRole('button', { name: /^No Membership/ })).toBeTruthy()
  })

  it('missing membership is neutral: no warning in the row, a short explanation on demand, Grant stays unavailable', async () => {
    await mountPanel({ ...base, people: [manu, nomem] }, vi.fn(), undefined, { organizations: [mfgOrg] })
    const row = within(screen.getByRole('button', { name: /^No Membership/ }).closest('li')!)
    expect(row.queryByRole('button', { name: /Grant role/ })).toBeNull()
    expect(row.queryByText(/nothing can be granted until HR/i)).toBeNull()
    expect(row.queryByText(/Cannot grant/)).toBeNull()
    expect(row.queryByRole('alert')).toBeNull()                         // never an error
    const why = row.getByRole('button', { name: /Grant unavailable for No Membership: show why/ })
    expect(why.getAttribute('aria-expanded')).toBe('false')
    expect(row.queryByText(/An active business membership is required/)).toBeNull()
    why.focus()
    await userEvent.keyboard('{Enter}')                                  // keyboard
    expect(why.getAttribute('aria-expanded')).toBe('true')
    expect(row.getByRole('note').textContent).toBe('An active business membership is required to assign an Access Profile.')
    expect(why.getAttribute('aria-controls')).toBe(row.getByRole('note').id)
    await userEvent.click(why)                                           // touch/click closes it again
    expect(row.queryByRole('note')).toBeNull()
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
      await userEvent.click(row.getByRole('button', { name: /show why/ }))
      expect(row.getByRole('note').textContent).toMatch(text)
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
      await userEvent.click(screen.getByRole('button', { name: /show why/ }))
      expect(!!screen.queryByRole('link', { name: 'User Management' })).toBe(allowed)
      expect(screen.getByRole('note').textContent).not.toMatch(/HR employee|enrol/i)
      cleanup()
    }
    await mountPanel({ ...base, people: [{ ...hq(3), id: 'st', full_name: 'Staff Person', membership: [] , principal_type: 'INTERNAL_EMPLOYEE' }] }, vi.fn(), undefined, { userManagement: true })
    await userEvent.click(screen.getByRole('button', { name: /show why/ }))
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
      expect(screen.getByText(/Counts cover all authorized organizations with the category, type, organization, status and membership filters applied/)).toBeTruthy()
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
