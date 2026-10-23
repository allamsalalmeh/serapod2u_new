import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Permanent identity deletion — the ONE deletion service behind User
 * Management "Delete User" and HR → Employees "Delete Employee Permanently".
 * The database owns every rule
 * (supabase/migrations/20261216100000_identity_permanent_deletion.sql):
 *   - explicit platform.identity.delete in the target's organization (no legacy
 *     role level, no delegation); the HR entry point additionally needs
 *     hr.employee.delete and an employment record;
 *   - protections: own account, Root Access, Super Admin, a target the actor
 *     does not dominate, the last HQ administrator, HR live;
 *   - dependency graph from pg_constraint (identity, login, employment record,
 *     person columns without a foreign key): only an explicit allowlist of
 *     identity-owned rows is removed, append-only logs are retained, anything
 *     else blocks — nothing is re-assigned or nulled;
 *   - preview token, typed confirmation, reason, idempotency key, advisory and
 *     row locks, durable before-image.
 * The login (auth.users), central identity (public.users) and HR anchor are
 * removed in ONE database transaction. Afterwards the GoTrue admin API must
 * confirm the account is gone before success is reported.
 */

export const IDENTITY_DELETE_PERMISSION = 'platform.identity.delete'
export const HR_EMPLOYEE_DELETE_PERMISSION = 'hr.employee.delete'

export type DeletionEntryPoint = 'user_management' | 'hr'
export const isDeletionEntryPoint = (value: unknown): value is DeletionEntryPoint => value === 'user_management' || value === 'hr'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value)

export interface DeletionBlocker {
  code: 'SELF' | 'PROTECTED_ROOT' | 'PROTECTED_SUPER_ADMIN' | 'TARGET_MORE_PRIVILEGED' | 'LAST_ADMINISTRATOR' | 'HR_LIVE'
    | 'DIRECT_REPORTS' | 'PROTECTED_RECORDS' | 'HR_RESET_SNAPSHOT' | string
  category?: string
  table?: string
  column?: string
  count?: number
  via?: string
  foreign_key?: boolean
  message?: string
}

export interface DeletionPreview {
  target: {
    user_id: string
    full_name: string | null
    email: string | null
    phone: string | null
    organization_id: string | null
    organization_name: string | null
    role_code: string | null
    employee_no: number | null
    account_status: string | null
    has_identity: boolean
    has_login: boolean
  }
  employment: Array<{ employment_id: string; organization_id: string; employee_no: number | null; onboarding_status: 'pending' | 'completed' | 'reset'; status: string }>
  cleanup: Array<{ table: string; column: string; count: number; label?: string }>
  retained: Array<{ table: string; column: string; label?: string }>
  blockers: DeletionBlocker[]
  confirmation_phrase: string
  preview_token: string
  entry_point: DeletionEntryPoint
  allowed: boolean
}

const CATEGORY_LABELS: Record<string, string> = {
  supply_chain: 'Supply Chain records (orders, stock, warehouse, QR or returns)',
  purchase_orders: 'purchase orders',
  finance: 'finance records (GL, payments, invoices, payouts)',
  payroll: 'payroll records',
  commission: 'sales commission records',
  compensation: 'compensation records',
  hr_attendance: 'attendance, overtime or timesheet records',
  hr_leave: 'leave requests or approvals',
  performance: 'KPI or performance records',
  positions: 'position assignments or approvals',
  hr_documents: 'employee documents or contracts',
  hr_other: 'other HR records',
  roadtour_operations: 'RoadTour / event operations records',
  security_access: 'Security & Access governance records (Root Access, access reviews, requests, delegations)',
  notifications_messaging: 'messages or campaign records',
  audit: 'audit history',
  loyalty: 'loyalty / points records',
  other: 'other business records',
}

const CLEANUP_LABELS: Record<string, string> = {
  hr_employees: 'HR employment record (employee number)',
  sa_organization_memberships: 'organization memberships',
  sa_role_assignments: 'Security & Access policy assignments',
  hr_access_group_members: 'HR access group memberships',
  account_scope_audit_log: 'account scope history (copied into the deletion record)',
  telegram_links: 'Telegram links',
  telegram_link_tokens: 'Telegram link tokens',
  serapp_user_presence: 'presence status',
  message_notifications: 'personal notifications',
  support_thread_reads: 'support read markers',
  support_thread_participants: 'support thread participation',
  admin_whatsapp_identities: 'admin WhatsApp identity',
}

