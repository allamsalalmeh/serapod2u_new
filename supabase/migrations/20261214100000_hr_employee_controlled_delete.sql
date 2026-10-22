-- ============================================================================
-- HR → People → Employees: controlled Delete Employee / Reset HR Registration
-- (one employee at a time)
-- ----------------------------------------------------------------------------
-- Audit result (why this is NOT a row delete)
--   * public.users is the central identity. Most HR tables reference it with
--     ON DELETE CASCADE (attendance, leave, payroll lines, compensation, …),
--     so deleting the identity would silently erase HR history; Supply Chain,
--     Finance and audit rows reference it too. It is never touched here.
--   * public.hr_employees is the employment ANCHOR of the identity: it owns
--     the employee number and projects department / position / manager /
--     employment type / status onto public.users (hr_employees_project_to_users),
--     which S&A department scope, approvals and the org chart read. Deleting
--     the row while the identity exists leaves users.employee_no pointing at a
--     number nobody owns, and the next users change of an employment column
--     (identity_users_forward_employment) or a re-insert recreates the row with a
--     NEW employee number. hr_commission_* reference hr_employees(id) as well.
--   * hr_employee_profiles does not exist in the staging schema (2026-10-22).
--   So the anchor and the identity stay; what HR "registered" is the explicit
--   onboarding state (20261003100000), and that is what these actions change.
--
-- Actions (database-owned; the server only calls them)
--   delete  "Delete Employee": removes the HR registration of an employee who has
--           NO HR records. onboarding_status completed|reset → pending, onboarding
--           columns cleared, hire date no longer confirmed. The person leaves the
--           Employees list and counts and returns to "Awaiting onboarding" (the
--           automatic anchor every internal identity has). Blocked by ANY HR row
--           that references the person (attendance, leave, payroll, compensation,
--           commission, performance, contracts, approvals, …: discovered from
--           pg_constraint at preview AND execution), by direct reports
--           (users.manager_user_id / hr_employees.manager_user_id), by HR being
--           live, and for the actor's own record.
--   reset   "Reset HR Registration": completed → reset for one employee, exactly
--           what the organization-wide onboarding reset does per person. HR history
--           is kept (read-only; new HR transactions need onboarding again).
--   Neither action changes: auth.users, public.users, credentials, account status,
--   organization membership, S&A assignments, employment facts and their users
--   projection, the employee number, HR history, Supply Chain / Finance / audit
--   rows. No DELETE statement is issued against any table. Re-onboarding through
--   Add Employee (hr_onboarding_complete) works from both resulting states and
--   reuses the same employee number.
--
-- Authorization (database, every call, every migration mode)
--   Explicit S&A decision for hr.employee.delete in the target organization
--   (sa_evaluate_permission(..., false): assignment or Root Access; no legacy
--   role level, no compatibility rule, no delegation). The permission is held only
--   by the new break-glass policy "HR Employee Record Administrator" (assigned to
--   nobody) and is recorded as a reviewed exclusion of HR & Payroll Full Access.
--   Target must be an employment record of that organization whose identity
--   belongs to it (other organizations are reported as not found). No self action.
--
-- Safety
--   preview token (fingerprint of the employment row + every dependency count),
--   idempotency key (request_id; a repeat returns the recorded outcome, a reuse
--   for another target/action is refused), per-employee advisory lock, row locks on
--   the identity and employment rows (every FK insert that references them waits,
--   so the dependency re-check is exact), SHARE locks on tables whose person
--   columns have no FK, lock_timeout, reason ≥ 10 characters, before-image of the
--   employment row, append-only action record (completed AND blocked attempts) and
--   onboarding log entry. Any failure rolls the whole call back.
--
-- Idempotent: yes. Apply manually (SQL editor / psql). Prerequisites:
--   20261003100000 (onboarding state), 20261009100000 + 20261110100000
--   (standard policy coverage / narrowing).
--
-- Rollback (reverse order):
--   drop function hr_employee_registration_execute, hr_employee_registration_preview,
--     hr_employee_registration_actor_check, hr_employee_registration_authorize,
--     hr_employee_registration_plan;
--   keep hr_employee_registration_actions (audit) or archive it before dropping;
--   restore hr_employee_onboarding_log_event_check without 'removed' only if no
--     'removed' rows exist;
--   delete the role grants / role 'hr-employee-record-administrator', its coverage
--     row, the hr.employee.delete readiness, mode and permission rows; remove
--     'hr.employee.delete' from hr-payroll-full-access excluded_keys.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Prerequisites
-- ---------------------------------------------------------------------------
do $pre$
begin
  if to_regprocedure('public.hr_onboarding_complete(uuid,uuid,jsonb)') is null
     or to_regprocedure('public.hr_onboarding_trusted_write()') is null
     or to_regprocedure('public.hr_reject_append_only()') is null
     or to_regclass('public.hr_employee_onboarding_log') is null
     or to_regclass('public.hr_go_live_state') is null then
    raise exception 'hr_prerequisite_missing: HR onboarding state (20261003100000)';
  end if;
  if to_regclass('public.sa_standard_policy_coverage') is null
     or to_regprocedure('public.sa_narrow_standard_policy(text,text[],text)') is null then
    raise exception 'sa_prerequisite_missing: standard policy coverage / narrowing (20261009100000, 20261110100000)';
  end if;
  if not exists (select 1 from public.sa_standard_policy_coverage where role_key = 'hr-payroll-full-access') then
    raise exception 'sa_prerequisite_missing: hr-payroll-full-access coverage record';
  end if;
  if to_regprocedure('public.sa_evaluate_permission(uuid,text,jsonb,boolean)') is null then
    raise exception 'sa_prerequisite_missing: sa_evaluate_permission';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Permission, mode, readiness, break-glass policy, Full Access exclusion
