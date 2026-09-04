/**
 * Viewer scope for the SMS and Email delivery monitors.
 *
 * Both monitors used to build one org filter from "my org + every active HQ +
 * every org owning a provider config" and applied it to every viewer. That
 * failed in both directions: HQ staff never saw rows stamped with a shop's org
 * (password reset OTPs are logged against the account's org), while a shop
 * org_admin was handed HQ's traffic.
 */

export type MonitorViewer = {
  organizationId: string | null
  orgTypeCode: string | null
  roleCode: string | null
  roleLevel: number | null
}

export type MonitorScope =
  | { kind: 'all' }
  | { kind: 'orgs'; orgIds: string[] }

const MONITOR_ROLE_CODES = ['super_admin', 'admin', 'org_admin']
const GLOBAL_ROLE_CODES = ['super_admin', 'admin']

export function canViewMonitor(viewer: MonitorViewer): boolean {
  // A missing level must not become 0 via Number(null); that granted access to
  // any account whose role row had no level.
  const roleLevel = viewer.roleLevel == null ? NaN : Number(viewer.roleLevel)
  const roleCode = String(viewer.roleCode || '')
  if (roleLevel <= 20 || MONITOR_ROLE_CODES.includes(roleCode)) return true
  return viewer.orgTypeCode === 'HQ' && roleLevel > 0 && roleLevel <= 40
}

/**
 * HQ staff and platform admins oversee every organization. Everyone else is
 * limited to their own organization, and a viewer without one resolves to an
 * empty list so callers fail closed instead of falling back to "no filter".
 */
export function resolveMonitorScope(viewer: MonitorViewer): MonitorScope {
  if (viewer.orgTypeCode === 'HQ') return { kind: 'all' }
  if (GLOBAL_ROLE_CODES.includes(String(viewer.roleCode || ''))) return { kind: 'all' }
  return { kind: 'orgs', orgIds: viewer.organizationId ? [viewer.organizationId] : [] }
}

export async function loadMonitorViewer(supabase: any, userId: string): Promise<MonitorViewer | null> {
  const { data } = await supabase
    .from('users')
    .select('organization_id, roles:role_code(role_level, role_code), organizations:organization_id(org_type_code)')
    .eq('id', userId)
    .single()

  if (!data) return null

  const role = Array.isArray(data.roles) ? data.roles[0] : data.roles
  const org = Array.isArray(data.organizations) ? data.organizations[0] : data.organizations

  return {
    organizationId: data.organization_id || null,
    orgTypeCode: org?.org_type_code || null,
    roleCode: role?.role_code || null,
    roleLevel: role?.role_level ?? null,
  }
}
