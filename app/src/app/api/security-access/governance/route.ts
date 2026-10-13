import { NextResponse } from 'next/server'
import { finishTrace, requireSecurityActor, unavailableResponse } from '@/lib/security-access/admin-api'
import { createTrace, isSchemaMissing } from '@/lib/security-access/diagnostics'
import { ALL_ENFORCEMENT_READY_PERMISSIONS } from '@/lib/security-access/readiness'

export const dynamic = 'force-dynamic'

// Only these setting keys are shown; values are policy parameters, never secrets.
const VISIBLE_SETTINGS = [
  'lifecycle.sync_enabled', 'lifecycle.contractor_default_expiry_days', 'access_request.max_temporary_days',
  'access_request.pending_expiry_days', 'delegation.max_days', 'emergency_access.enabled',
  'emergency_access.mfa_step_up_available', 'emergency_access.max_minutes', 'legacy_authorization.read_only',
]

/**
 * Governance read model (security.audit.view): service identities (metadata
 * only — environment variable NAMES, never values; presence is reported as a
 * boolean), settings, readiness, authority policies and the access change log.
 * Parity evidence is served separately by ./parity (expensive; on demand).
 */
export async function GET() {
  const trace = createTrace('security-access/governance')
  const actor = await requireSecurityActor('security.audit.view', trace)
  if (actor instanceof NextResponse) return finishTrace(trace, actor)
  const admin = actor.admin
  // Parity evidence (sa_shadow_parity_summary / sa_compat_parity_report, several seconds each on staging) is
  // loaded on demand by the Parity section from ./parity, not on every Security & Access page load.
  const reads = await trace.time('governance_reads', () => Promise.all([
    admin.from('sa_service_identities').select('id,identity_key,name,purpose,identity_kind,owner_team,status,credential_type,credential_reference,scope_description,last_used_at,last_rotated_at,rotation_due_at').order('identity_kind').order('name'),
    admin.from('sa_settings').select('setting_key,setting_value,description,updated_at').in('setting_key', VISIBLE_SETTINGS),
    admin.from('sa_access_change_log').select('id,occurred_at,actor_id,actor_kind,action,target_user_id,entity_type,entity_id,details,reason').order('occurred_at', { ascending: false }).limit(200),
    admin.from('sa_authority_policies').select('id,policy_key,name,permission_key,document_type,organization_id,role_id,currency,min_amount,max_amount,max_variance_percent,status,effective_from,effective_until').order('policy_key'),
    admin.from('sa_enforcement_readiness').select('permission_key,database_backstop,intentional_tightening,notes'),
    // Legacy compatibility (read-only view; Settings → Authorization moves here)
    admin.from('roles').select('role_code,role_name,role_level,is_active').order('role_level'),
    admin.from('sa_business_roles').select('id,role_key,permissions:sa_business_role_permissions(count)').eq('source', 'legacy'),
    admin.from('sa_role_assignments').select('role_id').eq('status', 'active').eq('source', 'backfill'),
    admin.from('departments').select('id,permission_overrides').not('permission_overrides', 'is', null),
  ]))
  // A table that is verified absent (optional migration) reads as empty; any other failure is not "no data".
  const transient = reads.map((r: any, i: number) => (r.error && !isSchemaMissing(r.error) ? trace.fail(`governance_${i}`, r.error) : null)).filter(Boolean)
  if (transient.length) return finishTrace(trace, unavailableResponse(trace, 'governance_reads_failed'))
  const [services, settings, changes, authority, readiness, legacyRoles, compatRoles, compatAssignments, overrideDepts] = reads
  const credentialConfigured = (name: string | null) => (name ? Boolean(process.env[name]) : null)
  return finishTrace(trace, NextResponse.json({
    serviceIdentities: (services.data || []).map((s: any) => ({ ...s, credential_configured: credentialConfigured(s.credential_reference) })),
    settings: settings.data || [],
    accessChanges: changes.data || [],
    authorityPolicies: authority.data || [],
    readiness: readiness.data || [],
    legacyCompatibility: legacyCompatibilityView(
      legacyRoles.data || [], compatRoles.data || [], compatAssignments.data || [], overrideDepts.data || [],
      (settings.data || []).find((x: any) => x.setting_key === 'legacy_authorization.read_only')?.setting_value === true,
    ),
    enforcementReadyInCode: ALL_ENFORCEMENT_READY_PERMISSIONS,
    emergencyAccess: {
      available: false,
      prerequisite: 'Multi-factor step-up (Supabase MFA, AAL2) must be enrolled for administrators and enforced by the application before emergency access can be enabled.',
    },
  }, { headers: { 'Cache-Control': 'no-store' } }))
}

/** role_code → the generated compatibility role (mirrors public.sa_compat_role_key). */
function compatRoleKey(roleCode: string): string {
  return 'legacy-' + roleCode.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().replace(/^-+|-+$/g, '')
}

function legacyCompatibilityView(roles: any[], compatRoles: any[], assignments: any[], departments: any[], readOnly: boolean) {
  const byKey = new Map(compatRoles.map((r: any) => [r.role_key, r]))
  const assignmentCount = new Map<string, number>()
  for (const a of assignments) assignmentCount.set(a.role_id, (assignmentCount.get(a.role_id) || 0) + 1)
  const isOverride = (o: any) => o && ((Array.isArray(o.allow) && o.allow.length) || (Array.isArray(o.deny) && o.deny.length))
  return {
    readOnly,
    roles: roles.map((r: any) => {
      const compat: any = byKey.get(compatRoleKey(r.role_code))
      return {
        roleCode: r.role_code, roleName: r.role_name, roleLevel: r.role_level, isActive: r.is_active,
        compatRoleKey: compat ? compat.role_key : null,
        compatPermissions: compat ? (compat.permissions?.[0]?.count ?? 0) : 0,
        compatAssignments: compat ? (assignmentCount.get(compat.id) || 0) : 0,
      }
    }),
    departmentsWithOverrides: departments.filter((d: any) => isOverride(d.permission_overrides)).length,
  }
}
