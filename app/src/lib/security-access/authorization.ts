import 'server-only'
import { randomUUID } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkPermissionForUser } from '@/lib/server/permissions'
import { activeAccountState, isActiveAccountRecord } from './active-account'
import { NO_TRACE, type Trace } from './diagnostics'
import { evaluateNewPolicy, type PolicyAssignment, type PolicyMembership } from './policy'
import { shadowComparisonFor } from './comparison'
import { auditClassFor, auditWriteFailureIsFatal, authoritativeOutcome, consultsLegacy, isNewAuthoritative } from './enforcement'
import type {
  AuditSensitivity,
  AuthorizationDecision,
  AuthorizationResource,
  AuthorizationDecisionValue,
  AuthorizationReasonCode,
  AuthorizationRequest,
  AuthorizationUnavailableReason,
  MigrationMode,
} from './types'

const POLICY_VERSION = 'sa-final-v1'

/**
 * Legacy decision supplied by the caller: the module's existing check
 * (canManageHr, role_level thresholds, organization-type rules, ...). It is
 * evaluated exactly as before so LEGACY_ENFORCED/SHADOW keep today's behaviour,
 * and it is never consulted once the permission is LEGACY_RETIRED.
 */
export type LegacyEvaluator = () => boolean | Promise<boolean>

const legacyPermissionFor = (permission: string) => ({
  'inventory.stock_count.view': 'view_inventory',
  'inventory.stock_count.create': 'adjust_stock',
  'inventory.stock_count.verify': 'post_stock_count',
  'inventory.stock_count.post': 'post_stock_count',
  'inventory.transfer.view': 'view_inventory',
  'inventory.transfer.request': 'adjust_stock',
  'inventory.transfer.approve': 'adjust_stock',
  'inventory.transfer.dispatch': 'ship_goods',
  'inventory.transfer.receive': 'receive_goods',
  'security.access.view': 'view_users',
  'security.role.assign': 'manage_authorization',
} as Record<string, string>)[permission] ?? permission

/** Thrown by requireAuthorization when the authoritative decision is DENY. */
export class AuthorizationDeniedError extends Error {
  readonly status = 403
  constructor(readonly decisionId: string, readonly reasonCode: AuthorizationReasonCode) {
    super('Forbidden')
    this.name = 'AuthorizationDeniedError'
  }
}

export function isAuthorizationDenied(error: unknown): error is AuthorizationDeniedError {
  return error instanceof AuthorizationDeniedError
}

async function loadNewPolicy(request: AuthorizationRequest) {
  const admin = createAdminClient() as any
  const results = await Promise.all([
    admin.from('sa_organization_memberships').select('id,organization_id,status,effective_from,effective_until').eq('user_id', request.actorId),
    admin.from('sa_role_assignments').select(`
      id,status,effective_from,effective_until,membership_id,
      role:sa_business_roles!inner(id,role_key,name,status,permissions:sa_business_role_permissions(permission:sa_permissions(permission_key))),
      scopes:sa_assignment_scopes(scope:sa_scope_definitions(scope_type,scope_value))
    `).eq('user_id', request.actorId),
  ])
  if (results.some((result: any) => result.error)) throw new Error('policy_data_unavailable')
  const [{ data: memberships }, { data: assignments }] = results

  const mappedMemberships: PolicyMembership[] = (memberships || []).map((m: any) => ({
    id: m.id, organizationId: m.organization_id, status: m.status,
    effectiveFrom: m.effective_from, effectiveUntil: m.effective_until,
  }))
  const mappedAssignments: PolicyAssignment[] = (assignments || []).map((a: any) => ({
    assignmentId: a.id,
    roleId: a.role.id,
    roleKey: a.role.role_key,
    roleName: a.role.name,
    membershipId: a.membership_id,
    status: a.status,
    effectiveFrom: a.effective_from,
    effectiveUntil: a.effective_until,
    permissions: (a.role.permissions || []).map((p: any) => p.permission?.permission_key).filter(Boolean),
    scopes: (a.scopes || []).map((s: any) => ({ type: s.scope?.scope_type, value: s.scope?.scope_value })).filter((s: any) => s.type && s.value),
  }))
  return { memberships: mappedMemberships, assignments: mappedAssignments }
}

