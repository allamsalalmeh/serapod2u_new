-- ============================================================================
-- 20261221100000_hr_employment_foundation.sql
-- Serapod2U HR Core — Wave 2: Employee lifecycle integrity, effective-dated employment history, reporting-line
-- integrity and reconciliation, compensation integrity, statutory employee profile, Finance-ready HR data contract.
-- Roadmap: B1 (lifecycle compatibility), B7a (reporting lines), B7b (employment-end effects, partial), B7c (history,
-- compensation integrity, statutory profile), B7d readiness (payroll component code slot only).
--
-- STATUS: migration file prepared. NOT applied to staging or production. Owner applies staging first (D-018), after
-- the replica suite supabase/tests/security/hr_employment_foundation/ passes.
--
-- What this migration does (all additive; no row of existing business data is deleted):
--   1. hr_employee_versions — append-only, effective-dated employment history. One "baseline" version per existing
--      employment record (as of this migration — the past is NOT reconstructed); afterwards one version per change of
--      an employment fact (status, type, department, position, manager, hire/end/probation dates, organization,
--      onboarding state). Carries a NULLABLE cost_center_ref slot: Finance owns cost centres (P-F02); HR never
--      creates or validates one here.
--   2. hr_employees lifecycle guard (BEFORE INSERT/UPDATE):
--        * a former (ARCHIVED) employee's employment facts are locked (reactivate the identity first);
--        * an ended employment returns to active only for a non-archived identity (rehire); end_date is cleared;
--        * ending employment stamps end_date (default today) and end_date >= hire_date;
--        * a NEW manager must be an active, non-archived person of the same company (HQ group), never the employee,
--          and must not create a reporting cycle. Existing rows are never re-validated unless the manager changes.
--      Database-owned onboarding/reset/restore writes (hr_onboarding_trusted_write) are not re-validated.
--   3. Employment-end effects (AFTER UPDATE): when employment ends, active compensation, allowances, deductions and
--      active position assignments that run past the end date are ended at the end date (history kept). Direct reports
--      are NOT silently re-pointed (explicit HR action, below).
--   4. Reporting lines: hr_reporting_line_review(org) (read-only findings incl. position-derived divergence),
--      hr_set_reporting_line / hr_reassign_direct_reports (service_role; S&A hr.employee.manage asserted in the
--      target organization, legacy fallback never counts), append-only hr_reporting_line_changes log.
--   5. hr_employment_change(...) — one controlled, effective-dated employment change (transfer, type, probation,
--      status within active/probation/suspended) with reason; S&A hr.employee.manage asserted.
--   6. Compensation integrity: no two ACTIVE compensation rows of an employee may overlap in time (trigger, per-employee
--      advisory lock; no extension dependency); end_date >= effective_date; append-only hr_compensation_change_log.
--      The migration REFUSES to run if overlapping active rows already exist (clean them first; staging 2026-10-24: 0).
--   7. hr_employee_statutory_profiles — statutory master data capture (NRIC/passport, DOB, citizenship,
--      tax residency, marital status, children, EPF/SOCSO/EIS/income-tax numbers, work state). No API privileges:
--      read/write only through server routes that assert S&A. No statutory CALCULATION (Phase B).
--      hr_employee_profiles — the personal HR profile the HR People "HR Profile" sheet always expected (the table never
--      existed, so saving failed — BL-17); its statutory fields are stored only in the statutory profile.
--   8. payroll_component_code slot on hr_allowance_types / hr_deduction_types (nullable; format-checked; no FK —
--      the component model is P-F03, Phase B).
--   9. hr_employment_finance_contract_v1 — read-only HR→Finance data contract view (service_role only): employment
--      identity, periods, organization/company, department, position, cost_center_ref slot, effective compensation
--      metadata (no statutory values). Finance remains owner of GL, chart of accounts and cost centres. No posting.
--  10. Identity/HR-reset compatibility: the new tables are classified in hr_reset_scope as KEPT; the history tables use
--      *_ref column names (no foreign keys) so they neither block nor get counted by identity_deletion_plan; versions of
--      an employment record that is permanently deleted (only possible when it has no HR history) are removed with it.
--      The statutory profile references public.users WITHOUT cascade: it is HR master data and blocks permanent
--      deletion like other HR records (lifecycle review §3).
--
-- Not done here (by design / other owners): no S&A catalogue, grant, policy or mode change; no change to identity
-- functions (identity_archive_*, identity_deletion_*); no payroll calculation, PCB/EPF/SOCSO/EIS computation, GL posting,
-- Finance account or cost-centre creation.
--
-- Dependencies: 20261003100000 (hr_reset_scope, hr_onboarding_trusted_write), HR01–HR05 (positions), identity Stage 2
-- (projection triggers). Coexists with 20261214…20261218 (lifecycle) and 20261219100000 (B2A) in either order.
--
-- ROLLBACK (safe; keeps all history tables and their rows):
--   drop trigger if exists hr_employees_lifecycle_guard on public.hr_employees;
--   drop trigger if exists hr_employees_record_version on public.hr_employees;
--   drop trigger if exists hr_employees_end_effects on public.hr_employees;
--   drop trigger if exists hr_employees_purge_versions on public.hr_employees;
--   drop trigger if exists hr_employee_compensation_no_overlap on public.hr_employee_compensation;
--   drop trigger if exists hr_employee_compensation_log on public.hr_employee_compensation;
--   drop trigger if exists hr_statutory_profiles_log on public.hr_employee_statutory_profiles;
--   drop function if exists public.hr_set_reporting_line(uuid,uuid,uuid,text), public.hr_reassign_direct_reports(uuid,uuid,uuid,text,uuid[]),
--     public.hr_employment_change(uuid,uuid,jsonb,date,text), public.hr_statutory_profile_save(uuid,uuid,jsonb,text);
--   (read-only entry points hr_employee_history, hr_statutory_profile_get, hr_reporting_line_review_for may stay: they
--    change nothing and keep the HR screens working; the app shows "unavailable" if they are dropped.)
--   alter table public.hr_employee_compensation drop constraint if exists hr_emp_comp_dates_chk;
--   (tables hr_employee_versions, hr_reporting_line_changes, hr_compensation_change_log, hr_employee_statutory_profiles,
--    hr_statutory_profile_changes and the view are retained as evidence; drop only with a recorded owner decision.)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Prerequisites
-- ---------------------------------------------------------------------------
do $pre$
begin
  if to_regclass('public.hr_employees') is null or to_regclass('public.users') is null
     or to_regclass('public.hr_employee_compensation') is null or to_regclass('public.hr_position_assignments') is null
     or to_regclass('public.hr_position_relationships') is null or to_regclass('public.hr_reset_scope') is null
     or to_regclass('public.hr_employee_allowances') is null or to_regclass('public.hr_employee_deductions') is null
     or to_regclass('public.hr_allowance_types') is null or to_regclass('public.hr_deduction_types') is null
     or to_regprocedure('public.hr_onboarding_trusted_write()') is null
     or to_regprocedure('public.get_company_id(uuid)') is null
     or to_regprocedure('public.sa_evaluate_permission_core(uuid,text,jsonb,boolean,boolean)') is null then
    raise exception 'hr_employment_foundation: prerequisites missing (HR onboarding/reset 20261003100000, HR01-HR05, S&A core)';
  end if;
  -- Compensation overlap must be clean before the guard is installed (no silent data change).
  if exists (
    select 1 from public.hr_employee_compensation a
    join public.hr_employee_compensation b on b.employee_id = a.employee_id and b.id > a.id
    where a.status = 'active' and b.status = 'active'
      and a.effective_date <= coalesce(b.end_date, 'infinity'::date)
      and b.effective_date <= coalesce(a.end_date, 'infinity'::date)) then
    raise exception 'hr_employment_foundation: overlapping ACTIVE compensation rows exist — resolve them first (see hr_b0 E: employees_with_overlapping_active_compensation)';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Employment history (append-only, effective-dated)
-- ---------------------------------------------------------------------------
create table if not exists public.hr_employee_versions (
  id uuid primary key default gen_random_uuid(),
  employment_ref uuid not null,            -- hr_employees.id (no FK: history survives; see §10)
  person_ref uuid not null,                -- users.id of the employee
  organization_id uuid not null,
  version_no integer not null,
  change_kind text not null,
  effective_date date not null,
  recorded_at timestamptz not null default now(),
  status text,
  employment_type text,
  department_id uuid,
  position_id uuid,
  manager_ref uuid,
  hire_date date,
  end_date date,
  probation_end date,
  onboarding_status text,
  cost_center_ref text,                    -- Finance-owned reference slot (P-F02); null until Finance provides one
  changed_columns text[] not null default '{}',
  reason text,
  actor_ref uuid,
  actor_db_role text not null,
  constraint hr_employee_versions_no_uniq unique (employment_ref, version_no),
  constraint hr_employee_versions_kind_chk check (change_kind in
    ('baseline','hire','transfer','reporting_change','status_change','employment_terms','end_of_employment','rehire',
     'organization_move','onboarding','correction')),
  constraint hr_employee_versions_reason_len check (reason is null or length(reason) <= 500)
);
create index if not exists hr_employee_versions_employment_idx on public.hr_employee_versions (employment_ref, version_no desc);
create index if not exists hr_employee_versions_person_idx on public.hr_employee_versions (person_ref);
create index if not exists hr_employee_versions_org_idx on public.hr_employee_versions (organization_id, effective_date);
alter table public.hr_employee_versions enable row level security;
alter table public.hr_employee_versions force row level security;
revoke all on table public.hr_employee_versions from public, anon, authenticated;
grant select on table public.hr_employee_versions to service_role;

