/**
 * Human-readable vocabulary for the Security & Access UI. Presentation only:
 * nothing here participates in an authorization decision.
 */

export interface PermissionLabel {
  label: string
  group: string
  resourceType: string
}

const ACTIONS: Record<string, string> = {
  view: 'View', create: 'Create', verify: 'Verify', post: 'Post', request: 'Request',
  approve: 'Approve', dispatch: 'Dispatch', receive: 'Receive', assign: 'Assign', manage: 'Manage',
  prepare: 'Prepare', release: 'Release', adjust: 'Adjust', perform: 'Perform', acknowledge: 'Acknowledge',
  use: 'Use', cancel: 'Cancel', reverse: 'Reverse', grant: 'Grant', reset: 'Reset', view_sensitive: 'View sensitive',
  destructive: 'Run destructive', disable: 'Suspend / Disable', delete: 'Archive',
  profile_edit: 'Edit', view_internal: 'View internal details of', administer: 'Administer', operate: 'Operate',
}

const MODULE_GROUPS: Record<string, string> = {
  finance: 'Finance', hr: 'HR & Payroll', supply_chain: 'Supply Chain', inventory: 'Inventory',
  warehouse: 'Warehouse', manufacturing: 'Manufacturing', qr: 'QR & Traceability', product: 'Product Catalogue',
  roadtour: 'RoadTour', customer: 'Customer & Growth', ecommerce: 'E-Commerce', platform: 'Platform',
  reporting: 'Reporting', security: 'Security Administration', marketing: 'Marketing',
}

const RESOURCES: Record<string, { noun: string; group: string; resourceType: string }> = {
  'inventory.stock_count': { noun: 'Stock Count', group: 'Stock Count', resourceType: 'stock_count' },
  'inventory.transfer': { noun: 'Stock Transfer', group: 'Stock Transfer', resourceType: 'stock_transfer' },
  'security.access': { noun: 'Security & Access', group: 'Security Administration', resourceType: 'security_access' },
  'security.role': { noun: 'Business Roles', group: 'Security Administration', resourceType: 'business_role' },
  'security.permission': { noun: 'Permission Catalog', group: 'Security Administration', resourceType: 'permission_catalog' },
  'security.scope': { noun: 'Scopes', group: 'Security Administration', resourceType: 'scope' },
  'security.policy': { noun: 'Authority & SoD Policies', group: 'Security Administration', resourceType: 'policy' },
  'security.audit': { noun: 'Security Audit', group: 'Security Administration', resourceType: 'audit' },
  'security.access_request': { noun: 'Access Requests', group: 'Security Administration', resourceType: 'access_request' },
  'security.access_review': { noun: 'Access Reviews', group: 'Security Administration', resourceType: 'access_review' },
  'security.delegation': { noun: 'Delegations', group: 'Security Administration', resourceType: 'delegation' },
  'security.service_identity': { noun: 'Service Identities', group: 'Security Administration', resourceType: 'service_identity' },
  'security.emergency_access': { noun: 'Emergency Access', group: 'Security Administration', resourceType: 'emergency_access' },
  'finance.report': { noun: 'Financial Reports', group: 'Finance', resourceType: 'finance_report' },
  'finance.payroll_integration': { noun: 'Payroll GL Integration', group: 'Finance', resourceType: 'payroll_integration' },
  'hr.payroll': { noun: 'Payroll', group: 'HR & Payroll', resourceType: 'payroll_run' },
  'hr.self_service': { noun: 'Employee Self-Service', group: 'HR & Payroll', resourceType: 'employee_record' },
  'hr.module': { noun: 'HR Module', group: 'HR & Payroll', resourceType: 'hr_module' },
  'finance.module': { noun: 'Finance Module', group: 'Finance', resourceType: 'finance_module' },
  'marketing.module': { noun: 'Marketing Module', group: 'Marketing', resourceType: 'marketing_module' },
  'ecommerce.module': { noun: 'E-Commerce Module', group: 'E-Commerce', resourceType: 'ecommerce_module' },
  'ecommerce.outdoor': { noun: 'Outdoor Store', group: 'E-Commerce', resourceType: 'outdoor_store' },
  'customer.crm': { noun: 'CRM Module', group: 'Customer & Growth', resourceType: 'crm_module' },
  'platform.notification_monitor': { noun: 'Delivery Monitors', group: 'Platform', resourceType: 'notification_monitor' },
  'supply_chain.order': { noun: 'Orders', group: 'Supply Chain', resourceType: 'order' },
  'supply_chain.document': { noun: 'Order Documents', group: 'Supply Chain', resourceType: 'document' },
  'inventory.opening_balance': { noun: 'Opening Balance', group: 'Inventory', resourceType: 'opening_balance' },
  'inventory.stock_config': { noun: 'Stock Configurations', group: 'Inventory', resourceType: 'stock_config' },
  'platform.data': { noun: 'Data Maintenance', group: 'Platform', resourceType: 'data_maintenance' },
  'platform.user': { noun: 'User Profiles', group: 'Identity', resourceType: 'identity' },
  'platform.identity': { noun: 'Identities', group: 'Identity', resourceType: 'identity' },
  'platform.identity_access': { noun: 'Identity Access (role / organization)', group: 'Identity', resourceType: 'identity' },
}

