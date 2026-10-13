import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkPermissionForUser } from '@/lib/server/permissions'

/**
 * Delegated Security & Access administration (opt-in).
 *
 * While a security.* permission is still on a legacy migration mode, the legacy rule decides and that rule is the
 * central Super Admin (manage_authorization). With the S&A setting `security_access.delegated_administration`
 * switched on, an explicit, in-scope Security & Access assignment ALSO satisfies the legacy evaluator — a union,
 * never narrower than today. Off by default; nothing changes until an administrator turns it on.
 *
 * This only widens the application's legacy evaluator; the database functions re-check the actor with the same rule
 * (sa_assert_actor_permission) and bound what a delegated administrator can grant (sa_grant_beyond_authority etc.).
 */
export const DELEGATED_ADMINISTRATION_SETTING = 'security_access.delegated_administration'

export async function delegatedAdministrationEnabled(admin: any = createAdminClient()): Promise<boolean> {
  try {
    const { data, error } = await admin.from('sa_settings').select('setting_value').eq('setting_key', DELEGATED_ADMINISTRATION_SETTING).maybeSingle()
    return !error && data?.setting_value === true
  } catch {
    return false
  }
}

/** The legacy rule for S&A administration, extended with the opt-in explicit-assignment path. Any failure denies. */
export async function legacyOrDelegatedSecurityAccess(userId: string, organizationId: string | null | undefined, permission: string): Promise<boolean> {
  if ((await checkPermissionForUser(userId, 'manage_authorization')).allowed) return true
  if (!permission.startsWith('security.') || !organizationId) return false
  const admin = createAdminClient() as any
  if (!(await delegatedAdministrationEnabled(admin))) return false
  try {
    const { data, error } = await admin.rpc('sa_actor_has_permission', { p_actor: userId, p_permission: permission, p_context: { organization_id: organizationId } })
    return !error && data === true
  } catch {
    return false
  }
}