async function migrationMode(permission: string): Promise<MigrationMode> {
  const admin = createAdminClient() as any
  const { data, error } = await admin.from('sa_migration_modes').select('mode').eq('permission_key', permission).maybeSingle()
  // Compatibility during code-before-migration rollout only. Other lookup
  // failures are policy errors, never permission to fall back from a configured
  // NEW_ENFORCED decision.
  if (error && error.code !== 'PGRST205' && error.code !== '42P01') throw new Error('migration_mode_unavailable')
  return data?.mode ?? 'LEGACY_ENFORCED'
}

/** Current migration mode of a permission (LEGACY_ENFORCED when not seeded yet). */
export async function currentMigrationMode(permission: string): Promise<MigrationMode> {
  return migrationMode(permission)
}

// Unknown, missing, or unreadable sensitivity is treated as protected.
async function auditSensitivity(permission: string): Promise<AuditSensitivity> {
  const admin = createAdminClient() as any
  const { data, error } = await admin.from('sa_permissions').select('audit_sensitivity').eq('permission_key', permission).maybeSingle()
  return !error && data?.audit_sensitivity === 'ordinary' ? 'ordinary' : 'security_sensitive'
}

async function legacyDecisionFor(request: AuthorizationRequest, mode: MigrationMode, evaluator?: LegacyEvaluator): Promise<AuthorizationDecisionValue | null> {
  if (!consultsLegacy(mode)) return null
  try {
    if (evaluator) return (await evaluator()) ? 'ALLOW' : 'DENY'
    const legacy = await checkPermissionForUser(request.actorId, legacyPermissionFor(request.permission))
    return legacy.allowed ? 'ALLOW' : 'DENY'
  } catch (error) {
    // Diagnostic only once the new engine is authoritative; never a reason to
    // allow and never a reason to break an enforced operation.
    if (isNewAuthoritative(mode)) return null
    throw error
  }
}

/** Resource context for the database evaluator (keys mirror sa_scope_matches). */
export function databaseContext(resource: AuthorizationResource): Record<string, unknown> {
  return {
    ...(resource.organizationId ? { organization_id: resource.organizationId } : {}),
    ...(resource.warehouseId ? { warehouse_id: resource.warehouseId } : {}),
    ...(resource.departmentId ? { department_id: resource.departmentId } : {}),
    ...(resource.ownerUserId ? { owner_user_id: resource.ownerUserId } : {}),
    ...(resource.attributes && Object.keys(resource.attributes).length ? { attributes: resource.attributes } : {}),
  }
}

const EVALUATOR_UNAVAILABLE = new Set(['PGRST202', '42883', 'PGRST205'])

type NewEvaluation = ReturnType<typeof evaluateNewPolicy> | {
  decision: AuthorizationDecisionValue; reasonCode: AuthorizationReasonCode; matchedAssignments: any[]; resolvedScopes: any[]
}

/**
 * Canonical new-model decision: the database evaluator
 * (public.sa_evaluate_permission — the same function the RLS/RPC backstops
 * use, including hierarchy-aware scopes and non-transitive delegation). The
 * in-process evaluator is used only while the Final Wave migration is not yet
 * applied in an environment (code-before-migration rollout).
 */
async function evaluateNew(request: AuthorizationRequest, actorActive: boolean): Promise<NewEvaluation> {
  const admin = createAdminClient() as any
  const { data, error } = await admin.rpc('sa_evaluate_permission', {
    p_actor: request.actorId, p_permission: request.permission, p_context: databaseContext(request.resource), p_include_delegation: true,
  })
  if (!error && data && typeof data === 'object' && (data.decision === 'ALLOW' || data.decision === 'DENY')) {
    return {
      decision: data.decision,
      reasonCode: data.reason_code as AuthorizationReasonCode,
      matchedAssignments: Array.isArray(data.matched_assignments) ? data.matched_assignments : [],
      resolvedScopes: Array.isArray(data.resolved_scopes) ? data.resolved_scopes : [],
    }
  }
  if (error && !EVALUATOR_UNAVAILABLE.has(error.code)) throw new Error('policy_evaluation_failed')
  return evaluateNewPolicy(request, { actorActive, ...(await loadNewPolicy(request)) })
}

