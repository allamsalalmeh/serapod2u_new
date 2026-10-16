import 'server-only'
import { authorizeOperation, organizationResource } from './operation'
import type { LegacyEvaluator } from './authorization'

/**
 * Authorization preflight for forms: the SAME decision the operation will take (same engine, permission, organization
 * and legacy evaluator), but explained and not audited. A denial is a confirmed answer of the engine; anything that
 * stops the engine from answering throws PreflightUnavailableError so callers can show "check failed / retry" instead
 * of a false denial. The operation itself re-authorizes (and the database re-checks) at submission.
 */
export class PreflightUnavailableError extends Error {
  constructor() { super('Authorization check unavailable'); this.name = 'PreflightUnavailableError' }
}

export type Preflight = { allowed: true } | { allowed: false; code: string; reason: string }

const ACTIONS: Record<string, string> = {
  'platform.user.manage': 'create users',
  'security.role.assign': 'assign Group Policies',
  'hr.employee.manage': 'manage HR employees',
}

export function denialExplanation(permission: string, reasonCode: string): string {
  const action = ACTIONS[permission] ?? 'perform this action'
  switch (reasonCode) {
    case 'MISSING_MEMBERSHIP':
      return `Your Security & Access authority does not reach this organization (it is outside every organization hierarchy you belong to), so you cannot ${action} here. A Security & Access administrator must place the organization under your hierarchy or give you a membership there.`
    case 'ACCOUNT_INACTIVE':
      return 'Your account is not active, so Security & Access cannot authorize this.'
    case 'SCOPE_MISMATCH':
      return `Your assignment does not cover this organization, so you cannot ${action} here.`
    default:
      return `You do not hold the permission to ${action} in this organization.`
  }
}

export async function explainOperation(actorId: string, permission: string, organizationId: string | null, legacy: LegacyEvaluator): Promise<Preflight> {
  let decision
  try {
    decision = await authorizeOperation({
      actorId, permission, legacy, explainOnly: true,
      resource: organizationResource(permission.split('.').slice(0, 2).join('_'), organizationId),
    })
  } catch (error) {
    // Stage only: no identities, tokens or ids.
    console.error(`[preflight] engine exception permission=${permission} type=${error instanceof Error ? error.name : typeof error}`)
    throw new PreflightUnavailableError()
  }
  if (decision.decision === 'ALLOW') return { allowed: true }
  if (decision.reasonCode === 'POLICY_ERROR') console.error(`[preflight] engine POLICY_ERROR permission=${permission}`)
  if (decision.reasonCode === 'POLICY_ERROR') throw new PreflightUnavailableError()
  return { allowed: false, code: decision.reasonCode, reason: denialExplanation(permission, decision.reasonCode) }
}
