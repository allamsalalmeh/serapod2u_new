import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { userAllowed } from '@/lib/security-access/operation'

export const MARKETPLACE_PERMISSION = 'ecommerce.order.manage'

type MarketplaceContext =
  | { error: NextResponse; db?: undefined; userId?: undefined; orgId?: undefined }
  | { error?: undefined; db: any; userId: string; orgId: string }

/**
 * Marketplace tables are only reachable through the service role, so every
 * route must pass this check first and scope every query by orgId.
 * Legacy evaluator matches Store Orders: HQ users with role level ≤ 30.
 */
export async function loadMarketplaceContext(): Promise<MarketplaceContext> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const db = createAdminClient() as any
  const { data: profile } = await db
    .from('users')
    .select('id, organization_id, organizations!fk_users_organization(id, org_type_code), roles(role_level)')
    .eq('id', user.id)
    .single()
  if (!profile?.organization_id) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }

  const orgType = (profile.organizations as any)?.org_type_code
  const roleLevel = (profile.roles as any)?.role_level
  const allowed = await userAllowed(
    user.id,
    MARKETPLACE_PERMISSION,
    () => orgType === 'HQ' && roleLevel != null && roleLevel <= 30,
    { organizationId: profile.organization_id },
  )
  if (!allowed) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  return { db, userId: user.id, orgId: profile.organization_id as string }
}
