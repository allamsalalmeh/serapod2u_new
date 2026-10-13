import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { navActorFromProfile, resolveDestinationAccess } from '@/lib/server/nav-access'

/**
 * Server-only context helper for Loyalty (Consumer Engagement) pages.
 * Mirrors the Supply Chain pattern in src/app/supply-chain/_lib.ts.
 *
 * Loyalty is accessible to HQ, SHOP, and INDEPENDENT org types.
 * Individual sub-sections handle their own permission checks.
 */
export async function getLoyaltyPageContext() {
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

    // Module entry is the canonical Security & Access decision for the 'loyalty' destination (see nav-access.ts), in
    // the user's own organization. A failed check is reported as such, not as a denial.
    const access = await resolveDestinationAccess(navActorFromProfile(transformedUserProfile), 'loyalty')
    const canViewLoyalty = access.state === 'allowed'

    return { user, userProfile: transformedUserProfile, canViewLoyalty, accessState: access.state }
}
