import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let user: any
const loadNavActor = vi.fn()
const resolveDestinationAccess = vi.fn()
const getOwnOnboardingState = vi.fn()
const dbCalls: Array<[string, ...unknown[]]> = []
let rpcResult: any = { data: [], error: null }
let singleResults: Record<string, any> = {}

const chain = (table: string): any => new Proxy({}, {
  get: (_t, prop: string) => {
    if (prop === 'then') return (resolve: any) => resolve(rpcResult)
    if (prop === 'maybeSingle' || prop === 'single') return async () => singleResults[table] ?? { data: null, error: null }
    return (...args: unknown[]) => { dbCalls.push([`${table}.${prop}`, ...args]); return chain(table) }
  },
})
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: user ? null : new Error('x') }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => chain(t) }) }))
vi.mock('@/lib/server/nav-access', () => ({ loadNavActor, resolveDestinationAccess }))
vi.mock('@/lib/hr/onboarding', () => ({ getOwnOnboardingState }))

const req = (url: string) => new NextRequest(`http://localhost${url}`)

beforeEach(() => {
  vi.clearAllMocks()
  dbCalls.length = 0
  user = { id: 'u-1' }
  rpcResult = { data: [], error: null }
  singleResults = {}
  loadNavActor.mockResolvedValue({ userId: 'u-1', organizationId: 'org-hq', orgTypeCode: 'HQ', roleCode: 'GUEST', roleLevel: 50 })
  resolveDestinationAccess.mockResolvedValue({ state: 'allowed', destination: 'hr/my-workspace' })
  getOwnOnboardingState.mockResolvedValue('completed')
})

describe('requireSelfService boundary (shared by /me and /payslips)', () => {
  it.each([
    ['expired login', () => { user = null }, 401],
    ['no Employee Self-Service (e.g. a non-HQ account)', () => resolveDestinationAccess.mockResolvedValue({ state: 'denied' }), 403],
    ['permission check unavailable', () => resolveDestinationAccess.mockResolvedValue({ state: 'unavailable' }), 503],
    ['employee state unreadable', () => getOwnOnboardingState.mockResolvedValue('unknown'), 503],
  ])('%s', async (_name, arrange, status) => {
    arrange()
    const { GET } = await import('./me/route')
    expect((await GET()).status).toBe(status)
    expect(dbCalls).toHaveLength(0)
  })

  it('decides Employee Self-Service for the authenticated account only', async () => {
    const { GET } = await import('./me/route')
    await GET()
    expect(loadNavActor).toHaveBeenCalledWith('u-1')
    expect(resolveDestinationAccess).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-1' }), 'hr/my-workspace')
  })
})

describe('GET /api/hr/self-service/me', () => {
  it.each(['pending', 'reset', 'none'])('reports a pending employee setup (%s) and fabricates nothing', async state => {
    getOwnOnboardingState.mockResolvedValue(state)
    const { GET } = await import('./me/route')
    const res = await GET()
    expect(await res.json()).toEqual({ success: true, state: 'pending' })
    expect(dbCalls).toHaveLength(0) // no employment lookup, no silent link/creation
  })

  it('returns only the caller\'s own, non-sensitive employment details', async () => {
    singleResults.users = { data: { full_name: 'Ben', employee_no: 7, employment_type: 'full_time', employment_status: 'active', positions: { name: 'Lead' }, departments: { dept_name: 'Ops' }, manager: { full_name: 'Aisha' }, organizations: { org_name: 'HQ Sdn Bhd' }, email: 'ben@x.test', salary: 1 }, error: null }
    singleResults.hr_employees = { data: { hire_date: '2024-01-01', hire_date_confirmed: true }, error: null }
    const { GET } = await import('./me/route')
    const body = await (await GET()).json()
    expect(body.state).toBe('ready')
    expect(body.employment).toMatchObject({ name: 'Ben', jobTitle: 'Lead', department: 'Ops', manager: 'Aisha', hireDate: '2024-01-01' })
    expect(JSON.stringify(body)).not.toMatch(/ben@x\.test|salary/)
    expect(dbCalls).toContainEqual(['users.eq', 'id', 'u-1'])
    expect(dbCalls).toContainEqual(['hr_employees.eq', 'user_id', 'u-1'])
  })

  it('never presents an unconfirmed (login/creation) date as a hire date', async () => {
    singleResults.users = { data: { full_name: 'Ben', positions: null, departments: null, manager: null, organizations: null }, error: null }
    singleResults.hr_employees = { data: { hire_date: '2026-10-01', hire_date_confirmed: false }, error: null }
    const { GET } = await import('./me/route')
    expect((await (await GET()).json()).employment.hireDate).toBeNull()
  })
})

describe('GET /api/hr/self-service/payslips', () => {
  it('is blocked (409 pending) until the employee link is complete', async () => {
    getOwnOnboardingState.mockResolvedValue('pending')
    const { GET } = await import('./payslips/route')
    const res = await GET(req('/api/hr/self-service/payslips'))
    expect(res.status).toBe(409)
    expect(dbCalls).toHaveLength(0)
  })

  it('returns only the authenticated employee\'s items of published (approved/posted) runs in their own organization', async () => {
    const { GET } = await import('./payslips/route')
    const res = await GET(req('/api/hr/self-service/payslips?periodStart=2026-09-01&periodEnd=2026-09-30'))
    expect(res.status).toBe(200)
    expect(dbCalls).toContainEqual(['hr_payroll_run_items.eq', 'employee_user_id', 'u-1'])
    expect(dbCalls).toContainEqual(['hr_payroll_run_items.eq', 'organization_id', 'org-hq'])
    expect(dbCalls).toContainEqual(['hr_payroll_run_items.in', 'hr_payroll_runs.status', ['approved', 'posted']])
    const statuses = dbCalls.find(c => c[0] === 'hr_payroll_run_items.in')![2] as string[]
    expect(statuses).not.toContain('draft')
    expect(statuses).not.toContain('calculated')
  })

  it('ignores a manipulated employee/user/organization id in the query: ownership comes from the session only', async () => {
    const { GET } = await import('./payslips/route')
    await GET(req('/api/hr/self-service/payslips?employee_user_id=u-victim&user_id=u-victim&organization_id=org-other&id=item-9'))
    const flat = JSON.stringify(dbCalls)
    expect(flat).not.toContain('u-victim')
    expect(flat).not.toContain('org-other')
    expect(flat).not.toContain('item-9')
    expect(dbCalls).toContainEqual(['hr_payroll_run_items.eq', 'employee_user_id', 'u-1'])
  })

  it('rejects a malformed period instead of passing it to the query', async () => {
    const { GET } = await import('./payslips/route')
    expect((await GET(req("/api/hr/self-service/payslips?periodStart=2026-09-01' or 1=1"))).status).toBe(400)
  })
})
