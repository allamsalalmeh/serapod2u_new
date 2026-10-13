import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { authorizeOperation, organizationResource, warehouseResource } from '@/lib/security-access/operation'
import { explainMany, type LegacyEvaluator } from '@/lib/security-access/authorization'
import { FINAL_WAVE_CATALOG, compatGrants } from '@/lib/security-access/catalog'
import { checkRolePermissionWithDefaults, withPermissionEvaluationScope } from '@/lib/server/permissions'
import { legacyOrDelegatedSecurityAccess } from '@/lib/security-access/delegation'
import { canManageHr, getHrAccessDecision, type HrAuthContext } from '@/lib/server/hrAccess'
import { legacyFinanceModuleEntry } from '@/lib/server/finance-access'
import { INVENTORY_STOCK_VIEW_PERMISSION, legacyInventoryStockView } from '@/lib/security-access/inventory-stock'
import { ORDER_VIEW_PERMISSION, legacyOrderView } from '@/lib/security-access/order-view'
import { decidedPerWarehouse } from '@/lib/security-access/warehouse-reach'
import { grantedWarehouseIds } from '@/lib/server/warehouse-reach'
import {
  FINANCE_MODULE_PERMISSION,
  NAV_DESTINATIONS,
  STAFF_DIRECTORY_PERMISSION,
  CUSTOMER_GROWTH_OWN_MODULE_IDS,
  SUPPLY_CHAIN_WORK_DESTINATION,
  USER_MANAGEMENT_ORG_TYPES,
  USER_MANAGEMENT_PERMISSION,
  computeDestinations,
  customerGrowthDestinationForView,
  customerGrowthVisibleFromDestinations,
  destinationAllowed,
  hrDestinationId,
  navPermissionPlan,
  type NavAccessSnapshot,
  type NavRequirement,
  type PermissionAnswers,
} from '@/lib/security-access/nav-access'

/**
 * Server-side navigation/page access, decided by the canonical Security & Access evaluation (authorizeOperation) in each
 * permission's CURRENT migration mode. The module's historical rule is the legacy evaluator, so LEGACY_ENFORCED/SHADOW
 * keep their meaning, NEW_ENFORCED/LEGACY_RETIRED are decided by S&A alone, and a legacy ALLOW never overrides an S&A
 * DENY. A failed evaluation is reported as "unavailable", never as a denial, and never as an allow.
 */

export interface NavActor {
  userId: string
  organizationId: string | null
  orgTypeCode: string | null
  roleCode: string | null
  roleLevel: number | null
}

const first = <T,>(value: T | T[] | null | undefined): T | null => (Array.isArray(value) ? value[0] ?? null : value ?? null)

/** The verified account's own organization and legacy classification (never taken from a request). */
export async function loadNavActor(userId: string): Promise<NavActor | null> {
  const admin = createAdminClient() as any
  const { data, error } = await admin
    .from('users')
    .select('id, organization_id, role_code, is_active, organizations:organization_id(org_type_code), roles:role_code(role_level)')
    .eq('id', userId)
    .maybeSingle()
  if (error || !data) return null
  return {
    userId: data.id,
    organizationId: data.organization_id ?? null,
    orgTypeCode: first<any>(data.organizations)?.org_type_code ?? null,
    roleCode: data.role_code ?? null,
    roleLevel: first<any>(data.roles)?.role_level ?? null,
  }
}

/** The actor for a profile row a page already loaded (organization and role joined, as the page contexts select it). */
export function navActorFromProfile(profile: any): NavActor {
  return {
    userId: profile.id,
    organizationId: profile.organization_id ?? first<any>(profile.organizations)?.id ?? null,
    orgTypeCode: first<any>(profile.organizations)?.org_type_code ?? null,
    roleCode: profile.role_code ?? null,
    roleLevel: first<any>(profile.roles)?.role_level ?? null,
  }
}

const hrContext = (actor: NavActor): HrAuthContext => ({
  userId: actor.userId, organizationId: actor.organizationId, roleCode: actor.roleCode, roleLevel: actor.roleLevel,
})

const CATALOG_BY_KEY = new Map(FINAL_WAVE_CATALOG.map(entry => [entry.key, entry]))

/**
 * The historical rule for each permission, used only while the permission is on LEGACY_ENFORCED/SHADOW. The module
 * entry rules are the ones the pages' own guards used (crm/marketing/catalog/ecommerce _lib files).
 */
