/**
 * HR Data Management permission. Seeded in SHADOW by
 * supabase/migrations/20261003100000_hr_onboarding_state_and_data_reset.sql
 * (hr-data-catalog.test.ts keeps both in step). The database always requires
 * Super Admin plus an explicit S&A grant of this permission (role
 * "hr-data-reset-administrator"), in every migration mode: it has no
 * compatibility rule, no delegation and no backfill.
 */
export const HR_DATA_RESET_PERMISSION = 'hr.data.reset'
export const HR_DATA_RESET_ROLE = 'hr-data-reset-administrator'

/**
 * Individual HR registration delete/reset (HR → People → Employees). Seeded in
 * SHADOW by supabase/migrations/20261214100000_hr_employee_controlled_delete.sql.
 * The database always requires an explicit S&A grant in the target organization
 * (break-glass policy "hr-employee-record-administrator"), in every migration
 * mode: no compatibility rule, no delegation, no backfill, not in Full Access.
 */
export const HR_EMPLOYEE_DELETE_PERMISSION = 'hr.employee.delete'
export const HR_EMPLOYEE_RECORD_ROLE = 'hr-employee-record-administrator'

export const HR_DATA_PERMISSION_KEYS: readonly string[] = [HR_DATA_RESET_PERMISSION, HR_EMPLOYEE_DELETE_PERMISSION]
