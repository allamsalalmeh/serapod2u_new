/**
 * Security & Access module taxonomy — the ONE display grouping used by every
 * S&A tab (Overview, People & Access, Roles & Policies, Technical Access,
 * Governance, Audit).
 *
 * Presentation only. A module group is how the UI organises features; it is
 * never an authorization boundary and never grants anything:
 *   - Organization membership: which organization a person belongs to.
 *   - Business role: which actions are permitted.
 *   - Scope: which records or areas those actions cover.
 *   - Assignment source: automatic lifecycle access vs explicitly granted.
 *
 * Classification uses stable identifiers only: the permission key's module and
 * resource (sa_permissions.permission_key), the permissions a business role
 * actually holds, and a service identity's owner_team. Names are never parsed.
 */

type Matcher = (module: string, resource: string) => boolean
export interface ModuleArea { id: string; name: string; match: Matcher }
export interface ModuleGroup { id: string; name: string; match: Matcher; areas?: ModuleArea[] }

const mod = (...modules: string[]): Matcher => (m) => modules.includes(m)
const res = (m: string, ...resources: string[]): Matcher => (mm, r) => mm === m && resources.includes(r)
const any = (...matchers: Matcher[]): Matcher => (m, r) => matchers.some(fn => fn(m, r))

/**
 * Groups and areas, in display order. Within a group the first matching area
 * wins; a permission of a known module whose resource matches no area is
 * listed directly under its group (never dropped).
 */
export const MODULE_TAXONOMY: readonly ModuleGroup[] = [
  {
    id: 'supply_chain', name: 'Supply Chain', match: mod('supply_chain', 'inventory', 'warehouse', 'manufacturing', 'product', 'qr'),
    areas: [
      { id: 'orders', name: 'Orders & Documents', match: mod('supply_chain') },
      { id: 'stock_count', name: 'Stock Count', match: res('inventory', 'stock_count') },
      { id: 'stock_transfer', name: 'Stock Transfer', match: res('inventory', 'transfer') },
      { id: 'inventory', name: 'Inventory', match: mod('inventory') },
      { id: 'warehouse', name: 'Warehouse', match: mod('warehouse') },
      { id: 'manufacturing', name: 'Manufacturing', match: mod('manufacturing') },
      { id: 'product_catalogue', name: 'Product Catalogue', match: mod('product') },
      { id: 'qr', name: 'QR & Traceability', match: mod('qr') },
    ],
  },
  {
    id: 'customer_growth', name: 'Customer & Growth', match: mod('customer', 'roadtour', 'ecommerce', 'marketing'),
    areas: [
      { id: 'crm', name: 'CRM & Customers', match: res('customer', 'crm', 'consumer', 'shop', 'report') },
      { id: 'loyalty', name: 'Loyalty & Rewards', match: res('customer', 'loyalty', 'program', 'redemption', 'reward') },
      { id: 'messaging', name: 'Messaging & Support', match: res('customer', 'messaging', 'support') },
      { id: 'roadtour', name: 'RoadTour', match: mod('roadtour') },
      { id: 'marketing', name: 'Marketing & Campaigns', match: any(mod('marketing'), res('customer', 'campaign', 'banner')) },
      // SeraOutdoor is its own storefront business. Its permission is stored
      // under ecommerce (ecommerce.outdoor.*) and its orders appear in the
      // E-Commerce store orders, so it stays in Customer & Growth — but as
      // its own area rather than folded into generic E-Commerce.
      { id: 'outdoor', name: 'Outdoor Store', match: res('ecommerce', 'outdoor') },
      { id: 'ecommerce', name: 'E-Commerce', match: mod('ecommerce') },
    ],
  },
  {
    id: 'hr_payroll', name: 'HR & Payroll', match: mod('hr'),
    areas: [
      // Staff sales commission (hr.commission.*) is pay: it sits with payroll and compensation.
      { id: 'payroll', name: 'Payroll & Compensation', match: res('hr', 'payroll', 'compensation', 'benefits', 'commission') },
      { id: 'employees', name: 'Employees & Contracts', match: res('hr', 'employee', 'contract', 'onboarding', 'recruitment') },
      { id: 'time_leave', name: 'Time, Leave & Expenses', match: res('hr', 'attendance', 'leave', 'leave_request', 'expense') },
      { id: 'performance', name: 'Performance & Learning', match: res('hr', 'performance', 'learning') },
      { id: 'self_service', name: 'Employee Self-Service', match: res('hr', 'self_service') },
      { id: 'manager_self_service', name: 'Manager Self-Service', match: res('hr', 'mss') },
      // hr.data.reset is listed here; its migration mode (e.g. Legacy Retired) is stored per permission and unaffected.
      { id: 'hr_admin', name: 'HR Administration', match: res('hr', 'module', 'settings', 'policy', 'analytics', 'ai', 'data') },
    ],
  },
  {
    id: 'finance', name: 'Finance', match: mod('finance'),
    areas: [
      { id: 'general_ledger', name: 'General Ledger', match: res('finance', 'ledger', 'journal', 'account') },
      { id: 'payables', name: 'Payables & Payments', match: res('finance', 'payable', 'payment') },
      { id: 'receivables', name: 'Receivables', match: res('finance', 'receivable') },
      { id: 'cash_bank', name: 'Cash & Bank', match: res('finance', 'cash', 'reconciliation') },
      { id: 'finance_reports', name: 'Financial Reports', match: res('finance', 'report') },
      { id: 'finance_admin', name: 'Finance Administration', match: res('finance', 'module', 'settings', 'data', 'payroll_integration') },
    ],
  },
  {
    id: 'platform_security', name: 'Platform & Security', match: mod('platform', 'security'),
    areas: [
      { id: 'identity', name: 'Identity', match: res('platform', 'identity', 'identity_access') },
      { id: 'user_admin', name: 'User Administration', match: res('platform', 'user') },
      { id: 'notifications', name: 'Notifications', match: res('platform', 'notification_monitor') },
      { id: 'integrations', name: 'Integrations & Settings', match: res('platform', 'settings') },
      { id: 'organizations', name: 'Organizations & Data', match: res('platform', 'organization', 'data') },
      { id: 'platform', name: 'Platform', match: mod('platform') },
      { id: 'security_governance', name: 'Security Governance', match: mod('security') },
    ],
  },
  // Shared, cross-module analytics only. Module-specific reports (customer,
  // RoadTour, finance, inventory) keep their originating module.
  { id: 'reporting', name: 'Reporting', match: mod('reporting') },
]

