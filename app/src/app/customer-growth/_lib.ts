import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { navActorFromProfile, resolveCustomerGrowthLandingAccess } from '@/lib/server/nav-access'

/**
 * Server-only context helper for Customer & Growth pages.
 * Mirrors the Supply Chain pattern in src/app/supply-chain/_lib.ts.
 *
 * Customer & Growth is a domain grouping: visible to people who can open at least one of its child modules.
 */
export async function getCustomerGrowthPageContext() {
    const supabase = await createClient()

    const { data: { user }, error } = await supabase.auth.getUser()
    if (error || !user) redirect('/login')

    const { data: userProfile, error: userProfileError } = await supabase
        .from('users')
        .select(`
      *,
      organizations:organization_id (
        id,
        org_name,
        org_type_code,
        org_code
      ),
      roles:role_code (
        role_name,
        role_level
      )
    `)
        .eq('id', user.id)
        .single()

    if (userProfileError || !userProfile) redirect('/login')

    const organization = Array.isArray(userProfile.organizations)
        ? userProfile.organizations[0]
        : userProfile.organizations
    const roles = Array.isArray(userProfile.roles)
        ? userProfile.roles[0]
        : userProfile.roles
    const organizationId = userProfile.organization_id ?? organization?.id ?? null

    if (!organizationId) redirect('/login')

    const transformedUserProfile = {
        ...userProfile,
        organization_id: organizationId,
        organizations: organization,
        roles
    }

    // The domain landing is reachable only when at least one child destination is (see nav-access.ts): a parent never
    // opens without an accessible destination of its own (the shared Product Catalog alone counts only without Supply Chain work). Each child module, route and API still decides for itself.
    const access = await resolveCustomerGrowthLandingAccess(navActorFromProfile(transformedUserProfile))
    const canViewCustomerGrowth = access.state === 'allowed'

    return { user, userProfile: transformedUserProfile, canViewCustomerGrowth, accessState: access.state }
}