export const PERMISSION_GROUP_ORDER = [
  'Finance', 'HR & Payroll', 'Supply Chain', 'Stock Count', 'Stock Transfer', 'Inventory', 'Warehouse', 'Manufacturing',
  'QR & Traceability', 'Product Catalogue', 'RoadTour', 'Customer & Growth', 'E-Commerce', 'Reporting', 'Platform',
  'Identity', 'Security Administration',
]

const titleCase = (value: string) => value.replace(/[_-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

export function permissionLabel(permissionKey: string): PermissionLabel {
  const [module = '', resource = '', action = ''] = permissionKey.split('.')
  const known = RESOURCES[`${module}.${resource}`]
  const verb = ACTIONS[action] ?? titleCase(action)
  if (known) return { label: `${verb} ${known.noun}`, group: known.group, resourceType: known.resourceType }
  return { label: `${verb} ${titleCase(resource)}`, group: MODULE_GROUPS[module] ?? (titleCase(module) || 'Other'), resourceType: resource || 'resource' }
}

export const RESOURCE_TYPE_LABELS: Record<string, string> = {
  stock_count: 'Stock Count',
  stock_transfer: 'Stock Transfer',
  business_role: 'Business Role',
  security_access: 'Security & Access',
  permission_catalog: 'Permission Catalog',
}

export function resourceTypeLabel(resourceType: string): string {
  return RESOURCE_TYPE_LABELS[resourceType] ?? titleCase(resourceType)
}

/**
 * ONE vocabulary for the four stored migration modes (sa_migration_modes.mode),
 * used by every Security & Access screen. Never rename a stored value here.
 */
export const MODE_LABELS: Record<string, { label: string; tone: string; help: string }> = {
  LEGACY_ENFORCED: { label: 'Legacy enforced', tone: 'bg-gray-100 text-gray-700', help: 'Legacy authorization decides. The new model is not used for the outcome.' },
  SHADOW: { label: 'Monitoring / Shadow', tone: 'bg-blue-50 text-blue-700', help: 'Legacy authorization decides; new Security & Access decisions are evaluated and compared for diagnostics.' },
  NEW_ENFORCED: { label: 'New Access Active', tone: 'bg-emerald-50 text-emerald-700', help: 'New Security & Access authorization decides. A legacy allow cannot override a new deny.' },
  LEGACY_RETIRED: { label: 'Legacy Retired', tone: 'bg-purple-50 text-purple-700', help: 'Legacy authorization is retired; only the new Security & Access model is used.' },
}

export function modeLabel(mode: string) {
  return MODE_LABELS[mode] ?? { label: titleCase(mode.toLowerCase()), tone: 'bg-gray-100 text-gray-700', help: '' }
}

export const REASON_LABELS: Record<string, string> = {
  ALLOWED_BY_ASSIGNMENT: 'Allowed by an active role assignment whose scope covers this resource.',
  ACCOUNT_INACTIVE: 'The account is inactive.',
  MISSING_MEMBERSHIP: 'The user has no active membership in this organization.',
  MISSING_ASSIGNMENT: 'The user has no active role assignment in this organization.',
  MISSING_PERMISSION: 'None of the user’s business roles grants this permission.',
  MISSING_CONTEXT: 'The request is missing context the user’s scope needs (for example a warehouse).',
  SCOPE_MISMATCH: 'The user’s role applies to a different organization or warehouse.',
  ALLOWED_BY_DELEGATION: 'Allowed through an active delegation from someone who currently holds this access.',
  ALLOWED_BY_ROOT_ACCESS: 'Allowed by active Root Access (Full System Administrator): every active permission in every organization.',
  LEGACY_ALLOWED: 'Allowed by the existing (legacy) role permissions.',
  LEGACY_DENIED: 'Denied by the existing (legacy) role permissions.',
  POLICY_ERROR: 'The policy could not be evaluated; access is denied for safety.',
}

export function reasonLabel(reasonCode: string | null | undefined): string {
  if (!reasonCode) return '—'
  return REASON_LABELS[reasonCode] ?? titleCase(reasonCode.toLowerCase())
}

export const COMPARISON_LABELS: Record<string, { label: string; tone: string }> = {
  MATCH_ALLOW: { label: 'Both allow', tone: 'bg-emerald-50 text-emerald-700' },
  MATCH_DENY: { label: 'Both deny', tone: 'bg-gray-100 text-gray-700' },
  LEGACY_ALLOW_NEW_DENY: { label: 'Legacy allows, new denies', tone: 'bg-amber-50 text-amber-800' },
  LEGACY_DENY_NEW_ALLOW: { label: 'Legacy denies, new allows', tone: 'bg-red-50 text-red-700' },
  SCOPE_MISMATCH: { label: 'Scope mismatch', tone: 'bg-amber-50 text-amber-800' },
  MISSING_ASSIGNMENT: { label: 'Missing assignment', tone: 'bg-amber-50 text-amber-800' },
  MISSING_CONTEXT: { label: 'Missing context', tone: 'bg-amber-50 text-amber-800' },
  POLICY_ERROR: { label: 'Policy error', tone: 'bg-red-50 text-red-700' },
}

export function comparisonLabel(comparison: string) {
  return COMPARISON_LABELS[comparison] ?? { label: titleCase(comparison.toLowerCase()), tone: 'bg-gray-100 text-gray-700' }
}

export const ORG_TYPE_LABELS: Record<string, string> = {
  HQ: 'Headquarters', WH: 'Warehouse', DIST: 'Distributor', MFG: 'Manufacturer', SHOP: 'Shop',
}

export function orgTypeLabel(orgType: string | null | undefined): string {
  return orgType ? ORG_TYPE_LABELS[orgType] ?? orgType : ''
}

export interface DirectoryOrganization {
  id: string
  org_name: string
  org_type_code: string | null
  parent_org_id: string | null
}

/** Warehouses owned by (or equal to) the selected organization, following the parent chain. */
export function warehousesForOrganization(organizations: DirectoryOrganization[], organizationId: string | null | undefined): DirectoryOrganization[] {
  const warehouses = organizations.filter(o => o.org_type_code === 'WH')
  if (!organizationId) return warehouses
  const byId = new Map(organizations.map(o => [o.id, o]))
  const underSelected = (org: DirectoryOrganization) => {
    let current: DirectoryOrganization | undefined = org
    for (let depth = 0; current && depth < 8; depth += 1) {
      if (current.id === organizationId) return true
      current = current.parent_org_id ? byId.get(current.parent_org_id) : undefined
    }
    return false
  }
  return warehouses.filter(underSelected)
}
