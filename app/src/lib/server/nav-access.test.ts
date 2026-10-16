import { beforeEach, describe, expect, it, vi } from 'vitest'

const authorizeOperation = vi.fn()
const canManageHr = vi.fn()
const getHrAccessDecision = vi.fn()
const checkRolePermissionWithDefaults = vi.fn()
const rootRpc = vi.fn()
const legacyOrDelegatedSecurityAccess = vi.fn()
const legacyFinanceModuleEntry = vi.fn()
vi.mock('@/lib/server/finance-access', () => ({ legacyFinanceModuleEntry }))
vi.mock('@/lib/server/permissions', () => ({ checkRolePermissionWithDefaults, withPermissionEvaluationScope: (fn: () => Promise<unknown>) => fn() }))
// The batch is the same per-permission decision without an audit row (its own equivalence is covered in authorization.test.ts).
vi.mock('@/lib/security-access/authorization', () => ({
  explainMany: (actorId: string, items: any[]) =>
    Promise.all(items.map(item => authorizeOperation({ actorId, ...item, explainOnly: true }).then((d: any) => d.decision))),
}))
vi.mock('@/lib/security-access/delegation', () => ({ legacyOrDelegatedSecurityAccess }))
vi.mock('@/lib/security-access/operation', () => ({
  authorizeOperation,
  organizationResource: (type: string, organizationId: string | null, extra: object = {}) => ({ type, organizationId, ...extra }),
  warehouseResource: (type: string, warehouseId: string) => ({ type, organizationId: warehouseId, warehouseId }),
}))
const grantedWarehouseIds = vi.fn()
vi.mock('@/lib/server/warehouse-reach', () => ({ grantedWarehouseIds }))
vi.mock('@/lib/server/hrAccess', () => ({ canManageHr, getHrAccessDecision }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({
  from: () => ({ select: () => ({ eq: () => ({ eq: async () => ({ data: [], error: null }) }) }) }),
  rpc: (fn: string, args: unknown) => rootRpc(fn, args),
}) }))

const actor = (over: Partial<Record<string, any>> = {}) => ({
  userId: 'u-1', organizationId: 'org-hq', orgTypeCode: 'HQ', roleCode: 'GUEST', roleLevel: 50, ...over,
})
const allow = (...permissions: string[]) =>
  authorizeOperation.mockImplementation(async (req: any) => ({ decision: permissions.includes(req.permission) ? 'ALLOW' : 'DENY' }))

beforeEach(() => {
  vi.clearAllMocks()
  canManageHr.mockResolvedValue(false)
  getHrAccessDecision.mockResolvedValue({ allowed: false })
  checkRolePermissionWithDefaults.mockResolvedValue(false)
  rootRpc.mockResolvedValue({ data: false, error: null })
  legacyOrDelegatedSecurityAccess.mockResolvedValue(false)
  legacyFinanceModuleEntry.mockResolvedValue(false)
  grantedWarehouseIds.mockResolvedValue([])
})

