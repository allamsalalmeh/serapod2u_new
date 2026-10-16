import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb, type FakeDb } from '@/test-support/postgrest-fake'

const authGetUser = vi.fn()
const authorizeOperation = vi.fn()
let db: FakeDb

// The real financeAllowed runs; only the S&A engine underneath is mocked.
vi.mock('@/lib/security-access/operation', () => ({
  authorizeOperation,
  organizationResource: (type: string, organizationId: string | null | undefined) => ({ type, organizationId: organizationId ?? null }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: authGetUser }, from: (table: string) => db.from(table) })),
}))

const YEAR = 'year-1'
const ORG = 'hq-org-1'
const ctx = (id = YEAR) => ({ params: Promise.resolve({ id }) })

const fixture = (organization_id: string | null = ORG) => createFakeDb({
  users: [{ id: 'user-1', organization_id, roles: { role_level: 10 } }],
  fiscal_years: [{ id: YEAR, status: 'open', start_date: '2026-01-01', end_date: '2026-12-31' }],
  gl_journals: [],
})
const writes = () => db.calls.filter(call => call.writes.length > 0).map(call => `${call.table}:${call.writes.join(',')}`)

const run = async (method: 'PUT' | 'DELETE', body?: unknown) => {
  const route = await import('./route')
  const request = new Request('http://localhost/x', { method, body: body === undefined ? undefined : JSON.stringify(body) })
  const response = await route[method](request, ctx())
  return { status: response.status, body: await response.json() }
}

describe.each(['PUT', 'DELETE'] as const)('%s /api/accounting/fiscal-years/[id] authorization', (method) => {
  const body = method === 'PUT' ? { fiscal_year_name: 'FY 2026' } : undefined

  beforeEach(() => {
    vi.clearAllMocks()
    db = fixture()
    authGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    authorizeOperation.mockResolvedValue({ decision: 'ALLOW' })
  })

  it("authorizes finance.settings.manage against the caller's own organization and proceeds", async () => {
    const result = await run(method, body)
    expect(result.status).toBe(200)
    expect(authorizeOperation).toHaveBeenCalledWith(expect.objectContaining({
      permission: 'finance.settings.manage',
      resource: { type: 'finance_company', organizationId: ORG },
    }))
    expect(writes()).toEqual([method === 'PUT' ? 'fiscal_years:update' : 'fiscal_years:delete'])
  })

  it('denies with 403 and writes nothing when S&A denies', async () => {
    authorizeOperation.mockResolvedValue({ decision: 'DENY' })
    expect((await run(method, body)).status).toBe(403)
    expect(writes()).toEqual([])
  })

  it('fails closed for a user without an organization', async () => {
    db = fixture(null)
    expect((await run(method, body)).status).toBe(403)
    expect(authorizeOperation).not.toHaveBeenCalled()
    expect(writes()).toEqual([])
  })

  it('rejects anonymous callers', async () => {
    authGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'missing' } })
    expect((await run(method, body)).status).toBe(401)
    expect(authorizeOperation).not.toHaveBeenCalled()
  })
})
