/**
 * In-memory fixture world for Security & Access enforcement tests.
 * Mirrors the Wave 1 compatibility backfill shape: one legacy_portal
 * membership per portal user, one legacy-* role assignment, and an
 * organization or warehouse scope. Test-only; imported by *.test.ts files.
 */
import type { MigrationMode } from './types'

export const ORG = {
  hqA: '00000000-0000-4000-8000-00000000a001',
  whA1: '00000000-0000-4000-8000-00000000a002',
  whA2: '00000000-0000-4000-8000-00000000a003',
  distA: '00000000-0000-4000-8000-00000000a004',
  hqB: '00000000-0000-4000-8000-00000000a006',
  whB: '00000000-0000-4000-8000-00000000a007',
} as const

export const USER = {
  sa: '00000000-0000-4000-8000-000000000001',
  hq: '00000000-0000-4000-8000-000000000002',
  manager: '00000000-0000-4000-8000-000000000011',
  user: '00000000-0000-4000-8000-000000000010',
  wh1: '00000000-0000-4000-8000-000000000003',
  inactive: '00000000-0000-4000-8000-000000000008',
  expired: '00000000-0000-4000-8000-000000000013',
  distManager: '00000000-0000-4000-8000-000000000014',
  hqB: '00000000-0000-4000-8000-000000000007',
} as const

const INVENTORY = [
  'inventory.stock_count.view', 'inventory.stock_count.create', 'inventory.stock_count.verify', 'inventory.stock_count.post',
  'inventory.transfer.view', 'inventory.transfer.request', 'inventory.transfer.approve', 'inventory.transfer.dispatch', 'inventory.transfer.receive',
]

interface Person {
  id: string
  orgId: string
  active: boolean
  legacy: string[] // legacy permission keys (post_stock_count etc.)
  role: string
  permissions: string[]
  scope: { type: 'organization' | 'warehouse'; value: string }
  membershipUntil?: string
}

const people: Person[] = [
  { id: USER.sa, orgId: ORG.hqA, active: true, legacy: ['post_stock_count'], role: 'legacy-sa', permissions: INVENTORY, scope: { type: 'organization', value: ORG.hqA } },
  { id: USER.hq, orgId: ORG.hqA, active: true, legacy: ['post_stock_count'], role: 'legacy-hq', permissions: INVENTORY, scope: { type: 'organization', value: ORG.hqA } },
  { id: USER.manager, orgId: ORG.hqA, active: true, legacy: ['post_stock_count'], role: 'legacy-manager', permissions: INVENTORY, scope: { type: 'organization', value: ORG.hqA } },
  { id: USER.user, orgId: ORG.hqA, active: true, legacy: ['view_inventory'], role: 'legacy-user', permissions: ['inventory.stock_count.view', 'inventory.transfer.view'], scope: { type: 'organization', value: ORG.hqA } },
  { id: USER.wh1, orgId: ORG.whA1, active: true, legacy: ['post_stock_count'], role: 'warehouse-manager', permissions: INVENTORY, scope: { type: 'warehouse', value: ORG.whA1 } },
  { id: USER.inactive, orgId: ORG.hqA, active: false, legacy: ['post_stock_count'], role: 'legacy-hq', permissions: INVENTORY, scope: { type: 'organization', value: ORG.hqA } },
  { id: USER.expired, orgId: ORG.hqA, active: true, legacy: ['post_stock_count'], role: 'legacy-hq', permissions: INVENTORY, scope: { type: 'organization', value: ORG.hqA }, membershipUntil: '2020-01-01T00:00:00Z' },
  { id: USER.distManager, orgId: ORG.distA, active: true, legacy: ['post_stock_count'], role: 'legacy-manager', permissions: INVENTORY, scope: { type: 'organization', value: ORG.distA } },
  { id: USER.hqB, orgId: ORG.hqB, active: true, legacy: ['post_stock_count'], role: 'legacy-hq', permissions: INVENTORY, scope: { type: 'organization', value: ORG.hqB } },
]

export function legacyPermission(userId: string, key: string) {
  const person = people.find(p => p.id === userId)
  return { allowed: Boolean(person?.legacy.includes(key)), reason: 'fixture', context: person ? { organization_id: person.orgId } : null }
}

type Row = Record<string, any>
type Filter = { column: string; value: unknown }

export interface FakeWorld {
  modes: Record<string, MigrationMode>
  sensitivity: Record<string, string>
  decisions: Row[]
  failDecisionInsert: boolean
  failModeLookup: boolean
  failPolicyData: boolean
  /** Error returned by the decision insert instead of the default database error (e.g. an aborted fetch). */
  decisionInsertError?: Row
  /** The users lookup fails (transport/database), as opposed to an inactive account. */
  failAccountLookup?: boolean
  rpcCalls: Array<{ fn: string; args: unknown }>
  rpc: Record<string, (args: any) => { data: unknown; error: unknown }>
  tables: Record<string, Row[]>
}

