import { scopesForPolicy, scopesOf, type ProfileChoice, type SelectableProfile, type SelectableScope } from '@/lib/security-access/group-policy-picker'

/**
 * Edit User → Group Policies: pure logic (no network, no React).
 *
 * The person's current grants come from the same read model People & Access uses. They are split into four kinds and only
 * the first is ever editable here:
 *   explicit    granted by an administrator or an approved request (source manual / access_request)
 *   managed     automatic lifecycle access (derived / backfill), including the Employee Self Service baseline
 *   legacy      compatibility roles created from the legacy role during migration (never assignable or editable)
 *   historical  revoked, ended, expired or suspended — shown for context only
 *
 * An unchecked policy is a revocation ONLY when it is an explicit grant this administrator can manage in the person's
 * current organization. Everything else (managed, legacy, other memberships, grants the actor cannot see in the catalogue
 * or whose scope the actor cannot grant, temporary validity) is preserved untouched. Nothing here authorizes anything:
 * the same server routes and database functions as Security & Access → People & Access decide every grant and revoke.
 */

export type AccessKind = 'explicit' | 'managed' | 'legacy' | 'historical'

export interface SnapshotScope { id: string; scopeType: string; scopeValue: string | null; name: string }
export interface SnapshotAssignment {
  id: string
  status: string
  source: string
  effectiveFrom: string | null
  effectiveUntil: string | null
  reason: string | null
  roleId: string
  roleKey: string | null
  roleName: string
  roleSource: string | null
  scopes: SnapshotScope[]
  membershipId: string
  organizationId: string
  organizationName: string
  membershipSource: string | null
  membershipStatus: string
}
export interface AccessSnapshot { assignments: SnapshotAssignment[]; memberships: Array<{ id: string; organizationId: string; organizationName: string; status: string; isPrimary: boolean; source: string | null; grantable: boolean; blockedReason: string | null }> }

const one = <T>(value: T | T[] | null | undefined): T | null => (Array.isArray(value) ? value[0] ?? null : value ?? null)
const AUTOMATIC_SOURCES = new Set(['backfill', 'derived'])
export const ESS_ROLE_KEY = 'employee-self-service'

/** Raw read model (`/api/security-access/people/[userId]`) → typed snapshot. */
export function normalizeSnapshot(person: any): AccessSnapshot {
  const memberships: AccessSnapshot['memberships'] = []
  const assignments: SnapshotAssignment[] = []
  for (const m of (person?.membership ?? []) as any[]) {
    const org = one<any>(m.organization)
    const organizationName = String(org?.org_name ?? 'Organization')
    memberships.push({
      id: m.id, organizationId: m.organization_id, organizationName, status: m.status, isPrimary: Boolean(m.is_primary),
      source: m.source ?? null, grantable: m.grantable !== false, blockedReason: m.grant_blocked_reason ?? null,
    })
    for (const a of (m.assignments ?? []) as any[]) {
      const role = one<any>(a.role)
      assignments.push({
        id: a.id, status: a.status, source: a.source ?? 'manual', effectiveFrom: a.effective_from ?? null, effectiveUntil: a.effective_until ?? null,
        reason: a.assignment_reason ?? null, roleId: role?.id ?? '', roleKey: role?.role_key ?? null, roleName: role?.name ?? 'Policy', roleSource: role?.source ?? null,
        scopes: ((a.scopes ?? []) as any[]).map(x => one<any>(x.scope)).filter(Boolean)
          .map((s: any) => ({ id: s.id, scopeType: s.scope_type, scopeValue: s.scope_value ?? null, name: s.display_name })),
        membershipId: m.id, organizationId: m.organization_id, organizationName, membershipSource: m.source ?? null, membershipStatus: m.status,
      })
    }
  }
  return { assignments, memberships }
}

