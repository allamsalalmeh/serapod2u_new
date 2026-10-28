import { beforeEach, describe, expect, it, vi } from 'vitest'

// Stage 2D scope helpers: the legacy rule decides until the permission is
// enforced; then S&A (sa_readable_organizations / sa_actor_dominates) decides,
// and any failure yields nothing / denies.
let mode = 'SHADOW'
const rpc = vi.fn()
vi.mock('./authorization', () => ({ currentMigrationMode: async () => mode }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: (...args: any[]) => rpc(...args),
    from: () => ({ select: () => ({ in: async () => ({ data: [{ id: 'hq' }, { id: 'wh-1' }, { id: 'wh-9' }], error: null }) }) }),
  }),
}))

describe('readableOrganizations', () => {
  beforeEach(() => { rpc.mockReset() })

  it('uses the legacy rule while the permission is not enforced', async () => {
    mode = 'SHADOW'
    const { readableOrganizations } = await import('./scope')
    await expect(readableOrganizations('u', 'inventory.report.view', () => ({ all: true }))).resolves.toEqual({ all: true })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('uses the S&A readable set once enforced', async () => {
    mode = 'NEW_ENFORCED'
    rpc.mockResolvedValue({ data: ['hq', 'wh-1', 'shop-1'], error: null })
    const { readableOrganizations, canReadOrganization, readableOrganizationsOfTypes } = await import('./scope')
    const scope = await readableOrganizations('u', 'inventory.report.view', () => ({ all: true }))
    expect(scope).toEqual({ all: false, organizationIds: ['hq', 'wh-1', 'shop-1'] })
    expect(rpc).toHaveBeenCalledWith('sa_readable_organizations', { p_actor: 'u', p_permission: 'inventory.report.view' })
    expect(canReadOrganization(scope, 'wh-1')).toBe(true)
    expect(canReadOrganization(scope, 'wh-9')).toBe(false)
    await expect(readableOrganizationsOfTypes(scope, ['HQ', 'WH'])).resolves.toEqual(['hq', 'wh-1'])
  })

  it('keeps the legacy rule until the Stage 2D migration creates the function', async () => {
    mode = 'NEW_ENFORCED'
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    const { readableOrganizations } = await import('./scope')
    await expect(readableOrganizations('u', 'inventory.report.view', () => ({ all: true }))).resolves.toEqual({ all: true })
  })

  it('returns nothing when the S&A lookup fails (never the legacy "all")', async () => {
    mode = 'NEW_ENFORCED'
    rpc.mockResolvedValue({ data: null, error: { code: 'XX000' } })
    const { readableOrganizations } = await import('./scope')
    await expect(readableOrganizations('u', 'inventory.report.view', () => ({ all: true }))).resolves.toEqual({ all: false, organizationIds: [] })
  })

  it('an active Root Administrator resolves to global scope (all organizations)', async () => {
    mode = 'NEW_ENFORCED'
    rpc.mockImplementation(async (fn: string) => (
      fn === 'sa_actor_is_root'
        ? { data: true, error: null }
        : { data: ['hq', 'wh-1', 'shop-1'], error: null }
    ))
    const { readableOrganizations } = await import('./scope')
    await expect(readableOrganizations('root', 'platform.system_logs.view', () => ({ all: false, organizationIds: [] }))).resolves.toEqual({ all: true })
    expect(rpc).toHaveBeenCalledWith('sa_actor_is_root', { p_actor: 'root' })
  })

  it('LEGACY_RETIRED also resolves Root to global scope (legacy not consulted)', async () => {
    mode = 'LEGACY_RETIRED'
    rpc.mockImplementation(async (fn: string) => (
      fn === 'sa_actor_is_root'
        ? { data: true, error: null }
        : { data: ['hq'], error: null }
    ))
    const { readableOrganizations } = await import('./scope')
    await expect(readableOrganizations('root', 'platform.system_logs.view', () => ({ all: true }))).resolves.toEqual({ all: true })
  })

  it('a scoped non-Root actor stays scoped (never global)', async () => {
    mode = 'NEW_ENFORCED'
    rpc.mockImplementation(async (fn: string) => (
      fn === 'sa_actor_is_root'
        ? { data: false, error: null }
        : { data: ['hq', 'wh-1'], error: null }
    ))
    const { readableOrganizations } = await import('./scope')
    await expect(readableOrganizations('u', 'inventory.report.view', () => ({ all: true }))).resolves.toEqual({ all: false, organizationIds: ['hq', 'wh-1'] })
  })

  it('an expired or revoked Root is not global (sa_actor_is_root false)', async () => {
    mode = 'NEW_ENFORCED'
    rpc.mockImplementation(async (fn: string) => (
      fn === 'sa_actor_is_root'
        ? { data: false, error: null }
        : { data: ['hq'], error: null }
    ))
    const { readableOrganizations } = await import('./scope')
    await expect(readableOrganizations('u', 'platform.system_logs.view', () => ({ all: true }))).resolves.toEqual({ all: false, organizationIds: ['hq'] })
  })

  it('falls back to the S&A list when Root Access is not installed (no sa_actor_is_root)', async () => {
    mode = 'NEW_ENFORCED'
    rpc.mockImplementation(async (fn: string) => (
      fn === 'sa_actor_is_root'
        ? { data: null, error: { code: 'PGRST202' } }
        : { data: ['hq'], error: null }
    ))
    const { readableOrganizations } = await import('./scope')
    await expect(readableOrganizations('u', 'platform.system_logs.view', () => ({ all: true }))).resolves.toEqual({ all: false, organizationIds: ['hq'] })
  })
})

describe('targetProtectionAllows', () => {
  beforeEach(() => { rpc.mockReset() })

  it('uses the legacy hierarchy rule while the identity permission is in SHADOW', async () => {
    mode = 'SHADOW'
    const { targetProtectionAllows } = await import('./scope')
    await expect(targetProtectionAllows('a', 't', 'platform.identity.delete', () => false)).resolves.toBe(false)
    await expect(targetProtectionAllows('a', 't', 'platform.identity.delete', () => true)).resolves.toBe(true)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('requires the actor to cover every grant of the target once enforced', async () => {
    mode = 'NEW_ENFORCED'
    const { targetProtectionAllows } = await import('./scope')
    rpc.mockResolvedValue({ data: true, error: null })
    await expect(targetProtectionAllows('a', 't', 'platform.identity.delete', () => false)).resolves.toBe(true)
    expect(rpc).toHaveBeenCalledWith('sa_actor_dominates', { p_actor: 'a', p_target: 't' })
    rpc.mockResolvedValue({ data: false, error: null })
    await expect(targetProtectionAllows('a', 't', 'platform.identity.delete', () => true)).resolves.toBe(false)
    rpc.mockResolvedValue({ data: null, error: { code: 'X' } })
    await expect(targetProtectionAllows('a', 't', 'platform.identity.delete', () => true)).resolves.toBe(false)
  })
})
