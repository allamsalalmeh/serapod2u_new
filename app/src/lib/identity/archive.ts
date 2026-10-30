import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { describeDeletionBlocker, mapDeletionDbError, type DeletionBlocker, type DeletionEntryPoint } from './permanent-deletion'

/**
 * Archive & Revoke Access and controlled email/phone release — the standard
 * lifecycle for former users, shared by User Management and HR → Employees.
 * The database owns every rule
 * (supabase/migrations/20261217100000_identity_archive_identifier_release.sql):
 *   - the same authority as permanent deletion (explicit platform.identity.delete
 *     in the target's organization, + hr.employee.delete from HR) and the same
 *     protections (own account, Root Access, Super Admin, dominance, last HQ admin);
 *   - one transaction: employment ended (resigned/terminated + end date), account
 *     ARCHIVED (S&A leaver sync revokes assignments with an end date, ends
 *     memberships and delegations), login banned, sessions / refresh / one-time
 *     tokens and unused OTP codes revoked; optionally identifiers released;
 *   - the UUID, name, employee number and every historical reference are kept;
 *     nothing is deleted or re-assigned.
 * Releasing replaces the email/phone with a non-deliverable placeholder (the
 * originals live only in a restricted snapshot) so a NEW person can register
 * them with a NEW UUID; a returning person is reactivated and gets them back.
 */

export type ArchiveWarning = { code: 'DIRECT_REPORTS' | 'ACCESS_REVOKED' | 'DELEGATIONS_REVOKED' | 'SESSIONS_REVOKED' | string; count?: number; message?: string }
export type EmploymentEnd = 'resigned' | 'terminated'
export const isEmploymentEnd = (value: unknown): value is EmploymentEnd => value === 'resigned' || value === 'terminated'

export interface ArchivePreview {
  target: {
    user_id: string
    full_name: string | null
    email: string | null
    phone: string | null
    /** Present in the database payload; used to keep bulk operations inside one organization. */
    organization_id?: string | null
    organization_name: string | null
    account_status: string | null
    employee_no: number | null
  }
  employment: Array<{ employment_id: string; employee_no: number | null; onboarding_status: string; status: string; end_date: string | null }>
  archived: boolean
  identifiers_released: boolean
  releasable: boolean
  blockers: DeletionBlocker[]
  warnings: ArchiveWarning[]
  confirmation_phrase: string
  preview_token: string
  entry_point: DeletionEntryPoint
  archive_allowed: boolean
  release_allowed: boolean
}

export function describeArchiveBlocker(b: DeletionBlocker): string {
  switch (b.code) {
    case 'SELF': return 'You cannot archive your own account.'
    case 'ALREADY_ARCHIVED': return 'This account is already archived.'
    case 'NOT_ARCHIVED': return 'Email and phone can only be released for an archived account.'
    case 'ALREADY_RELEASED': return 'This account\'s email and phone were already released.'
    case 'PROTECTED_ROOT': return 'This person holds Root Access. Revoke Root Access first (Security & Access → Root Access).'
    default: return describeDeletionBlocker(b)
  }
}

export function describeArchiveWarning(w: ArchiveWarning): string {
  switch (w.code) {
    case 'DIRECT_REPORTS': return `${w.count ?? 'Some'} employee(s) report to this person. Assign them another manager afterwards.`
    case 'ACCESS_REVOKED': return `${w.count ?? 'All'} Security & Access assignment(s) will be ended (kept as history).`
    case 'DELEGATIONS_REVOKED': return `${w.count ?? 'All'} delegation(s) will be revoked.`
    case 'SESSIONS_REVOKED': return `${w.count ?? 'All'} active sign-in session(s) will be ended immediately.`
    default: return w.code
  }
}

