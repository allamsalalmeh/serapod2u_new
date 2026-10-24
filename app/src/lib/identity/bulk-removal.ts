import 'server-only'
import { randomUUID } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { deletionActorCheck, deletionExecute, deletionPreview, type DeletionBlocker } from './permanent-deletion'
import { archiveExecute, archivePreview, type ArchiveWarning } from './archive'
import {
  BULK_REMOVAL_MAX_TARGETS, BULK_REMOVAL_TOKEN_TTL_MS,
  bulkExecutionComplete, bulkPlanFingerprint, bulkPlanReference, bulkPreviewState, bulkRemovalPhrase,
  perTargetRequestId, signBulkPlanToken, summarizeBulkEligibility, summarizeBulkResults, validateBulkPlan,
  verifyBulkPlanToken, isBulkRemovalAction, isBulkUuid, normalizeBulkPhrase,
  type BulkPlanProblem, type BulkRemovalEligibility, type BulkRemovalPlanEntry,
  type BulkRemovalSummary, type BulkTargetResult, type BulkExecutionSummary,
} from './bulk-removal-plan'

/**
 * Bulk employee removal for HR → People → Employees.
 *
 * This module owns NO deletion or archival logic. Every identity is previewed
 * and executed through the canonical services:
 *   - lib/identity/permanent-deletion.ts  → identity_deletion_preview/_execute
 *   - lib/identity/archive.ts             → identity_archive_preview/_execute
 * The database decides permission for each target's organization
 * (platform.identity.delete, + hr.employee.delete for entry=hr), every
 * protection (self, Root, Super Admin, dominance, last administrator, HR
 * live), dependency blockers, the stale preview token, idempotency and the
 * audit record. The batch only adds: an org-scoped selection contract, an
 * authoritative per-target classification, bounded concurrency, a signed
 * short-lived plan token, a server-generated batch phrase and deterministic
 * per-target request ids so a retry cannot act twice.
 */

export interface BulkRemovalFailure {
  ok: false
  code: string
  status: number
  message: string
  problems?: BulkPlanProblem[]
  targets?: BulkRemovalEligibility[]
}

interface TargetInternal {
  eligibility: BulkRemovalEligibility
  deletionToken: string | null
  deletionPhrase: string | null
  archiveToken: string | null
  archivePhrase: string | null
  state: string
}

export interface BulkEligibility {
  targets: BulkRemovalEligibility[]
  summary: BulkRemovalSummary
  internal: Map<string, TargetInternal>
}

/**
 * The canonical permission keys the database re-decides for entry=hr on every
 * preview and execute: explicit platform.identity.delete in the target's
 * organization, plus hr.employee.delete from HR.
 */
const BULK_REMOVAL_PERMISSIONS = ['platform.identity.delete', 'hr.employee.delete'] as const

/**
 * Destructive execution is strictly serial (one identity at a time).
 *
 * The canonical deletion acquires table-level SHARE locks from
 * identity_deletion_plan.lock_tables (hr_employees is in that list because its
 * onboarded_by / onboarding_reset_by columns have no foreign key) and then
 * writes some of those same tables in the same transaction. Running two
 * deletions concurrently produces a PostgreSQL deadlock (40P01); running a
 * deletion next to an archive (which UPDATEs hr_employees and INSERTs
 * identity_lifecycle_actions) produces a 5s lock timeout (55P03). Both are
 * same-batch conflicts, not genuine changes to the target. Serial execution
 * removes them without weakening any safeguard.
 */
const EXECUTION_CONCURRENCY = 1
/** Only these canonical errors are proven transaction aborts (nothing was written). */
const RETRYABLE_LOCK_DELAYS_MS = [300, 900]
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Bounded retry for lock-timeout/deadlock only. The whole per-identity
 * transaction is rolled back by PostgreSQL on either error, the request id is
 * unchanged (canonical idempotency) and the canonical function re-checks the
 * preview token, authorization and dependencies on every attempt. Nothing else
 * is retried: authorization denials, blockers, stale previews, invalid
 * confirmations, auth-cleanup uncertainty and unknown failures are returned as
 * they are.
 */
async function runWithTransientLockRetry<T extends { ok: boolean }>(
  run: () => Promise<T>,
  codeOf: (result: T) => string | undefined,
): Promise<T> {
  let result = await run()
  for (const wait of RETRYABLE_LOCK_DELAYS_MS) {
    if (result.ok || codeOf(result) !== 'BUSY') return result
    await delay(wait)
    result = await run()
  }
  return result
}