export function legacyRuleFor(permission: string, actor: NavActor, kind: 'org' | 'self'): LegacyEvaluator {
  if (kind === 'self') return () => true
  const level = actor.roleLevel ?? 999
  const hq = actor.orgTypeCode === 'HQ'
  switch (permission) {
    case 'customer.crm.view': return () => hq && level <= 50
    case 'marketing.module.view': return () => hq && level <= 30
    case 'product.catalog.view': return () => ['HQ', 'DIST', 'SHOP'].includes(actor.orgTypeCode ?? '') && level <= 50
    case 'ecommerce.module.view': return () => hq && level <= 30
    case STAFF_DIRECTORY_PERMISSION: return () => hq && ((actor.roleCode ?? '').toUpperCase() === 'MANAGER' || level <= 50)
    case 'hr.module.view':
    case 'hr.employee.view':
      return async () => (await getHrAccessDecision(hrContext(actor))).allowed
    case FINANCE_MODULE_PERMISSION: return () => legacyFinanceModuleEntry(actor.userId)
    // The Finance section reads: the historical rule of their own GET routes (financeAllowed(..., () => true)), so in a
    // legacy mode a section is reachable exactly when the module entry is (every Finance destination also requires it).
    case 'finance.ledger.view':
    case 'finance.receivable.view':
    case 'finance.payable.view':
    case 'finance.cash.view':
    case 'finance.report.view_sensitive':
      return () => true
    // The settings routes' write rule (role level 20 and above in privilege).
    case 'finance.settings.manage': return () => level <= 20
    // The Inventory group's historical organization-type rule (any level), as the database's legacy tenant read.
    case INVENTORY_STOCK_VIEW_PERMISSION: return () => legacyInventoryStockView(actor.orgTypeCode)
    // The historical Order Details rule (canOpenOrderEditor: role level 40), the compatibility rule of View Orders.
    case ORDER_VIEW_PERMISSION: return () => legacyOrderView(actor.roleLevel)
  }
  if (permission.startsWith('hr.')) return () => canManageHr(hrContext(actor))
  if (permission.startsWith('roadtour.')) return () => level <= 20
  const entry = CATALOG_BY_KEY.get(permission)
  if (entry) return () => compatGrants(entry, { roleCode: actor.roleCode ?? '', roleLevel: actor.roleLevel, permissions: [] })
  // Unknown to the compatibility catalogue: deny until S&A decides it.
  return () => false
}

type Plan = { org: readonly string[]; self: readonly string[] }

const orgItem = (actor: NavActor, permission: string) => ({
  permission,
  // Finance decisions are recorded on the company, like the Finance routes record them (financeAllowed).
  resource: organizationResource(permission.startsWith('finance.') ? 'finance_company' : permission.split('.').slice(0, 2).join('_'), actor.organizationId),
  legacy: legacyRuleFor(permission, actor, 'org'),
})
// Own-record permissions are decided on the caller's own record: the owner is the verified account itself.
const selfItem = (actor: NavActor, permission: string) => ({
  permission,
  resource: organizationResource('hr_employee_record', actor.organizationId, { ownerUserId: actor.userId }),
  legacy: legacyRuleFor(permission, actor, 'self'),
})

/**
 * Decide every permission of the plan. Throws when any evaluation fails, so callers can report "unavailable".
 * With `audit` each permission is a recorded authorizeOperation decision (page guards). Without it (snapshots) the
 * plan is one explain-only batch: same outcome per permission, shared reads, bounded concurrency.
 */
async function decide(actor: NavActor, plan: Plan, options: { audit: boolean }): Promise<PermissionAnswers> {
  const run = (items: ReturnType<typeof orgItem>[]) => options.audit
    ? Promise.all(items.map(item => authorizeOperation({ actorId: actor.userId, ...item, explainOnly: false }).then(d => d.decision)))
    : explainMany(actor.userId, items)
  const items = [...plan.org.map(p => orgItem(actor, p)), ...plan.self.map(p => selfItem(actor, p))]
  const decisions = await run(items)
  const org: Record<string, boolean> = {}
  const self: Record<string, boolean> = {}
  items.forEach((item, i) => {
    (i < plan.org.length ? org : self)[item.permission] = decisions[i] === 'ALLOW'
  })

  // A grant scoped to a warehouse is decided on that warehouse, never on the person's own organization (an HQ): for the
  // functions that work per warehouse, ask the engine again on each warehouse the person's grants name. Only permissions
  // still denied are asked; every answer is the engine's own decision on that warehouse.
  const reach = plan.org.filter(p => !org[p] && decidedPerWarehouse(p))
  if (reach.length > 0) {
    const warehouses = (await grantedWarehouseIds(actor.userId)).filter(id => id !== actor.organizationId)
    const probes = reach.flatMap(permission => warehouses.map(warehouseId => ({
      permission,
      resource: warehouseResource(permission.split('.').slice(0, 2).join('_'), warehouseId),
      legacy: legacyRuleFor(permission, actor, 'org'),
    })))
    const answers = await run(probes)
    probes.forEach((probe, i) => { if (answers[i] === 'ALLOW') org[probe.permission] = true })
  }
  return { org, self }
}

