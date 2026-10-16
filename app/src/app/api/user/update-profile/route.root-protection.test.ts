import { beforeEach, describe, expect, it, vi } from 'vitest'

// An administrator editing ANOTHER person's profile (the login phone is synced to Supabase Auth): a Root
// Administrator's account may be changed only by another Root Administrator.
const ADMIN = '11111111-1111-4111-8111-111111111111'
const ROOT_TARGET = '22222222-2222-4222-8222-222222222222'

const usersUpdate = vi.fn(() => ({ eq: async () => ({ error: null }) }))
const updateUserById = vi.fn(async () => ({ data: { user: {} }, error: null }))
let rootRows: any[] = []
let actorIsRoot = false

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: ADMIN } }, error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { role_code: 'SA', roles: { role_level: 1 } } }) }) }) }),
  }),
}))
vi.mock('@/lib/security-access/operation', () => ({ userAllowed: async () => true }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === 'sa_root_access_grants') return { select: () => ({ eq: () => ({ eq: async () => ({ data: rootRows, error: null }) }) }) }
      if (table === 'users') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { organization_id: 'org-hq' }, error: null }) }), neq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
          update: usersUpdate,
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
    rpc: async (fn: string) => (fn === 'sa_actor_is_root' ? { data: actorIsRoot, error: null } : { data: null, error: null }),
    auth: { admin: { getUserById: async () => ({ data: { user: { user_metadata: {} } } }), updateUserById, listUsers: async () => ({ data: { users: [] } }) } },
  }),
}))

const post = async (body: any) => {
  const { POST } = await import('./route')
  return POST({ json: async () => body } as any)
}

describe('POST /api/user/update-profile — Root Administrator target protection', () => {
  beforeEach(() => { vi.clearAllMocks(); rootRows = []; actorIsRoot = false })

  it('refuses a non-root administrator (even level 1) before any write', async () => {
    rootRows = [{ effective_until: null }]
    const res = await post({ userId: ROOT_TARGET, phone: '0123456789', full_name: 'Hijacked' })
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('ROOT_TARGET_PROTECTED')
    expect(updateUserById).not.toHaveBeenCalled()
    expect(usersUpdate).not.toHaveBeenCalled()
  })

  it('lets another Root Administrator through to the normal checks', async () => {
    rootRows = [{ effective_until: null }]
    actorIsRoot = true
    const res = await post({ userId: ROOT_TARGET, full_name: 'Renamed' })
    expect(res.status).not.toBe(403)
  })

  it('does not affect people without Root Access', async () => {
    const res = await post({ userId: ROOT_TARGET, full_name: 'Renamed' })
    expect(res.status).not.toBe(403)
  })
})
