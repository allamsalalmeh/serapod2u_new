import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { legacyOrDelegatedSecurityAccess } from '@/lib/security-access/delegation'
import { authorizeOperation, organizationResource } from '@/lib/security-access/operation'
import { redirect } from 'next/navigation'

export async function getSecurityAccessContext() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  const { data: profile } = await supabase.from('users').select(`*,organizations:organization_id(id,org_name,org_type_code,org_code),roles:role_code(role_name,role_level)`).eq('id', user.id).single()
  if (!profile || !profile.is_active) redirect('/login')
  const organizations = Array.isArray(profile.organizations) ? profile.organizations[0] : profile.organizations
  const roles = Array.isArray(profile.roles) ? profile.roles[0] : profile.roles
  // Page entry is an S&A decision (security.access.view); the Wave 1
  // manage_authorization rule is the legacy evaluator (plus the opt-in delegated path).
  // Fail closed either way; an evaluation that could not run is reported as unavailable, not as a denial.
  const decision = await authorizeOperation({
    actorId: user.id,
    permission: 'security.access.view',
    resource: organizationResource('security_access', profile.organization_id),
    legacy: () => legacyOrDelegatedSecurityAccess(user.id, profile.organization_id, 'security.access.view'),
  }).catch(() => null)
  const allowed = decision?.decision === 'ALLOW' && !decision.unavailable
  const unavailable = !decision || Boolean(decision.unavailable)
  return { user, userProfile: { ...profile, organizations, roles }, allowed, unavailable }
}
