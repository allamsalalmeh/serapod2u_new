import 'server-only'

/**
 * Identity of an administrator grant = person + policy + membership organization (the rule sa_submit_access_request and
 * sa_assign_role apply). A second ACTIVE grant of the same policy in the same membership is never added: the database
 * upsert would replace the scopes of the first. Read-only; nothing is changed here.
 */

export type HeldGrantResult =
  | { held: false }
  | { held: true; message: string; coversWarehouses: boolean }

export const HELD_MESSAGE = 'This person already holds that policy in this organization. Nothing was changed.'
export const HELD_COVERS_WAREHOUSES_MESSAGE = 'This person already holds that policy for the whole organization, which already covers every warehouse. Adding warehouse access would not restrict it, and the existing grant was not changed. Revoke the existing grant first if you want narrower access.'

/** Pure: does an existing active grant already reach every warehouse the requested scopes name? */
export function describeHeldGrant(existingScopes: ReadonlyArray<{ scope_type: string; scope_value: string | null }>, membershipOrgId: string, requested: ReadonlyArray<{ scope_type: string }>): { message: string; coversWarehouses: boolean } {
  const coversWarehouses = existingScopes.some(s => s.scope_type === 'organization' && s.scope_value === membershipOrgId) && requested.some(r => r.scope_type === 'warehouse')
  return { coversWarehouses, message: coversWarehouses ? HELD_COVERS_WAREHOUSES_MESSAGE : HELD_MESSAGE }
}

export async function findHeldGrant(admin: any, input: { userId: string; roleId: string; organizationId: string; scopeIds: readonly string[] }): Promise<HeldGrantResult> {
  const { data, error } = await admin.from('sa_role_assignments')
    .select('id, effective_until, membership:sa_organization_memberships!sa_role_assignments_membership_id_fkey(organization_id), scopes:sa_assignment_scopes(scope:sa_scope_definitions(scope_type, scope_value))')
    .eq('user_id', input.userId).eq('role_id', input.roleId).eq('status', 'active')
  // A failed read is left to the database rule (sa_assign_role refuses the same duplicate); never a reason to block or to allow here.
  if (error || !data) return { held: false }
  const now = Date.now()
  const rows = (data as any[]).filter(a => {
    const m = Array.isArray(a.membership) ? a.membership[0] : a.membership
    return m?.organization_id === input.organizationId && (!a.effective_until || new Date(a.effective_until).getTime() > now)
  })
  if (!rows.length) return { held: false }
  const existing = rows.flatMap(a => (a.scopes || []).map((x: any) => (Array.isArray(x.scope) ? x.scope[0] : x.scope)).filter(Boolean))
  const { data: requested } = await admin.from('sa_scope_definitions').select('scope_type').in('id', Array.from(input.scopeIds))
  return { held: true, ...describeHeldGrant(existing, input.organizationId, requested || []) }
}
