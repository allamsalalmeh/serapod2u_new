import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { authorizeOperation, organizationResource } from '@/lib/security-access/operation'

/**
 * Event Management authorization (Strategy B — parent gate only).
 *
 * Reuses the existing Marketing parent gate `marketing.module.view` exactly as
 * `getMarketingPageContext()` does in `app/src/app/marketing/_lib.ts`:
 *   - the resource is `organizationResource('marketing_module', orgId)` with
 *     the org id derived server-side (never from the request),
 *   - the legacy evaluator is the historical page rule (HQ org type, role
 *     level <= 30).
 *
 * There are no `event.*` permissions in this phase. The returned org id is the
 * caller's own organization; every DB read/write in the event routes must
 * filter by it explicitly (service role bypasses RLS, so RLS is not an org
 * boundary here).
 */

export interface EventManagementAccess {
  allowed: boolean
  orgId: string | null
  orgType: string | null
  roleLevel: number | null
}

const roleLevel = (relation: any): number | null =>
  Number(Array.isArray(relation) ? relation[0]?.role_level : relation?.role_level) || null

export async function authorizeEventManagement(userId: string): Promise<EventManagementAccess> {
  const admin = createAdminClient() as any
  const { data: profile, error } = await admin
    .from('users')
    .select(`id, organization_id, organizations:organization_id(org_type_code), roles:role_code(role_level)`)
    .eq('id', userId)
    .maybeSingle()

  if (error || !profile) return { allowed: false, orgId: null, orgType: null, roleLevel: null }

  const organization = Array.isArray(profile.organizations) ? profile.organizations[0] : profile.organizations
  const roles = Array.isArray(profile.roles) ? profile.roles[0] : profile.roles
  const orgId: string | null = profile.organization_id ?? organization?.id ?? null
  if (!orgId) return { allowed: false, orgId: null, orgType: null, roleLevel: null }

  const orgType: string | null = organization?.org_type_code ?? null
  const level: number | null = roleLevel(roles)
  const legacyLevel = level ?? 999

  const allowed = await authorizeOperation({
    actorId: userId,
    permission: 'marketing.module.view',
    resource: organizationResource('marketing_module', orgId),
    legacy: () => orgType === 'HQ' && legacyLevel <= 30,
  })
    .then((d) => d.decision === 'ALLOW')
    .catch(() => false)

  return { allowed, orgId, orgType, roleLevel: legacyLevel }
}
