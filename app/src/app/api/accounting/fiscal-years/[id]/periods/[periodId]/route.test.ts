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
const PERIOD = 'period-1'
const ORG = 'hq-org-1'

// Next 16 hands route handlers `params` as a Promise.
const ctx = (id = YEAR, periodId = PERIOD) => ({ params: Promise.resolve({ id, periodId }) })
const put = async (body: unknown, context = ctx()) => {
  const { PUT } = await import('./route')
  const response = await PUT(new Request('http://localhost/x', { method: 'PUT', body: JSON.stringify(body) }), context)
  return { status: response.status, body: await response.json() }
}
const writes = () => db.calls.filter(call => call.writes.length > 0)

const fixture = (organization_id: string | null = ORG) => createFakeDb({
  users: [{ id: 'user-1', organization_id, roles: { role_level: 10 } }],
  fiscal_periods: [{ id: PERIOD, fiscal_year_id: YEAR, status: 'open', fiscal_years: { status: 'open' } }],
})

describe('PUT /api/accounting/fiscal-years/[id]/periods/[periodId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db = fixture()
    authGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    authorizeOperation.mockResolvedValue({ decision: 'ALLOW' })
  })

  it('rejects anonymous callers', async () => {
    authGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'missing' } })
    expect((await put({ status: 'closed' })).status).toBe(401)
    expect(authorizeOperation).not.toHaveBeenCalled()
  })

  it("authorizes finance.settings.manage against the caller's own organization", async () => {
    const result = await put({ status: 'closed' })
    expect(result.status).toBe(200)
    expect(authorizeOperation).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'user-1',
      permission: 'finance.settings.manage',
      resource: { type: 'finance_company', organizationId: ORG },
    }))
    const usersQuery = db.calls.find(call => call.table === 'users')!
    expect(usersQuery.select).toBe('organization_id, roles!inner(role_level)')
  })

  it('denies with 403 and writes nothing when S&A denies', async () => {
    authorizeOperation.mockResolvedValue({ decision: 'DENY' })
    expect((await put({ status: 'closed' })).status).toBe(403)
    expect(writes()).toEqual([])
  })

  it('fails closed for a user without an organization, without consulting S&A', async () => {
    db = fixture(null)
    expect((await put({ status: 'closed' })).status).toBe(403)
    expect(authorizeOperation).not.toHaveBeenCalled()
    expect(writes()).toEqual([])
  })

  it('fails closed when the S&A engine errors', async () => {
    authorizeOperation.mockRejectedValue(new Error('engine down'))
    expect((await put({ status: 'closed' })).status).toBe(403)
    expect(writes()).toEqual([])
  })

  it('looks the period up by both awaited route params', async () => {
    await put({ status: 'closed' })
    const lookup = db.calls.find(call => call.table === 'fiscal_periods' && call.writes.length === 0)!
    expect(lookup.filters).toEqual([
      { op: 'eq', column: 'id', value: PERIOD },
      { op: 'eq', column: 'fiscal_year_id', value: YEAR },
    ])
    const update = db.calls.find(call => call.table === 'fiscal_periods' && call.writes.includes('update'))!
    expect(update.filters).toEqual([{ op: 'eq', column: 'id', value: PERIOD }])
  })

  it('returns 404 when the period is not in that fiscal year', async () => {
    expect((await put({ status: 'closed' }, ctx('other-year'))).status).toBe(404)
  })

  it('keeps the status-transition rules', async () => {
    const result = await put({ status: 'future' })
    expect(result).toEqual({ status: 400, body: { error: 'Invalid status transition from open to future' } })
  })
})