function planFor(req: NavRequirement): Plan {
  const org = new Set<string>()
  if (req.module) org.add(req.module)
  req.org?.forEach(p => org.add(p))
  req.staff?.forEach(p => org.add(p))
  return { org: [...org], self: [...(req.self ?? [])] }
}

/** Names of the person's active, human-assigned group policies (generated compatibility roles are not listed). */
async function activePolicyNames(userId: string): Promise<string[]> {
  try {
    const admin = createAdminClient() as any
    const { data, error } = await admin
      .from('sa_role_assignments')
      .select('status, role:sa_business_roles!inner(name, source)')
      .eq('user_id', userId)
      .eq('status', 'active')
    if (error || !Array.isArray(data)) return []
    return [...new Set<string>(data.filter((row: any) => row.role?.source !== 'legacy').map((row: any) => String(row.role?.name)).filter(Boolean))].sort()
  } catch {
    return []
  }
}

/**
 * Whether the person holds active Root Access (sa_actor_is_root, the evaluator's own rule). Display only: false when
 * Root Access is not installed or the read fails, so nothing is shown that the server would refuse.
 */
async function holdsRootAccess(userId: string): Promise<boolean> {
  try {
    const { data, error } = await (createAdminClient() as any).rpc('sa_actor_is_root', { p_actor: userId })
    return !error && data === true
  } catch {
    return false
  }
}

/**
 * User Management (sidebar entry and the /users page guard): staff of USER_MANAGEMENT_ORG_TYPES who hold the role
 * permission `view_users` as the shell always resolved it (level defaults under the stored role JSON), or whom the
 * engine allows USER_MANAGEMENT_PERMISSION in its current migration mode — which is how a Root Administrator gets in,
 * independent of the legacy role level (Root Access is held by HQ staff only). The legacy role rule is kept alongside
 * the engine so nobody loses the entry they had. The screen's reads and every change decide again on the server and in
 * the database. With `audit` the engine decision is recorded (page guard). Throws when a decision cannot be made.
 */
async function decideUserManagement(actor: NavActor, options: { audit: boolean }): Promise<boolean> {
  if (!USER_MANAGEMENT_ORG_TYPES.includes(actor.orgTypeCode ?? '')) return false
  const legacy = await checkRolePermissionWithDefaults(actor.userId, 'view_users')
  const item = {
    permission: USER_MANAGEMENT_PERMISSION,
    resource: organizationResource('platform_identity', actor.organizationId),
    legacy: () => legacy,
  }
  const decision = options.audit
    ? (await authorizeOperation({ actorId: actor.userId, ...item, explainOnly: false })).decision
    : (await explainMany(actor.userId, [item]))[0]
  return legacy || decision === 'ALLOW'
}

/** Server guard for /users and /users/[id] (another person's record). Same rule as the sidebar entry. */
export async function resolveUserManagementAccess(actor: NavActor): Promise<DestinationAccess> {
  try {
    return (await withPermissionEvaluationScope(() => decideUserManagement(actor, { audit: true })))
      ? { state: 'allowed', destination: 'users' }
      : { state: 'denied' }
  } catch {
    return { state: 'unavailable' }
  }
}

/**
 * The sidebar's User Management and Security & Access answers. Security & Access is decided exactly like its page guard
 * (security.access.view; the legacy evaluator is the manage_authorization rule plus the opt-in delegated path); User
 * Management exactly like its page guard (decideUserManagement). Throws when either cannot be decided, so the snapshot
 * is "unavailable".
 */