export function createWorld(): FakeWorld {
  const organizations: Row[] = [
    { id: ORG.hqA, parent_org_id: null, org_type_code: 'HQ', is_active: true, org_name: 'HQ A' },
    { id: ORG.whA1, parent_org_id: ORG.hqA, org_type_code: 'WH', is_active: true, org_name: 'WH A1' },
    { id: ORG.whA2, parent_org_id: ORG.hqA, org_type_code: 'WH', is_active: true, org_name: 'WH A2' },
    { id: ORG.distA, parent_org_id: ORG.hqA, org_type_code: 'DIST', is_active: true, org_name: 'DIST A' },
    { id: ORG.hqB, parent_org_id: null, org_type_code: 'HQ', is_active: true, org_name: 'HQ B' },
    { id: ORG.whB, parent_org_id: ORG.hqB, org_type_code: 'WH', is_active: true, org_name: 'WH B' },
  ]
  const users = people.map(p => ({ id: p.id, is_active: p.active, organization_id: p.orgId, full_name: p.role, email: `${p.role}@fixture.test` }))
  const memberships = people.map(p => ({
    id: `m-${p.id}`, user_id: p.id, organization_id: p.orgId, status: 'active', effective_from: null, effective_until: p.membershipUntil ?? null,
  }))
  const assignments = people.map(p => ({
    id: `a-${p.id}`, user_id: p.id, status: 'active', effective_from: null, effective_until: null, membership_id: `m-${p.id}`,
    role: { id: `r-${p.role}`, role_key: p.role, name: p.role, status: 'active', permissions: p.permissions.map(k => ({ permission: { permission_key: k } })) },
    scopes: [{ scope: { scope_type: p.scope.type, scope_value: p.scope.value } }],
  }))
  return {
    modes: Object.fromEntries(INVENTORY.map(k => [k, 'SHADOW' as MigrationMode])),
    sensitivity: Object.fromEntries(INVENTORY.map(k => [k, 'ordinary'])),
    decisions: [],
    failDecisionInsert: false,
    failModeLookup: false,
    failPolicyData: false,
    rpcCalls: [],
    rpc: {},
    tables: { organizations, users, sa_organization_memberships: memberships, sa_role_assignments: assignments },
  }
}

function rowsFor(world: FakeWorld, table: string): Row[] {
  if (table === 'sa_migration_modes') return Object.entries(world.modes).map(([permission_key, mode]) => ({ permission_key, mode }))
  if (table === 'sa_permissions') return Object.entries(world.sensitivity).map(([permission_key, audit_sensitivity]) => ({ permission_key, audit_sensitivity }))
  if (table === 'sa_authorization_decisions') return world.decisions
  return world.tables[table] ?? []
}

/** Minimal PostgREST-shaped client: select/eq/maybeSingle/single/insert/update/rpc. */
export function fakeClient(world: FakeWorld) {
  return {
    from(table: string) {
      const filters: Filter[] = []
      const resolve = () => {
        if (table === 'sa_migration_modes' && world.failModeLookup) return { data: null, error: { code: '08006', message: 'down' } }
        if (table === 'sa_role_assignments' && world.failPolicyData) return { data: null, error: { code: '08006', message: 'down' } }
        if (table === 'users' && world.failAccountLookup) return { data: null, error: { code: '', message: 'TypeError: fetch failed' } }
        return { data: rowsFor(world, table).filter(r => filters.every(f => r[f.column] === f.value)), error: null }
      }
      const builder: any = {
        select: () => builder,
        eq: (column: string, value: unknown) => { filters.push({ column, value }); return builder },
        neq: () => builder, order: () => builder, limit: () => builder, in: () => builder,
        maybeSingle: async () => { const r = resolve(); return r.error ? r : { data: (r.data as Row[])[0] ?? null, error: null } },
        single: async () => { const r = resolve(); const row = (r.data as Row[] | null)?.[0]; return row ? { data: row, error: null } : { data: null, error: r.error ?? { code: 'PGRST116' } } },
        insert: async (row: Row) => {
          if (table !== 'sa_authorization_decisions') return { data: null, error: null }
          if (world.failDecisionInsert) return { data: null, error: world.decisionInsertError ?? { code: '23502', message: 'insert failed' } }
          world.decisions.push(row)
          return { data: null, error: null }
        },
        update: () => builder,
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(resolve()).then(onFulfilled, onRejected),
      }
      return builder
    },
    async rpc(fn: string, args: unknown) {
      world.rpcCalls.push({ fn, args })
      return world.rpc[fn]?.(args) ?? { data: null, error: null }
    },
  }
}
