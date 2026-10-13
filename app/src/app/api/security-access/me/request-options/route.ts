import { NextResponse } from 'next/server'
import { requireSelfServiceActor } from '@/lib/security-access/admin-api'
import { loadScopeChoices } from '@/lib/security-access/scope-grant'

export const dynamic = 'force-dynamic'

/**
 * GET /api/security-access/me/request-options
 *
 * What the caller may ask for in a self-service access request: their active
 * business memberships, the scopes inside those organizations, the requestable
 * business roles (active, never legacy compatibility roles or the employee
 * baseline) and the roles they already hold. Read-only; submitting and
 * deciding are re-checked by sa_submit_access_request / sa_decide_access_request.
 */
export async function GET() {
  const actor = await requireSelfServiceActor()
  if (actor instanceof NextResponse) return actor
  const admin = actor.admin
  const { data: memberships, error } = await admin.from('sa_organization_memberships')
    .select('id, organization_id, organization:organizations(org_name), assignments:sa_role_assignments!sa_role_assignments_membership_id_fkey(role_id, status, effective_until)')
    .eq('user_id', actor.userId).eq('status', 'active')
  if (error) return NextResponse.json({ error: 'Unable to load request options' }, { status: 500 })
  const orgIds = (memberships || []).map((m: any) => m.organization_id)
  // The same canonical choices the grant forms offer (an HQ membership: the HQ and its own warehouses only). The requester holds no
  // grant authority, so none is filtered here; the approver's decision and the database apply it.
  let scopes: any[] = []
  try {
    for (const orgId of orgIds) {
      const loaded = await loadScopeChoices(admin, orgId, null)
      for (const c of loaded?.choices ?? []) {
        scopes.push({ id: c.scopeId, organization_id: c.targetOrganizationId, membership_organization_id: orgId, scope_type: c.scopeType, display_name: c.name, kind: c.kind, label: c.label, coverage: c.coverage })
      }
    }
  } catch {
    return NextResponse.json({ error: 'Unable to load request options' }, { status: 500 })
  }
  const { data: roles } = await admin.from('sa_business_roles').select('id, name, description')
    .eq('status', 'active').neq('source', 'legacy').neq('role_key', 'employee-self-service').order('name')
  const now = Date.now()
  return NextResponse.json({
    memberships: (memberships || []).map((m: any) => ({
      organizationId: m.organization_id,
      organizationName: (Array.isArray(m.organization) ? m.organization[0] : m.organization)?.org_name ?? 'Organization',
      heldRoleIds: (m.assignments || [])
        .filter((a: any) => a.status === 'active' && !(a.effective_until && new Date(a.effective_until).getTime() <= now))
        .map((a: any) => a.role_id),
    })),
    scopes,
    roles: roles || [],
  })
}
