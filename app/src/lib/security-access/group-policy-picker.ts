import { OTHER_MODULE, classifyRole, moduleGroupName, moduleGroupRank } from './modules'
import { fullAccessPolicy } from './group-policies'
import { choiceAllowedForPolicy, type ScopeChoiceKind, type WarehouseSupport } from './scope-eligibility'

/**
 * Pure selection logic of the Add User Group Policy picker (checkbox hierarchy, Standard / Custom tabs).
 *
 * Nothing here authorizes anything: the catalogue handed in is already filtered by the server (audience, publication,
 * assignment authority, privileged-initial-assignment and recipient rules) and the database re-checks at submission.
 * This module only decides how a selection changes when a box is ticked, so it can be tested without a browser.
 *
 * The selection is the same list the form always submitted: one { roleId, scopeId } pair per policy and scope. A
 * policy that is ticked but has no scope yet is a pair with scopeId '' — it is shown, it blocks the submission, and it
 * never means "global".
 */

export interface SelectableProfile {
  id: string; name: string; description?: string | null; permissionCount?: number; roleKey?: string | null
  /** 'standard' = shipped template policy, 'custom' = created in Security & Access. Absent on legacy payloads. */
  kind?: 'standard' | 'custom'
  /** Permissions the published policy holds. Absent = unknown, so coverage can never be proven for it. */
  permissionKeys?: string[] | null
  /** Scope types this policy supports. Absent = the catalogue does not restrict it (the organization filter still applies). */
  scopeTypes?: string[] | null
  /** How much of the policy a warehouse-only scope can limit (shared eligibility). Absent = not restricted. */
  warehouseSupport?: WarehouseSupport | null
}
export interface SelectableScope {
  id: string; organization_id: string | null; scope_type: string; display_name: string
  /** Canonical choice metadata from the shared scope eligibility (absent on legacy payloads, which fall back to scope labels). */
  kind?: ScopeChoiceKind; label?: string; coverage?: string
}
/** One policy with ONE explicit scope ('' = ticked, scope not chosen yet). The same pair never twice. */
export interface ProfileChoice { roleId: string; scopeId: string }

/** Upper bound the server accepts for one creation (policy × scope pairs). */
export const MAX_POLICY_SCOPE_PAIRS = 20

/** Scopes a policy may use: its supported scope types (when the catalogue states them), inside the selected organization tree. */
export function scopesForPolicy(policy: SelectableProfile | undefined, scopes: SelectableScope[]) {
  if (!policy) return []
  const types = policy.scopeTypes
  const byType = types && types.length ? scopes.filter(s => types.includes(s.scope_type)) : scopes
  // A warehouse-only scope is not offered for a policy none of whose permissions a single warehouse can limit.
  return byType.filter(s => !s.kind || choiceAllowedForPolicy({ kind: s.kind }, policy.warehouseSupport))
}

// ── Catalogue ─────────────────────────────────────────────────────────────

export const policyKind = (p: SelectableProfile): 'standard' | 'custom' =>
  p.kind ?? (fullAccessPolicy(p.roleKey) ? 'standard' : 'custom')

/** The module a Full Access policy stands for: from the catalogue of standard policies (role key), never from its name. */
export const fullAccessModuleOf = (p: SelectableProfile) =>
  policyKind(p) === 'standard' ? fullAccessPolicy(p.roleKey)?.moduleId ?? null : null

export const fullAccessLabel = (moduleId: string) => `${moduleGroupName(moduleId)} — Full Access`

export interface CatalogueModule {
  id: string; name: string
  /** The ONE eligible published Full Access policy of this module (standard tab only). */
  fullAccess: SelectableProfile | null
  /** Narrower policies of this module. */
  policies: SelectableProfile[]
}
export interface Catalogue { standard: CatalogueModule[]; custom: CatalogueModule[] }

/** A policy's display module from the permissions it actually holds; spanning several modules = Shared / Cross-module. */
export function moduleOfPolicy(p: SelectableProfile): string {
  const fa = fullAccessModuleOf(p)
  if (fa) return fa
  if (!p.permissionKeys?.length) return OTHER_MODULE.id
  return classifyRole({ permissions: p.permissionKeys }).groupId
}

export function buildCatalogue(profiles: readonly SelectableProfile[]): Catalogue {
  const build = (kind: 'standard' | 'custom') => {
    const modules = new Map<string, CatalogueModule>()
    const at = (id: string) => {
      let m = modules.get(id)
      if (!m) { m = { id, name: moduleGroupName(id), fullAccess: null, policies: [] }; modules.set(id, m) }
      return m
    }
    for (const p of profiles) {
      if (policyKind(p) !== kind) continue
      const faModule = fullAccessModuleOf(p)
      const m = at(moduleOfPolicy(p))
      if (faModule && !m.fullAccess) m.fullAccess = p
      else m.policies.push(p)
    }
    for (const m of modules.values()) m.policies.sort((a, b) => a.name.localeCompare(b.name))
    return Array.from(modules.values()).sort((a, b) => moduleGroupRank(a.id) - moduleGroupRank(b.id))
  }
  return { standard: build('standard'), custom: build('custom') }
}

