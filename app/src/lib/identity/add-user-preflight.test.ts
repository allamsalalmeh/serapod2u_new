import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Add User preflight versus execution. The engine double answers per (organization, permission), the way the database
 * evaluator does: an actor's authority reaches an organization only through a membership in its hierarchy.
 */
type Answer = 'ALLOW' | 'MISSING_MEMBERSHIP' | 'MISSING_ASSIGNMENT' | 'SCOPE_MISMATCH' | 'POLICY_ERROR' | 'THROW'
let engine: Record<string, Partial<Record<string, Answer>>> = {}
const asked: Array<[string, string | null | undefined]> = []

const decide = async (req: any) => {
  const org = req.resource?.organizationId
  asked.push([req.permission, org])
  const a = engine[org]?.[req.permission] ?? 'MISSING_MEMBERSHIP'
  if (a === 'THROW') throw new Error('engine down')
  return a === 'ALLOW' ? { decision: 'ALLOW', reasonCode: 'ALLOWED_BY_ASSIGNMENT', decisionId: 'd' } : { decision: 'DENY', reasonCode: a, decisionId: 'd' }
}
vi.mock('@/lib/security-access/operation', () => ({
  authorizeOperation: decide,
  userAllowed: async (_u: string, permission: string, _l: unknown, opts: any) => (await decide({ permission, resource: { organizationId: opts?.organizationId } })).decision === 'ALLOW',
  organizationResource: (type: string, organizationId: string | null) => ({ type, organizationId }),
}))

const authGetUser = vi.fn()
const checkPermissionForUser = vi.fn()
const provisionIdentity = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({ auth: { getUser: authGetUser } })) }))
vi.mock('@/lib/server/permissions', () => ({ checkPermissionForUser }))
vi.mock('@/lib/identity/provisioning', () => ({ provisionIdentity, setIdentityAccountStatus: vi.fn(), updateIdentityAccess: vi.fn(), identityHistoryReferences: vi.fn() }))

const ORG_TYPES: Record<string, string> = { hq: 'HQ', mfg: 'MFG', dist: 'DIST', shop: 'SHOP' }
const ROLE = (id: string, role_key: string, extra: any = {}) => ({ id, name: role_key, description: null, role_key, source: 'template', ...extra })
const perms = (...keys: string[]) => keys.map(k => ({ permission: { permission_key: k } }))
const ROLES = [
  // Eligibility as classified by 20261030100000 (explicit organization types; none listed = grantable nowhere).
  ROLE('r-wh', 'warehouse-operator', { applicable_org_types: ['HQ', 'WH'] }), ROLE('r-ess', 'employee-self-service', { applicable_org_types: ['HQ'] }),
  ROLE('r-order', 'order-creator', { applicable_org_types: ['HQ', 'DIST', 'SHOP'], permissions: perms('supply_chain.order.create') }),
  ROLE('r-unclassified', 'custom-without-types', { source: 'new', permissions: perms('inventory.stock_count.view') }),
  ROLE('r-mf', 'manufacturing-operator', { applicable_org_types: ['MFG'], permissions: perms('manufacturing.production.manage', 'manufacturing.scan.reverse') }),
  ROLE('r-mixed', 'manufacturing-plus-finance', { applicable_org_types: ['MFG'], permissions: perms('manufacturing.production.manage', 'finance.report.view') }),
  ROLE('r-open', 'adjustment-administrator', { applicable_org_types: ['HQ'], permissions: perms('manufacturing.adjustment.administer') }),
  ROLE('r-internal', 'supply-chain-full-access', { applicable_account_types: ['internal'], applicable_org_types: ['HQ'], permissions: perms('manufacturing.production.manage', 'inventory.stock.view') }),
]
let inSizes: number[] = []
let failTable: string | null = null
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => {
      let eqId: string | null = null
      const result = () => {
        if (failTable === table) return { data: null, error: { code: 'XX000', message: 'boom' } }
        if (table === 'sa_business_roles') return { data: ROLES.map(r => ({ applicable_account_types: [], applicable_org_types: [], permissions: [], ...r })), error: null }
        if (table === 'sa_scope_definitions') return { data: [{ id: 's1', organization_id: eqId, scope_type: 'organization', display_name: 'Org' }], error: null }
        if (table === 'organizations') return { data: [{ id: 'mfg', org_name: 'M' }], error: null }
        return { data: null, error: null }
      }
      const chain: any = {
        select: () => chain, neq: () => chain, order: () => chain, in: (_c: string, v: unknown[]) => { inSizes.push(v.length); return chain },
        eq: (c: string, v: string) => { if (c === 'id' || c === 'organization_id') eqId = v; return chain },
        maybeSingle: async () => table === 'sa_business_roles' ? { data: { role_key: eqId === '00000000-0000-4000-8000-000000000003' ? 'employee-self-service' : 'warehouse-operator' }, error: null } : table === 'organizations' ? { data: { org_name: 'Org', org_type_code: ORG_TYPES[eqId ?? ''] ?? 'HQ' }, error: null } : { data: table === 'sa_settings' ? { setting_value: false } : null, error: null },
        then: (resolve: any) => resolve(result()),
      }
      return chain
    },
    rpc: vi.fn(async () => ({ data: true, error: null })),
  })),
}))

