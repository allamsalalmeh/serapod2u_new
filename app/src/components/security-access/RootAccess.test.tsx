// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import PeopleAccessPanel from './PeopleAccessPanel'

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as any
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const HQ = { org_name: 'Serapod HQ', org_type_code: 'HQ' }
const SHOP = { org_name: 'Corner Shop', org_type_code: 'SHOP' }
const membership = (id: string, org: any, orgId: string) => ({ id, organization_id: orgId, status: 'active', is_primary: true, organization: org, assignments: [] })
const ROOT_INFO = { grantId: 'g1', method: 'grant', grantedAt: '2026-10-01T08:00:00Z', grantedBy: { id: 'viewer', name: 'Me Myself', email: 'me@example.test' }, effectiveUntil: null, reason: 'Platform owner during the S&A rollout' }
const PEOPLE = [
  { id: 'viewer', full_name: 'Me Myself', email: 'me@example.test', is_active: true, membership: [membership('mv', HQ, 'hq')], root_access: { ...ROOT_INFO, grantId: 'g0', method: 'bootstrap', grantedBy: null } },
  { id: 'u1', full_name: 'Rita Root', email: 'rita@example.test', is_active: true, membership: [membership('m1', HQ, 'hq')], root_access: ROOT_INFO },
  { id: 'u2', full_name: 'Siti Staff', email: 'siti@example.test', is_active: true, membership: [membership('m2', HQ, 'hq')], root_access: null },
  { id: 'u3', full_name: 'Shop Sam', email: 'sam@example.test', is_active: true, membership: [membership('m3', SHOP, 'shop')], root_access: null },
]
const data = { viewerId: 'viewer', organizations: [], roles: [], scopeDefinitions: [], people: PEOPLE }

function serve(rootAccess: any, posts: any[] = [], postReply: any = { ok: true }) {
  return vi.fn(async (url: string, init: any) => {
    if (String(url).startsWith('/api/security-access/people')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, people: PEOPLE, total: PEOPLE.length, counts: { all: 4, granted: 0, temporary: 0, inactive: 0, none: 0 }, organizations: [], capabilities: { userManagement: false, rootAccess } }) }
    }
    if (String(url) === '/api/security-access/root-access') {
      posts.push(JSON.parse(init.body))
      return { ok: postReply.ok !== false, status: postReply.status ?? 200, json: async () => postReply }
    }
    return { ok: true, status: 200, json: async () => ({ choices: [] }) }
  })
}
async function mount(rootAccess: any, posts: any[] = [], postReply?: any, extra: any = {}) {
  vi.stubGlobal('fetch', serve(rootAccess, posts, postReply))
  render(<PeopleAccessPanel data={{ ...data, ...extra }} onChanged={vi.fn()} />)
  await waitFor(() => expect(screen.queryByText('Loading people…')).toBeNull())
}
const ROOT_VIEWER = { available: true, viewerIsRoot: true, activeCount: 2 }

