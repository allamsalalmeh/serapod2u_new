import 'server-only'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { authorize, type LegacyEvaluator } from './authorization'
import type { AuthorizationDecision, AuthorizationResource } from './types'
import type { Trace } from './diagnostics'

export interface OperationRequest {
  actorId: string
  permission: string
  resource: AuthorizationResource
  /** The module's existing check; decides in LEGACY_ENFORCED/SHADOW. */
  legacy?: LegacyEvaluator
  correlationId?: string | null
  /** Decide and explain without writing an audit row (UI preflight; nothing is being authorized). */
  explainOnly?: boolean
  /** Request diagnostics (phase timings, failure classification). */
  trace?: Trace
}

/**
 * Server-side operation authorization for API routes. Records the decision
 * and returns it; callers use guardOperation() for the standard 403 path.
 * Resource context must come from trusted server data (the verified user's
 * organization, rows loaded by the server) — never from the request body.
 */
export async function authorizeOperation(request: OperationRequest): Promise<AuthorizationDecision> {
  return authorize(
    {
      actorId: request.actorId,
      permission: request.permission,
      resource: request.resource,
      context: { correlationId: request.correlationId ?? null, ...(request.explainOnly ? { explainOnly: true } : {}) },
    },
    { legacy: request.legacy, trace: request.trace },
  )
}

/**
 * Returns null when the operation may proceed, otherwise a 403 response
 * (or 503 when the authorization service itself is unavailable; never an
 * implicit allow). The body satisfies both `{ error }` and
 * `{ success: false, error }` response conventions used across the API.
 */
export async function guardOperation(request: OperationRequest): Promise<NextResponse | null> {
  let decision: AuthorizationDecision
  try {
    decision = await authorizeOperation(request)
  } catch {
    return NextResponse.json({ success: false, error: 'Authorization service unavailable' }, { status: 503 })
  }
  if (decision.decision === 'ALLOW') return null
  // Fail closed, but an infrastructure failure is not a confirmed denial.
  if (decision.unavailable) {
    return NextResponse.json({ success: false, error: 'Authorization service unavailable', code: 'sa_unavailable', decisionId: decision.decisionId }, { status: 503 })
  }
  return NextResponse.json(
    { success: false, error: 'Forbidden', code: 'sa_forbidden', permission: request.permission, decisionId: decision.decisionId, reason: decision.reasonCode },
    { status: 403 },
  )
}

/** Organization-scoped resource from a trusted organization id. */
export function organizationResource(type: string, organizationId: string | null | undefined, extra: Partial<AuthorizationResource> = {}): AuthorizationResource {
  return { type, organizationId: organizationId ?? null, ...extra }
}

/** Warehouse-scoped resource (organization + warehouse context). */
export function warehouseResource(type: string, warehouseId: string, extra: Partial<AuthorizationResource> = {}): AuthorizationResource {
  return { type, organizationId: warehouseId, warehouseId, ...extra }
}

/**
 * Route guard for a verified user id. The resource organization defaults to
 * the actor's own organization read from the database (trusted), so a client
 * can never widen its scope by supplying an organization. Pass
 * organizationId/warehouseId only when they come from rows the server loaded.
 */
export async function guardUserOperation(
  userId: string,
  permission: string,
  options: {
    legacy?: LegacyEvaluator
    resourceType?: string
    organizationId?: string | null
    warehouseId?: string | null
    ownerUserId?: string | null
  } = {},
): Promise<NextResponse | null> {
  let organizationId = options.organizationId ?? null
  let warehouseId = options.warehouseId ?? null
  if (!organizationId && !warehouseId) {
    const admin = createAdminClient() as any
    const { data } = await admin.from('users').select('organization_id, organizations:organization_id(org_type_code)').eq('id', userId).maybeSingle()
    organizationId = data?.organization_id ?? null
    // A warehouse organization is its own warehouse (see warehouseResource):
    // without this, warehouse-scoped assignments resolve as MISSING_CONTEXT.
    if (organizationId && data?.organizations?.org_type_code === 'WH') warehouseId = organizationId
  }
  return guardOperation({
    actorId: userId,
    permission,
    resource: {
      type: options.resourceType ?? permission.split('.').slice(0, 2).join('_'),
      organizationId: organizationId ?? warehouseId ?? null,
      ...(warehouseId ? { warehouseId } : {}),
      ...(options.ownerUserId ? { ownerUserId: options.ownerUserId } : {}),
    },
    legacy: options.legacy ?? (() => true),
  })
}

/**
 * Boolean form of guardUserOperation for routes that keep their own
 * response shape: replaces an inline legacy check (`isAdmin`, role level,
 * org type) with the S&A decision, the old expression becoming the legacy
 * evaluator. Any failure denies.
 */
export async function userAllowed(
  userId: string,
  permission: string,
  legacy: LegacyEvaluator,
  options: { organizationId?: string | null; warehouseId?: string | null; resourceType?: string } = {},
): Promise<boolean> {
  const denied = await guardUserOperation(userId, permission, { ...options, legacy }).catch(() => 'error' as const)
  return denied === null
}