// ── Coverage (proven by contents, never by name or module) ────────────────

/**
 * A narrower STANDARD policy is covered by a Full Access policy only when both publish their permission lists and every
 * permission of the narrower one is in the Full Access one. Custom policies are never treated as covered.
 */
export function coveredByFullAccess(fullAccess: SelectableProfile, other: SelectableProfile): boolean {
  if (other.id === fullAccess.id || policyKind(other) !== 'standard' || fullAccessModuleOf(other)) return false
  const have = new Set(fullAccess.permissionKeys ?? [])
  const keys = other.permissionKeys ?? []
  return have.size > 0 && keys.length > 0 && keys.every(k => have.has(k))
}

// ── Selection operations ──────────────────────────────────────────────────

export interface PickerContext { profiles: readonly SelectableProfile[]; scopes: SelectableScope[] }
export interface PickerChange { items: ProfileChoice[]; notice: string | null }

const byId = (ctx: PickerContext) => new Map(ctx.profiles.map(p => [p.id, p]))
export const selectedPolicyIds = (items: readonly ProfileChoice[]) => Array.from(new Set(items.map(i => i.roleId)))
export const scopesOf = (items: readonly ProfileChoice[], roleId: string) => items.filter(i => i.roleId === roleId && i.scopeId).map(i => i.scopeId)
const optionIds = (p: SelectableProfile | undefined, ctx: PickerContext) => scopesForPolicy(p, ctx.scopes).map(s => s.id)
const signature = (ids: readonly string[]) => ids.slice().sort().join('|')
const tooMany = (): PickerChange['notice'] => `At most ${MAX_POLICY_SCOPE_PAIRS} policy and scope selections can be made at once.`

/** Scope a newly ticked policy starts with: the group's current choice, else the only valid option, else none (never broader). */
function initialScopes(items: readonly ProfileChoice[], policy: SelectableProfile, ctx: PickerContext): string[] {
  const options = optionIds(policy, ctx)
  if (options.length === 1) return options
  const sig = signature(options)
  const profiles = byId(ctx)
  for (const id of selectedPolicyIds(items)) {
    const mine = scopesOf(items, id)
    if (mine.length && signature(optionIds(profiles.get(id), ctx)) === sig) return mine
  }
  return []
}

const withRows = (items: ProfileChoice[], roleId: string, scopeIds: string[]): ProfileChoice[] =>
  [...items, ...(scopeIds.length ? scopeIds : ['']).map(scopeId => ({ roleId, scopeId }))]

/** Ticks or unticks one policy. Full Access replaces only what is proven covered; specific groups drop their module's Full Access. */
export function togglePolicy(ctx: PickerContext, items: ProfileChoice[], policyId: string, on: boolean): PickerChange {
  const profiles = byId(ctx)
  const policy = profiles.get(policyId)
  if (!policy) return { items, notice: null }
  if (!on) return { items: items.filter(i => i.roleId !== policyId), notice: null }
  if (items.some(i => i.roleId === policyId)) return { items, notice: null }

  const faModule = fullAccessModuleOf(policy)
  if (faModule) {
    const fullOptions = new Set(optionIds(policy, ctx))
    const covered = selectedPolicyIds(items).filter(id => {
      const other = profiles.get(id)
      // Proven by contents AND compatible with the scopes already chosen for it; anything else is kept as chosen.
      return other && coveredByFullAccess(policy, other) && scopesOf(items, id).every(s => fullOptions.has(s))
    })
    const kept = items.filter(i => !covered.includes(i.roleId))
    const inherited = Array.from(new Set(covered.flatMap(id => scopesOf(items, id))))
    const scopeIds = inherited.length ? inherited : initialScopes(kept, policy, ctx)
    const next = withRows(kept, policyId, scopeIds)
    if (next.length > MAX_POLICY_SCOPE_PAIRS) return { items, notice: tooMany() }
    const names = covered.map(id => profiles.get(id)?.name).filter(Boolean)
    return { items: next, notice: covered.length ? `${fullAccessLabel(faModule)} replaced ${names.join(', ')}, which it already includes. Other selections were kept.` : null }
  }

  // A narrower policy: the module's Full Access selection is removed explicitly so it does not defeat the narrower choice.
  const module = moduleOfPolicy(policy)
  const faId = ctx.profiles.find(p => fullAccessModuleOf(p) === module && items.some(i => i.roleId === p.id))?.id
  const base = faId ? items.filter(i => i.roleId !== faId) : items
  const next = withRows(base, policyId, initialScopes(base, policy, ctx))
  if (next.length > MAX_POLICY_SCOPE_PAIRS) return { items, notice: tooMany() }
  return { items: next, notice: faId ? `${fullAccessLabel(module)} was removed because you chose specific groups instead.` : null }
}