create or replace function public.hr_history_append_only()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $fn$
begin
  -- Only the purge of a permanently deleted, history-free employment record may remove rows (see §10).
  if tg_op = 'DELETE' and coalesce(current_setting('hr.history_purge', true), '') = 'on'
     and current_user not in ('anon', 'authenticated', 'service_role') then
    return old;
  end if;
  raise exception 'hr_history_append_only' using errcode = '42501', detail = tg_table_name || ' is append-only.';
end $fn$;
revoke all on function public.hr_history_append_only() from public, anon, authenticated, service_role;

drop trigger if exists hr_employee_versions_append_only on public.hr_employee_versions;
create trigger hr_employee_versions_append_only before update or delete on public.hr_employee_versions
  for each row execute function public.hr_history_append_only();
drop trigger if exists hr_employee_versions_no_truncate on public.hr_employee_versions;
create trigger hr_employee_versions_no_truncate before truncate on public.hr_employee_versions
  for each statement execute function public.hr_history_append_only();

-- The originating API role (PostgREST sets ROLE; a SECURITY DEFINER frame changes current_user, not this setting).
create or replace function public.hr_request_db_role()
returns text language sql stable set search_path = pg_catalog, pg_temp as $fn$
  select coalesce(nullif(nullif(current_setting('role', true), ''), 'none'), session_user::text)
$fn$;
revoke all on function public.hr_request_db_role() from public, anon;
grant execute on function public.hr_request_db_role() to authenticated, service_role;

create or replace function public.hr_employees_record_version()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_cols text[] := '{}';
  v_kind text;
  v_no integer;
  v_eff date;
  v_reason text := nullif(btrim(coalesce(current_setting('hr.change_reason', true), '')), '');
  v_eff_setting text := nullif(current_setting('hr.change_effective_date', true), '');
begin
  if tg_op = 'UPDATE' then
    if new.status is distinct from old.status then v_cols := array_append(v_cols, 'status'::text); end if;
    if new.employment_type is distinct from old.employment_type then v_cols := array_append(v_cols, 'employment_type'::text); end if;
    if new.department_id is distinct from old.department_id then v_cols := array_append(v_cols, 'department_id'::text); end if;
    if new.position_id is distinct from old.position_id then v_cols := array_append(v_cols, 'position_id'::text); end if;
    if new.manager_user_id is distinct from old.manager_user_id then v_cols := array_append(v_cols, 'manager_user_id'::text); end if;
    if new.hire_date is distinct from old.hire_date then v_cols := array_append(v_cols, 'hire_date'::text); end if;
    if new.end_date is distinct from old.end_date then v_cols := array_append(v_cols, 'end_date'::text); end if;
    if new.probation_end is distinct from old.probation_end then v_cols := array_append(v_cols, 'probation_end'::text); end if;
    if new.organization_id is distinct from old.organization_id then v_cols := array_append(v_cols, 'organization_id'::text); end if;
    if new.onboarding_status is distinct from old.onboarding_status then v_cols := array_append(v_cols, 'onboarding_status'::text); end if;
    if cardinality(v_cols) = 0 then return new; end if;
    v_kind := case
      when 'organization_id' = any(v_cols) then 'organization_move'
      when 'status' = any(v_cols) and new.status in ('resigned','terminated') then 'end_of_employment'
      when 'status' = any(v_cols) and old.status in ('resigned','terminated') then 'rehire'
      when 'status' = any(v_cols) then 'status_change'
      when 'onboarding_status' = any(v_cols) then 'onboarding'
      when v_cols <@ array['manager_user_id'] then 'reporting_change'
      when 'department_id' = any(v_cols) or 'position_id' = any(v_cols) then 'transfer'
      else 'employment_terms' end;
  else
    v_cols := array['status','employment_type','department_id','position_id','manager_user_id','hire_date','end_date',
                    'probation_end','organization_id','onboarding_status'];
    v_kind := 'hire';
  end if;
  v_eff := case when v_eff_setting ~ '^\d{4}-\d{2}-\d{2}$' then v_eff_setting::date
                when tg_op = 'INSERT' then coalesce(new.hire_date, current_date)
                when v_kind = 'end_of_employment' then coalesce(new.end_date, current_date)
                else current_date end;
  perform pg_advisory_xact_lock(hashtextextended('hr_employee_versions:' || new.id::text, 0));
  select coalesce(max(version_no), 0) + 1 into v_no from public.hr_employee_versions where employment_ref = new.id;
  insert into public.hr_employee_versions(employment_ref, person_ref, organization_id, version_no, change_kind, effective_date,
    status, employment_type, department_id, position_id, manager_ref, hire_date, end_date, probation_end, onboarding_status,
    changed_columns, reason, actor_ref, actor_db_role)
  values (new.id, new.user_id, new.organization_id, v_no, v_kind, v_eff,
    new.status, new.employment_type, new.department_id, new.position_id, new.manager_user_id, new.hire_date, new.end_date,
    new.probation_end, new.onboarding_status, v_cols, left(v_reason, 500), auth.uid(), public.hr_request_db_role());
  return new;
end $fn$;
revoke all on function public.hr_employees_record_version() from public, anon, authenticated, service_role;

drop trigger if exists hr_employees_record_version on public.hr_employees;
create trigger hr_employees_record_version after insert or update on public.hr_employees
  for each row execute function public.hr_employees_record_version();

-- Baseline: one version per employment record that has none. It records the state KNOWN at this migration and is
-- effective from the hire date (best available knowledge; earlier changes are not reconstructed — change_kind
-- 'baseline' and recorded_at make that explicit to every consumer).
insert into public.hr_employee_versions(employment_ref, person_ref, organization_id, version_no, change_kind, effective_date,
  status, employment_type, department_id, position_id, manager_ref, hire_date, end_date, probation_end, onboarding_status,
  changed_columns, reason, actor_ref, actor_db_role)
select e.id, e.user_id, e.organization_id, 1, 'baseline', coalesce(least(e.hire_date, current_date), current_date),
       e.status, e.employment_type, e.department_id, e.position_id, e.manager_user_id, e.hire_date, e.end_date, e.probation_end,
       e.onboarding_status, '{}', 'Baseline at migration 20261221100000 (earlier history not reconstructed)', null, 'migration'
from public.hr_employees e
where not exists (select 1 from public.hr_employee_versions v where v.employment_ref = e.id);

-- As-of view of one employment record (latest version effective on or before the date).
create or replace function public.hr_employee_as_of(p_employment uuid, p_as_of date default current_date)
returns setof public.hr_employee_versions language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select v.* from public.hr_employee_versions v
  where v.employment_ref = p_employment and v.effective_date <= p_as_of
  order by v.effective_date desc, v.version_no desc limit 1
$fn$;
revoke all on function public.hr_employee_as_of(uuid, date) from public, anon, authenticated;
grant execute on function public.hr_employee_as_of(uuid, date) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Lifecycle guard on hr_employees
-- ---------------------------------------------------------------------------
create or replace function public.hr_manager_assignment_error(p_employee_user uuid, p_org uuid, p_manager uuid)
returns text language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  m record;
  v_cursor uuid;
  v_depth integer := 0;
  v_company uuid := public.get_company_id(p_org);
begin
  if p_manager is null then return null; end if;
  if p_manager = p_employee_user then return 'hr_manager_self'; end if;
  select u.id, u.is_active, coalesce(u.account_status, 'ACTIVE') as account_status, u.organization_id into m
  from public.users u where u.id = p_manager;
  if not found then return 'hr_manager_unknown'; end if;
  if m.account_status = 'ARCHIVED' or m.is_active is not true or m.account_status not in ('ACTIVE', 'INVITED') then
    return 'hr_manager_inactive';
  end if;
  -- The manager's employment (when the manager has HR records) must not be ended in every company of the group.
  if exists (select 1 from public.hr_employees me where me.user_id = p_manager)
     and not exists (select 1 from public.hr_employees me where me.user_id = p_manager
                     and me.status not in ('resigned', 'terminated')) then
    return 'hr_manager_inactive';
  end if;
  -- Same company (HQ group). A company without an HQ ancestor compares organizations directly.
  if coalesce(public.get_company_id(m.organization_id), m.organization_id) is distinct from coalesce(v_company, p_org) then
    return 'hr_manager_outside_company';
  end if;
  -- No reporting cycle: walk up from the new manager.
  v_cursor := p_manager;
  while v_cursor is not null and v_depth < 64 loop
    select e.manager_user_id into v_cursor from public.hr_employees e
    where e.user_id = v_cursor order by (e.status in ('resigned','terminated')), e.updated_at desc limit 1;
    if v_cursor = p_employee_user then return 'hr_manager_cycle'; end if;
    v_depth := v_depth + 1;
  end loop;
  if v_depth >= 64 then return 'hr_manager_cycle'; end if;
  return null;
