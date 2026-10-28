-- ============================================================================
-- Security & Access — hr.employee.delete: Monitoring / Shadow → Legacy Retired
--
-- NOT APPLIED. Optional, independent. Apply by hand after 20261214100000_hr_employee_controlled_delete.sql.
--
-- Why it is safe (S&A finalization audit, 2026-10-23):
--   * hr.employee.delete was seeded as SHADOW only as a display state. Its only enforcement points are the database
--     functions hr_employee_registration_actor_check / _preview / _execute (20261214100000), which call
--     sa_evaluate_permission(actor, 'hr.employee.delete', {organization_id}, false) in EVERY migration mode: an explicit
--     S&A assignment or Root Access in the target organization; no delegation, no emergency access, no legacy rule.
--   * No legacy compatibility policy holds the key (sa_legacy_compat_rules has no rule for it), no Full Access policy
--     holds it (recorded exclusion of hr-payroll-full-access), and the only policy that does is the break-glass
--     'hr-employee-record-administrator', assigned to nobody by any migration.
--   * The application never calls authorize()/requireAuthorization() for it (app/src/lib/hr/employee-registration.ts
--     delegates to the RPCs above), and no navigation destination uses it.
--   So the effective decision is the same before and after; the mode only stops the Overview from reporting the key as
--   "Monitoring" and makes any future authorize() call new-model authoritative (no legacy fallback can appear).
--
-- Path: SHADOW → NEW_ENFORCED → LEGACY_RETIRED through sa_set_migration_mode (database-owner session = 'system'),
-- audited as migration_mode.changed. Requires the readiness row inserted by 20261214100000.
--
-- security.emergency_access.grant is deliberately NOT changed: Emergency Access stays disabled
-- (emergency_access.enabled = false) and its application grant flow / TOTP step-up screen is not released; see the
-- S&A finalization report. Do not apply 20261024110000 either.
--
-- Rollback:
--   select public.sa_set_migration_mode(null, 'hr.employee.delete', 'SHADOW', 'Rollback of 20261215120000');
-- (No access changes either way.)
-- ============================================================================

do $migration$
declare
  v_mode text;
  v_emergency_before text := (select mode from public.sa_migration_modes where permission_key = 'security.emergency_access.grant');
begin
  if not exists (select 1 from public.sa_permissions where permission_key = 'hr.employee.delete' and status = 'active') then
    raise exception 'sa_prerequisite_missing: hr.employee.delete (20261214100000)';
  end if;
  if not exists (select 1 from public.sa_enforcement_readiness where permission_key = 'hr.employee.delete') then
    raise exception 'sa_prerequisite_missing: hr.employee.delete readiness (20261214100000)';
  end if;
  if not exists (select 1 from pg_proc where proname = 'hr_employee_registration_execute' and pronamespace = 'public'::regnamespace) then
    raise exception 'sa_prerequisite_missing: hr_employee_registration_execute (20261214100000)';
  end if;
  -- Nothing may hold the key through a compatibility policy (would become new-model authoritative).
  if exists (select 1 from public.sa_business_roles b join public.sa_business_role_permissions rp on rp.role_id = b.id
             join public.sa_permissions p on p.id = rp.permission_id
             where p.permission_key = 'hr.employee.delete' and b.source = 'legacy') then
    raise exception 'sa_precondition_failed: a legacy compatibility policy holds hr.employee.delete';
  end if;

  select mode into v_mode from public.sa_migration_modes where permission_key = 'hr.employee.delete';
  if v_mode in ('SHADOW', 'LEGACY_ENFORCED') then
    perform public.sa_set_migration_mode(null, 'hr.employee.delete', 'NEW_ENFORCED',
      'S&A finalization: the database gate already requires an explicit S&A grant in every mode (20261215120000).');
  end if;
  perform public.sa_set_migration_mode(null, 'hr.employee.delete', 'LEGACY_RETIRED',
    'S&A finalization: no legacy rule exists for Archive/Delete Employee; new model is the only decision (20261215120000).');

  if (select mode from public.sa_migration_modes where permission_key = 'hr.employee.delete') <> 'LEGACY_RETIRED' then
    raise exception 'postcondition: hr.employee.delete is not LEGACY_RETIRED';
  end if;
  if (select mode from public.sa_migration_modes where permission_key = 'security.emergency_access.grant') is distinct from v_emergency_before then
    raise exception 'postcondition: security.emergency_access.grant must not change here';
  end if;
end $migration$;
