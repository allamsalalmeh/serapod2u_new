import { NextResponse } from 'next/server'
import { actorAlsoHolds, finishTrace, requireSecurityActor, unavailableResponse } from '@/lib/security-access/admin-api'
import { createTrace, isSchemaMissing } from '@/lib/security-access/diagnostics'
import { isEnforcementReady } from '@/lib/security-access/readiness'
import { loadEligibilityModel } from '@/lib/security-access/eligibility-model'

export const dynamic = 'force-dynamic'

const DIRECTORY_ORG_TYPES = ['HQ', 'WH', 'DIST', 'MFG']

// Display-only lookups so administrators see names instead of UUIDs. Every
// query is read-only and optional: a failure leaves the page usable.
// Ids per `id=in.(...)` request: ~37 characters per UUID keeps each URL well under
// the gateway's request-line limit (one query with ~800 scope ids was rejected 414).
const ID_CHUNK = 100
const chunks = <T,>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size))

// Display-only lookups so administrators see names instead of UUIDs. Every
// query is read-only and optional: a failure leaves the page usable.
async function loadDirectory(admin: any, differenceDecisions: any[]) {
  const [recent, scopeOrgs] = await Promise.all([
    admin.from('sa_authorization_decisions').select('id,occurred_at,actor_id,permission_key,resource_type,resource_id,decision,reason_code,migration_mode,legacy_decision,new_decision,comparison,resolved_scopes,matched_assignments,correlation_id,policy_version').order('occurred_at', { ascending: false }).limit(100),
    admin.from('sa_scope_definitions').select('organization_id').not('organization_id', 'is', null),
  ])
  const scopeOrgIds: string[] = Array.from(new Set((scopeOrgs.data || []).map((s: any) => s.organization_id)))
  const recentDecisions = recent.error ? [] : recent.data || []
  const actorIds = Array.from(new Set([...recentDecisions, ...differenceDecisions].map((d: any) => d.actor_id).filter(Boolean)))
  const orgColumns = 'id,org_name,org_type_code,parent_org_id'
  const [byType, byId, actors] = await Promise.all([
    admin.from('organizations').select(orgColumns).eq('is_active', true).in('org_type_code', DIRECTORY_ORG_TYPES).order('org_name').limit(1000),
    Promise.all(chunks(scopeOrgIds, ID_CHUNK).map(ids => admin.from('organizations').select(orgColumns).eq('is_active', true).in('id', ids))),
    actorIds.length
      ? admin.from('users').select('id,full_name,email,role_code,organization_id').in('id', actorIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  const organizations = new Map<string, any>()
  for (const r of [byType, ...byId]) if (!r.error) for (const o of r.data || []) organizations.set(o.id, o)
  return {
    recentDecisions,
    organizations: Array.from(organizations.values()).sort((a, b) => String(a.org_name).localeCompare(String(b.org_name))),
    actors: actors.error ? [] : actors.data || [],
  }
}

const CORE = ['memberships', 'assignments', 'modes', 'decisions', 'permissions', 'roles', 'people'] as const

/**
 * Overview read model (security.access.view).
 *
 * Status contract (the client renders each distinctly):
 *   200 schemaReady:true   — measured data (an empty list is a real, confirmed empty)
 *   200 schemaReady:false  — a specific core table/relationship is verified missing (missingDependency)
 *   401 / 403              — unauthenticated / recorded policy denial (requireSecurityActor)
 *   503 sa_unavailable     — a core read failed for another reason (timeout, network, database)
 */
export async function GET() {
  const trace = createTrace('security-access/overview')
  const actor = await requireSecurityActor('security.access.view', trace)
  if (actor instanceof NextResponse) return finishTrace(trace, actor)
  const admin = actor.admin
  try {
    // Every read below is independent of the others: one parallel round.
    const [results, retention, directory, scopeDefinitions, restorable, canManageModes, eligibilityModel] = await trace.time('overview_reads', () => Promise.all([
      Promise.all([
        admin.from('sa_organization_memberships').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        admin.from('sa_role_assignments').select('id', { count: 'exact', head: true }).eq('status', 'active'),
        admin.from('sa_migration_modes').select('permission_key,mode,legacy_permission_key').order('permission_key'),
        admin.from('sa_authorization_decisions').select('id,occurred_at,actor_id,permission_key,resource_type,resource_id,decision,reason_code,migration_mode,legacy_decision,new_decision,comparison,correlation_id,policy_version').neq('comparison', 'MATCH_ALLOW').order('occurred_at', { ascending: false }).limit(100),
        admin.from('sa_permissions').select('id,permission_key,module,resource,action,description,status,source,audit_sensitivity').order('permission_key'),
        admin.from('sa_business_roles').select('id,role_key,name,description,status,source,version,applicable_account_types,applicable_org_types,permissions:sa_business_role_permissions(permission:sa_permissions(permission_key))').order('name'),
        admin.from('users').select('id,full_name,email,organization_id,role_code,is_active,organization:organizations!fk_users_organization(org_name),membership:sa_organization_memberships!sa_organization_memberships_user_id_fkey(id,status,is_primary,membership_type,organization_id,organization:organizations(org_name,org_type_code),assignments:sa_role_assignments!sa_role_assignments_membership_id_fkey(id,status,source,effective_from,effective_until,assignment_reason,role:sa_business_roles(id,role_key,name,source),scopes:sa_assignment_scopes(scope:sa_scope_definitions(id,scope_type,scope_value,display_name))))').eq('organization_id', actor.organizationId).limit(500),
      ]),
      // Readiness-migration diagnostics are optional: absent before it is applied.
      admin.rpc('sa_decision_retention_status'),
      // Display-only names; it re-reads the latest differences itself so it need not wait for the core reads.
      loadDirectoryWithDifferences(admin).catch(() => ({ recentDecisions: [], organizations: [], actors: [] })),
      // Final Wave read models (optional before the migration is applied).
      admin.from('sa_scope_definitions').select('id,organization_id,scope_type,scope_value,display_name,status').eq('status', 'active').order('display_name').limit(1000),
      // Administrator-overridden automatic access that may be restored (optional before the restore migration).
      admin.rpc('sa_restorable_assignments'),
      actorAlsoHolds(actor, 'security.permission.manage').catch(() => false),
      // Which recipient-eligibility rule the database enforces, so the grant form offers exactly what it accepts.
      loadEligibilityModel(admin),
    ]))
    const failed = results.map((r: any, i: number) => ({ name: CORE[i], error: r.error })).filter((r: any) => r.error)
    if (failed.length) {
      for (const f of failed) trace.fail(`overview_${f.name}`, f.error)
      // Only a verified missing table/relationship means "migration not applied"; anything else is a transient failure.
      if (failed.every((f: any) => isSchemaMissing(f.error))) {
        return finishTrace(trace, NextResponse.json({ schemaReady: false, missingDependency: failed.map((f: any) => f.name), error: 'The Security & Access schema has not been applied in this environment.' }))
      }
      return finishTrace(trace, unavailableResponse(trace, 'overview_reads_failed'))
    }
    const [{ count: memberships }, { count: assignments }, { data: modes }, { data: decisions }, { data: permissions }, { data: roles }, { data: people }] = results
    return finishTrace(trace, NextResponse.json({
      schemaReady: true,
      metrics: { businessIdentities: memberships || 0, activeAssignments: assignments || 0, shadowMismatches: (decisions || []).filter((d: any) => !['MATCH_ALLOW', 'MATCH_DENY'].includes(d.comparison)).length },
      modes: (modes || []).map((m: any) => ({ ...m, enforcementReady: isEnforcementReady(m.permission_key) })),
      decisions: decisions || [], permissions: permissions || [], roles: roles || [], people: people || [],
      retention: retention.error ? null : retention.data,
      scopeDefinitions: scopeDefinitions.error ? [] : scopeDefinitions.data || [],
      restorableAssignmentIds: restorable.error ? [] : (restorable.data || []).map((r: any) => r.assignment_id),
      viewerId: actor.userId, viewerOrganizationId: actor.organizationId,
      capabilities: { canManageModes },
      eligibilityModel,
      ...directory,
    }, { headers: { 'Cache-Control': 'no-store' } }))
  } catch (error) {
    trace.fail('overview', error)
    return finishTrace(trace, unavailableResponse(trace, 'overview_failed'))
  }
}

async function loadDirectoryWithDifferences(admin: any) {
  const { data } = await admin.from('sa_authorization_decisions').select('actor_id').neq('comparison', 'MATCH_ALLOW').order('occurred_at', { ascending: false }).limit(100)
  return loadDirectory(admin, data || [])
}
