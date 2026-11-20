-- ============================================================================
-- Finance — dedicated permissions for fiscal years and accounting periods
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database.
--
-- Before this migration every fiscal-year / period action (create a year, open a month, close, reopen, lock) was
-- decided by finance.settings.manage (HQ Admin, role level <= 20), and the routes wrote the tables directly.
-- Management asked for separate permissions that can be given to specific people.
--
-- What this adds
--   1. Five permissions (Finance → Fiscal Year & Periods), audit_sensitivity security_sensitive:
--        finance.fiscal_year.create   create a fiscal year and its periods (created as Future)
--        finance.period.open          open a new period            (future -> open)
--        finance.period.close         close a period or a year      (open -> closed)
--        finance.period.reopen        reopen a closed period / year (closed -> open)
--        finance.fiscal_year.lock     lock permanently              (closed -> locked; never reversible)
--   2. Compatibility rule: role level <= 1 (central Super Admin only).
--   3. Migration mode SHADOW. While SHADOW the legacy rule decides: Super Admin only (routes and functions below).
--      To let specific people in, management assigns the Group Policies below and moves the keys to NEW_ENFORCED
--      (Security & Access → Migration Modes). The compatibility role keeps Super Admins in, so enforcing cannot lock
--      everyone out.
--   4. One standard Group Policy per permission (each also holds finance.module.view and finance.ledger.view so the
--      holder can open the Fiscal Year & Periods page). Published, assigned to NO ONE. Finance Full Access is
--      deliberately NOT extended: these are given to named people only.
--   5. Database path: fiscal_year_create / fiscal_year_set_status / fiscal_period_set_status (SECURITY DEFINER) decide
--      the permission from the transition and record every change in fiscal_period_events. A guard trigger refuses
--      inserts and status/date changes on fiscal_years / fiscal_periods from API roles outside those functions
--      (migrations, the database owner and service_role are not affected).
--
-- Not changed: no mode is enforced, no assignment is created, no existing policy is modified, no existing migration is
-- edited, sa_permission_is_sensitive() is not redefined. Mirrors app/src/lib/security-access/fiscal-period-catalog.ts
-- (lock-step test fiscal-period-catalog.test.ts).
--
-- Repeat-safe. Rollback (only while unused: modes not enforced, policies unassigned):
--   drop trigger if exists fiscal_years_status_guard on public.fiscal_years;
--   drop trigger if exists fiscal_periods_status_guard on public.fiscal_periods;
--   drop function if exists public.fiscal_status_guard();
--   drop function if exists public.fiscal_period_set_status(uuid,text);
--   drop function if exists public.fiscal_year_set_status(uuid,text);
--   drop function if exists public.fiscal_year_create(text,text,date,date,text);
--   drop function if exists public.fiscal_assert(uuid,text,uuid);
--   delete from public.sa_business_roles where role_key in ('fiscal-year-creator','accounting-period-opener',
--     'accounting-period-closer','accounting-period-reopener','fiscal-year-locker');
--   delete from public.sa_migration_modes / sa_enforcement_readiness / sa_legacy_compat_rules / sa_business_role_permissions
--     / sa_permissions rows for the five keys (keep fiscal_period_events: it is history).
-- ============================================================================

do $pre$
begin
  if to_regclass('public.sa_standard_policy_coverage') is null then
    raise exception 'sa_prerequisite_missing: apply 20261009100000_sa_group_policies_full_access.sql first';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sa_business_roles' and column_name = 'applicable_account_types') then
    raise exception 'sa_prerequisite_missing: apply 20261005110000_sa_access_profiles.sql first';
  end if;
  if to_regclass('public.fiscal_years') is null or to_regclass('public.fiscal_periods') is null then
    raise exception 'fiscal tables missing';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Permissions, compatibility rules, modes, readiness