/** Ticks or unticks one scope for every policy of a shared scope control. */
export function setScopeFor(items: ProfileChoice[], policyIds: readonly string[], scopeId: string, on: boolean): PickerChange {
  let next = items
  for (const roleId of policyIds) {
    const first = next.findIndex(i => i.roleId === roleId)
    if (first < 0) continue
    const chosen = next.filter(i => i.roleId === roleId).map(i => i.scopeId).filter(Boolean)
    const scopes = on ? Array.from(new Set([...chosen, scopeId])) : chosen.filter(s => s !== scopeId)
    const rows = (scopes.length ? scopes : ['']).map(s => ({ roleId, scopeId: s }))
    // The policy keeps its position in the list; only its own rows change.
    next = [...next.slice(0, first), ...rows, ...next.slice(first).filter(i => i.roleId !== roleId)]
  }
  if (next.length > MAX_POLICY_SCOPE_PAIRS) return { items, notice: tooMany() }
  return { items: next, notice: null }
}

export interface ScopeGroup { key: string; policyIds: string[]; options: SelectableScope[] }

/** Selected policies sharing exactly the same valid scope options share one control; otherwise each has its own. */
export function scopeGroups(ctx: PickerContext, items: readonly ProfileChoice[]): ScopeGroup[] {
  const profiles = byId(ctx)
  const groups = new Map<string, ScopeGroup>()
  for (const id of selectedPolicyIds(items)) {
    const options = scopesForPolicy(profiles.get(id), ctx.scopes)
    const key = options.length ? signature(options.map(o => o.id)) : `none:${id}`
    const group = groups.get(key) ?? { key, policyIds: [], options }
    group.policyIds.push(id)
    groups.set(key, group)
  }
  return Array.from(groups.values())
}

/** Applies the single valid scope wherever exactly one exists and none is chosen (returns the same array when nothing changes). */
export function autoSelectSoleScopes(ctx: PickerContext, items: ProfileChoice[]): ProfileChoice[] {
  let next = items
  for (const group of scopeGroups(ctx, items)) {
    if (group.options.length !== 1) continue
    const missing = group.policyIds.filter(id => !scopesOf(next, id).length)
    if (missing.length) next = setScopeFor(next, missing, group.options[0].id, true).items
  }
  return next
}

/** Organization / catalogue change: keeps only selections that are still offered with a still-valid scope. Returns what was dropped. */
export function pruneSelections(ctx: PickerContext, items: readonly ProfileChoice[]): { kept: ProfileChoice[]; removed: number } {
  const profiles = byId(ctx)
  const droppedPolicies = selectedPolicyIds(items).filter(id => !profiles.has(id)).length
  const kept = items.filter(i => {
    const p = profiles.get(i.roleId)
    return !!p && (!i.scopeId || scopesForPolicy(p, ctx.scopes).some(s => s.id === i.scopeId))
  })
  // A policy whose every chosen scope vanished stays ticked but unscoped, so the form says so instead of silently dropping it.
  const out = [...kept]
  for (const id of selectedPolicyIds(items)) if (profiles.has(id) && !out.some(i => i.roleId === id)) out.push({ roleId: id, scopeId: '' })
  const droppedScopes = items.filter(i => profiles.has(i.roleId)).length - kept.length
  return { kept: out, removed: droppedPolicies + droppedScopes }
}

/** The accurate message for a selection that cannot be submitted yet (never "global"), or null when every policy has a scope. */
export function missingScopeMessage(ctx: PickerContext, items: readonly ProfileChoice[]): string | null {
  const profiles = byId(ctx)
  const missing = selectedPolicyIds(items).filter(id => !scopesOf(items, id).length)
  if (!missing.length) return null
  const names = missing.map(id => profiles.get(id)?.name ?? 'Policy')
  const none = missing.filter(id => !scopesForPolicy(profiles.get(id), ctx.scopes).length).map(id => profiles.get(id)?.name ?? 'Policy')
  return none.length
    ? `No data scope is available for ${none.join(', ')}. Untick ${none.length === 1 ? 'it' : 'them'} or choose a different organization.`
    : `Choose a data scope for ${names.join(', ')}. A policy is never assigned without one.`
}