describe('resolveDestinationAccess', () => {
  it('allows My Workspace for Employee Self-Service, decided on the person\'s OWN record', async () => {
    allow('hr.self_service.use')
    const { resolveDestinationAccess } = await import('./nav-access')
    expect(await resolveDestinationAccess(actor(), 'hr/my-workspace')).toEqual({ state: 'allowed', destination: 'hr/my-workspace' })
    const call = authorizeOperation.mock.calls.find(([r]) => r.permission === 'hr.self_service.use')![0]
    expect(call.resource).toMatchObject({ organizationId: 'org-hq', ownerUserId: 'u-1' })
  })

  it('denies administrative HR pages to an ESS-only person (module entry and page permissions are both needed)', async () => {
    allow('hr.self_service.use')
    const { resolveDestinationAccess } = await import('./nav-access')
    for (const id of ['hr', 'hr/people/employees', 'hr/leave/requests', 'hr/payroll/payslips', 'hr/settings/configuration']) {
      expect(await resolveDestinationAccess(actor(), id), id).toEqual({ state: 'denied' })
    }
  })

  it('evaluates organization permissions on the verified account\'s own organization, never as an own record', async () => {
    allow('hr.module.view', 'hr.employee.view')
    const { resolveDestinationAccess } = await import('./nav-access')
    expect(await resolveDestinationAccess(actor(), 'hr/people/employees')).toEqual({ state: 'allowed', destination: 'hr/people/employees' })
    for (const [req] of authorizeOperation.mock.calls) {
      expect(req.resource.organizationId).toBe('org-hq')
      expect(req.resource.ownerUserId).toBeUndefined()
      expect(req.explainOnly).toBe(false) // page decisions are recorded
    }
  })

  it('prefers the administrative chart and falls back to the limited staff chart', async () => {
    const { resolveDestinationAccess } = await import('./nav-access')
    allow('hr.module.view', 'hr.employee.view', 'hr.employee.view_internal')
    expect(await resolveDestinationAccess(actor(), ['hr/people/org-chart', 'hr/people/org-chart/staff'])).toMatchObject({ destination: 'hr/people/org-chart' })
    allow('hr.employee.view_internal')
    expect(await resolveDestinationAccess(actor(), ['hr/people/org-chart', 'hr/people/org-chart/staff'])).toEqual({ state: 'allowed', destination: 'hr/people/org-chart/staff' })
    allow()
    expect(await resolveDestinationAccess(actor(), ['hr/people/org-chart', 'hr/people/org-chart/staff'])).toEqual({ state: 'denied' })
  })

  it('reports a failed permission check as unavailable, never as a denial and never as an allow', async () => {
    authorizeOperation.mockRejectedValue(new Error('migration_mode_unavailable'))
    const { resolveDestinationAccess } = await import('./nav-access')
    expect(await resolveDestinationAccess(actor(), 'hr/my-workspace')).toEqual({ state: 'unavailable' })
    expect(await resolveDestinationAccess(actor(), 'crm')).toEqual({ state: 'unavailable' })
  })

  it('denies an unregistered destination instead of leaving it open', async () => {
    allow('hr.module.view')
    const { resolveDestinationAccess } = await import('./nav-access')
    expect(await resolveDestinationAccess(actor(), 'hr/made-up')).toEqual({ state: 'denied' })
  })

  it('gates RoadTour and Customer & Growth on their own permissions', async () => {
    const { resolveDestinationAccess } = await import('./nav-access')
    allow('product.catalog.view', 'qr.batch.manage') // Supply Chain Full Access
    expect(await resolveDestinationAccess(actor(), 'roadtour')).toEqual({ state: 'denied' })
    expect(await resolveDestinationAccess(actor(), 'crm')).toEqual({ state: 'denied' })
    expect(await resolveDestinationAccess(actor(), 'catalog')).toEqual({ state: 'allowed', destination: 'catalog' })
    allow('roadtour.report.view')
    expect(await resolveDestinationAccess(actor(), 'roadtour')).toEqual({ state: 'allowed', destination: 'roadtour' })
  })
})

describe('resolveCustomerGrowthLandingAccess (Supply Chain + shared Product Catalog)', () => {
  const SC = ['product.catalog.view', 'qr.batch.manage', 'inventory.report.view', 'supply_chain.order.create']
  it('denies the landing for Supply Chain + catalog only; the catalog page itself stays allowed', async () => {
    allow(...SC)
    const { resolveCustomerGrowthLandingAccess, resolveDestinationAccess } = await import('./nav-access')
    expect(await resolveCustomerGrowthLandingAccess(actor())).toEqual({ state: 'denied' })
    expect(await resolveDestinationAccess(actor(), 'catalog')).toEqual({ state: 'allowed', destination: 'catalog' })
    expect(await resolveDestinationAccess(actor(), 'product-catalog')).toEqual({ state: 'allowed', destination: 'product-catalog' })
  })
  it('allows a catalog-only person, and anyone holding one of the module\'s own functions', async () => {
    const { resolveCustomerGrowthLandingAccess } = await import('./nav-access')
    allow('product.catalog.view')
    expect(await resolveCustomerGrowthLandingAccess(actor())).toMatchObject({ state: 'allowed' })
    allow(...SC, 'customer.crm.view', 'customer.consumer.view')
    expect(await resolveCustomerGrowthLandingAccess(actor())).toMatchObject({ state: 'allowed', destination: 'crm' })
    allow(...SC, 'ecommerce.module.view')
    expect(await resolveCustomerGrowthLandingAccess(actor())).toMatchObject({ state: 'allowed', destination: 'ecommerce' })
  })
  it('denies without any permission (Supply Chain without catalog, ESS only) and reports failures as unavailable', async () => {
    const { resolveCustomerGrowthLandingAccess } = await import('./nav-access')
    allow('qr.batch.manage', 'hr.self_service.use')
    expect(await resolveCustomerGrowthLandingAccess(actor())).toEqual({ state: 'denied' })
    authorizeOperation.mockRejectedValue(new Error('x'))
    expect(await resolveCustomerGrowthLandingAccess(actor())).toEqual({ state: 'unavailable' })
  })
  it('the supply-chain work probe writes no decision audit rows', async () => {
    allow('product.catalog.view')
    const { resolveCustomerGrowthLandingAccess } = await import('./nav-access')
    await resolveCustomerGrowthLandingAccess(actor())
    const probe = authorizeOperation.mock.calls.filter(([r]) => r.permission === 'qr.batch.manage')
    expect(probe.length).toBeGreaterThan(0)
    for (const [r] of probe) expect(r.explainOnly).toBe(true)
  })
})