-- ---------------------------------------------------------------------------
insert into public.sa_permissions(permission_key, module, resource, action, description, source, audit_sensitivity) values
 ('finance.fiscal_year.create','finance','fiscal_year','create','Create a fiscal year and its accounting periods (created as Future)','new','security_sensitive'),
 ('finance.period.open','finance','period','open','Open a new accounting period (Future to Open) so it accepts postings','new','security_sensitive'),
 ('finance.period.close','finance','period','close','Close an accounting period or a fiscal year (Open to Closed)','new','security_sensitive'),
 ('finance.period.reopen','finance','period','reopen','Reopen a closed accounting period or fiscal year (Closed to Open) to post corrections','new','security_sensitive'),
 ('finance.fiscal_year.lock','finance','fiscal_year','lock','Lock a closed period or fiscal year permanently (Closed to Locked); it can never be changed again','new','security_sensitive')
on conflict (permission_key) do nothing;

insert into public.sa_legacy_compat_rules(permission_key, max_role_level, role_codes, legacy_permissions, employee_baseline, notes) values
 ('finance.fiscal_year.create', 1, '{}', '{}', false, 'Fiscal Year & Periods: central Super Admin only; others through the fiscal-year-creator policy'),
 ('finance.period.open', 1, '{}', '{}', false, 'Fiscal Year & Periods: central Super Admin only; others through the accounting-period-opener policy'),
 ('finance.period.close', 1, '{}', '{}', false, 'Fiscal Year & Periods: central Super Admin only; others through the accounting-period-closer policy'),
 ('finance.period.reopen', 1, '{}', '{}', false, 'Fiscal Year & Periods: central Super Admin only; others through the accounting-period-reopener policy'),
 ('finance.fiscal_year.lock', 1, '{}', '{}', false, 'Fiscal Year & Periods: central Super Admin only; others through the fiscal-year-locker policy')
on conflict (permission_key) do update set max_role_level = excluded.max_role_level, role_codes = excluded.role_codes,
  legacy_permissions = excluded.legacy_permissions, employee_baseline = excluded.employee_baseline,
  notes = excluded.notes, updated_at = now();

insert into public.sa_migration_modes(permission_key, mode, legacy_permission_key, notes)
select k, 'SHADOW', null, 'Fiscal Year & Periods: legacy (Super Admin only) decides until enforced from Security & Access.'
from unnest(array['finance.fiscal_year.create','finance.period.open','finance.period.close','finance.period.reopen','finance.fiscal_year.lock']) k
on conflict (permission_key) do nothing;

insert into public.sa_enforcement_readiness(permission_key, route_wiring, database_backstop, intentional_tightening, notes) values
 ('finance.fiscal_year.create', true, 'rpc_guard', null, 'POST /api/accounting/fiscal-years decides through S&A; fiscal_year_create re-checks the actor; direct inserts from API roles are refused.'),
 ('finance.period.open', true, 'rpc_guard', null, 'Period status routes decide through S&A; fiscal_period_set_status re-checks the actor; direct status changes from API roles are refused.'),
 ('finance.period.close', true, 'rpc_guard', null, 'Period / year status routes decide through S&A; fiscal_*_set_status re-check the actor; direct status changes from API roles are refused.'),
 ('finance.period.reopen', true, 'rpc_guard', null, 'Period / year status routes decide through S&A; fiscal_*_set_status re-check the actor; direct status changes from API roles are refused.'),
 ('finance.fiscal_year.lock', true, 'rpc_guard', null, 'Period / year status routes decide through S&A; fiscal_*_set_status re-check the actor; direct status changes from API roles are refused.')
on conflict (permission_key) do update set route_wiring = excluded.route_wiring, database_backstop = excluded.database_backstop,
  intentional_tightening = excluded.intentional_tightening, notes = excluded.notes;

-- ---------------------------------------------------------------------------
-- 2. Standard Group Policies (one per permission, assigned to no one)
-- ---------------------------------------------------------------------------
do $seed$
declare
  r record;
  v_role uuid;
  v_existing text;
