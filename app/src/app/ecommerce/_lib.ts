import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { navActorFromProfile, resolveDestinationAccess } from '@/lib/server/nav-access'

/**
 * Server-only context helper for E-commerce pages.
 * Mirrors the CRM pattern in src/app/crm/_lib.ts.
 *
 * E-commerce is accessible to HQ org type (maxRoleLevel ≤ 30).
 */
export async function getEcommercePageContext() {
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

    // Module entry is the canonical Security & Access decision for the 'ecommerce' destination (see nav-access.ts), in
    // the user's own organization. A failed check is reported as such, not as a denial.
    const access = await resolveDestinationAccess(navActorFromProfile(transformedUserProfile), 'ecommerce')
    const canViewEcommerce = access.state === 'allowed'

    return { user, userProfile: transformedUserProfile, canViewEcommerce, accessState: access.state }
}