const isLegacy = (a: SnapshotAssignment) => a.roleSource === 'legacy' || (a.roleKey ?? '').startsWith('legacy-')
export const isEssAssignment = (a: SnapshotAssignment) => a.roleKey === ESS_ROLE_KEY
export const isExpired = (a: SnapshotAssignment, now = Date.now()) => Boolean(a.effectiveUntil) && new Date(a.effectiveUntil as string).getTime() <= now

export function classifyAssignment(a: SnapshotAssignment, now = Date.now()): AccessKind {
  if (a.status !== 'active' || isExpired(a, now)) return 'historical'
  if (isLegacy(a)) return 'legacy'
  if (AUTOMATIC_SOURCES.has(a.source) || isEssAssignment(a)) return 'managed'
  return 'explicit'
}

export interface AccessOptions {
  profiles: SelectableProfile[]; scopes: SelectableScope[]
  /** Published policies not eligible for the organization type (recipient-eligibility.ts); existing grants of them are flagged, never removed. */
  ineligibleProfiles?: Array<{ id: string; name?: string; message?: string }>
}

export type ReadOnlyReason = 'other_organization' | 'policy_not_offered' | 'scope_not_available' | 'membership_not_grantable' | 'not_eligible'
export const READ_ONLY_TEXT: Record<ReadOnlyReason, string> = {
  other_organization: 'Held through another organization membership. Manage it in Security & Access → People & Access.',
  policy_not_offered: 'You cannot manage this policy here (outside your assignment authority or not offered for this account). It is kept as it is.',
  scope_not_available: 'Its scope is outside the scopes you may grant, so it is kept as it is.',
  membership_not_grantable: 'You cannot grant in this membership, so it is kept as it is.',
  not_eligible: 'Not eligible for this organization type under the current Group Policy rules. Kept as it is for review in Security & Access → People & Access; it is never removed automatically and cannot be granted again here.',
}

export interface ManageableGrant { assignment: SnapshotAssignment; scopeIds: string[] }
export interface HeldGrant { assignment: SnapshotAssignment; kind: AccessKind; reason: ReadOnlyReason | null }

export interface ClassifiedAccess {
  /** Explicit grants this administrator may change here. */
  manageable: ManageableGrant[]
  /** Everything else that is active (explicit but not manageable, managed, legacy), with why it is read-only. */
  held: HeldGrant[]
  historical: SnapshotAssignment[]
  /** Roles held in the current organization that the picker must not offer again (a duplicate grant is refused by the server). */
  heldRoleIds: Set<string>
}

/**
 * Splits the snapshot for the person's CURRENT organization. `options` is what this administrator may grant there
 * (the Add User catalogue and scope eligibility, loaded for that organization).
 */
export function classifyAccess(snapshot: AccessSnapshot, organizationId: string | null, options: AccessOptions | null, now = Date.now()): ClassifiedAccess {
  const manageable: ManageableGrant[] = []
  const held: HeldGrant[] = []
  const historical: SnapshotAssignment[] = []
  const heldRoleIds = new Set<string>()
  const profiles = new Map((options?.profiles ?? []).map(p => [p.id, p]))
  const ineligible = new Set((options?.ineligibleProfiles ?? []).map(p => p.id))
  const membership = snapshot.memberships.find(m => m.organizationId === organizationId && m.status === 'active')
  for (const a of snapshot.assignments) {
    const kind = classifyAssignment(a, now)
    if (kind === 'historical') { historical.push(a); continue }
    const here = a.organizationId === organizationId
    if (here) heldRoleIds.add(a.roleId)
    if (kind !== 'explicit') { held.push({ assignment: a, kind, reason: null }); continue }
    if (!here) { held.push({ assignment: a, kind, reason: 'other_organization' }); continue }
    if (membership && !membership.grantable) { held.push({ assignment: a, kind, reason: 'membership_not_grantable' }); continue }
    const profile = profiles.get(a.roleId)
    if (!profile) { held.push({ assignment: a, kind, reason: ineligible.has(a.roleId) ? 'not_eligible' : 'policy_not_offered' }); continue }
    const allowed = new Set(scopesForPolicy(profile, options?.scopes ?? []).map(s => s.id))
    if (!a.scopes.length || a.scopes.some(s => !allowed.has(s.id))) { held.push({ assignment: a, kind, reason: 'scope_not_available' }); continue }
    manageable.push({ assignment: a, scopeIds: a.scopes.map(s => s.id) })
  }
  return { manageable, held, historical, heldRoleIds }
}