begin
  for r in select * from (values
    ('fiscal-year-creator', 'Fiscal Year Creator',
     'Create a new fiscal year with its accounting periods (created as Future). Does not open, close or lock periods.'),
    ('accounting-period-opener', 'Accounting Period Opener',
     'Open a new accounting period (Future to Open) so it accepts postings. Does not close, reopen or lock.'),
    ('accounting-period-closer', 'Accounting Period Closer',
     'Close an accounting period or a fiscal year (Open to Closed) after review. Does not reopen or lock.'),
    ('accounting-period-reopener', 'Accounting Period Reopener',
     'Reopen a closed accounting period or fiscal year (Closed to Open) to post a correction. Every reopen is recorded.'),
    ('fiscal-year-locker', 'Fiscal Year Locker',
     'Lock a closed period or fiscal year permanently (Closed to Locked), e.g. after audit. A locked year can never be changed.')
  ) as t(role_key, name, description)
  loop
    select b.source into v_existing from public.sa_business_roles b where b.role_key = r.role_key;
    if v_existing is not null and v_existing <> 'template' then
      raise exception 'sa_group_policy_key_conflict: % already exists as a non-standard role', r.role_key;
    end if;
    insert into public.sa_business_roles(role_key, name, description, source, status, applicable_account_types, applicable_org_types)
    values (r.role_key, r.name, r.description, 'template', 'active', array['internal'], '{}')
    on conflict (role_key) do nothing;
  end loop;
end $seed$;

insert into public.sa_business_role_permissions(role_id, permission_id)
select br.id, p.id
from (values
  ('fiscal-year-creator',        array['finance.module.view','finance.ledger.view','finance.fiscal_year.create']),
  ('accounting-period-opener',   array['finance.module.view','finance.ledger.view','finance.period.open']),
  ('accounting-period-closer',   array['finance.module.view','finance.ledger.view','finance.period.close']),
  ('accounting-period-reopener', array['finance.module.view','finance.ledger.view','finance.period.reopen']),
  ('fiscal-year-locker',         array['finance.module.view','finance.ledger.view','finance.fiscal_year.lock'])
) as t(role_key, keys)
join public.sa_business_roles br on br.role_key = t.role_key and br.source = 'template'
join public.sa_permissions p on p.permission_key = any(t.keys) and p.status = 'active'
on conflict do nothing;

do $coverage$
declare
  r record;
begin
  for r in
    select br.id as role_id, br.role_key,
           (select array_agg(p.permission_key order by p.permission_key)
              from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id
             where rp.role_id = br.id) as keys
    from public.sa_business_roles br
    where br.role_key in ('fiscal-year-creator','accounting-period-opener','accounting-period-closer','accounting-period-reopener','fiscal-year-locker')
      and not exists (select 1 from public.sa_standard_policy_coverage c where c.role_id = br.id)
  loop
    if cardinality(r.keys) <> 3 then
      raise exception 'sa_group_policy_permission_missing: % (%)', r.role_key, array_to_string(r.keys, ', ');
    end if;
    insert into public.sa_standard_policy_coverage(role_id, role_key, module_id, module_prefixes, permission_keys)
    values (r.role_id, r.role_key, 'finance', array['finance'], r.keys);
    perform public.sa_log_access_change(null, 'access_profile.standard_seeded', null, 'sa_business_role', r.role_id::text,
      jsonb_build_object('role_key', r.role_key, 'module', 'finance', 'permission_count', cardinality(r.keys)),
      'Standard Fiscal Year & Periods group policy seeded (not assigned to anyone)', 'system');
  end loop;
end $coverage$;

-- ---------------------------------------------------------------------------
-- 3. Compatibility roles gain the keys only while legacy authorization is still writable
-- ---------------------------------------------------------------------------
select public.sa_refresh_compat_role(r.role_code, false)
from public.roles r
where not public.sa_setting_bool('legacy_authorization.read_only', false)
  and r.role_level <= 1
  and exists (select 1 from public.sa_business_roles br where br.role_key = public.sa_compat_role_key(r.role_code));

