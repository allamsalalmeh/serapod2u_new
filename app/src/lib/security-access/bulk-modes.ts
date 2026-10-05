import { createHash } from 'node:crypto'
import { MODULE_TAXONOMY, OTHER_MODULE, classifyPermission, moduleGroupName } from './modules'
import { permissionLabel } from './labels'

/**
 * Bulk migration-mode change for a module group or subgroup.
 *
 * Group membership is resolved HERE, on the server, from the registered
 * migration modes and the shared taxonomy (modules.ts) — the browser sends
 * only a group id, never a list of permissions. Eligibility rules live in the
 * database (sa_bulk_mode_evaluate); the database re-verifies authority, the
 * previewed modes and eligibility under row locks when applying.
 */

export const BULK_TARGET_MODES = ['LEGACY_ENFORCED', 'SHADOW', 'NEW_ENFORCED', 'LEGACY_RETIRED'] as const
export type BulkTargetMode = (typeof BULK_TARGET_MODES)[number]
export type BulkSelection = 'all' | 'eligible_only'

export const BLOCKER_MESSAGES: Record<string, string> = {
  sa_not_enforcement_ready: 'Not enforcement-ready: not every route and database path is wired for the new model yet.',
  sa_retire_requires_new_enforced: 'Legacy can only be retired from New Access Active. Move it to New Access Active first (never done automatically).',
  sa_permission_unknown: 'Not registered in the migration-mode table.',
}

export interface ResolvedGroup { id: string; name: string; kind: 'group' | 'subgroup'; keys: string[] }

/** Group ids are the Overview node ids: "supply_chain", "supply_chain/stock_count" or "other". */
export function resolveGroup(groupId: string, registeredKeys: string[]): ResolvedGroup | null {
  const [groupPart, areaPart, extra] = String(groupId).split('/')
  if (extra !== undefined || !groupPart) return null
  let name: string
  let match: (key: string) => boolean
  if (groupPart === OTHER_MODULE.id) {
    if (areaPart !== undefined) return null
    name = OTHER_MODULE.name
    match = key => classifyPermission(key).groupId === OTHER_MODULE.id
  } else {
    const group = MODULE_TAXONOMY.find(g => g.id === groupPart)
    if (!group) return null
    if (areaPart === undefined) {
      name = group.name
      match = key => classifyPermission(key).groupId === group.id
    } else {
      const area = group.areas?.find(a => a.id === areaPart)
      if (!area) return null
      name = `${moduleGroupName(group.id)} · ${area.name}`
      match = key => { const c = classifyPermission(key); return c.groupId === group.id && c.areaId === area.id }
    }
  }
  const keys = Array.from(new Set(registeredKeys)).filter(match).sort()
  return { id: groupId, name, kind: areaPart === undefined ? 'group' : 'subgroup', keys }
}

export interface PreviewRow {
  permissionKey: string
  label: string
  currentMode: string
  targetMode: BulkTargetMode
  status: 'change' | 'unchanged' | 'blocked'
  blockers: Array<{ code: string; message: string }>
}

export interface BulkPreview {
  group: { id: string; name: string; kind: 'group' | 'subgroup'; total: number }
  targetMode: BulkTargetMode
  rows: PreviewRow[]
  counts: { change: number; unchanged: number; blocked: number }
  /** Concurrency token: changes whenever membership, a relevant mode or eligibility changes. */
  previewHash: string
  /** "All permissions" can be applied (nothing blocked, something to change). */
  canApplyAll: boolean
  /** "Eligible only" is offered (some blocked, some changeable). */
  canApplyEligibleOnly: boolean
}

export function previewHashOf(groupId: string, targetMode: string, rows: Array<Pick<PreviewRow, 'permissionKey' | 'currentMode' | 'status' | 'blockers'>>): string {
  const canonical = JSON.stringify([groupId, targetMode, rows.map(r => [r.permissionKey, r.currentMode, r.status, r.blockers.map(b => b.code).sort()])])
  return createHash('sha256').update(canonical).digest('hex')
}

