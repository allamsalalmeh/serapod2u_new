import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { navActorFromProfile, resolveDestinationAccess } from '@/lib/server/nav-access'
import { SUPPLY_CHAIN_MODULE_DESTINATION } from '@/lib/security-access/nav-access'

/**
 * Server-only context helper for Supply Chain pages.
 * Mirrors the Finance pattern in src/app/finance/_lib.ts.
 *
 * Returns the authenticated user profile and whether the user may open `destination` (a Supply Chain destination from
 * nav-access.ts: the module landing by default, or `supply-chain/<view>` from supplyChainDestinationForView).
 */
export async function getSupplyChainPageContext(destination: string = SUPPLY_CHAIN_MODULE_DESTINATION) {
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

    // The same decision as the sidebar, the landing cards and the top navigation: the destination table (nav-access.ts)
    // evaluated by the canonical S&A engine, in each permission's current migration mode, on the user's organization.
    // The module entry opens the landing; a view also needs the permission its own APIs and data read with. A revoked or
    // expired grant answers DENY on the next request (no cache across requests). Hiding is not authorization: every API,
    // RPC and RLS policy behind these pages decides again.
    const access = await resolveDestinationAccess(navActorFromProfile(transformedUserProfile), [SUPPLY_CHAIN_MODULE_DESTINATION])
    const viewAccess = access.state === 'allowed' && destination !== SUPPLY_CHAIN_MODULE_DESTINATION
        ? await resolveDestinationAccess(navActorFromProfile(transformedUserProfile), destination)
        : access
    const canViewSupplyChain = viewAccess.state === 'allowed'

    return { user, userProfile: transformedUserProfile, canViewSupplyChain, accessState: viewAccess.state }
}