end $fn$;
revoke all on function public.hr_manager_assignment_error(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.hr_manager_assignment_error(uuid, uuid, uuid) to service_role;

create or replace function public.hr_employees_lifecycle_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_archived boolean;
  v_err text;
  v_old_ended boolean;
  v_new_ended boolean := new.status in ('resigned', 'terminated');
begin
  -- Database-owned onboarding / HR reset / restore writes carry their own validation — except that a FRESH HR onboarding
  -- (hr_onboarding_complete stamps onboarded_at = now() in this transaction) must not assign a former, inactive,
  -- other-company or cyclic manager. A restore brings back the recorded onboarded_at and is never re-validated.
  if public.hr_onboarding_trusted_write() then
    if new.manager_user_id is not null and new.onboarding_status = 'completed' and new.onboarded_at is not distinct from now()
       and (tg_op = 'INSERT' or new.manager_user_id is distinct from old.manager_user_id
            or old.onboarding_status is distinct from 'completed') then
      v_err := public.hr_manager_assignment_error(new.user_id, new.organization_id, new.manager_user_id);
      if v_err is not null then raise exception '%', v_err using errcode = '23514'; end if;
    end if;
    return new;
  end if;

  select coalesce(u.account_status, 'ACTIVE') = 'ARCHIVED' into v_archived from public.users u where u.id = new.user_id;
  v_archived := coalesce(v_archived, false);

  if tg_op = 'UPDATE' then
    v_old_ended := old.status in ('resigned', 'terminated');
    -- A former (archived) employee's employment facts are locked; ending employment / correcting the end date is allowed.
    if v_archived and (
         (new.status is distinct from old.status and not v_new_ended)
      or new.department_id is distinct from old.department_id
      or new.position_id is distinct from old.position_id
      or new.employment_type is distinct from old.employment_type
      or new.hire_date is distinct from old.hire_date
      or new.probation_end is distinct from old.probation_end
      or (new.manager_user_id is distinct from old.manager_user_id and new.manager_user_id is not null)) then
      raise exception 'hr_employment_archived_locked' using errcode = '42501',
        detail = 'This person is a former employee (archived). Reactivate the identity before changing employment details.';
    end if;
    -- Rehire: an ended employment returns to active only for a non-archived identity; the old end date is cleared
    -- unless the caller set one explicitly (history keeps the previous end date).
    if v_old_ended and not v_new_ended and new.end_date is not distinct from old.end_date then
      new.end_date := null;
    end if;
    -- Ending employment stamps the end date.
    if v_new_ended and not v_old_ended then
      new.end_date := coalesce(new.end_date, current_date);
    end if;
  else
    if v_new_ended then new.end_date := coalesce(new.end_date, current_date); end if;
  end if;

  if new.end_date is not null and new.hire_date is not null and new.end_date < new.hire_date then
    raise exception 'hr_employment_end_before_hire' using errcode = '22023',
      detail = 'The employment end date cannot be before the hire date.';
  end if;
  if new.end_date is not null and not v_new_ended and new.end_date < current_date then
    raise exception 'hr_employment_end_date_passed' using errcode = '22023',
      detail = 'An active employment cannot carry an end date in the past. End the employment instead.';
  end if;

  -- A NEW manager is validated (existing reporting lines are reported by hr_reporting_line_review, not blocked).
  if new.manager_user_id is not null
     and (tg_op = 'INSERT' or new.manager_user_id is distinct from old.manager_user_id) then
    v_err := public.hr_manager_assignment_error(new.user_id, new.organization_id, new.manager_user_id);
    if v_err is not null then
      raise exception '%', v_err using errcode = '23514', detail = case v_err
        when 'hr_manager_self' then 'An employee cannot report to themself.'
        when 'hr_manager_unknown' then 'The selected manager does not exist.'
        when 'hr_manager_inactive' then 'The selected manager is a former or inactive employee.'
        when 'hr_manager_outside_company' then 'The selected manager belongs to another company.'
        when 'hr_manager_cycle' then 'This reporting line would create a reporting cycle.'
        else v_err end;
    end if;
  end if;
  return new;
end $fn$;
revoke all on function public.hr_employees_lifecycle_guard() from public, anon, authenticated, service_role;

drop trigger if exists hr_employees_lifecycle_guard on public.hr_employees;
create trigger hr_employees_lifecycle_guard before insert or update on public.hr_employees
  for each row execute function public.hr_employees_lifecycle_guard();

-- ---------------------------------------------------------------------------
-- 3. Employment-end effects (history kept; nothing deleted)
-- ---------------------------------------------------------------------------
create or replace function public.hr_employees_end_effects()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_end date := coalesce(new.end_date, current_date);
begin
  if not (new.status in ('resigned','terminated') and old.status not in ('resigned','terminated')) then return new; end if;
  perform set_config('hr.change_reason', coalesce(nullif(current_setting('hr.change_reason', true), ''), 'Employment ended'), true);
  update public.hr_employee_compensation c
     set end_date = greatest(c.effective_date, v_end), updated_at = now()
   where c.employee_id = new.user_id and c.organization_id = new.organization_id and c.status = 'active'
     and (c.end_date is null or c.end_date > v_end);
  update public.hr_employee_allowances a
     set end_date = greatest(a.effective_date, v_end), updated_at = now()
   where a.employee_id = new.user_id and a.organization_id = new.organization_id and a.is_active is true
     and (a.end_date is null or a.end_date > v_end);
  update public.hr_employee_deductions d
     set end_date = greatest(d.effective_date, v_end), updated_at = now()
   where d.employee_id = new.user_id and d.organization_id = new.organization_id and d.is_active is true
     and (d.end_date is null or d.end_date > v_end);
  update public.hr_position_assignments p
     set effective_to = greatest(p.effective_from, v_end),
         status = case when greatest(p.effective_from, v_end) <= current_date then 'ended' else p.status end,
         updated_at = now()
   where p.employee_user_id = new.user_id and p.status = 'active'
     and (p.effective_to is null or p.effective_to > v_end);
  return new;
end $fn$;
revoke all on function public.hr_employees_end_effects() from public, anon, authenticated, service_role;

drop trigger if exists hr_employees_end_effects on public.hr_employees;
create trigger hr_employees_end_effects after update of status on public.hr_employees
  for each row execute function public.hr_employees_end_effects();

-- Versions of a permanently deleted employment record go with it (permanent deletion is refused while HR history exists).
create or replace function public.hr_employees_purge_versions()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
begin
  perform set_config('hr.history_purge', 'on', true);
  delete from public.hr_employee_versions where employment_ref = old.id;
  perform set_config('hr.history_purge', 'off', true);
  return old;
end $fn$;
revoke all on function public.hr_employees_purge_versions() from public, anon, authenticated, service_role;
drop trigger if exists hr_employees_purge_versions on public.hr_employees;
create trigger hr_employees_purge_versions after delete on public.hr_employees
  for each row execute function public.hr_employees_purge_versions();

-- ---------------------------------------------------------------------------
-- 4. Reporting lines: review, controlled changes, log
-- ---------------------------------------------------------------------------
create table if not exists public.hr_reporting_line_changes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  employee_ref uuid not null,
  from_manager_ref uuid,
  to_manager_ref uuid,
  source text not null check (source in ('set', 'reassign_direct_reports', 'employment_change', 'reconciliation')),
  reason text not null check (length(btrim(reason)) between 5 and 500),
  actor_ref uuid not null,
  occurred_at timestamptz not null default now()
);
create index if not exists hr_reporting_line_changes_org_idx on public.hr_reporting_line_changes (organization_id, occurred_at desc);
alter table public.hr_reporting_line_changes enable row level security;
alter table public.hr_reporting_line_changes force row level security;
revoke all on table public.hr_reporting_line_changes from public, anon, authenticated;
grant select on table public.hr_reporting_line_changes to service_role;
drop trigger if exists hr_reporting_line_changes_append_only on public.hr_reporting_line_changes;
create trigger hr_reporting_line_changes_append_only before update or delete on public.hr_reporting_line_changes
  for each row execute function public.hr_history_append_only();