/** Caller-safe explanation of one blocker. */
export function describeDeletionBlocker(b: DeletionBlocker): string {
  switch (b.code) {
    case 'SELF': return 'You cannot delete your own account.'
    case 'PROTECTED_ROOT': return 'This person holds (or held) Root Access. Root Access holders are never deleted.'
    case 'PROTECTED_SUPER_ADMIN': return 'Only a Super Admin or Root Administrator can delete a Super Admin account.'
    case 'TARGET_MORE_PRIVILEGED': return 'This person has access you do not hold yourself, so you cannot delete them.'
    case 'LAST_ADMINISTRATOR': return 'This is the last active HQ administrator of the organization.'
    case 'HR_LIVE': return 'HR for this organization is live. Permanent deletion of employees is only available before HR goes live.'
    case 'DIRECT_REPORTS': return `${b.count ?? 'Some'} employee(s) report to this person. Assign them another manager first.`
    case 'HR_RESET_SNAPSHOT': return 'An HR data reset that can still be restored keeps this person\'s HR records. Deleting them would break that restore.'
    case 'PROTECTED_RECORDS':
      return `Referenced by ${b.count != null ? `${b.count} ` : ''}${CATEGORY_LABELS[b.category ?? ''] ?? 'business records'}`
        + `${b.table ? ` (${b.table}.${b.column ?? ''})` : ''}. These are kept, so the account cannot be deleted — deactivate or archive it instead.`
    default: return 'Permanent deletion is not available for this person.'
  }
}

function withLabels(preview: DeletionPreview): DeletionPreview {
  return {
    ...preview,
    blockers: (preview.blockers ?? []).map(b => ({ ...b, message: describeDeletionBlocker(b) })),
    cleanup: (preview.cleanup ?? []).map(c => ({ ...c, label: CLEANUP_LABELS[c.table] ?? c.table })),
    retained: (preview.retained ?? []).map(r => ({ ...r, label: `${r.table} (audit log, kept)` })),
  }
}

const DB_ERRORS: Array<[RegExp, string, number, string]> = [
  [/sa_authorization_required/, 'FORBIDDEN', 403,
    'You are not authorized to permanently delete this person (Security & Access: Archive Identities, plus HR Employee Record Administrator from HR).'],
  [/sa_actor_inactive|sa_actor_required/, 'FORBIDDEN', 403, 'Your account cannot perform this action.'],
  [/identity_deletion_target_not_found|hr_employee_not_in_organization/, 'NOT_FOUND', 404, 'This person was not found (they may already have been deleted).'],
  [/identity_deletion_reason_required/, 'REASON_REQUIRED', 400, 'Enter a reason of at least 10 characters.'],
  [/identity_deletion_confirmation_mismatch/, 'CONFIRMATION_MISMATCH', 400, 'The confirmation text does not match. Nothing was deleted.'],
  [/identity_deletion_request_reused/, 'INVALID_INPUT', 400, 'This request was already used for another person. Review the preview again.'],
  [/identity_deletion_(input_required|entry_invalid)/, 'INVALID_INPUT', 400, 'The request is incomplete.'],
  [/lock_not_available|canceling statement due to lock timeout|deadlock detected/, 'BUSY', 409,
    'This person\'s records are being changed right now. Nothing was deleted; try again in a moment.'],
]

export type DeletionError = { ok: false; code: string; status: number; message: string }

export function mapDeletionDbError(error: { message?: string | null } | null | undefined): DeletionError {
  const message = error?.message || ''
  for (const [pattern, code, status, text] of DB_ERRORS) {
    if (pattern.test(message)) return { ok: false, code, status, message: text }
  }
  if (/function .* does not exist|Could not find the function/i.test(message)) {
    return { ok: false, code: 'NOT_INSTALLED', status: 503, message: 'Permanent deletion is not installed on this database yet.' }
  }
  return { ok: false, code: 'FAILED', status: 500, message: 'The deletion did not complete. Nothing was deleted.' }
}

