import { beforeEach, describe, expect, it, vi } from 'vitest'
import { referenceAllowedForOrgType, referenceEligibilityError, REFERENCE_HQ_ONLY_MESSAGE } from './reference-eligibility'

describe('Reference eligibility rule', () => {
  it('allows HQ only', () => {
    expect(referenceAllowedForOrgType('HQ')).toBe(true)
    expect(referenceAllowedForOrgType(' hq ')).toBe(true)
    for (const t of ['MFG', 'DIST', 'SHOP', 'WH', '', null, undefined]) expect(referenceAllowedForOrgType(t as any)).toBe(false)
  })
  it('rejects only an enabled Reference on non-HQ', () => {
    expect(referenceEligibilityError(true, 'SHOP')).toBe(REFERENCE_HQ_ONLY_MESSAGE)
    expect(referenceEligibilityError(false, 'SHOP')).toBeNull()
    expect(referenceEligibilityError(undefined, 'SHOP')).toBeNull()
    expect(referenceEligibilityError(true, 'HQ')).toBeNull()
  })
})

// Isolated fixtures: every Supabase client is a mock; nothing touches a real database or auth user.
const authGetUser = vi.fn()
const adminRpc = vi.fn()
const createAuthUser = vi.fn()
const usersUpdate = vi.fn(() => ({ eq: async () => ({ error: null }) }))
let orgType = 'DIST'
vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({ auth: { getUser: authGetUser } })) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    auth: { admin: { updateUserById: vi.fn(async () => ({ data: { user: {} }, error: null })), createUser: createAuthUser, deleteUser: vi.fn() } },
    rpc: adminRpc,
    from: (table: string) => table === 'sa_root_access_grants'
      // Nobody in these fixtures holds Root Access (target protection passes).
      ? { select: () => ({ eq: () => ({ eq: async () => ({ data: [], error: null }) }) }) }
      : ({
      update: usersUpdate,
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === 'organizations' ? { org_type_code: orgType } : { organization_id: 'org-1', role_code: 'USER', is_active: true }, error: null }) }) }),
      }),
  })),
}))
vi.mock('@/lib/server/permissions', () => ({ checkPermissionForUser: vi.fn(async () => ({ allowed: true, context: { role_level: 1 } })) }))

const base = { email: 'a@example.test', full_name: 'A', phone: '0123456789', password: 'x-secret-1', organization_id: 'org-1' }

describe('server-side Reference eligibility (mocked fixtures)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    adminRpc.mockResolvedValue({ data: null, error: null })
  })

  it('rejects create with Reference for a non-HQ organization before any provisioning side effect', async () => {
    orgType = 'SHOP'
    const { createUserWithAuth } = await import('@/lib/actions')
    const result: any = await createUserWithAuth({ ...base, can_be_reference: true } as any)
    expect(result.success).toBe(false)
    expect(result.code).toBe('REFERENCE_HQ_ONLY')
    expect(result.error).toContain(REFERENCE_HQ_ONLY_MESSAGE)
    expect(createAuthUser).not.toHaveBeenCalled()
    expect(adminRpc).not.toHaveBeenCalled()
    expect(usersUpdate).not.toHaveBeenCalled()
  })

  it('does not reject create with Reference=false (guard passes; provisioning is reached)', async () => {
    orgType = 'SHOP'
    const { createUserWithAuth } = await import('@/lib/actions')
    const result: any = await createUserWithAuth({ ...base, can_be_reference: false } as any)
    expect(result.code).not.toBe('REFERENCE_HQ_ONLY')
  })

  it('rejects an edit that turns Reference on for a non-HQ user, using the stored organization type', async () => {
    orgType = 'MFG'
    const { updateUserWithAuth } = await import('@/lib/actions')
    const result: any = await updateUserWithAuth('target', { can_be_reference: true } as any)
    expect(result.success).toBe(false)
    expect(result.code).toBe('REFERENCE_HQ_ONLY')
    expect(usersUpdate).not.toHaveBeenCalled()
  })

  it('allows an edit for an HQ user and an edit that does not touch Reference on a non-HQ user', async () => {
    const { updateUserWithAuth } = await import('@/lib/actions')
    orgType = 'HQ'
    expect(((await updateUserWithAuth('target', { can_be_reference: true } as any)) as any).code).not.toBe('REFERENCE_HQ_ONLY')
    orgType = 'MFG'
    expect(((await updateUserWithAuth('target', { full_name: 'B' } as any)) as any).code).not.toBe('REFERENCE_HQ_ONLY')
  })
})