-- ---------------------------------------------------------------------------
insert into public.sa_permissions(permission_key, module, resource, action, description, source, audit_sensitivity) values
 ('hr.employee.delete','hr','employee','delete','Delete an employee''s HR registration or reset it, one employee at a time (identity, login, access, employee number and history are kept; blocked while HR records exist)','new','security_sensitive')
on conflict (permission_key) do nothing;

insert into public.sa_migration_modes(permission_key, mode, legacy_permission_key, notes)
values ('hr.employee.delete', 'SHADOW', null,
        'The database always requires an explicit S&A grant of this permission in the target organization, in every mode (no legacy or compatibility path).')
on conflict (permission_key) do nothing;

insert into public.sa_enforcement_readiness(permission_key, route_wiring, database_backstop, intentional_tightening, notes)
values ('hr.employee.delete', true, 'governance_function',
        'Always requires an explicit S&A assignment (no compatibility grant, no delegation), in every migration mode.',
        'HR employee registration routes and hr_employee_registration_preview / hr_employee_registration_execute.')
on conflict (permission_key) do nothing;

do $policy$
declare
  v_role uuid;
  v_existing text;
begin
  select b.source into v_existing from public.sa_business_roles b where b.role_key = 'hr-employee-record-administrator';
  if v_existing is not null and v_existing <> 'template' then
    raise exception 'sa_group_policy_key_conflict: hr-employee-record-administrator already exists as a non-standard role';
  end if;
  insert into public.sa_business_roles(role_key, name, description, source, status, applicable_account_types, applicable_org_types)
  values ('hr-employee-record-administrator', 'HR Employee Record Administrator',
          'Break-glass: deletes or resets an individual employee''s HR registration before HR goes live (identity, login, access, employee number and history are kept). Kept out of HR & Payroll Full Access. Grant only for a planned clean-up, preferably with an end date.',
          'template', 'active', array['internal'], array['HQ'])
  on conflict (role_key) do nothing
  returning id into v_role;
  if v_role is null then return; end if;   -- already present: never modified or expanded here

  insert into public.sa_business_role_permissions(role_id, permission_id)
  select br.id, p.id from public.sa_business_roles br, public.sa_permissions p
  where br.role_key = 'hr-employee-record-administrator' and p.permission_key = 'hr.employee.delete' and br.id = v_role and p.status = 'active';
  if (select count(*) from public.sa_business_role_permissions where role_id = v_role) <> 1 then
    raise exception 'sa_group_policy_permission_missing: hr-employee-record-administrator (hr.employee.delete)';
  end if;
  insert into public.sa_standard_policy_coverage(role_id, role_key, module_id, module_prefixes, permission_keys)
  values (v_role, 'hr-employee-record-administrator', 'hr_payroll', array['hr'], array['hr.employee.delete']);
  perform public.sa_log_access_change(null, 'access_profile.standard_seeded', null, 'sa_business_role', v_role::text,
    jsonb_build_object('role_key', 'hr-employee-record-administrator', 'module', 'hr_payroll', 'permission_count', 1),
    'Standard group policy seeded (not assigned to anyone)', 'system');