/** Items without a reliable mapping stay visible here. */
export const OTHER_MODULE = { id: 'other', name: 'Other / Unmapped' }
/** Business roles whose permissions span more than one module group. */
export const CROSS_MODULE = { id: 'cross_module', name: 'Shared / Cross-module' }

const GROUP_NAMES = new Map<string, string>([
  ...MODULE_TAXONOMY.map(g => [g.id, g.name] as [string, string]),
  [OTHER_MODULE.id, OTHER_MODULE.name], [CROSS_MODULE.id, CROSS_MODULE.name],
])
export const moduleGroupName = (id: string) => GROUP_NAMES.get(id) ?? id
/** Display order (taxonomy, then cross-module, then other). */
export const moduleGroupRank = (id: string) => {
  const i = MODULE_TAXONOMY.findIndex(g => g.id === id)
  return i >= 0 ? i : id === CROSS_MODULE.id ? MODULE_TAXONOMY.length : MODULE_TAXONOMY.length + 1
}
export const MODULE_FILTER_OPTIONS = MODULE_TAXONOMY.map(g => ({ id: g.id, name: g.name }))

export interface ModuleClass { groupId: string; areaId: string | null; areaName: string | null }

/** Permission key → module group and area. Unknown modules → Other / Unmapped. */
export function classifyPermission(permissionKey: string): ModuleClass {
  const [module = '', resource = ''] = String(permissionKey || '').split('.')
  const group = MODULE_TAXONOMY.find(g => g.match(module, resource))
  if (!group) return { groupId: OTHER_MODULE.id, areaId: null, areaName: null }
  const area = group.areas?.find(a => a.match(module, resource)) ?? null
  return { groupId: group.id, areaId: area?.id ?? null, areaName: area?.name ?? null }
}

/** Position of an area inside its group (taxonomy order); unmatched permissions sort last. */
export function areaRank(groupId: string, areaId: string | null): number {
  const i = MODULE_TAXONOMY.find(g => g.id === groupId)?.areas?.findIndex(a => a.id === areaId) ?? -1
  return i >= 0 ? i : 999
}

export interface TaxonomyArea<T> { id: string; name: string; items: T[] }
export interface TaxonomyModule<T> { id: string; name: string; areas: Array<TaxonomyArea<T>>; total: number }
/** Functional area shown for permissions of a module that match no area. */
export const GENERAL_AREA = { id: '_general', name: 'General' }

/**
 * THE module → functional area → operation grouping used by Migration Modes,
 * the Permission Catalogue, Access Profiles (details and editor) and People &
 * Access. Ids, names and ordering come only from MODULE_TAXONOMY. It is a
 * navigation aid: it never grants or inherits anything.
 */
