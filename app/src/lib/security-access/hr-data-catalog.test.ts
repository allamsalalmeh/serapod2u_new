import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HR_DATA_RESET_PERMISSION, HR_DATA_RESET_ROLE } from './hr-data-catalog'
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
