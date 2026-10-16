import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const hrCan = vi.fn()
const queryCalls: string[] = []
vi.mock('@/lib/server/hrAccess', () => ({ hrCan }))
vi.mock('@/lib/identity/provisioning', () => ({ provisionIdentity: vi.fn() }))
vi.mock('@/lib/hr/onboarding', () => ({ resolveForOnboarding: vi.fn(), completeOnboarding: vi.fn(), ONBOARDING_BLOCK_MESSAGES: {} }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u-1' } }, error: null }) },
    from: (table: string) => {
      const chain: any = new Proxy({}, {
        get: (_t, prop: string) => {
          if (prop === 'single') return async () => ({ data: { organization_id: 'org-a', roles: { role_level: 50 } }, error: null })
          if (prop === 'then') return (resolve: any) => resolve({ data: [], error: null, count: 0 })
          return () => { queryCalls.push(`${table}.${prop}`); return chain }
        },
      })
      return chain
    },
  }),
}))

describe('GET /api/hr/employees (the employee directory)', () => {
  beforeEach(() => { vi.clearAllMocks(); queryCalls.length = 0 })

  it('is refused (403) without hr.employee.view, and no employee row is read', async () => {
    hrCan.mockResolvedValue(false)
    const { GET } = await import('./route')
    const res = await GET(new NextRequest('http://localhost/api/hr/employees'))
    expect(res.status).toBe(403)
    expect(hrCan).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-1', organizationId: 'org-a' }), 'hr.employee.view')
    expect(queryCalls).not.toContain('users.range') // the directory query never ran
  })

  it('lists employees for an HR viewer', async () => {
    hrCan.mockResolvedValue(true)
    const { GET } = await import('./route')
    const res = await GET(new NextRequest('http://localhost/api/hr/employees'))
    expect(res.status).toBe(200)
  })
})
