import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { actorAlsoHolds, requireSecurityActor, requireSelfServiceActor } from '@/lib/security-access/admin-api'
import { loadScopeChoices } from '@/lib/security-access/scope-grant'

export const dynamic = 'force-dynamic'

const query = z.object({ organizationId: z.string().uuid(), purpose: z.enum(['grant', 'request']).default('grant') })

/**
 * GET /api/security-access/scope-choices?organizationId=&purpose=grant|request
 *
 * The scopes offered for a person whose membership is in this organization: the shared canonical choices (an HQ offers
 * itself and its own warehouses only).
 *   purpose=grant   (default) — security.role.assign; limited to organizations where the administrator holds the grant
 *                   authority, so a warehouse-only administrator is never shown the broader HQ scope.
 *   purpose=request — an access request names a scope but does not grant it; the requester needs no grant authority (the
 *                   approver decides), only visibility of the organization (their own membership or security.access.view).
 * Read-only. POST /assignments and POST /access-requests re-validate every submission with the same rules, so this list
 * never grants anything.
 */
export async function GET(request: NextRequest) {
  const parsed = query.safeParse({
    organizationId: request.nextUrl.searchParams.get('organizationId'),
    purpose: request.nextUrl.searchParams.get('purpose') ?? undefined,
  })
  if (!parsed.success) return NextResponse.json({ error: 'Invalid organization' }, { status: 400 })
  const { organizationId, purpose } = parsed.data

  let admin: any
  let authorityFor: string | null = null
  if (purpose === 'grant') {
    const actor = await requireSecurityActor('security.role.assign')
    if (actor instanceof NextResponse) return actor
    admin = actor.admin
    authorityFor = actor.userId
  } else {
    const actor = await requireSelfServiceActor()
    if (actor instanceof NextResponse) return actor
    admin = actor.admin
    const { data: own } = await admin.from('sa_organization_memberships').select('id').eq('user_id', actor.userId).eq('organization_id', organizationId).eq('status', 'active').limit(1)
    if (!(own && own.length) && !(await actorAlsoHolds(actor, 'security.access.view'))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  try {
    const loaded = await loadScopeChoices(admin, organizationId, authorityFor)
    if (!loaded) return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
    return NextResponse.json({
      organization: loaded.organization,
      orgNames: loaded.orgNames,
      choices: loaded.choices.map(c => ({ id: c.scopeId, organization_id: c.targetOrganizationId, scope_type: c.scopeType, display_name: c.name, kind: c.kind, label: c.label, coverage: c.coverage })),
    })
  } catch {
    return NextResponse.json({ error: 'The scope choices could not be loaded.' }, { status: 503 })
  }
}