describe('evaluateNavSnapshot', () => {
  it('binds the answers to the verified account and organization and writes no decision audit rows', async () => {
    allow('hr.self_service.use')
    const { evaluateNavSnapshot } = await import('./nav-access')
    const snapshot = await evaluateNavSnapshot(actor())
    expect(snapshot).toMatchObject({ userId: 'u-1', organizationId: 'org-hq' })
    expect(snapshot.destinations['hr/my-workspace']).toBe(true)
    expect(snapshot.destinations.hr).toBe(false)
    expect(snapshot.destinations.roadtour).toBe(false)
    expect(authorizeOperation.mock.calls.every(([r]) => r.explainOnly === true)).toBe(true)
  })

  it('decides the sidebar entries with the role permission and the engine (security.access.view with the page guard legacy rule)', async () => {
    checkRolePermissionWithDefaults.mockResolvedValue(true)
    legacyOrDelegatedSecurityAccess.mockResolvedValue(true)
    authorizeOperation.mockImplementation(async (req: any) => ({ decision: req.permission === 'security.access.view' && (await req.legacy()) ? 'ALLOW' : 'DENY' }))
    const { evaluateNavSnapshot } = await import('./nav-access')
    expect((await evaluateNavSnapshot(actor())).sidebar).toEqual({ users: true, securityAccess: true })
    expect(checkRolePermissionWithDefaults).toHaveBeenCalledWith('u-1', 'view_users')
    expect(legacyOrDelegatedSecurityAccess).toHaveBeenCalledWith('u-1', 'org-hq', 'security.access.view')

    // The engine's DENY wins (NEW_ENFORCED without a grant), whatever the legacy rule says.
    authorizeOperation.mockImplementation(async () => ({ decision: 'DENY' }))
    expect((await evaluateNavSnapshot(actor())).sidebar).toEqual({ users: true, securityAccess: false })
  })

  it('rejects when a sidebar decision cannot be made (not a denial)', async () => {
    checkRolePermissionWithDefaults.mockRejectedValue(new Error('roles_unavailable'))
    const { evaluateNavSnapshot } = await import('./nav-access')
    await expect(evaluateNavSnapshot(actor())).rejects.toThrow()
  })

  it('rejects (so callers report unavailable) when any evaluation fails', async () => {
    authorizeOperation.mockRejectedValueOnce(new Error('policy_data_unavailable')).mockResolvedValue({ decision: 'ALLOW' })
    const { evaluateNavSnapshot } = await import('./nav-access')
    await expect(evaluateNavSnapshot(actor())).rejects.toThrow()
  })
})

