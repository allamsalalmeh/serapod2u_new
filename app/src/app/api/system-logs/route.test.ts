import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  user: { id: 'viewer' } as { id: string } | null,
  access: { allowed: true, scope: { all: false, organizationIds: ['org-1'] }, organizationId: 'org-1' } as any,
  rpc: vi.fn(),
  orgName: 'HQ',
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: mocks.user } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: mocks.rpc,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { org_name: mocks.orgName } }) }) }) }),
  }),
}))
vi.mock('@/lib/system-logs/access', async (orig) => ({
  ...(await orig<typeof import('@/lib/system-logs/access')>()),
  resolveSystemLogAccess: vi.fn(async (id: string | undefined) => (id ? mocks.access : { allowed: false, status: 401, reason: 'not_authenticated' })),
}))

import { GET as LIST } from './route'
import { GET as DETAIL } from './[id]/route'
import { GET as ACCESS } from './access/route'
import { decodeCursor, encodeCursor } from '@/lib/system-logs/query'

const list = (qs = '') => LIST(new NextRequest(`http://localhost/api/system-logs${qs}`))
const detail = (id: string) => DETAIL(new NextRequest(`http://localhost/api/system-logs/${id}`), { params: Promise.resolve({ id }) })
const row = (i: number) => ({ id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, occurred_at: new Date(Date.now() - i * 1000).toISOString(), reference_id: `ERR-${String(i).padStart(12, '0')}` })

beforeEach(() => {
  mocks.user = { id: 'viewer' }
  mocks.access = { allowed: true, scope: { all: false, organizationIds: ['org-1'] }, organizationId: 'org-1' }
  mocks.rpc.mockReset()
  mocks.rpc.mockResolvedValue({ data: [], error: null })
})

describe('GET /api/system-logs — authorization and scope', () => {
  it('denies without a session and without platform.system_logs.view (Settings/User Management alone is not enough)', async () => {
    mocks.user = null
    expect((await list()).status).toBe(401)
    mocks.user = { id: 'settings-admin' }
    mocks.access = { allowed: false, status: 403, reason: 'NO_MATCHING_ASSIGNMENT' }
    const denied = await list()
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ code: 'sa_forbidden', permission: 'platform.system_logs.view' })
    expect((await detail('00000000-0000-0000-0000-000000000001')).status).toBe(403)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('passes only the readable organizations to the database (never all unless S&A said so)', async () => {
    await list()
    expect(mocks.rpc).toHaveBeenCalledWith('system_log_list_errors', expect.objectContaining({ p_orgs: ['org-1'], p_all_orgs: false }))
    mocks.access = { allowed: true, scope: { all: true }, organizationId: 'hq' }
    await list('?tab=activity')
    expect(mocks.rpc).toHaveBeenLastCalledWith('system_log_list_activity', expect.objectContaining({ p_orgs: null, p_all_orgs: true }))
  })

  it('an empty readable scope returns nothing without querying', async () => {
    mocks.access = { allowed: true, scope: { all: false, organizationIds: [] }, organizationId: 'x' }
    const body = await (await list()).json()
    expect(body).toMatchObject({ state: 'ok', items: [], scope: 'none' })
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('out-of-scope or unknown detail ids answer 404 (existence not revealed)', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    expect((await detail('00000000-0000-0000-0000-000000000009')).status).toBe(404)
    expect((await detail('not-a-uuid')).status).toBe(404)
  })
})

describe('GET /api/system-logs — filters, bounds and pagination', () => {
  it('defaults Errors to the last 24 hours and Activity to 7 days, and caps the window at 31 days', async () => {
    await list()
    let args = mocks.rpc.mock.calls[0][1]
    expect((Date.parse(args.p_to) - Date.parse(args.p_from)) / 3_600_000).toBeCloseTo(24, 0)
    await list('?tab=activity')
    args = mocks.rpc.mock.calls[1][1]
    expect((Date.parse(args.p_to) - Date.parse(args.p_from)) / 86_400_000).toBeCloseTo(7, 0)
    await list(`?from=${encodeURIComponent(new Date(Date.now() - 400 * 86_400_000).toISOString())}`)
    args = mocks.rpc.mock.calls[2][1]
    expect((Date.parse(args.p_to) - Date.parse(args.p_from)) / 86_400_000).toBeLessThanOrEqual(31.001)
  })

  it('forwards validated filters and rejects invalid ones', async () => {
    await list('?environment=local&severity=warning&category=network&module=Supply%20Chain&user=3f2c1d8e-1111-2222-3333-444455556666&q=ERR-ABC')
    expect(mocks.rpc).toHaveBeenCalledWith('system_log_list_errors', expect.objectContaining({
      p_environment: 'local', p_severity: 'warning', p_category: 'network', p_module: 'Supply Chain', p_actor: '3f2c1d8e-1111-2222-3333-444455556666', p_search: 'ERR-ABC', p_limit: 51,
    }))
    for (const bad of ['?environment=prod', '?user=nope', '?limit=500', '?category=x', `?q=${'x'.repeat(200)}`]) expect((await list(bad)).status, bad).toBe(400)
  })

  it('pages with keyset cursors (limit + 1 probe)', async () => {
    mocks.rpc.mockResolvedValue({ data: Array.from({ length: 51 }, (_, i) => row(i)), error: null })
    const body = await (await list()).json()
    expect(body.items).toHaveLength(50)
    expect(decodeCursor(body.nextCursor)).toEqual({ t: body.items[49].occurred_at, k: body.items[49].id })
    await list(`?cursor=${body.nextCursor}`)
    expect(mocks.rpc).toHaveBeenLastCalledWith('system_log_list_errors', expect.objectContaining({ p_cursor_time: body.items[49].occurred_at, p_cursor_id: body.items[49].id }))
    mocks.rpc.mockResolvedValue({ data: [row(1)], error: null })
    expect((await (await list(`?cursor=${encodeCursor({ t: 'x', k: 'y' })}`)).json()).nextCursor).toBeNull()
  })

  it('shows an accurate admin state when the migration is pending, without failing the app', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })
    const res = await list()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ state: 'not_installed', items: [] })
  })

  it('detail returns the event with its group, related events and organization name', async () => {
    mocks.rpc.mockResolvedValue({ data: { event: { id: 'e', organization_id: 'org-1' }, group: { occurrence_count: 3 }, related: [] }, error: null })
    const body = await (await detail('00000000-0000-0000-0000-000000000001')).json()
    expect(body).toMatchObject({ state: 'ok', organizationName: 'HQ', detail: { group: { occurrence_count: 3 } } })
    expect(mocks.rpc).toHaveBeenCalledWith('system_log_event_detail', { p_id: '00000000-0000-0000-0000-000000000001', p_orgs: ['org-1'], p_all_orgs: false })
  })
})

describe('GET /api/system-logs/access', () => {
  it('answers allowed + environment for permitted viewers and false otherwise', async () => {
    expect(await (await ACCESS()).json()).toEqual({ allowed: true, environment: 'test' })
    mocks.access = { allowed: false, status: 403, reason: 'x' }
    expect(await (await ACCESS()).json()).toEqual({ allowed: false })
  })
})