end $policy$;

-- Reviewed exclusion (repeat-safe): Full Access never implies deleting HR registrations.
select public.sa_narrow_standard_policy('hr-payroll-full-access', array['hr.employee.delete'],
  'Deleting or resetting an individual HR registration is granted only through HR Employee Record Administrator (break-glass), never through Full Access.');

-- hr.employee.delete must never be backfilled: nobody receives it from this migration.

-- ---------------------------------------------------------------------------
-- 2. Onboarding log event for a deleted registration
-- ---------------------------------------------------------------------------
alter table public.hr_employee_onboarding_log drop constraint if exists hr_employee_onboarding_log_event_check;
alter table public.hr_employee_onboarding_log add constraint hr_employee_onboarding_log_event_check
  check (event in ('completed','already_completed','reset','restored','removed'));

-- ---------------------------------------------------------------------------
-- 3. Append-only action record (completed and blocked attempts)
-- ---------------------------------------------------------------------------
create table if not exists public.hr_employee_registration_actions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  organization_id uuid not null,
  user_id uuid not null,
  employment_id uuid,
  employee_no integer,
  action text not null check (action in ('delete','reset')),
  status text not null check (status in ('completed','blocked')),
  actor_id uuid not null,
  reason text not null,
  preview_token text not null,
  previous_status text,
  new_status text,
  blockers jsonb not null default '[]'::jsonb,
  before_image jsonb,
  created_at timestamptz not null default now()
);
create index if not exists hr_employee_registration_actions_target_idx
  on public.hr_employee_registration_actions (organization_id, user_id, created_at desc);
alter table public.hr_employee_registration_actions enable row level security;
revoke all on table public.hr_employee_registration_actions from public, anon, authenticated, service_role;
grant select on table public.hr_employee_registration_actions to service_role;
drop trigger if exists hr_employee_registration_actions_append_only on public.hr_employee_registration_actions;
create trigger hr_employee_registration_actions_append_only before update or delete on public.hr_employee_registration_actions
for each row execute function public.hr_reject_append_only();
drop trigger if exists hr_employee_registration_actions_no_truncate on public.hr_employee_registration_actions;
create trigger hr_employee_registration_actions_no_truncate before truncate on public.hr_employee_registration_actions
for each statement execute function public.hr_reject_append_only();
comment on table public.hr_employee_registration_actions is
  'Permanent record of individual HR registration deletes/resets (hr_employee_registration_execute), including blocked attempts. Append-only.';