const ARCHIVE_ERRORS: Array<[RegExp, string, number, string]> = [
  [/identity_archive_reason_required/, 'REASON_REQUIRED', 400, 'Enter a reason of at least 10 characters.'],
  [/identity_archive_request_reused/, 'INVALID_INPUT', 400, 'This request was already used for another action. Review the preview again.'],
  [/identity_archive_(input_required|employment_end_invalid)/, 'INVALID_INPUT', 400, 'The request is incomplete.'],
  [/identity_last_root_administrator/, 'BLOCKED', 409, 'The last active Root Administrator cannot be archived.'],
  [/identity_root_target|Root Administrator/, 'FORBIDDEN', 403, 'Only another Root Administrator can archive a Root Administrator.'],
  [/identity_archive_incomplete/, 'FAILED', 500, 'Archiving did not complete, so nothing was changed. Try again.'],
]

export function mapArchiveDbError(error: { message?: string | null } | null | undefined) {
  const message = error?.message || ''
  for (const [pattern, code, status, text] of ARCHIVE_ERRORS) {
    if (pattern.test(message)) return { ok: false as const, code, status, message: text }
  }
  const mapped = mapDeletionDbError(error)
  if (mapped.code === 'NOT_INSTALLED') return { ...mapped, message: 'Archive & Revoke Access is not installed on this database yet.' }
  if (mapped.code === 'FAILED') return { ...mapped, message: 'Archiving did not complete, so nothing was changed.' }
  return mapped
}

const withMessages = (p: ArchivePreview): ArchivePreview => ({
  ...p,
  blockers: (p.blockers ?? []).map(b => ({ ...b, message: describeArchiveBlocker(b) })),
  warnings: (p.warnings ?? []).map(w => ({ ...w, message: describeArchiveWarning(w) })),
})

export async function archivePreview(actorId: string, userId: string, entry: DeletionEntryPoint) {
  const admin = createAdminClient(30_000) as any
  const { data, error } = await admin.rpc('identity_archive_preview', { p_actor: actorId, p_user: userId, p_entry: entry })
  if (error) return mapArchiveDbError(error)
  return { ok: true as const, preview: withMessages(data as ArchivePreview) }
}

export type LifecycleOutcome =
  | { status: 'completed'; actionId: string; replayed: boolean; released: boolean; login?: Record<string, number> }
  | { status: 'blocked'; actionId?: string; replayed: boolean; blockers: DeletionBlocker[] }
  | { status: 'stale' }

function toOutcome(data: any): LifecycleOutcome {
  if (data?.status === 'stale') return { status: 'stale' }
  if (data?.status === 'blocked') {
    return { status: 'blocked', actionId: data.action_id, replayed: data.replayed === true,
      blockers: (data.blockers ?? []).map((b: DeletionBlocker) => ({ ...b, message: describeArchiveBlocker(b) })) }
  }
  const release = data?.release ?? data?.details?.release
  return { status: 'completed', actionId: data?.action_id, replayed: data?.replayed === true,
    released: release?.released === true, login: data?.login ?? data?.details?.login }
}

export async function archiveExecute(input: {
  actorId: string
  userId: string
  entry: DeletionEntryPoint
  requestId: string
  previewToken: string
  reason: string
  confirmation: string
  releaseIdentifiers: boolean
  employmentEnd: EmploymentEnd
}) {
  const admin = createAdminClient(60_000) as any
  const { data, error } = await admin.rpc('identity_archive_execute', {
    p_actor: input.actorId,
    p_user: input.userId,
    p_entry: input.entry,
    p_request_id: input.requestId,
    p_preview_token: input.previewToken,
    p_reason: input.reason,
    p_confirmation: input.confirmation,
    p_release_identifiers: input.releaseIdentifiers,
    p_employment_end: input.employmentEnd,
  })
  if (error) return mapArchiveDbError(error)
  return { ok: true as const, outcome: toOutcome(data) }
}

export async function releaseIdentifiers(input: { actorId: string; userId: string; entry: DeletionEntryPoint; requestId: string; reason: string }) {
  const admin = createAdminClient(30_000) as any
  const { data, error } = await admin.rpc('identity_release_identifiers', {
    p_actor: input.actorId, p_user: input.userId, p_entry: input.entry, p_request_id: input.requestId, p_reason: input.reason,
  })
  if (error) return mapArchiveDbError(error)
  return { ok: true as const, outcome: toOutcome(data) }
}
