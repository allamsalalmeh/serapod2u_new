import { z } from 'zod'
import { groupByTaxonomy } from './modules'
import { permissionLabel } from './labels'

/**
 * Access Profiles = business roles (sa_business_roles) plus a draft → review →
 * publish lifecycle. No second authorization engine: evaluation, assignments,
 * scopes, SoD and the audit log are the existing ones. This file is the
 * server-side service the profiles route calls and the client-safe helpers the
 * UI shares.
 *
 *   Standard      source 'template'  — protected; only copied.
 *   Custom        source 'new'       — edited through drafts only.
 *   Compatibility source 'legacy'    — lifecycle-managed, never a profile.
 */

export type ProfileKind = 'standard' | 'custom' | 'compatibility'
export const profileKind = (role: { source?: string | null }): ProfileKind =>
  role.source === 'legacy' ? 'compatibility' : role.source === 'template' ? 'standard' : 'custom'

export const ACCOUNT_TYPES = ['internal', 'partner'] as const
export const ACCOUNT_TYPE_LABELS: Record<string, string> = { internal: 'Internal staff', partner: 'Partner account' }

const uuid = z.string().uuid()
const permissionKey = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/)
const content = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().default(''),
  accountTypes: z.array(z.enum(ACCOUNT_TYPES)).max(2).default([]),
  orgTypes: z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{1,16}$/)).max(10).default([]),
  // Explicit permissions only: never a module wildcard.
  permissionKeys: z.array(permissionKey).max(300),
}
export const profileActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), roleKey: z.string().regex(/^[a-z][a-z0-9_-]*$/).max(80), ...content }).strict(),
  z.object({ action: z.literal('copy'), sourceId: uuid, roleKey: z.string().regex(/^[a-z][a-z0-9_-]*$/).max(80), name: z.string().trim().max(120).optional().default(''), reason: z.string().trim().min(10).max(500) }).strict(),
  z.object({ action: z.literal('save_draft'), roleId: uuid, ...content }).strict(),
  z.object({ action: z.literal('submit'), roleId: uuid }).strict(),
  z.object({ action: z.literal('discard'), roleId: uuid, reason: z.string().trim().min(5).max(500) }).strict(),
  z.object({ action: z.literal('preview'), roleId: uuid }).strict(),
  z.object({ action: z.literal('publish'), roleId: uuid, impactHash: z.string().regex(/^[0-9a-f]{32}$/), reason: z.string().trim().max(500).optional().default('') }).strict(),
  z.object({ action: z.literal('retire'), roleId: uuid, reason: z.string().trim().min(10).max(500) }).strict(),
  z.object({ action: z.literal('holders'), roleId: uuid }).strict(),
])
export type ProfileAction = z.infer<typeof profileActionSchema>

export type ProfileFailure = { ok: false; status: number; code: string; error: string }
const fail = (status: number, code: string, error: string): ProfileFailure => ({ ok: false, status, code, error })