export async function deletionActorCheck(actorId: string, entry: DeletionEntryPoint) {
  const admin = createAdminClient() as any
  const { data, error } = await admin.rpc('identity_deletion_actor_check', { p_actor: actorId, p_entry: entry })
  if (error) return mapDeletionDbError(error)
  return { ok: true as const, check: { permission: data?.permission === true } }
}

export async function deletionPreview(actorId: string, userId: string, entry: DeletionEntryPoint) {
  const admin = createAdminClient(30_000) as any
  const { data, error } = await admin.rpc('identity_deletion_preview', { p_actor: actorId, p_user: userId, p_entry: entry })
  if (error) return mapDeletionDbError(error)
  return { ok: true as const, preview: withLabels(data as DeletionPreview) }
}

export type DeletionOutcome =
  | { status: 'completed'; deletionId: string; replayed: boolean; removed: Array<{ table: string; count: number }>; authVerified: true }
  | { status: 'blocked'; deletionId?: string; replayed: boolean; blockers: DeletionBlocker[] }
  | { status: 'stale' }

/**
 * Verifies with GoTrue that the login is gone. The database transaction
 * already deleted auth.users; this catches a deployment whose auth store is
 * not that database. A login that is still there is deleted through the admin
 * API; if that fails too the outcome is an error, never success.
 */
async function verifyLoginGone(admin: any, userId: string): Promise<{ verified: boolean; detail: string | null }> {
  const lookup = async () => {
    const { data, error } = await admin.auth.admin.getUserById(userId)
    if (error) {
      const notFound = error.status === 404 || /not.?found/i.test(error.message || '')
      return notFound ? 'absent' : 'unknown'
    }
    return data?.user ? 'present' : 'absent'
  }
  let state = await lookup()
  if (state === 'present') {
    const { error } = await admin.auth.admin.deleteUser(userId)
    if (error) return { verified: false, detail: `login still present; admin delete failed: ${error.message}` }
    state = await lookup()
  }
  if (state === 'absent') return { verified: true, detail: null }
  return { verified: false, detail: state === 'present' ? 'login still present after admin delete' : 'auth service did not answer' }
}

export async function deletionExecute(input: {
  actorId: string
  userId: string
  entry: DeletionEntryPoint
  requestId: string
  previewToken: string
  reason: string
  confirmation: string
}): Promise<{ ok: true; outcome: DeletionOutcome } | DeletionError> {
  const admin = createAdminClient(60_000) as any
  const { data, error } = await admin.rpc('identity_deletion_execute', {
    p_actor: input.actorId,
    p_user: input.userId,
    p_entry: input.entry,
    p_request_id: input.requestId,
    p_preview_token: input.previewToken,
    p_reason: input.reason,
    p_confirmation: input.confirmation,
  })
  if (error) return mapDeletionDbError(error)

  const result = data as { status: 'completed' | 'blocked' | 'stale' | 'executing'; replayed?: boolean; deletion_id?: string;
    removed?: Array<{ table: string; count: number }>; blockers?: DeletionBlocker[] }
  if (result.status === 'stale') return { ok: true, outcome: { status: 'stale' } }
  if (result.status === 'blocked') {
    return { ok: true, outcome: { status: 'blocked', deletionId: result.deletion_id, replayed: result.replayed === true,
      blockers: (result.blockers ?? []).map(b => ({ ...b, message: describeDeletionBlocker(b) })) } }
  }
  if (result.status !== 'completed' || !result.deletion_id) {
    return { ok: false, code: 'FAILED', status: 500, message: 'The deletion did not complete. Nothing was deleted.' }
  }

  const check = await verifyLoginGone(admin, input.userId)
  await admin.rpc('identity_deletion_record_auth_check', { p_request_id: input.requestId, p_verified: check.verified, p_detail: check.detail })
    .then(() => undefined, () => undefined)
  if (!check.verified) {
    return {
      ok: false, code: 'AUTH_CLEANUP_REQUIRED', status: 502,
      message: 'The person\'s records were deleted, but the login could not be confirmed as removed. Retry the deletion to finish; it is recorded and safe to repeat.',
    }
  }
  return { ok: true, outcome: { status: 'completed', deletionId: result.deletion_id, replayed: result.replayed === true,
    removed: result.removed ?? [], authVerified: true } }
}
