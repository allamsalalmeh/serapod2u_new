import { ESS_HQ_ONLY_MESSAGE, ESS_ROLE_KEY, essAllowedForOrgType } from '@/lib/security-access/ess-eligibility'

/**
 * Employee Self Service (ESS) at user creation.
 *
 * ESS is the canonical lifecycle baseline: a derived assignment of the `employee-self-service` policy on the person's
 * OWN-RECORD scope, created by sa_sync_user_lifecycle when the membership is established. Add User never writes a second
 * ESS grant and never hardcodes a policy id. This module only (a) decides, from the organization's STORED type, whether
 * the new account is meant to hold ESS, and (b) reconciles the result: an excluded (non-employee HQ) account, or any
 * non-HQ account, has the automatic baseline revoked through sa_revoke_assignment (audited, administrator-owned, so the
 * lifecycle never resurrects it and it stays restorable).
 *
 * ESS grants access to the person's own eligible HR employee record only; it is not HR administration and does not
 * create or link an HR employee. Until a verified employee link exists, employee features stay unavailable.
 */
export type EssIntent =
  | { ok: true; wanted: boolean }
  | { ok: false; code: 'ESS_HQ_ONLY' | 'INVALID_INPUT'; message: string }

/** `includeEss`: undefined = default for the organization (HQ yes, others no); false = excluded; true = explicitly requested. */
export function resolveEssIntent(input: { organizationTypeCode: string | null; includeEss?: boolean | null; linkedUserId?: string | null }): EssIntent {
  const hq = essAllowedForOrgType(input.organizationTypeCode)
  if (!hq) {
    if (input.includeEss === true) return { ok: false, code: 'ESS_HQ_ONLY', message: `${ESS_HQ_ONLY_MESSAGE} Nothing was created.` }
    return { ok: true, wanted: false }
  }
  if (input.includeEss === false && input.linkedUserId) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Employee Self Service cannot be excluded for a linked HR employee. Nothing was created.' }
  }
  return { ok: true, wanted: input.includeEss !== false }
}

export type EssReconcileResult =
  | { state: 'assigned' | 'excluded' | 'not_applicable' | 'skipped' }
  | { state: 'failed'; message: string }

export const ESS_EXCLUDED_REASON = 'Employee Self Service excluded when the user was created.'
export const ESS_NOT_HQ_REASON = 'Employee Self Service is available to HQ users only.'

/**
 * After provisioning: make the stored ESS baseline match the intent, and report the truth. `verifyAssigned` is false
 * for an account created inactive (the lifecycle holds no access for it, so absence is expected).
 */
export async function reconcileEssBaseline(admin: any, input: { actorId: string; userId: string; wanted: boolean; hq: boolean; verifyAssigned: boolean }): Promise<EssReconcileResult> {
  try {
    return await reconcile(admin, input)
  } catch {
    return { state: 'failed', message: 'Employee Self Service could not be checked.' }
  }
}

async function reconcile(admin: any, input: { actorId: string; userId: string; wanted: boolean; hq: boolean; verifyAssigned: boolean }): Promise<EssReconcileResult> {
  const { data: role, error: roleError } = await admin.from('sa_business_roles').select('id').eq('role_key', ESS_ROLE_KEY).maybeSingle()
  if (roleError) return { state: 'failed', message: 'The Employee Self Service policy could not be checked.' }
  if (!role) return input.wanted && input.verifyAssigned ? { state: 'failed', message: 'The Employee Self Service policy is not installed, so it was not assigned.' } : { state: 'skipped' }

  const { data: rows, error } = await admin.from('sa_role_assignments').select('id, status').eq('user_id', input.userId).eq('role_id', role.id)
  if (error) return { state: 'failed', message: 'Employee Self Service could not be checked.' }
  const active = (rows ?? []).filter((r: any) => r.status === 'active')

  if (input.wanted) {
    if (!input.verifyAssigned) return { state: 'skipped' }
    return active.length ? { state: 'assigned' } : { state: 'failed', message: 'Employee Self Service was not assigned by the account lifecycle.' }
  }
  for (const row of active) {
    const { error: revokeError } = await admin.rpc('sa_revoke_assignment', { p_actor: input.actorId, p_assignment: row.id, p_reason: input.hq ? ESS_EXCLUDED_REASON : ESS_NOT_HQ_REASON })
    if (revokeError) return { state: 'failed', message: input.hq ? 'Employee Self Service could not be excluded.' : 'The automatic Employee Self Service could not be removed from this non-HQ account.' }
  }
  return { state: input.hq ? 'excluded' : 'not_applicable' }
}
