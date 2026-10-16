import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * HR Data Management (pre-go-live reset). The database owns every rule —
 * Super Admin + explicit hr.data.reset grant, pre-go-live phase, allowlist,
 * dependency blockers, preview token, idempotency key, snapshot, audit
 * (supabase/migrations/20261003100000_hr_onboarding_state_and_data_reset.sql).
 * This module only calls it and maps errors to caller-safe messages.
 */

export type HrResetKind = 'onboarding' | 'full'

export const HR_RESET_KINDS: readonly HrResetKind[] = ['onboarding', 'full']

export function isHrResetKind(value: unknown): value is HrResetKind {
  return value === 'onboarding' || value === 'full'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value)

const DB_ERRORS: Array<[RegExp, string, number, string]> = [
  [/hr_reset_requires_super_admin/, 'SUPER_ADMIN_REQUIRED', 403, 'Only a Super Admin can reset HR data.'],
  [/hr_reset_permission_required/, 'RESET_PERMISSION_REQUIRED', 403,
    'You need the "HR Data Reset Administrator" role for this organization in Security & Access.'],
  [/hr_reset_not_pre_go_live/, 'NOT_PRE_GO_LIVE', 409, 'HR for this organization is live. Resets are only available before HR goes live.'],
  [/hr_reset_organization_unknown/, 'ORGANIZATION_UNKNOWN', 404, 'Organization not found.'],
  [/hr_reset_confirmation_mismatch/, 'CONFIRMATION_MISMATCH', 400, 'The confirmation text does not match.'],
  [/hr_reset_reason_required/, 'REASON_REQUIRED', 400, 'Enter a reason of at least 10 characters.'],
  [/hr_reset_request_id_required|hr_reset_kind_invalid/, 'INVALID_INPUT', 400, 'The request is incomplete.'],
  [/hr_reset_snapshot_incomplete/, 'SNAPSHOT_FAILED', 500, 'The snapshot could not be completed, so nothing was reset.'],
  [/hr_reset_count_mismatch/, 'COUNT_MISMATCH', 409, 'The data changed during the reset, so nothing was reset. Review the preview again.'],
  [/sa_actor_inactive|sa_actor_required/, 'FORBIDDEN', 403, 'Your account cannot perform this action.'],
]

export type HrResetError = { ok: false; code: string; status: number; message: string }

export function mapHrResetDbError(error: { message?: string | null } | null | undefined): HrResetError {
  const message = error?.message || ''
  for (const [pattern, code, status, text] of DB_ERRORS) {
    if (pattern.test(message)) return { ok: false, code, status, message: text }
  }
  if (/function .* does not exist|Could not find the function/i.test(message)) {
    return { ok: false, code: 'NOT_INSTALLED', status: 503, message: 'HR Data Management is not installed yet.' }
  }
  return { ok: false, code: 'RESET_FAILED', status: 500, message: 'The reset did not run. No changes were kept.' }
}

export interface HrResetEligibility {
  super_admin: boolean
  reset_permission: boolean
  phase: 'pre_go_live' | 'live' | 'not_configured'
  eligible: boolean
}

export async function hrResetEligibility(actorId: string, organizationId: string) {
  const admin = createAdminClient() as any
  const { data, error } = await admin.rpc('hr_reset_actor_check', { p_actor: actorId, p_org: organizationId })
  if (error) return mapHrResetDbError(error)
  return { ok: true as const, eligibility: data as HrResetEligibility }
}

/** Organizations offered in the selector: HR-configured organizations this actor can reset. */
export async function hrResetOrganizations(actorId: string) {
  const admin = createAdminClient() as any
  const { data: states, error } = await admin
    .from('hr_go_live_state')
    .select('organization_id, phase, organizations:organization_id(org_name, org_code)')
  if (error) return mapHrResetDbError(error)
  const result: Array<{ id: string; name: string; code: string | null; phase: string; eligible: boolean }> = []
  for (const row of states || []) {
    const check = await hrResetEligibility(actorId, row.organization_id)
    if (!check.ok || !check.eligibility.reset_permission) continue
    const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations
    result.push({ id: row.organization_id, name: org?.org_name ?? 'Organization', code: org?.org_code ?? null, phase: row.phase, eligible: check.eligibility.eligible })
  }
  return { ok: true as const, organizations: result.sort((a, b) => a.name.localeCompare(b.name)) }
}

export async function hrResetPreview(actorId: string, organizationId: string, kind: HrResetKind) {
  const admin = createAdminClient() as any
  const { data, error } = await admin.rpc('hr_reset_preview', { p_actor: actorId, p_org: organizationId, p_kind: kind })
  if (error) return mapHrResetDbError(error)
  return { ok: true as const, preview: data }
}

export async function hrResetExecute(input: {
  actorId: string
  organizationId: string
  kind: HrResetKind
  requestId: string
  previewToken: string
  reason: string
  confirmation: string
}) {
  const admin = createAdminClient(60_000) as any
  const { data, error } = await admin.rpc('hr_reset_execute', {
    p_actor: input.actorId,
    p_org: input.organizationId,
    p_kind: input.kind,
    p_request_id: input.requestId,
    p_preview_token: input.previewToken,
    p_reason: input.reason,
    p_confirmation: input.confirmation,
  })
  if (error) return mapHrResetDbError(error)
  return { ok: true as const, result: data as { status: 'completed' | 'blocked' | 'stale'; run_id?: string; replayed?: boolean; counts?: Record<string, number>; onboarding_reset?: number; blockers?: unknown[]; message?: string } }
}

export async function hrResetHistory(organizationId: string, limit = 10) {
  const admin = createAdminClient() as any
  const { data, error } = await admin
    .from('hr_reset_runs')
    .select('id, kind, status, actor_id, reason, counts, onboarding_reset, snapshot_rows, created_at')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) return []
  return data || []
}