export async function authorize(
  request: AuthorizationRequest,
  options: { log?: boolean; legacy?: LegacyEvaluator; trace?: Trace } = {},
): Promise<AuthorizationDecision> {
  const trace = options.trace ?? NO_TRACE
  const decisionId = randomUUID()
  const shouldLog = options.log !== false && !request.context?.explainOnly
  const [mode, accountState, sensitivity] = await trace.time('authz_inputs', () => Promise.all([
    migrationMode(request.permission),
    activeAccountState(request.actorId),
    shouldLog ? auditSensitivity(request.permission) : Promise.resolve<AuditSensitivity>('security_sensitive'),
  ]))
  const actorActive = accountState === 'active'
  // Set when the authoritative input could not be read: the outcome still fails
  // closed (DENY), but callers report "unavailable", never a confirmed denial.
  let unavailable: AuthorizationUnavailableReason | undefined = accountState === 'unavailable' ? 'account_state_unavailable' : undefined
  const legacyDecision = await trace.time('authz_legacy', () => legacyDecisionFor(request, mode, options.legacy))
  let evaluated: NewEvaluation
  try {
    evaluated = actorActive
      ? await trace.time('authz_evaluate', () => evaluateNew(request, actorActive))
      : { decision: 'DENY', reasonCode: unavailable ? 'POLICY_ERROR' : 'ACCOUNT_INACTIVE', matchedAssignments: [], resolvedScopes: [] }
  } catch (error) {
    trace.fail('authz_evaluate', error)
    evaluated = { decision: 'DENY', reasonCode: 'POLICY_ERROR', matchedAssignments: [], resolvedScopes: [] }
    if (isNewAuthoritative(mode)) unavailable = 'policy_evaluation_failed'
  }

  const computed = authoritativeOutcome({
    mode, actorActive, legacyDecision, newDecision: evaluated.decision, newReasonCode: evaluated.reasonCode,
  })
  const outcome = unavailable ? { decision: 'DENY' as const, reasonCode: 'POLICY_ERROR' as const } : computed
  const comparison = shadowComparisonFor(legacyDecision, evaluated.decision, evaluated.reasonCode)
  const auditClass = auditClassFor({ mode, sensitivity, comparison, reasonCode: outcome.reasonCode })
  const result: AuthorizationDecision = {
    decision: outcome.decision,
    permission: request.permission,
    actor: request.actorId,
    matchedAssignments: evaluated.matchedAssignments,
    resolvedScopes: evaluated.resolvedScopes,
    reasonCode: outcome.reasonCode,
    policyVersion: POLICY_VERSION,
    decisionId,
    migrationMode: mode,
    legacyDecision,
    newDecision: evaluated.decision,
    newReasonCode: evaluated.reasonCode,
    ...(shouldLog ? { auditClass } : {}),
    ...(unavailable ? { unavailable } : {}),
  }

  if (shouldLog) {
    const admin = createAdminClient() as any
    // Awaited and not retried: the database backstop requires this row before an
    // enforced ALLOW proceeds, and a retry would only double a slow path.
    const { error }: any = await trace.time('authz_audit_write', () => admin.from('sa_authorization_decisions').insert({
      id: decisionId,
      actor_id: request.actorId,
      permission_key: request.permission,
      resource_type: request.resource.type,
      resource_id: request.resource.id ?? null,
      decision: result.decision,
      reason_code: result.reasonCode,
      matched_assignments: result.matchedAssignments,
      resolved_scopes: result.resolvedScopes,
      migration_mode: mode,
      legacy_decision: legacyDecision,
      new_decision: evaluated.decision,
      comparison,
      audit_class: auditClass,
      correlation_id: request.context?.correlationId ?? request.context?.requestId ?? null,
      policy_version: POLICY_VERSION,
    }))
    if (error) {
      // Classification only (timeout / network / database code): an aborted or failed
      // fetch has no PostgREST code, which used to be logged as code ''.
      const failure = trace.fail('authz_audit_write', error)
      console.error('[sa-authorization] decision audit write failed', {
        decisionId, permission: request.permission, classification: failure.classification, code: failure.code, correlationId: trace.id || null,
      })
      // The database backstop requires this row; an enforced ALLOW that was not
      // recorded fails closed, reported as unavailable (it is not a policy denial).
      // Non-authoritative modes keep legacy behavior.
      if (auditWriteFailureIsFatal(mode) && result.decision === 'ALLOW') {
        return { ...result, decision: 'DENY', reasonCode: 'POLICY_ERROR', unavailable: 'audit_write_failed' }
      }
    }
  }
  trace.outcome(`${result.decision}:${result.reasonCode}${result.unavailable ? `:${result.unavailable}` : ''}`)
  return result
}


