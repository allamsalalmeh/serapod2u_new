/**
 * Navigation destinations and the Security & Access permissions that unlock them.
 *
 * ONE table drives every surface that decides "may this person see/open X":
 *   - server page guards (getHrPageContext, Customer & Growth / RoadTour entry),
 *   - the per-user snapshot served by /api/security-access/me/navigation,
 *   - sidebar entries, module landing cards, top navigation and in-page actions.
 *
 * Hiding a destination is never authorization: every route, API and mutation keeps its own server check. The snapshot
 * only mirrors what the server's canonical evaluation (authorizeOperation, in the permission's current migration mode)
 * answers for the same permissions.
 *
 * Isomorphic and pure: no server imports.
 */

import { INVENTORY_STOCK_READ_PERMISSIONS } from './inventory-stock'
import { ORDER_VIEW_PERMISSION } from './order-view'
import { MSS_PERMISSIONS } from './mss'
import { COMPENSATION_VIEWER_PERMISSION_KEYS } from './compensation-viewer'

/** `org`: decided on the caller's organization. `self`: decided on the caller's OWN record (own_record scope). */
export interface NavRequirement {
  /** The module-entry permission must also be allowed (administrative destinations). */
  module?: string
  /** Any one of these, evaluated on the caller's organization. Empty with `module` = module entry alone. */
  org?: readonly string[]
  /** Any one of these, evaluated on the caller's own record. Needs no module-entry permission. */
  self?: readonly string[]
  /** Any one of these, evaluated on the caller's organization, without the module-entry permission (staff reads). */
  staff?: readonly string[]
}

export const HR_MODULE_PERMISSION = 'hr.module.view'
export const ESS_PERMISSION = 'hr.self_service.use'
/** Existing read-only directory permission (Stage 2D): colleagues' non-sensitive employment details. */
export const STAFF_DIRECTORY_PERMISSION = 'hr.employee.view_internal'

const hrAdmin = (...org: string[]): NavRequirement => ({ module: HR_MODULE_PERMISSION, org })

/** HR destinations by view id (the id the dashboard shell and the top navigation use). */
export const HR_DESTINATIONS: Record<string, NavRequirement> = {
  // Administrative landing. Employee-only users land on My Workspace instead.
  hr: hrAdmin(),
  'hr/my-workspace': { self: [ESS_PERMISSION] },
  'hr/self-service/overview': { self: [ESS_PERMISSION] },

  // Manager Self-Service (explicit grant; decided on the manager's organization, data scoped to direct reports).
  // These unlock the manager sections inside My Workspace; they need no module entry (a manager is not an HR admin).
  'hr/my-team': { staff: [MSS_PERMISSIONS.teamView] },
  'hr/team-attendance': { staff: [MSS_PERMISSIONS.attendanceView] },
  'hr/team-leave': { staff: [MSS_PERMISSIONS.leaveView] },
  'hr/team-requests': { staff: [MSS_PERMISSIONS.requestsView] },
  'hr/team-performance': { staff: [MSS_PERMISSIONS.performanceView] },
  // Restricted Manager Compensation Viewer (read-only basic salary + authorized fixed allowances of direct reports).
  'hr/team-compensation': { staff: [...COMPENSATION_VIEWER_PERMISSION_KEYS] },

  /** In-page action: create/edit/onboard employees (the people, departments and positions screens' edit controls). */
  'hr:manage-people': hrAdmin('hr.employee.manage'),

  'hr/people': hrAdmin('hr.employee.view'),
  'hr/people/employees': hrAdmin('hr.employee.view'),
  'hr/people/departments': hrAdmin('hr.employee.view'),
  'hr/people/positions': hrAdmin('hr.employee.view'),
  'hr/people/org-chart': hrAdmin('hr.employee.view'),
  /** The limited read-only chart (name, job title, department, reporting line). */
  'hr/people/org-chart/staff': { staff: [STAFF_DIRECTORY_PERMISSION] },

  // The desktop attendance screen carries policy administration; employees clock in and out from My Attendance.
  'hr/attendance/clock-in-out': hrAdmin('hr.attendance.manage'),
  'hr/attendance/public-holidays': hrAdmin('hr.settings.manage', 'hr.attendance.manage'),
  'hr/attendance/timesheets': hrAdmin('hr.attendance.manage'),

  'hr/leave/types': hrAdmin('hr.leave.approve'),
  'hr/leave/requests': hrAdmin('hr.leave.approve'),
  'hr/leave/approval-flow': hrAdmin('hr.leave.approve'),

  'hr/payroll/salary-structure': hrAdmin('hr.compensation.view', 'hr.payroll.view'),
  'hr/payroll/allowances-deductions': hrAdmin('hr.compensation.view', 'hr.payroll.view'),
  'hr/payroll/payslips': hrAdmin('hr.payroll.view'),
  // Staff Sales Commission (compensation data; no legacy audience). The commission APIs re-check every action.
  'hr/payroll/commission-settings': hrAdmin('hr.commission.view'),

  'hr/performance/kpis': hrAdmin('hr.performance.manage'),
  'hr/performance/appraisals': hrAdmin('hr.performance.manage'),
  'hr/performance/reviews': hrAdmin('hr.performance.manage'),

  'hr/settings': hrAdmin('hr.settings.manage'),
  'hr/settings/departments': hrAdmin('hr.settings.manage'),
  'hr/settings/positions': hrAdmin('hr.settings.manage'),
  'hr/settings/approval-rules': hrAdmin('hr.settings.manage'),
  'hr/settings/permissions': hrAdmin('hr.settings.manage'),
  'hr/settings/accounting': hrAdmin('hr.settings.manage'),
  'hr/settings/configuration': hrAdmin('hr.settings.manage'),

  'hr/recruitment': hrAdmin('hr.recruitment.manage'),
  'hr/learning': hrAdmin('hr.learning.manage'),
  'hr/onboarding': hrAdmin('hr.onboarding.manage'),
  'hr/benefits': hrAdmin('hr.benefits.manage'),
  'hr/compliance-docs': hrAdmin('hr.policy.manage'),
  'hr/analytics': hrAdmin('hr.analytics.view'),
  'hr/time-expense': hrAdmin('hr.expense.manage'),
}