const ERRORS: Array<[RegExp, number, string, string]> = [
  [/sa_profile_standard_protected/, 409, 'standard_protected', 'Standard profiles are protected. Use “Copy & Customize” to make your own version.'],
  [/sa_profile_not_editable/, 409, 'not_editable', 'Compatibility roles are managed by the lifecycle and cannot be edited or copied.'],
  [/sa_profile_legacy_not_copyable/, 409, 'not_editable', 'Compatibility roles are managed by the lifecycle and cannot be edited or copied.'],
  [/sa_profile_key_taken/, 409, 'key_taken', 'That profile key is already used.'],
  [/sa_profile_invalid_permission/, 400, 'invalid_permission', 'One or more permissions are unknown or inactive.'],
  [/sa_profile_partner_forbidden/, 409, 'partner_forbidden', 'Profiles for partner accounts cannot include HR, security administration, user administration or data-maintenance permissions.'],
  [/sa_profile_too_large/, 400, 'too_large', 'A profile can hold at most 300 permissions.'],
  [/sa_profile_no_draft/, 409, 'no_draft', 'There is no open draft for this profile.'],
  [/sa_profile_not_in_review/, 409, 'not_in_review', 'Submit the draft for review before publishing it.'],
  [/sa_profile_stale_preview/, 409, 'stale_preview', 'The profile or its holders changed since this impact preview. Review a fresh preview before publishing.'],
  [/sa_profile_self_review_prohibited/, 403, 'self_review', 'A change that affects existing holders must be published by someone other than the person who submitted it.'],
  [/sa_profile_holder_conflict/, 409, 'holder_conflict', 'Publishing would create a segregation-of-duties conflict for an existing holder. Nothing was changed.'],
  [/sa_profile_has_holders/, 409, 'has_holders', 'This profile is still assigned. Revoke or replace the assignments before retiring it.'],
  [/sa_profile_in_use/, 409, 'in_use', 'An assigned profile cannot be deleted. Retire it instead.'],
  [/sa_profile_requires_draft/, 409, 'requires_draft', 'An assigned profile can only change through a draft, review and publication.'],
  [/sa_profile_not_published/, 409, 'not_published', 'Publish the profile before copying it.'],
  [/sa_profile_retired/, 409, 'retired', 'This profile is retired.'],
  [/sa_profile_not_found/, 404, 'not_found', 'Profile not found.'],
  [/sa_profile_invalid/, 400, 'invalid', 'The profile is not valid.'],
  [/sa_reason_required/, 400, 'reason_required', 'A reason of at least 10 characters is required.'],
  [/sa_authorization_required|sa_actor_inactive|sa_actor_required/, 403, 'forbidden', 'Forbidden'],
]
const isMissing = (e: any) => ['PGRST202', '42883'].includes(String(e?.code)) || /could not find the function|does not exist/i.test(String(e?.message || ''))

export const PROFILES_MIGRATION_MISSING = fail(409, 'profiles_migration_missing',
  'Access Profile management needs the database migration 20261005110000_sa_access_profiles.sql, which has not been applied in this environment yet. Existing roles stay readable.')

export function mapProfileError(error: any): ProfileFailure {
  if (isMissing(error)) return PROFILES_MIGRATION_MISSING
  const message = String(error?.message || '')
  for (const [pattern, status, code, text] of ERRORS) if (pattern.test(message)) return fail(status, code, text)
  console.error('[security-access] profile action failed', { code: error?.code })
  return fail(400, 'failed', 'The profile change could not be completed. Nothing was changed.')
}

export async function runProfileAction(admin: any, actorId: string, input: ProfileAction): Promise<{ ok: true; value: any } | ProfileFailure> {
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await admin.rpc(fn, { p_actor: actorId, ...args })
    return error ? mapProfileError(error) : ({ ok: true as const, value: data })
  }
  switch (input.action) {
    case 'create': return call('sa_create_access_profile', { p_role_key: input.roleKey, p_name: input.name, p_description: input.description, p_account_types: input.accountTypes, p_org_types: input.orgTypes, p_permission_keys: input.permissionKeys })
    case 'copy': return call('sa_copy_access_profile', { p_source: input.sourceId, p_role_key: input.roleKey, p_name: input.name, p_reason: input.reason })
    case 'save_draft': return call('sa_save_profile_draft', { p_role: input.roleId, p_name: input.name, p_description: input.description, p_account_types: input.accountTypes, p_org_types: input.orgTypes, p_permission_keys: input.permissionKeys })
    case 'submit': return call('sa_submit_profile_draft', { p_role: input.roleId })
    case 'discard': return call('sa_discard_profile_draft', { p_role: input.roleId, p_reason: input.reason })
    case 'preview': return call('sa_profile_publish_preview', { p_role: input.roleId })
    case 'publish': return call('sa_publish_profile_draft', { p_role: input.roleId, p_reason: input.reason, p_impact_hash: input.impactHash })
    case 'retire': return call('sa_retire_access_profile', { p_role: input.roleId, p_reason: input.reason })
    case 'holders': return call('sa_profile_holders', { p_role: input.roleId })
  }
}

export interface ProfileSummary {
  id: string; roleKey: string; name: string; description: string | null; kind: ProfileKind; status: string; version: number
  accountTypes: string[]; orgTypes: string[]; copiedFromId: string | null; permissionKeys: string[]
  holders: number; visibleHolders: number
  draft: null | { id: string; status: 'draft' | 'in_review'; name: string; description: string | null; accountTypes: string[]; orgTypes: string[]; permissionKeys: string[]; submittedBy: string | null; updatedAt: string }
}

