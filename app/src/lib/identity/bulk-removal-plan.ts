import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Pure planning/signing helpers for bulk employee removal (HR → People →
 * Employees). No database access and no `server-only` marker: the server
 * orchestration (bulk-removal.ts) builds the authoritative preview with the
 * canonical per-identity services, and these helpers bind the reviewed batch
 * plan to a short-lived, signed token.
 *
 * Nothing here decides eligibility. The database does, per identity, in
 * identity_deletion_preview/_execute and identity_archive_preview/_execute.
 */

export const BULK_REMOVAL_MAX_TARGETS = 50
/** How long a reviewed plan can be confirmed/executed. */
export const BULK_REMOVAL_TOKEN_TTL_MS = 10 * 60 * 1000

export type BulkRemovalAction = 'delete' | 'archive'
export type BulkRemovalClassification = 'DELETE_ELIGIBLE' | 'ARCHIVE_ELIGIBLE' | 'BLOCKED' | 'UNVERIFIED'
export type BulkEmploymentEnd = 'resigned' | 'terminated'

export const isBulkRemovalAction = (value: unknown): value is BulkRemovalAction =>
  value === 'delete' || value === 'archive'
export const isBulkEmploymentEnd = (value: unknown): value is BulkEmploymentEnd =>
  value === 'resigned' || value === 'terminated'

export interface BulkBlocker {
  code: string
  message?: string
  category?: string
  table?: string
  column?: string
  count?: number
}

export interface BulkWarning {
  code: string
  message?: string
  count?: number
}

/** One selected employee, exactly as the server previewed it (no preview tokens). */
export interface BulkRemovalEligibility {
  user_id: string
  full_name: string | null
  email: string | null
  employee_no: number | null
  organization_id: string | null
  organization_name: string | null
  account_status: string | null
  onboarding_status: string | null
  employment_status: string | null
  classification: BulkRemovalClassification
  delete_allowed: boolean
  archive_allowed: boolean
  releasable: boolean
  blockers: BulkBlocker[]
  warnings: BulkWarning[]
  detail: string | null
}

export interface BulkRemovalSummary {
  total: number
  deleteEligible: number
  archiveEligible: number
  blocked: number
  unverified: number
}

/** One confirmed operation inside a batch plan. */
export interface BulkRemovalPlanEntry {
  user_id: string
  action: BulkRemovalAction
  employment_end: BulkEmploymentEnd
  release_identifiers: boolean
}

export interface BulkPlanTokenPayload {
  v: 1
  actor: string
  organization: string
  /** Server-generated batch idempotency key. */
  request_id: string
  issued_at: number
  expires_at: number
  phrase: string
  plan_hash: string
  plan: Array<{ user_id: string; action: BulkRemovalAction; state: string }>
}

export type BulkTokenVerification =
  | { ok: true; payload: BulkPlanTokenPayload }
  | { ok: false; code: 'INVALID_TOKEN' | 'TOKEN_EXPIRED'; message: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isBulkUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value)

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
/** Result classification from the two authoritative previews. */
export function classifyBulkRemoval(input: {
  deleteAllowed: boolean
  archiveAllowed: boolean
  /** False when the deletion preview could not be established at all. */
  deleteVerified: boolean
  /** False when the archive preview could not be established at all. */
  archiveVerified: boolean
}): BulkRemovalClassification {
  if (input.deleteAllowed) return 'DELETE_ELIGIBLE'
  if (input.archiveAllowed) return 'ARCHIVE_ELIGIBLE'
  // A definitive refusal from both previews is BLOCKED; an unanswered preview is never a permission.
  if (input.deleteVerified && input.archiveVerified) return 'BLOCKED'
  return 'UNVERIFIED'
}

export function summarizeBulkEligibility(targets: Array<Pick<BulkRemovalEligibility, 'classification'>>): BulkRemovalSummary {
  const summary: BulkRemovalSummary = { total: targets.length, deleteEligible: 0, archiveEligible: 0, blocked: 0, unverified: 0 }
  for (const target of targets) {
    if (target.classification === 'DELETE_ELIGIBLE') summary.deleteEligible += 1
    else if (target.classification === 'ARCHIVE_ELIGIBLE') summary.archiveEligible += 1
    else if (target.classification === 'BLOCKED') summary.blocked += 1
    else summary.unverified += 1
  }
  return summary
}