/** Signing secret for the reviewed batch plan. Fails closed when unset. */
export function bulkRemovalSecret(): string {
  const secret = process.env.IDENTITY_BULK_REMOVAL_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw new Error('bulk_removal_secret_missing')
  return secret
}

/** Bounded parallelism: per-identity database calls are expensive and lock rows. */
async function mapLimit<T, R>(items: ReadonlyArray<T>, limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/** The actor must exist, be active and belong to the organization being administered. */
async function guardActor(actorId: string, organizationId: string): Promise<BulkRemovalFailure | null> {
  const admin = createAdminClient() as any
  const { data, error } = await admin.from('users').select('id, organization_id, is_active').eq('id', actorId).maybeSingle()
  if (error) return { ok: false, code: 'FAILED', status: 503, message: 'The authorization check did not complete.' }
  if (!data || data.is_active !== true) {
    return { ok: false, code: 'FORBIDDEN', status: 403, message: 'Your account cannot perform this action.' }
  }
  if (!data.organization_id || data.organization_id !== organizationId) {
    return { ok: false, code: 'OUT_OF_SCOPE', status: 403,
      message: 'Employees can only be removed inside your own organization. Nothing was changed.' }
  }
  // Same database decision the single-employee workflows use (UI hint; every preview/execute decides again).
  const check = await deletionActorCheck(actorId, 'hr')
  if (!check.ok) return { ok: false, code: check.code, status: check.status, message: check.message }
  if (!check.check.permission) {
    return { ok: false, code: 'FORBIDDEN', status: 403,
      message: 'You are not authorized to remove employees (Security & Access: Archive Identities, plus HR Employee Record Administrator from HR).'
        + ` Required permissions: ${BULK_REMOVAL_PERMISSIONS.join(' + ')}.` }
  }
  return null
}

const definitiveRefusal = (result: { ok: boolean; code?: string }) =>
  !result.ok && (result.code === 'FORBIDDEN' || result.code === 'NOT_FOUND')

function mergeBlockers(...lists: Array<ReadonlyArray<DeletionBlocker>>): DeletionBlocker[] {
  const seen = new Set<string>()
  const merged: DeletionBlocker[] = []
  for (const blocker of lists.flat()) {
    const key = `${blocker.code}|${blocker.table ?? ''}|${blocker.column ?? ''}|${blocker.category ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(blocker)
  }
  return merged
}

function mergeWarnings(...lists: Array<ReadonlyArray<ArchiveWarning>>): ArchiveWarning[] {
  const seen = new Set<string>()
  const merged: ArchiveWarning[] = []
  for (const warning of lists.flat()) {
    if (seen.has(warning.code)) continue
    seen.add(warning.code)
    merged.push(warning)
  }
  return merged
}

/** A target outside the administered organization is never described. */
function maskedEligibility(userId: string, detail: string): BulkRemovalEligibility {
  return {
    user_id: userId, full_name: null, email: null, employee_no: null, organization_id: null, organization_name: null,
    account_status: null, onboarding_status: null, employment_status: null,
    classification: 'BLOCKED', delete_allowed: false, archive_allowed: false, releasable: false,
    blockers: [], warnings: [], detail,
  }
}

/**
 * Authoritative per-target preview. Both canonical previews are read for every
 * identity, because the plan needs to know whether permanent deletion is
 * possible, whether archival is possible, and why not.
 */
async function loadEligibility(actorId: string, organizationId: string, userIds: ReadonlyArray<string>): Promise<BulkEligibility> {
  const internal = new Map<string, TargetInternal>()
  const targets = await mapLimit(userIds, 4, async (userId): Promise<BulkRemovalEligibility> => {
    const [deletion, archive] = await Promise.all([
      deletionPreview(actorId, userId, 'hr'),
      archivePreview(actorId, userId, 'hr'),
    ])

    const deletionOrg = deletion.ok ? deletion.preview.target.organization_id : null
    const archiveOrg = archive.ok ? archive.preview.target.organization_id ?? null : null
    if ((deletion.ok && deletionOrg !== organizationId) || (archive.ok && archiveOrg !== organizationId)) {
      const masked = maskedEligibility(userId, 'This person is not an employee of this organization. No action is available.')
      internal.set(userId, { eligibility: masked, deletionToken: null, deletionPhrase: null, archiveToken: null, archivePhrase: null, state: bulkPreviewState({ deletion: null, archive: null }) })
      return masked
    }

    const deleteAllowed = deletion.ok && deletion.preview.allowed === true
    const archiveAllowed = archive.ok && archive.preview.archive_allowed === true
    const deleteVerified = deletion.ok || definitiveRefusal(deletion)
    const archiveVerified = archive.ok || definitiveRefusal(archive)
    const blockers = mergeBlockers(
      deletion.ok ? deletion.preview.blockers : [],
      archive.ok ? archive.preview.blockers : [],
    )
    const warnings = mergeWarnings(archive.ok ? archive.preview.warnings : [])
    const failures: string[] = []
    if (!deletion.ok) failures.push(`Permanent deletion check: ${deletion.message}`)
    if (!archive.ok) failures.push(`Archive check: ${archive.message}`)

    let classification: BulkRemovalEligibility['classification']
    if (deleteAllowed) classification = 'DELETE_ELIGIBLE'
    else if (archiveAllowed) classification = 'ARCHIVE_ELIGIBLE'
    else if (deleteVerified && archiveVerified) classification = 'BLOCKED'
    else classification = 'UNVERIFIED'

    const employment = deletion.ok ? deletion.preview.employment : []
    const target = deletion.ok ? deletion.preview.target : (archive.ok ? archive.preview.target : null)
    const eligibility: BulkRemovalEligibility = {
      user_id: userId,
      full_name: target?.full_name ?? null,
      email: target?.email ?? null,
      employee_no: target?.employee_no ?? null,
      organization_id: deletionOrg ?? archiveOrg,
      organization_name: target?.organization_name ?? null,
      account_status: target?.account_status ?? null,
      onboarding_status: employment[0]?.onboarding_status ?? null,
      employment_status: employment[0]?.status ?? null,
      classification,
      delete_allowed: deleteAllowed,
      archive_allowed: archiveAllowed,
      releasable: archive.ok ? archive.preview.releasable === true && archive.preview.identifiers_released !== true : false,
      blockers,
      warnings,
      detail: failures.length > 0 ? failures.join(' ') : null,
    }
    internal.set(userId, {
      eligibility,
      deletionToken: deletion.ok ? deletion.preview.preview_token : null,
      deletionPhrase: deletion.ok ? deletion.preview.confirmation_phrase : null,
      archiveToken: archive.ok ? archive.preview.preview_token : null,
      archivePhrase: archive.ok ? archive.preview.confirmation_phrase : null,
      state: bulkPreviewState({
        deletion: deletion.ok ? deletion.preview.preview_token : null,
        archive: archive.ok ? archive.preview.preview_token : null,
      }),
    })
    return eligibility
  })

  return { targets, summary: summarizeBulkEligibility(targets), internal }
}


function parseBulkPlan(rawPlan: unknown): { plan: BulkRemovalPlanEntry[] } | BulkRemovalFailure {
  if (!Array.isArray(rawPlan) || rawPlan.length === 0) {
    return { ok: false, code: 'INVALID_INPUT', status: 400, message: 'Choose at least one employee to remove.' }
  }
  if (rawPlan.length > BULK_REMOVAL_MAX_TARGETS) {
    return { ok: false, code: 'INVALID_INPUT', status: 400, message: `Select at most ${BULK_REMOVAL_MAX_TARGETS} employees at once.` }
  }
  const plan: BulkRemovalPlanEntry[] = []
  for (const raw of rawPlan as Array<Record<string, unknown>>) {
    if (!raw || !isBulkUuid(raw.user_id) || !isBulkRemovalAction(raw.action)
      || (raw.employment_end !== 'resigned' && raw.employment_end !== 'terminated')) {
      return { ok: false, code: 'INVALID_INPUT', status: 400, message: 'The request is incomplete.' }
    }
    if (plan.some(entry => entry.user_id === raw.user_id)) {
      return { ok: false, code: 'INVALID_INPUT', status: 400, message: 'The same employee is planned twice.' }
    }
    plan.push({
      user_id: raw.user_id,
      action: raw.action,
      employment_end: raw.employment_end,
      release_identifiers: raw.release_identifiers === true,
    })
  }
  return { plan }
}

const INVALID_SELECTION = 'Select between 1 and {max} employees from this list.'

function normalizeUserIds(userIds: unknown): { ids: string[] } | BulkRemovalFailure {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return { ok: false, code: 'INVALID_INPUT', status: 400, message: INVALID_SELECTION.replace('{max}', String(BULK_REMOVAL_MAX_TARGETS)) }
  }
  if (userIds.length > BULK_REMOVAL_MAX_TARGETS) {
    return { ok: false, code: 'INVALID_INPUT', status: 400, message: `Select at most ${BULK_REMOVAL_MAX_TARGETS} employees at once.` }
  }
  const ids: string[] = []
  for (const id of userIds) {
    if (!isBulkUuid(id)) return { ok: false, code: 'INVALID_INPUT', status: 400, message: 'The request is incomplete.' }
    if (ids.includes(id)) return { ok: false, code: 'INVALID_INPUT', status: 400, message: 'The same employee is selected twice.' }
    ids.push(id)
  }
  return { ids }
}

/** Eligibility preview for the selected employees (read-only; nothing is changed). */
export async function bulkRemovalPreview(input: {
  actorId: string
  organizationId: string
  userIds: unknown
}): Promise<{ ok: true; targets: BulkRemovalEligibility[]; summary: BulkRemovalSummary } | BulkRemovalFailure> {
  const selection = normalizeUserIds(input.userIds)
  if (!('ids' in selection)) return selection
  const denied = await guardActor(input.actorId, input.organizationId)
  if (denied) return denied
  try {
    const eligibility = await loadEligibility(input.actorId, input.organizationId, selection.ids)
    return { ok: true, targets: eligibility.targets, summary: eligibility.summary }
  } catch {
    return { ok: false, code: 'FAILED', status: 500, message: 'The eligibility check did not complete. Nothing was changed.' }
  }
}

export interface BulkRemovalConfirmation {
  ok: true
  /** Short-lived signed plan. */
  token: string
  request_id: string
  phrase: string
  plan_ref: string
  expires_at: string
  targets: BulkRemovalEligibility[]
  summary: BulkRemovalSummary
}

/**
 * Re-checks the chosen actions against fresh authoritative previews and issues
 * the confirmation contract: a server phrase, a plan reference, asks the
 * server-set expiry and (inside the signed token) the exact per-target preview
 * state. A plan that asks for an action the database does not allow is refused.
 */
export async function bulkRemovalReviewPlan(input: {
  actorId: string
  organizationId: string
  plan: unknown
}): Promise<BulkRemovalConfirmation | BulkRemovalFailure> {
  const parsed = parseBulkPlan(input.plan)
  if (!('plan' in parsed)) return parsed
  const plan = parsed.plan

  const denied = await guardActor(input.actorId, input.organizationId)
  if (denied) return denied

  let eligibility: BulkEligibility
  try {
    eligibility = await loadEligibility(input.actorId, input.organizationId, plan.map(entry => entry.user_id))
  } catch {
    return { ok: false, code: 'FAILED', status: 500, message: 'The eligibility check did not complete. Nothing was changed.' }
  }
  const eligibilityById = new Map(eligibility.targets.map(target => [target.user_id, target]))
  const problems = validateBulkPlan(plan, eligibilityById)
  if (problems.length > 0) {
    return { ok: false, code: 'PLAN_NOT_ALLOWED', status: 409,
      message: 'Some selected employees cannot be removed with the chosen action. Review the plan; nothing was changed.',
      problems, targets: eligibility.targets }
  }

  const planHash = bulkPlanFingerprint(plan)
  const requestId = randomUUID()
  const issuedAt = Date.now()
  const expiresAt = issuedAt + BULK_REMOVAL_TOKEN_TTL_MS
  const phrase = bulkRemovalPhrase(plan.length)
  const secret = bulkRemovalSecret()
  const token = signBulkPlanToken({
    v: 1,
    actor: input.actorId,
    organization: input.organizationId,
    request_id: requestId,
    issued_at: issuedAt,
    expires_at: expiresAt,
    phrase,
    plan_hash: planHash,
    plan: plan.map(entry => ({
      user_id: entry.user_id,
      action: entry.action,
      state: eligibility.internal.get(entry.user_id)!.state,
    })),
  }, secret)

  return {
    ok: true, token, request_id: requestId, phrase, plan_ref: bulkPlanReference(planHash),
    expires_at: new Date(expiresAt).toISOString(), targets: eligibility.targets, summary: eligibility.summary,
  }
}


export interface BulkExecutionResult {
  ok: true
  request_id: string
  summary: BulkExecutionSummary
  results: BulkTargetResult[]
  /** False when any planned identity was not deleted/archived as confirmed. */
  complete: boolean
}

/**
 * Executes a reviewed batch. Nothing is mutated until the signature, actor,
 * organization, request id, phrase, plan fingerprint and every target's fresh
 * eligibility/preview state have been verified. Each identity then runs
 * through the canonical per-identity execute function in its own transaction,
 * with bounded concurrency and a deterministic request id.
 */
export async function bulkRemovalExecute(input: {
  actorId: string
  organizationId: string
  requestId: unknown
  token: unknown
  confirmation: unknown
  plan: unknown
  reason: unknown
}): Promise<BulkExecutionResult | BulkRemovalFailure> {
  if (!isBulkUuid(input.requestId)) {
    return { ok: false, code: 'INVALID_INPUT', status: 400, message: 'The request is incomplete.' }
  }
  const parsed = parseBulkPlan(input.plan)
  if (!('plan' in parsed)) return parsed
  const plan = parsed.plan

  let secret: string
  try {
    secret = bulkRemovalSecret()
  } catch {
    return { ok: false, code: 'NOT_INSTALLED', status: 503, message: 'Bulk removal is not configured on this server.' }
  }
  const verification = verifyBulkPlanToken(input.token, secret)
  if (!verification.ok) {
    return { ok: false, code: verification.code, status: 409, message: verification.message }
  }
  const payload = verification.payload
  if (payload.actor !== input.actorId || payload.organization !== input.organizationId || payload.request_id !== input.requestId) {
    return { ok: false, code: 'INVALID_TOKEN', status: 409,
      message: 'This confirmation belongs to a different request. Review the selection again; nothing was executed.' }
  }
  if (normalizeBulkPhrase(input.confirmation) !== normalizeBulkPhrase(payload.phrase)) {
    return { ok: false, code: 'CONFIRMATION_MISMATCH', status: 400,
      message: `Type ${payload.phrase} to confirm. Nothing was executed.` }
  }
  // The plan the administrator confirmed is exactly the plan that may run:
  // no target, action, employment outcome or release choice can change after confirmation.
  if (bulkPlanFingerprint(plan) !== payload.plan_hash || plan.length !== payload.plan.length) {
    return { ok: false, code: 'PLAN_CHANGED', status: 409,
      message: 'The plan changed after it was confirmed. Review the selection again; nothing was executed.' }
  }
  for (const entry of plan) {
    const bound = payload.plan.find(item => item.user_id === entry.user_id)
    if (!bound || bound.action !== entry.action) {
      return { ok: false, code: 'PLAN_CHANGED', status: 409,
        message: 'The plan changed after it was confirmed. Review the selection again; nothing was executed.' }
    }
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (plan.some(entry => entry.action === 'delete') && reason.length < 10) {
    return { ok: false, code: 'REASON_REQUIRED', status: 400,
      message: 'Enter a reason of at least 10 characters for permanent deletion. Nothing was executed.' }
  }

  const denied = await guardActor(input.actorId, input.organizationId)
  if (denied) return denied

  let eligibility: BulkEligibility
  try {
    eligibility = await loadEligibility(input.actorId, input.organizationId, plan.map(entry => entry.user_id))
  } catch {
    return { ok: false, code: 'FAILED', status: 500, message: 'The eligibility check did not complete. Nothing was executed.' }
  }
  const eligibilityById = new Map(eligibility.targets.map(target => [target.user_id, target]))
  const problems = validateBulkPlan(plan, eligibilityById)
  if (problems.length > 0) {
    return { ok: false, code: 'PLAN_NOT_ALLOWED', status: 409,
      message: 'The selection is no longer allowed as confirmed. Review the plan again; nothing was executed.',
      problems, targets: eligibility.targets }
  }

  // Nothing may have changed since the administrator reviewed the plan.
  const stale: BulkRemovalEligibility[] = []
  for (const entry of plan) {
    const bound = payload.plan.find(item => item.user_id === entry.user_id)!
    const fresh = eligibility.internal.get(entry.user_id)
    if (!fresh || fresh.state !== bound.state) stale.push(eligibilityById.get(entry.user_id)!)
  }
  if (stale.length > 0) {
    return { ok: false, code: 'PREVIEW_STALE', status: 409,
      message: 'Some selected employees changed since the preview. Nothing was executed; review the plan again.',
      targets: stale }
  }



  const outcomes = await mapLimit(plan, EXECUTION_CONCURRENCY, async (entry): Promise<BulkTargetResult> => {
    const fresh = eligibility.internal.get(entry.user_id)!
    const name = eligibilityById.get(entry.user_id)?.full_name || entry.user_id
    const requestId = perTargetRequestId(secret, payload.request_id, entry.user_id, entry.action)

    try {
      if (entry.action === 'delete') {
        if (!fresh.deletionToken || !fresh.deletionPhrase) {
          return { user_id: entry.user_id, name, action: entry.action, outcome: 'failed', detail: 'Permanent deletion was not previewed for this person.' }
        }
        const executed = await runWithTransientLockRetry(
          () => deletionExecute({
            actorId: input.actorId, userId: entry.user_id, entry: 'hr', requestId,
            previewToken: fresh.deletionToken!, reason, confirmation: fresh.deletionPhrase!,
          }),
          result => (result.ok ? undefined : result.code),
        )
        if (!executed.ok) {
          if (executed.code === 'BUSY') {
            return { user_id: entry.user_id, name, action: entry.action, outcome: 'conflict', retryable: true,
              detail: 'Another operation briefly held this person\'s records. Nothing was changed for this person; a fresh review and retry is safe.' }
          }
          if (executed.code === 'AUTH_CLEANUP_REQUIRED') {
            return { user_id: entry.user_id, name, action: entry.action, outcome: 'unconfirmed', retryable: false,
              detail: executed.message }
          }
          return { user_id: entry.user_id, name, action: entry.action, outcome: 'failed', detail: executed.message }
        }
        const outcome = executed.outcome
        if (outcome.status === 'completed') {
          return { user_id: entry.user_id, name, action: entry.action, outcome: 'deleted', detail: null, replayed: outcome.replayed }
        }
        if (outcome.status === 'blocked') {
          return { user_id: entry.user_id, name, action: entry.action, outcome: 'blocked',
            detail: outcome.blockers.map(blocker => blocker.message || blocker.code).join(' ') || 'Not allowed for this person.' }
        }
        return { user_id: entry.user_id, name, action: entry.action, outcome: 'stale',
          detail: 'Changed since the preview; nothing was deleted.' }
      }
  
      if (!fresh.archiveToken || !fresh.archivePhrase) {
        return { user_id: entry.user_id, name, action: entry.action, outcome: 'failed', detail: 'Archive was not previewed for this person.' }
      }
      // Releasing identifiers happens only where the database says it is possible.
      const releaseIdentifiers = entry.release_identifiers === true && fresh.eligibility.releasable
      const executed = await runWithTransientLockRetry(
        () => archiveExecute({
          actorId: input.actorId, userId: entry.user_id, entry: 'hr', requestId,
          previewToken: fresh.archiveToken!, reason, confirmation: fresh.archivePhrase!,
          releaseIdentifiers, employmentEnd: entry.employment_end,
        }),
        result => (result.ok ? undefined : result.code),
      )
      if (!executed.ok) {
        if (executed.code === 'BUSY') {
          return { user_id: entry.user_id, name, action: entry.action, outcome: 'conflict', retryable: true,
            detail: 'Another operation briefly held this person\'s records. Nothing was changed for this person; a fresh review and retry is safe.' }
        }
        if (executed.code === 'AUTH_CLEANUP_REQUIRED') {
          return { user_id: entry.user_id, name, action: entry.action, outcome: 'unconfirmed', retryable: false,
            detail: executed.message }
        }
        return { user_id: entry.user_id, name, action: entry.action, outcome: 'failed', detail: executed.message }
      }
      const outcome = executed.outcome
      if (outcome.status === 'completed') {
        return { user_id: entry.user_id, name, action: entry.action, outcome: 'archived', detail: null,
          released: outcome.released, replayed: outcome.replayed }
      }
      if (outcome.status === 'blocked') {
        return { user_id: entry.user_id, name, action: entry.action, outcome: 'blocked',
          detail: outcome.blockers.map(blocker => blocker.message || blocker.code).join(' ') || 'Not allowed for this person.' }
      }
      return { user_id: entry.user_id, name, action: entry.action, outcome: 'stale',
        detail: 'Changed since the preview; nothing was changed.' }
    } catch {
      // One unexpected per-identity failure never discards the other results and never reports success.
      // The outcome is unknown, not "nothing happened": the canonical request id makes a repeat safe,
      // but it is never retried automatically here.
      return { user_id: entry.user_id, name, action: entry.action, outcome: 'unconfirmed', retryable: false,
        detail: 'The result could not be confirmed for this person. Repeating the same request is safe; check the employee before acting again.' }
    }
  })

  const summary = summarizeBulkResults(outcomes)
  return { ok: true, request_id: payload.request_id, summary, results: outcomes, complete: bulkExecutionComplete(summary) }
}
