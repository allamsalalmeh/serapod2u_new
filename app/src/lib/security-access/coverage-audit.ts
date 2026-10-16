import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FINAL_WAVE_CATALOG } from './catalog'
import { IDENTITY_CATALOG } from './identity-catalog'
import { STAGE2D_PERMISSION_KEYS } from './stage2d-catalog'
import { HR_DATA_PERMISSION_KEYS } from './hr-data-catalog'
import { USER_ADMIN_PERMISSION_KEYS } from './user-admin-catalog'
import { SYSTEM_LOGS_PERMISSION_KEYS } from './system-logs-catalog'
import { BANK_STATEMENT_PERMISSION_KEYS } from './bank-statement-catalog'
import { ORDER_VIEW_PERMISSION_KEYS } from './order-view'
import { INVENTORY_STOCK_VIEW_PERMISSION } from './inventory-stock'
import { COMMISSION_PERMISSION_KEYS } from './commission'
import { MSS_PERMISSION_KEYS } from './mss'
import { COMPENSATION_VIEWER_PERMISSION_KEYS } from './compensation-viewer'
import { ALL_ENFORCEMENT_READY_PERMISSIONS } from './readiness'
import { ROUTE_COVERAGE } from './route-coverage'
import { classifyPermission } from './modules'

/**
 * Static coverage audit (read-only, no database): compares the permission
 * catalogue, the migration-mode registry seeds, enforcement readiness, the
 * profiles seeded by migrations and the runtime route checks. Different
 * objects are compared on purpose — permission counts and profile counts are
 * NOT expected to match, and a permission or area without a profile is a
 * finding to review, not an error.
 */
const MIGRATIONS = resolve(process.cwd(), '..', 'supabase', 'migrations')

const WAVE1_PERMISSIONS = ['security.access.view', 'security.role.assign', 'security.permission.manage', 'inventory.stock_count.view', 'inventory.stock_count.create',
  'inventory.stock_count.verify', 'inventory.stock_count.post', 'inventory.transfer.view', 'inventory.transfer.request', 'inventory.transfer.approve',
  'inventory.transfer.dispatch', 'inventory.transfer.receive']

/** role_key → permission keys, parsed from the migrations' seed statements. */
export function seededProfilePermissions(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  const add = (role: string, keys: string[]) => { const set = map.get(role) ?? new Set<string>(); keys.forEach(k => set.add(k)); map.set(role, set) }
  for (const file of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(resolve(MIGRATIONS, file), 'utf8')
    for (const statement of sql.split(/insert into public\.sa_business_role_permissions/i).slice(1)) {
      const body = statement.slice(0, statement.indexOf(';'))
      for (const m of body.matchAll(/\(\s*'([a-z0-9-]+)'\s*,\s*array\[([^\]]*)\]\s*\)/g)) add(m[1], [...m[2].matchAll(/'([a-z_.]+)'/g)].map(x => x[1]))
      for (const m of body.matchAll(/\(\s*'([a-z0-9-]+)'\s*,\s*'([a-z_.]+)'\s*\)/g)) add(m[1], [m[2]])
      for (const m of body.matchAll(/role_key\s*=\s*'([a-z0-9-]+)'\s+and\s+p\.permission_key\s*=\s*'([a-z_.]+)'/g)) add(m[1], [m[2]])
    }
  }
  // Wave 1 templates use a different statement shape.
  add('warehouse-operator', ['inventory.stock_count.view', 'inventory.stock_count.create', 'inventory.stock_count.verify', 'inventory.transfer.view', 'inventory.transfer.request', 'inventory.transfer.receive'])
  add('warehouse-manager', WAVE1_PERMISSIONS.filter(k => k.startsWith('inventory.')))
  // The QR Batch Operator profile (20261006100000) is a single explicit insert.
  if (readFileSync(resolve(MIGRATIONS, '20261006100000_sa_qr_batch_operator_profile.sql'), 'utf8').includes("'qr-batch-operator'")) add('qr-batch-operator', ['qr.batch.manage'])
  // The Group Policies migration seeds the module Full Access policies as explicit arrays inside one VALUES list.
  const gp = readFileSync(resolve(MIGRATIONS, '20261009100000_sa_group_policies_full_access.sql'), 'utf8')
  for (const m of gp.matchAll(/\(\s*'([a-z0-9-]+-full-access)'\s*,[\s\S]*?array\[([^\]]*)\]\s*,\s*array\[([^\]]*)\]\s*\)/g)) add(m[1], [...m[3].matchAll(/'([a-z_.]+)'/g)].map(x => x[1]))
  // The password-reset migration (20261016100000) seeds one narrow policy and extends Platform & Settings Full Access with the same key.
  const reset = readFileSync(resolve(MIGRATIONS, '20261016100000_sa_user_password_reset_permission.sql'), 'utf8')
  if (reset.includes("'user-password-administrator'")) add('user-password-administrator', [...USER_ADMIN_PERMISSION_KEYS])
  if (reset.includes("sa_extend_standard_policy('platform-settings-full-access'")) add('platform-settings-full-access', [...USER_ADMIN_PERMISSION_KEYS])
  // The System Logs migration (20261017110000) seeds one narrow policy and extends nothing.
  const logs = readFileSync(resolve(MIGRATIONS, '20261017110000_sa_system_logs_view_permission.sql'), 'utf8')
  if (logs.includes("'system-log-viewer'")) add('system-log-viewer', [...SYSTEM_LOGS_PERMISSION_KEYS])
  // View Orders (20261101100000) is the supporting read of the order policies and is covered by Supply Chain Full Access.
  const orderView = readFileSync(resolve(MIGRATIONS, '20261101100000_sa_order_view_policy_dependencies.sql'), 'utf8')
  if (orderView.includes("b.role_key in ('order-approver', 'order-creator')")) {
    for (const role of ['order-approver', 'order-creator']) add(role, [...ORDER_VIEW_PERMISSION_KEYS])
  }
  if (orderView.includes("sa_extend_standard_policy('supply-chain-full-access'")) add('supply-chain-full-access', [...ORDER_VIEW_PERMISSION_KEYS])
  // View Inventory (20261031100000): the Inventory Viewer policy, and the Supply Chain Full Access extension.
  const stockView = readFileSync(resolve(MIGRATIONS, '20261031100000_sa_inventory_stock_view.sql'), 'utf8')
  if (stockView.includes("'inventory-viewer'")) add('inventory-viewer', [INVENTORY_STOCK_VIEW_PERMISSION])
  if (stockView.includes("sa_extend_standard_policy('supply-chain-full-access', array['inventory.stock.view']")) add('supply-chain-full-access', [INVENTORY_STOCK_VIEW_PERMISSION])
  // Warehouse Manager = Full Access to Products, Inventory and Quality & Returns (20261109100000): one explicit list.
  const wm = readFileSync(resolve(MIGRATIONS, '20261109100000_sa_warehouse_manager_full_access.sql'), 'utf8')
  const wmTarget = wm.match(/v_target constant text\[\] := array\[([^\]]*)\]/)
  if (wmTarget && wm.includes("sa_extend_standard_policy('warehouse-manager'")) add('warehouse-manager', [...wmTarget[1].matchAll(/'([a-z_.]+)'/g)].map(x => x[1]))
  // Policy hardening (20261110100000): six new policies in one VALUES list (role_key, name, module, prefixes, org types,
  // description, perms), then destructive keys removed from Full Access through sa_narrow_standard_policy.
  const ph = readFileSync(resolve(MIGRATIONS, '20261110100000_sa_policy_hardening_and_new_standard_policies.sql'), 'utf8')
  const seed = ph.slice(ph.indexOf('do $seed$'), ph.indexOf('end $seed$'))
  for (const m of seed.matchAll(/\(\s*'([a-z0-9-]+)',\s*'[^']*',\s*'[a-z_]+',\s*array\[[^\]]*\],\s*array\[[^\]]*\],\s*'(?:[^']|'')*',\s*array\[([^\]]*)\]\s*\)/g)) {
    add(m[1], [...m[2].matchAll(/'([a-z_.]+)'/g)].map(x => x[1]))
  }
  for (const m of ph.matchAll(/select public\.sa_narrow_standard_policy\('([a-z0-9-]+)',\s*array\[([^\]]*)\]/g)) {
    const set = map.get(m[1])
    for (const k of [...m[2].matchAll(/'([a-z_.]+)'/g)].map(x => x[1])) set?.delete(k)
  }
  return map
}

