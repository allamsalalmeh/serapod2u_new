import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)

const authGetUser = vi.fn()
const checkPermissionForUser = vi.fn()
let setting: unknown = null
// sa_actor_may_assign_profile: per role id; 'missing' = the migration is not applied (function unknown), 'error' = the check failed.
let authority: Record<string, boolean | 'missing' | 'error'> = {}
const rpcCalls: Array<{ fn: string; args: any }> = []

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({ auth: { getUser: authGetUser } })) }))
vi.mock('@/lib/server/permissions', () => ({ checkPermissionForUser }))
vi.mock('@/lib/identity/provisioning', () => ({ provisionIdentity: vi.fn(), setIdentityAccountStatus: vi.fn(), updateIdentityAccess: vi.fn(), identityHistoryReferences: vi.fn() }))

const keysOf = (...k: string[]) => k.map(permission_key => ({ permission: { permission_key } }))
const ROLES = [
  { id: 'r-warehouse', name: 'Warehouse Operator', description: null, role_key: 'warehouse-operator', source: 'template' },
  { id: 'r-finance', name: 'Finance Full Access', description: null, role_key: 'finance-full-access', source: 'template' },
  { id: 'r-supply', name: 'Supply Chain Full Access', description: null, role_key: 'supply-chain-full-access', source: 'template' },
  { id: 'r-customer', name: 'Customer & Growth Full Access', description: null, role_key: 'customer-growth-full-access', source: 'template' },
  { id: 'r-secadmin', name: 'Security & Access Full Access', description: null, role_key: 'security-access-full-access', source: 'template' },
]
const EXTRA = [
  { id: 'r-warehouse', role_key: 'warehouse-operator', applicable_account_types: [], applicable_org_types: ['HQ', 'WH'], permissions: keysOf('inventory.stock_count.view') },
  { id: 'r-finance', role_key: 'finance-full-access', applicable_account_types: ['internal'], applicable_org_types: ['HQ'], permissions: keysOf('finance.ledger.view', 'finance.data.reset') },
  { id: 'r-supply', role_key: 'supply-chain-full-access', applicable_account_types: ['internal'], applicable_org_types: ['HQ'], permissions: keysOf('supply_chain.order.cancel', 'qr.batch.manage') },
  { id: 'r-customer', role_key: 'customer-growth-full-access', applicable_account_types: ['internal'], applicable_org_types: ['HQ'], permissions: keysOf('customer.crm.view') },
  { id: 'r-secadmin', role_key: 'security-access-full-access', applicable_account_types: ['internal'], applicable_org_types: ['HQ'], permissions: keysOf('security.access.view', 'security.role.assign') },
]
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => {
      if (table === 'sa_business_roles') {
        const chain: any = { select: () => chain, eq: () => chain, neq: () => chain, order: async () => ({ data: ROLES }), in: async () => ({ data: EXTRA, error: null }) }
        return chain
      }
      if (table === 'organizations') return { select: () => ({ eq: (c: string) => (c === 'id' ? { maybeSingle: async () => ({ data: { org_name: 'HQ', org_type_code: 'HQ' } }) } : Promise.resolve({ data: [] })), in: async () => ({ data: [] }) }) }
      if (table === 'sa_scope_definitions') { const c: any = { select: () => c, eq: () => c, in: () => c, neq: () => c, order: async () => ({ data: [] }) }; return c }
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: setting === null ? null : { setting_value: setting } }) }) }) }
    },
    rpc: vi.fn(async (fn: string, args: any) => {
      rpcCalls.push({ fn, args })
      if (fn !== 'sa_actor_may_assign_profile') return { data: true, error: null }
      const v = authority[args.p_role] ?? true
      return v === 'missing' ? { data: null, error: { code: 'PGRST202', message: 'function not found' } } : v === 'error' ? { data: null, error: { message: 'boom' } } : { data: v, error: null }
    }),
  })),
}))

beforeEach(() => { vi.clearAllMocks(); setting = null; authority = {}; rpcCalls.length = 0 })

describe('Add User → Group Policies (module Full Access)', () => {
  const names = (r: any) => r.profiles.map((p: any) => p.name)
  const admin = () => { authGetUser.mockResolvedValue({ data: { user: { id: 'sec-admin' } }, error: null }); checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 1 } }) }

  it('offers a sensitive policy only when the database says this administrator holds the same authority Grant Policy requires', async () => {
    admin()
    const { listInitialAccessRoles } = await import('@/lib/actions')
    const result: any = await listInitialAccessRoles('org-a')
    // Authorized actor (check returns true for the target organization): every applicable policy, module Full Access first.
    expect(names(result)).toEqual(['Supply Chain Full Access', 'Customer & Growth Full Access', 'Finance Full Access', 'Security & Access Full Access', 'Warehouse Operator'])
    expect(result.deferredProfiles).toEqual([])
    // Only the sensitive policies are asked about, each for THIS actor and THIS organization.
    expect(rpcCalls.filter(c => c.fn === 'sa_actor_may_assign_profile').map(c => c.args)).toEqual([
      { p_actor: 'sec-admin', p_role: 'r-finance', p_org: 'org-a' }, { p_actor: 'sec-admin', p_role: 'r-secadmin', p_org: 'org-a' }])
  })

  it('an actor without the sensitive permissions keeps those policies post-creation; Supply Chain and Customer & Growth are unaffected', async () => {
    admin(); authority = { 'r-finance': false, 'r-secadmin': false }
    const { listInitialAccessRoles } = await import('@/lib/actions')
    const result: any = await listInitialAccessRoles('org-a')
    expect(names(result)).toEqual(['Supply Chain Full Access', 'Customer & Growth Full Access', 'Warehouse Operator'])
    expect(result.deferredProfiles).toEqual([{ id: 'r-finance', name: 'Finance Full Access' }, { id: 'r-secadmin', name: 'Security & Access Full Access' }])
  })

  it('holding one sensitive policy’s permissions does not offer the other', async () => {
    admin(); authority = { 'r-finance': true, 'r-secadmin': false }
    const { listInitialAccessRoles } = await import('@/lib/actions')
    const result: any = await listInitialAccessRoles('org-a')
    expect(names(result)).toContain('Finance Full Access')
    expect(names(result)).not.toContain('Security & Access Full Access')
    expect(result.deferredProfiles).toEqual([{ id: 'r-secadmin', name: 'Security & Access Full Access' }])
  })

  it.each(['missing', 'error'] as const)('while the database rule is not applied or the check fails (%s) nothing sensitive is offered (never a UI-only change)', async state => {
    admin(); authority = { 'r-finance': state, 'r-secadmin': state }
    const { listInitialAccessRoles } = await import('@/lib/actions')
    const result: any = await listInitialAccessRoles('org-a')
    expect(names(result)).toEqual(['Supply Chain Full Access', 'Customer & Growth Full Access', 'Warehouse Operator'])
    expect(result.deferredProfiles.map((d: any) => d.id)).toEqual(['r-finance', 'r-secadmin'])
  })

  it('a non-level-1 administrator is offered nothing unless delegated administration is on and the explicit permission is held', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'delegated' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: false, context: { role_level: 10 } })
    const { listInitialAccessRoles } = await import('@/lib/actions')
    setting = false
    expect(((await listInitialAccessRoles('org-a')) as any).canAssign).toBe(false)
    setting = true                                              // opt-in rollout step; sa_actor_has_permission (mocked ALLOW) decides
    expect(((await listInitialAccessRoles('org-a')) as any).canAssign).toBe(true)
  })
})
