import 'server-only'
import { legacyOrDelegatedSecurityAccess } from './delegation'
import { authorizeOperation, organizationResource } from './operation'
import {
  canonicalScopeChoices, choiceAllowedForPolicy, eligibleTargetOrganizations, isHqType, isScopeEligible, isStructuralScopeType,
  warehouseSupportFor, warehouseUnsupportedMessage, type ScopeChoice, type ScopeDefinitionLike, type ScopeOrg, type WarehouseSupport,
} from './scope-eligibility'

/**
 * Server side of the shared scope eligibility (scope-eligibility.ts): loads the real organization hierarchy and scope
 * definitions, builds the SAME choices the pickers show, and validates direct API / provisioning submissions against
 * them plus the assigning administrator's authority in each scope's organization. Read-only: nothing is created,
 * rewritten or deleted here.
 */

const PERMISSION = 'security.role.assign'
const MAX_DEPTH = 4

const chunk = <T,>(list: T[], size = 100): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size))

async function readIn(admin: any, table: string, select: string, column: string, values: string[], refine: (q: any) => any = q => q): Promise<any[]> {
  const rows: any[] = []
  for (const part of chunk(values)) {
    const { data, error } = await refine(admin.from(table).select(select).in(column, part))
    if (error) throw new Error('scope_context_unavailable')
    rows.push(...(data || []))
  }
  return rows
}

const toOrg = (r: any): ScopeOrg => ({ id: r.id, name: r.org_name ?? r.id, typeCode: r.org_type_code ?? '', parentId: r.parent_org_id ?? null, isActive: r.is_active })

export interface ScopeContext { recipient: ScopeOrg; orgs: ScopeOrg[]; scopes: ScopeDefinitionLike[] }

/** The recipient organization, the organizations a choice may stand for, and their active scope definitions. */
export async function loadScopeContext(admin: any, recipientOrgId: string): Promise<ScopeContext | null> {
  const { data: org, error } = await admin.from('organizations').select('id, org_name, org_type_code, parent_org_id, is_active').eq('id', recipientOrgId).maybeSingle()
  if (error) throw new Error('scope_context_unavailable')
  if (!org) return null
  const recipient = toOrg(org)
  const cols = 'id, org_name, org_type_code, parent_org_id, is_active'
  const orgs: ScopeOrg[] = [recipient]
  // An HQ needs only its direct children (its warehouses are the explicit relationship); others need the subtree beneath them.
  const depth = isHqType(recipient.typeCode) ? 1 : MAX_DEPTH
  let frontier = [recipient.id]
  const seen = new Set<string>([recipient.id])
  for (let level = 0; level < depth && frontier.length; level++) {
    const children = (await readIn(admin, 'organizations', cols, 'parent_org_id', frontier)).filter(c => !seen.has(c.id))
    for (const c of children) { seen.add(c.id); orgs.push(toOrg(c)) }
    frontier = children.map(c => c.id)
  }
  const targetIds = eligibleTargetOrganizations(recipient, orgs).map(o => o.id)
  const scopes = (await readIn(admin, 'sa_scope_definitions', 'id, organization_id, scope_type, scope_value, display_name', 'organization_id', targetIds,
    q => q.eq('status', 'active').in('scope_type', ['organization', 'warehouse']))) as ScopeDefinitionLike[]
  return { recipient, orgs, scopes }
}

/** True when the administrator may assign Group Policies in `organizationId` (same engine and legacy rule as the assign routes). Fails closed. */
export async function actorMayAssignIn(actorId: string, organizationId: string, cache?: Map<string, boolean>): Promise<boolean> {
  const hit = cache?.get(organizationId)
  if (hit !== undefined) return hit
  let allowed = false
  try {
    const decision = await authorizeOperation({
      actorId, permission: PERMISSION, explainOnly: true,
      resource: organizationResource('security_access', organizationId),
      legacy: () => legacyOrDelegatedSecurityAccess(actorId, organizationId, PERMISSION),
    })
    allowed = decision.decision === 'ALLOW'
  } catch {
    allowed = false
  }
  cache?.set(organizationId, allowed)
  return allowed
}

export interface ScopeChoicesResult {
  organization: { id: string; name: string; typeCode: string }
  choices: ScopeChoice[]
  orgNames: Record<string, string>
}