describe('Root Access in People & Access', () => {
  it('marks Root Administrators in the directory', async () => {
    await mount(ROOT_VIEWER)
    const rita = screen.getByRole('button', { name: /^Rita Root/ }).closest('li')!
    expect(within(rita).getByText('Root Administrator')).toBeTruthy()
    const siti = screen.getByRole('button', { name: /^Siti Staff/ }).closest('li')!
    expect(within(siti).queryByText('Root Administrator')).toBeNull()
  })

  it('keeps the standard grant form unchanged when the migration is not applied', async () => {
    await mount(undefined)
    await userEvent.click(screen.getByRole('button', { name: 'Grant access' }))
    expect(screen.queryByRole('group', { name: /Access level/ })).toBeNull()
    expect(screen.queryByRole('radio', { name: /Root Access/ })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Group Policy' })).toBeTruthy()
  })

  it('offers Root Access only to a Root Administrator; others see it disabled with the reason', async () => {
    await mount({ available: true, viewerIsRoot: false, activeCount: 1 })
    await userEvent.click(screen.getByRole('button', { name: 'Grant access' }))
    const root = screen.getByRole('radio', { name: /Root Access — Full System Administrator/ }) as HTMLInputElement
    expect(root.disabled).toBe(true)
    expect(screen.getByText(/Only an active Root Administrator can grant Root Access/)).toBeTruthy()
    expect((screen.getByRole('radio', { name: /Standard Access/ }) as HTMLInputElement).checked).toBe(true)
  })

  it('Root mode: warning, global scope, no module/policy/scope selectors, reason + typed confirmation required', async () => {
    const posts: any[] = []
    await mount(ROOT_VIEWER, posts, { ok: true, grantId: 'g9' })
    await userEvent.click(screen.getByRole('button', { name: 'Grant access' }))
    await userEvent.click(screen.getByRole('radio', { name: /Root Access — Full System Administrator/ }))
    expect(screen.getByText(/Root Access grants full system-wide administrative privileges across all modules and organizations/)).toBeTruthy()
    expect(screen.getByText(/Global — HQ, branches/)).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Group Policy' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Scope' })).toBeNull()
    expect(screen.queryByLabelText('Module filter')).toBeNull()

    // Person picker: self excluded; existing Root Administrators and partner staff listed but not selectable.
    await userEvent.click(screen.getByRole('combobox', { name: 'Person' }))
    expect(screen.queryByRole('option', { name: /Me Myself/ })).toBeNull()
    expect(screen.getByRole('option', { name: /Rita Root/ }).getAttribute('aria-disabled')).toBe('true')
    expect(screen.getByRole('option', { name: /Shop Sam/ }).getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(screen.getByRole('option', { name: /Siti Staff/ }))

    const start = screen.getByRole('button', { name: /Grant Root Access…/ }) as HTMLButtonElement
    expect(start.disabled).toBe(true)                 // reason missing
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'Owner of the platform migration, ticket OPS-12')
    expect(start.disabled).toBe(false)
    await userEvent.click(start)

    const confirm = screen.getByRole('button', { name: 'Confirm and grant Root Access' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    await userEvent.type(screen.getByLabelText('Confirmation phrase'), 'grant root access')
    expect(confirm.disabled).toBe(true)               // exact phrase only
    await userEvent.clear(screen.getByLabelText('Confirmation phrase'))
    await userEvent.type(screen.getByLabelText('Confirmation phrase'), 'GRANT ROOT ACCESS')
    await userEvent.click(confirm)

    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toMatchObject({ action: 'grant', userId: 'u2', reason: 'Owner of the platform migration, ticket OPS-12', confirmation: 'GRANT ROOT ACCESS', effectiveUntil: null })
    expect(posts[0].requestKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(posts[0]).not.toHaveProperty('scopeIds')
    expect(await screen.findByText(/Root Access granted to Siti Staff/)).toBeTruthy()
  })

  it('shows a refusal from the server and grants nothing', async () => {
    const posts: any[] = []
    await mount(ROOT_VIEWER, posts, { ok: false, status: 403, error: 'Only an active Root Administrator can grant or revoke Root Access.', code: 'root_authority_required' })
    await userEvent.click(screen.getByRole('button', { name: 'Grant access' }))
    await userEvent.click(screen.getByRole('radio', { name: /Root Access — Full System Administrator/ }))
    await userEvent.click(screen.getByRole('combobox', { name: 'Person' }))
    await userEvent.click(screen.getByRole('option', { name: /Siti Staff/ }))
    await userEvent.type(screen.getByLabelText('Reason (required)'), 'Owner of the platform migration')
    await userEvent.click(screen.getByRole('button', { name: /Grant Root Access…/ }))
    await userEvent.type(screen.getByLabelText('Confirmation phrase'), 'GRANT ROOT ACCESS')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm and grant Root Access' }))
    expect(await screen.findByText(/Only an active Root Administrator can grant or revoke Root Access\. Nothing was changed\./)).toBeTruthy()
  })

  it('access detail shows status, granter, dates and reason; Revoke for another Root Administrator only', async () => {
    const posts: any[] = []
    await mount(ROOT_VIEWER, posts, { ok: true })
    await userEvent.click(screen.getByRole('button', { name: /^Rita Root/ }))
    const card = screen.getByRole('region', { name: 'Root Access' })
    expect(within(card).getByText('Me Myself')).toBeTruthy()
    expect(within(card).getByText('No expiry')).toBeTruthy()
    expect(within(card).getByText('Platform owner during the S&A rollout')).toBeTruthy()
    expect(within(card).getByText('Global — all modules and organizations')).toBeTruthy()
    vi.spyOn(window, 'prompt').mockReturnValue('Rotation to the new platform owner')
    await userEvent.click(within(card).getByRole('button', { name: 'Revoke Root Access' }))
    await waitFor(() => expect(posts).toEqual([{ action: 'revoke', userId: 'u1', reason: 'Rotation to the new platform owner' }]))
    expect(await screen.findByText(/Root Access revoked from Rita Root\. Their other access is unchanged\./)).toBeTruthy()

    // Own entry: no Revoke, an explanation instead.
    await userEvent.click(screen.getByRole('button', { name: /^Me Myself/ }))
    const own = screen.getAllByRole('region', { name: 'Root Access' }).find(r => within(r).queryByText('Initial setup (database owner)'))!
    expect(within(own).queryByRole('button', { name: 'Revoke Root Access' })).toBeNull()
    expect(within(own).getByText('You cannot revoke your own Root Access.')).toBeTruthy()
  })

  it('Revoke Root Access: a too-short reason is explained and nothing is sent; cancelling stays silent', async () => {
    const posts: any[] = []
    await mount(ROOT_VIEWER, posts, { ok: true })
    await userEvent.click(screen.getByRole('button', { name: /^Rita Root/ }))
    const card = screen.getByRole('region', { name: 'Root Access' })
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue(null)
    await userEvent.click(within(card).getByRole('button', { name: 'Revoke Root Access' }))
    expect(screen.queryByText(/reason of at least/)).toBeNull()
    prompt.mockReturnValue('   test    ')
    await userEvent.click(within(card).getByRole('button', { name: 'Revoke Root Access' }))
    expect(await screen.findByText('A reason of at least 10 characters is required. Root Access was not revoked.')).toBeTruthy()
    expect(posts).toEqual([])
    expect(screen.getByRole('region', { name: 'Root Access' })).toBeTruthy()
  })

  it('a non-root viewer sees Root status but no Revoke action', async () => {
    await mount({ available: true, viewerIsRoot: false, activeCount: 2 })
    await userEvent.click(screen.getByRole('button', { name: /^Rita Root/ }))
    const card = screen.getByRole('region', { name: 'Root Access' })
    expect(within(card).queryByRole('button', { name: 'Revoke Root Access' })).toBeNull()
  })

  it('shows that Root Access applies across all modules with a catalogue-derived effective-permissions summary', async () => {
    await mount({ available: true, viewerIsRoot: true, activeCount: 2, activePermissionCount: 134 })
    await userEvent.click(screen.getByRole('button', { name: /^Rita Root/ }))
    const card = screen.getByRole('region', { name: 'Root Access' })
    expect(within(card).getByText('Root Access applies across all modules')).toBeTruthy()
    expect(within(card).getByText(/Effective for all 134 active permissions in the current catalogue/)).toBeTruthy()
  })

  it('omits a hardcoded count and uses the catalogue wording when the permission count is unavailable', async () => {
    await mount({ available: true, viewerIsRoot: true, activeCount: 2, activePermissionCount: null })
    await userEvent.click(screen.getByRole('button', { name: /^Rita Root/ }))
    const card = screen.getByRole('region', { name: 'Root Access' })
    expect(within(card).getByText(/Effective for every active permission in the current catalogue/)).toBeTruthy()
  })

  describe('Effective Root Permissions breakdown', () => {
    // Same catalogue rows the Overview read model returns for Roles & Policies → Policies.
    const CATALOGUE = [
      { permission_key: 'supply_chain.order.view', status: 'active', description: 'View orders and their documents' },
      { permission_key: 'supply_chain.order.create', status: 'active', description: null },
      { permission_key: 'inventory.stock_count.post', status: 'active', description: 'Post a verified stock count' },
      { permission_key: 'security.access.view', status: 'active', description: 'Open Security & Access' },
      { permission_key: 'platform.user.manage', status: 'active', description: 'Manage user accounts' },
      { permission_key: 'inventory.transfer.cancel', status: 'inactive', description: 'Retired' },
    ]
    const ACTIVE = CATALOGUE.filter(p => p.status === 'active')
    const openRita = async (cap: any = { available: true, viewerIsRoot: true, activeCount: 2, activePermissionCount: ACTIVE.length }, extra: any = { permissions: CATALOGUE }, people?: any[]) => {
      const fetchMock = serve(cap)
      if (people) fetchMock.mockImplementation(async (url: string) => ({ ok: true, status: 200, json: async () => String(url).startsWith('/api/security-access/people')
        ? { ok: true, people, total: people.length, counts: {}, organizations: [], capabilities: { userManagement: false, rootAccess: cap } } : { choices: [] } }))
      vi.stubGlobal('fetch', fetchMock)
      render(<PeopleAccessPanel data={{ ...data, ...extra }} onChanged={vi.fn()} />)
      await waitFor(() => expect(screen.queryByText('Loading people…')).toBeNull())
      await userEvent.click(screen.getByRole('button', { name: /^Rita Root/ }))
      return fetchMock
    }
    const toggle = (card: HTMLElement) => within(card).getByRole('button', { name: /^Effective Root Permissions/ })

    it('is collapsed by default, counts only active permissions and renders no rows until opened', async () => {
      await openRita()
      const card = screen.getByRole('region', { name: 'Root Access' })
      const t = toggle(card)
      expect(t.getAttribute('aria-expanded')).toBe('false')
      expect(t.textContent).toBe(`Effective Root Permissions — ${ACTIVE.length} active permissions`)
      expect(within(card).queryByText('supply_chain.order.view')).toBeNull()
      expect(within(card).getByText('Root Administrator — active')).toBeTruthy()
    })

    it('opens to the Policies hierarchy with counts; every active key, description, Allowed by Root and Global scope can be inspected', async () => {
      const fetchMock = await openRita()
      const card = screen.getByRole('region', { name: 'Root Access' })
      await userEvent.click(toggle(card))
      expect(toggle(card).getAttribute('aria-expanded')).toBe('true')
      expect(within(card).getByText(/inherited through active Root Access\. They are not individual or automatic group-policy assignments\./)).toBeTruthy()
      expect(within(card).getByText('1 inactive catalogue permission is not listed or counted.')).toBeTruthy()
      const tree = within(card).getByRole('region', { name: 'Effective Root Permissions' })
      // Modules: same names and order as Policies, with counts; collapsed.
      expect(within(tree).getByRole('button', { name: 'Supply Chain, 3 permissions, expand' })).toBeTruthy()
      expect(within(tree).getByRole('button', { name: 'Security & Access, 1 permission, expand' })).toBeTruthy()
      expect(within(tree).getByRole('button', { name: 'Platform & Settings, 1 permission, expand' })).toBeTruthy()
      expect(within(tree).queryByText('inventory.transfer.cancel')).toBeNull()

      // Keyboard: open a module and a subcategory with Enter.
      within(tree).getByRole('button', { name: /^Supply Chain,/ }).focus()
      await userEvent.keyboard('{Enter}')
      const sub = within(tree).getByRole('button', { name: 'Supply Chain: Orders & Documents, 2 permissions, expand' })
      sub.focus()
      await userEvent.keyboard('{Enter}')
      expect(within(tree).getByText('supply_chain.order.view')).toBeTruthy()
      expect(within(tree).getByText('View orders and their documents')).toBeTruthy()
      expect(within(tree).getByText('supply_chain.order.create')).toBeTruthy()
      expect(within(tree).getAllByText('Allowed by Root').length).toBe(2)
      expect(within(tree).getAllByText('Scope: Global').length).toBe(2)

      // Search reaches every active key (and never an inactive one).
      for (const p of ACTIVE) {
        await userEvent.clear(within(tree).getByRole('textbox', { name: 'Search modules or permissions' }))
        await userEvent.type(within(tree).getByRole('textbox', { name: 'Search modules or permissions' }), p.permission_key)
        expect(within(tree).getByText(p.permission_key)).toBeTruthy()
      }
      await userEvent.clear(within(tree).getByRole('textbox', { name: 'Search modules or permissions' }))
      await userEvent.type(within(tree).getByRole('textbox', { name: 'Search modules or permissions' }), 'inventory.transfer.cancel')
      expect(within(tree).queryByText('inventory.transfer.cancel')).toBeNull()
      await userEvent.clear(within(tree).getByRole('textbox', { name: 'Search modules or permissions' }))

      // Collapse all, then the whole section.
      await userEvent.click(within(tree).getByRole('button', { name: 'Collapse all' }))
      expect(within(tree).queryByText('supply_chain.order.view')).toBeNull()
      await userEvent.click(toggle(card))
      expect(within(card).queryByRole('region', { name: 'Effective Root Permissions' })).toBeNull()

      // Display only: nothing but the directory read was requested — no grant, no write.
      expect(fetchMock.mock.calls.every(([url, init]: any) => String(url).startsWith('/api/security-access/people') && (init?.method ?? 'GET') === 'GET')).toBe(true)
      expect(fetchMock.mock.calls.some(([url]: any) => String(url).includes('root-access') || String(url).includes('assignments'))).toBe(false)
    })

    it('includes a newly added permission automatically', async () => {
      const added = [...CATALOGUE, { permission_key: 'hr.payroll.approve', status: 'active', description: 'Approve payroll runs' }]
      await openRita({ available: true, viewerIsRoot: true, activeCount: 2, activePermissionCount: ACTIVE.length + 1 }, { permissions: added })
      const card = screen.getByRole('region', { name: 'Root Access' })
      expect(toggle(card).textContent).toBe(`Effective Root Permissions — ${ACTIVE.length + 1} active permissions`)
      await userEvent.click(toggle(card))
      expect(within(card).getByRole('button', { name: 'HR & Payroll, 1 permission, expand' })).toBeTruthy()
    })

    it('warns instead of claiming completeness when the catalogue count and rows differ', async () => {
      await openRita({ available: true, viewerIsRoot: true, activeCount: 2, activePermissionCount: 134 })
      const card = screen.getByRole('region', { name: 'Root Access' })
      expect(toggle(card).textContent).toBe('Effective Root Permissions — 134 active permissions')
      await userEvent.click(toggle(card))
      expect(within(card).getByRole('alert').textContent).toMatch(new RegExp(`Showing ${ACTIVE.length} active permissions of 134 .*may be incomplete`))
    })

    it('reports a missing catalogue and an empty catalogue distinctly', async () => {
      await openRita(undefined, {})
      let card = screen.getByRole('region', { name: 'Root Access' })
      await userEvent.click(toggle(card))
      expect(within(card).getByRole('alert').textContent).toMatch(/permission catalogue could not be loaded/)
      cleanup()
      await openRita({ available: true, viewerIsRoot: true, activeCount: 2, activePermissionCount: 0 }, { permissions: [] })
      card = screen.getByRole('region', { name: 'Root Access' })
      expect(toggle(card).textContent).toBe('Effective Root Permissions — 0 active permissions')
      await userEvent.click(toggle(card))
      expect(within(card).getByText('No active permissions are registered in the catalogue.')).toBeTruthy()
    })

    it('leaves Automatic and Legacy Access counts unchanged (Root permissions are a separate, virtual list)', async () => {
      const asg = (id: string, source: string, roleSource: string, name: string) => ({ id, status: 'active', source, effective_from: null, effective_until: null, role: { id: `r-${id}`, name, source: roleSource }, scopes: [] })
      const withAccess = PEOPLE.map(p => p.id === 'u1' ? { ...p, membership: [{ ...membership('m1', HQ, 'hq'),
        assignments: [asg('a1', 'derived', 'system', 'Order Viewer'), asg('a2', 'backfill', 'system', 'Stock Viewer'), asg('a3', 'legacy_compat', 'legacy', 'HQ Admin (legacy)')] }] } : p)
      await openRita(undefined, { permissions: CATALOGUE }, withAccess)
      const membershipRegion = () => screen.getByRole('region', { name: 'Membership: Serapod HQ' })
      const counts = () => within(membershipRegion()).getAllByRole('button').map(b => b.getAttribute('aria-label')).filter(l => /^(System-assigned|Legacy-based) access/.test(l || ''))
      const before = counts()
      expect(before).toEqual(['System-assigned access, 2, expand', 'Legacy-based access, 1, expand'])
      const card = screen.getByRole('region', { name: 'Root Access' })
      await userEvent.click(toggle(card))
      expect(counts()).toEqual(before)
    })

    it('shows no Root permissions once Root Access has expired or been revoked; Group Policy access is unaffected', async () => {
      const expired = PEOPLE.map(p => p.id === 'u1' ? { ...p, root_access: { ...ROOT_INFO, effectiveUntil: '2026-01-01T00:00:00Z' } } : p)
      await openRita(undefined, { permissions: CATALOGUE }, expired)
      expect(screen.queryByRole('region', { name: 'Root Access' })).toBeNull()
      expect(screen.queryByRole('button', { name: /^Effective Root Permissions/ })).toBeNull()
      cleanup()
      const revoked = PEOPLE.map(p => p.id === 'u1' ? { ...p, root_access: null } : p)
      await openRita(undefined, { permissions: CATALOGUE }, revoked)
      expect(screen.queryByRole('button', { name: /^Effective Root Permissions/ })).toBeNull()
    })
  })
  describe('Root Access and organization access stay separate', () => {
    const open = async (people: any[], name: RegExp) => {
      const fetchMock = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => String(url).startsWith('/api/security-access/people')
        ? { ok: true, people, total: people.length, counts: {}, organizations: [], capabilities: { userManagement: false, rootAccess: { available: true, viewerIsRoot: true, activeCount: 2, activePermissionCount: 2 } } } : { choices: [] } }))
      vi.stubGlobal('fetch', fetchMock)
      render(<PeopleAccessPanel data={data} onChanged={vi.fn()} />)
      await waitFor(() => expect(screen.queryByText('Loading people…')).toBeNull())
      await userEvent.click(screen.getByRole('button', { name }))
    }

    it('a Root Administrator with no individual grants still shows active Root Access, then Organization access', async () => {
      await open(PEOPLE.map(p => p.id === 'u1' ? { ...p, role_code: 'SA' } : p), /^Rita Root/)
      const card = screen.getByRole('region', { name: 'Root Access' })
      expect(within(card).getByText('Root Administrator — active')).toBeTruthy()
      expect(within(card).getByText('Global — all modules and organizations')).toBeTruthy()
      expect(screen.getByRole('heading', { name: 'Organization membership' })).toBeTruthy()
      const membership = screen.getByRole('region', { name: 'Membership: Serapod HQ' })
      expect(within(membership).queryByRole('group', { name: 'Legacy Access' })).toBeNull()
      expect(within(within(membership).getByRole('group', { name: 'S&A Access' })).getByText('No Security & Access policies in this membership.')).toBeTruthy()
      // Root permissions are never listed as assigned policies.
      expect(screen.queryByRole('button', { name: /^Assigned policies/ })).toBeNull()
    })

    it('a person without Root Access has no Root card and no Organization access divider', async () => {
      await open(PEOPLE, /^Siti Staff/)
      expect(screen.queryByRole('region', { name: 'Root Access' })).toBeNull()
      expect(screen.queryByRole('heading', { name: 'Organization membership' })).toBeNull()
    })
  })
})
