import { z } from 'zod'
import { HUMAN_PRINCIPAL_TYPES } from '@/lib/identity/resolution'
import { loadRootAccess, withRootAccess } from './root-access'
import { withRestoreStatus } from './policy-restore'

/**
 * People & Access directory: server-side search, filter and pagination across
 * the organizations the administrator is authorized for. The authorized set
 * is decided in the database (sa_authorized_organizations) with the existing
 * S&A semantics; the browser can only narrow it (organization filter), and a
 * forged organization id is rejected by the database.
 *
 * Read-only: nothing here creates or changes users, memberships or
 * assignments, and only the fields the screen needs are returned (no
 * credentials, phone numbers, banking or HR data).
 */

export const DIRECTORY_FILTERS = ['all', 'granted', 'temporary', 'inactive', 'none'] as const
export type DirectoryFilter = (typeof DIRECTORY_FILTERS)[number]

/** User category = users.principal_type (the classification User Management/identity use), or UNCLASSIFIED when it is unknown. */
export const DIRECTORY_CATEGORIES = [...HUMAN_PRINCIPAL_TYPES, 'UNCLASSIFIED'] as const
export const DIRECTORY_ORG_TYPES = ['HQ', 'MFG', 'DIST', 'WH', 'SHOP'] as const
export const DIRECTORY_STATUSES = ['all', 'active', 'inactive'] as const
export const DIRECTORY_MEMBERSHIPS = ['all', 'has', 'none'] as const

export const directoryQuerySchema = z.object({
  category: z.enum(DIRECTORY_CATEGORIES).optional(),
  orgType: z.enum(DIRECTORY_ORG_TYPES).optional(),
  status: z.enum(DIRECTORY_STATUSES).optional().default('all'),
  membership: z.enum(DIRECTORY_MEMBERSHIPS).optional().default('all'),
  q: z.string().trim().max(100).optional().default(''),
  org: z.string().uuid().optional(),
  filter: z.enum(DIRECTORY_FILTERS).optional().default('all'),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional().default(0),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
})
export type DirectoryQuery = z.infer<typeof directoryQuerySchema>

export type DirectoryFailure = { ok: false; status: number; code: string; error: string }
const fail = (status: number, code: string, error: string): DirectoryFailure => ({ ok: false, status, code, error })

const isMissingFunction = (error: any) =>
  ['PGRST202', '42883'].includes(String(error?.code)) || /could not find the function|does not exist/i.test(String(error?.message || ''))

export function mapDirectoryError(error: any): DirectoryFailure {
  const message = String(error?.message || '')
  if (isMissingFunction(error)) {
    return fail(409, 'directory_migration_missing', 'Searching all authorized organizations needs the database migration 20261005100000_sa_directory_visibility.sql, which has not been applied here yet.')
  }
  if (/sa_directory_org_forbidden/.test(message)) return fail(403, 'org_forbidden', 'You are not authorized to view that organization.')
  if (/sa_authorization_required|sa_actor_inactive|sa_actor_required/.test(message)) return fail(403, 'forbidden', 'Forbidden')
  if (/sa_directory_filter_invalid/.test(message)) return fail(400, 'invalid_request', 'Invalid filter.')
  console.error('[security-access] directory failed', { code: error?.code })
  return fail(500, 'directory_failed', 'The directory could not be loaded.')
}

const PERSON_SELECT = [
  'id', 'full_name', 'email', 'role_code', 'is_active', 'organization_id', 'principal_type', 'account_status',
  'organization:organizations!fk_users_organization(org_name,org_type_code)',
  'membership:sa_organization_memberships!sa_organization_memberships_user_id_fkey(id,status,is_primary,membership_type,organization_id,organization:organizations(org_name,org_type_code),assignments:sa_role_assignments!sa_role_assignments_membership_id_fkey(id,status,source,effective_from,effective_until,assignment_reason,role:sa_business_roles(id,role_key,name,source),scopes:sa_assignment_scopes(scope:sa_scope_definitions(id,scope_type,scope_value,display_name))))',
].join(',')

export interface DirectoryResult {
  people: any[]
  /** False when the restore status of revoked grants could not be read (migration not applied): no Restore is offered. */
  restoreAvailable: boolean
  total: number
  counts: { all: number; granted: number; temporary: number; inactive: number; none: number }
  organizations: Array<{ id: string; org_name: string; org_type_code: string; parent_org_id: string | null; people_count: number }>
  query: DirectoryQuery
}