/** Server-generated batch confirmation, e.g. REMOVE 5 EMPLOYEES. */
export function bulkRemovalPhrase(count: number): string {
  return `REMOVE ${count} ${count === 1 ? 'EMPLOYEE' : 'EMPLOYEES'}`
}

/** Case/space-insensitive comparison of the typed batch phrase. */
export const normalizeBulkPhrase = (value: unknown): string =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toUpperCase() : ''

/**
 * The reviewed plan, order-independent. Changing any target, action,
 * employment outcome or identifier-release choice changes the fingerprint and
 * therefore invalidates the confirmation.
 */
export function bulkPlanFingerprint(plan: ReadonlyArray<BulkRemovalPlanEntry>): string {
  const canonical = plan
    .map(entry => [entry.user_id, entry.action, entry.employment_end, entry.release_identifiers] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return sha256(JSON.stringify(canonical)).slice(0, 32)
}

/** Short plan reference shown in the confirmation screen. */
export const bulkPlanReference = (planHash: string): string => planHash.slice(0, 8).toUpperCase()

/**
 * Fingerprint of the authoritative preview state for one identity. The state
 * strings are the preview tokens the database produced (they are md5 state
 * fingerprints, never credentials); only their hash leaves the server.
 */
export const bulkPreviewState = (tokens: { deletion: string | null; archive: string | null }): string =>
  sha256(`${tokens.deletion ?? '-'}|${tokens.archive ?? '-'}`)

const base64url = (value: string) => Buffer.from(value, 'utf8').toString('base64url')
const fromBase64url = (value: string) => Buffer.from(value, 'base64url').toString('utf8')

export function signBulkPlanToken(payload: BulkPlanTokenPayload, secret: string): string {
  if (!secret) throw new Error('bulk_removal_secret_missing')
  const body = base64url(JSON.stringify(payload))
  const signature = createHmac('sha256', secret).update(body, 'utf8').digest('hex')
  return `${body}.${signature}`
}

export function verifyBulkPlanToken(token: unknown, secret: string, now = Date.now()): BulkTokenVerification {
  if (typeof token !== 'string' || !token || !secret) {
    return { ok: false, code: 'INVALID_TOKEN', message: 'The reviewed plan could not be read. Review the selection again.' }
  }
  const [body, signature] = token.split('.')
  if (!body || !signature) {
    return { ok: false, code: 'INVALID_TOKEN', message: 'The reviewed plan could not be read. Review the selection again.' }
  }
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest('hex')

  const a = Buffer.from(signature, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, code: 'INVALID_TOKEN', message: 'The reviewed plan could not be verified. Review the selection again.' }
  }
  let payload: BulkPlanTokenPayload
  try {
    payload = JSON.parse(fromBase64url(body))
  } catch {
    return { ok: false, code: 'INVALID_TOKEN', message: 'The reviewed plan could not be read. Review the selection again.' }
  }
  if (!payload || payload.v !== 1 || !Array.isArray(payload.plan) || typeof payload.plan_hash !== 'string'
    || typeof payload.request_id !== 'string' || typeof payload.phrase !== 'string'
    || typeof payload.actor !== 'string' || typeof payload.organization !== 'string'
    || typeof payload.expires_at !== 'number') {
    return { ok: false, code: 'INVALID_TOKEN', message: 'The reviewed plan could not be verified. Review the selection again.' }
  }
  if (now >= payload.expires_at) {
    return { ok: false, code: 'TOKEN_EXPIRED', message: 'This confirmation expired. Review the selection again; nothing was executed.' }
  }
  return { ok: true, payload }
}

export interface BulkPlanProblem {
  user_id: string
  message: string
}

/**
 * Re-validates a reviewed plan against the authoritative eligibility map.
 * A requested permanent deletion is never converted into an archive (and the
 * reverse is not assumed either): the action must be allowed for that person.
 */