-- Findings for one organization's employees (read-only). Position-derived expected manager: the employee's active PRIMARY
-- position → its active PRIMARY parent position → that position's single active PRIMARY incumbent.
create or replace function public.hr_reporting_line_review(p_org uuid)
returns table(employee_user_id uuid, employee_name text, employee_no integer, manager_user_id uuid, manager_name text,
              issue_code text, expected_manager_user_id uuid, expected_manager_name text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  with emp as (
    select e.user_id, e.employee_no, e.manager_user_id, e.organization_id, u.full_name
    from public.hr_employees e join public.users u on u.id = e.user_id
    where e.organization_id = p_org and e.status not in ('resigned','terminated') and e.onboarding_status = 'completed'
      and coalesce(u.account_status, 'ACTIVE') <> 'ARCHIVED'
  ), expected as (
    select a.employee_user_id, min(pi.employee_user_id::text)::uuid as exp_mgr, count(distinct pi.employee_user_id) as n
    from public.hr_position_assignments a
    join public.hr_position_relationships r on r.position_id = a.position_id and r.relationship_type = 'PRIMARY'
         and r.is_active and r.effective_from <= current_date and coalesce(r.effective_to, 'infinity'::date) >= current_date
    join public.hr_position_assignments pi on pi.position_id = r.parent_position_id and pi.assignment_type = 'PRIMARY'
         and pi.status = 'active' and pi.effective_from <= current_date and coalesce(pi.effective_to, 'infinity'::date) >= current_date
    join public.users pu on pu.id = pi.employee_user_id and coalesce(pu.account_status, 'ACTIVE') <> 'ARCHIVED'
    where a.organization_id = p_org and a.assignment_type = 'PRIMARY' and a.status = 'active'
      and a.effective_from <= current_date and coalesce(a.effective_to, 'infinity'::date) >= current_date
    group by a.employee_user_id
  ), findings as (
    select emp.*, x.exp_mgr,
      case
        when emp.manager_user_id is null then 'NO_MANAGER'
        else public.hr_manager_assignment_error(emp.user_id, emp.organization_id, emp.manager_user_id)
      end as base_issue,
      x.n
    from emp left join expected x on x.employee_user_id = emp.user_id
  )
  select f.user_id, f.full_name, f.employee_no, f.manager_user_id, mu.full_name,
         case
           when f.base_issue = 'NO_MANAGER' and f.exp_mgr is not null and f.n = 1 then 'NO_MANAGER_POSITION_SUGGESTS'
           when f.base_issue is not null then upper(replace(f.base_issue, 'hr_manager_', 'MANAGER_'))
           when f.exp_mgr is not null and f.n = 1 and f.exp_mgr is distinct from f.manager_user_id then 'POSITION_DIVERGENCE'
         end,
         case when f.n = 1 then f.exp_mgr end, xu.full_name
  from findings f
  left join public.users mu on mu.id = f.manager_user_id
  left join public.users xu on xu.id = f.exp_mgr and f.n = 1
  where f.base_issue is not null or (f.exp_mgr is not null and f.n = 1 and f.exp_mgr is distinct from f.manager_user_id)
  order by 6, 2
$fn$;
revoke all on function public.hr_reporting_line_review(uuid) from public, anon, authenticated;
grant execute on function public.hr_reporting_line_review(uuid) to service_role;

-- Explicit (non-legacy) S&A authority of a given actor — same rule as B2A hr_leave_actor_has_explicit, for server-called
-- functions: Root Access, or an ACTIVE assignment of a non-legacy policy in scope. Legacy-compatibility policies never
-- count (BL-11 / D-024), and the legacy evaluator is never consulted.
create or replace function public.hr_actor_has_explicit(p_actor uuid, p_permission text, p_context jsonb)
returns boolean language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v jsonb;
begin
  if p_actor is null or p_permission is null then return false; end if;
  if not exists (select 1 from public.users u where u.id = p_actor and u.is_active is true
                 and coalesce(u.account_status, 'ACTIVE') <> 'ARCHIVED') then
    return false;
  end if;
  v := public.sa_evaluate_permission_core(p_actor, p_permission, coalesce(p_context, '{}'::jsonb), false, false);
  if v->>'decision' <> 'ALLOW' then return false; end if;
  if v->>'reason_code' = 'ALLOWED_BY_ROOT_ACCESS' then return true; end if;
  return v->>'reason_code' = 'ALLOWED_BY_ASSIGNMENT' and exists (
    select 1 from jsonb_array_elements(coalesce(v->'matched_assignments', '[]'::jsonb)) m
    join public.sa_business_roles br on br.id = nullif(m->>'roleId', '')::uuid
    where br.status = 'active' and br.source <> 'legacy');
end $fn$;
revoke all on function public.hr_actor_has_explicit(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.hr_actor_has_explicit(uuid, text, jsonb) to service_role;

create or replace function public.hr_assert_hr_manage(p_actor uuid, p_org uuid)
returns void language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
begin
  if p_actor is null or p_org is null then raise exception 'hr_actor_and_organization_required' using errcode = '22023'; end if;
  -- Canonical S&A in the TARGET organization (an organization scope covers its descendants); explicit authority only.
  if not public.hr_actor_has_explicit(p_actor, 'hr.employee.manage', jsonb_build_object('organization_id', p_org)) then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.employee.manage';
  end if;
end $fn$;
revoke all on function public.hr_assert_hr_manage(uuid, uuid) from public, anon, authenticated;
grant execute on function public.hr_assert_hr_manage(uuid, uuid) to service_role;

create or replace function public.hr_set_reporting_line(p_actor uuid, p_employee_user uuid, p_manager_user uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare e record;
begin
  if p_reason is null or length(btrim(p_reason)) < 5 then raise exception 'hr_reason_required' using errcode = '22023'; end if;
  select x.id, x.organization_id, x.manager_user_id into e from public.hr_employees x
  where x.user_id = p_employee_user and x.status not in ('resigned','terminated')
  order by x.updated_at desc limit 1 for update;
  if not found then raise exception 'hr_employment_not_found' using errcode = '22023'; end if;
  perform public.hr_assert_hr_manage(p_actor, e.organization_id);
  if p_actor = p_employee_user then raise exception 'hr_self_change_prohibited' using errcode = '42501'; end if;
  if e.manager_user_id is not distinct from p_manager_user then return jsonb_build_object('status', 'unchanged'); end if;
  perform set_config('hr.change_reason', left(btrim(p_reason), 500), true);
  update public.hr_employees set manager_user_id = p_manager_user, updated_at = now() where id = e.id;
  insert into public.hr_reporting_line_changes(organization_id, employee_ref, from_manager_ref, to_manager_ref, source, reason, actor_ref)
  values (e.organization_id, p_employee_user, e.manager_user_id, p_manager_user, 'set', left(btrim(p_reason), 500), p_actor);
  perform set_config('hr.change_reason', '', true);
  return jsonb_build_object('status', 'changed', 'from', e.manager_user_id, 'to', p_manager_user);
end $fn$;
revoke all on function public.hr_set_reporting_line(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.hr_set_reporting_line(uuid, uuid, uuid, text) to service_role;

-- Re-point the (selected) direct reports of one manager to another manager (or to nobody). All-or-nothing.
create or replace function public.hr_reassign_direct_reports(p_actor uuid, p_from_manager uuid, p_to_manager uuid, p_reason text,
                                                             p_employee_users uuid[] default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare r record; v_n integer := 0;
begin
  if p_reason is null or length(btrim(p_reason)) < 5 then raise exception 'hr_reason_required' using errcode = '22023'; end if;
  if p_from_manager is null then raise exception 'hr_manager_required' using errcode = '22023'; end if;
  if p_from_manager is not distinct from p_to_manager then raise exception 'hr_reassign_same_manager' using errcode = '22023'; end if;
  perform set_config('hr.change_reason', left(btrim(p_reason), 500), true);
  for r in
    select x.id, x.user_id, x.organization_id from public.hr_employees x
    where x.manager_user_id = p_from_manager and x.status not in ('resigned','terminated')
      and (p_employee_users is null or x.user_id = any(p_employee_users))
    order by x.user_id for update
  loop
    perform public.hr_assert_hr_manage(p_actor, r.organization_id);
    if r.user_id = p_actor then raise exception 'hr_self_change_prohibited' using errcode = '42501'; end if;
    update public.hr_employees set manager_user_id = p_to_manager, updated_at = now() where id = r.id;
    insert into public.hr_reporting_line_changes(organization_id, employee_ref, from_manager_ref, to_manager_ref, source, reason, actor_ref)
    values (r.organization_id, r.user_id, p_from_manager, p_to_manager, 'reassign_direct_reports', left(btrim(p_reason), 500), p_actor);
    v_n := v_n + 1;
  end loop;
  perform set_config('hr.change_reason', '', true);
  return jsonb_build_object('status', case when v_n = 0 then 'nothing_to_do' else 'reassigned' end, 'count', v_n);
end $fn$;
revoke all on function public.hr_reassign_direct_reports(uuid, uuid, uuid, text, uuid[]) from public, anon, authenticated;
grant execute on function public.hr_reassign_direct_reports(uuid, uuid, uuid, text, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Controlled, effective-dated employment change
-- ---------------------------------------------------------------------------
create or replace function public.hr_employment_change(p_actor uuid, p_employee_user uuid, p_changes jsonb,
                                                       p_effective_date date, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  e record;
  k text;
  c_allowed constant text[] := array['department_id','position_id','manager_user_id','employment_type','probation_end','status'];
  v_status text;
  v_dept uuid; v_pos uuid; v_mgr uuid; v_type text; v_prob date;
  v_after record;
begin
  if p_reason is null or length(btrim(p_reason)) < 5 then raise exception 'hr_reason_required' using errcode = '22023'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'hr_changes_required' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not (k = any(c_allowed)) then raise exception 'hr_change_field_not_allowed' using errcode = '22023', detail = k; end if;
  end loop;
  if p_effective_date is null or p_effective_date > current_date then
    -- Future-dated (scheduled) changes need a scheduler (PD-LC-01); not silently applied early.
    raise exception 'hr_effective_date_invalid' using errcode = '22023', detail = 'The effective date must be today or earlier.';
  end if;
  select x.* into e from public.hr_employees x where x.user_id = p_employee_user and x.status not in ('resigned','terminated')
  order by x.updated_at desc limit 1 for update;
  if not found then raise exception 'hr_employment_not_found' using errcode = '22023'; end if;
  perform public.hr_assert_hr_manage(p_actor, e.organization_id);
  if p_actor = p_employee_user then raise exception 'hr_self_change_prohibited' using errcode = '42501'; end if;
  if e.onboarding_status <> 'completed' then raise exception 'hr_onboarding_pending' using errcode = '22023'; end if;
  if p_effective_date < coalesce(e.hire_date, p_effective_date) then
    raise exception 'hr_effective_date_invalid' using errcode = '22023', detail = 'The effective date cannot be before the hire date.';
  end if;

  v_status := coalesce(p_changes->>'status', e.status);
  if v_status not in ('active','probation','suspended') then
    raise exception 'hr_status_change_not_allowed' using errcode = '22023',
      detail = 'End employment through Archive & Revoke Access (or the offboarding flow), not as a field change.';
  end if;
  v_dept := case when p_changes ? 'department_id' then nullif(p_changes->>'department_id', '')::uuid else e.department_id end;
  v_pos := case when p_changes ? 'position_id' then nullif(p_changes->>'position_id', '')::uuid else e.position_id end;
  v_mgr := case when p_changes ? 'manager_user_id' then nullif(p_changes->>'manager_user_id', '')::uuid else e.manager_user_id end;
  v_type := case when p_changes ? 'employment_type' then nullif(p_changes->>'employment_type', '') else e.employment_type end;
  v_prob := case when p_changes ? 'probation_end' then nullif(p_changes->>'probation_end', '')::date else e.probation_end end;
  -- References must belong to the employee's company (HQ group).
  if v_dept is not null and not exists (select 1 from public.departments d where d.id = v_dept
       and coalesce(public.get_company_id(d.organization_id), d.organization_id) = coalesce(public.get_company_id(e.organization_id), e.organization_id)) then
    raise exception 'hr_reference_outside_company' using errcode = '23514', detail = 'department';
  end if;
  if v_pos is not null and not exists (select 1 from public.hr_positions p where p.id = v_pos
       and coalesce(public.get_company_id(p.organization_id), p.organization_id) = coalesce(public.get_company_id(e.organization_id), e.organization_id)) then
    raise exception 'hr_reference_outside_company' using errcode = '23514', detail = 'position';
  end if;

  perform set_config('hr.change_reason', left(btrim(p_reason), 500), true);
  perform set_config('hr.change_effective_date', to_char(p_effective_date, 'YYYY-MM-DD'), true);
  update public.hr_employees set department_id = v_dept, position_id = v_pos, manager_user_id = v_mgr, employment_type = v_type,
         probation_end = v_prob, status = v_status, updated_at = now()
   where id = e.id;
  if v_mgr is distinct from e.manager_user_id then
    insert into public.hr_reporting_line_changes(organization_id, employee_ref, from_manager_ref, to_manager_ref, source, reason, actor_ref)
    values (e.organization_id, p_employee_user, e.manager_user_id, v_mgr, 'employment_change', left(btrim(p_reason), 500), p_actor);
  end if;
  perform set_config('hr.change_reason', '', true);
  perform set_config('hr.change_effective_date', '', true);
  select v.version_no, v.change_kind into v_after from public.hr_employee_versions v where v.employment_ref = e.id
  order by v.version_no desc limit 1;
  return jsonb_build_object('status', 'changed', 'version_no', v_after.version_no, 'change_kind', v_after.change_kind);
end $fn$;
revoke all on function public.hr_employment_change(uuid, uuid, jsonb, date, text) from public, anon, authenticated;
grant execute on function public.hr_employment_change(uuid, uuid, jsonb, date, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Compensation integrity
-- ---------------------------------------------------------------------------
do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'hr_emp_comp_dates_chk' and conrelid = 'public.hr_employee_compensation'::regclass) then
    alter table public.hr_employee_compensation add constraint hr_emp_comp_dates_chk
      check (end_date is null or end_date >= effective_date) not valid;
  end if;
end $c$;
do $v$
begin
  if not exists (select 1 from public.hr_employee_compensation where end_date is not null and end_date < effective_date) then
    alter table public.hr_employee_compensation validate constraint hr_emp_comp_dates_chk;
  end if;
end $v$;

create or replace function public.hr_employee_compensation_no_overlap()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
begin
  if new.status <> 'active' then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('hr_compensation:' || new.employee_id::text, 0));
  if exists (select 1 from public.hr_employee_compensation c
             where c.employee_id = new.employee_id and c.id is distinct from new.id and c.status = 'active'
               and c.effective_date <= coalesce(new.end_date, 'infinity'::date)
               and new.effective_date <= coalesce(c.end_date, 'infinity'::date)) then
    raise exception 'hr_compensation_overlap' using errcode = '23P01',
      detail = 'Another active salary record already covers part of this period. End or supersede it first.';
  end if;
  return new;
end $fn$;
revoke all on function public.hr_employee_compensation_no_overlap() from public, anon, authenticated, service_role;
drop trigger if exists hr_employee_compensation_no_overlap on public.hr_employee_compensation;
create trigger hr_employee_compensation_no_overlap before insert or update of employee_id, effective_date, end_date, status
  on public.hr_employee_compensation for each row execute function public.hr_employee_compensation_no_overlap();

create table if not exists public.hr_compensation_change_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  compensation_ref uuid not null,
  employee_ref uuid not null,
  action text not null check (action in ('insert','update','delete')),
  changed_columns text[] not null default '{}',
  old_values jsonb,
  new_values jsonb,
  reason text,
  actor_ref uuid,
  actor_db_role text not null,
  occurred_at timestamptz not null default now()
);
create index if not exists hr_compensation_change_log_emp_idx on public.hr_compensation_change_log (employee_ref, occurred_at desc);
alter table public.hr_compensation_change_log enable row level security;
alter table public.hr_compensation_change_log force row level security;
revoke all on table public.hr_compensation_change_log from public, anon, authenticated;
grant select on table public.hr_compensation_change_log to service_role;
drop trigger if exists hr_compensation_change_log_append_only on public.hr_compensation_change_log;
create trigger hr_compensation_change_log_append_only before update or delete on public.hr_compensation_change_log
  for each row execute function public.hr_history_append_only();

create or replace function public.hr_employee_compensation_log()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  c_cols constant text[] := array['salary_band_id','pay_type','basic_salary','hourly_rate','currency','ot_eligible',
                                  'effective_date','end_date','status'];
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_changed text[];
  r record;
begin
  r := coalesce(new, old);
  select coalesce(array_agg(k), '{}') into v_changed from unnest(c_cols) k
  where (v_old->k) is distinct from (v_new->k);
  if tg_op = 'UPDATE' and cardinality(v_changed) = 0 then return new; end if;
  insert into public.hr_compensation_change_log(organization_id, compensation_ref, employee_ref, action, changed_columns,
    old_values, new_values, reason, actor_ref, actor_db_role)
  values (r.organization_id, r.id, r.employee_id, lower(tg_op), v_changed,
    (select jsonb_object_agg(k, v_old->k) from unnest(c_cols) k where v_old is not null),
    (select jsonb_object_agg(k, v_new->k) from unnest(c_cols) k where v_new is not null),
    left(nullif(btrim(coalesce(current_setting('hr.change_reason', true), '')), ''), 500), auth.uid(), public.hr_request_db_role());
  return coalesce(new, old);
end $fn$;
revoke all on function public.hr_employee_compensation_log() from public, anon, authenticated, service_role;
drop trigger if exists hr_employee_compensation_log on public.hr_employee_compensation;
create trigger hr_employee_compensation_log after insert or update or delete on public.hr_employee_compensation
  for each row execute function public.hr_employee_compensation_log();

-- ---------------------------------------------------------------------------
-- 7. Statutory & personal master data (capture only; no calculation)
-- ---------------------------------------------------------------------------
create table if not exists public.hr_employee_statutory_profiles (
  user_id uuid primary key references public.users(id),   -- no cascade: HR master data blocks permanent deletion
  organization_id uuid not null,
  id_type text check (id_type is null or id_type in ('nric','passport','other')),
  nric_no text check (nric_no is null or nric_no ~ '^\d{12}$'),
  passport_no text check (passport_no is null or length(passport_no) between 5 and 20),
  passport_country text check (passport_country is null or passport_country ~ '^[A-Z]{2}$'),
  passport_expiry date,
  date_of_birth date check (date_of_birth is null or date_of_birth > date '1900-01-01'),
  gender text check (gender is null or gender in ('male','female','other')),
  nationality text check (nationality is null or length(btrim(nationality)) between 2 and 60),
  citizenship_status text check (citizenship_status is null or citizenship_status in ('citizen','permanent_resident','foreigner')),
  tax_residency text check (tax_residency is null or tax_residency in ('resident','non_resident')),
  marital_status text check (marital_status is null or marital_status in ('single','married','divorced','widowed')),
  spouse_working boolean,
  children_count integer check (children_count is null or children_count between 0 and 30),
  disabled_self boolean,
  epf_no text check (epf_no is null or epf_no ~ '^[0-9A-Z]{5,20}$'),
  socso_no text check (socso_no is null or socso_no ~ '^[0-9A-Z]{5,20}$'),
  eis_applicable boolean,
  eis_no text check (eis_no is null or eis_no ~ '^[0-9A-Z]{5,20}$'),
  income_tax_no text check (income_tax_no is null or income_tax_no ~ '^[0-9A-Z]{5,20}$'),
  work_state text check (work_state is null or work_state in ('JHR','KDH','KTN','MLK','NSN','PHG','PNG','PRK','PLS','SBH',
                                                              'SWK','SGR','TRG','KUL','LBN','PJY')),
  effective_from date not null default current_date,
  updated_at timestamptz not null default now(),
  updated_by_ref uuid
);
alter table public.hr_employee_statutory_profiles enable row level security;
alter table public.hr_employee_statutory_profiles force row level security;
revoke all on table public.hr_employee_statutory_profiles from public, anon, authenticated;
grant select, insert, update on table public.hr_employee_statutory_profiles to service_role;
create index if not exists hr_employee_statutory_profiles_org_idx on public.hr_employee_statutory_profiles (organization_id);

create table if not exists public.hr_statutory_profile_changes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  person_ref uuid not null,
  action text not null check (action in ('insert','update')),
  changed_columns text[] not null,        -- names only: statutory VALUES are not copied into the log
  reason text,
  actor_ref uuid,
  actor_db_role text not null,
  occurred_at timestamptz not null default now()
);
create index if not exists hr_statutory_profile_changes_person_idx on public.hr_statutory_profile_changes (person_ref, occurred_at desc);
alter table public.hr_statutory_profile_changes enable row level security;
alter table public.hr_statutory_profile_changes force row level security;
revoke all on table public.hr_statutory_profile_changes from public, anon, authenticated;
grant select on table public.hr_statutory_profile_changes to service_role;
drop trigger if exists hr_statutory_profile_changes_append_only on public.hr_statutory_profile_changes;
create trigger hr_statutory_profile_changes_append_only before update or delete on public.hr_statutory_profile_changes
  for each row execute function public.hr_history_append_only();

create or replace function public.hr_statutory_profiles_log()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_changed text[]; v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end; v_new jsonb := to_jsonb(new);
begin
  select coalesce(array_agg(k order by k), '{}') into v_changed from jsonb_object_keys(v_new) k
  where k not in ('updated_at','updated_by_ref') and (v_old->k) is distinct from (v_new->k);
  if tg_op = 'UPDATE' and cardinality(v_changed) = 0 then return new; end if;
  insert into public.hr_statutory_profile_changes(organization_id, person_ref, action, changed_columns, reason, actor_ref, actor_db_role)
  values (new.organization_id, new.user_id, lower(tg_op), v_changed,
          left(nullif(btrim(coalesce(current_setting('hr.change_reason', true), '')), ''), 500),
          coalesce(new.updated_by_ref, auth.uid()), public.hr_request_db_role());
  return new;
end $fn$;
revoke all on function public.hr_statutory_profiles_log() from public, anon, authenticated, service_role;
drop trigger if exists hr_statutory_profiles_log on public.hr_employee_statutory_profiles;
create trigger hr_statutory_profiles_log after insert or update on public.hr_employee_statutory_profiles
  for each row execute function public.hr_statutory_profiles_log();

-- ---------------------------------------------------------------------------
-- 7b. Server entry points (service_role only). The database decides: explicit S&A authority in the employee's
--     organization (legacy never counts) or the employee themself where self-service applies.
-- ---------------------------------------------------------------------------
create or replace function public.hr_employment_target(p_employee_user uuid)
returns record language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select x.id, x.organization_id from public.hr_employees x where x.user_id = p_employee_user
  order by (x.status in ('resigned','terminated')), x.updated_at desc limit 1
$fn$;
revoke all on function public.hr_employment_target(uuid) from public, anon, authenticated;

create or replace function public.hr_can_view_employee(p_actor uuid, p_org uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select p_org is not null and (
         public.hr_actor_has_explicit(p_actor, 'hr.employee.manage', jsonb_build_object('organization_id', p_org))
      or public.hr_actor_has_explicit(p_actor, 'hr.employee.view', jsonb_build_object('organization_id', p_org)))
$fn$;
revoke all on function public.hr_can_view_employee(uuid, uuid) from public, anon, authenticated;
grant execute on function public.hr_can_view_employee(uuid, uuid) to service_role;

-- Employment history of one person (all employment records), newest first. Self or explicit HR (view/manage).
create or replace function public.hr_employee_history(p_actor uuid, p_employee_user uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_org uuid; v_emp uuid;
begin
  if p_actor is null or p_employee_user is null then raise exception 'hr_actor_and_employee_required' using errcode = '22023'; end if;
  select t.id, t.organization_id into v_emp, v_org from public.hr_employment_target(p_employee_user) as t(id uuid, organization_id uuid);
  if v_emp is null then raise exception 'hr_employment_not_found' using errcode = '22023'; end if;
  if p_actor <> p_employee_user and not public.hr_can_view_employee(p_actor, v_org) then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.employee.view';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'version_no', v.version_no, 'change_kind', v.change_kind, 'effective_date', v.effective_date, 'recorded_at', v.recorded_at,
      'status', v.status, 'employment_type', v.employment_type,
      'department_id', v.department_id, 'department_name', d.dept_name,
      'position_id', v.position_id, 'position_name', p.name,
      'manager_user_id', v.manager_ref, 'manager_name', m.full_name,
      'hire_date', v.hire_date, 'end_date', v.end_date, 'probation_end', v.probation_end,
      'onboarding_status', v.onboarding_status, 'organization_id', v.organization_id,
      'changed_columns', to_jsonb(v.changed_columns), 'reason', v.reason,
      'actor_name', case when p_actor = p_employee_user then null else a.full_name end)
      order by v.effective_date desc, v.version_no desc)
    from public.hr_employee_versions v
    left join public.departments d on d.id = v.department_id
    left join public.hr_positions p on p.id = v.position_id
    left join public.users m on m.id = v.manager_ref
    left join public.users a on a.id = v.actor_ref
    where v.person_ref = p_employee_user), '[]'::jsonb);
end $fn$;
revoke all on function public.hr_employee_history(uuid, uuid) from public, anon, authenticated;
grant execute on function public.hr_employee_history(uuid, uuid) to service_role;

-- Statutory profile: self (read only) or explicit HR (hr.employee.manage) in the employee's organization.
create or replace function public.hr_statutory_profile_get(p_actor uuid, p_employee_user uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_org uuid; v_emp uuid; r jsonb;
begin
  if p_actor is null or p_employee_user is null then raise exception 'hr_actor_and_employee_required' using errcode = '22023'; end if;
  select t.id, t.organization_id into v_emp, v_org from public.hr_employment_target(p_employee_user) as t(id uuid, organization_id uuid);
  if v_emp is null then raise exception 'hr_employment_not_found' using errcode = '22023'; end if;
  if p_actor <> p_employee_user
     and not public.hr_actor_has_explicit(p_actor, 'hr.employee.manage', jsonb_build_object('organization_id', v_org)) then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.employee.manage';
  end if;
  select to_jsonb(sp) - 'updated_by_ref' into r from public.hr_employee_statutory_profiles sp where sp.user_id = p_employee_user;
  return jsonb_build_object('profile', r, 'can_edit', p_actor <> p_employee_user);
end $fn$;
revoke all on function public.hr_statutory_profile_get(uuid, uuid) from public, anon, authenticated;
grant execute on function public.hr_statutory_profile_get(uuid, uuid) to service_role;

create or replace function public.hr_statutory_profile_save(p_actor uuid, p_employee_user uuid, p_profile jsonb, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_org uuid; v_emp uuid; k text;
  c_fields constant text[] := array['id_type','nric_no','passport_no','passport_country','passport_expiry','date_of_birth','gender',
    'nationality','citizenship_status','tax_residency','marital_status','spouse_working','children_count','disabled_self','epf_no',
    'socso_no','eis_applicable','eis_no','income_tax_no','work_state','effective_from'];
  v_row public.hr_employee_statutory_profiles;
  v_exists boolean;
begin
  if p_reason is null or length(btrim(p_reason)) < 5 then raise exception 'hr_reason_required' using errcode = '22023'; end if;
  if p_profile is null or jsonb_typeof(p_profile) <> 'object' then raise exception 'hr_changes_required' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p_profile) loop
    if not (k = any(c_fields)) then raise exception 'hr_change_field_not_allowed' using errcode = '22023', detail = k; end if;
  end loop;
  select t.id, t.organization_id into v_emp, v_org from public.hr_employment_target(p_employee_user) as t(id uuid, organization_id uuid);
  if v_emp is null then raise exception 'hr_employment_not_found' using errcode = '22023'; end if;
  perform public.hr_assert_hr_manage(p_actor, v_org);
  if p_actor = p_employee_user then raise exception 'hr_self_change_prohibited' using errcode = '42501'; end if;
  select exists (select 1 from public.hr_employee_statutory_profiles where user_id = p_employee_user) into v_exists;
  -- Merge the given fields onto the current row (absent keys keep their value; JSON null clears a field).
  select * into v_row from jsonb_populate_record(
           coalesce((select sp from public.hr_employee_statutory_profiles sp where sp.user_id = p_employee_user),
                    row(p_employee_user, v_org, null, null, null, null, null, null, null, null, null, null, null, null, null,
                        null, null, null, null, null, null, null, current_date, now(), null)::public.hr_employee_statutory_profiles),
           p_profile);
  v_row.user_id := p_employee_user;
  v_row.organization_id := v_org;
  v_row.updated_at := now();
  v_row.updated_by_ref := p_actor;
  v_row.effective_from := coalesce(v_row.effective_from, current_date);
  perform set_config('hr.change_reason', left(btrim(p_reason), 500), true);
  if v_exists then
    update public.hr_employee_statutory_profiles sp set
      id_type = v_row.id_type, nric_no = v_row.nric_no, passport_no = v_row.passport_no, passport_country = v_row.passport_country,
      passport_expiry = v_row.passport_expiry, date_of_birth = v_row.date_of_birth, gender = v_row.gender, nationality = v_row.nationality,
      citizenship_status = v_row.citizenship_status, tax_residency = v_row.tax_residency, marital_status = v_row.marital_status,
      spouse_working = v_row.spouse_working, children_count = v_row.children_count, disabled_self = v_row.disabled_self,
      epf_no = v_row.epf_no, socso_no = v_row.socso_no, eis_applicable = v_row.eis_applicable, eis_no = v_row.eis_no,
      income_tax_no = v_row.income_tax_no,
      work_state = v_row.work_state, effective_from = v_row.effective_from, organization_id = v_row.organization_id,
      updated_at = v_row.updated_at, updated_by_ref = v_row.updated_by_ref
    where sp.user_id = p_employee_user;
  else
    insert into public.hr_employee_statutory_profiles select v_row.*;
  end if;
  perform set_config('hr.change_reason', '', true);
  return jsonb_build_object('status', case when v_exists then 'updated' else 'created' end);
end $fn$;
revoke all on function public.hr_statutory_profile_save(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.hr_statutory_profile_save(uuid, uuid, jsonb, text) to service_role;

-- Reporting-line review through the server: explicit HR (view/manage) in that organization.
create or replace function public.hr_reporting_line_review_for(p_actor uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
begin
  if not public.hr_can_view_employee(p_actor, p_org) then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.employee.view';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(r)) from public.hr_reporting_line_review(p_org) r), '[]'::jsonb);
end $fn$;
revoke all on function public.hr_reporting_line_review_for(uuid, uuid) from public, anon, authenticated;
grant execute on function public.hr_reporting_line_review_for(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7c. Personal HR profile (contact, address, emergency contact, bank, education, notes). The HR People "HR Profile"
--     sheet wrote to public.hr_employee_profiles, which never existed (BL-17): saving always failed. Statutory fields of
--     that sheet (NRIC, passport, tax, EPF, SOCSO, EIS, gender, DOB, nationality, marital status) are stored ONLY in
--     hr_employee_statutory_profiles — one source, no duplicate master data.
-- ---------------------------------------------------------------------------
create table if not exists public.hr_employee_profiles (
  user_id uuid primary key references public.users(id),   -- no cascade: HR data blocks permanent deletion
  organization_id uuid not null,
  blood_type text check (blood_type is null or blood_type in ('A+','A-','B+','B-','AB+','AB-','O+','O-')),
  religion text check (religion is null or length(religion) <= 60),
  personal_email text check (personal_email is null or personal_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  personal_phone text check (personal_phone is null or length(personal_phone) <= 30),
  address_line1 text check (address_line1 is null or length(address_line1) <= 200),
  address_line2 text check (address_line2 is null or length(address_line2) <= 200),
  city text check (city is null or length(city) <= 100),
  state text check (state is null or length(state) <= 100),
  postcode text check (postcode is null or length(postcode) <= 20),
  country text check (country is null or length(country) <= 100),
  emergency_name text check (emergency_name is null or length(emergency_name) <= 200),
  emergency_relationship text check (emergency_relationship is null or length(emergency_relationship) <= 60),
  emergency_phone text check (emergency_phone is null or length(emergency_phone) <= 30),
  emergency_address text check (emergency_address is null or length(emergency_address) <= 400),
  bank_name text check (bank_name is null or length(bank_name) <= 100),
  bank_account_no text check (bank_account_no is null or bank_account_no ~ '^[0-9]{5,30}$'),
  bank_holder_name text check (bank_holder_name is null or length(bank_holder_name) <= 200),
  highest_education text check (highest_education is null or highest_education in
    ('primary','secondary','diploma','degree','masters','phd','professional')),
  education_institution text check (education_institution is null or length(education_institution) <= 200),
  education_field text check (education_field is null or length(education_field) <= 200),
  notes text check (notes is null or length(notes) <= 2000),
  updated_at timestamptz not null default now(),
  updated_by_ref uuid
);
alter table public.hr_employee_profiles enable row level security;
alter table public.hr_employee_profiles force row level security;
revoke all on table public.hr_employee_profiles from public, anon, authenticated;
grant select, insert, update on table public.hr_employee_profiles to service_role;

create or replace function public.hr_employee_profiles_log()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_changed text[]; v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end; v_new jsonb := to_jsonb(new);
begin
  select coalesce(array_agg('profile.' || k order by k), '{}') into v_changed from jsonb_object_keys(v_new) k
  where k not in ('updated_at','updated_by_ref','user_id','organization_id') and (v_old->k) is distinct from (v_new->k);
  if tg_op = 'UPDATE' and cardinality(v_changed) = 0 then return new; end if;
  insert into public.hr_statutory_profile_changes(organization_id, person_ref, action, changed_columns, reason, actor_ref, actor_db_role)
  values (new.organization_id, new.user_id, lower(tg_op), v_changed,
          left(nullif(btrim(coalesce(current_setting('hr.change_reason', true), '')), ''), 500),
          coalesce(new.updated_by_ref, auth.uid()), public.hr_request_db_role());
  return new;
end $fn$;
revoke all on function public.hr_employee_profiles_log() from public, anon, authenticated, service_role;
drop trigger if exists hr_employee_profiles_log on public.hr_employee_profiles;
create trigger hr_employee_profiles_log after insert or update on public.hr_employee_profiles
  for each row execute function public.hr_employee_profiles_log();

-- One read for the HR Profile sheet / ESS: personal profile + statutory profile + what the caller may edit.
create or replace function public.hr_employee_profile_get(p_actor uuid, p_employee_user uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_org uuid; v_emp uuid; v_hr boolean; v_self boolean := p_actor = p_employee_user;
begin
  if p_actor is null or p_employee_user is null then raise exception 'hr_actor_and_employee_required' using errcode = '22023'; end if;
  select t.id, t.organization_id into v_emp, v_org from public.hr_employment_target(p_employee_user) as t(id uuid, organization_id uuid);
  if v_emp is null then raise exception 'hr_employment_not_found' using errcode = '22023'; end if;
  v_hr := public.hr_actor_has_explicit(p_actor, 'hr.employee.manage', jsonb_build_object('organization_id', v_org));
  if not v_self and not v_hr then raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.employee.manage'; end if;
  return jsonb_build_object(
    'organization_id', v_org,
    'profile', (select to_jsonb(p) - 'updated_by_ref' from public.hr_employee_profiles p where p.user_id = p_employee_user),
    'statutory', (select to_jsonb(sp) - 'updated_by_ref' from public.hr_employee_statutory_profiles sp where sp.user_id = p_employee_user),
    'can_edit_personal', v_self or v_hr,
    'self_fields', to_jsonb(array['personal_email','personal_phone','address_line1','address_line2','city','state','postcode','country',
                                  'emergency_name','emergency_relationship','emergency_phone','emergency_address',
                                  'bank_name','bank_account_no','bank_holder_name']),
    'can_edit_all_personal', v_hr and not v_self,
    'can_edit_statutory', v_hr and not v_self,
    'archived', coalesce((select u.account_status = 'ARCHIVED' from public.users u where u.id = p_employee_user), false));
end $fn$;
revoke all on function public.hr_employee_profile_get(uuid, uuid) from public, anon, authenticated;
grant execute on function public.hr_employee_profile_get(uuid, uuid) to service_role;

create or replace function public.hr_employee_profile_save(p_actor uuid, p_employee_user uuid, p_personal jsonb, p_statutory jsonb, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_org uuid; v_emp uuid; v_hr boolean; v_self boolean := p_actor = p_employee_user; k text;
  c_self constant text[] := array['personal_email','personal_phone','address_line1','address_line2','city','state','postcode','country',
                                  'emergency_name','emergency_relationship','emergency_phone','emergency_address',
                                  'bank_name','bank_account_no','bank_holder_name'];
  c_all constant text[] := c_self || array['blood_type','religion','highest_education','education_institution','education_field','notes'];
  v_row public.hr_employee_profiles;
  v_exists boolean;
  v_stat jsonb := null;
begin
  if p_actor is null or p_employee_user is null then raise exception 'hr_actor_and_employee_required' using errcode = '22023'; end if;
  select t.id, t.organization_id into v_emp, v_org from public.hr_employment_target(p_employee_user) as t(id uuid, organization_id uuid);
  if v_emp is null then raise exception 'hr_employment_not_found' using errcode = '22023'; end if;
  if coalesce((select u.account_status = 'ARCHIVED' from public.users u where u.id = p_employee_user), false) then
    raise exception 'hr_employment_archived_locked' using errcode = '42501', detail = 'Former employees'' profiles are read-only.';
  end if;
  v_hr := public.hr_actor_has_explicit(p_actor, 'hr.employee.manage', jsonb_build_object('organization_id', v_org));
  if not v_self and not v_hr then raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.employee.manage'; end if;
  if p_personal is not null and jsonb_typeof(p_personal) = 'object' and p_personal <> '{}'::jsonb then
    for k in select jsonb_object_keys(p_personal) loop
      if not (k = any(case when v_self then c_self else c_all end)) then
        raise exception 'hr_change_field_not_allowed' using errcode = '42501', detail = k;
      end if;
    end loop;
    select exists (select 1 from public.hr_employee_profiles where user_id = p_employee_user) into v_exists;
    select * into v_row from jsonb_populate_record(
      coalesce((select p from public.hr_employee_profiles p where p.user_id = p_employee_user),
               jsonb_populate_record(null::public.hr_employee_profiles,
                 jsonb_build_object('user_id', p_employee_user, 'organization_id', v_org, 'updated_at', now()))),
      p_personal);
    v_row.user_id := p_employee_user; v_row.organization_id := v_org; v_row.updated_at := now(); v_row.updated_by_ref := p_actor;
    perform set_config('hr.change_reason', left(coalesce(nullif(btrim(p_reason), ''), case when v_self then 'Employee self-service update' else 'HR profile update' end), 500), true);
    if v_exists then
      update public.hr_employee_profiles p set
        blood_type = v_row.blood_type, religion = v_row.religion, personal_email = v_row.personal_email, personal_phone = v_row.personal_phone,
        address_line1 = v_row.address_line1, address_line2 = v_row.address_line2, city = v_row.city, state = v_row.state,
        postcode = v_row.postcode, country = v_row.country, emergency_name = v_row.emergency_name,
        emergency_relationship = v_row.emergency_relationship, emergency_phone = v_row.emergency_phone,
        emergency_address = v_row.emergency_address, bank_name = v_row.bank_name, bank_account_no = v_row.bank_account_no,
        bank_holder_name = v_row.bank_holder_name, highest_education = v_row.highest_education,
        education_institution = v_row.education_institution, education_field = v_row.education_field, notes = v_row.notes,
        organization_id = v_row.organization_id, updated_at = v_row.updated_at, updated_by_ref = v_row.updated_by_ref
      where p.user_id = p_employee_user;
    else
      insert into public.hr_employee_profiles select v_row.*;
    end if;
    perform set_config('hr.change_reason', '', true);
  end if;
  if p_statutory is not null and jsonb_typeof(p_statutory) = 'object' and p_statutory <> '{}'::jsonb then
    if v_self then raise exception 'hr_statutory_self_edit_refused' using errcode = '42501',
      detail = 'Statutory details (ID, tax, EPF, SOCSO, EIS) are changed by HR.'; end if;
    v_stat := public.hr_statutory_profile_save(p_actor, p_employee_user, p_statutory,
                                               coalesce(nullif(btrim(p_reason), ''), 'HR profile update'));
  end if;
  return jsonb_build_object('status', 'saved', 'statutory', v_stat);
end $fn$;
revoke all on function public.hr_employee_profile_save(uuid, uuid, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.hr_employee_profile_save(uuid, uuid, jsonb, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Payroll component classification readiness (slot only; P-F03 decides the model)
-- ---------------------------------------------------------------------------
alter table public.hr_allowance_types add column if not exists payroll_component_code text;
alter table public.hr_deduction_types add column if not exists payroll_component_code text;
do $p$
begin
  if not exists (select 1 from pg_constraint where conname = 'hr_allowance_types_component_code_chk') then
    alter table public.hr_allowance_types add constraint hr_allowance_types_component_code_chk
      check (payroll_component_code is null or payroll_component_code ~ '^[A-Z][A-Z0-9_]{1,39}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'hr_deduction_types_component_code_chk') then
    alter table public.hr_deduction_types add constraint hr_deduction_types_component_code_chk
      check (payroll_component_code is null or payroll_component_code ~ '^[A-Z][A-Z0-9_]{1,39}$');
  end if;
end $p$;

-- ---------------------------------------------------------------------------
-- 9. HR → Finance data contract (read-only; service_role only)
-- ---------------------------------------------------------------------------
create or replace view public.hr_employment_finance_contract_v1 as
select
  e.id as employment_id,
  e.user_id as person_id,
  e.employee_no,
  e.organization_id,
  coalesce(public.get_company_id(e.organization_id), e.organization_id) as company_id,
  e.status as employment_status,
  e.employment_type,
  e.hire_date,
  e.end_date,
  e.department_id,
  e.position_id,
  v.cost_center_ref,
  v.version_no as current_version_no,
  c.id as compensation_id,
  c.pay_type,
  c.currency,
  c.effective_date as compensation_effective_date,
  c.end_date as compensation_end_date,
  (sp.user_id is not null and (sp.nric_no is not null or sp.passport_no is not null) and sp.date_of_birth is not null
     and sp.citizenship_status is not null and sp.tax_residency is not null) as statutory_profile_complete,
  'v1'::text as contract_version
from public.hr_employees e
left join lateral (select x.cost_center_ref, x.version_no from public.hr_employee_versions x where x.employment_ref = e.id
                   order by x.version_no desc limit 1) v on true
left join lateral (select x.id, x.pay_type, x.currency, x.effective_date, x.end_date from public.hr_employee_compensation x
                   where x.employee_id = e.user_id and x.organization_id = e.organization_id and x.status = 'active'
                     and x.effective_date <= current_date and coalesce(x.end_date, 'infinity'::date) >= current_date
                   order by x.effective_date desc limit 1) c on true
left join public.hr_employee_statutory_profiles sp on sp.user_id = e.user_id
where e.onboarding_status = 'completed';
revoke all on public.hr_employment_finance_contract_v1 from public, anon, authenticated;
grant select on public.hr_employment_finance_contract_v1 to service_role;
comment on view public.hr_employment_finance_contract_v1 is
  'HR→Finance data contract v1 (read-only). Finance owns GL, chart of accounts and cost centres; cost_center_ref is a slot. No salary amounts, no statutory values.';

-- ---------------------------------------------------------------------------
-- 10. HR Data Management reset classification (new tables are KEPT)
-- ---------------------------------------------------------------------------
insert into public.hr_reset_scope(table_name, category, action, delete_order, label)
select v.t, 'not_in_scope', 'keep', null, v.l
from (values
  ('hr_employee_versions', 'Employment history (append-only, kept)'),
  ('hr_reporting_line_changes', 'Reporting-line change log (append-only, kept)'),
  ('hr_compensation_change_log', 'Compensation change log (append-only, kept)'),
  ('hr_employee_statutory_profiles', 'Statutory employee profile (master data, kept)'),
  ('hr_employee_profiles', 'Personal HR profile (master data, kept)'),
  ('hr_statutory_profile_changes', 'HR profile / statutory change log, column names only (append-only, kept)')) v(t, l)
where not exists (select 1 from public.hr_reset_scope s where s.table_name = v.t);

comment on table public.hr_employee_versions is 'Append-only, effective-dated employment history (20261221100000). Baseline at migration; no reconstruction.';
comment on table public.hr_employee_statutory_profiles is 'Statutory & personal master data capture (20261221100000). Service-role access only; S&A asserted by the server.';
