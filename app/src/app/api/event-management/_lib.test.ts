import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  user: null as any,
  authError: null as any,
  allowed: true,
  orgId: 'orgA',
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user }, error: state.authError }) } }),
}))
vi.mock('@/modules/event-management/lib/auth', () => ({
  authorizeEventManagement: async () => ({ allowed: state.allowed, orgId: state.allowed ? state.orgId : null, orgType: 'HQ', roleLevel: 10 }),
}))

import { requireMarketingUser } from './_lib'

describe('requireMarketingUser (admin API route gate)', () => {
  it('returns 401 when there is no authenticated user', async () => {
    state.user = null
    state.authError = null
    const result = await requireMarketingUser()
    expect(result.ok).toBe(false)
    expect((result as any).response.status).toBe(401)
  })

  it('returns 403 when the user lacks the Marketing parent permission', async () => {
    state.user = { id: 'u1' }
    state.authError = null
    state.allowed = false
    const result = await requireMarketingUser()
    expect(result.ok).toBe(false)
    expect((result as any).response.status).toBe(403)
  })

  it('returns the derived org id when authorized', async () => {
    state.user = { id: 'u1' }
    state.authError = null
    state.allowed = true
    state.orgId = 'orgA'
    const result = await requireMarketingUser()
    expect(result.ok).toBe(true)
    expect((result as any).userId).toBe('u1')
    expect((result as any).orgId).toBe('orgA')
  })
})
