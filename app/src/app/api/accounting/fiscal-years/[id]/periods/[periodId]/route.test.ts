import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb, type FakeDb } from '@/test-support/postgrest-fake'

const authGetUser = vi.fn()
const financeAllowed = vi.fn()
let db: FakeDb

vi.mock('@/lib/security-access/finance', () => ({ financeAllowed }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: authGetUser }, from: (table: string) => db.from(table) })),
}))

const YEAR = 'year-1'
const PERIOD = 'period-1'

// Next 16 hands route handlers `params` as a Promise.
const ctx = (id = YEAR, periodId = PERIOD) => ({ params: Promise.resolve({ id, periodId }) })
const put = async (body: unknown, context = ctx()) => {
  const { PUT } = await import('./route')
  const response = await PUT(new Request('http://localhost/x', { method: 'PUT', body: JSON.stringify(body) }), context)
  return { status: response.status, body: await response.json() }
}

describe('PUT /api/accounting/fiscal-years/[id]/periods/[periodId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db = createFakeDb({
      users: [{ id: 'user-1', roles: { role_level: 10 } }],
      fiscal_periods: [{ id: PERIOD, fiscal_year_id: YEAR, status: 'open', fiscal_years: { status: 'open' } }],
    })
    authGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    financeAllowed.mockResolvedValue(true)
  })

  it('rejects anonymous callers', async () => {
    authGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'missing' } })
    expect((await put({ status: 'closed' })).status).toBe(401)
  })

  it('rejects callers without finance.settings.manage', async () => {
    financeAllowed.mockResolvedValue(false)
    const result = await put({ status: 'closed' })
    expect(result.status).toBe(403)
    expect(financeAllowed).toHaveBeenCalledWith('user-1', 'finance.settings.manage', expect.any(Function), undefined)
  })

  it('looks the period up by both awaited route params', async () => {
    const result = await put({ status: 'closed' })
    expect(result.status).toBe(200)
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