export interface ExplainItem {
  permission: string
  resource: AuthorizationResource
  legacy?: LegacyEvaluator
}

/** At most this many evaluator calls run at once for one batch (a snapshot never floods the database). */
const EXPLAIN_CONCURRENCY = 8

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Explain-only decisions for several permissions of ONE actor (navigation snapshots), with the same authoritative
 * outcome authorize() reaches for each item (authoritativeOutcome). Nothing is recorded. The reads authorize() repeats
 * per call are done once: the migration modes (one query) and the active-account gate. Each permission then consults
 * only the input its mode makes authoritative: the legacy evaluator in LEGACY_ENFORCED/SHADOW, the database evaluator
 * in NEW_ENFORCED/LEGACY_RETIRED (the diagnostic side only feeds the audit row, which explain-only never writes).
 *
 * Unlike authorize(), a read or evaluator failure throws instead of answering DENY, so a snapshot reports
 * "unavailable" rather than a silently reduced menu.
 */
export async function explainMany(actorId: string, items: readonly ExplainItem[]): Promise<AuthorizationDecisionValue[]> {
  if (items.length === 0) return []
  const admin = createAdminClient() as any
  const permissions = [...new Set(items.map(item => item.permission))]
  const [modesResult, actorActive] = await Promise.all([
    admin.from('sa_migration_modes').select('permission_key, mode').in('permission_key', permissions),
    admin.from('users').select('is_active').eq('id', actorId).maybeSingle().then((r: any) => {
      if (r.error) throw new Error('account_state_unavailable')
      return isActiveAccountRecord(r.data)
    }),
  ])
  const { data: modeRows, error: modeError } = modesResult
  // Same rollout compatibility as migrationMode(): only a missing table means "not seeded yet".
  if (modeError && modeError.code !== 'PGRST205' && modeError.code !== '42P01') throw new Error('migration_mode_unavailable')
  const modes = new Map<string, MigrationMode>((modeRows ?? []).map((row: any) => [row.permission_key, row.mode]))
  if (!actorActive) return items.map(() => 'DENY')

  return mapLimited(items, EXPLAIN_CONCURRENCY, async item => {
    const mode = modes.get(item.permission) ?? 'LEGACY_ENFORCED'
    const request: AuthorizationRequest = { actorId, permission: item.permission, resource: item.resource, context: { explainOnly: true } }
    let legacyDecision: AuthorizationDecisionValue | null = null
    let newDecision: AuthorizationDecisionValue = 'DENY'
    if (isNewAuthoritative(mode)) {
      newDecision = (await evaluateNew(request, true)).decision
    } else {
      legacyDecision = await legacyDecisionFor(request, mode, item.legacy)
    }
    return authoritativeOutcome({ mode, actorActive, legacyDecision, newDecision, newReasonCode: 'POLICY_ERROR' }).decision
  })
}

/**
 * Server-side enforcement helper. Evaluates and records the decision, then
 * enforces the authoritative outcome for the permission's migration mode
 * (see enforcement.ts). In NEW_ENFORCED / LEGACY_RETIRED a new-engine DENY
 * throws; there is no fallback to a legacy ALLOW.
 */
export async function requireAuthorization(request: AuthorizationRequest, options: { legacy?: LegacyEvaluator } = {}): Promise<AuthorizationDecision> {
  const decision = await authorize(request, { legacy: options.legacy })
  if (decision.decision !== 'ALLOW') throw new AuthorizationDeniedError(decision.decisionId, decision.reasonCode)
  return decision
}
