import 'server-only'
import { randomUUID } from 'crypto'
import { buildServerPayload, storeDiagnostic } from '@/lib/system-logs/server'
import { classifyPermission, moduleGroupName } from './modules'
import type { AuthorizationDecision, AuthorizationRequest } from './types'

// Coalesce concurrent requests and short bursts, including storage failures. Durable
// authorization audit rows remain separate; this bounds operational diagnostics only.
const recent = new Map<string, { until: number; pending: Promise<string | undefined> }>()
type DiagnosticDecision = Pick<AuthorizationDecision, 'reasonCode' | 'unavailable'> & Partial<AuthorizationDecision>
export async function recordAuthorizationDenial(request: AuthorizationRequest, decision: DiagnosticDecision): Promise<string | undefined> {
  const key = JSON.stringify([request.actorId, request.resource.organizationId, request.resource.type, request.permission, request.context?.diagnosticOrigin, request.context?.operationId, decision.reasonCode, decision.unavailable])
  const now = Date.now()
  for (const [k, value] of recent) if (value.until <= now) recent.delete(k)
  const cached = recent.get(key)
  if (cached) return cached.pending
  if (recent.size >= 500) return undefined
  const pending = (async () => {
    try {
      const payload = buildServerPayload({
        referenceId: `SA-${randomUUID()}`,
        message: `security.authorization.denied: ${request.permission} (${decision.reasonCode})`,
        category: decision.unavailable ? 'server' : 'permission',
        status: decision.unavailable ? 503 : 403,
        code: decision.unavailable ? 'AUTHORIZATION_UNAVAILABLE' : decision.reasonCode,
        actorId: request.actorId,
        organizationId: request.resource.organizationId ?? null,
        module: moduleGroupName(classifyPermission(request.permission).groupId),
        action: request.context?.operationId ?? request.permission,
        pagePath: request.context?.diagnosticOrigin === 'page_navigation' && request.context.operationId ? `/${request.context.operationId}` : undefined,
        correlationId: request.context?.correlationId ?? request.context?.requestId,
        details: {
          event: 'security.authorization.denied', result: 'DENIED',
          permission: request.permission, reason: decision.reasonCode,
          origin: request.context?.diagnosticOrigin ?? 'server_operation', operation: request.context?.operationId ?? null,
          decision_id: decision.decisionId ?? null, resource_type: request.resource.type,
          policy_version: decision.policyVersion, migration_mode: decision.migrationMode,
          matched_assignment_count: decision.matchedAssignments?.length ?? 0, evaluated_scope_count: decision.resolvedScopes?.length ?? 0,
          resolution: decision.unavailable ? 'Retry when authorization is available' :
            decision.reasonCode === 'MISSING_PERMISSION' || decision.reasonCode === 'MISSING_ASSIGNMENT'
              ? 'Review an existing policy in the required organization and scope' : 'Review the recorded scope, membership or security condition',
        },
      })
      if (!payload) return undefined
      const result = await storeDiagnostic(payload)
      return result.stored && result.result?.stored === true && typeof result.result?.event_id === 'string'
        ? payload.reference_id : undefined
    } catch { return undefined }
  })()
  recent.set(key, { until: now + 10_000, pending })
  return pending
}