export type BulkFailure = { ok: false; status: number; code: string; error: string }
export type BulkOutcome<T> = { ok: true; value: T } | BulkFailure
const fail = (status: number, code: string, error: string): BulkFailure => ({ ok: false, status, code, error })

const isMissingFunction = (error: any) =>
  ['PGRST202', '42883'].includes(String(error?.code)) || /could not find the function|does not exist/i.test(String(error?.message || ''))

const MIGRATION_MISSING = fail(409, 'bulk_migration_missing',
  'Group mode changes need the database migration 20261004100000_sa_bulk_migration_mode.sql, which has not been applied in this environment yet. Single-permission changes still work.')

/** Loads membership from the server-side registry and asks the database to evaluate eligibility. */
async function loadPreview(admin: any, actorId: string, groupId: string, targetMode: BulkTargetMode): Promise<BulkOutcome<{ preview: BulkPreview; modes: Record<string, string>; keys: string[] }>> {
  const { data: registered, error } = await admin.from('sa_migration_modes').select('permission_key,mode')
  if (error) return fail(500, 'modes_unavailable', 'Migration modes could not be loaded.')
  const group = resolveGroup(groupId, (registered || []).map((r: any) => r.permission_key))
  if (!group) return fail(400, 'unknown_group', 'Unknown module group.')
  if (group.keys.length === 0) return fail(404, 'empty_group', 'This group has no registered permissions.')

  const { data, error: rpcError } = await admin.rpc('sa_preview_bulk_migration_mode', { p_actor: actorId, p_permissions: group.keys, p_target: targetMode })
  if (rpcError) {
    if (isMissingFunction(rpcError)) return MIGRATION_MISSING
    return { ok: false, ...mapDatabaseError(rpcError) }
  }
  const byKey = new Map<string, any>((data || []).map((r: any) => [r.permission_key, r]))
  const rows: PreviewRow[] = group.keys.map(key => {
    const r = byKey.get(key)
    return {
      permissionKey: key, label: permissionLabel(key).label,
      currentMode: r?.current_mode ?? 'UNREGISTERED', targetMode,
      status: r?.status ?? 'blocked',
      blockers: (r?.blockers ?? (r ? [] : ['sa_permission_unknown'])).map((code: string) => ({ code, message: BLOCKER_MESSAGES[code] ?? code })),
    }
  })
  const counts = {
    change: rows.filter(r => r.status === 'change').length,
    unchanged: rows.filter(r => r.status === 'unchanged').length,
    blocked: rows.filter(r => r.status === 'blocked').length,
  }
  const preview: BulkPreview = {
    group: { id: group.id, name: group.name, kind: group.kind, total: rows.length },
    targetMode, rows, counts,
    previewHash: previewHashOf(group.id, targetMode, rows),
    canApplyAll: counts.blocked === 0 && counts.change > 0,
    canApplyEligibleOnly: counts.blocked > 0 && counts.change > 0,
  }
  return { ok: true, value: { preview, modes: Object.fromEntries(rows.map(r => [r.permissionKey, r.currentMode])), keys: group.keys } }
}

export async function previewBulkModeChange(admin: any, actorId: string, input: { groupId: string; targetMode: BulkTargetMode }): Promise<BulkOutcome<BulkPreview>> {
  const loaded = await loadPreview(admin, actorId, input.groupId, input.targetMode)
  return loaded.ok ? { ok: true, value: loaded.value.preview } : loaded
}

export interface BulkApplyInput {
  groupId: string
  targetMode: BulkTargetMode
  selection: BulkSelection
  reason: string
  previewHash: string
  idempotencyKey: string
}

export interface BulkApplyResult {
  batchId: string
  groupId: string
  targetMode: BulkTargetMode
  selection: BulkSelection
  changed: number
  unchanged: number
  skipped: number
  replayed: boolean
  items: Array<{ permissionKey: string; from: string; to: string; status: 'changed' | 'unchanged' | 'skipped'; blockers: string[] }>
}

