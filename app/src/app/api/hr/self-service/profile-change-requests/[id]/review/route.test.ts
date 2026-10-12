import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const getHrAuthContext = vi.fn()
const hrCan = vi.fn()
const dbCalls: Array<[string, ...unknown[]]> = []
let singleResults: Record<string, any> = {}

const chain = (table: string): any => new Proxy({}, {
  get: (_t, prop: string) => {
    if (prop === 'then') return (resolve: any) => resolve({ data: [], error: null })
    if (prop === 'maybeSingle') return async () => singleResults[table] ?? { data: null, error: null }
    return (...args: unknown[]) => { dbCalls.push([`${table}.${prop}`, ...args]); return chain(table) }
  },
})
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => chain(t) }) }))
vi.mock('@/lib/server/hrAccess', () => ({ getHrAuthContext, hrCan }))

const ctx = { userId: 'hr-1', organizationId: 'org-hq', roleCode: 'HR', roleLevel: 10 }
const post = (id: string, body: object) => new NextRequest(`http://localhost/api/hr/self-service/profile-change-requests/${id}/review`, { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  dbCalls.length = 0
  singleResults = {}
  getHrAuthContext.mockResolvedValue({ success: true, data: ctx })
  hrCan.mockResolvedValue(true)
})

describe('POST /api/hr/self-service/profile-change-requests/[id]/review', () => {
  it('requires HR administration', async () => {
    hrCan.mockResolvedValue(false)
    const { POST } = await import('./route')
    expect((await POST(post('r1', { decision: 'approve' }), { params: Promise.resolve({ id: 'r1' }) })).status).toBe(403)
    expect(dbCalls).toHaveLength(0)
  })

  it('refuses self-review', async () => {
    singleResults.hr_profile_change_requests = { data: { id: 'r1', employee_user_id: 'hr-1', change_payload: { full_name: 'X' } }, error: null }
    const { POST } = await import('./route')
    const res = await POST(post('r1', { decision: 'approve' }), { params: Promise.resolve({ id: 'r1' }) })
    expect(res.status).toBe(403)
  })

  it('approves and applies only the permitted users columns in the same organization', async () => {
    singleResults.hr_profile_change_requests = { data: { id: 'r1', employee_user_id: 'emp-1', change_payload: { full_name: 'New', bank_account_number: '123', ic_number: 'SECRET' } }, error: null }
    const { POST } = await import('./route')
    const res = await POST(post('r1', { decision: 'approve' }), { params: Promise.resolve({ id: 'r1' }) })
    expect(res.status).toBe(200)

    // Applied to users, scoped to the employee and organization.
    expect(dbCalls.some(c => c[0] === 'users.update' && (c[1] as any)?.full_name === 'New' && (c[1] as any)?.bank_account_number === '123')).toBe(true)
    // ic_number is a sensitive request field but has no public.users column, so it is NOT applied.
    const updatePayloads = dbCalls.filter(c => c[0] === 'users.update').map(c => c[1])
    expect(JSON.stringify(updatePayloads)).not.toContain('ic_number')
    // The request row is marked approved with the reviewer + timestamps.
    expect(dbCalls.some(c => c[0] === 'hr_profile_change_requests.update' && (c[1] as any)?.status === 'approved' && (c[1] as any)?.reviewed_by === 'hr-1' && (c[1] as any)?.applied_at)).toBe(true)
  })

  it('rejects and records the reason without applying anything', async () => {
    singleResults.hr_profile_change_requests = { data: { id: 'r1', employee_user_id: 'emp-1', change_payload: { full_name: 'New' } }, error: null }
    const { POST } = await import('./route')
    const res = await POST(post('r1', { decision: 'reject', reason: 'needs docs' }), { params: Promise.resolve({ id: 'r1' }) })
    expect(res.status).toBe(200)
    expect(dbCalls.some(c => c[0] === 'users.update')).toBe(false)
    expect(dbCalls.some(c => c[0] === 'hr_profile_change_requests.update' && (c[1] as any)?.status === 'rejected' && (c[1] as any)?.rejection_reason === 'needs docs')).toBe(true)
  })

  it('rejects an invalid decision', async () => {
    singleResults.hr_profile_change_requests = { data: { id: 'r1', employee_user_id: 'emp-1', change_payload: { full_name: 'New' } }, error: null }
    const { POST } = await import('./route')
    expect((await POST(post('r1', { decision: 'maybe' }), { params: Promise.resolve({ id: 'r1' }) })).status).toBe(400)
  })
})
