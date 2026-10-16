import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

describe('provisioning with Group Policies — database refusals', () => {
  it('returns the database refusal (nothing was created) when a profile does not apply or a scope is missing', async () => {
    const { mapIdentityDbError } = await import('./provisioning')
    expect(mapIdentityDbError({ message: 'sa_profile_not_applicable' })).toMatchObject({ ok: false, code: 'ROLE_GRANT_NOT_ALLOWED', status: 400 })
    expect(mapIdentityDbError({ message: 'sa_profile_sensitive_not_initial' }).message).toMatch(/Nothing was created/)
    expect(mapIdentityDbError({ message: 'sa_scope_required' })).toMatchObject({ code: 'INVALID_INPUT' })
    expect(mapIdentityDbError({ message: 'sa_initial_access_duplicate' })).toMatchObject({ code: 'INVALID_INPUT' })
    expect(mapIdentityDbError({ message: 'sod_violation: x' })).toMatchObject({ code: 'FORBIDDEN' })
  })

})