-- ---------------------------------------------------------------------------
-- 4. Audit history of every fiscal-year / period change
-- ---------------------------------------------------------------------------
create table if not exists public.fiscal_period_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  fiscal_year_id uuid not null,
  period_id uuid,
  permission_key text not null,
  from_status text,
  to_status text not null,
  actor_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists fiscal_period_events_company_idx on public.fiscal_period_events(company_id, created_at desc);
alter table public.fiscal_period_events enable row level security;
revoke all on table public.fiscal_period_events from public, anon, authenticated;
grant select on table public.fiscal_period_events to service_role;
comment on table public.fiscal_period_events is
  'Who created, opened, closed, reopened or locked a fiscal year / accounting period, and when. Written only by fiscal_* functions; kept after a year is deleted.';

-- ---------------------------------------------------------------------------
-- 5. Decision helper and the three functions that change fiscal years / periods
-- ---------------------------------------------------------------------------
create or replace function public.fiscal_assert(p_actor uuid, p_permission text, p_company uuid)
returns void language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  -- New modes: the actor's S&A assignment decides. SHADOW / legacy: central Super Admin only.
  perform public.sa_assert_actor_permission(p_actor, p_permission,
    jsonb_build_object('organization_id', p_company), public.sa_legacy_is_super_admin(p_actor));
end $$;
revoke all on function public.fiscal_assert(uuid,text,uuid) from public, anon, authenticated;

create or replace function public.fiscal_year_create(
  p_code text, p_name text, p_start date, p_end date, p_period_type text default 'monthly')
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_company uuid;
  v_id uuid;
  v_step interval;
  v_from date;
  v_to date;
  v_n integer := 0;
  v_overlap text;
begin
  if v_actor is null then raise exception 'fiscal_actor_required' using errcode = '42501'; end if;
  select public.get_company_id(u.organization_id) into v_company from public.users u where u.id = v_actor;
  if v_company is null then raise exception 'fiscal_company_not_found' using errcode = 'P0002'; end if;
  perform public.fiscal_assert(v_actor, 'finance.fiscal_year.create', v_company);

  if nullif(btrim(p_code), '') is null or nullif(btrim(p_name), '') is null or p_start is null or p_end is null then
    raise exception 'Missing required fields' using errcode = '22023';
  end if;
  if p_end <= p_start then raise exception 'End date must be after start date' using errcode = '22023'; end if;
  if coalesce(p_period_type, 'monthly') not in ('monthly', 'quarterly') then
    raise exception 'Period type must be monthly or quarterly' using errcode = '22023';
  end if;
  v_step := case when coalesce(p_period_type, 'monthly') = 'quarterly' then interval '3 months' else interval '1 month' end;
  if (select count(*) from generate_series(p_start::timestamp, p_end::timestamp, v_step)) > 13 then
    raise exception 'A fiscal year can have at most 13 periods' using errcode = '22023';
  end if;

  select fy.fiscal_year_name into v_overlap from public.fiscal_years fy
   where fy.company_id = v_company and fy.start_date <= p_end and fy.end_date >= p_start limit 1;
  if v_overlap is not null then
    raise exception 'Dates overlap with existing fiscal year: %', v_overlap using errcode = '23P01';
  end if;

  perform set_config('app.fiscal_rpc', 'on', true);

  insert into public.fiscal_years(company_id, fiscal_year_code, fiscal_year_name, start_date, end_date, status, created_by)
  values (v_company, upper(btrim(p_code)), btrim(p_name), p_start, p_end, 'open', v_actor)
  returning id into v_id;

  v_from := p_start;
  while v_from <= p_end loop
    v_n := v_n + 1;
    v_to := least((v_from + v_step - interval '1 day')::date, p_end);
    insert into public.fiscal_periods(company_id, fiscal_year_id, period_number, period_name, start_date, end_date, status, period_type)
    values (v_company, v_id, v_n,
            case when v_step = interval '1 month' then to_char(v_from, 'FMMonth YYYY') else format('Q%s %s', v_n, upper(btrim(p_code))) end,
            v_from, v_to, 'future', 'normal');
    v_from := (v_from + v_step)::date;
  end loop;

  insert into public.fiscal_period_events(company_id, fiscal_year_id, period_id, permission_key, from_status, to_status, actor_id)
  values (v_company, v_id, null, 'finance.fiscal_year.create', null, 'open', v_actor);

  return jsonb_build_object('success', true, 'fiscal_year_id', v_id, 'periods_created', v_n);
