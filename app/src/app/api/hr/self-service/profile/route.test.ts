import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const requireSelfService = vi.fn()
const dbCalls: Array<[string, ...unknown[]]> = []
let singleResults: Record<string, any> = {}

const chain = (table: string): any => new Proxy({}, {
  get: (_t, prop: string) => {
    if (prop === 'then') return (resolve: any) => resolve({ data: [], error: null })
    if (prop === 'maybeSingle') return async () => singleResults[table] ?? { data: null, error: null }
    return (...args: unknown[]) => { dbCalls.push([`${table}.${prop}`, ...args]); return chain(table) }
  },
})
vi.mock('@/lib/server/hr/self-service', () => ({ requireSelfService, noStore: { 'Cache-Control': 'no-store' } }))

const actor = { userId: 'emp-1', organizationId: 'org-hq' }
const patch = (body: object) => new NextRequest('http://localhost/api/hr/self-service/profile', { method: 'PATCH', body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  dbCalls.length = 0
  singleResults = { users: { data: { address: 'Old Address' }, error: null } }
  requireSelfService.mockResolvedValue({ ok: true, actor, admin: { from: (t: string) => chain(t) } })
})

describe('PATCH /api/hr/self-service/profile (Category A)', () => {
  it('validates the address and rejects salary/payroll fields (they are never editable here)', async () => {
    const { PATCH } = await import('./route')
    expect((await PATCH(patch({ address: '' }))).status).toBe(400)
    // A body naming salary/bank/etc. is ignored: only `address` is read and validated.
    const res = await PATCH(patch({ address: 'New Address', basic_salary: 99999, bank_account_number: 'X' }))
    expect(res.status).toBe(200)
    const updatePayloads = dbCalls.filter(c => c[0] === 'users.update').map(c => c[1])
    expect(JSON.stringify(updatePayloads)).not.toMatch(/basic_salary|bank_account_number/)
    expect(updatePayloads[0]).toEqual({ address: 'New Address' })
  })

  it('updates only the caller\'s own record and writes an audit row with before/after values', async () => {
    const { PATCH } = await import('./route')
    const res = await PATCH(patch({ address: 'New Address' }))
    expect(res.status).toBe(200)
    // Own record only: the user id is the authenticated account, never a request parameter.
    expect(dbCalls.some(c => c[0] === 'users.eq' && c[1] === 'id' && c[2] === 'emp-1')).toBe(true)
    expect(dbCalls.some(c => c[0] === 'users.eq' && c[1] === 'organization_id' && c[2] === 'org-hq')).toBe(true)
    const audit = dbCalls.find(c => c[0] === 'hr_profile_edit_audit.insert')
    expect(audit?.[1]).toMatchObject({ field: 'address', before_value: 'Old Address', after_value: 'New Address', changed_by: 'emp-1' })
  })

  it('requires Employee Self-Service and a ready employee', async () => {
    requireSelfService.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 }) })
    const { PATCH } = await import('./route')
    expect((await PATCH(patch({ address: 'X' }))).status).toBe(403)
    expect(dbCalls).toHaveLength(0)
  })
})
