import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertDestructiveOpsAllowed } from '@/lib/server/destructive-ops-guard'
import { authorizeOrganizationIdentityRemoval } from '@/lib/identity/removal-authorization'

export const dynamic = 'force-dynamic'

/**
 * POST /api/organizations/delete
 * Hard-delete an organization via the service_role client.
 * Protected by the destructive-ops-guard (env gate + auth + Super Admin check).
 */
export async function POST(request: NextRequest) {
    const guard = await assertDestructiveOpsAllowed(request, 'hard-delete-organization')
    if (guard.blocked) return guard.response

    const body = await request.json()
    const { orgId } = body

    if (!orgId || typeof orgId !== 'string') {
        return NextResponse.json({ error: 'orgId is required' }, { status: 400 })
    }

    // Member identities are deleted with the organization: each one must be
    // removable by this administrator (Archive Identities, target protection).
    if (!guard.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const memberRemoval = await authorizeOrganizationIdentityRemoval(guard.userId, orgId)
    if (!memberRemoval.ok) {
        return NextResponse.json({ error: memberRemoval.error, code: memberRemoval.code }, { status: memberRemoval.status })
    }

    const admin = createAdminClient()

    console.log(`🗑️ Super Admin ${guard.userEmail} hard-deleting organization ${orgId}`)

    const { data, error } = await admin.rpc('hard_delete_organization', { p_org_id: orgId })

    if (error) {
        console.error('hard_delete_organization RPC error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json(data)
}