-- ---------------------------------------------------------------------------
-- 4. Plan (shared by preview and execution; no authorization, no writes)
-- ---------------------------------------------------------------------------
create or replace function public.hr_employee_registration_plan(p_org uuid, p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  e record;
  u record;
  c record;
  v_n bigint;
  v_deps jsonb := '[]'::jsonb;
  v_hr_total bigint := 0;
  v_reports bigint := 0;
  v_phase text;
  v_del jsonb := '[]'::jsonb;
  v_res jsonb := '[]'::jsonb;
  v_category text;
  v_cats jsonb := '{}'::jsonb;
  k text;
begin
  select x.* into e from public.hr_employees x where x.user_id = p_user and x.organization_id = p_org;
  select pu.id, pu.full_name, pu.organization_id, pu.principal_type, pu.account_status, pu.employee_no into u
  from public.users pu where pu.id = p_user;
  if e.id is null or u.id is null or u.organization_id is distinct from p_org then
    return jsonb_build_object('found', false);
  end if;

  -- Every single-column reference from an HR table to the identity or the employment record.
  -- Person columns without a foreign key are checked too (against both ids).
  for c in
    select cls.relname as tbl, a.attname as col,
           case when con.confrelid = 'public.hr_employees'::regclass then 'employment' else 'identity' end as target
    from pg_constraint con
    join pg_class cls on cls.oid = con.conrelid
    join pg_namespace n on n.oid = cls.relnamespace
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
    where con.contype = 'f' and n.nspname = 'public' and cardinality(con.conkey) = 1
      and cls.relname like 'hr\_%'
      and con.confrelid in ('public.users'::regclass, 'auth.users'::regclass, 'public.hr_employees'::regclass)
      and cls.relname not in ('hr_employee_onboarding_log','hr_employee_registration_actions','hr_reset_runs',
                              'hr_reset_snapshots','hr_reset_restorations','hr_go_live_state')
      and not (cls.relname = 'hr_employees' and a.attname <> 'manager_user_id')
    union
    select cls.relname, a.attname, 'either'
    from pg_class cls
    join pg_namespace n on n.oid = cls.relnamespace
    join pg_attribute a on a.attrelid = cls.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and cls.relkind in ('r','p') and cls.relname like 'hr\_%'
      and a.attname in ('user_id','employee_id','employee_user_id','employment_id') and a.atttypid = 'uuid'::regtype
      and cls.relname not in ('hr_employees','hr_employee_onboarding_log','hr_employee_registration_actions','hr_reset_runs',
                              'hr_reset_snapshots','hr_reset_restorations','hr_go_live_state')
      and not exists (select 1 from pg_constraint con2 where con2.conrelid = cls.oid and con2.contype = 'f'
                      and cardinality(con2.conkey) = 1 and con2.conkey[1] = a.attnum)
    order by 1, 2
  loop
    if c.target = 'employment' then
      execute format('select count(*) from public.%I t where t.%I = $1', c.tbl, c.col) into v_n using e.id;
    elsif c.target = 'identity' then
      execute format('select count(*) from public.%I t where t.%I = $1', c.tbl, c.col) into v_n using p_user;
    else
      execute format('select count(*) from public.%I t where t.%I in ($1, $2)', c.tbl, c.col) into v_n using p_user, e.id;
    end if;
    continue when v_n = 0;
    v_category := case
      when c.tbl = 'hr_employees' then 'reporting_line'
      when c.tbl like 'hr\_attendance%' or c.tbl like 'hr\_overtime%' or c.tbl like 'hr\_timesheet%' or c.tbl like 'hr\_shift%' then 'attendance'
      when c.tbl like 'hr\_leave%' then 'leave'
      when c.tbl like 'hr\_payroll%' or c.tbl like 'hr\_payslip%' then 'payroll'
      when c.tbl like '%commission%' then 'commission'
      when c.tbl in ('hr_employee_compensation','hr_employee_allowances','hr_employee_deductions') or c.tbl like 'hr\_benefit%' then 'compensation'
      when c.tbl like 'hr\_kpi%' or c.tbl like 'hr\_performance%' or c.tbl like 'hr\_appraisal%' or c.tbl like 'hr\_skill%'
        or c.tbl like 'hr\_review%' then 'performance'
      else 'other_hr' end;
    v_deps := v_deps || jsonb_build_object('table', c.tbl, 'column', c.col, 'category', v_category, 'count', v_n);
    v_cats := v_cats || jsonb_build_object(v_category, coalesce((v_cats->>v_category)::bigint, 0) + v_n);
    if v_category = 'reporting_line' then v_reports := v_reports + v_n; else v_hr_total := v_hr_total + v_n; end if;
  end loop;

  -- Direct reports through the identity projection (any organization).
  select count(*) into v_n from public.users r where r.manager_user_id = p_user and r.id <> p_user;
  if v_n > 0 then
    v_deps := v_deps || jsonb_build_object('table', 'users', 'column', 'manager_user_id', 'category', 'reporting_line', 'count', v_n);
    v_reports := greatest(v_reports, v_n);
    v_cats := v_cats || jsonb_build_object('reporting_line', v_reports);
  end if;

  select g.phase into v_phase from public.hr_go_live_state g where g.organization_id = p_org;
  v_phase := coalesce(v_phase, 'pre_go_live');   -- 'live' is only ever set by hr_mark_go_live

  -- Delete blockers
  if v_phase = 'live' then v_del := v_del || jsonb_build_object('code', 'HR_LIVE'); end if;
  if e.onboarding_status = 'pending' then v_del := v_del || jsonb_build_object('code', 'NOT_REGISTERED'); end if;
  for k in select jsonb_object_keys(v_cats) loop
    v_del := v_del || jsonb_build_object('code', case when k = 'reporting_line' then 'DIRECT_REPORTS' else 'HR_RECORDS' end,
                                         'category', k, 'count', (v_cats->>k)::bigint);
  end loop;
  -- Reset blockers
  if v_phase = 'live' then v_res := v_res || jsonb_build_object('code', 'HR_LIVE'); end if;
  if e.onboarding_status <> 'completed' then v_res := v_res || jsonb_build_object('code', 'NOT_COMPLETED'); end if;

  return jsonb_build_object(
    'found', true,
    'employee', jsonb_build_object('user_id', p_user, 'employment_id', e.id, 'full_name', u.full_name,
                                   'employee_no', e.employee_no, 'onboarding_status', e.onboarding_status,
                                   'employment_status', e.status, 'account_status', u.account_status),
    'phase', v_phase,
    'dependencies', v_deps,
    'categories', v_cats,
    'hr_record_total', v_hr_total,
    'direct_reports', v_reports,
    'kept', jsonb_build_object(
      'login', exists (select 1 from auth.users au where au.id = p_user),
      'access_assignments', (select count(*) from public.sa_role_assignments ra where ra.user_id = p_user and ra.status = 'active'),
      'employee_no', e.employee_no),
    'blockers', jsonb_build_object('delete', v_del, 'reset', v_res),
    'delete_allowed', jsonb_array_length(v_del) = 0,
    'reset_allowed', jsonb_array_length(v_res) = 0,
    'preview_token', md5(concat_ws('|', e.id, e.onboarding_status, e.updated_at, e.status, v_phase, v_deps::text))
  );
end $fn$;
revoke all on function public.hr_employee_registration_plan(uuid,uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Authorization
-- ---------------------------------------------------------------------------
create or replace function public.hr_employee_registration_actor_check(p_actor uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_phase text;
begin
  select g.phase into v_phase from public.hr_go_live_state g where g.organization_id = p_org;
  return jsonb_build_object(
    'permission', p_actor is not null and p_org is not null
      and exists (select 1 from public.users u where u.id = p_actor and u.is_active is true)
      and coalesce(public.sa_evaluate_permission(p_actor, 'hr.employee.delete', jsonb_build_object('organization_id', p_org), false)->>'decision', 'DENY') = 'ALLOW',
    'phase', coalesce(v_phase, 'pre_go_live'));
end $fn$;
revoke all on function public.hr_employee_registration_actor_check(uuid,uuid) from public, anon, authenticated;
grant execute on function public.hr_employee_registration_actor_check(uuid,uuid) to service_role;

create or replace function public.hr_employee_registration_authorize(p_actor uuid, p_org uuid)
returns void language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
begin
  if p_actor is null then raise exception 'sa_actor_required' using errcode = '42501'; end if;
  if not exists (select 1 from public.users u where u.id = p_actor and u.is_active is true) then
    raise exception 'sa_actor_inactive' using errcode = '42501';
  end if;
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'hr_employee_registration_organization_unknown' using errcode = '22023';
  end if;
  if coalesce(public.sa_evaluate_permission(p_actor, 'hr.employee.delete', jsonb_build_object('organization_id', p_org), false)->>'decision', 'DENY') <> 'ALLOW' then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.employee.delete';
  end if;
end $fn$;
revoke all on function public.hr_employee_registration_authorize(uuid,uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Preview
-- ---------------------------------------------------------------------------
create or replace function public.hr_employee_registration_preview(p_actor uuid, p_org uuid, p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v jsonb;
begin
  perform public.hr_employee_registration_authorize(p_actor, p_org);
  if p_user is null then raise exception 'hr_employee_registration_input_required' using errcode = '22023'; end if;
  v := public.hr_employee_registration_plan(p_org, p_user);
  if not (v->>'found')::boolean then
    raise exception 'hr_employee_not_in_organization' using errcode = '22023';
  end if;
  if p_actor = p_user then
    v := jsonb_set(v, '{blockers,delete}', (v->'blockers'->'delete') || jsonb_build_array(jsonb_build_object('code', 'SELF')));
    v := jsonb_set(v, '{blockers,reset}', (v->'blockers'->'reset') || jsonb_build_array(jsonb_build_object('code', 'SELF')));
    v := v || jsonb_build_object('delete_allowed', false, 'reset_allowed', false);
  end if;
  return v;
end $fn$;
revoke all on function public.hr_employee_registration_preview(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.hr_employee_registration_preview(uuid,uuid,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Execute (one transaction; revalidates everything)
-- ---------------------------------------------------------------------------
create or replace function public.hr_employee_registration_execute(
  p_actor uuid, p_org uuid, p_user uuid, p_action text, p_request_id uuid, p_preview_token text, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_existing record;
  v_plan jsonb;
  v_blockers jsonb;
  e record;
  t record;
  v_id uuid;
  v_new text;
  v_n integer;
begin
  if p_request_id is null or p_user is null or p_action is null then
    raise exception 'hr_employee_registration_input_required' using errcode = '22023';
  end if;
  if p_action not in ('delete','reset') then raise exception 'hr_employee_registration_action_invalid' using errcode = '22023'; end if;
  perform public.hr_employee_registration_authorize(p_actor, p_org);
  if p_actor = p_user then raise exception 'hr_employee_registration_self_prohibited' using errcode = '42501'; end if;

  -- A repeated submission returns its recorded outcome; a reused id for anything else is refused.
  select * into v_existing from public.hr_employee_registration_actions where request_id = p_request_id;
  if found then
    if v_existing.actor_id <> p_actor or v_existing.organization_id <> p_org or v_existing.user_id <> p_user or v_existing.action <> p_action then
      raise exception 'hr_employee_registration_request_reused' using errcode = '22023';
    end if;
    return jsonb_build_object('status', v_existing.status, 'replayed', true, 'action_id', v_existing.id,
                              'new_status', v_existing.new_status, 'blockers', v_existing.blockers, 'employee_no', v_existing.employee_no);
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'hr_employee_registration_reason_required' using errcode = '22023';
  end if;

  perform set_config('lock_timeout', '5s', true);
  perform pg_advisory_xact_lock(hashtextextended('hr_employee_registration:' || p_org::text || ':' || p_user::text, 0));
  select * into v_existing from public.hr_employee_registration_actions where request_id = p_request_id;
  if found then
    if v_existing.actor_id <> p_actor or v_existing.organization_id <> p_org or v_existing.user_id <> p_user or v_existing.action <> p_action then
      raise exception 'hr_employee_registration_request_reused' using errcode = '22023';
    end if;
    return jsonb_build_object('status', v_existing.status, 'replayed', true, 'action_id', v_existing.id,
                              'new_status', v_existing.new_status, 'blockers', v_existing.blockers, 'employee_no', v_existing.employee_no);
  end if;

  -- Fence: every insert/update that references the identity or the employment record through a foreign key
  -- waits on these row locks (and in-flight ones are waited for), so the dependency re-check below is exact.
  perform 1 from public.users pu where pu.id = p_user and pu.organization_id = p_org for update;
  if not found then raise exception 'hr_employee_not_in_organization' using errcode = '22023'; end if;
  select * into e from public.hr_employees x where x.user_id = p_user and x.organization_id = p_org for update;
  if not found then raise exception 'hr_employee_not_in_organization' using errcode = '22023'; end if;
  if p_action = 'delete' then
    -- Person columns without a foreign key: block concurrent writers of those tables until commit.
    for t in
      select distinct cls.relname as tbl
      from pg_class cls join pg_namespace n on n.oid = cls.relnamespace
      join pg_attribute a on a.attrelid = cls.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public' and cls.relkind in ('r','p') and cls.relname like 'hr\_%'
        and a.attname in ('user_id','employee_id','employee_user_id','employment_id') and a.atttypid = 'uuid'::regtype
        and cls.relname not in ('hr_employees','hr_employee_onboarding_log','hr_employee_registration_actions','hr_reset_runs',
                                'hr_reset_snapshots','hr_reset_restorations','hr_go_live_state')
        and not exists (select 1 from pg_constraint con2 where con2.conrelid = cls.oid and con2.contype = 'f'
                        and cardinality(con2.conkey) = 1 and con2.conkey[1] = a.attnum)
      order by 1
    loop
      execute format('lock table public.%I in share mode', t.tbl);
    end loop;
  end if;

  v_plan := public.hr_employee_registration_plan(p_org, p_user);
  if not (v_plan->>'found')::boolean then raise exception 'hr_employee_not_in_organization' using errcode = '22023'; end if;
  if p_preview_token is distinct from v_plan->>'preview_token' then
    return jsonb_build_object('status', 'stale', 'message', 'This employee''s records changed since the preview. Review the new preview first.');
  end if;

  v_blockers := v_plan->'blockers'->p_action;
  if jsonb_array_length(v_blockers) > 0 then
    insert into public.hr_employee_registration_actions(request_id, organization_id, user_id, employment_id, employee_no, action, status,
                                                        actor_id, reason, preview_token, previous_status, new_status, blockers)
    values (p_request_id, p_org, p_user, e.id, e.employee_no, p_action, 'blocked', p_actor, btrim(p_reason), p_preview_token,
            e.onboarding_status, e.onboarding_status, v_blockers)
    returning id into v_id;
    return jsonb_build_object('status', 'blocked', 'action_id', v_id, 'blockers', v_blockers);
  end if;

  v_new := case p_action when 'delete' then 'pending' else 'reset' end;
  insert into public.hr_employee_registration_actions(request_id, organization_id, user_id, employment_id, employee_no, action, status,
                                                      actor_id, reason, preview_token, previous_status, new_status, before_image)
  values (p_request_id, p_org, p_user, e.id, e.employee_no, p_action, 'completed', p_actor, btrim(p_reason), p_preview_token,
          e.onboarding_status, v_new, to_jsonb(e))
  returning id into v_id;

  -- Registration only. Employment facts are not written, so nothing is re-projected onto users.
  perform set_config('hr.onboarding_write', 'on', true);
  if p_action = 'delete' then
    update public.hr_employees x set
      onboarding_status = 'pending', onboarding_source = null, onboarded_at = null, onboarded_by = null,
      onboarding_reset_at = null, onboarding_reset_by = null, onboarding_reset_run_id = null,
      hire_date_confirmed = false, updated_at = now()
    where x.id = e.id and x.onboarding_status in ('completed','reset');
  else
    update public.hr_employees x set
      onboarding_status = 'reset', onboarding_reset_at = now(), onboarding_reset_by = p_actor, onboarding_reset_run_id = null,
      updated_at = now()
    where x.id = e.id and x.onboarding_status = 'completed';
  end if;
  get diagnostics v_n = row_count;
  perform set_config('hr.onboarding_write', 'off', true);
  if v_n <> 1 then
    raise exception 'hr_employee_registration_count_mismatch' using errcode = 'P0001';
  end if;

  insert into public.hr_employee_onboarding_log(organization_id, user_id, employment_id, event, previous_status, new_status, actor_id, details)
  values (p_org, p_user, e.id, case p_action when 'delete' then 'removed' else 'reset' end, e.onboarding_status, v_new, p_actor,
          jsonb_build_object('registration_action_id', v_id, 'action', p_action, 'reason', btrim(p_reason)));

  return jsonb_build_object('status', 'completed', 'action_id', v_id, 'previous_status', e.onboarding_status,
                            'new_status', v_new, 'employee_no', e.employee_no);
end $fn$;
revoke all on function public.hr_employee_registration_execute(uuid,uuid,uuid,text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.hr_employee_registration_execute(uuid,uuid,uuid,text,uuid,text,text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Operational guard: wait for an in-flight registration change
-- ---------------------------------------------------------------------------
-- Same rule as 20261003100000. The employment row is now read FOR KEY SHARE: an insert racing
-- hr_employee_registration_execute (which holds the row FOR UPDATE) waits for it and re-reads the
-- committed state, so a clock-in, leave request or payroll line cannot slip in for an employee whose
-- registration was just deleted or reset. KEY SHARE does not conflict with ordinary updates of the row.
create or replace function public.hr_require_onboarded_employee()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_row jsonb := to_jsonb(new);
  v_user uuid := nullif(v_row->>tg_argv[0], '')::uuid;
  v_org uuid := nullif(v_row->>'organization_id', '')::uuid;
begin
  if v_user is null or v_org is null then return new; end if;
  if nullif(current_setting('hr.reset_restore', true), '') is not null
     and exists (select 1 from public.hr_reset_runs r where r.id::text = current_setting('hr.reset_restore', true)) then
    return new;   -- hr_reset_restore re-inserts the captured history of that run
  end if;
  perform 1 from public.hr_employees e
  where e.user_id = v_user and e.organization_id = v_org and e.onboarding_status = 'completed'
  for key share;
  if not found then
    raise exception 'hr_onboarding_pending' using errcode = 'P0001',
      detail = format('%s: employee %s has not completed HR onboarding in organization %s', tg_table_name, v_user, v_org),
      hint = 'HR must complete onboarding (HR → People → Add Employee) before HR transactions are recorded.';
  end if;
  return new;
end $fn$;
revoke all on function public.hr_require_onboarded_employee() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. Post-conditions
-- ---------------------------------------------------------------------------
do $post$
begin
  if not exists (select 1 from public.sa_permissions where permission_key = 'hr.employee.delete' and status = 'active') then
    raise exception 'postcondition: hr.employee.delete missing';
  end if;
  if not exists (select 1 from public.sa_business_role_permissions rp join public.sa_business_roles b on b.id = rp.role_id
                 join public.sa_permissions p on p.id = rp.permission_id
                 where b.role_key = 'hr-employee-record-administrator' and p.permission_key = 'hr.employee.delete') then
    raise exception 'postcondition: HR Employee Record Administrator does not hold hr.employee.delete';
  end if;
  if exists (select 1 from public.sa_business_role_permissions rp join public.sa_business_roles b on b.id = rp.role_id
             join public.sa_permissions p on p.id = rp.permission_id
             where p.permission_key = 'hr.employee.delete' and b.role_key <> 'hr-employee-record-administrator') then
    raise exception 'postcondition: hr.employee.delete is held by another policy';
  end if;
  if not exists (select 1 from public.sa_standard_policy_coverage
                 where role_key = 'hr-payroll-full-access' and 'hr.employee.delete' = any(excluded_keys)) then
    raise exception 'postcondition: hr.employee.delete not recorded as a Full Access exclusion';
  end if;
  if has_function_privilege('authenticated', 'public.hr_employee_registration_execute(uuid,uuid,uuid,text,uuid,text,text)', 'execute')
     or has_function_privilege('anon', 'public.hr_employee_registration_execute(uuid,uuid,uuid,text,uuid,text,text)', 'execute')
     or has_function_privilege('service_role', 'public.hr_employee_registration_plan(uuid,uuid)', 'execute') then
    raise exception 'postcondition: registration functions exposed to API roles';
  end if;
end $post$;