/** The picker's starting selection: the explicit grants the administrator may manage, one pair per policy and scope. */
export const initialItems = (access: ClassifiedAccess): ProfileChoice[] =>
  access.manageable.flatMap(g => g.scopeIds.map(scopeId => ({ roleId: g.assignment.roleId, scopeId })))

/** Policies offered for ADDING: never one already held in this organization (managed, legacy or an unmanageable grant). */
export const offeredProfiles = (access: ClassifiedAccess, options: AccessOptions | null): SelectableProfile[] => {
  const manageableIds = new Set(access.manageable.map(g => g.assignment.roleId))
  return (options?.profiles ?? []).filter(p => manageableIds.has(p.id) || !access.heldRoleIds.has(p.id))
}

export interface AddOp { kind: 'add'; roleId: string; scopeIds: string[] }
export interface RemoveOp { kind: 'remove'; assignment: SnapshotAssignment }
export interface ScopeChangeOp { kind: 'scope'; assignment: SnapshotAssignment; from: string[]; to: string[] }
export type AccessOp = AddOp | RemoveOp | ScopeChangeOp
export interface AccessPlan { adds: AddOp[]; removes: RemoveOp[]; scopeChanges: ScopeChangeOp[]; ops: AccessOp[]; empty: boolean; incomplete: string | null }

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|')

/**
 * Draft selection → the exact changes against what the administrator may manage. A policy with no scope chosen yet makes
 * the plan incomplete (it is never submitted as a broader grant).
 */
export function computePlan(access: ClassifiedAccess, draft: readonly ProfileChoice[]): AccessPlan {
  const adds: AddOp[] = []
  const removes: RemoveOp[] = []
  const scopeChanges: ScopeChangeOp[] = []
  const currentByRole = new Map(access.manageable.map(g => [g.assignment.roleId, g]))
  const draftRoles = Array.from(new Set(draft.map(i => i.roleId)))
  for (const g of access.manageable) {
    if (!draftRoles.includes(g.assignment.roleId)) removes.push({ kind: 'remove', assignment: g.assignment })
  }
  let incomplete: string | null = null
  for (const roleId of draftRoles) {
    const to = scopesOf(draft, roleId)
    if (!to.length) { incomplete = 'Choose a data scope for every selected Group Policy.'; continue }
    const current = currentByRole.get(roleId)
    if (!current) adds.push({ kind: 'add', roleId, scopeIds: to })
    else if (!sameSet(current.scopeIds, to)) scopeChanges.push({ kind: 'scope', assignment: current.assignment, from: current.scopeIds, to })
  }
  const ops: AccessOp[] = [...scopeChanges, ...removes, ...adds]
  return { adds, removes, scopeChanges, ops, empty: ops.length === 0, incomplete }
}

/** Active assignments the lifecycle ends when the person moves away from the organizations their derived memberships follow. */
export function moverImpact(snapshot: AccessSnapshot, newOrganizationId: string | null, now = Date.now()): { memberships: string[]; assignments: SnapshotAssignment[] } {
  if (!newOrganizationId) return { memberships: [], assignments: [] }
  const affected = snapshot.memberships.filter(m => m.status === 'active' && m.organizationId !== newOrganizationId && AUTOMATIC_SOURCES.has(m.source ?? ''))
  const ids = new Set(affected.map(m => m.id))
  return {
    memberships: affected.map(m => m.organizationName),
    assignments: snapshot.assignments.filter(a => ids.has(a.membershipId) && classifyAssignment(a, now) !== 'historical'),
  }
}

