import { NextResponse } from 'next/server'
import { actorAlsoHolds, requireSecurityActor } from '@/lib/security-access/admin-api'
import { isEnforcementReady } from '@/lib/security-access/readiness'

export const dynamic = 'force-dynamic'

const DIRECTORY_ORG_TYPES = ['HQ', 'WH', 'DIST', 'MFG']

// Display-only lookups so administrators see names instead of UUIDs. Every
// query is read-only and optional: a failure leaves the page usable.
async function loadDirectory(admin: any, differenceDecisions: any[]) {
  const [recent, scopeOrgs] = await Promise.all([
    admin.from('sa_authorization_decisions').select('id,occurred_at,actor_id,permission_key,resource_type,resource_id,decision,reason_code,migration_mode,legacy_decision,new_decision,comparison,resolved_scopes,matched_assignments,correlation_id,policy_version').order('occurred_at', { ascending: false }).limit(100),
    admin.from('sa_scope_definitions').select('organization_id').not('organization_id', 'is', null),
  ])
  const scopeOrgIds = Array.from(new Set((scopeOrgs.data || []).map((s: any) => s.organization_id)))
  const orgFilter = `org_type_code.in.(${DIRECTORY_ORG_TYPES.join(',')})${scopeOrgIds.length ? `,id.in.(${scopeOrgIds.join(',')})` : ''}`
  const recentDecisions = recent.error ? [] : recent.data || []
  const actorIds = Array.from(new Set([...recentDecisions, ...differenceDecisions].map((d: any) => d.actor_id).filter(Boolean)))
  const [organizations, actors] = await Promise.all([
    admin.from('organizations').select('id,org_name,org_type_code,parent_org_id').eq('is_active', true).or(orgFilter).order('org_name').limit(1000),
    actorIds.length
      ? admin.from('users').select('id,full_name,email,role_code,organization_id').in('id', actorIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  return {
    recentDecisions,
    organizations: organizations.error ? [] : organizations.data || [],
    actors: actors.error ? [] : actors.data || [],
  }
}

export async function GET() {
  const actor = await requireSecurityActor('security.access.view')
  if (actor instanceof NextResponse) return actor
  const admin = actor.admin
  try {
    const results = await Promise.all([
      admin.from('sa_organization_memberships').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      admin.from('sa_role_assignments').select('id', { count: 'exact', head: true }).eq('status', 'active'),
      admin.from('sa_migration_modes').select('permission_key,mode,legacy_permission_key').order('permission_key'),
      admin.from('sa_authorization_decisions').select('id,occurred_at,actor_id,permission_key,resource_type,resource_id,decision,reason_code,migration_mode,legacy_decision,new_decision,comparison,correlation_id,policy_version').neq('comparison', 'MATCH_ALLOW').order('occurred_at', { ascending: false }).limit(100),
      admin.from('sa_permissions').select('id,permission_key,module,resource,action,description,status,source,audit_sensitivity').order('permission_key'),
      admin.from('sa_business_roles').select('id,role_key,name,description,status,source,version,permissions:sa_business_role_permissions(permission:sa_permissions(permission_key))').order('name'),
      admin.from('users').select('id,full_name,email,organization_id,role_code,is_active,organization:organizations!fk_users_organization(org_name),membership:sa_organization_memberships!sa_organization_memberships_user_id_fkey(id,status,is_primary,membership_type,organization_id,assignments:sa_role_assignments!sa_role_assignments_membership_id_fkey(id,status,source,effective_from,effective_until,assignment_reason,role:sa_business_roles(id,role_key,name,source),scopes:sa_assignment_scopes(scope:sa_scope_definitions(id,scope_type,scope_value,display_name))))').eq('organization_id', actor.organizationId).limit(500),
    ])
    if (results.some((result: any) => result.error)) {
      return NextResponse.json({ schemaReady: false, error: 'Wave 1 schema has not been applied in this environment.', metrics: {}, modes: [], decisions: [], permissions: [], roles: [], people: [] })
    }
    const [{ count: memberships }, { count: assignments }, { data: modes }, { data: decisions }, { data: permissions }, { data: roles }, { data: people }] = results
    // Readiness-migration diagnostics are optional: absent before it is applied.
    const { data: retention, error: retentionError } = await admin.rpc('sa_decision_retention_status')
    const directory = await loadDirectory(admin, decisions || []).catch(() => ({ recentDecisions: [], organizations: [], actors: [] }))
    // Final Wave read models (optional before the migration is applied).
    const { data: scopeDefinitions } = await admin.from('sa_scope_definitions')
      .select('id,organization_id,scope_type,scope_value,display_name,status').eq('status', 'active').order('display_name').limit(1000)
    // Administrator-overridden automatic access that may be restored (optional before the restore migration).
    const { data: restorable, error: restorableError } = await admin.rpc('sa_restorable_assignments')
    return NextResponse.json({ schemaReady: true, metrics: { businessIdentities: memberships || 0, activeAssignments: assignments || 0, shadowMismatches: (decisions || []).filter((d: any) => !['MATCH_ALLOW','MATCH_DENY'].includes(d.comparison)).length }, modes: (modes || []).map((m: any) => ({ ...m, enforcementReady: isEnforcementReady(m.permission_key) })), decisions: decisions || [], permissions: permissions || [], roles: roles || [], people: people || [], retention: retentionError ? null : retention, scopeDefinitions: scopeDefinitions || [], restorableAssignmentIds: restorableError ? [] : (restorable || []).map((r: any) => r.assignment_id), viewerId: actor.userId, viewerOrganizationId: actor.organizationId, capabilities: { canManageModes: await actorAlsoHolds(actor, 'security.permission.manage').catch(() => false) }, ...directory })
  } catch (error) {
    return NextResponse.json({ schemaReady: false, error: 'Wave 1 schema has not been applied in this environment.', metrics: {}, modes: [], decisions: [], permissions: [], roles: [], people: [] })
  }
}
