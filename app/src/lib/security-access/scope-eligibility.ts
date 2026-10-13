/**
 * Shared, client-safe scope eligibility for Group Policy assignment.
 *
 * ONE implementation used by the Add User picker, the Security & Access grant form, the self-service request form and
 * the server-side grant validation (scope-grant.ts), so every screen and every direct API call gives the same answer.
 *
 * Approved semantics (data scope only; it never adds permissions to a published policy and never bypasses approvals):
 *   - HQ recipient: the picker offers ONLY the HQ itself ("HQ and all its warehouses") and the warehouses that
 *     explicitly belong to that HQ (an active organization of type WH whose parent_org_id is the HQ), each "this
 *     warehouse only". Shops, Distributors and Manufacturers are never offered to an HQ recipient.
 *   - Selecting the HQ scope is an `organization` scope on the HQ. The evaluator (public.sa_scope_matches) resolves it
 *     dynamically through parent_org_id, so a warehouse attached later is covered with no copied grants, and a warehouse
 *     that is removed or moved to another HQ stops being covered at once.
 *   - A warehouse choice is a `warehouse` scope: it matches only resources whose warehouse is exactly that warehouse.
 *     It never authorizes an operation that carries no warehouse (the evaluator reports missing context and denies).
 *   - Any other recipient (a warehouse user, or a Manufacturer / Distributor / Shop account): the recipient's own
 *     organization and the organizations beneath it, which is the hierarchy the evaluator already honours. No new
 *     partner hierarchy rule is introduced here.
 *   - Exactly one choice per organization: a warehouse that carries both an `organization` and a `warehouse` scope
 *     definition is shown once, as the canonical `warehouse` scope. Definitions are never deleted or rewritten.
 */

export interface ScopeOrg {
  id: string
  name: string
  typeCode: string
  parentId: string | null
  isActive?: boolean | null
}

export interface ScopeDefinitionLike {
  id: string
  organization_id: string | null
  scope_type: string
  scope_value?: string | null
  display_name: string
}

export type ScopeChoiceKind = 'hq' | 'warehouse' | 'organization'

export interface ScopeChoice {
  scopeId: string
  scopeType: string
  /** The organization (or warehouse) this scope stands for. */
  targetOrganizationId: string
  kind: ScopeChoiceKind
  /** Actual organization / warehouse name. */
  name: string
  /** One-line picker label, e.g. "Serapod HQ — HQ and all its warehouses". */
  label: string
  /** Short coverage text kept visible next to the choice. */
  coverage: string
}

const upper = (v?: string | null) => String(v ?? '').trim().toUpperCase()
const STRUCTURAL = new Set(['organization', 'warehouse'])
export const isStructuralScopeType = (t: string) => STRUCTURAL.has(t)

export const isHqType = (t?: string | null) => upper(t) === 'HQ'
export const isWarehouseType = (t?: string | null) => upper(t) === 'WH'

/** Short coverage labels kept visible beside a choice; the longer explanations live in the ⓘ popover (SCOPE_HELP). */
export const HQ_COVERAGE = 'HQ and all its warehouses'
export const WAREHOUSE_COVERAGE = 'This warehouse only'
export const ORGANIZATION_COVERAGE = 'This organization'

export const SCOPE_HELP: readonly string[] = [
  'HQ scope: the policy’s permissions apply to HQ data and to every warehouse attached to this HQ, including warehouses attached later. Nothing is copied per warehouse, and a warehouse that is removed or moved to another HQ stops being covered.',
  'Warehouse scope: the permissions apply to that warehouse only. They never reach another warehouse, and they do not authorize organization-wide operations that cannot be limited to a warehouse.',
  'A scope limits data only. It does not add permissions to a policy, bypass approvals or give access to unrelated partner organizations.',
]

export function scopeChoiceLabel(kind: ScopeChoiceKind, name: string): string {
  if (kind === 'hq') return `${name} — HQ and all its warehouses`
  if (kind === 'warehouse') return `${name} — this warehouse only`
  return `${name} — this organization`
}

/** Active warehouses that explicitly belong to the HQ. Not "every descendant". */
export function warehousesOfHq(hqId: string, orgs: readonly ScopeOrg[]): ScopeOrg[] {
  return orgs.filter(o => isWarehouseType(o.typeCode) && o.parentId === hqId && o.isActive !== false)
}

/** Organizations the recipient's choices may stand for. */
export function eligibleTargetOrganizations(recipient: ScopeOrg, orgs: readonly ScopeOrg[]): ScopeOrg[] {
  if (isHqType(recipient.typeCode)) return [recipient, ...warehousesOfHq(recipient.id, orgs)]
  if (isWarehouseType(recipient.typeCode)) return [recipient]
  // Partner / other organization: itself and everything beneath it (the hierarchy the evaluator already honours).
  const byParent = new Map<string, ScopeOrg[]>()
  for (const o of orgs) if (o.parentId) byParent.set(o.parentId, [...(byParent.get(o.parentId) ?? []), o])
  const out: ScopeOrg[] = [recipient]
  const seen = new Set<string>([recipient.id])
  const queue = [recipient.id]
  for (let depth = 0; queue.length && depth < 10; depth++) {
    const next: string[] = []
    for (const id of queue) for (const child of byParent.get(id) ?? []) {
      if (seen.has(child.id) || child.isActive === false) continue
      seen.add(child.id); out.push(child); next.push(child.id)
    }
    queue.splice(0, queue.length, ...next)
  }
  return out
}

