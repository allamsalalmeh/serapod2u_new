import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Static contract of the UNAPPLIED migrations (no database is touched): they keep the Add User change narrow and safe.
const dir = path.resolve(__dirname, '../../../../supabase/migrations')
const read = (name: string) => readFileSync(path.join(dir, name), 'utf8')

describe('20261013100000_identity_provision_no_legacy_access.sql', () => {
  const sql = read('20261013100000_identity_provision_no_legacy_access.sql')
  const previous = read('20261005110000_sa_access_profiles.sql')

  it('maps no_legacy_access to the no-authority GUEST, never USER, and refuses it beside an explicit legacy role', () => {
    expect(sql).toMatch(/v_no_legacy then[\s\S]*identity_legacy_role_conflict[\s\S]*v_baseline := 'GUEST'/)
    expect(sql).not.toMatch(/v_baseline := 'USER'/)
    expect(sql).toMatch(/identity_no_legacy_role_unavailable/)
  })

  it('keeps the authorization, grant-ceiling and audit steps of the previous definition', () => {
    for (const keep of ['sa_assert_actor_permission', 'identity_legacy_role_grant_allowed', "'platform.identity_access.manage'", 'sa_assign_initial_profiles', 'sa_log_access_change', 'identity_membership_not_established']) {
      expect(previous).toContain(keep)
      expect(sql).toContain(keep)
    }
  })

  it('is service-role only and does not touch existing users or grants', () => {
    expect(sql).toMatch(/revoke all on function public\.identity_provision\(uuid,uuid,jsonb\) from public, anon, authenticated/)
    expect(sql).toMatch(/grant execute on function public\.identity_provision_capabilities\(\) to service_role/)
    expect(sql).not.toMatch(/\bdelete\s+from\b/i)                       // no backfill, no rewrite of existing users
    expect(sql).not.toMatch(/update public\.users u? ?set role_code/i)
    expect(sql).not.toMatch(/insert into public\.sa_role_assignments/i)
  })
})

describe('20261013110000_sa_ensure_organization_scope_definitions.sql', () => {
  const sql = read('20261013110000_sa_ensure_organization_scope_definitions.sql')
  it('only inserts missing own-organization scope definitions and grants nothing', () => {
    expect(sql).toMatch(/insert into public\.sa_scope_definitions/)
    expect(sql).toMatch(/not exists/)
    expect(sql).toMatch(/on conflict do nothing/)
    expect(sql).not.toMatch(/sa_role_assignments|sa_assignment_scopes|update public\.|delete from/i)
    expect(sql).not.toMatch(/'(\*|all|global)'/)
  })
})