async function decideSidebar(actor: NavActor): Promise<NavAccessSnapshot['sidebar']> {
  const [users, [securityAccess]] = await Promise.all([
    decideUserManagement(actor, { audit: false }),
    explainMany(actor.userId, [{
      permission: 'security.access.view',
      resource: organizationResource('security_access', actor.organizationId),
      legacy: () => legacyOrDelegatedSecurityAccess(actor.userId, actor.organizationId, 'security.access.view'),
    }]),
  ])
  return { users, securityAccess: securityAccess === 'ALLOW' }
}

/**
 * The whole navigation snapshot for the caller (no decision audit rows: nothing is being authorized here). The legacy
 * role/department reads are shared by every permission of this one evaluation and discarded afterwards.
 */
export async function evaluateNavSnapshot(actor: NavActor): Promise<NavAccessSnapshot> {
  return withPermissionEvaluationScope(async () => {
    const [answers, sidebar, policies, rootAccess] = await Promise.all([
      decide(actor, navPermissionPlan(), { audit: false }),
      decideSidebar(actor),
      activePolicyNames(actor.userId),
      holdsRootAccess(actor.userId),
    ])
    return {
      userId: actor.userId,
      organizationId: actor.organizationId,
      destinations: computeDestinations(answers),
      sidebar,
      policies,
      rootAccess,
    }
  })
}

/** Access to a specific child view of a module (deep link), falling back to the module's own destination. */
export async function resolveChildViewAccess(profile: any, viewId: string, moduleDestination: string): Promise<DestinationAccess> {
  return resolveDestinationAccess(navActorFromProfile(profile), customerGrowthDestinationForView(viewId, moduleDestination))
}

export type DestinationAccess =
  | { state: 'allowed'; /** The destination that matched (e.g. the staff chart instead of the administrative one). */ destination: string }
  | { state: 'denied' }
  | { state: 'unavailable' }

/**
 * Server page guard for one destination (or the first of several, in order of preference). Records the decisions of the
 * permissions it evaluates, like every other module entry decision.
 */
export async function resolveDestinationAccess(actor: NavActor, destinationIds: string | readonly string[]): Promise<DestinationAccess> {
  const ids = (Array.isArray(destinationIds) ? destinationIds : [destinationIds as string]).map(hrDestinationId)
  const requirements = ids.map(id => ({ id, req: NAV_DESTINATIONS[id] }))
  // An unregistered route is not silently open: it needs its own entry in the destination table.
  if (requirements.some(r => !r.req)) return { state: 'denied' }
  const plan: Plan = {
    org: [...new Set(requirements.flatMap(r => planFor(r.req!).org))],
    self: [...new Set(requirements.flatMap(r => planFor(r.req!).self))],
  }
  let answers: PermissionAnswers
  try {
    answers = await withPermissionEvaluationScope(() => decide(actor, plan, { audit: true }))
  } catch {
    return { state: 'unavailable' }
  }
  for (const { id, req } of requirements) {
    if (destinationAllowed(req!, answers)) return { state: 'allowed', destination: id }
  }
  return { state: 'denied' }
}


/**
 * Server guard for the Customer & Growth landing. Same rule as the sidebar entry (customerGrowthVisible): one of its own
 * business functions opens it, and the shared Product Catalog does so only for people without Supply Chain work, where the
 * catalog lives under Supply Chain instead. Direct URLs of the catalog itself (/catalog/...) are NOT affected: they keep
 * deciding with product.catalog.view in resolveDestinationAccess.
 */
export async function resolveCustomerGrowthLandingAccess(actor: NavActor): Promise<DestinationAccess> {
  // The shared catalog goes last: the first match is then an own business function whenever the person has one.
  const ids = [...CUSTOMER_GROWTH_OWN_MODULE_IDS, 'catalog']
  const first = await resolveDestinationAccess(actor, ids)
  if (first.state !== 'allowed') return first
  // Anything but the shared catalog is a business function of this module: nothing more to decide.
  if (first.destination !== 'catalog') return first
  // Only the shared catalog matched (resolveDestinationAccess answers with the first match in order): another own
  // function never matched, so the person opens this module only if their catalog is not homed in Supply Chain.
  try {
    const answers = await decide(actor, planFor(NAV_DESTINATIONS[SUPPLY_CHAIN_WORK_DESTINATION]!), { audit: false })
    const destinations = { catalog: true, [SUPPLY_CHAIN_WORK_DESTINATION]: destinationAllowed(NAV_DESTINATIONS[SUPPLY_CHAIN_WORK_DESTINATION]!, answers) }
    return customerGrowthVisibleFromDestinations(destinations) ? first : { state: 'denied' }
  } catch {
    return { state: 'unavailable' }
  }
}
