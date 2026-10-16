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
async function mount(rootAccess: any, posts: any[] = [], postReply?: any) {
  vi.stubGlobal('fetch', serve(rootAccess, posts, postReply))
  render(<PeopleAccessPanel data={data} onChanged={vi.fn()} />)
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

  it('a non-root viewer sees Root status but no Revoke action', async () => {
    await mount({ available: true, viewerIsRoot: false, activeCount: 2 })
    await userEvent.click(screen.getByRole('button', { name: /^Rita Root/ }))
    const card = screen.getByRole('region', { name: 'Root Access' })
    expect(within(card).queryByRole('button', { name: 'Revoke Root Access' })).toBeNull()
  })
})
