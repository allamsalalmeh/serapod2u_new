import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const checkPermissionForUser = vi.fn()
let profile: any = null
let profileError: any = null
vi.mock('@/lib/server/permissions', () => ({ checkPermissionForUser }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: profileError }) }) }) }),
}) }))

const staff = (level: number, over: object = {}) => ({ principal_type: 'INTERNAL_EMPLOYEE', is_active: true, account_status: 'ACTIVE', roles: { role_level: level }, ...over })

beforeEach(() => {
  vi.clearAllMocks()
  checkPermissionForUser.mockResolvedValue({ allowed: false })
  profile = null
  profileError = null
})

describe('legacyFinanceModuleEntry (the /finance page guard\'s historical rule, shared with the sidebar)', () => {
  it('allows view_settings holders and active staff at level 40, denies level 50 without view_settings', async () => {
    const { legacyFinanceModuleEntry } = await import('./finance-access')
    profile = staff(40)
    expect(await legacyFinanceModuleEntry('u')).toBe(true)
    profile = staff(50)
    expect(await legacyFinanceModuleEntry('u')).toBe(false)
    checkPermissionForUser.mockResolvedValue({ allowed: true })
    expect(await legacyFinanceModuleEntry('u')).toBe(true)
    expect(checkPermissionForUser).toHaveBeenCalledWith('u', 'view_settings')
  })

  it('denies inactive or non-staff accounts by role level', async () => {
    const { legacyFinanceModuleEntry } = await import('./finance-access')
    profile = staff(10, { is_active: false })
    expect(await legacyFinanceModuleEntry('u')).toBe(false)
    profile = staff(10, { principal_type: 'CONSUMER' })
    expect(await legacyFinanceModuleEntry('u')).toBe(false)
  })

  it('a failed profile read throws (reported as unavailable by the caller), never an allow', async () => {
    const { legacyFinanceModuleEntry } = await import('./finance-access')
    profileError = { message: 'boom' }
    await expect(legacyFinanceModuleEntry('u')).rejects.toThrow()
  })
})
