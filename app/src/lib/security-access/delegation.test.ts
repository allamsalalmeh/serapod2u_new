import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const checkPermissionForUser = vi.fn()
let settingValue: unknown = false
const rpc = vi.fn()
vi.mock('@/lib/server/permissions', () => ({ checkPermissionForUser }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { setting_value: settingValue }, error: null }) }) }) }), rpc }),
}))

beforeEach(() => { checkPermissionForUser.mockReset(); rpc.mockReset(); settingValue = false })

describe('delegated Security & Access administration (opt-in)', () => {
  it('legacy level-1 behaviour is unchanged and never needs the setting', async () => {
    checkPermissionForUser.mockResolvedValue({ allowed: true })
    const { legacyOrDelegatedSecurityAccess } = await import('./delegation')
    expect(await legacyOrDelegatedSecurityAccess('u1', 'org', 'security.role.assign')).toBe(true)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('is off by default: an explicit assignment alone does not satisfy the legacy rule', async () => {
    checkPermissionForUser.mockResolvedValue({ allowed: false })
    rpc.mockResolvedValue({ data: true, error: null })
    const { legacyOrDelegatedSecurityAccess } = await import('./delegation')
    expect(await legacyOrDelegatedSecurityAccess('u2', 'org', 'security.role.assign')).toBe(false)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('when enabled, an explicit in-scope S&A assignment counts, evaluated in the actor organization', async () => {
    checkPermissionForUser.mockResolvedValue({ allowed: false })
    settingValue = true
    rpc.mockResolvedValue({ data: true, error: null })
    const { legacyOrDelegatedSecurityAccess } = await import('./delegation')
    expect(await legacyOrDelegatedSecurityAccess('u2', 'org-1', 'security.audit.view')).toBe(true)
    expect(rpc).toHaveBeenCalledWith('sa_actor_has_permission', { p_actor: 'u2', p_permission: 'security.audit.view', p_context: { organization_id: 'org-1' } })
  })

  it('denies when the assignment is missing, out of scope, the evaluator errors, or there is no organization', async () => {
    checkPermissionForUser.mockResolvedValue({ allowed: false })
    settingValue = true
    const { legacyOrDelegatedSecurityAccess } = await import('./delegation')
    rpc.mockResolvedValue({ data: false, error: null })
    expect(await legacyOrDelegatedSecurityAccess('u3', 'org-1', 'security.role.assign')).toBe(false)
    rpc.mockResolvedValue({ data: null, error: { code: 'X' } })
    expect(await legacyOrDelegatedSecurityAccess('u3', 'org-1', 'security.role.assign')).toBe(false)
    rpc.mockRejectedValue(new Error('down'))
    expect(await legacyOrDelegatedSecurityAccess('u3', 'org-1', 'security.role.assign')).toBe(false)
    expect(await legacyOrDelegatedSecurityAccess('u3', null, 'security.role.assign')).toBe(false)
  })

  it('never widens a non-security permission (HR reset, finance, platform keep their own rules)', async () => {
    checkPermissionForUser.mockResolvedValue({ allowed: false })
    settingValue = true
    rpc.mockResolvedValue({ data: true, error: null })
    const { legacyOrDelegatedSecurityAccess } = await import('./delegation')
    for (const key of ['hr.data.reset', 'finance.data.reset', 'platform.data.destructive', 'platform.user.manage']) expect(await legacyOrDelegatedSecurityAccess('u2', 'org-1', key)).toBe(false)
  })
})