const DATABASE_ERRORS: Array<[RegExp, number, string, string]> = [
  [/sa_bulk_stale_preview/, 409, 'stale_preview', 'The group changed since this preview. Review a fresh preview before applying.'],
  [/sa_bulk_blocked/, 409, 'blocked', 'Some permissions are blocked, so nothing was changed. Choose “Eligible permissions only” to skip them.'],
  [/sa_bulk_no_changes/, 409, 'no_changes', 'Nothing to change: every permission is already in the target mode or blocked.'],
  [/sa_bulk_actor_lockout/, 409, 'actor_lockout', 'Nothing was changed: this would remove your own authority to manage permissions.'],
  [/sa_bulk_idempotency_conflict/, 409, 'idempotency_conflict', 'This submission key was already used for a different change. Start from a fresh preview.'],
  [/sa_bulk_selection_invalid/, 400, 'selection_invalid', 'The selection is not valid.'],
  [/sa_reason_required/, 400, 'reason_required', 'A reason of at least 10 characters is required.'],
  [/sa_not_enforcement_ready/, 409, 'not_enforcement_ready', 'A permission is not enforcement-ready. Nothing was changed.'],
  [/sa_retire_requires_new_enforced/, 409, 'retire_requires_new_enforced', 'A permission must be New Access Active before legacy is retired. Nothing was changed.'],
  [/sa_authorization_required|sa_actor_inactive|sa_actor_required/, 403, 'forbidden', 'Forbidden'],
]

export function mapDatabaseError(error: any): { status: number; code: string; error: string } {
  const message = String(error?.message || '')
  for (const [pattern, status, code, text] of DATABASE_ERRORS) if (pattern.test(message)) return { status, code, error: text }
  console.error('[security-access] bulk mode change failed', { code: error?.code })
  return { status: 400, code: 'failed', error: 'The group mode change could not be completed. Nothing was changed.' }
}

/**
 * Applies one batch. Membership, modes and eligibility are re-resolved now; a
 * preview hash that no longer matches is rejected (never silently re-planned).
 * The database then repeats the checks under row locks in one transaction.
 */
export async function applyBulkModeChange(admin: any, actorId: string, input: BulkApplyInput): Promise<BulkOutcome<BulkApplyResult>> {
  // Repeated submission: the same actor + key replays the stored result and
  // changes/audits nothing. (The database repeats this under a lock for races.)
  const { data: prior, error: priorError } = await admin.from('sa_migration_mode_batches')
    .select('group_id,target_mode,selection,result').eq('actor_id', actorId).eq('idempotency_key', input.idempotencyKey).maybeSingle()
  if (priorError) return isMissingFunction(priorError) || priorError.code === '42P01' || priorError.code === 'PGRST205' ? MIGRATION_MISSING : { ok: false, ...mapDatabaseError(priorError) }
  if (prior) {
    if (prior.group_id !== input.groupId || prior.target_mode !== input.targetMode || prior.selection !== input.selection) {
      return fail(409, 'idempotency_conflict', DATABASE_ERRORS.find(e => e[2] === 'idempotency_conflict')![3])
    }
    return { ok: true, value: { ...prior.result, replayed: true } }
  }

  // Membership, modes and eligibility are re-resolved now; a changed preview is rejected, never silently re-planned.
  const loaded = await loadPreview(admin, actorId, input.groupId, input.targetMode)
  if (!loaded.ok) return loaded
  const { preview, modes, keys } = loaded.value
  if (preview.previewHash !== input.previewHash) return fail(409, 'stale_preview', DATABASE_ERRORS[0][3])
  if (input.selection === 'all' && preview.counts.blocked > 0) return fail(409, 'blocked', DATABASE_ERRORS[1][3])
  if (preview.counts.change === 0) return fail(409, 'no_changes', DATABASE_ERRORS[2][3])

  const { data, error } = await admin.rpc('sa_bulk_set_migration_mode', {
    p_actor: actorId, p_permissions: keys, p_expected: modes, p_target: input.targetMode, p_reason: input.reason.trim(),
    p_group_id: input.groupId, p_selection: input.selection, p_idempotency_key: input.idempotencyKey,
  })
  if (error) return isMissingFunction(error) ? MIGRATION_MISSING : { ok: false, ...mapDatabaseError(error) }
  return { ok: true, value: data as BulkApplyResult }
}