/**
 * Customer & Growth child destinations, keyed by the child ids in customerGrowthNav (module and group children).
 * Each maps to the permission the destination's own server entry guard decides with.
 */
const ROADTOUR = ['roadtour.campaign.manage', 'roadtour.report.view', 'roadtour.visit.manage', 'roadtour.kpi.manage']
const LOYALTY = ['customer.reward.manage', 'customer.program.manage', 'customer.redemption.manage', 'customer.loyalty.adjust', 'customer.campaign.manage']
/** product.catalog.view is also held by Supply Chain Full Access: the Product Catalog destination is a legitimate shared one. */
const CATALOG = ['product.catalog.view']

/**
 * Permissions the shared taxonomy (modules.ts) files under Supply Chain, other than the shared catalog view itself.
 * Holding any of them means the person works in Supply Chain, which is then where the Product Catalog is offered
 * (see productCatalogHome). Navigation only: it grants nothing, and no page or API consults this list to authorize.
 * nav-access.test.ts keeps it in step with the taxonomy and the permission catalogues.
 */
export const SUPPLY_CHAIN_ACCESS_PERMISSIONS: readonly string[] = [
  'supply_chain.order.view', 'supply_chain.order.create', 'supply_chain.order.approve', 'supply_chain.order.cancel',
  'supply_chain.document.acknowledge', 'supply_chain.document.manage',
  'inventory.transfer.view', 'inventory.transfer.request', 'inventory.transfer.approve', 'inventory.transfer.dispatch',
  'inventory.transfer.receive', 'inventory.transfer.cancel',
  'inventory.stock_count.view', 'inventory.stock_count.create', 'inventory.stock_count.verify', 'inventory.stock_count.post',
  'inventory.stock.view',
  'inventory.adjustment.post', 'inventory.opening_balance.manage', 'inventory.stock_config.manage',
  'inventory.return.request', 'inventory.return.manage', 'inventory.report.view',
  'warehouse.receipt.post', 'warehouse.shipment.manage',
  'manufacturing.production.manage', 'manufacturing.adjustment.manage', 'manufacturing.adjustment.administer',
  'manufacturing.scan.reverse',
  'qr.batch.manage',
  'product.catalog.manage',
]
const ECOMMERCE = ['ecommerce.module.view']