export interface CoverageReport {
  universe: string[]
  /** Registered somewhere in code but not a known permission (typos / stale keys). */
  orphanReady: string[]
  orphanRoutes: string[]
  /** Not placed in any module group of the shared taxonomy. */
  unclassified: string[]
  /** No standard/custom profile seeded by a migration contains it. */
  withoutProfile: string[]
  /** Profile permissions that are not in the universe. */
  profileOrphans: string[]
  /** In the catalogue but referenced by no route and not ready (informational). */
  noRuntimeReference: string[]
}

export function coverageReport(): CoverageReport {
  const universe = new Set<string>([
    ...WAVE1_PERMISSIONS, ...FINAL_WAVE_CATALOG.map(e => e.key), ...IDENTITY_CATALOG.map(e => e.key), ...STAGE2D_PERMISSION_KEYS, ...HR_DATA_PERMISSION_KEYS, ...USER_ADMIN_PERMISSION_KEYS, ...SYSTEM_LOGS_PERMISSION_KEYS,
    ...ORDER_VIEW_PERMISSION_KEYS,
    INVENTORY_STOCK_VIEW_PERMISSION,
    ...COMMISSION_PERMISSION_KEYS,
    ...MSS_PERMISSION_KEYS, ...COMPENSATION_VIEWER_PERMISSION_KEYS,
    ...BANK_STATEMENT_PERMISSION_KEYS,
  ])
  const profiles = seededProfilePermissions()
  const inProfile = new Set([...profiles.values()].flatMap(s => [...s]))
  const routePermissions = new Set(Object.values(ROUTE_COVERAGE).flatMap((r: any) => r.permissions ?? []))
  return {
    universe: [...universe].sort(),
    orphanReady: ALL_ENFORCEMENT_READY_PERMISSIONS.filter(k => !universe.has(k)),
    orphanRoutes: [...routePermissions].filter(k => !universe.has(k as string)) as string[],
    unclassified: [...universe].filter(k => classifyPermission(k).groupId === 'other').sort(),
    withoutProfile: [...universe].filter(k => !inProfile.has(k)).sort(),
    profileOrphans: [...inProfile].filter(k => !universe.has(k)).sort(),
    noRuntimeReference: [...universe].filter(k => !routePermissions.has(k) && !ALL_ENFORCEMENT_READY_PERMISSIONS.includes(k)).sort(),
  }
}