describe('User Management (sidebar entry and /users page guard)', () => {
  // Root Access reaches User Management through the engine: Root ALLOWs every active permission (ALLOWED_BY_ROOT_ACCESS).
  const rootEngine = () => authorizeOperation.mockImplementation(async () => ({ decision: 'ALLOW', reasonCode: 'ALLOWED_BY_ROOT_ACCESS' }))

  it('HQ Admin without Root keeps User Management through the role rule with level defaults (HQ role JSON has no view_users)', async () => {
    allow()
    checkRolePermissionWithDefaults.mockResolvedValue(true)
    const { evaluateNavSnapshot, resolveUserManagementAccess } = await import('./nav-access')
    const hqAdmin = actor({ roleCode: 'HQ', roleLevel: 10 })
    const snapshot = await evaluateNavSnapshot(hqAdmin)
    expect(snapshot.sidebar.users).toBe(true)
    expect(snapshot.rootAccess).toBe(false)
    expect(await resolveUserManagementAccess(hqAdmin)).toEqual({ state: 'allowed', destination: 'users' })
  })

  it('active Root Administrator gets User Management from the engine, independent of the legacy role level', async () => {
    rootEngine()
    rootRpc.mockResolvedValue({ data: true, error: null })
    const { evaluateNavSnapshot, resolveUserManagementAccess } = await import('./nav-access')
    const root = actor({ roleCode: 'GUEST', roleLevel: 50 })
    const snapshot = await evaluateNavSnapshot(root)
    expect(snapshot.sidebar.users).toBe(true)
    expect(snapshot.rootAccess).toBe(true)
    expect(rootRpc).toHaveBeenCalledWith('sa_actor_is_root', { p_actor: 'u-1' })
    expect(await resolveUserManagementAccess(root)).toEqual({ state: 'allowed', destination: 'users' })
    const guard = authorizeOperation.mock.calls.filter(([r]) => r.permission === 'platform.identity.view' && r.explainOnly === false)
    expect(guard).toHaveLength(1) // the page decision is recorded
    expect(guard[0][0].resource.organizationId).toBe('org-hq')
  })

  it('revoked Root (engine DENY, role rule false) returns to normal: no entry, page denied, no Root flag', async () => {
    allow()
    const { evaluateNavSnapshot, resolveUserManagementAccess } = await import('./nav-access')
    const snapshot = await evaluateNavSnapshot(actor())
    expect(snapshot.sidebar.users).toBe(false)
    expect(snapshot.rootAccess).toBe(false)
    expect(await resolveUserManagementAccess(actor())).toEqual({ state: 'denied' })
  })

  it('manufacturer staff never get User Management (organization-type rule), whatever the role or engine says', async () => {
    checkRolePermissionWithDefaults.mockResolvedValue(true)
    rootEngine()
    const { evaluateNavSnapshot, resolveUserManagementAccess } = await import('./nav-access')
    const mfg = actor({ orgTypeCode: 'MFG', organizationId: 'org-mfg', roleCode: 'MFG', roleLevel: 30 })
    expect((await evaluateNavSnapshot(mfg)).sidebar.users).toBe(false)
    expect(await resolveUserManagementAccess(mfg)).toEqual({ state: 'denied' })
  })

  it('distributor and shop staff keep their role-rule entry (unchanged)', async () => {
    checkRolePermissionWithDefaults.mockResolvedValue(true)
    const { resolveUserManagementAccess } = await import('./nav-access')
    for (const orgTypeCode of ['DIST', 'SHOP', 'WH']) {
      expect(await resolveUserManagementAccess(actor({ orgTypeCode, organizationId: `org-${orgTypeCode}`, roleLevel: 40 })), orgTypeCode).toEqual({ state: 'allowed', destination: 'users' })
    }
  })

  it('a failed decision is unavailable, never an allow; a failed Root read only hides the Root flag', async () => {
    checkRolePermissionWithDefaults.mockRejectedValue(new Error('role_permissions_unavailable'))
    const { resolveUserManagementAccess, evaluateNavSnapshot } = await import('./nav-access')
    expect(await resolveUserManagementAccess(actor())).toEqual({ state: 'unavailable' })
    checkRolePermissionWithDefaults.mockResolvedValue(false)
    rootRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    expect((await evaluateNavSnapshot(actor())).rootAccess).toBe(false)
  })
})

describe('legacy rules (only consulted while a permission is on a legacy migration mode)', () => {
  it('reproduces each module entry\'s historical rule and never allows the unknown', async () => {
    const { legacyRuleFor } = await import('./nav-access')
    const l50hq = actor()
    expect(await legacyRuleFor('customer.crm.view', l50hq, 'org')()).toBe(true)
    expect(await legacyRuleFor('marketing.module.view', l50hq, 'org')()).toBe(false)
    expect(await legacyRuleFor('product.catalog.view', actor({ orgTypeCode: 'MFG' }), 'org')()).toBe(false)
    expect(await legacyRuleFor('hr.employee.view_internal', l50hq, 'org')()).toBe(true)
    expect(await legacyRuleFor('hr.employee.view_internal', actor({ orgTypeCode: 'SHOP' }), 'org')()).toBe(false)
    expect(await legacyRuleFor('roadtour.report.view', l50hq, 'org')()).toBe(false)
    expect(await legacyRuleFor('some.unknown.permission', actor({ roleLevel: 1 }), 'org')()).toBe(false)
    expect(await legacyRuleFor('hr.self_service.use', l50hq, 'self')()).toBe(true)
  })

  it('uses the HR administration rule for HR permissions', async () => {
    const { legacyRuleFor } = await import('./nav-access')
    canManageHr.mockResolvedValue(true)
    expect(await legacyRuleFor('hr.payroll.view', actor(), 'org')()).toBe(true)
    canManageHr.mockResolvedValue(false)
    expect(await legacyRuleFor('hr.payroll.view', actor(), 'org')()).toBe(false)
  })
})

