import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)

const authGetUser = vi.fn()
const checkPermissionForUser = vi.fn()
const provisionIdentity = vi.fn()
const roleFilters: Array<[string, string, unknown]> = []

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({ auth: { getUser: authGetUser } })) }))
vi.mock('@/lib/server/permissions', () => ({ checkPermissionForUser }))
vi.mock('@/lib/identity/provisioning', () => ({
  provisionIdentity, setIdentityAccountStatus: vi.fn(), updateIdentityAccess: vi.fn(), identityHistoryReferences: vi.fn(),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => {
      if (table === 'sa_business_roles') {
        const chain: any = {
          select: () => chain,
          eq: (c: string, v: unknown) => { roleFilters.push(['eq', c, v]); return chain },
          neq: (c: string, v: unknown) => { roleFilters.push(['neq', c, v]); return chain },
          order: async () => ({ data: [{ id: 'r-1', name: 'Order Approver', description: 'Approves orders', role_key: 'order-approver', source: 'template' }] }),
        }
        return chain
      }
      return { update: () => ({ eq: async () => ({ error: null }) }), select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }
    },
  })),
}))

beforeEach(() => {
  vi.clearAllMocks()
  roleFilters.length = 0
})

describe('Add User wizard — initial Security & Access role', () => {
  it('offers no roles to an administrator who may not assign roles', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: false, context: { role_level: 20 } })
    const { listInitialAccessRoles } = await import('@/lib/actions')
    expect(await listInitialAccessRoles('org-a')).toEqual({ success: true, roles: [], canAssign: false, legacyReadOnly: false })
    expect(roleFilters).toEqual([])
  })

  it('offers active business roles only — never compatibility (legacy-*) roles or the employee baseline', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'sec-admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 1 } })
    const { listInitialAccessRoles } = await import('@/lib/actions')
    const result = await listInitialAccessRoles('org-a')
    expect(result.roles).toEqual([{ id: 'r-1', name: 'Order Approver', description: 'Approves orders' }])
    expect(result.canAssign).toBe(true)
    expect(roleFilters).toEqual(expect.arrayContaining([
      ['eq', 'status', 'active'], ['neq', 'source', 'legacy'], ['neq', 'role_key', 'employee-self-service'],
    ]))
  })

  it('passes the chosen role to canonical provisioning as initial access (the database re-checks it)', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'sec-admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 1 } })
    provisionIdentity.mockResolvedValue({ ok: true, userId: 'u-1', outcome: 'CREATED', principalType: 'INTERNAL_EMPLOYEE' })
    const { createUserWithAuth } = await import('@/lib/actions')
    await createUserWithAuth({ email: 'x@y.test', password: 'p-123456', full_name: 'X', role_code: 'USER', organization_id: 'org-a',
      initial_role_id: 'r-1', initial_access_reason: 'Order approval duty' })
    expect(provisionIdentity).toHaveBeenCalledWith(expect.objectContaining({
      initialAccess: { roleId: 'r-1', reason: 'Order approval duty' }, source: 'user_management',
    }))
  })
})

describe('Add User wizard — several Access Profiles, each with its own scope', () => {
  it('passes every profile with its own scope to canonical provisioning (no shared or defaulted scope)', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'sec-admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 1 } })
    provisionIdentity.mockResolvedValue({ ok: true, userId: 'u-2', outcome: 'CREATED', principalType: 'INTERNAL_EMPLOYEE' })
    const { createUserWithAuth } = await import('@/lib/actions')
    await createUserWithAuth({ email: 'w@y.test', password: 'p-123456', full_name: 'W', role_code: 'USER', organization_id: 'org-a',
      initial_profiles: [{ role_id: 'r-wh', scope_id: 's-balakong' }, { role_id: 'r-rcv', scope_id: 's-alma' }], initial_access_reason: 'Warehouse duty' })
    const call = provisionIdentity.mock.calls.at(-1)![0]
    expect(call.initialProfiles).toEqual([
      { roleId: 'r-wh', scopeIds: ['s-balakong'], reason: 'Warehouse duty' },
      { roleId: 'r-rcv', scopeIds: ['s-alma'], reason: 'Warehouse duty' },
    ])
    expect(call.initialAccess).toBeUndefined()
  })

  it('keeps the offered role list shape and adds scopes/organization additively and tolerantly', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'sec-admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 1 } })
    const { listInitialAccessRoles } = await import('@/lib/actions')
    const result: any = await listInitialAccessRoles('org-a')
    expect(result.roles).toEqual([{ id: 'r-1', name: 'Order Approver', description: 'Approves orders' }])
    expect(result.scopes).toEqual([])                  // optional metadata failing never hides the roles
  })
})

describe('HR Add Employee — one form, identity resolved on the server', () => {
  const view = readFileSync(resolve(process.cwd(), 'src/components/hr/HrPeopleView.tsx'), 'utf8')
  it('has no "link existing or create new" decision, no role picker and no login-less option', () => {
    expect(view).not.toContain('Link Existing User')
    expect(view).not.toContain('Create New')
    expect(view).not.toContain('create_login')
    expect(view).not.toMatch(/<SelectItem value="staff">/)
    expect(view).not.toContain("role_code: addForm")
    expect(view).toContain('no duplicate is created')
  })
})

describe('Legacy compatibility moves under Security & Access (read-only)', () => {
  const route = readFileSync(resolve(process.cwd(), 'src/app/api/security-access/governance/route.ts'), 'utf8')
  const panel = readFileSync(resolve(process.cwd(), 'src/components/security-access/TechnicalAccessPanel.tsx'), 'utf8')
  it('serves the legacy role levels, compatibility roles and overrides from the governance read model only', () => {
    expect(route).toContain('legacyCompatibility: legacyCompatibilityView(')
    expect(route).toContain(".eq('source', 'legacy')")
    expect(route).not.toMatch(/\.(insert|update|upsert|delete)\(/)
  })
  it('renders a read-only table (no controls that write)', () => {
    const section = panel.slice(panel.indexOf('export function LegacyCompatibilityPanel'))
    expect(section).not.toMatch(/<button|onClick|fetch\(|<Switch|<Select/)
  })
})