/** The CRM / Marketing module entries (their pages' own guards) are required together with the child's own permission. */
const crmChild = (...org: string[]): NavRequirement => ({ module: 'customer.crm.view', org })
const marketingChild = (...org: string[]): NavRequirement => ({ module: 'marketing.module.view', org })

export const CUSTOMER_GROWTH_DESTINATIONS: Record<string, NavRequirement> = {
  // CRM: the module entry (customer.crm.view) only opens the shell. Each function needs the permission its data and APIs
  // decide with, so holding the entry (or a Supply Chain policy) never exposes customer activity or the support inbox.
  crm: crmChild('customer.consumer.view', 'customer.support.manage', 'customer.support.administer'),
  'consumer-activations': crmChild('customer.consumer.view'),
  'support-inbox': crmChild('customer.support.manage', 'customer.support.administer'),
  mktg: marketingChild('customer.campaign.manage', 'customer.messaging.manage'),
  'landing-pages': marketingChild('customer.campaign.manage'),
  'journey-builder': marketingChild('customer.campaign.manage'),
  marketing: marketingChild('customer.messaging.manage'),
  // Event Management is gated by the Marketing parent permission alone (no event.*
  // permissions yet): module entry only, with the same organization isolation as
  // its pages and APIs (which each re-check marketing.module.view server-side).
  'event-management': marketingChild(),
  roadtour: { org: ROADTOUR },
  loyalty: { org: LOYALTY },
  'point-catalog': { org: ['customer.reward.manage'] },
  'lucky-draw': { org: ['customer.campaign.manage'] },
  'scratch-card-game': { org: ['customer.campaign.manage'] },
  'redeem-gift-management': { org: ['customer.redemption.manage'] },
  catalog: { org: CATALOG },
  'product-catalog': { org: CATALOG },
  ecommerce: { org: ECOMMERCE },
  'hero-banners': { org: ECOMMERCE },
  'store-banner-manager': { org: ECOMMERCE },
  'login-hero-banner': { org: ECOMMERCE },
  'store-orders': { org: ECOMMERCE },
  'ecommerce/tiktok-shop': { org: ECOMMERCE },
  'ecommerce/payment-gateway': { org: ECOMMERCE },
}

/**
 * RoadTour sections. The module entry ('roadtour') needs any RoadTour permission; each section then needs the
 * permission its own screens and APIs decide with. Every RoadTour API keeps its own server check regardless.
 */
export const ROADTOUR_DESTINATIONS: Record<string, NavRequirement> = {
  'roadtour:campaigns': { org: ['roadtour.campaign.manage'] },
  'roadtour:reporting': { org: ['roadtour.report.view', 'roadtour.visit.manage', 'roadtour.kpi.manage'] },
  'roadtour:visits': { org: ['roadtour.visit.manage', 'roadtour.report.view'] },
  'roadtour:settings': { org: ['roadtour.campaign.manage', 'roadtour.kpi.manage'] },
  'roadtour:kpi-settings': { org: ['roadtour.kpi.manage'] },
}

/** The Customer & Growth top-level destinations whose visibility makes the parent entry visible. */
export const CUSTOMER_GROWTH_MODULE_IDS = ['crm', 'mktg', 'roadtour', 'loyalty', 'catalog', 'ecommerce'] as const

/**
 * Supply Chain work (not a page): decides where the shared Product Catalog is offered. Not a Customer & Growth child.
 */
export const SUPPLY_CHAIN_WORK_DESTINATION = 'supply-chain:work'

/** Supply Chain's Organizations screens are where partner organizations are administered. */
const ORGANIZATION_ADMIN = ['platform.organization.manage']
const ORDER_WORK = [ORDER_VIEW_PERMISSION, 'supply_chain.order.create', 'supply_chain.order.approve', 'supply_chain.order.cancel',
  'supply_chain.document.acknowledge', 'supply_chain.document.manage']
const STOCK_COUNT = ['inventory.stock_count.view', 'inventory.stock_count.create', 'inventory.stock_count.verify',
  'inventory.stock_count.post', 'inventory.adjustment.post']
const STOCK_TRANSFER = ['inventory.transfer.view', 'inventory.transfer.request', 'inventory.transfer.approve',
  'inventory.transfer.dispatch', 'inventory.transfer.receive', 'inventory.transfer.cancel']