/** The picker's choices for a recipient organization, limited to organizations where `actorId` holds the grant authority. */
export async function loadScopeChoices(admin: any, recipientOrgId: string, actorId?: string | null): Promise<ScopeChoicesResult | null> {
  const ctx = await loadScopeContext(admin, recipientOrgId)
  if (!ctx) return null
  let choices = canonicalScopeChoices(ctx.recipient, ctx.orgs, ctx.scopes)
  if (actorId) {
    const cache = new Map<string, boolean>()
    const keep: ScopeChoice[] = []
    for (const c of choices) if (await actorMayAssignIn(actorId, c.targetOrganizationId, cache)) keep.push(c)
    choices = keep
  }
  return {
    organization: { id: ctx.recipient.id, name: ctx.recipient.name, typeCode: ctx.recipient.typeCode },
    choices,
    orgNames: Object.fromEntries(ctx.orgs.map(o => [o.id, o.name])),
  }
}

export type ScopeGrantResult =
  | { ok: true }
  | { ok: false; code: 'SCOPE_NOT_ELIGIBLE' | 'WAREHOUSE_SCOPE_UNSUPPORTED' | 'SCOPE_BEYOND_AUTHORITY' | 'SCOPE_CHECK_UNAVAILABLE'; message: string; status: number }

const NOT_ELIGIBLE_HQ = 'A selected scope is not available for an HQ account. An HQ account can receive the HQ scope or one of its own warehouses only. Nothing was changed.'
const NOT_ELIGIBLE = 'A selected scope does not apply to this organization. Nothing was changed.'

/** Support level of the policy for warehouse-only scopes, from its published permissions. Unreadable → treated as fully supported (the database still decides). */
async function policySupport(admin: any, roleId: string): Promise<WarehouseSupport | null> {
  const { data, error } = await admin.from('sa_business_roles')
    .select('id, permissions:sa_business_role_permissions(permission:sa_permissions(permission_key))').eq('id', roleId).maybeSingle()
  if (error) throw new Error('scope_context_unavailable')
  if (!data) return null
  return warehouseSupportFor((data.permissions || []).map((p: any) => p?.permission?.permission_key).filter(Boolean))
}

/**
 * Validates the scopes of ONE grant (policy + recipient organization + scope ids) exactly as the picker offers them:
 * eligibility for the recipient, policy compatibility, and the assigning administrator's authority in each scope's
 * organization. Only structural (organization / warehouse) scopes are judged here; other typed scopes keep the database
 * rules. Run before any side effect.
 */
export async function validateScopeGrant(admin: any, input: { /** Null for a self-service request: the requester holds no grant authority; the approver's decision and the database apply it. */ actorId: string | null; roleId: string; organizationId: string; scopeIds: readonly string[] }): Promise<ScopeGrantResult> {
  const unavailable: ScopeGrantResult = { ok: false, code: 'SCOPE_CHECK_UNAVAILABLE', message: 'The scope could not be checked. Nothing was changed. Try again.', status: 503 }
  try {
    const ctx = await loadScopeContext(admin, input.organizationId)
    if (!ctx) return { ok: false, code: 'SCOPE_NOT_ELIGIBLE', message: NOT_ELIGIBLE, status: 400 }
    const ids = Array.from(new Set(input.scopeIds))
    const defs = await readIn(admin, 'sa_scope_definitions', 'id, organization_id, scope_type, scope_value, display_name, status', 'id', ids) as Array<ScopeDefinitionLike & { status?: string }>
    // Unknown or inactive ids are the database's to reject with its own error; only the ones found are judged here.
    const structural = defs.filter(d => d.status !== 'inactive' && isStructuralScopeType(d.scope_type))
    if (!structural.length) return { ok: true }

    const hq = isHqType(ctx.recipient.typeCode)
    for (const def of structural) {
      if (!isScopeEligible(ctx.recipient, ctx.orgs, def)) return { ok: false, code: 'SCOPE_NOT_ELIGIBLE', message: hq ? NOT_ELIGIBLE_HQ : NOT_ELIGIBLE, status: 400 }
    }
    const support = await policySupport(admin, input.roleId)
    const byOrg = new Map(eligibleTargetOrganizations(ctx.recipient, ctx.orgs).map(o => [o.id, o]))
    for (const def of structural) {
      const target = byOrg.get(def.organization_id as string)
      const kind = target && target.typeCode.toUpperCase() === 'WH' ? 'warehouse' : 'organization'
      if (!choiceAllowedForPolicy({ kind }, support)) return { ok: false, code: 'WAREHOUSE_SCOPE_UNSUPPORTED', message: `${warehouseUnsupportedMessage} Nothing was changed.`, status: 400 }
    }
    const cache = new Map<string, boolean>()
    const authority = input.actorId
    if (authority) {
      for (const def of structural) {
        if (!(await actorMayAssignIn(authority, def.organization_id as string, cache))) {
          return { ok: false, code: 'SCOPE_BEYOND_AUTHORITY', message: 'You can grant a scope only inside an organization where you hold the grant authority. Nothing was changed.', status: 403 }
        }
      }
    }
    return { ok: true }
  } catch {
    return unavailable
  }
}