end $$;
revoke all on function public.fiscal_year_create(text,text,date,date,text) from public, anon;
grant execute on function public.fiscal_year_create(text,text,date,date,text) to authenticated, service_role;

create or replace function public.fiscal_period_set_status(p_period_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_period public.fiscal_periods;
  v_year_status text;
  v_key text;
begin
  if v_actor is null then raise exception 'fiscal_actor_required' using errcode = '42501'; end if;
  select * into v_period from public.fiscal_periods where id = p_period_id for update;
  if not found then raise exception 'Period not found' using errcode = 'P0002'; end if;
  select fy.status into v_year_status from public.fiscal_years fy where fy.id = v_period.fiscal_year_id;
  if v_year_status = 'locked' then raise exception 'Fiscal year is locked' using errcode = '22023'; end if;
  if v_period.status = 'locked' then raise exception 'Cannot modify locked period' using errcode = '22023'; end if;

  v_key := case
    when v_period.status = 'future' and p_status = 'open'   then 'finance.period.open'
    when v_period.status = 'open'   and p_status = 'closed' then 'finance.period.close'
    when v_period.status = 'closed' and p_status = 'open'   then 'finance.period.reopen'
    when v_period.status = 'closed' and p_status = 'locked' then 'finance.fiscal_year.lock'
  end;
  if v_key is null then
    raise exception 'Invalid status transition from % to %', v_period.status, p_status using errcode = '22023';
  end if;
  perform public.fiscal_assert(v_actor, v_key, v_period.company_id);

  perform set_config('app.fiscal_rpc', 'on', true);
  update public.fiscal_periods
     set status = p_status,
         closed_at = case when p_status in ('closed', 'locked') then now() else null end,
         closed_by = case when p_status in ('closed', 'locked') then v_actor else null end,
         updated_at = now()
   where id = p_period_id;

  insert into public.fiscal_period_events(company_id, fiscal_year_id, period_id, permission_key, from_status, to_status, actor_id)
  values (v_period.company_id, v_period.fiscal_year_id, v_period.id, v_key, v_period.status, p_status, v_actor);

  return jsonb_build_object('success', true, 'period_id', v_period.id, 'from_status', v_period.status, 'status', p_status);
end $$;
revoke all on function public.fiscal_period_set_status(uuid,text) from public, anon;
grant execute on function public.fiscal_period_set_status(uuid,text) to authenticated, service_role;

create or replace function public.fiscal_year_set_status(p_year_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_year public.fiscal_years;
  v_key text;
begin
  if v_actor is null then raise exception 'fiscal_actor_required' using errcode = '42501'; end if;
  select * into v_year from public.fiscal_years where id = p_year_id for update;
  if not found then raise exception 'Fiscal year not found' using errcode = 'P0002'; end if;
  if v_year.status = 'locked' then raise exception 'Cannot modify locked fiscal year' using errcode = '22023'; end if;

  v_key := case
    when v_year.status = 'open'   and p_status = 'closed' then 'finance.period.close'
    when v_year.status = 'closed' and p_status = 'open'   then 'finance.period.reopen'
    when v_year.status = 'closed' and p_status = 'locked' then 'finance.fiscal_year.lock'
  end;
  if v_key is null then
    raise exception 'Invalid status transition from % to %', v_year.status, p_status using errcode = '22023';
  end if;
  perform public.fiscal_assert(v_actor, v_key, v_year.company_id);

  perform set_config('app.fiscal_rpc', 'on', true);
  update public.fiscal_years
     set status = p_status,
         closed_at = case when p_status in ('closed', 'locked') then coalesce(closed_at, now()) else null end,
         closed_by = case when p_status in ('closed', 'locked') then coalesce(closed_by, v_actor) else null end,
         updated_at = now()
   where id = p_year_id;

  insert into public.fiscal_period_events(company_id, fiscal_year_id, period_id, permission_key, from_status, to_status, actor_id)
  values (v_year.company_id, v_year.id, null, v_key, v_year.status, p_status, v_actor);

  return jsonb_build_object('success', true, 'fiscal_year_id', v_year.id, 'from_status', v_year.status, 'status', p_status);
end $$;
revoke all on function public.fiscal_year_set_status(uuid,text) from public, anon;
grant execute on function public.fiscal_year_set_status(uuid,text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Guard: API roles change fiscal years / periods only through the functions above
-- ---------------------------------------------------------------------------
create or replace function public.fiscal_status_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role';
begin
  -- Migrations, the database owner and the trusted server (service_role) are not API callers.
  if v_role is null or v_role = 'service_role' then return new; end if;
  if coalesce(current_setting('app.fiscal_rpc', true), '') = 'on' then return new; end if;
  raise exception 'fiscal_status_change_requires_rpc'
    using errcode = '42501',
          detail = 'Fiscal years and accounting periods are created and change status only through Finance Settings > Fiscal Year & Periods.';
end $$;
revoke all on function public.fiscal_status_guard() from public, anon, authenticated;

drop trigger if exists fiscal_years_status_guard on public.fiscal_years;
create trigger fiscal_years_status_guard
  before insert or update of status, start_date, end_date, company_id on public.fiscal_years
  for each row execute function public.fiscal_status_guard();

drop trigger if exists fiscal_periods_status_guard on public.fiscal_periods;
create trigger fiscal_periods_status_guard
  before insert or update of status, start_date, end_date, fiscal_year_id, company_id on public.fiscal_periods
  for each row execute function public.fiscal_status_guard();

-- ---------------------------------------------------------------------------
-- 7. Post-conditions
-- ---------------------------------------------------------------------------
do $post$
declare
  v_keys constant text[] := array['finance.fiscal_year.create','finance.period.open','finance.period.close','finance.period.reopen','finance.fiscal_year.lock'];
  v_assigned integer;
begin
  if (select count(*) from public.sa_migration_modes where permission_key = any(v_keys) and mode = 'SHADOW') <> 5 then
    raise exception 'postcondition: the five fiscal permissions must be in SHADOW mode (this migration enforces nothing)';
  end if;
  if (select count(*) from public.sa_legacy_compat_rules where permission_key = any(v_keys) and max_role_level = 1) <> 5 then
    raise exception 'postcondition: fiscal compatibility audience must be the central Super Admin only';
  end if;
  if (select count(*) from public.sa_enforcement_readiness where permission_key = any(v_keys)) <> 5 then
    raise exception 'postcondition: readiness must be registered for the five fiscal permissions';
  end if;
  if exists (
    select 1 from public.sa_business_role_permissions rp
    join public.sa_permissions p on p.id = rp.permission_id
    join public.sa_business_roles b on b.id = rp.role_id
    where p.permission_key = any(v_keys)
      and b.role_key not in ('fiscal-year-creator','accounting-period-opener','accounting-period-closer','accounting-period-reopener','fiscal-year-locker')
      and b.role_key not like 'legacy-%') then
    raise exception 'postcondition: only the five fiscal Group Policies (and compatibility roles) may hold the fiscal permissions';
  end if;
  select count(*) into v_assigned from public.sa_role_assignments a join public.sa_business_roles b on b.id = a.role_id
  where b.role_key in ('fiscal-year-creator','accounting-period-opener','accounting-period-closer','accounting-period-reopener','fiscal-year-locker');
  raise notice 'fiscal Group Policy assignments: % (this migration assigns none)', v_assigned;
end $post$;