/** The Supply Chain module entry (sidebar, /supply-chain landing): any Supply Chain function, or organization admin. */
export const SUPPLY_CHAIN_MODULE_DESTINATION = 'supply-chain'
const scView = (...org: string[]): NavRequirement => ({ org })

/**
 * Supply Chain destinations by `supply-chain/<view id>` (supplyChainNav ids). Each maps to the permissions its own
 * screen's APIs, RPCs and RLS decide with, so the landing, top navigation, page guard and data agree. The legacy
 * organization-type / role-level rules in supplyChainNav still apply on top as business boundaries.
 */
export const SUPPLY_CHAIN_VIEW_DESTINATIONS: Record<string, NavRequirement> = {
  'supply-chain/organizations': scView(...ORGANIZATION_ADMIN),
  'supply-chain/add-organization': scView(...ORGANIZATION_ADMIN),
  // The product list reads the catalogue; master data changes it.
  'supply-chain/products': scView('product.catalog.view', 'product.catalog.manage'),
  'supply-chain/product-management': scView('product.catalog.manage'),
  'supply-chain/orders': scView(...ORDER_WORK),
  // Order Details / tracking: View Orders only — the permission GET /api/orders/[orderId]/access decides with (its legacy
  // rule is the historical role level 40). Standard order policies include it explicitly (policy-dependencies.ts); an
  // operation permission alone does not open an order.
  'supply-chain/view-order': scView(ORDER_VIEW_PERMISSION),
  'supply-chain/create-order': scView('supply_chain.order.create'),
  'supply-chain/distributor-order': scView('supply_chain.order.create'),
  'supply-chain/shop-order': scView('supply_chain.order.create'),
  'supply-chain/distributor-incentive': scView(...ORDER_WORK),
  'supply-chain/qr-batches': scView('qr.batch.manage'),
  'supply-chain/manufacturer-scan-2': scView('manufacturing.production.manage'),
  'supply-chain/manufacturer-quality-issues': scView('manufacturing.adjustment.manage', 'manufacturing.adjustment.administer'),
  'supply-chain/warehouse-receive-2': scView('warehouse.receipt.post'),
  'supply-chain/warehouse-ship-v2': scView('warehouse.shipment.manage'),
  // View Inventory: the same permissions the database stock rule reads balances with (inventory-stock.ts).
  'supply-chain/inventory-list': scView(...INVENTORY_STOCK_READ_PERMISSIONS),
  'supply-chain/inventory-settings': scView('inventory.stock_config.manage'),
  'supply-chain/add-stock': scView('inventory.adjustment.post'),
  'supply-chain/stock-adjustment': scView(...STOCK_COUNT),
  'supply-chain/stock-transfer': scView(...STOCK_TRANSFER),
  'supply-chain/stock-movements': scView('inventory.report.view'),
  'supply-chain/return-product': scView('inventory.return.request', 'inventory.return.manage'),
  'supply-chain/return-settings': scView('inventory.return.manage'),
  'supply-chain/return-reporting': scView('inventory.return.manage'),
}

export const SUPPLY_CHAIN_DESTINATIONS: Record<string, NavRequirement> = {
  [SUPPLY_CHAIN_WORK_DESTINATION]: { org: SUPPLY_CHAIN_ACCESS_PERMISSIONS },
  // The shared catalog view alone does not open Supply Chain (it lives in Customer & Growth for catalog-only users).
  [SUPPLY_CHAIN_MODULE_DESTINATION]: { org: [...SUPPLY_CHAIN_ACCESS_PERMISSIONS, ...ORGANIZATION_ADMIN] },
  ...SUPPLY_CHAIN_VIEW_DESTINATIONS,
}

/** Views reached from a list (detail/edit/new) are decided like the list they come from. */
const SUPPLY_CHAIN_VIEW_ALIASES: Record<string, string> = {
  inventory: 'inventory-list',
  'view-product': 'products', 'edit-product': 'products', 'add-product': 'product-management',
  'track-order': 'view-order',
  'view-organization': 'organizations', 'edit-organization': 'organizations', 'edit-organization-hq': 'organizations',
}

/**
 * The destination a Supply Chain view is decided with: its own `supply-chain/<view>`, else the module entry. Used by the
 * page guards (direct URLs), the landing cards, the top navigation and the in-app view switch, so all four agree.
 */
