import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb, type FakeDb } from '@/test-support/postgrest-fake'

const authGetUser = vi.fn()
const guardUserOperation = vi.fn()
const createAdminClient = vi.fn()
let db: FakeDb

vi.mock('@/lib/security-access/operation', () => ({ guardUserOperation }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: authGetUser }, from: (table: string) => db.from(table) })),
}))

const ISSUE = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

// Next 16 hands route handlers `params` as a Promise.
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const req = (body?: unknown) =>
  ({ json: async () => (body === undefined ? Promise.reject(new Error('no body')) : body) }) as any

const issueQuery = () => db.calls.find(call => call.table === 'consumer_scan_issues')!

describe('/api/scan-issues/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Only rows the caller's RLS lets it see.
    db = createFakeDb({ consumer_scan_issues: [{ id: ISSUE, status: 'pending', priority: 'medium' }] })
    authGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    guardUserOperation.mockResolvedValue(null)
  })

  describe('GET', () => {
    it('rejects anonymous callers before any query', async () => {
      authGetUser.mockResolvedValue({ data: { user: null } })
      const { GET } = await import('./route')
      const response = await GET(req(), ctx(ISSUE))
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'unauthenticated' })
      expect(db.calls).toHaveLength(0)
    })

    it('returns the S&A denial for callers without customer.support.manage', async () => {
      guardUserOperation.mockResolvedValue(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }))
      const { GET } = await import('./route')
      const response = await GET(req(), ctx(ISSUE))
      expect(guardUserOperation).toHaveBeenCalledWith('user-1', 'customer.support.manage')
      expect(response.status).toBe(403)
      expect(db.calls).toHaveLength(0)
    })

    it('loads the issue named by the awaited route param', async () => {
      const { GET } = await import('./route')
      const response = await GET(req(), ctx(ISSUE))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ issue: { id: ISSUE, status: 'pending', priority: 'medium' } })
      expect(issueQuery().filters).toEqual([{ op: 'eq', column: 'id', value: ISSUE }])
    })

    it('returns 404 for an unknown or RLS-hidden issue', async () => {
      const { GET } = await import('./route')
      const response = await GET(req(), ctx(OTHER))
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'not_found' })
    })

    it('returns 400 with the database message when the query fails', async () => {
      db.failOn('consumer_scan_issues', { message: 'invalid input syntax for type uuid' })
      const { GET } = await import('./route')
      const response = await GET(req(), ctx('not-a-uuid'))
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid input syntax for type uuid' })
    })
  })

  describe('PATCH', () => {
    it('rejects anonymous callers and S&A denials without writing', async () => {
      const { PATCH } = await import('./route')
      authGetUser.mockResolvedValue({ data: { user: null } })
      expect((await PATCH(req({ status: 'resolved' }), ctx(ISSUE))).status).toBe(401)
      authGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
      guardUserOperation.mockResolvedValue(new Response(null, { status: 403 }))
      expect((await PATCH(req({ status: 'resolved' }), ctx(ISSUE))).status).toBe(403)
      expect(db.calls).toHaveLength(0)
    })

    it.each([
      [{ status: 'closed' }, 'invalid status'],
      [{ priority: 'critical' }, 'invalid priority'],
      [{}, 'nothing to update'],
      [undefined, 'nothing to update'],
    ])('validates the body %j before writing', async (body, error) => {
      const { PATCH } = await import('./route')
      const response = await PATCH(req(body), ctx(ISSUE))
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error })
      expect(db.calls).toHaveLength(0)
    })

    it('updates only the issue named by the awaited route param through the RLS-scoped client', async () => {
      const { PATCH } = await import('./route')
      const response = await PATCH(req({ status: 'in_progress', priority: 'high' }), ctx(ISSUE))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ issue: { id: ISSUE, status: 'pending', priority: 'medium' } })
      expect(issueQuery().writes).toEqual(['update'])
      expect(issueQuery().filters).toEqual([{ op: 'eq', column: 'id', value: ISSUE }])
      expect(createAdminClient).not.toHaveBeenCalled()
    })
  })
})
