import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { navActorFromProfile, resolveDestinationAccess } from '@/lib/server/nav-access'

/**
 * Server-only context helper for Finance pages.
 * Mirrors the HR pattern in src/app/hr/_lib.ts.
 *
 * Returns the authenticated user profile and whether the user may open
 * `destination` (a Finance view id from FINANCE_DESTINATIONS; the landing by default).
 */
export async function getFinancePageContext(destination: string = 'finance') {
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

    // The same decision as the sidebar and the Finance top navigation: the destination table (nav-access.ts) evaluated
    // by the canonical S&A engine, in each permission's current migration mode, on the user's own company. The module
    // entry opens the landing page; a section also needs the permission its own APIs read with. The legacy rule of the
    // module entry is legacyFinanceModuleEntry (view_settings or staff at level 40), as before.
    const access = await resolveDestinationAccess(navActorFromProfile(transformedUserProfile), destination)
    const canViewFinance = access.state === 'allowed'

    return { user, userProfile: transformedUserProfile, canViewFinance, accessState: access.state }
}