export function supplyChainDestinationForView(viewId: string): string {
  const id = SUPPLY_CHAIN_VIEW_ALIASES[viewId] ?? viewId
  const destination = `supply-chain/${id}`
  return SUPPLY_CHAIN_VIEW_DESTINATIONS[destination] ? destination : SUPPLY_CHAIN_MODULE_DESTINATION
}

export const FINANCE_MODULE_PERMISSION = 'finance.module.view'

const financeChild = (...org: string[]): NavRequirement => ({ module: FINANCE_MODULE_PERMISSION, org })
const FINANCE_LEDGER = financeChild('finance.ledger.view')
const FINANCE_RECEIVABLES = financeChild('finance.receivable.view')
const FINANCE_PAYABLES = financeChild('finance.payable.view')
const FINANCE_CASH = financeChild('finance.cash.view')
const FINANCE_REPORTS = financeChild('finance.report.view_sensitive')
// The settings screens read with finance.ledger.view (the routes' GET check) and change with finance.settings.manage.
const FINANCE_SETTINGS = financeChild('finance.settings.manage', 'finance.ledger.view')

/**
 * Finance destinations by view id (financeNav ids). The module entry (finance.module.view) opens the landing and status
 * pages only; each section also needs the permission its own APIs read with, so a Finance entry never implies every
 * Finance function. Operations (posting, reconciliation, payment approval, settings changes) keep their own server and
 * database checks.
 */
export const FINANCE_DESTINATIONS: Record<string, NavRequirement> = {
  finance: financeChild(),
  'finance/status': financeChild(),
  'finance/gl/journals': FINANCE_LEDGER,
  'finance/gl/pending-postings': FINANCE_LEDGER,
  'finance/gl/chart-of-accounts': FINANCE_LEDGER,
  'finance/ar/invoices': FINANCE_RECEIVABLES,
  'finance/ar/receipts': FINANCE_RECEIVABLES,
  'finance/ar/aging': FINANCE_RECEIVABLES,
  'finance/ap/bills': FINANCE_PAYABLES,
  'finance/ap/payments': FINANCE_PAYABLES,
  'finance/ap/aging': FINANCE_PAYABLES,
  'finance/cash/bank-accounts': FINANCE_CASH,
  'finance/cash/statements': FINANCE_CASH,
  'finance/cash/reconciliation': FINANCE_CASH,
  // The cash flow screen reads the sensitive cashflow report.
  'finance/cash/cashflow': FINANCE_REPORTS,
  'finance/reports/trial-balance': FINANCE_REPORTS,
  'finance/reports/profit-loss': FINANCE_REPORTS,
  'finance/reports/balance-sheet': FINANCE_REPORTS,
  'finance/reports/gl-detail': FINANCE_REPORTS,
  'finance/reports/cashflow': FINANCE_REPORTS,
  'finance/settings/default-accounts': FINANCE_SETTINGS,
  'finance/settings/currency': FINANCE_SETTINGS,
  'finance/settings/fiscal-year': FINANCE_SETTINGS,
  'finance/settings/posting-rules': FINANCE_SETTINGS,
  'finance/settings/configuration': FINANCE_SETTINGS,
  // Explains where Finance access is administered; holds no data.
  'finance/settings/permissions': financeChild(),
}

export const NAV_DESTINATIONS: Record<string, NavRequirement> = {
  ...HR_DESTINATIONS,
  ...FINANCE_DESTINATIONS,
  ...SUPPLY_CHAIN_DESTINATIONS,
  ...CUSTOMER_GROWTH_DESTINATIONS,
  ...ROADTOUR_DESTINATIONS,
}

/** Every permission a destination may need, with the kind of resource it is evaluated on. */
export function navPermissionPlan(): { org: string[]; self: string[] } {
  const org = new Set<string>()
  const self = new Set<string>()
  for (const req of Object.values(NAV_DESTINATIONS)) {
    if (req.module) org.add(req.module)
    req.org?.forEach(p => org.add(p))
    req.staff?.forEach(p => org.add(p))
    req.self?.forEach(p => self.add(p))
  }
  return { org: [...org].sort(), self: [...self].sort() }
}

export type PermissionAnswers = {
  org: Readonly<Record<string, boolean>>
  self: Readonly<Record<string, boolean>>
}