export async function loadDirectory(admin: any, actorId: string, query: DirectoryQuery): Promise<{ ok: true; value: DirectoryResult } | DirectoryFailure> {
  const filtered = Boolean(query.category || query.orgType) || query.status !== 'all' || query.membership !== 'all'
  const base = { p_actor: actorId, p_org: query.org ?? null, p_search: query.q || null, p_filter: query.filter, p_limit: query.limit, p_offset: query.offset }
  // Filters are applied by the database before pagination, inside the authorized scope (they can only narrow it).
  let page = await admin.rpc('sa_directory_page_v2', {
    ...base, p_category: query.category ?? null, p_org_type: query.orgType ?? null, p_status: query.status, p_membership: query.membership,
  })
  if (page.error && isMissingFunction(page.error)) {
    if (filtered) return fail(409, 'directory_filters_migration_missing', 'These filters need the database migration 20261007100000_sa_directory_filters.sql, which has not been applied here yet.')
    page = await admin.rpc('sa_directory_page', base)
  }
  if (page.error) return mapDirectoryError(page.error)
  const ids: string[] = page.data?.ids ?? []

  const [orgs, rows, visible, root] = await Promise.all([
    admin.rpc('sa_directory_organizations', { p_actor: actorId }),
    ids.length ? admin.from('users').select(PERSON_SELECT).in('id', ids) : Promise.resolve({ data: [], error: null }),
    ids.length ? admin.rpc('sa_directory_visible_memberships', { p_actor: actorId, p_user_ids: ids }) : Promise.resolve({ data: [], error: null }),
    // Root Access badge (active grants only). Display only; an unreadable status shows no badge.
    loadRootAccess(admin, ids),
  ])
  if (orgs.error) return mapDirectoryError(orgs.error)
  if (rows.error) return fail(500, 'directory_failed', 'The directory could not be loaded.')
  if (visible.error) return mapDirectoryError(visible.error)

  // Only memberships in organizations the actor may see are returned, each with
  // its own grant eligibility (viewing never implies the right to grant).
  const visibleById = new Map<string, any>((visible.data || []).map((v: any) => [v.membership_id, v]))
  const byId = new Map<string, any>((rows.data || []).map((u: any) => [u.id, u]))
  const visiblePeople = withRootAccess(ids.map(id => byId.get(id)).filter(Boolean), root.byUser).map((u: any) => ({
    ...u,
    membership: (u.membership || []).filter((m: any) => visibleById.has(m.id)).map((m: any) => {
      const v = visibleById.get(m.id)
      return { ...m, grantable: Boolean(v.grantable), grant_blocked_reason: v.blocked_reason ?? null }
    }),
  }))
  // Restore status of revoked administrator grants (Access history). Display only; the restore re-checks everything.
  const { people, available: restoreAvailable } = await withRestoreStatus(admin, visiblePeople)
  return {
    ok: true,
    value: {
      people, restoreAvailable, total: Number(page.data?.total ?? 0),
      counts: { all: 0, granted: 0, temporary: 0, inactive: 0, none: 0, ...(page.data?.counts ?? {}) },
      organizations: orgs.data || [], query,
    },
  }
}

// ── One person (Edit User → Group Policies) ──────────────────────────────

/** Same read model as the directory plus the membership source (derived memberships follow the person's organization). */
const PERSON_ACCESS_SELECT = PERSON_SELECT.replace('membership_type,organization_id', 'membership_type,source,organization_id')

/**
 * One person's memberships and assignments, limited to the memberships in organizations this administrator may see
 * (sa_directory_visible_memberships, the directory's own rule) with each membership's grant eligibility. Read-only;
 * viewing never implies the right to grant.
 */
export async function loadPersonAccess(admin: any, actorId: string, userId: string): Promise<{ ok: true; value: { person: any } } | DirectoryFailure> {
  const [row, visible, root] = await Promise.all([
    admin.from('users').select(PERSON_ACCESS_SELECT).eq('id', userId).maybeSingle(),
    admin.rpc('sa_directory_visible_memberships', { p_actor: actorId, p_user_ids: [userId] }),
    loadRootAccess(admin, [userId]),
  ])
  if (visible.error) return mapDirectoryError(visible.error)
  if (row.error) return fail(500, 'directory_failed', 'The person could not be loaded.')
  if (!row.data) return fail(404, 'not_found', 'Person not found.')
  const visibleById = new Map<string, any>((visible.data || []).map((v: any) => [v.membership_id, v]))
  const visiblePerson = {
    ...row.data,
    root_access: root.byUser.get(userId) ?? null,
    membership: (row.data.membership || []).filter((m: any) => visibleById.has(m.id)).map((m: any) => {
      const v = visibleById.get(m.id)
      return { ...m, grantable: Boolean(v.grantable), grant_blocked_reason: v.blocked_reason ?? null }
    }),
  }
  const { people: [person] } = await withRestoreStatus(admin, [visiblePerson])
  return { ok: true, value: { person } }
}
