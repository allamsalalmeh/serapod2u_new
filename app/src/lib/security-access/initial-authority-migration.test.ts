import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (f: string) => readFileSync(path.resolve(__dirname, '../../../../supabase/migrations', f), 'utf8')
const sql = read('20261015100000_sa_initial_policy_same_authority_as_grant.sql')
const code = sql.replace(/--.*$/gm, '')

describe('Add User initial policies use the Grant Policy authority (unapplied migration, lock-step)', () => {
  it('removes the blanket sensitive block that only the Add User path had, and keeps the grant guard as the enforcement', () => {
    expect(read('20261005110000_sa_access_profiles.sql')).toMatch(/sa_profile_sensitive_not_initial/)   // the confirmed cause
    expect(code).not.toMatch(/sa_profile_sensitive_not_initial/)
    expect(code).toMatch(/sa_actor_may_assign_profile\(p_actor, v_role, p_org\)/)
    expect(code).not.toMatch(/(drop|create)\s+(or replace\s+)?(trigger|function public\.sa_assignment_grant_guard)/i)                                 // the existing trigger is neither replaced nor dropped
  })
  it('the predicate repeats the grant guard rule: legacy Super Admin rule or holding every sensitive permission in the organization', () => {
    const guard = read('20261009100000_sa_group_policies_full_access.sql')
    expect(guard).toMatch(/sa_legacy_is_super_admin\(v_actor\)[\s\S]*sa_permission_is_sensitive[\s\S]*sa_actor_holds_permission\(v_actor, v_key, v_org\)/)
    expect(code).toMatch(/sa_legacy_is_super_admin\(p_actor\)[\s\S]*sa_permission_is_sensitive\(p\.permission_key\)[\s\S]*sa_actor_holds_permission\(p_actor, v_key, p_org\)/)
  })
  it('keeps every other rule of the initial path: one scope each, no defaulting to a broad scope, no duplicates, at most ten, sa_assign_role per policy', () => {
    for (const rule of ['sa_initial_access_invalid', 'sa_initial_access_duplicate', 'sa_scope_required', 'jsonb_array_length(p_items) > 10', 'public.sa_assign_role(p_actor, p_user, v_role, p_org, v_scopes']) expect(code).toContain(rule)
  })
  it('refuses a second active grant with the identity rule of sa_submit_access_request, and rewrites nothing', () => {
    expect(code).toMatch(/a\.user_id = p_user and a\.role_id = p_role and m\.organization_id = p_org and a\.status = 'active'/)
    expect(code).toMatch(/sa_role_already_held/)
    expect(code).not.toMatch(/\b(delete\s+from|update\s+public\.|truncate|alter\s+table)\b/i)
  })
  it('is service-role only and applied by hand', () => {
    expect(code).toMatch(/revoke all on function public\.sa_actor_may_assign_profile\(uuid, uuid, uuid\) from public, anon, authenticated/)
    expect(code).toMatch(/grant execute on function public\.sa_actor_may_assign_profile\(uuid, uuid, uuid\) to service_role/)
    expect(sql).toMatch(/NOT APPLIED/)
  })
})