/** Pure destination decision from per-permission answers (shared by the server snapshot and tests). */
export function destinationAllowed(req: NavRequirement, answers: PermissionAnswers): boolean {
  const orgAny = (list: readonly string[] | undefined) => (list ?? []).some(p => answers.org[p] === true)
  if (req.self && req.self.some(p => answers.self[p] === true)) return true
  if (req.staff && orgAny(req.staff)) return true
  if (req.module !== undefined || req.org !== undefined) {
    if (req.module && answers.org[req.module] !== true) return false
    if (req.org && req.org.length > 0) return orgAny(req.org)
    // Module entry alone, or an organization requirement list that is empty.
    return Boolean(req.module)
  }
  return false
}

export function computeDestinations(answers: PermissionAnswers): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const [id, req] of Object.entries(NAV_DESTINATIONS)) out[id] = destinationAllowed(req, answers)
  return out
}

/** Normalizes a path or view id (`/hr/people/employees`, `hr-people`) to a destination id. */
export function hrDestinationId(viewOrPath: string): string {
  const id = viewOrPath.replace(/^\//, '').replace(/\/$/, '')
  const section = /^hr\/(recruitment|learning|onboarding|benefits|compliance-docs|analytics|time-expense)(\/|$)/.exec(id)
  if (section) return `hr/${section[1]}`
  if (id === 'hr-people') return 'hr/people'
  if (id === 'hr-org-chart') return 'hr/people/org-chart'
  if (id === 'hr-departments') return 'hr/people/departments'
  if (id === 'hr-positions') return 'hr/people/positions'
  if (id === 'hr-settings') return 'hr/settings'
  if (id === 'hr/org-chart') return 'hr/people/org-chart'
  if (id === 'hr/departments') return 'hr/people/departments'
  if (id === 'hr/positions') return 'hr/people/positions'
  return id
}

/** Per-user answer set. `userId`/`organizationId` bind it to the identity it was computed for. */
export interface NavAccessSnapshot {
  userId: string
  organizationId: string | null
  destinations: Record<string, boolean>
  /**
   * Sidebar entries decided by the same server evaluation as their pages, so the whole menu resolves together:
   *   users           User Management (USER_MANAGEMENT_ORG_TYPES + role `view_users` with level defaults, or
   *                   USER_MANAGEMENT_PERMISSION allowed by the engine — Root Access included); the /users page guard
   *   securityAccess  `security.access.view` decided by the engine in its current migration mode (the page's own guard)
   */
  sidebar: { users: boolean; securityAccess: boolean }
  /** Active, named group policies (not generated compatibility roles) for ordinary display. */
  policies: string[]
  /**
   * The person holds active Root Access (database answer, sa_actor_is_root). Display only: lets screens stop applying
   * their legacy role-level pre-checks; every operation is still decided on the server, where Root is evaluated.
   */
  rootAccess?: boolean
}

/** Organization types whose staff may open User Management (the sidebar entry's historical rule). */
export const USER_MANAGEMENT_ORG_TYPES: readonly string[] = ['HQ', 'DIST', 'WH', 'SHOP']
/** The Security & Access permission that also opens User Management (Root Access allows every active permission). */
export const USER_MANAGEMENT_PERMISSION = 'platform.identity.view'

export const HR_MODULE_DESTINATIONS = Object.keys(HR_DESTINATIONS)

export function snapshotAllows(snapshot: NavAccessSnapshot | null | undefined, id: string): boolean {
  return snapshot?.destinations?.[id] === true
}

export function snapshotAllowsAny(snapshot: NavAccessSnapshot | null | undefined, ids: readonly string[]): boolean {
  return ids.some(id => snapshotAllows(snapshot, id))
}

/** HR parent entry: at least one HR destination (workspace, staff chart or administrative) is reachable. */
export function hrModuleVisible(snapshot: NavAccessSnapshot | null | undefined): boolean {
  return snapshotAllowsAny(snapshot, HR_MODULE_DESTINATIONS)
}

/** True when the person holds administrative HR (module entry), not only employee destinations. */
export function hrAdminVisible(snapshot: NavAccessSnapshot | null | undefined): boolean {
  return snapshotAllows(snapshot, 'hr')
}

/**
 * Finance sidebar entry: the module entry decision the /finance page guard makes (finance.module.view, in its current
 * migration mode; a Finance Full Access policy or Root Access answers it once the permission is enforced by S&A).
 */
export function financeModuleVisible(snapshot: NavAccessSnapshot | null | undefined): boolean {
  return snapshotAllows(snapshot, 'finance')
}

/**
 * Supply Chain sidebar entry: the /supply-chain page guard's decision (any Supply Chain permission, or organization
 * administration). Unresolved answers show nothing, like the other S&A-driven entries.
 */
export function supplyChainModuleVisible(snapshot: NavAccessSnapshot | null | undefined): boolean {
  return snapshotAllows(snapshot, SUPPLY_CHAIN_MODULE_DESTINATION)
}

/** A Supply Chain view (landing card, top navigation, in-app switch): the module entry and the view's own destination. */
export function supplyChainViewVisible(snapshot: NavAccessSnapshot | null | undefined, viewId: string): boolean {
  return supplyChainModuleVisible(snapshot) && snapshotAllows(snapshot, supplyChainDestinationForView(viewId))
}

/** Customer & Growth destinations that are its own business functions (everything except the shared Product Catalog). */
export const CUSTOMER_GROWTH_OWN_MODULE_IDS = CUSTOMER_GROWTH_MODULE_IDS.filter(id => id !== 'catalog')

/** The Product Catalog destinations (module entry and its child page) that are shared with Supply Chain. */
const SHARED_CATALOG_IDS: readonly string[] = ['catalog', 'product-catalog']

export type ProductCatalogHome = 'supply-chain' | 'customer-growth'

/**
 * Where the shared Product Catalog is offered (sidebar, landing cards, top navigation, breadcrumbs): ONE place, so a
 * person never sees it twice. People who work in Supply Chain (hold a Supply Chain permission) get it there; everyone
 * else who may open it, catalog-only users included, keeps it under Customer & Growth. `null` = not authorized, or the
 * answers are not ready. The route and API keep deciding with product.catalog.view regardless of this value.
 */
export function productCatalogHomeFromDestinations(destinations: Readonly<Record<string, boolean>> | null | undefined): ProductCatalogHome | null {
  if (!destinations || destinations.catalog !== true) return null
  return destinations[SUPPLY_CHAIN_WORK_DESTINATION] === true ? 'supply-chain' : 'customer-growth'
}

export function productCatalogHome(snapshot: NavAccessSnapshot | null | undefined): ProductCatalogHome | null {
  return productCatalogHomeFromDestinations(snapshot?.destinations)
}

/**
 * Customer & Growth parent entry. Its own business functions always open it; the shared Product Catalog does so only
 * when the catalog lives here (no Supply Chain work), so Supply Chain + a catalog view never opens this module.
 */
export function customerGrowthVisibleFromDestinations(destinations: Readonly<Record<string, boolean>> | null | undefined): boolean {
  if (!destinations) return false
  return CUSTOMER_GROWTH_OWN_MODULE_IDS.some(id => destinations[id] === true) || productCatalogHomeFromDestinations(destinations) === 'customer-growth'
}

export function customerGrowthVisible(snapshot: NavAccessSnapshot | null | undefined): boolean {
  return customerGrowthVisibleFromDestinations(snapshot?.destinations)
}

/** Whether a Customer & Growth child (by nav child id) is reachable AND belongs to this module for this person. */
export function customerGrowthChildVisible(snapshot: NavAccessSnapshot | null | undefined, childId: string): boolean {
  if (!snapshotAllows(snapshot, childId)) return false
  if (SHARED_CATALOG_IDS.includes(childId)) return productCatalogHome(snapshot) === 'customer-growth'
  return true
}

/** Keeps the groups (and children) whose destination is allowed; a group without an allowed child is dropped. */
export function filterGroupsByDestination<G extends { children: readonly { id: string }[] }>(
  groups: readonly G[],
  allows: (destinationId: string) => boolean,
): G[] {
  return groups
    .map(group => ({ ...group, children: group.children.filter(child => allows(child.id)) }))
    .filter(group => group.children.length > 0)
}

/**
 * The destination a Customer & Growth child view is decided with: its own, else the module's. Used by the module pages'
 * deep links (/crm/support-inbox ...), so a direct URL needs the same permission as the menu entry.
 */
export function customerGrowthDestinationForView(viewId: string, moduleDestination: string): string {
  return NAV_DESTINATIONS[viewId] ? viewId : moduleDestination
}