export function groupByTaxonomy<T>(items: T[], keyOf: (item: T) => string): Array<TaxonomyModule<T>> {
  const modules = new Map<string, Map<string, TaxonomyArea<T>>>()
  for (const item of items) {
    const c = classifyPermission(keyOf(item))
    const areas = modules.get(c.groupId) ?? new Map<string, TaxonomyArea<T>>()
    const id = c.areaId ?? GENERAL_AREA.id
    const area = areas.get(id) ?? { id, name: c.areaName ?? GENERAL_AREA.name, items: [] }
    area.items.push(item)
    areas.set(id, area)
    modules.set(c.groupId, areas)
  }
  return Array.from(modules.entries())
    .sort(([a], [b]) => moduleGroupRank(a) - moduleGroupRank(b))
    .map(([id, areas]) => {
      const list = Array.from(areas.values()).sort((a, b) => areaRank(id, a.id === GENERAL_AREA.id ? null : a.id) - areaRank(id, b.id === GENERAL_AREA.id ? null : b.id))
      return { id, name: moduleGroupName(id), areas: list, total: list.reduce((n, a) => n + a.items.length, 0) }
    })
}

/** "Supply Chain · Stock Count" — for grouped selects. */
export function permissionModuleLabel(permissionKey: string) {
  const c = classifyPermission(permissionKey)
  return c.areaName ? `${moduleGroupName(c.groupId)} · ${c.areaName}` : moduleGroupName(c.groupId)
}

// ── Business roles ────────────────────────────────────────────────────────

export interface RoleModules {
  /** Display group: a taxonomy group, cross_module, or other. */
  groupId: string
  /** Every module group the role's permissions touch (taxonomy order). */
  modules: string[]
  /** Groups other than the display group (tags). */
  related: string[]
  crossModule: boolean
}

/** Module-entry permissions (e.g. finance.module.view) only open a module. */
const isEntryPermission = (key: string) => key.split('.')[1] === 'module'

export const rolePermissionKeys = (role: any): string[] =>
  (role?.permissions || []).map((x: any) => (typeof x === 'string' ? x : x?.permission?.permission_key)).filter(Boolean)

/**
 * Classifies a business role by the permissions it actually holds. A role is
 * cross-module only when its substantive permissions span several groups;
 * module-entry permissions alone only add a related-module tag. Roles with no
 * mapped permissions go to Other / Unmapped. Role names are never inspected.
 */
export function classifyRole(role: any): RoleModules {
  const keys = rolePermissionKeys(role)
  const all = new Set(keys.map(k => classifyPermission(k).groupId))
  const substantive = new Set(keys.filter(k => !isEntryPermission(k)).map(k => classifyPermission(k).groupId))
  const core = substantive.size ? substantive : all
  core.delete(OTHER_MODULE.id)
  const order = (ids: Iterable<string>) => Array.from(ids).filter(id => id !== OTHER_MODULE.id).sort((a, b) => moduleGroupRank(a) - moduleGroupRank(b))
  const modules = order(all)
  if (core.size === 0) return { groupId: OTHER_MODULE.id, modules, related: modules, crossModule: false }
  if (core.size > 1) return { groupId: CROSS_MODULE.id, modules, related: modules, crossModule: true }
  const groupId = Array.from(core)[0]
  return { groupId, modules, related: modules.filter(m => m !== groupId), crossModule: false }
}

/** A role belongs to a module filter when any of its permissions does. */
export const roleInModule = (role: any, moduleId: string, cls = classifyRole(role)) =>
  moduleId === 'all' || cls.groupId === moduleId || cls.modules.includes(moduleId)

/** Groups items by their display group, in taxonomy order, hiding empty groups. */
export function groupByModule<T>(items: T[], groupOf: (item: T) => string): Array<{ id: string; name: string; items: T[] }> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const id = groupOf(item)
    map.set(id, [...(map.get(id) || []), item])
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => moduleGroupRank(a) - moduleGroupRank(b))
    .map(([id, list]) => ({ id, name: moduleGroupName(id), items: list }))
}

// ── Service identities ────────────────────────────────────────────────────

/**
 * sa_service_identities.owner_team → taxonomy. owner_team is a stable team
 * value seeded with each identity; unknown teams stay visible under Other.
 */
const SERVICE_TEAMS: Record<string, { groupId: string; areaName: string | null }> = {
  supplychain: { groupId: 'supply_chain', areaName: null },
  customergrowth: { groupId: 'customer_growth', areaName: null },
  ecommerce: { groupId: 'customer_growth', areaName: 'E-Commerce' },
  hrpayroll: { groupId: 'hr_payroll', areaName: null },
  finance: { groupId: 'finance', areaName: null },
  platform: { groupId: 'platform_security', areaName: 'Platform' },
  security: { groupId: 'platform_security', areaName: 'Security Governance' },
  reporting: { groupId: 'reporting', areaName: null },
}
export const teamKey = (team?: string | null) => (team ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

export function classifyServiceTeam(team?: string | null): { groupId: string; areaName: string | null } {
  const known = SERVICE_TEAMS[teamKey(team)]
  if (known) return known
  return { groupId: OTHER_MODULE.id, areaName: team ? String(team).trim() : null }
}
