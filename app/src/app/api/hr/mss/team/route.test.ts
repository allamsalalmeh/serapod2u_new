import { beforeEach, describe, expect, it, vi } from 'vitest'

let user: any = { id: 'mgr-1' }
const loadNavActor = vi.fn()
const hrCan = vi.fn()
const dbCalls: Array<[string, ...unknown[]]> = []

const chain = (table: string): any => new Proxy({}, {
  get: (_t, prop: string) => {
    if (prop === 'then') return (resolve: any) => resolve({ data: [], error: null })
    return (...args: unknown[]) => { dbCalls.push([`${table}.${prop}`, ...args]); return chain(table) }
  },
})
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: user ? null : new Error('x') }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => chain(t) }) }))
vi.mock('@/lib/server/nav-access', () => ({ loadNavActor }))
vi.mock('@/lib/server/hrAccess', () => ({ hrCan }))

beforeEach(() => {
  vi.clearAllMocks()
  dbCalls.length = 0
  user = { id: 'mgr-1' }
  loadNavActor.mockResolvedValue({ userId: 'mgr-1', organizationId: 'org-hq', orgTypeCode: 'HQ', roleCode: 'GUEST', roleLevel: 50 })
  hrCan.mockResolvedValue(true)
})

describe('GET /api/hr/mss/team', () => {
  it.each([
    ['expired login', () => { user = null }, 401],
    ['no Manager Self-Service', () => hrCan.mockResolvedValue(false), 403],
  ])('%s', async (_name, arrange, status) => {
    arrange()
    const { GET } = await import('./route')
    const res = await GET()
    expect(res.status).toBe(status)
    expect(dbCalls).toHaveLength(0)
  })

  it('decides hr.mss.team_view on the manager\'s own organization', async () => {
    const { GET } = await import('./route')
    await GET()
    expect(hrCan).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'mgr-1', organizationId: 'org-hq' }),
      'hr.mss.team_view',
      expect.any(Function),
    )
  })

  it('scopes the directory to the manager\'s own current, active direct reports', async () => {
    const { GET } = await import('./route')
    await GET()
    expect(dbCalls).toContainEqual(['users.eq', 'organization_id', 'org-hq'])
    expect(dbCalls).toContainEqual(['users.eq', 'manager_user_id', 'mgr-1'])
    expect(dbCalls).toContainEqual(['users.eq', 'is_active', true])
    expect(dbCalls).toContainEqual(['users.eq', 'hr_employees.organization_id', 'org-hq'])
    expect(dbCalls).toContainEqual(['users.eq', 'hr_employees.onboarding_status', 'completed'])
    expect(dbCalls).toContainEqual(['users.in', 'hr_employees.status', ['active', 'probation']])
    // No employee id, user id or organization id is read from the request (GET has no such parameter).
    expect(JSON.stringify(dbCalls)).not.toMatch(/victim|other-org/)
  })
})