describe('Finance (sidebar entry, landing, sections and their page guards share one decision)', () => {
  const FINANCE_FULL_ACCESS = [
    'finance.account.manage', 'finance.cash.view', 'finance.data.reset', 'finance.journal.post', 'finance.ledger.view',
    'finance.module.view', 'finance.payable.view', 'finance.payment.approve', 'finance.payroll_integration.manage',
    'finance.receivable.view', 'finance.reconciliation.perform', 'finance.report.view_sensitive', 'finance.settings.manage',
  ]
  const ORDER_DEV_OTHER_POLICIES = ['supply_chain.order.create', 'supply_chain.order.approve', 'product.catalog.view', 'inventory.adjustment.post', 'qr.batch.manage']
  const SECTIONS = {
    gl: 'finance/gl/journals', ar: 'finance/ar/invoices', ap: 'finance/ap/bills', cash: 'finance/cash/bank-accounts',
    cashflow: 'finance/cash/cashflow', reports: 'finance/reports/trial-balance', settings: 'finance/settings/posting-rules',
  }

  it('an active Finance Full Access grant (HQ L50 GUEST, no legacy rule) shows Finance and opens every section', async () => {
    allow(...FINANCE_FULL_ACCESS, ...ORDER_DEV_OTHER_POLICIES)
    const { evaluateNavSnapshot, resolveDestinationAccess } = await import('./nav-access')
    const { financeModuleVisible } = await import('@/lib/security-access/nav-access')
    const snapshot = await evaluateNavSnapshot(actor())
    expect(financeModuleVisible(snapshot)).toBe(true)
    for (const id of ['finance', 'finance/status', ...Object.values(SECTIONS)]) {
      expect(snapshot.destinations[id], id).toBe(true)
      expect(await resolveDestinationAccess(actor(), id), id).toEqual({ state: 'allowed', destination: id })
    }
  })

  it('decides on the verified company and records the decision like the Finance routes (finance_company)', async () => {
    allow('finance.module.view')
    const { resolveDestinationAccess } = await import('./nav-access')
    await resolveDestinationAccess(actor(), 'finance')
    const call = authorizeOperation.mock.calls.find(([r]) => r.permission === 'finance.module.view')![0]
    expect(call.resource).toEqual({ type: 'finance_company', organizationId: 'org-hq' })
    expect(call.explainOnly).toBe(false)
  })

  it('a partial policy (AR clerk) shows Finance with only the permitted sections', async () => {
    allow('finance.module.view', 'finance.ledger.view', 'finance.receivable.view')
    const { evaluateNavSnapshot } = await import('./nav-access')
    const d = (await evaluateNavSnapshot(actor())).destinations
    expect(d.finance).toBe(true)
    expect([d[SECTIONS.gl], d[SECTIONS.ar], d['finance/ar/aging']]).toEqual([true, true, true])
    expect([d[SECTIONS.ap], d[SECTIONS.cash], d[SECTIONS.cashflow], d[SECTIONS.reports]]).toEqual([false, false, false, false])
    // Settings screens read with the ledger permission; changing them is finance.settings.manage on the server.
    expect(d[SECTIONS.settings]).toBe(true)
  })

  it('the module entry alone opens the landing, never a data section', async () => {
    allow('finance.module.view')
    const { evaluateNavSnapshot } = await import('./nav-access')
    const d = (await evaluateNavSnapshot(actor())).destinations
    expect([d.finance, d['finance/status'], d['finance/settings/permissions']]).toEqual([true, true, true])
    for (const id of Object.values(SECTIONS)) expect(d[id], id).toBe(false)
  })

  it('a section permission without the module entry opens nothing (entry is required, as the page guard requires it)', async () => {
    allow('finance.receivable.view', 'finance.payment.approve')
    const { evaluateNavSnapshot } = await import('./nav-access')
    const d = (await evaluateNavSnapshot(actor())).destinations
    expect(Object.entries(d).filter(([id, v]) => id.startsWith('finance') && v)).toEqual([])
  })

  it('no Finance permission, or a revoked / expired grant (engine DENY): Finance hidden and every page denied', async () => {
    allow(...ORDER_DEV_OTHER_POLICIES)
    const { evaluateNavSnapshot, resolveDestinationAccess } = await import('./nav-access')
    const { financeModuleVisible } = await import('@/lib/security-access/nav-access')
    expect(financeModuleVisible(await evaluateNavSnapshot(actor()))).toBe(false)
    for (const id of ['finance', ...Object.values(SECTIONS)]) {
      expect(await resolveDestinationAccess(actor(), id), id).toEqual({ state: 'denied' })
    }
  })

  it('a legacy Super Admin is not elevated by the navigation layer: the engine answer decides', async () => {
    allow()
    const { evaluateNavSnapshot } = await import('./nav-access')
    const { financeModuleVisible } = await import('@/lib/security-access/nav-access')
    expect(financeModuleVisible(await evaluateNavSnapshot(actor({ roleCode: 'SA', roleLevel: 1 })))).toBe(false)
  })

  it('Root Access (the engine allows every active permission) gets Finance', async () => {
    authorizeOperation.mockResolvedValue({ decision: 'ALLOW' })
    rootRpc.mockResolvedValue({ data: true, error: null })
    const { evaluateNavSnapshot } = await import('./nav-access')
    const snapshot = await evaluateNavSnapshot(actor({ roleLevel: 10 }))
    expect(snapshot.rootAccess).toBe(true)
    for (const id of ['finance', ...Object.values(SECTIONS)]) expect(snapshot.destinations[id], id).toBe(true)
  })

  it('a failed decision is unavailable on the page and rejects the snapshot (never a silent allow or deny)', async () => {
    authorizeOperation.mockRejectedValue(new Error('migration_mode_unavailable'))
    const { evaluateNavSnapshot, resolveDestinationAccess } = await import('./nav-access')
    expect(await resolveDestinationAccess(actor(), 'finance')).toEqual({ state: 'unavailable' })
    await expect(evaluateNavSnapshot(actor())).rejects.toThrow()
  })

  it('legacy rules: module entry is the page guard\'s historical rule; section reads follow their routes; settings at level 20', async () => {
    const { legacyRuleFor } = await import('./nav-access')
    legacyFinanceModuleEntry.mockResolvedValue(true)
    expect(await legacyRuleFor('finance.module.view', actor(), 'org')()).toBe(true)
    expect(legacyFinanceModuleEntry).toHaveBeenCalledWith('u-1')
    legacyFinanceModuleEntry.mockResolvedValue(false)
    expect(await legacyRuleFor('finance.module.view', actor({ roleLevel: 1 }), 'org')()).toBe(false)
    for (const p of ['finance.ledger.view', 'finance.receivable.view', 'finance.payable.view', 'finance.cash.view', 'finance.report.view_sensitive']) {
      expect(await legacyRuleFor(p, actor(), 'org')(), p).toBe(true)
    }
    expect(await legacyRuleFor('finance.settings.manage', actor({ roleLevel: 20 }), 'org')()).toBe(true)
    expect(await legacyRuleFor('finance.settings.manage', actor({ roleLevel: 30 }), 'org')()).toBe(false)
  })
})

