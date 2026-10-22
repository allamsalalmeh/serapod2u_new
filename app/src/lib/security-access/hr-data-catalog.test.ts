import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HR_DATA_RESET_PERMISSION, HR_DATA_RESET_ROLE, HR_EMPLOYEE_DELETE_PERMISSION, HR_EMPLOYEE_RECORD_ROLE } from './hr-data-catalog'
import { BREAK_GLASS_POLICIES } from './group-policies'
import { isSensitivePermission } from './profiles'
import { ALL_ENFORCEMENT_READY_PERMISSIONS } from './readiness'
import { FINAL_WAVE_CATALOG } from './catalog'

const migration = readFileSync(new URL('../../../../supabase/migrations/20261003100000_hr_onboarding_state_and_data_reset.sql', import.meta.url), 'utf8')

describe('HR data reset permission', () => {
  it('is seeded SHADOW with its explicit role and readiness row', () => {
    expect(migration).toContain(`('${HR_DATA_RESET_PERMISSION}','hr','data','reset'`)
    expect(migration).toContain(`('${HR_DATA_RESET_ROLE}','HR Data Reset Administrator'`)
    expect(migration).toContain(`values ('${HR_DATA_RESET_PERMISSION}', 'SHADOW', null,`)
    expect(ALL_ENFORCEMENT_READY_PERMISSIONS).toContain(HR_DATA_RESET_PERMISSION)
  })

  it('is never granted by compatibility rules or backfill', () => {
    expect(FINAL_WAVE_CATALOG.map(e => e.key)).not.toContain(HR_DATA_RESET_PERMISSION)
    expect(migration).not.toMatch(/sa_create_assignment_internal\([^)]*hr-data-reset/)
    expect(migration).toContain("hr.data.reset must never be backfilled")
  })

  it('requires Super Admin and the explicit grant without delegation, in the database', () => {
    expect(migration).toContain("public.sa_legacy_is_super_admin(p_actor)")
    expect(migration).toContain("public.sa_evaluate_permission(p_actor, 'hr.data.reset', jsonb_build_object('organization_id', p_org), false)")
  })

  it('never puts identity, configuration or non-HR tables in the delete allowlist', () => {
    const deletes = [...migration.matchAll(/\('([a-z_]+)','[a-z_]+','delete',\d+,/g)].map(m => m[1])
    expect(deletes.length).toBeGreaterThan(10)
    for (const table of deletes) expect(table.startsWith('hr_')).toBe(true)
    for (const kept of ['hr_employees', 'departments', 'hr_positions', 'hr_leave_types', 'hr_public_holidays', 'hr_salary_bands',
      'hr_allowance_types', 'hr_deduction_types', 'hr_approval_chains', 'hr_attendance_policies', 'hr_employee_profiles']) {
      expect(deletes).not.toContain(kept)
    }
    expect(migration).not.toMatch(/\btruncate\s+(table\s+)?public\./i)
    expect(migration).not.toMatch(/\bdelete\s+from\s+public\.(users|hr_employees|departments)\b/i)
  })
})

const deleteMigration = readFileSync(new URL('../../../../supabase/migrations/20261214100000_hr_employee_controlled_delete.sql', import.meta.url), 'utf8')

describe('HR employee delete permission (20261214100000)', () => {
  it('is seeded SHADOW with its break-glass policy, readiness row and a Full Access exclusion', () => {
    expect(deleteMigration).toContain(`('${HR_EMPLOYEE_DELETE_PERMISSION}','hr','employee','delete'`)
    expect(deleteMigration).toContain(`values ('${HR_EMPLOYEE_DELETE_PERMISSION}', 'SHADOW', null,`)
    expect(deleteMigration).toContain(`values ('${HR_EMPLOYEE_RECORD_ROLE}', 'HR Employee Record Administrator',`)
    expect(deleteMigration).toContain(`sa_narrow_standard_policy('hr-payroll-full-access', array['${HR_EMPLOYEE_DELETE_PERMISSION}']`)
    expect(ALL_ENFORCEMENT_READY_PERMISSIONS).toContain(HR_EMPLOYEE_DELETE_PERMISSION)
    expect(BREAK_GLASS_POLICIES[HR_EMPLOYEE_RECORD_ROLE]).toEqual([HR_EMPLOYEE_DELETE_PERMISSION])
    expect(isSensitivePermission(HR_EMPLOYEE_DELETE_PERMISSION)).toBe(true)
  })

  it('is never granted by compatibility, legacy level, delegation or backfill', () => {
    expect(FINAL_WAVE_CATALOG.map(e => e.key)).not.toContain(HR_EMPLOYEE_DELETE_PERMISSION)
    expect(deleteMigration).not.toMatch(/sa_create_assignment_internal|insert into public\.sa_role_assignments/)
    expect(deleteMigration).toContain("public.sa_evaluate_permission(p_actor, 'hr.employee.delete', jsonb_build_object('organization_id', p_org), false)")
    expect(deleteMigration).not.toContain('sa_assert_actor_permission')
  })

  it('never deletes rows, cascades or touches identity, access or business tables', () => {
    expect(deleteMigration).not.toMatch(/\bdelete\s+from\b/i)
    expect(deleteMigration).not.toMatch(/\btruncate\b\s+(table\s+)?public\./i)
    expect(deleteMigration.replace(/--.*$/gm, '')).not.toMatch(/\bcascade\b/i)
    expect(deleteMigration).not.toMatch(/\bupdate\s+public\.(users|sa_role_assignments|sa_organization_memberships|orders)\b/i)
    expect(deleteMigration).not.toMatch(/auth\.users\s+(set|where)/i)
    // Only the onboarding columns of the employment record are written (never employment facts or the employee number).
    for (const m of deleteMigration.matchAll(/update public\.hr_employees x set([\s\S]*?)where/g)) {
      expect(m[1]).not.toMatch(/\b(employee_no|department_id|position_id|manager_user_id|employment_type|hire_date|status)\s*=/)
    }
  })

  it('re-checks under row locks with an idempotency key, preview token and append-only audit', () => {
    expect(deleteMigration).toContain('for update;')
    expect(deleteMigration).toContain('pg_advisory_xact_lock')
    expect(deleteMigration).toContain("set_config('lock_timeout', '5s', true)")
    expect(deleteMigration).toContain('request_id uuid not null unique')
    expect(deleteMigration).toContain("p_preview_token is distinct from v_plan->>'preview_token'")
    expect(deleteMigration).toContain('hr_employee_registration_actions_append_only')
    expect(deleteMigration).toContain('for key share;')
  })
})
