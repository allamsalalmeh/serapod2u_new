import { describe, expect, it, vi } from 'vitest'

// Legacy-mode S&A double: authorizeOperation decides from the legacy evaluator
// (`orgType === 'HQ' && roleLevel <= 30`), exactly like production before a
// permission is cut over. This exercises the real gate wiring, not a stub.
const state = vi.hoisted(() => ({ profile: null as any }))

vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.profile, error: null }) }) }) }),
  }),
}))

import { authorizeEventManagement } from './auth'

describe('authorizeEventManagement (Marketing parent gate: marketing.module.view)', () => {
  it('allows an HQ user with role level <= 30 and derives the org id server-side', async () => {
    state.profile = { id: 'u1', organization_id: 'orgA', organizations: { org_type_code: 'HQ' }, roles: { role_level: 10 } }
    const result = await authorizeEventManagement('u1')
    expect(result.allowed).toBe(true)
    expect(result.orgId).toBe('orgA')
    expect(result.orgType).toBe('HQ')
  })

  it('denies a user whose organization is not HQ', async () => {
    state.profile = { id: 'u1', organization_id: 'orgA', organizations: { org_type_code: 'SH' }, roles: { role_level: 10 } }
    const result = await authorizeEventManagement('u1')
    expect(result.allowed).toBe(false)
  })

  it('denies an HQ user above role level 30', async () => {
    state.profile = { id: 'u1', organization_id: 'orgA', organizations: { org_type_code: 'HQ' }, roles: { role_level: 50 } }
    const result = await authorizeEventManagement('u1')
    expect(result.allowed).toBe(false)
  })

  it('denies when the user has no profile', async () => {
    state.profile = null
    const result = await authorizeEventManagement('u1')
    expect(result.allowed).toBe(false)
    expect(result.orgId).toBeNull()
  })

  it('denies when the profile has no organization id', async () => {
    state.profile = { id: 'u1', organization_id: null, organizations: null, roles: { role_level: 10 } }
    const result = await authorizeEventManagement('u1')
    expect(result.allowed).toBe(false)
    expect(result.orgId).toBeNull()
  })

  it('supports the organizations/roles relations when returned as arrays', async () => {
    state.profile = { id: 'u1', organization_id: 'orgA', organizations: [{ org_type_code: 'HQ' }], roles: [{ role_level: 5 }] }
    const result = await authorizeEventManagement('u1')
    expect(result.allowed).toBe(true)
    expect(result.orgId).toBe('orgA')
  })
})