describe('warehouse-scoped grants (Warehouse Manager on one warehouse, HQ account)', () => {
  // The engine allows the policy's keys only with the granted warehouse as the resource (sa_scope_matches).
  const WAREHOUSE_KEYS = ['inventory.stock.view', 'inventory.report.view', 'inventory.adjustment.post', 'inventory.stock_count.view',
    'inventory.stock_count.create', 'inventory.transfer.view', 'inventory.transfer.request', 'inventory.stock_config.manage',
    'inventory.return.manage', 'inventory.return.request', 'product.catalog.view', 'product.catalog.manage']
  const allowInWarehouse = (warehouseId: string, keys = WAREHOUSE_KEYS) =>
    authorizeOperation.mockImplementation(async (req: any) => ({
      decision: req.resource.warehouseId === warehouseId && keys.includes(req.permission) ? 'ALLOW' : 'DENY',
    }))

  it('shows Supply Chain and exactly the functions that work per warehouse', async () => {
    grantedWarehouseIds.mockResolvedValue(['wh-balakong'])
    allowInWarehouse('wh-balakong')
    const { evaluateNavSnapshot } = await import('./nav-access')
    const { destinations } = await evaluateNavSnapshot(actor())
    expect(destinations['supply-chain']).toBe(true)
    for (const id of ['inventory-list', 'add-stock', 'stock-adjustment', 'stock-transfer', 'stock-movements']) {
      expect(destinations[`supply-chain/${id}`], id).toBe(true)
    }
    // Decided on the organization (HQ): a warehouse-only grant cannot use them, so they are not offered.
    for (const id of ['products', 'product-management', 'inventory-settings', 'return-product', 'return-settings', 'return-reporting']) {
      expect(destinations[`supply-chain/${id}`], id).toBe(false)
    }
    // Excluded areas.
    for (const id of ['organizations', 'orders', 'qr-batches', 'warehouse-receive-2']) expect(destinations[`supply-chain/${id}`], id).toBe(false)
  })

  it('asks only on the warehouses the grants name, and only for permissions decided per warehouse', async () => {
    grantedWarehouseIds.mockResolvedValue(['wh-balakong'])
    allowInWarehouse('wh-balakong')
    const { evaluateNavSnapshot } = await import('./nav-access')
    await evaluateNavSnapshot(actor())
    const probes = authorizeOperation.mock.calls.map(([r]) => r).filter(r => r.resource.warehouseId)
    expect(probes.length).toBeGreaterThan(0)
    expect(new Set(probes.map(r => r.resource.warehouseId))).toEqual(new Set(['wh-balakong']))
    expect(probes.some(r => r.permission.startsWith('product.') || r.permission.startsWith('inventory.return.') || r.permission === 'inventory.stock_config.manage')).toBe(false)
    expect(probes.every(r => r.explainOnly === true)).toBe(true) // the snapshot records nothing
  })

  it('page guards decide the same way, and record the warehouse decision', async () => {
    grantedWarehouseIds.mockResolvedValue(['wh-balakong'])
    allowInWarehouse('wh-balakong')
    const { resolveDestinationAccess } = await import('./nav-access')
    expect(await resolveDestinationAccess(actor(), 'supply-chain/stock-transfer')).toEqual({ state: 'allowed', destination: 'supply-chain/stock-transfer' })
    expect(await resolveDestinationAccess(actor(), 'supply-chain/products')).toEqual({ state: 'denied' })
    expect(await resolveDestinationAccess(actor(), 'supply-chain/orders')).toEqual({ state: 'denied' })
    expect(authorizeOperation.mock.calls.some(([r]) => r.resource.warehouseId === 'wh-balakong' && r.explainOnly === false)).toBe(true)
  })

  it('a grant on another warehouse, a revoked or expired grant (no warehouse named) shows nothing', async () => {
    allowInWarehouse('wh-balakong')
    const { evaluateNavSnapshot } = await import('./nav-access')
    grantedWarehouseIds.mockResolvedValue(['wh-alma'])
    expect((await evaluateNavSnapshot(actor())).destinations['supply-chain']).toBe(false)
    grantedWarehouseIds.mockResolvedValue([])
    expect((await evaluateNavSnapshot(actor())).destinations['supply-chain']).toBe(false)
  })

  it('an HQ-scoped grant opens every function of the policy on HQ itself (no warehouse probe)', async () => {
    allow(...WAREHOUSE_KEYS)
    const { evaluateNavSnapshot } = await import('./nav-access')
    const { destinations } = await evaluateNavSnapshot(actor())
    for (const id of ['products', 'product-management', 'inventory-list', 'inventory-settings', 'stock-movements', 'return-product', 'return-settings', 'return-reporting']) {
      expect(destinations[`supply-chain/${id}`], id).toBe(true)
    }
    expect(authorizeOperation.mock.calls.some(([r]) => r.resource.warehouseId)).toBe(false)
  })

  it('a failed grant read makes the snapshot unavailable (never a silent deny or allow)', async () => {
    allow()
    grantedWarehouseIds.mockRejectedValue(new Error('warehouse_reach_unavailable'))
    const { evaluateNavSnapshot, resolveDestinationAccess } = await import('./nav-access')
    await expect(evaluateNavSnapshot(actor())).rejects.toThrow()
    expect(await resolveDestinationAccess(actor(), 'supply-chain/inventory-list')).toEqual({ state: 'unavailable' })
  })
})