/** Profiles, drafts and holder counts. Falls back to the base columns when the migration is not applied. */
export async function loadProfiles(admin: any, actorId: string): Promise<{ ok: true; value: { migrationReady: boolean; profiles: ProfileSummary[] } } | ProfileFailure> {
  const base = 'id,role_key,name,description,source,status,version,permissions:sa_business_role_permissions(permission:sa_permissions(permission_key))'
  const full = await admin.from('sa_business_roles').select(`${base},applicable_account_types,applicable_org_types,copied_from_role_id`).order('name')
  const migrationReady = !full.error
  const roles = migrationReady ? full : await admin.from('sa_business_roles').select(base).order('name')
  if (roles.error) return fail(500, 'profiles_unavailable', 'Access Profiles could not be loaded.')
  let drafts: any[] = []
  let counts = new Map<string, { holders: number; visible: number }>()
  if (migrationReady) {
    const [d, c] = await Promise.all([
      admin.from('sa_access_profile_drafts').select('id,role_id,status,name,description,applicable_account_types,applicable_org_types,permission_keys,submitted_by,updated_at').in('status', ['draft', 'in_review']),
      admin.rpc('sa_profile_holder_counts', { p_actor: actorId }),
    ])
    if (c.error && !isMissing(c.error)) return mapProfileError(c.error)
    drafts = d.error ? [] : d.data || []
    counts = new Map((c.data || []).map((r: any) => [r.role_id, { holders: Number(r.holders), visible: Number(r.visible_holders) }]))
  }
  const draftByRole = new Map<string, any>(drafts.map(d => [d.role_id, d]))
  const profiles: ProfileSummary[] = (roles.data || []).map((r: any) => {
    const d = draftByRole.get(r.id)
    const c = counts.get(r.id)
    return {
      id: r.id, roleKey: r.role_key, name: r.name, description: r.description ?? null, kind: profileKind(r), status: r.status, version: r.version,
      accountTypes: r.applicable_account_types ?? [], orgTypes: r.applicable_org_types ?? [], copiedFromId: r.copied_from_role_id ?? null,
      permissionKeys: (r.permissions || []).map((p: any) => p?.permission?.permission_key).filter(Boolean).sort(),
      holders: c?.holders ?? 0, visibleHolders: c?.visible ?? 0,
      draft: d ? { id: d.id, status: d.status, name: d.name, description: d.description ?? null, accountTypes: d.applicable_account_types ?? [], orgTypes: d.applicable_org_types ?? [], permissionKeys: d.permission_keys ?? [], submittedBy: d.submitted_by ?? null, updatedAt: d.updated_at } : null,
    }
  })
  return { ok: true, value: { migrationReady, profiles } }
}

// ── Permission picker: module → functional area → operation (navigation only) ──

export interface PickerArea { id: string; name: string; permissions: Array<{ key: string; label: string; description?: string }> }
export interface PickerModule { id: string; name: string; areas: PickerArea[]; total: number }

/**
 * Module → functional area → operation, from the shared taxonomy (modules.ts).
 * Selecting is always per operation: a module or area never implies its
 * permissions, and permissions added to the catalogue later are not selected.
 */
export function buildPermissionPicker(permissions: Array<{ permission_key: string; description?: string | null }>): PickerModule[] {
  return groupByTaxonomy(permissions, p => p.permission_key).map(m => ({
    id: m.id, name: m.name, total: m.total,
    areas: m.areas.map(a => ({
      id: a.id, name: a.name,
      permissions: a.items.map(p => ({ key: p.permission_key, label: permissionLabel(p.permission_key).label, description: p.description ?? undefined })).sort((x, y) => x.label.localeCompare(y.label)),
    })),
  }))
}

/** Permissions a partner-applicable profile may not hold (mirror of sa_permission_forbidden_for_partner). */
export const isForbiddenForPartner = (key: string) => /^(hr\.|security\.|platform\.user\.|platform\.data\.|finance\.data\.)/.test(key)
/** Administrative / destructive permissions (mirror of sa_permission_is_sensitive). */
export const isSensitivePermission = (key: string) => key.startsWith('security.') || ['hr.data.reset', 'platform.data.destructive', 'finance.data.reset'].includes(key)
