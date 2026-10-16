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

export const HR_DATA_PERMISSION_KEYS: readonly string[] = [HR_DATA_RESET_PERMISSION]