function kindFor(target: ScopeOrg): ScopeChoiceKind {
  if (isHqType(target.typeCode)) return 'hq'
  if (isWarehouseType(target.typeCode)) return 'warehouse'
  return 'organization'
}

/**
 * The canonical scope choices for a recipient. `scopes` are the active scope definitions that exist; a target
 * organization without a usable definition simply has no choice (nothing is created here).
 */
export function canonicalScopeChoices(recipient: ScopeOrg, orgs: readonly ScopeOrg[], scopes: readonly ScopeDefinitionLike[]): ScopeChoice[] {
  const choices: ScopeChoice[] = []
  for (const target of eligibleTargetOrganizations(recipient, orgs)) {
    const kind = kindFor(target)
    const mine = scopes.filter(s => isStructuralScopeType(s.scope_type) && s.organization_id === target.id && (s.scope_value == null || s.scope_value === target.id))
    // A warehouse is the canonical `warehouse` scope; fall back to an `organization` definition only when no warehouse one exists.
    const wanted = kind === 'warehouse' ? ['warehouse', 'organization'] : ['organization']
    const def = wanted.map(t => mine.find(s => s.scope_type === t)).find(Boolean)
    if (!def) continue
    choices.push({
      scopeId: def.id, scopeType: def.scope_type, targetOrganizationId: target.id, kind, name: target.name,
      label: scopeChoiceLabel(kind, target.name),
      coverage: kind === 'hq' ? HQ_COVERAGE : kind === 'warehouse' ? WAREHOUSE_COVERAGE : ORGANIZATION_COVERAGE,
    })
  }
  // The recipient's own organization first, then organizations, then warehouses; each by name.
  const rank = (c: ScopeChoice) => (c.targetOrganizationId === recipient.id ? 0 : c.kind === 'warehouse' ? 2 : 1)
  return choices.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/**
 * Server check for one submitted scope id against the recipient (the picker and the API share this).
 * Structural scopes must be a canonical-or-fallback choice target; other typed scopes (department, territory, ...)
 * are not part of this picker and are judged by the database rules as before.
 */
export function isScopeEligible(recipient: ScopeOrg, orgs: readonly ScopeOrg[], scope: ScopeDefinitionLike): boolean {
  if (!isStructuralScopeType(scope.scope_type)) return true
  if (!scope.organization_id) return false
  const target = eligibleTargetOrganizations(recipient, orgs).find(o => o.id === scope.organization_id)
  if (!target) return false
  if (scope.scope_value != null && scope.scope_value !== target.id) return false
  // An organization-typed definition on a warehouse is the legacy duplicate of its warehouse definition: still valid.
  return kindFor(target) === 'warehouse' ? true : scope.scope_type === 'organization'
}

/* ── Policy compatibility ─────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Permissions whose enforcement carries the warehouse of the resource, so a `warehouse` scope can limit them.
 * Derived from the enforcement points (sa_require_operation gates in 20260928120000_sa_final_modules_supply_chain.sql
 * and the stock-count verification routes). Every other permission is decided on the organization alone: a warehouse
 * scope cannot match it, so it is denied (fail closed), never over-granted.
 */
export const WAREHOUSE_SCOPED_PERMISSIONS: ReadonlySet<string> = new Set([
  'inventory.adjustment.post',
  'inventory.opening_balance.manage',
  'inventory.return.manage',
  'inventory.transfer.approve',
  'inventory.transfer.cancel',
  'inventory.transfer.dispatch',
  'inventory.transfer.receive',
  'inventory.transfer.request',
  'inventory.stock_count.verify',
  'inventory.stock_count.post',
  'warehouse.receipt.post',
  'warehouse.shipment.manage',
])

export type WarehouseSupportLevel = 'full' | 'partial' | 'none'
export interface WarehouseSupport { level: WarehouseSupportLevel; supported: number; total: number }

/** How much of a policy a warehouse-only scope can actually limit and grant. Unknown contents → 'full' (not restricted). */
export function warehouseSupportFor(permissionKeys?: readonly string[] | null): WarehouseSupport {
  const keys = permissionKeys ?? []
  if (!keys.length) return { level: 'full', supported: 0, total: 0 }
  const supported = keys.filter(k => WAREHOUSE_SCOPED_PERMISSIONS.has(k)).length
  return { level: supported === keys.length ? 'full' : supported === 0 ? 'none' : 'partial', supported, total: keys.length }
}

export const warehouseUnsupportedMessage = 'This Group Policy has no permission that a single warehouse can limit, so it cannot be assigned to one warehouse. Choose the HQ scope instead.'

/** Short visible caveat for a policy only partly limited by a warehouse scope. */
export function warehousePartialNote(support: WarehouseSupport): string {
  return `A warehouse scope covers ${support.supported} of this policy's ${support.total} permissions.`
}
export const WAREHOUSE_PARTIAL_DETAIL = 'The remaining permissions are decided at organization level, so a warehouse-only scope does not grant them. Choose the HQ scope to use the whole policy. No permission is removed from the published policy.'

/** Whether a choice may be offered / submitted for a policy. Never edits the policy. */
export function choiceAllowedForPolicy(choice: Pick<ScopeChoice, 'kind'>, support?: WarehouseSupport | null): boolean {
  if (!support) return true
  return !(choice.kind === 'warehouse' && support.level === 'none')
}