// ── Applying a plan ──────────────────────────────────────────────────────

export interface ApiCall { (url: string, init?: { method?: string; body?: unknown }): Promise<{ ok: boolean; data?: any; error?: string; code?: string }> }
export interface OpResult { op: AccessOp; ok: boolean; error?: string; /** A failed scope change that also lost the old grant. */ restored?: boolean | null }
export interface ApplyOutcome { results: OpResult[]; applied: number; failed: number; message: string; allApplied: boolean; nothingApplied: boolean }

const ENDPOINT = '/api/security-access/assignments'

/**
 * Applies the plan through the SAME endpoint (and database functions) as People & Access. There is no atomic "change scope"
 * operation, so a scope change is a revoke followed by a grant of the new scopes (same validity); if the grant is refused the
 * old grant is restored with a second grant. Anything that could not be applied or restored is reported honestly.
 */
export async function applyPlan(plan: AccessPlan, input: { userId: string; organizationId: string; reason: string; names?: (roleId: string) => string }, call: ApiCall): Promise<ApplyOutcome> {
  const results: OpResult[] = []
  const grant = (roleId: string, scopeIds: string[], effectiveUntil: string | null) =>
    call(ENDPOINT, { body: { action: 'grant', userId: input.userId, roleId, organizationId: input.organizationId, scopeIds, effectiveUntil, reason: input.reason } })
  for (const op of plan.ops) {
    if (op.kind === 'remove') {
      const r = await call(ENDPOINT, { body: { action: 'revoke', assignmentId: op.assignment.id, reason: input.reason } })
      results.push({ op, ok: r.ok, error: r.ok ? undefined : r.error })
    } else if (op.kind === 'add') {
      const r = await grant(op.roleId, op.scopeIds, null)
      results.push({ op, ok: r.ok, error: r.ok ? undefined : r.error })
    } else {
      const revoked = await call(ENDPOINT, { body: { action: 'revoke', assignmentId: op.assignment.id, reason: input.reason } })
      if (!revoked.ok) { results.push({ op, ok: false, error: revoked.error, restored: null }); continue }
      const granted = await grant(op.assignment.roleId, op.to, op.assignment.effectiveUntil)
      if (granted.ok) { results.push({ op, ok: true }); continue }
      const restored = await grant(op.assignment.roleId, op.from, op.assignment.effectiveUntil)
      results.push({ op, ok: false, error: granted.error, restored: restored.ok })
    }
  }
  const applied = results.filter(r => r.ok).length
  const failed = results.length - applied
  return { results, applied, failed, allApplied: failed === 0, nothingApplied: applied === 0 && results.length > 0, message: summarizeOutcome(results, applied, failed, input.names) }
}

const verb = (op: AccessOp) => (op.kind === 'add' ? 'add' : op.kind === 'remove' ? 'remove' : 'change the scope of')
const nameOf = (op: AccessOp, names: (roleId: string) => string) => (op.kind === 'add' ? names(op.roleId) : op.assignment.roleName)

export function summarizeOutcome(results: OpResult[], applied: number, failed: number, names: (roleId: string) => string = () => 'a policy'): string {
  if (!results.length) return 'No Group Policy changes.'
  if (!failed) return `${applied} Group Policy ${applied === 1 ? 'change was' : 'changes were'} applied.`
  const problems = results.filter(r => !r.ok).map(r => {
    const base = `could not ${verb(r.op)} ${nameOf(r.op, names)}: ${r.error || 'the request was refused'}`
    if (r.op.kind !== 'scope') return base
    if (r.restored === null) return `${base} (nothing changed)`
    return r.restored ? `${base} (the previous grant is still in place)` : `${base} (the previous grant was removed and could not be restored — grant it again in Security & Access → People & Access)`
  })
  return `${applied} of ${results.length} Group Policy changes were applied; ${problems.join('; ')}.`
}