beforeEach(() => {
  vi.clearAllMocks(); asked.length = 0; failTable = null; inSizes = []
  authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
  checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 1 } })
  provisionIdentity.mockResolvedValue({ ok: true, userId: 'u-1', outcome: 'CREATED', principalType: 'INTERNAL_EMPLOYEE' })
  engine = {}
})
const allow = (...orgs: string[]) => { for (const o of orgs) engine[o] = { 'platform.user.manage': 'ALLOW', 'security.role.assign': 'ALLOW' } }

describe('listInitialAccessRoles — preflight states', () => {
  it('an administrator whose authority reaches HQ and non-HQ organizations may choose eligible policies in each (ESS only for HQ)', async () => {
    allow('hq', 'mfg', 'dist', 'shop')
    const { listInitialAccessRoles } = await import('@/lib/actions')
    for (const org of ['hq', 'mfg', 'dist', 'shop']) {
      const r: any = await listInitialAccessRoles(org)
      expect(r).toMatchObject({ success: true, canAssign: true, essAllowed: org === 'hq' })
      expect(r.denial).toBeUndefined()
      const keys = r.profiles.map((p: any) => p.roleKey)
      if (org === 'mfg') expect(keys).toEqual(['manufacturing-operator'])
      else if (org === 'hq') expect(keys).toEqual(expect.arrayContaining(['warehouse-operator', 'order-creator']))
      else expect(keys).toEqual(['order-creator'])   // Distributor / Shop: only policies that list them; HQ policies never leak
      expect(keys).not.toContain('custom-without-types')   // unclassified = grantable nowhere
      if (org !== 'hq') expect(r.profiles.map((p: any) => p.roleKey)).not.toContain('employee-self-service')   // filtered for non-HQ
    }
  })

  it('a Manufacturer is offered only Manufacturing-only policies designated for it (no mixed, unrestricted or internal-only policy), exactly as published', async () => {
    allow('mfg', 'hq')
    const { listInitialAccessRoles } = await import('@/lib/actions')
    const r: any = await listInitialAccessRoles('mfg')
    expect(r.profiles).toHaveLength(1)
    expect(r.profiles[0]).toMatchObject({ roleKey: 'manufacturing-operator', permissionCount: 2 })
    const hq: any = await listInitialAccessRoles('hq')
    expect(hq.profiles.map((p: any) => p.roleKey)).toEqual(expect.arrayContaining(['supply-chain-full-access', 'adjustment-administrator', 'warehouse-operator']))
    expect(hq.profiles.map((p: any) => p.roleKey)).not.toContain('manufacturing-operator')   // partner-only policy never offered to HQ
  })

  it('lists ineligible policies with why, so the picker can explain the gap', async () => {
    allow('shop')
    const { listInitialAccessRoles } = await import('@/lib/actions')
    const r: any = await listInitialAccessRoles('shop')
    const why = new Map(r.ineligibleProfiles.map((p: any) => [p.name, p.code]))
    expect(why.get('warehouse-operator')).toBe('ORG_TYPE_NOT_ELIGIBLE')
    expect(why.get('custom-without-types')).toBe('POLICY_UNCLASSIFIED')
    expect(r.eligibilityModel).toBe('org_type')
  })

  it('a large organization hierarchy is read in bounded id lists (no oversized request URI)', async () => {
    allow('hq')
    const { listInitialAccessRoles } = await import('@/lib/actions')
    expect(await listInitialAccessRoles('hq')).toMatchObject({ success: true, canAssign: true })
    expect(Math.max(...inSizes)).toBeLessThanOrEqual(100)
  })

  it('a confirmed denial names the actual restriction (organization outside the actor’s hierarchy) and blocks creation', async () => {
    allow('hq')                                   // mfg: no membership path → MISSING_MEMBERSHIP for both permissions
    const { listInitialAccessRoles } = await import('@/lib/actions')
    const r: any = await listInitialAccessRoles('mfg')
    expect(r).toMatchObject({ success: true, canAssign: false, roles: [], denial: { permission: 'platform.user.manage', code: 'MISSING_MEMBERSHIP', cannotCreate: true } })
    expect(r.denial.reason).toMatch(/does not reach this organization/)
    expect(r.failed).toBeUndefined()
  })

  it('a delegated administrator stays limited to the organizations and permissions they hold', async () => {
    engine.dist = { 'platform.user.manage': 'ALLOW', 'security.role.assign': 'ALLOW' }
    engine.shop = { 'platform.user.manage': 'ALLOW', 'security.role.assign': 'SCOPE_MISMATCH' }
    const { listInitialAccessRoles } = await import('@/lib/actions')
    expect(await listInitialAccessRoles('dist')).toMatchObject({ canAssign: true })
    const shop: any = await listInitialAccessRoles('shop')
    expect(shop).toMatchObject({ canAssign: false, denial: { permission: 'security.role.assign', cannotCreate: false } })     // may create, may not assign
    expect(await listInitialAccessRoles('mfg')).toMatchObject({ canAssign: false, denial: { cannotCreate: true } })
  })

  it('an unauthorized administrator remains denied', async () => {
    engine.hq = { 'platform.user.manage': 'MISSING_ASSIGNMENT', 'security.role.assign': 'MISSING_ASSIGNMENT' }
    const { listInitialAccessRoles } = await import('@/lib/actions')
    expect(await listInitialAccessRoles('hq')).toMatchObject({ canAssign: false, roles: [], denial: { cannotCreate: true } })
  })

  it.each(['POLICY_ERROR', 'THROW'] as const)('an engine failure (%s) is a failed check — never a denial, nothing offered', async (answer) => {
    engine.hq = { 'platform.user.manage': answer, 'security.role.assign': 'ALLOW' }
    const { listInitialAccessRoles } = await import('@/lib/actions')
    const r: any = await listInitialAccessRoles('hq')
    expect(r).toMatchObject({ success: false, failed: true, failedStage: 'engine', canAssign: false, roles: [] })
    expect(r.denial).toBeUndefined()
  })

  it.each(['sa_business_roles', 'sa_scope_definitions'])('a failed %s read is a failed check, not "no policies / no scope"', async (table) => {
    allow('hq'); failTable = table
    const { listInitialAccessRoles } = await import('@/lib/actions')
    expect(await listInitialAccessRoles('hq')).toMatchObject({ success: false, failed: true, failedStage: table === 'sa_business_roles' ? 'catalogue' : 'scopes' })
  })

  it('a Manufacturer whose policy metadata cannot be read fails closed (never the unfiltered role list)', async () => {
    allow('mfg')
    const { listInitialAccessRoles } = await import('@/lib/actions')
    failTable = 'organizations'
    expect(await listInitialAccessRoles('mfg')).toMatchObject({ success: false, failed: true })
  })

  it('an unauthenticated caller is a failed check, not a denial', async () => {
    authGetUser.mockResolvedValue({ data: { user: null }, error: null })
    const { listInitialAccessRoles } = await import('@/lib/actions')
    expect(await listInitialAccessRoles('hq')).toMatchObject({ success: false, failed: true })
  })
})

