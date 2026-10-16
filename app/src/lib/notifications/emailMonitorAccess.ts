import { isCanonicalStaff } from '@/lib/identity/staff'
import { userAllowed } from '@/lib/security-access/operation'

/** Who may view the Email delivery monitor (shared by its endpoints). */
export async function canViewEmailMonitor(supabase: any, userId: string) {
  // The delivery monitors are an S&A decision (platform.notification_monitor.view);
  // the historical canonical-staff rule below is the legacy evaluator.
  return userAllowed(userId, 'platform.notification_monitor.view', () => legacyCanViewEmailMonitor(supabase, userId))
}

async function legacyCanViewEmailMonitor(supabase: any, userId: string) {
  const { data } = await supabase
    .from('users')
    .select('organization_id, is_active, account_status, principal_type, roles:role_code(role_level, role_code), organizations:organization_id(org_type_code)')
    .eq('id', userId)
    .single()

  const role = Array.isArray(data?.roles) ? data.roles[0] : data?.roles
  const org = Array.isArray(data?.organizations) ? data.organizations[0] : data?.organizations
  const roleLevel = Number(role?.role_level)
  const roleCode = String(role?.role_code || '')
  // Only canonical internal staff; the legacy level is a ceiling, not proof.
  if (!isCanonicalStaff(data, roleLevel, 40)) return false
  if (roleLevel <= 20 || ['super_admin', 'admin', 'org_admin'].includes(roleCode)) return true
  return org?.org_type_code === 'HQ'
}
