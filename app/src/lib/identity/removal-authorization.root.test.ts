import { beforeEach, describe, expect, it, vi } from 'vitest'

// Archive Identities target protection for a Root Administrator: the legacy "only a Super Admin removes a Super Admin"
// rule does not bind a Root actor (dominance decides, where Root dominates every account); it still binds everyone else.
vi.mock('server-only', () => ({}))
const authorizeOperation = vi.fn()
const targetProtectionAllows = vi.fn()
const rpc = vi.fn()
const levels: Record<string, number> = { actor: 10, 'super-admin': 1, ordinary: 40 }
vi.mock('@/lib/security-access/operation', () => ({
  authorizeOperation,
  organizationResource: (type: string, organizationId: string | null, extra: object = {}) => ({ type, organizationId, ...extra }),
}))
vi.mock('@/lib/security-access/scope', () => ({ targetProtectionAllows }))
vi.mock('@/lib/security-access/authorization', () => ({ currentMigrationMode: vi.fn(async () => 'LEGACY_RETIRED') }))
vi.mock('./provisioning', () => ({ setIdentityAccountStatus: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc,
    from: () => ({ select: () => ({ eq: (_c: string, id: string) => ({
      maybeSingle: async () => ({ data: { id, organization_id: 'org-hq', roles: { role_level: levels[id] } }, error: null }),
    }) }) }),
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  authorizeOperation.mockResolvedValue({ decision: 'ALLOW', decisionId: 'd-1' })
  targetProtectionAllows.mockResolvedValue(true)
})

describe('authorizeIdentityRemoval with Root Access', () => {
  it('a Root Administrator (legacy level 10) may archive a Super Admin when dominance allows it', async () => {
    rpc.mockResolvedValue({ data: true, error: null })
    const { authorizeIdentityRemoval } = await import('./removal-authorization')
    expect(await authorizeIdentityRemoval('actor', 'super-admin')).toMatchObject({ ok: true })
    expect(rpc).toHaveBeenCalledWith('sa_actor_is_root', { p_actor: 'actor' })
  })

  it('a non-root level 10 administrator still cannot archive a Super Admin', async () => {
    rpc.mockResolvedValue({ data: false, error: null })
    const { authorizeIdentityRemoval } = await import('./removal-authorization')
    expect(await authorizeIdentityRemoval('actor', 'super-admin')).toMatchObject({ ok: false, code: 'target_protected' })
  })

  it('a failed Root read never relaxes the rule; dominance still decides for Root (e.g. a protected Root target)', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '57014' } })
    const { authorizeIdentityRemoval } = await import('./removal-authorization')
    expect(await authorizeIdentityRemoval('actor', 'super-admin')).toMatchObject({ ok: false, code: 'target_protected' })
    rpc.mockResolvedValue({ data: true, error: null })
    targetProtectionAllows.mockResolvedValue(false)
    expect(await authorizeIdentityRemoval('actor', 'ordinary')).toMatchObject({ ok: false, code: 'target_protected' })
  })
})
