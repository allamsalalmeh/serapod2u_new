import { beforeEach, describe, expect, it, vi } from 'vitest'

let user: any = { id: 'mgr-1' }
const loadNavActor = vi.fn()
const hrCan = vi.fn()
const dbCalls: Array<[string, ...unknown[]]> = []
let tableResults: Record<string, any> = {}

// Each client's queries are recorded with a `session.` or `admin.` prefix so the test can prove that the sensitive
// compensation reads go through the caller's OWN session (RLS-enforced), never the service role.
const chain = (prefix: string, table: string): any => new Proxy({}, {
  get: (_t, prop: string) => {
    if (prop === 'then') return (resolve: any) => resolve(tableResults[table] ?? { data: [], error: null })
    return (...args: unknown[]) => { dbCalls.push([`${prefix}.${table}.${prop}`, ...args]); return chain(prefix, table) }
  },
})
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: user ? null : new Error('x') }) }, from: (t: string) => chain('session', t) }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => chain('admin', t) }) }))
vi.mock('@/lib/server/nav-access', () => ({ loadNavActor }))
vi.mock('@/lib/server/hrAccess', () => ({ hrCan }))

const reports = [{ id: 'emp-1', full_name: 'Amina', employee_no: 3, employment_status: 'active', positions: { name: 'Analyst' }, departments: { dept_name: 'Ops' } }]

beforeEach(() => {
  vi.clearAllMocks()
  dbCalls.length = 0
  tableResults = { users: { data: reports, error: null }, hr_employee_compensation: { data: [], error: null }, hr_employee_allowances: { data: [], error: null } }
  user = { id: 'mgr-1' }
  loadNavActor.mockResolvedValue({ userId: 'mgr-1', organizationId: 'org-hq', orgTypeCode: 'HQ', roleCode: 'GUEST', roleLevel: 50 })
  hrCan.mockImplementation(async (_ctx: any, perm: string) => perm === 'hr.compensation.salary_view')
})

describe('GET /api/hr/mss/compensation', () => {
  it('is denied when the caller holds neither compensation viewer permission', async () => {
    hrCan.mockImplementation(async () => false)
    const { GET } = await import('./route')
    expect((await GET()).status).toBe(403)
    expect(dbCalls).toHaveLength(0)
  })

  it('reads compensation through the caller session (RLS), never the service role', async () => {
    hrCan.mockImplementation(async (_ctx: any, perm: string) => true)
    const { GET } = await import('./route')
    expect((await GET()).status).toBe(200)

    // Sensitive compensation reads use the SESSION client (so RLS applies), not the admin client.
    expect(dbCalls).toContainEqual(['session.hr_employee_compensation.select', 'employee_id, basic_salary, effective_date, currency'])
    expect(dbCalls).toContainEqual(['session.hr_employee_allowances.select', 'employee_id, amount, currency, allowance_type_id'])
    expect(JSON.stringify(dbCalls)).not.toMatch(/admin\.hr_employee_(compensation|allowances)/)

    // No employee id is passed to the compensation queries: the database (RLS) restricts to direct reports.
    expect(JSON.stringify(dbCalls)).not.toMatch(/hr_employee_compensation\.in|hr_employee_allowances\.in/)

    // The non-sensitive directory names still come from the admin client, scoped to the manager relationship.
    expect(dbCalls).toContainEqual(['admin.users.eq', 'manager_user_id', 'mgr-1'])
    expect(dbCalls).toContainEqual(['admin.users.eq', 'organization_id', 'org-hq'])
  })

  it('returns only salary when only salary.view is held, and never fabricates allowances', async () => {
    // hrCan default: salary.view true, allowance.view false
    tableResults.hr_employee_compensation = { data: [{ employee_id: 'emp-1', basic_salary: 4500, currency: 'MYR' }], error: null }
    const { GET } = await import('./route')
    const body = await (await GET()).json()
    expect(body.data[0]).toMatchObject({ userId: 'emp-1', fullName: 'Amina', basicSalary: 4500 })
    expect(body.data[0].allowances).toBeUndefined()
    // No allowance query was issued.
    expect(JSON.stringify(dbCalls)).not.toContain('hr_employee_allowances')
  })

  it('never returns payslip, net salary, banking, deductions or payroll-run data even when authorized', async () => {
    hrCan.mockImplementation(async (_ctx: any, perm: string) => true)
    tableResults.hr_employee_compensation = { data: [{ employee_id: 'emp-1', basic_salary: 4500, net_amount: 999999, bank_account: 'SECRET', epf_employee: 1 }], error: null }
    const { GET } = await import('./route')
    const body = await (await GET()).json()
    const text = JSON.stringify(body)
    expect(text).toContain('basicSalary')
    expect(text).not.toMatch(/net_amount|netSalary|bank|epf|socso|pcb|deduction|payslip/)
    // Only the whitelisted compensation columns are selected.
    expect(dbCalls).toContainEqual(['session.hr_employee_compensation.select', 'employee_id, basic_salary, effective_date, currency'])
  })
})
