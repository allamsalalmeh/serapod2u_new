import 'server-only'
import { isFullAccessPolicy } from './group-policies'
import { recipientEligibility } from './recipient-eligibility'
import { ROUTE_COVERAGE } from './route-coverage'
const SERVER_GATES = new Set(Object.values(ROUTE_COVERAGE).flatMap(route => route.kind === 'ENTERPRISE' ? route.permissions : []))

/** Catalogue matches are review candidates, never a grant decision. The existing
 * grant preflight rechecks scope, grant ceilings and SoD at the time of approval. */
export function policyOptions(roles: any[], permissions: any[], required: string, orgType: string, enforcementReady = true) {
  const byKey = new Map(permissions.map(p => [p.permission_key, p]))
  const restrictedPolicies: Array<{ id: string; name: string; reason: string }> = []
  const matching = roles.filter(role => (role.permissions ?? []).some((p: any) => p.permission?.permission_key === required))
  const matches = matching.flatMap(role => {
    const keys: string[] = (role.permissions ?? []).map((p: any) => p.permission?.permission_key).filter(Boolean)
    const eligibility = recipientEligibility({ roleKey: role.role_key, source: role.source, status: role.status,
      orgTypes: role.applicable_org_types, accountTypes: role.applicable_account_types, permissionKeys: keys }, orgType)
    const reason = !byKey.has(required) || keys.some(k => !byKey.has(k) || (byKey.get(k)?.status && byKey.get(k)?.status !== 'active'))
      ? 'A permission is unregistered or inactive; engineering/catalogue review is required.'
      : !enforcementReady ? 'Backend/database enforcement registration is unavailable; engineering review is required.'
      : keys.includes('security.emergency_access.grant') ? 'This policy includes disabled emergency access.'
      : !eligibility.ok ? eligibility.message : null
    if (reason) { restrictedPolicies.push({ id: role.id, name: role.name, reason }); return [] }
    const sensitive = keys.filter(k => byKey.get(k)?.audit_sensitivity !== 'ordinary')
    return [{ id: role.id, name: role.name, roleKey: role.role_key, extraPermissions: keys.filter(k => k !== required),
      sensitivePermissions: sensitive, requiresExplicitReview: true }]
  })
  const narrow = matches.filter(candidate => !isFullAccessPolicy(candidate.roleKey))
  const candidates = (narrow.length ? narrow : matches).sort((a, b) => a.sensitivePermissions.length - b.sensitivePermissions.length || a.extraPermissions.length - b.extraPermissions.length || a.name.localeCompare(b.name)).slice(0, 20)
  return { candidates, matchingPolicyCount: matching.length, restrictedPolicies: restrictedPolicies.slice(0, 20) }
}

export function policyCandidates(roles: any[], permissions: any[], required: string, orgType: string) {
  return policyOptions(roles, permissions, required, orgType).candidates
}

export async function denialDiagnostics(admin: any, event: any) {
  if (event?.source !== 'server' || ![403, 503].includes(event?.http_status) || event?.details?.event !== 'security.authorization.denied' || !event.organization_id || !event.actor_id) return null
  const required = event.details.permission
  const [permissions, roles, org, assignments, readiness] = await Promise.all([
    admin.from('sa_permissions').select('permission_key,audit_sensitivity,status'),
    admin.from('sa_business_roles').select('id,role_key,name,status,source,applicable_org_types,applicable_account_types,permissions:sa_business_role_permissions(permission:sa_permissions(permission_key))').neq('source', 'legacy'),
    admin.from('organizations').select('org_type_code').eq('id', event.organization_id).maybeSingle(),
    admin.from('sa_role_assignments').select('id,status,effective_from,effective_until,source,role:sa_business_roles(id,name,status,permissions:sa_business_role_permissions(permission:sa_permissions(permission_key))),membership:sa_organization_memberships!inner(organization_id,status,effective_from,effective_until),scopes:sa_assignment_scopes(scope:sa_scope_definitions(scope_type,scope_value,status))').eq('user_id', event.actor_id).eq('membership.organization_id', event.organization_id).limit(100),
    admin.from('sa_enforcement_readiness').select('permission_key,route_wiring,database_backstop').eq('permission_key', required).maybeSingle(),
  ])
  if ([permissions, roles, org, assignments, readiness].some(r => r.error)) throw new Error('diagnostics_unavailable')
  const gateReady = readiness.data?.route_wiring === true && ['rpc_guard', 'rls_gate', 'transition_guard', 'decision_backstop', 'governance_function', 'read_only'].includes(readiness.data?.database_backstop)
  const missing = ['MISSING_PERMISSION', 'MISSING_ASSIGNMENT'].includes(event.details.reason)
  const options = missing ? policyOptions(roles.data, permissions.data, required, org.data?.org_type_code ?? '', gateReady)
    : { candidates: [], matchingPolicyCount: 0, restrictedPolicies: [] }
  return { requiredPermission: required, reason: event.details.reason, decisionId: event.details.decision_id,
    catalogueRegistered: permissions.data.some((p: any) => p.permission_key === required && p.status === 'active'),
    enforcementRegistered: gateReady,
    policyResolvable: missing, relevantAssignments: assignments.data.map((a: any) => ({ ...a,
      containsRequiredPermission: (a.role?.permissions ?? []).some((p: any) => p.permission?.permission_key === required),
      note: 'Current assignment state. Active dates, policy, membership and matching resource scope are all required; this record alone does not authorize access.',
    })),
    ...options, serverRouteRegistered: SERVER_GATES.has(required),
    review: 'Historical decision; current policies may have changed. Review target, organization, scope, extra permissions, grant authority and separation of duties in People & Access. No access has been granted.',
  }
}
