import 'server-only'
import { createElement, type ReactElement } from 'react'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import AccessState from '@/components/access/AccessState'
import { loadNavActor, resolveDestinationAccess, type DestinationAccess, type NavActor } from '@/lib/server/nav-access'

export const HR_WORKSPACE_HREF = '/hr/my-workspace'

/**
 * Where "back" goes from a denied HR page: My Workspace when the person holds Employee Self-Service, otherwise the
 * dashboard. Decided only after a denial, with the same canonical evaluation.
 */
async function homeFor(actor: NavActor) {
    const workspace = await resolveDestinationAccess(actor, 'hr/my-workspace')
    return workspace.state === 'allowed'
        ? { homeHref: HR_WORKSPACE_HREF, homeLabel: 'Back to My Workspace' }
        : { homeHref: '/dashboard', homeLabel: 'Back to Dashboard' }
}

/**
 * Server context for every desktop HR page.
 *
 * `destination` is the HR destination id (see HR_DESTINATIONS) or an ordered list of them (first allowed wins, e.g.
 * the administrative chart before the staff chart). Access is decided per destination by the canonical Security &
 * Access evaluation, not by a blanket "HR administrator" rule: Employee Self-Service destinations carry their own
 * permission, administrative ones need the module entry plus their own permission.
 *
 * `gate` is a ready-to-return access state (denied / temporarily unavailable) that loads no protected data; when it is
 * null the page may render. `access.destination` tells which of several destinations matched. An expired login
 * redirects to /login and is never reported as a denial.
 */
export async function getHrPageContext(destination?: string | readonly string[]) {
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

    const actor: NavActor = {
        userId: user.id,
        organizationId,
        orgTypeCode: organization?.org_type_code ?? null,
        roleCode: userProfile.role_code ?? null,
        roleLevel: roles?.role_level ?? null,
    }

    let access: DestinationAccess = { state: 'allowed', destination: Array.isArray(destination) ? destination[0] : (destination as string | undefined) ?? '' }
    let gate: ReactElement | null = null
    if (destination !== undefined) {
        access = await resolveDestinationAccess(actor, destination as string | string[])
        if (access.state !== 'allowed') {
            // Diagnostics stay on the server; the person sees the ordinary state only.
            console.warn('[hr-access]', access.state, { userId: user.id, destination })
            gate = createElement(AccessState, {
                kind: access.state === 'unavailable' ? 'unavailable' : 'denied',
                ...(await homeFor(actor)),
            })
        }
    }

    return { user, userProfile: transformedUserProfile, actor, access, gate }
}