describe('preflight and execution agree', () => {
  const create = async (org: string) => {
    const { createUserWithAuth } = await import('@/lib/actions')
    return createUserWithAuth({ email: 'x@y.test', password: 'p-123456', full_name: 'X', organization_id: org })
  }

  it('asks the engine the same permission about the same target organization, and agrees on allow and deny', async () => {
    allow('dist')
    const { listInitialAccessRoles } = await import('@/lib/actions')
    for (const org of ['dist', 'mfg']) {
      asked.length = 0
      const pre: any = await listInitialAccessRoles(org)
      const preAsked = asked.filter(([p]) => p === 'platform.user.manage')
      asked.length = 0
      const exec: any = await create(org)
      expect(asked.filter(([p]) => p === 'platform.user.manage').slice(0, 1)).toEqual(preAsked.slice(0, 1))
      expect(Boolean(pre.denial?.cannotCreate)).toBe(!exec.success)
    }
    expect(provisionIdentity).toHaveBeenCalledTimes(1)
  })

  it('execution re-authorizes and explains a denial with the same reason, before any side effect', async () => {
    const result: any = await create('mfg')
    expect(result).toMatchObject({ success: false, code: 'FORBIDDEN' })
    expect(result.error).toMatch(/does not reach this organization/)
    expect(provisionIdentity).not.toHaveBeenCalled()
  })

  it('a preflight allowance is never trusted: if authority is gone at submission, creation is refused', async () => {
    allow('dist')
    const { listInitialAccessRoles } = await import('@/lib/actions')
    expect(await listInitialAccessRoles('dist')).toMatchObject({ canAssign: true })
    engine.dist = {}                                   // revoked between the check and the submit
    expect(await create('dist')).toMatchObject({ success: false, code: 'FORBIDDEN' })
    expect(provisionIdentity).not.toHaveBeenCalled()
  })

  it('non-HQ ESS submissions are rejected server-side even for an authorized administrator', async () => {
    allow('mfg')
    const { createUserWithAuth } = await import('@/lib/actions')
    const ESS_ID = '00000000-0000-4000-8000-000000000003'
    const res: any = await createUserWithAuth({ email: 'x@y.test', password: 'p-123456', full_name: 'X', organization_id: 'mfg', initial_role_id: ESS_ID })
    expect(res.success).toBe(false)
    expect(provisionIdentity).not.toHaveBeenCalled()
  })
})
