import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkPermissionForUser } from '@/lib/server/permissions'
import { isCanonicalStaff } from '@/lib/identity/staff'

/**
 * The Finance module entry's historical rule (finance.module.view while it is LEGACY_ENFORCED/SHADOW): the role
 * permission `view_settings`, or active internal staff at role level 40 or above in privilege. ONE definition, used by
 * the /finance page guards and the navigation snapshot, so the sidebar and the page always agree. Never consulted once
 * the permission is NEW_ENFORCED/LEGACY_RETIRED (S&A alone decides then).
 */
export async function legacyFinanceModuleEntry(userId: string): Promise<boolean> {
  const [viewSettings, profile] = await Promise.all([
    checkPermissionForUser(userId, 'view_settings'),
    (createAdminClient() as any)
      .from('users')
      .select('principal_type, is_active, account_status, roles:role_code(role_level)')
      .eq('id', userId)
      .maybeSingle()
      .then((r: any) => {
        if (r.error) throw new Error('finance_legacy_profile_unavailable')
        return r.data
      }),
  ])
  if (viewSettings.allowed) return true
  const role = Array.isArray(profile?.roles) ? profile.roles[0] : profile?.roles
  return isCanonicalStaff(profile, role?.role_level, 40)
}
