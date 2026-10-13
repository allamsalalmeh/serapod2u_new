import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { navActorFromProfile, resolveDestinationAccess } from '@/lib/server/nav-access'

export async function getRoadtourPageContext() {
    const supabase = await createClient()
    const { data: { user }, error } = await supabase.auth.getUser()
    if (error || !user) redirect('/login')

    const { data: userProfile, error: userProfileError } = await supabase
        .from('users')
        .select(`*, organizations:organization_id (id, org_name, org_type_code, org_code), roles:role_code (role_name, role_level)`)
        .eq('id', user.id)
        .single()

    if (userProfileError || !userProfile) redirect('/login')

    const organization = Array.isArray(userProfile.organizations) ? userProfile.organizations[0] : userProfile.organizations
    const roles = Array.isArray(userProfile.roles) ? userProfile.roles[0] : userProfile.roles
    const organizationId = userProfile.organization_id ?? organization?.id ?? null
    if (!organizationId) redirect('/login')

    const transformedUserProfile = { ...userProfile, organization_id: organizationId, organizations: organization, roles }
    // RoadTour pages need a RoadTour permission (any of campaign / visit / report / KPI management). Every RoadTour API
    // keeps its own check; this decides whether the screens open at all.
    const access = await resolveDestinationAccess(navActorFromProfile(transformedUserProfile), 'roadtour')
    return { user, userProfile: transformedUserProfile, canViewRoadtour: access.state === 'allowed', accessState: access.state }
}