export function validateBulkPlan(
  plan: ReadonlyArray<BulkRemovalPlanEntry>,
  eligibilityById: ReadonlyMap<string, BulkRemovalEligibility>,
): BulkPlanProblem[] {
  const problems: BulkPlanProblem[] = []
  if (plan.length === 0) {
    return [{ user_id: '', message: 'Choose at least one employee to remove.' }]
  }
  if (plan.length > BULK_REMOVAL_MAX_TARGETS) {
    return [{ user_id: '', message: `Select at most ${BULK_REMOVAL_MAX_TARGETS} employees at once.` }]
  }
  const seen = new Set<string>()
  for (const entry of plan) {
    if (!isBulkUuid(entry.user_id)) {
      problems.push({ user_id: String(entry.user_id ?? ''), message: 'The selection contains an invalid employee identifier.' })
      continue
    }
    if (seen.has(entry.user_id)) {
      problems.push({ user_id: entry.user_id, message: 'The same employee is planned twice.' })
      continue
    }
    seen.add(entry.user_id)
    const eligibility = eligibilityById.get(entry.user_id)
    if (!eligibility) {
      problems.push({ user_id: entry.user_id, message: 'This employee is not part of the reviewed selection.' })
      continue
    }
    if (eligibility.classification === 'UNVERIFIED') {
      problems.push({ user_id: entry.user_id, message: 'Eligibility could not be verified for this employee, so no action is allowed.' })
      continue
    }
    if (!isBulkRemovalAction(entry.action)) {
      problems.push({ user_id: entry.user_id, message: 'Choose permanent deletion, archive or skip.' })
      continue
    }
    if (!isBulkEmploymentEnd(entry.employment_end)) {
      problems.push({ user_id: entry.user_id, message: 'Choose an employment outcome (resigned or terminated).' })
      continue
    }
    if (typeof entry.release_identifiers !== 'boolean') {
      problems.push({ user_id: entry.user_id, message: 'Choose whether to release the email and phone.' })
      continue
    }
    if (entry.action === 'delete' && !eligibility.delete_allowed) {
      problems.push({ user_id: entry.user_id, message: 'Permanent deletion is not allowed for this person. Choose Archive & Revoke Access or skip them.' })
    }
    if (entry.action === 'archive' && !eligibility.archive_allowed) {
      problems.push({ user_id: entry.user_id, message: 'Archive & Revoke Access is not allowed for this person.' })
    }
    if (entry.action === 'archive' && entry.release_identifiers && !eligibility.releasable) {
      problems.push({ user_id: entry.user_id, message: 'The email and phone cannot be released for this person.' })
    }
  }
  return problems
}

/**
 * Deterministic per-identity request id for a batch. Repeating the same batch
 * request id produces the same per-identity ids, so the canonical database
 * functions answer with their recorded outcome instead of acting twice.
 */
export function perTargetRequestId(secret: string, batchRequestId: string, userId: string, action: BulkRemovalAction): string {
  if (!secret) throw new Error('bulk_removal_secret_missing')
  const digest = createHmac('sha256', secret)
    .update(`identity-bulk-removal|${batchRequestId}|${userId}|${action}`, 'utf8')
    .digest('hex')
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `a${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-')
}

export type BulkOutcomeKind = 'deleted' | 'archived' | 'blocked' | 'failed' | 'stale'

export interface BulkTargetResult {
  user_id: string
  name: string
  action: BulkRemovalAction
  outcome: BulkOutcomeKind
  detail: string | null
  released?: boolean
  replayed?: boolean
}

export interface BulkExecutionSummary {
  total: number
  deleted: number
  archived: number
  blocked: number
  failed: number
  stale: number
}

export function summarizeBulkResults(results: ReadonlyArray<Pick<BulkTargetResult, 'outcome'>>): BulkExecutionSummary {
  const summary: BulkExecutionSummary = { total: results.length, deleted: 0, archived: 0, blocked: 0, failed: 0, stale: 0 }
  for (const result of results) summary[result.outcome] += 1
  return summary
}

/** True only when every planned identity reached the confirmed outcome. */
export const bulkExecutionComplete = (summary: BulkExecutionSummary): boolean =>
  summary.deleted + summary.archived === summary.total
