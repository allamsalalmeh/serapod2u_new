import { OUTSIDE_FULL_ACCESS } from './group-policies'
import { classifyPermission } from './modules'

/**
 * Existing-access coverage for the Grant a Group Policy form (client-safe, presentation only).
 *
 * Answers "would this grant add anything the person does not already hold for this membership organization?" so the
 * form can hide modules and policies whose grant would be redundant. It decides nothing about authorization: the
 * server re-checks every grant (authority, scope, SoD, self-grant, sensitive policies) regardless of what is offered.
 *
 * Coverage is computed from what actually grants access, never from policy names or labels:
 *   - only CURRENT assignments count: status 'active' and now inside [effective_from, effective_until) — a revoked,
 *     expired or future-start grant covers nothing (mirrors the evaluator);
 *   - only roles that are published ('active'); a draft or retired policy grants nothing;
 *   - permissions come from the role's actual permission list, whatever its name or source (granted, or automatic
 *     access managed by HR / User Management);
 *   - compatibility (legacy) roles are NOT counted: they mirror legacy access only while a module is still in a legacy
 *     mode and disappear when it retires, so explicit policies must stay grantable to prepare for that;
 *   - only assignments on the SAME membership organization, and only when one of their scopes reaches that whole
 *     organization: its own organization / warehouse scope, or an organization scope on an ancestor (the evaluator
 *     resolves organization scopes through parent_org_id). A grant limited to one warehouse, a department or own records
 *     never hides anything, because a broader grant would still add access.
 */

export interface CoverageRole { id: string; status?: string | null; source?: string | null; permissionKeys: string[] }

export interface CoverageInput {
  /** The assignments of the person's membership in `organizationId` (any status; filtered here). */
  assignments: readonly any[]
  organizationId: string
  /** Every known role (grantable and not), by id, with its actual permission keys. */
  roles: ReadonlyMap<string, CoverageRole>
  /** organization id → parent organization id, when known (ancestor organization scopes). */
  parents?: ReadonlyMap<string, string | null | undefined>
  now?: Date
}

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null)
const WHOLE_ORG_TYPES = new Set(['organization', 'warehouse'])

/** Canonical current-assignment rule (mirrors the server evaluator). */
export function isCurrentAssignment(a: any, now: Date = new Date()): boolean {
  if (a?.status !== 'active') return false
  if (a.effective_until && new Date(a.effective_until).getTime() <= now.getTime()) return false
  if (a.effective_from && new Date(a.effective_from).getTime() > now.getTime()) return false
  return true
}

function ancestors(orgId: string, parents?: ReadonlyMap<string, string | null | undefined>): Set<string> {
  const out = new Set<string>()
  let cur = parents?.get(orgId)
  while (cur && !out.has(cur) && cur !== orgId) { out.add(cur); cur = parents?.get(cur) }
  return out
}

/** True when one of the assignment's scopes reaches the whole membership organization. */
export function scopeCoversOrganization(a: any, organizationId: string, parents?: ReadonlyMap<string, string | null | undefined>): boolean {
  const up = ancestors(organizationId, parents)
  return (a?.scopes || []).map((x: any) => one(x?.scope)).some((s: any) => {
    if (!s || !s.scope_value) return false
    if (WHOLE_ORG_TYPES.has(s.scope_type) && String(s.scope_value) === organizationId) return true
    return s.scope_type === 'organization' && up.has(String(s.scope_value))
  })
}

/** Current, published, non-compatibility assignments whose scope reaches the whole membership organization. */
export function coveringAssignments(input: CoverageInput): any[] {
  const now = input.now ?? new Date()
  return input.assignments.filter(a => {
    const role = input.roles.get(one(a?.role as any)?.id)
    return !!role && role.status === 'active' && role.source !== 'legacy'
      && isCurrentAssignment(a, now) && scopeCoversOrganization(a, input.organizationId, input.parents)
  })
}

/** Every permission the person already holds across the whole membership organization. */
export function coveredPermissions(input: CoverageInput): Set<string> {
  const keys = new Set<string>()
  for (const a of coveringAssignments(input)) for (const k of input.roles.get(one(a.role as any)?.id)?.permissionKeys ?? []) keys.add(k)
  return keys
}

/** A policy is redundant when it holds permissions and every one of them is already covered. */
export const isRedundantPolicy = (permissionKeys: readonly string[], covered: ReadonlySet<string>) =>
  permissionKeys.length > 0 && permissionKeys.every(k => covered.has(k))

/**
 * Per module: the permissions of that module that any grantable policy could give (excluding permissions deliberately
 * outside module Full Access, and permissions the catalogue no longer lists as active). A permission no policy offers
 * cannot be granted here, so it never keeps a module open.
 */
export function grantableModulePermissions(grantable: ReadonlyArray<{ permissionKeys: readonly string[] }>, catalogue?: ReadonlyArray<{ permission_key: string; status?: string | null }>): Map<string, Set<string>> {
  const active = catalogue?.length ? new Set(catalogue.filter(p => !p.status || p.status === 'active').map(p => p.permission_key)) : null
  const out = new Map<string, Set<string>>()
  for (const r of grantable) for (const k of r.permissionKeys) {
    if (OUTSIDE_FULL_ACCESS.includes(k) || (active && !active.has(k))) continue
    const id = classifyPermission(k).groupId
    out.set(id, (out.get(id) ?? new Set<string>()).add(k))
  }
  return out
}

/** Modules whose every grantable permission the person already holds for this organization (e.g. through Full Access). */
export function fullyCoveredModules(required: ReadonlyMap<string, ReadonlySet<string>>, covered: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  for (const [id, keys] of required) if (keys.size > 0 && Array.from(keys).every(k => covered.has(k))) out.add(id)
  return out
}

export const COVERED_MODULES_NOTE = 'Some modules are unavailable because this person already has Full Access for the selected organization and scope.'
