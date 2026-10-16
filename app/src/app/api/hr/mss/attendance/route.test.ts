import { beforeEach, describe, expect, it, vi } from 'vitest'

let user: any = { id: 'mgr-1' }
const loadNavActor = vi.fn()
const hrCan = vi.fn()
const dbCalls: Array<[string, ...unknown[]]> = []
let tableResults: Record<string, any> = {}

const chain = (table: string): any => new Proxy({}, {
  get: (_t, prop: string) => {
    if (prop === 'then') return (resolve: any) => resolve(tableResults[table] ?? { data: [], error: null })
    return (...args: unknown[]) => { dbCalls.push([`${table}.${prop}`, ...args]); return chain(table) }
  },
})
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: user ? null : new Error('x') }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => chain(t) }) }))
vi.mock('@/lib/server/nav-access', () => ({ loadNavActor }))
vi.mock('@/lib/server/hrAccess', () => ({ hrCan }))

const reports = [{ id: 'emp-1', full_name: 'Amina', employee_no: 3, employment_status: 'active' }]

beforeEach(() => {
  vi.clearAllMocks()
  dbCalls.length = 0
  tableResults = { users: { data: reports, error: null }, hr_attendance_entries: { data: [], error: null } }
  user = { id: 'mgr-1' }
  loadNavActor.mockResolvedValue({ userId: 'mgr-1', organizationId: 'org-hq', orgTypeCode: 'HQ', roleCode: 'GUEST', roleLevel: 50 })
  hrCan.mockResolvedValue(true)
})

describe('GET /api/hr/mss/attendance', () => {
  it('requires hr.mss.attendance_view', async () => {
    hrCan.mockResolvedValue(false)
    const { GET } = await import('./route')
    expect((await GET()).status).toBe(403)
    expect(dbCalls).toHaveLength(0)
  })

  it('scopes attendance to the manager\'s own direct reports, never a client id', async () => {
    const { GET } = await import('./route')
    await GET()
    expect(hrCan).toHaveBeenCalledWith(expect.objectContaining({ userId: 'mgr-1', organizationId: 'org-hq' }), 'hr.mss.attendance_view', expect.any(Function))
    expect(dbCalls).toContainEqual(['hr_attendance_entries.eq', 'organization_id', 'org-hq'])
    expect(dbCalls).toContainEqual(['hr_attendance_entries.in', 'user_id', ['emp-1']])
    // No other employee id is ever read from the request.
    expect(JSON.stringify(dbCalls)).not.toMatch(/victim|other-org/)
  })
})
