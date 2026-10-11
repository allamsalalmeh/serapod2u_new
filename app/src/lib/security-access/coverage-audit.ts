import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FINAL_WAVE_CATALOG } from './catalog'
import { IDENTITY_CATALOG } from './identity-catalog'
import { STAGE2D_PERMISSION_KEYS } from './stage2d-catalog'
import { HR_DATA_PERMISSION_KEYS } from './hr-data-catalog'
import { ORDER_VIEW_PERMISSION_KEYS } from './order-view'
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
    ...WAVE1_PERMISSIONS, ...FINAL_WAVE_CATALOG.map(e => e.key), ...IDENTITY_CATALOG.map(e => e.key), ...STAGE2D_PERMISSION_KEYS, ...HR_DATA_PERMISSION_KEYS,
    ...ORDER_VIEW_PERMISSION_KEYS,
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
