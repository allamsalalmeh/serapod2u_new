-- ============================================================================
-- 20261222100000_hr_hybrid_attendance_overtime.sql
-- Serapod2U HR Core — Wave 3 (B4a / B4b / B4c / B5): Hybrid Attendance and Overtime workflow.
--
-- STATUS: migration file prepared. NOT applied to staging or production. Owner applies staging first (D-018), after
-- the replica suite supabase/tests/security/hr_attendance_overtime/ passes. Requires Wave 2 (20261221100000) — the
-- prerequisites block refuses to run without it.
--
-- What this migration does (additive; no existing business row is deleted or re-valued):
--   1. Reliable capture. Every write to hr_attendance_entries, hr_attendance_corrections and hr_overtime_requests goes
--      through database functions (server time, canonical identity, audit). Direct writes by API roles (anon,
--      authenticated, service_role) are refused by a guard trigger; database-owned code (HR reset/restore, identity
--      lifecycle, the functions below) is unaffected. Reads keep their existing RLS policies (B3 scope).
--   2. Hybrid capture channels (source): web, mobile (employee clock), hr_manual (HR on behalf, reason, review by a
--      second person), import (Excel bulk import), correction (approved missing-day correction).
--   3. Auto-validation (D-012): a valid entry needs no approval. Exceptions are detected from the EXISTING policy and
--      shift fields (late after, early leave, max open hours, workdays, public holidays, approved leave) and reviewed
--      independently (never by the employee concerned; manual-entry reviews never by their maker).
--   4. Corrections (D-013): employee requests (incl. a missing day), HR adjustments (maker-checker), approval by explicit
--      HR (hr.attendance.manage) or — when S&A creates it — a direct manager holding hr.mss.attendance_approve.
--      Original values are preserved on the correction row and in hr_attendance_audit.
--   5. Excel bulk import: preview (validation, canonical employee mapping by employee number / e-mail, duplicate and
--      conflict detection, per-row outcome) → explicit commit (re-validated, idempotent; the same file cannot be
--      committed twice in an organization).
--   6. Overtime (D-014, D-030): employee request (pre or post), day type derived by the database, policy-cap and
--      recorded-time flags, independent decision (explicit HR, or a direct manager with hr.mss.overtime_approve once
--      S&A creates the key), requester ≠ approver, one active request per employee and date, append-only status
--      history. No payroll calculation, no rate certification, no auto-approval (payroll consumption = Phase B).
--
-- Not done here: no S&A catalogue/grant/policy/mode change (hr.mss.attendance_approve and hr.mss.overtime_approve are
-- REQUESTED from S&A; until they exist only explicit HR decides); no attendance lock (PD-ATT-08); no cron schedule;
-- no GL/finance effect (D-015); no change to identity functions.
--
-- Dependencies: 20261221100000 (hr_actor_has_explicit, hr_request_db_role), 20261003100000 (hr_reset_scope),
-- canonical S&A (sa_evaluate_permission_core, sa_org_ancestry).
--
-- ROLLBACK (safe; never deletes attendance, exception, import or OT history):
--   drop trigger if exists hr_attendance_entries_api_guard on public.hr_attendance_entries;
--   drop trigger if exists hr_attendance_corrections_api_guard on public.hr_attendance_corrections;
--   drop trigger if exists hr_overtime_requests_api_guard on public.hr_overtime_requests;
--   (the previous direct-write behaviour of the old application build returns; the new build keeps working.)
--   Functions may stay (they only act when called). Tables hr_attendance_exceptions, hr_attendance_import_batches,
--   hr_attendance_import_rows, hr_overtime_request_events and the added columns are retained as evidence; drop only
--   with a recorded owner decision.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Prerequisites
-- ---------------------------------------------------------------------------
do $pre$
begin
  if to_regclass('public.hr_attendance_entries') is null or to_regclass('public.hr_attendance_corrections') is null
     or to_regclass('public.hr_overtime_requests') is null or to_regclass('public.hr_attendance_policies') is null
     or to_regclass('public.hr_shifts') is null or to_regclass('public.hr_public_holidays') is null
     or to_regclass('public.hr_attendance_audit') is null or to_regclass('public.hr_reset_scope') is null
     or to_regclass('public.hr_timesheets') is null or to_regclass('public.hr_leave_requests') is null then
    raise exception 'hr_w3_prerequisite_missing: attendance/overtime/leave base tables';
  end if;
  if to_regprocedure('public.hr_actor_has_explicit(uuid,text,jsonb)') is null
     or to_regprocedure('public.hr_request_db_role()') is null
     or to_regclass('public.hr_employee_statutory_profiles') is null then
    raise exception 'hr_w3_prerequisite_missing: Wave 2 (20261221100000_hr_employment_foundation) must be applied first';
  end if;
  if to_regprocedure('public.sa_evaluate_permission_core(uuid,text,jsonb,boolean,boolean)') is null
     or to_regprocedure('public.sa_org_ancestry(uuid)') is null then
    raise exception 'hr_w3_prerequisite_missing: canonical S&A evaluation';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Columns (additive)
-- ---------------------------------------------------------------------------
alter table public.hr_attendance_entries
  add column if not exists work_date date,
  add column if not exists review_state text not null default 'not_required',
  add column if not exists recorded_by_ref uuid,
  add column if not exists manual_reason text,
  add column if not exists import_batch_ref uuid,
  add column if not exists client_clock_in_at timestamptz,
  add column if not exists client_clock_out_at timestamptz;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'hr_attendance_entries_review_state_chk') then
    alter table public.hr_attendance_entries add constraint hr_attendance_entries_review_state_chk
      check (review_state in ('not_required', 'pending', 'resolved'));
  end if;
end $c$;
comment on column public.hr_attendance_entries.work_date is 'Local working date (organization attendance policy time zone) of clock_in_at.';
comment on column public.hr_attendance_entries.review_state is 'Auto-validation: not_required (valid, no review), pending (open exception), resolved.';
comment on column public.hr_attendance_entries.source is 'Capture channel: web, mobile, hr_manual, import, correction (legacy rows may hold other values).';

-- Backfill the local working date of existing rows (organization time zone, default Asia/Kuala_Lumpur).
update public.hr_attendance_entries e
   set work_date = (e.clock_in_at at time zone coalesce(
         (select p.timezone from public.hr_attendance_policies p where p.organization_id = e.organization_id), 'Asia/Kuala_Lumpur'))::date
 where e.work_date is null;
create index if not exists hr_attendance_entries_user_day_idx on public.hr_attendance_entries (organization_id, user_id, work_date);

alter table public.hr_attendance_corrections
  add column if not exists employee_ref uuid,
  add column if not exists work_date date,
  add column if not exists kind text not null default 'correction',
  add column if not exists corrected_break_minutes integer,
  add column if not exists created_entry_ref uuid;
alter table public.hr_attendance_corrections alter column entry_id drop not null;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'hr_attendance_corrections_kind_chk') then
    alter table public.hr_attendance_corrections add constraint hr_attendance_corrections_kind_chk
      check (kind in ('correction', 'missing_day', 'hr_adjustment'));
  end if;
end $c$;
update public.hr_attendance_corrections c
   set employee_ref = e.user_id, work_date = coalesce(c.work_date, e.work_date)
  from public.hr_attendance_entries e
 where e.id = c.entry_id and (c.employee_ref is null or c.work_date is null);

alter table public.hr_overtime_requests
  add column if not exists request_kind text not null default 'post',
  add column if not exists planned_start_at timestamptz,
  add column if not exists planned_end_at timestamptz,
  add column if not exists submitted_at timestamptz,
  add column if not exists decided_authority text,
  add column if not exists approved_minutes integer,
  add column if not exists exceeds_policy_cap boolean not null default false,
  add column if not exists exceeds_recorded_time boolean not null default false,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancel_reason text,
  add column if not exists idempotency_key text,
  add column if not exists payroll_consumed_ref uuid;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'hr_overtime_requests_kind_chk') then
    alter table public.hr_overtime_requests add constraint hr_overtime_requests_kind_chk check (request_kind in ('pre', 'post'));
  end if;
end $c$;
comment on column public.hr_overtime_requests.payroll_consumed_ref is 'Phase B: payroll run that consumed this approved OT. Unused in HR Core.';
create unique index if not exists hr_overtime_requests_idem_uniq on public.hr_overtime_requests (employee_id, idempotency_key)
  where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- 2. New tables (no foreign keys to people: *_ref columns, see E-02/E-17)
-- ---------------------------------------------------------------------------
create table if not exists public.hr_attendance_exceptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  employee_ref uuid not null,
  work_date date not null,
  exception_code text not null check (exception_code in ('late_arrival', 'early_departure', 'missing_clock_out',
                                      'absent_no_record', 'non_working_day_work', 'manual_entry')),
  entry_ref uuid,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'resolved', 'cleared')),
  resolution text check (resolution is null or resolution in ('acknowledged', 'excused', 'dismissed', 'corrected')),
  resolution_note text,
  resolved_by_ref uuid,
  resolved_authority text,
  resolved_at timestamptz,
  maker_ref uuid,
  detected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists hr_attendance_exceptions_uniq on public.hr_attendance_exceptions
  (organization_id, employee_ref, work_date, exception_code, coalesce(entry_ref, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists hr_attendance_exceptions_queue_idx on public.hr_attendance_exceptions (organization_id, status, work_date);

create table if not exists public.hr_attendance_import_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  file_name text not null,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'previewed' check (status in ('previewed', 'committed', 'cancelled')),
  row_count integer not null default 0,
  valid_count integer not null default 0,
  error_count integer not null default 0,
  duplicate_count integer not null default 0,
  conflict_count integer not null default 0,
  imported_count integer not null default 0,
  created_by_ref uuid not null,
  created_at timestamptz not null default now(),
  committed_by_ref uuid,
  committed_at timestamptz,
  cancelled_at timestamptz
);
create unique index if not exists hr_attendance_import_committed_file_uniq on public.hr_attendance_import_batches
  (organization_id, file_sha256) where status = 'committed';
create index if not exists hr_attendance_import_batches_org_idx on public.hr_attendance_import_batches (organization_id, created_at desc);

create table if not exists public.hr_attendance_import_rows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  batch_ref uuid not null,
  row_no integer not null,
  raw jsonb not null,
  employee_ref uuid,
  employee_no integer,
  work_date date,
  clock_in_at timestamptz,
  clock_out_at timestamptz,
  break_minutes integer,
  shift_ref uuid,
  outcome text not null check (outcome in ('valid', 'error', 'duplicate', 'conflict', 'imported')),
  messages text[] not null default '{}',
  entry_ref uuid,
  unique (batch_ref, row_no)
);

create table if not exists public.hr_overtime_request_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  request_ref uuid not null,
  action text not null,
  from_status text,
  to_status text,
  actor_ref uuid,
  authority text,
  comment text,
  created_at timestamptz not null default now()
);
create index if not exists hr_overtime_request_events_req_idx on public.hr_overtime_request_events (request_ref, created_at);

-- Sealed: no API privileges at all; read/write only through the functions below (service_role server routes).
do $s$
declare t text;
begin
  foreach t in array array['hr_attendance_exceptions', 'hr_attendance_import_batches', 'hr_attendance_import_rows',
                           'hr_overtime_request_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
  end loop;
end $s$;

-- Append-only for API roles and accidental owner edits; only database-owned maintenance (HR reset with snapshot)
-- may remove rows of the event log (it is in hr_reset_scope, captured and restorable).
create or replace function public.hr_w3_append_only()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $fn$
begin
  if tg_op = 'DELETE' and current_user not in ('anon', 'authenticated', 'service_role') then
    return old;
  end if;
  raise exception 'hr_history_append_only' using errcode = '42501', detail = tg_table_name || ' is append-only.';
end $fn$;
revoke all on function public.hr_w3_append_only() from public, anon, authenticated, service_role;
drop trigger if exists hr_overtime_request_events_append_only on public.hr_overtime_request_events;
create trigger hr_overtime_request_events_append_only before update or delete on public.hr_overtime_request_events
  for each row execute function public.hr_w3_append_only();

-- HR Data Management: transactional attendance data follows the existing attendance category (captured & restorable).
insert into public.hr_reset_scope(table_name, category, action, delete_order, label)
select v.t, 'attendance', 'delete', v.o, v.l
from (values ('hr_attendance_exceptions', 9, 'Attendance exceptions'),
             ('hr_overtime_request_events', 12, 'Overtime request history'),
             ('hr_attendance_import_rows', 16, 'Attendance import rows'),
             ('hr_attendance_import_batches', 17, 'Attendance import batches')) v(t, o, l)
where not exists (select 1 from public.hr_reset_scope s where s.table_name = v.t);

-- ---------------------------------------------------------------------------
-- 3. Direct-write guard (reliable records): API roles write only through the functions below
-- ---------------------------------------------------------------------------
create or replace function public.hr_attendance_api_guard()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $fn$
begin
  if current_user in ('anon', 'authenticated', 'service_role') then
    raise exception 'hr_attendance_direct_write_refused' using errcode = '42501',
      detail = tg_table_name || ' is written only through the HR attendance/overtime functions (server time, audit).';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $fn$;
revoke all on function public.hr_attendance_api_guard() from public, anon, authenticated, service_role;
drop trigger if exists hr_attendance_entries_api_guard on public.hr_attendance_entries;
create trigger hr_attendance_entries_api_guard before insert or update or delete on public.hr_attendance_entries
  for each row execute function public.hr_attendance_api_guard();
drop trigger if exists hr_attendance_corrections_api_guard on public.hr_attendance_corrections;
create trigger hr_attendance_corrections_api_guard before insert or update or delete on public.hr_attendance_corrections
  for each row execute function public.hr_attendance_api_guard();
drop trigger if exists hr_overtime_requests_api_guard on public.hr_overtime_requests;
create trigger hr_overtime_requests_api_guard before insert or update or delete on public.hr_overtime_requests
  for each row execute function public.hr_attendance_api_guard();

-- ---------------------------------------------------------------------------
-- 4. Helpers (service_role / database-internal only)
-- ---------------------------------------------------------------------------
create or replace function public.hr_att_tz(p_org uuid)
returns text language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select coalesce((select nullif(btrim(p.timezone), '') from public.hr_attendance_policies p where p.organization_id = p_org),
                  'Asia/Kuala_Lumpur')
$fn$;

create or replace function public.hr_att_local_date(p_org uuid, p_at timestamptz)
returns date language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select (p_at at time zone public.hr_att_tz(p_org))::date
$fn$;

create or replace function public.hr_att_local_ts(p_org uuid, p_date date, p_time time)
returns timestamptz language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select (p_date + p_time) at time zone public.hr_att_tz(p_org)
$fn$;

-- Active, non-archived account (an unexpired token of an archived person must not act).
create or replace function public.hr_att_assert_actor(p_actor uuid)
returns void language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
begin
  if p_actor is null or not exists (select 1 from public.users u where u.id = p_actor and u.is_active is true
                                    and coalesce(u.account_status, 'ACTIVE') <> 'ARCHIVED') then
    raise exception 'sa_actor_inactive' using errcode = '42501';
  end if;
end $fn$;

-- The person's CURRENT completed employment (Identity Stage 2: in users.organization_id).
create or replace function public.hr_att_employment(p_user uuid)
returns table (employment_id uuid, organization_id uuid, manager_user_id uuid, hire_date date, end_date date,
               employee_no integer, status text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select e.id, e.organization_id, e.manager_user_id, e.hire_date, e.end_date, e.employee_no, e.status
  from public.hr_employees e join public.users u on u.id = e.user_id and u.organization_id = e.organization_id
  where e.user_id = p_user and e.onboarding_status = 'completed'
  limit 1
$fn$;

create or replace function public.hr_att_hr_authority(p_actor uuid, p_org uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select p_actor is not null and p_org is not null
     and public.hr_actor_has_explicit(p_actor, 'hr.attendance.manage', jsonb_build_object('organization_id', p_org))
$fn$;

-- Direct manager with an explicit MSS permission of the employee's company (same rule as B2A D-022).
create or replace function public.hr_att_manager_authority(p_actor uuid, p_org uuid, p_employee uuid, p_permission text)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select p_actor is not null and p_org is not null and p_employee is not null and p_employee <> p_actor
     and p_permission in ('hr.mss.attendance_view', 'hr.mss.attendance_approve', 'hr.mss.overtime_approve')
     and exists (select 1 from public.hr_employees e
                 where e.user_id = p_employee and e.organization_id = p_org
                   and e.manager_user_id = p_actor and e.onboarding_status = 'completed')
     and exists (select 1 from public.hr_employees me
                 where me.user_id = p_actor and me.onboarding_status = 'completed'
                   and me.organization_id = any(public.sa_org_ancestry(p_org)))
     and public.hr_actor_has_explicit(p_actor, p_permission,
           jsonb_build_object('organization_id', p_org, 'owner_user_id', p_employee))
$fn$;

-- Who may decide an attendance item of p_employee: 'hr', 'manager' or null. Never the employee themself.
create or replace function public.hr_att_decider(p_actor uuid, p_org uuid, p_employee uuid, p_mss_permission text)
returns text language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select case
    when p_actor is null or p_actor = p_employee then null
    when public.hr_att_hr_authority(p_actor, p_org) then 'hr'
    when public.hr_att_manager_authority(p_actor, p_org, p_employee, p_mss_permission) then 'manager'
  end
$fn$;

create or replace function public.hr_att_can_view(p_actor uuid, p_org uuid, p_employee uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select p_actor = p_employee or public.hr_att_hr_authority(p_actor, p_org)
      or public.hr_att_manager_authority(p_actor, p_org, p_employee, 'hr.mss.attendance_view')
      or public.hr_att_manager_authority(p_actor, p_org, p_employee, 'hr.mss.attendance_approve')
      or public.hr_att_manager_authority(p_actor, p_org, p_employee, 'hr.mss.overtime_approve')
$fn$;

create or replace function public.hr_att_audit(p_org uuid, p_actor uuid, p_entity text, p_entity_id uuid, p_action text, p_meta jsonb)
returns void language sql security definer set search_path = pg_catalog, pg_temp as $fn$
  insert into public.hr_attendance_audit(organization_id, actor_user_id, entity_type, entity_id, action, metadata)
  values (p_org, p_actor, p_entity, p_entity_id, p_action, coalesce(p_meta, '{}'::jsonb));
$fn$;

-- Day type of a date for an employee: 'public_holiday', 'rest_day' (not a policy workday) or 'normal'.
-- National holidays (state null) and state holidays matching the employee's work state (statutory profile) count;
-- recurring holidays repeat on the same month/day.
create or replace function public.hr_att_day_type(p_org uuid, p_employee uuid, p_date date)
returns text language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_state text; v_names text[]; v_workdays text[];
begin
  select sp.work_state into v_state from public.hr_employee_statutory_profiles sp where sp.user_id = p_employee;
  v_names := case v_state
    when 'JHR' then array['johor'] when 'KDH' then array['kedah'] when 'KTN' then array['kelantan']
    when 'MLK' then array['melaka', 'malacca'] when 'NSN' then array['negeri sembilan'] when 'PHG' then array['pahang']
    when 'PNG' then array['pulau pinang', 'penang'] when 'PRK' then array['perak'] when 'PLS' then array['perlis']
    when 'SBH' then array['sabah'] when 'SWK' then array['sarawak'] when 'SGR' then array['selangor']
    when 'TRG' then array['terengganu'] when 'KUL' then array['kuala lumpur', 'wp kuala lumpur', 'w.p. kuala lumpur']
    when 'LBN' then array['labuan', 'wp labuan'] when 'PJY' then array['putrajaya', 'wp putrajaya'] else array[]::text[] end;
  if exists (select 1 from public.hr_public_holidays h
             where h.organization_id = any(public.sa_org_ancestry(p_org))
               and (h.date = p_date or (h.is_recurring and extract(month from h.date) = extract(month from p_date)
                                        and extract(day from h.date) = extract(day from p_date)))
               and (h.state is null or btrim(h.state) = '' or lower(btrim(h.state)) = any(v_names)
                    or upper(btrim(h.state)) = v_state)) then
    return 'public_holiday';
  end if;
  select p.workdays into v_workdays from public.hr_attendance_policies p where p.organization_id = p_org;
  v_workdays := coalesce(v_workdays, array['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  if not (to_char(p_date, 'Dy') = any(v_workdays)) then return 'rest_day'; end if;
  return 'normal';
end $fn$;

-- Approved leave covering the date (any part of the day)
create or replace function public.hr_att_on_leave(p_employee uuid, p_date date)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select exists (select 1 from public.hr_leave_requests r
                 where r.employee_id = p_employee and r.status = 'approved' and p_date between r.start_date and r.end_date)
$fn$;

create or replace function public.hr_att_minutes(p_in timestamptz, p_out timestamptz, p_break integer)
returns integer language sql immutable set search_path = pg_catalog, pg_temp as $fn$
  select case when p_in is null or p_out is null then null
              else greatest(0, round(extract(epoch from (p_out - p_in)) / 60)::integer - coalesce(p_break, 0)) end
$fn$;

-- Late/early flag against the entry's shift (no shift → no punctuality evaluation).
--   late  = arrival after shift start + coalesce(shift.grace_override_minutes, policy.late_after_minutes)
--   early = departure before shift end − policy.early_leave_before_minutes
create or replace function public.hr_att_flag(p_org uuid, p_shift uuid, p_work_date date, p_in timestamptz, p_out timestamptz)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare s record; v_late_after integer; v_early_before integer; v_start timestamptz; v_end timestamptz;
        v_late boolean := false; v_early boolean := false; v_late_min integer := 0; v_early_min integer := 0;
begin
  if p_shift is null then return jsonb_build_object('flag', 'ontime', 'evaluated', false); end if;
  select * into s from public.hr_shifts where id = p_shift;
  if not found then return jsonb_build_object('flag', 'ontime', 'evaluated', false); end if;
  select late_after_minutes, early_leave_before_minutes into v_late_after, v_early_before
    from public.hr_attendance_policies where organization_id = p_org;
  v_late_after := coalesce(v_late_after, 15); v_early_before := coalesce(v_early_before, 15);
  v_start := public.hr_att_local_ts(p_org, p_work_date, s.start_time);
  v_end := public.hr_att_local_ts(p_org, p_work_date, s.end_time);
  if v_end <= v_start then v_end := v_end + interval '1 day'; end if;          -- cross-midnight shift
  if p_in is not null and p_in > v_start + make_interval(mins => coalesce(s.grace_override_minutes, v_late_after)) then
    v_late := true; v_late_min := round(extract(epoch from (p_in - v_start)) / 60)::integer;
  end if;
  if p_out is not null and p_out < v_end - make_interval(mins => v_early_before) then
    v_early := true; v_early_min := round(extract(epoch from (v_end - p_out)) / 60)::integer;
  end if;
  return jsonb_build_object('flag', case when v_late and v_early then 'late_and_early' when v_late then 'late'
                                         when v_early then 'early_leave' else 'ontime' end,
                            'evaluated', true, 'late_minutes', v_late_min, 'early_minutes', v_early_min,
                            'shift_start', v_start, 'shift_end', v_end);
end $fn$;

-- Overlap of a proposed interval with the employee's other entries (open entries count as one minute).
create or replace function public.hr_att_overlaps(p_employee uuid, p_in timestamptz, p_out timestamptz, p_except uuid)
returns uuid language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select e.id from public.hr_attendance_entries e
  where e.user_id = p_employee and e.id is distinct from p_except
    and tstzrange(e.clock_in_at, coalesce(e.clock_out_at, e.clock_in_at + interval '1 minute'), '[)')
        && tstzrange(p_in, coalesce(p_out, p_in + interval '1 minute'), '[)')
  limit 1
$fn$;

-- Weekly timesheet summary (existing behaviour, minus the defect of resetting a submitted/approved period).
create or replace function public.hr_att_refresh_timesheet(p_org uuid, p_employee uuid, p_work_date date)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_start date := p_work_date - ((extract(isodow from p_work_date)::int + 6) % 7);
        v_end date := v_start + 6; v_total integer;
begin
  select coalesce(sum(worked_minutes), 0) into v_total from public.hr_attendance_entries
  where organization_id = p_org and user_id = p_employee and work_date between v_start and v_end;
  update public.hr_timesheets set total_minutes = v_total, updated_at = now()
  where user_id = p_employee and period_start = v_start and status in ('draft', 'pending');
  if not found and not exists (select 1 from public.hr_timesheets where user_id = p_employee and period_start = v_start) then
    insert into public.hr_timesheets(organization_id, user_id, period_start, period_end, total_minutes, status, period_type)
    values (p_org, p_employee, v_start, v_end, v_total, 'pending', 'weekly');
  end if;
end $fn$;

-- ---------------------------------------------------------------------------
-- 5. Exception detection (auto-validation, D-012) — idempotent, re-runnable
-- ---------------------------------------------------------------------------
-- Detects exceptions of one employee on one day; inserts new ones, clears open ones whose condition disappeared,
-- never touches resolved ones; updates the review state of the day's entries.
create or replace function public.hr_att_detect_day(p_org uuid, p_employee uuid, p_date date)
returns integer language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_today date := public.hr_att_local_date(p_org, now());
  v_max_open integer;
  v_day text;
  v_found jsonb := '[]'::jsonb;   -- [{code, entry, details}]
  v_emp record;
  r record; f jsonb; v_new integer := 0; v_n integer;
begin
  select * into v_emp from public.hr_att_employment(p_employee);
  if v_emp.employment_id is null or v_emp.organization_id <> p_org then return 0; end if;
  if v_emp.hire_date is not null and p_date < v_emp.hire_date then return 0; end if;
  if v_emp.end_date is not null and p_date > v_emp.end_date then return 0; end if;
  if p_date > v_today then return 0; end if;
  select coalesce(max_open_entry_hours, 16) into v_max_open from public.hr_attendance_policies where organization_id = p_org;
  v_max_open := coalesce(v_max_open, 16);
  v_day := public.hr_att_day_type(p_org, p_employee, p_date);

  for r in select * from public.hr_attendance_entries
           where organization_id = p_org and user_id = p_employee and work_date = p_date order by clock_in_at loop
    f := public.hr_att_flag(p_org, r.shift_id, p_date, r.clock_in_at, r.clock_out_at);
    if f->>'flag' in ('late', 'late_and_early') then
      v_found := v_found || jsonb_build_object('code', 'late_arrival', 'entry', r.id, 'details', jsonb_build_object('late_minutes', f->'late_minutes'));
    end if;
    if f->>'flag' in ('early_leave', 'late_and_early') then
      v_found := v_found || jsonb_build_object('code', 'early_departure', 'entry', r.id, 'details', jsonb_build_object('early_minutes', f->'early_minutes'));
    end if;
    if r.clock_out_at is null and r.clock_in_at < now() - make_interval(hours => v_max_open) then
      v_found := v_found || jsonb_build_object('code', 'missing_clock_out', 'entry', r.id, 'details', jsonb_build_object('max_open_hours', v_max_open));
    end if;
    if v_day <> 'normal' then
      v_found := v_found || jsonb_build_object('code', 'non_working_day_work', 'entry', r.id, 'details', jsonb_build_object('day_type', v_day));
    end if;
    if r.source = 'hr_manual' then
      v_found := v_found || jsonb_build_object('code', 'manual_entry', 'entry', r.id,
                                               'details', jsonb_build_object('reason', r.manual_reason), 'maker', r.recorded_by_ref);
    end if;
  end loop;

  if p_date < v_today and v_day = 'normal'
     and not exists (select 1 from public.hr_attendance_entries where organization_id = p_org and user_id = p_employee and work_date = p_date)
     and not public.hr_att_on_leave(p_employee, p_date) then
    v_found := v_found || jsonb_build_object('code', 'absent_no_record', 'entry', null, 'details', '{}'::jsonb);
  end if;

  -- insert new findings
  for f in select * from jsonb_array_elements(v_found) loop
    insert into public.hr_attendance_exceptions(organization_id, employee_ref, work_date, exception_code, entry_ref, details, maker_ref)
    values (p_org, p_employee, p_date, f->>'code', nullif(f->>'entry', '')::uuid, coalesce(f->'details', '{}'::jsonb),
            nullif(f->>'maker', '')::uuid)
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_new := v_new + v_n;
  end loop;

  -- clear open findings whose condition disappeared
  update public.hr_attendance_exceptions x set status = 'cleared', updated_at = now()
  where x.organization_id = p_org and x.employee_ref = p_employee and x.work_date = p_date and x.status = 'open'
    and not exists (select 1 from jsonb_array_elements(v_found) ff
                    where ff->>'code' = x.exception_code and nullif(ff->>'entry', '')::uuid is not distinct from x.entry_ref);

  -- review state of the day's entries
  update public.hr_attendance_entries e set review_state = case
      when exists (select 1 from public.hr_attendance_exceptions x where x.entry_ref = e.id and x.status = 'open') then 'pending'
      when exists (select 1 from public.hr_attendance_exceptions x where x.entry_ref = e.id and x.status = 'resolved') then 'resolved'
      else 'not_required' end
  where e.organization_id = p_org and e.user_id = p_employee and e.work_date = p_date
    and e.review_state is distinct from (case
      when exists (select 1 from public.hr_attendance_exceptions x where x.entry_ref = e.id and x.status = 'open') then 'pending'
      when exists (select 1 from public.hr_attendance_exceptions x where x.entry_ref = e.id and x.status = 'resolved') then 'resolved'
      else 'not_required' end);
  return v_new;
end $fn$;

-- HR-run detection for an organization and date range (≤ 62 days, never in the future).
create or replace function public.hr_attendance_run_detection(p_actor uuid, p_org uuid, p_from date, p_to date)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_to date; d date; e record; v_new integer := 0; v_days integer := 0;
begin
  perform public.hr_att_assert_actor(p_actor);
  if not public.hr_att_hr_authority(p_actor, p_org) then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.attendance.manage';
  end if;
  v_to := least(coalesce(p_to, public.hr_att_local_date(p_org, now())), public.hr_att_local_date(p_org, now()));
  if p_from is null or p_from > v_to or v_to - p_from > 62 then
    raise exception 'hr_attendance_range_invalid' using errcode = '22023';
  end if;
  for e in select x.user_id from public.hr_employees x join public.users u on u.id = x.user_id and u.organization_id = x.organization_id
           where x.organization_id = p_org and x.onboarding_status = 'completed' and x.status in ('active', 'probation')
             and u.is_active is true and coalesce(u.account_status, 'ACTIVE') <> 'ARCHIVED' loop
    d := p_from;
    while d <= v_to loop
      v_new := v_new + public.hr_att_detect_day(p_org, e.user_id, d);
      d := d + 1;
    end loop;
  end loop;
  v_days := v_to - p_from + 1;
  perform public.hr_att_audit(p_org, p_actor, 'attendance_detection', null, 'exceptions_detected',
                              jsonb_build_object('from', p_from, 'to', v_to, 'new_exceptions', v_new));
  return jsonb_build_object('status', 'ok', 'from', p_from, 'to', v_to, 'days', v_days, 'new_exceptions', v_new);
end $fn$;

-- ---------------------------------------------------------------------------
-- 6. Employee capture: clock in / clock out (server time)
-- ---------------------------------------------------------------------------
create or replace function public.hr_attendance_clock(p_actor uuid, p_action text, p_shift uuid default null,
                                                      p_source text default 'web', p_client_at timestamptz default null,
                                                      p_note text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_emp record; v_org uuid; v_now timestamptz := now(); v_open record; v_max_open integer; v_require boolean;
  v_break integer := 0; v_flag jsonb; v_id uuid; v_source text; v_minutes integer; v_date date;
begin
  perform public.hr_att_assert_actor(p_actor);
  select * into v_emp from public.hr_att_employment(p_actor);
  if v_emp.employment_id is null then raise exception 'hr_onboarding_pending' using errcode = 'P0001'; end if;
  if v_emp.status not in ('active', 'probation') then raise exception 'hr_employment_not_active' using errcode = '42501'; end if;
  v_org := v_emp.organization_id;
  v_source := case when p_source in ('web', 'mobile') then p_source else 'web' end;
  perform pg_advisory_xact_lock(hashtextextended('hr_att_clock:' || p_actor::text, 0));
  select coalesce(max_open_entry_hours, 16), coalesce(require_shift, false) into v_max_open, v_require
    from public.hr_attendance_policies where organization_id = v_org;
  v_max_open := coalesce(v_max_open, 16); v_require := coalesce(v_require, false);
  -- the open entry still inside the maximum open time; older open entries are "missing clock-out" exceptions
  select * into v_open from public.hr_attendance_entries
  where user_id = p_actor and clock_out_at is null and clock_in_at >= v_now - make_interval(hours => v_max_open)
  order by clock_in_at desc limit 1;

  if p_action = 'clock_in' then
    if v_open.id is not null then raise exception 'hr_attendance_already_clocked_in' using errcode = '22023'; end if;
    if p_shift is not null then
      select coalesce(s.break_minutes, 0) into v_break from public.hr_shifts s
       where s.id = p_shift and s.organization_id = any(public.sa_org_ancestry(v_org)) and s.is_active;
      if not found then raise exception 'hr_attendance_shift_invalid' using errcode = '22023'; end if;
    elsif v_require then
      raise exception 'hr_attendance_shift_required' using errcode = '22023';
    end if;
    v_date := public.hr_att_local_date(v_org, v_now);
    v_flag := public.hr_att_flag(v_org, p_shift, v_date, v_now, null);
    insert into public.hr_attendance_entries(organization_id, user_id, shift_id, clock_in_at, status, source, note, work_date,
                                             attendance_flag, review_state, client_clock_in_at, break_minutes)
    values (v_org, p_actor, p_shift, v_now, 'open', v_source, nullif(left(btrim(coalesce(p_note, '')), 500), ''), v_date,
            coalesce(v_flag->>'flag', 'ontime'), 'not_required', p_client_at, coalesce(v_break, 0))
    returning id into v_id;
    perform public.hr_att_audit(v_org, p_actor, 'entry', v_id, 'clock_in',
      jsonb_build_object('source', v_source, 'shift_id', p_shift, 'client_clock_skew_seconds',
                         case when p_client_at is null then null else round(extract(epoch from (p_client_at - v_now))) end));
    perform public.hr_att_detect_day(v_org, p_actor, v_date);
    -- earlier forgotten clock-outs become reviewable now
    perform public.hr_att_detect_day(v_org, p_actor, x.work_date)
      from (select distinct work_date from public.hr_attendance_entries
            where user_id = p_actor and clock_out_at is null and id <> v_id) x;
    return jsonb_build_object('status', 'clocked_in', 'entry_id', v_id, 'clock_in_at', v_now, 'work_date', v_date,
                              'attendance_flag', v_flag->>'flag');
  elsif p_action = 'clock_out' then
    if v_open.id is null then raise exception 'hr_attendance_not_clocked_in' using errcode = '22023'; end if;
    v_minutes := public.hr_att_minutes(v_open.clock_in_at, v_now, v_open.break_minutes);
    v_flag := public.hr_att_flag(v_org, v_open.shift_id, v_open.work_date, v_open.clock_in_at, v_now);
    update public.hr_attendance_entries
       set clock_out_at = v_now, worked_minutes = v_minutes, status = 'closed', updated_at = v_now,
           attendance_flag = coalesce(v_flag->>'flag', attendance_flag), client_clock_out_at = p_client_at
     where id = v_open.id;
    perform public.hr_att_audit(v_org, p_actor, 'entry', v_open.id, 'clock_out',
      jsonb_build_object('source', v_source, 'worked_minutes', v_minutes));
    perform public.hr_att_refresh_timesheet(v_org, p_actor, v_open.work_date);
    perform public.hr_att_detect_day(v_org, p_actor, v_open.work_date);
    return jsonb_build_object('status', 'clocked_out', 'entry_id', v_open.id, 'clock_out_at', v_now,
                              'worked_minutes', v_minutes, 'attendance_flag', v_flag->>'flag');
  end if;
  raise exception 'hr_attendance_action_invalid' using errcode = '22023';
end $fn$;

-- ---------------------------------------------------------------------------
-- 7. HR manual entry (on behalf; reason; immediate record + independent review by another person)
-- ---------------------------------------------------------------------------
create or replace function public.hr_attendance_manual_entry(p_actor uuid, p_employee uuid, p_work_date date,
                                                             p_clock_in time, p_clock_out time, p_break_minutes integer,
                                                             p_shift uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_emp record; v_in timestamptz; v_out timestamptz; v_id uuid; v_conflict uuid; v_flag jsonb;
begin
  perform public.hr_att_assert_actor(p_actor);
  if p_reason is null or length(btrim(p_reason)) < 5 then raise exception 'hr_reason_required' using errcode = '22023'; end if;
  select * into v_emp from public.hr_att_employment(p_employee);
  if v_emp.employment_id is null then raise exception 'hr_employment_not_found' using errcode = '22023'; end if;
  if not public.hr_att_hr_authority(p_actor, v_emp.organization_id) then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.attendance.manage';
  end if;
  if p_actor = p_employee then raise exception 'hr_self_change_prohibited' using errcode = '42501'; end if;
  if p_work_date is null or p_clock_in is null then raise exception 'hr_attendance_time_required' using errcode = '22023'; end if;
  if p_work_date > public.hr_att_local_date(v_emp.organization_id, now()) then
    raise exception 'hr_attendance_future_date' using errcode = '22023';
  end if;
  if v_emp.hire_date is not null and p_work_date < v_emp.hire_date then raise exception 'hr_attendance_before_hire' using errcode = '22023'; end if;
  if p_break_minutes is not null and (p_break_minutes < 0 or p_break_minutes > 600) then
    raise exception 'hr_attendance_break_invalid' using errcode = '22023';
  end if;
  if p_shift is not null and not exists (select 1 from public.hr_shifts where id = p_shift
                                         and organization_id = any(public.sa_org_ancestry(v_emp.organization_id))) then
    raise exception 'hr_attendance_shift_invalid' using errcode = '22023';
  end if;
  v_in := public.hr_att_local_ts(v_emp.organization_id, p_work_date, p_clock_in);
  if p_clock_out is not null then
    v_out := public.hr_att_local_ts(v_emp.organization_id, p_work_date, p_clock_out);
    if v_out <= v_in then v_out := v_out + interval '1 day'; end if;           -- overnight
    if v_out - v_in > interval '24 hours' then raise exception 'hr_attendance_duration_invalid' using errcode = '22023'; end if;
    if v_out > now() then raise exception 'hr_attendance_future_date' using errcode = '22023'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hr_att_clock:' || p_employee::text, 0));
  v_conflict := public.hr_att_overlaps(p_employee, v_in, v_out, null);
  if v_conflict is not null then raise exception 'hr_attendance_overlap' using errcode = '23P01'; end if;
  v_flag := public.hr_att_flag(v_emp.organization_id, p_shift, p_work_date, v_in, v_out);
  insert into public.hr_attendance_entries(organization_id, user_id, shift_id, clock_in_at, clock_out_at, worked_minutes, status,
                                           source, work_date, attendance_flag, review_state, recorded_by_ref, manual_reason, break_minutes)
  values (v_emp.organization_id, p_employee, p_shift, v_in, v_out, public.hr_att_minutes(v_in, v_out, coalesce(p_break_minutes, 0)),
          case when v_out is null then 'open' else 'closed' end, 'hr_manual', p_work_date, coalesce(v_flag->>'flag', 'ontime'),
          'pending', p_actor, left(btrim(p_reason), 500), coalesce(p_break_minutes, 0))
  returning id into v_id;
  perform public.hr_att_audit(v_emp.organization_id, p_actor, 'entry', v_id, 'hr_manual_entry',
    jsonb_build_object('employee', p_employee, 'work_date', p_work_date, 'clock_in_at', v_in, 'clock_out_at', v_out,
                       'break_minutes', coalesce(p_break_minutes, 0), 'reason', left(btrim(p_reason), 500)));
  if v_out is not null then perform public.hr_att_refresh_timesheet(v_emp.organization_id, p_employee, p_work_date); end if;
  perform public.hr_att_detect_day(v_emp.organization_id, p_employee, p_work_date);
  return jsonb_build_object('status', 'recorded', 'entry_id', v_id, 'review', 'pending_second_person');
end $fn$;

-- ---------------------------------------------------------------------------
-- 8. Corrections (D-013): request → independent decision; originals preserved
-- ---------------------------------------------------------------------------
create or replace function public.hr_attendance_request_correction(p_actor uuid, p_entry uuid, p_work_date date,
                                                                   p_clock_in time, p_clock_out time, p_break_minutes integer,
                                                                   p_reason text, p_on_behalf_of uuid default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_entry record; v_emp record; v_employee uuid; v_date date; v_in timestamptz; v_out timestamptz; v_kind text; v_id uuid;
        v_orig_in timestamptz; v_orig_out timestamptz; v_orig_min integer;
begin
  perform public.hr_att_assert_actor(p_actor);
  if p_reason is null or length(btrim(p_reason)) < 5 then raise exception 'hr_reason_required' using errcode = '22023'; end if;
  if p_entry is not null then
    select * into v_entry from public.hr_attendance_entries where id = p_entry;
    if not found then raise exception 'hr_attendance_entry_not_found' using errcode = '22023'; end if;
    v_employee := v_entry.user_id; v_date := v_entry.work_date;
    v_orig_in := v_entry.clock_in_at; v_orig_out := v_entry.clock_out_at; v_orig_min := v_entry.worked_minutes;
  else
    v_employee := coalesce(p_on_behalf_of, p_actor); v_date := p_work_date;
    if v_date is null then raise exception 'hr_attendance_time_required' using errcode = '22023'; end if;
  end if;
  select * into v_emp from public.hr_att_employment(v_employee);
  if v_emp.employment_id is null then raise exception 'hr_employment_not_found' using errcode = '22023'; end if;
  if v_employee = p_actor then
    if p_on_behalf_of is not null and p_on_behalf_of <> p_actor then raise exception 'hr_attendance_not_authorized' using errcode = '42501'; end if;
    v_kind := case when p_entry is null then 'missing_day' else 'correction' end;
  else
    -- HR adjustment on behalf (maker-checker: another person decides)
    if not public.hr_att_hr_authority(p_actor, v_emp.organization_id) then
      raise exception 'hr_attendance_not_authorized' using errcode = '42501';
    end if;
    v_kind := case when p_entry is null then 'missing_day' else 'hr_adjustment' end;
  end if;
  if v_date > public.hr_att_local_date(v_emp.organization_id, now()) then raise exception 'hr_attendance_future_date' using errcode = '22023'; end if;
  if p_entry is null and p_clock_in is null then raise exception 'hr_attendance_time_required' using errcode = '22023'; end if;
  if p_clock_in is null and p_clock_out is null and p_break_minutes is null then raise exception 'hr_changes_required' using errcode = '22023'; end if;
  if p_break_minutes is not null and (p_break_minutes < 0 or p_break_minutes > 600) then raise exception 'hr_attendance_break_invalid' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hr_att_corr:' || v_employee::text || ':' || coalesce(p_entry::text, v_date::text), 0));
  if exists (select 1 from public.hr_attendance_corrections c where c.status = 'pending'
             and ((p_entry is not null and c.entry_id = p_entry)
                  or (p_entry is null and c.entry_id is null and c.employee_ref = v_employee and c.work_date = v_date))) then
    raise exception 'hr_attendance_correction_pending' using errcode = '23505';
  end if;
  if p_clock_in is not null then v_in := public.hr_att_local_ts(v_emp.organization_id, v_date, p_clock_in); end if;
  if p_clock_out is not null then
    v_out := public.hr_att_local_ts(v_emp.organization_id, v_date, p_clock_out);
    if v_out <= coalesce(v_in, v_orig_in) then v_out := v_out + interval '1 day'; end if;
    if v_out - coalesce(v_in, v_orig_in) > interval '24 hours' then raise exception 'hr_attendance_duration_invalid' using errcode = '22023'; end if;
  end if;
  insert into public.hr_attendance_corrections(organization_id, entry_id, requested_by, reason, original_clock_in, original_clock_out,
            original_worked_minutes, corrected_clock_in, corrected_clock_out, corrected_break_minutes, status, employee_ref, work_date, kind)
  values (v_emp.organization_id, p_entry, p_actor, left(btrim(p_reason), 1000), v_orig_in, v_orig_out,
          v_orig_min, v_in, v_out, p_break_minutes, 'pending', v_employee, v_date, v_kind)
  returning id into v_id;
  perform public.hr_att_audit(v_emp.organization_id, p_actor, 'attendance_correction', v_id, 'correction_requested',
    jsonb_build_object('kind', v_kind, 'entry_id', p_entry, 'employee', v_employee, 'work_date', v_date));
  return jsonb_build_object('status', 'pending', 'correction_id', v_id, 'kind', v_kind);
end $fn$;

create or replace function public.hr_attendance_cancel_correction(p_actor uuid, p_correction uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare c record;
begin
  perform public.hr_att_assert_actor(p_actor);
  select * into c from public.hr_attendance_corrections where id = p_correction for update;
  if not found then raise exception 'hr_attendance_correction_not_found' using errcode = '22023'; end if;
  if c.requested_by <> p_actor then raise exception 'hr_attendance_not_authorized' using errcode = '42501'; end if;
  if c.status <> 'pending' then raise exception 'hr_attendance_already_decided' using errcode = '22023'; end if;
  update public.hr_attendance_corrections set status = 'cancelled', updated_at = now() where id = p_correction;
  perform public.hr_att_audit(c.organization_id, p_actor, 'attendance_correction', p_correction, 'correction_cancelled', '{}'::jsonb);
  return jsonb_build_object('status', 'cancelled');
end $fn$;

create or replace function public.hr_attendance_decide_correction(p_actor uuid, p_correction uuid, p_decision text, p_comment text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare c record; e record; v_auth text; v_in timestamptz; v_out timestamptz; v_break integer; v_minutes integer;
        v_entry uuid; v_flag jsonb; v_conflict uuid;
begin
  perform public.hr_att_assert_actor(p_actor);
  if p_decision not in ('approved', 'rejected') then raise exception 'hr_attendance_action_invalid' using errcode = '22023'; end if;
  select * into c from public.hr_attendance_corrections where id = p_correction for update;
  if not found then raise exception 'hr_attendance_correction_not_found' using errcode = '22023'; end if;
  if c.status <> 'pending' then raise exception 'hr_attendance_already_decided' using errcode = '22023'; end if;
  if p_actor = c.requested_by or p_actor = c.employee_ref then raise exception 'hr_attendance_self_review' using errcode = '42501'; end if;
  v_auth := public.hr_att_decider(p_actor, c.organization_id, c.employee_ref, 'hr.mss.attendance_approve');
  if v_auth is null then raise exception 'hr_attendance_not_authorized' using errcode = '42501'; end if;
  if p_decision = 'rejected' and (p_comment is null or length(btrim(p_comment)) < 3) then
    raise exception 'hr_comment_required' using errcode = '22023';
  end if;

  if p_decision = 'approved' then
    perform pg_advisory_xact_lock(hashtextextended('hr_att_clock:' || c.employee_ref::text, 0));
    if c.entry_id is not null then
      select * into e from public.hr_attendance_entries where id = c.entry_id for update;
      if not found then raise exception 'hr_attendance_entry_not_found' using errcode = '22023'; end if;
      v_in := coalesce(c.corrected_clock_in, e.clock_in_at);
      v_out := coalesce(c.corrected_clock_out, e.clock_out_at);
      v_break := coalesce(c.corrected_break_minutes, e.break_minutes, 0);
      if v_out is not null and (v_out <= v_in or v_out - v_in > interval '24 hours') then
        raise exception 'hr_attendance_duration_invalid' using errcode = '22023';
      end if;
      v_conflict := public.hr_att_overlaps(c.employee_ref, v_in, v_out, e.id);
      if v_conflict is not null then raise exception 'hr_attendance_overlap' using errcode = '23P01'; end if;
      v_minutes := public.hr_att_minutes(v_in, v_out, v_break);
      v_flag := public.hr_att_flag(c.organization_id, e.shift_id, e.work_date, v_in, v_out);
      update public.hr_attendance_entries
         set clock_in_at = v_in, clock_out_at = v_out, break_minutes = v_break, worked_minutes = v_minutes,
             status = case when v_out is null then 'open' else 'adjusted' end, updated_at = now(),
             work_date = public.hr_att_local_date(c.organization_id, v_in), attendance_flag = coalesce(v_flag->>'flag', attendance_flag)
       where id = e.id;
      v_entry := e.id;
    else
      v_in := c.corrected_clock_in; v_out := c.corrected_clock_out; v_break := coalesce(c.corrected_break_minutes, 0);
      v_conflict := public.hr_att_overlaps(c.employee_ref, v_in, v_out, null);
      if v_conflict is not null then raise exception 'hr_attendance_overlap' using errcode = '23P01'; end if;
      insert into public.hr_attendance_entries(organization_id, user_id, clock_in_at, clock_out_at, worked_minutes, status, source,
                                               work_date, review_state, recorded_by_ref, manual_reason, break_minutes)
      values (c.organization_id, c.employee_ref, v_in, v_out, public.hr_att_minutes(v_in, v_out, v_break),
              case when v_out is null then 'open' else 'closed' end, 'correction', c.work_date, 'not_required', c.requested_by,
              left(c.reason, 500), v_break)
      returning id into v_entry;
    end if;
  end if;

  update public.hr_attendance_corrections
     set status = p_decision, reviewed_by = p_actor, reviewed_at = now(), review_comment = nullif(btrim(coalesce(p_comment, '')), ''),
         corrected_worked_minutes = case when p_decision = 'approved' then public.hr_att_minutes(v_in, v_out, v_break) end,
         created_entry_ref = case when p_decision = 'approved' and c.entry_id is null then v_entry end, updated_at = now()
   where id = c.id;
  perform public.hr_att_audit(c.organization_id, p_actor, 'attendance_correction', c.id,
    case when p_decision = 'approved' then 'correction_approved' else 'correction_rejected' end,
    jsonb_build_object('authority', v_auth, 'entry_id', coalesce(c.entry_id, v_entry), 'requested_by', c.requested_by,
                       'kind', c.kind, 'comment', nullif(btrim(coalesce(p_comment, '')), ''),
                       'before', jsonb_build_object('clock_in_at', c.original_clock_in, 'clock_out_at', c.original_clock_out,
                                                    'worked_minutes', c.original_worked_minutes),
                       'after', case when p_decision = 'approved' then jsonb_build_object('clock_in_at', v_in, 'clock_out_at', v_out,
                                     'worked_minutes', public.hr_att_minutes(v_in, v_out, v_break)) end));
  if p_decision = 'approved' then
    update public.hr_attendance_exceptions set status = 'resolved', resolution = 'corrected', resolved_by_ref = p_actor,
           resolved_authority = v_auth, resolved_at = now(), resolution_note = 'Corrected by approved correction ' || c.id::text,
           updated_at = now()
     where organization_id = c.organization_id and employee_ref = c.employee_ref and work_date = c.work_date and status = 'open'
       and exception_code in ('late_arrival', 'early_departure', 'missing_clock_out', 'absent_no_record');
    perform public.hr_att_refresh_timesheet(c.organization_id, c.employee_ref, c.work_date);
    perform public.hr_att_detect_day(c.organization_id, c.employee_ref, c.work_date);
  end if;
  return jsonb_build_object('status', p_decision, 'authority', v_auth, 'entry_id', v_entry);
end $fn$;

-- ---------------------------------------------------------------------------
-- 9. Exception review (independent)
-- ---------------------------------------------------------------------------
create or replace function public.hr_attendance_resolve_exception(p_actor uuid, p_exception uuid, p_resolution text, p_note text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare x record; v_auth text;
begin
  perform public.hr_att_assert_actor(p_actor);
  if p_resolution not in ('acknowledged', 'excused', 'dismissed') then raise exception 'hr_attendance_action_invalid' using errcode = '22023'; end if;
  select * into x from public.hr_attendance_exceptions where id = p_exception for update;
  if not found then raise exception 'hr_attendance_exception_not_found' using errcode = '22023'; end if;
  if x.status <> 'open' then raise exception 'hr_attendance_already_decided' using errcode = '22023'; end if;
  if p_actor = x.employee_ref then raise exception 'hr_attendance_self_review' using errcode = '42501'; end if;
  if x.exception_code = 'manual_entry' then
    if p_actor = x.maker_ref then raise exception 'hr_attendance_maker_checker' using errcode = '42501'; end if;
    v_auth := case when public.hr_att_hr_authority(p_actor, x.organization_id) then 'hr' end;   -- HR entries: HR reviews
  else
    v_auth := public.hr_att_decider(p_actor, x.organization_id, x.employee_ref, 'hr.mss.attendance_approve');
  end if;
  if v_auth is null then raise exception 'hr_attendance_not_authorized' using errcode = '42501'; end if;
  if p_resolution in ('excused', 'dismissed') and (p_note is null or length(btrim(p_note)) < 3) then
    raise exception 'hr_comment_required' using errcode = '22023';
  end if;
  update public.hr_attendance_exceptions
     set status = 'resolved', resolution = p_resolution, resolution_note = nullif(btrim(coalesce(p_note, '')), ''),
         resolved_by_ref = p_actor, resolved_authority = v_auth, resolved_at = now(), updated_at = now()
   where id = x.id;
  perform public.hr_att_audit(x.organization_id, p_actor, 'attendance_exception', x.id, 'exception_resolved',
    jsonb_build_object('code', x.exception_code, 'resolution', p_resolution, 'authority', v_auth, 'employee', x.employee_ref,
                       'work_date', x.work_date));
  perform public.hr_att_detect_day(x.organization_id, x.employee_ref, x.work_date);
  return jsonb_build_object('status', 'resolved', 'resolution', p_resolution, 'authority', v_auth);
end $fn$;

-- ---------------------------------------------------------------------------
-- 10. Excel bulk import: preview → commit
-- ---------------------------------------------------------------------------
-- p_rows: [{row_no, employee_no, email, work_date 'YYYY-MM-DD', clock_in 'HH:MM', clock_out 'HH:MM'|null,
--           break_minutes, shift, note}]  (the browser converts Excel cells; the database validates everything again)
create or replace function public.hr_att_import_validate_row(p_org uuid, p_row jsonb)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  m text[] := '{}'; v_emp uuid; v_no integer; v_date date; v_in time; v_out time; v_tin timestamptz; v_tout timestamptz;
  v_break integer; v_shift uuid; v_email text := lower(btrim(coalesce(p_row->>'email', ''))); v_raw_no text := btrim(coalesce(p_row->>'employee_no', ''));
  v_today date := public.hr_att_local_date(p_org, now()); v_hire date; v_end date;
begin
  if v_raw_no <> '' then
    if v_raw_no !~ '^\d{1,9}$' then m := m || 'Employee number must be digits.'::text; else v_no := v_raw_no::integer; end if;
  end if;
  if v_no is not null then
    select e.user_id, e.hire_date, e.end_date into v_emp, v_hire, v_end from public.hr_employees e
    join public.users u on u.id = e.user_id and u.organization_id = e.organization_id
    where e.employee_no = v_no and e.organization_id = p_org and e.onboarding_status = 'completed';
    if v_emp is null then m := m || 'No onboarded employee with this employee number in this company.'::text; end if;
    if v_emp is not null and v_email <> '' and not exists (select 1 from public.users u where u.id = v_emp and lower(u.email) = v_email) then
      m := m || 'Employee number and e-mail belong to different people.'::text; v_emp := null;
    end if;
  elsif v_email <> '' then
    select e.user_id, e.hire_date, e.end_date into v_emp, v_hire, v_end from public.hr_employees e
    join public.users u on u.id = e.user_id and u.organization_id = e.organization_id
    where lower(u.email) = v_email and e.organization_id = p_org and e.onboarding_status = 'completed';
    if v_emp is null then m := m || 'No onboarded employee with this e-mail in this company.'::text; end if;
  else
    m := m || 'Employee number or e-mail is required.'::text;
  end if;
  if coalesce(p_row->>'work_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then m := m || 'Work date must be YYYY-MM-DD.'::text;
  else begin v_date := (p_row->>'work_date')::date; exception when others then m := m || 'Work date is not a valid date.'::text; end;
  end if;
  if coalesce(p_row->>'clock_in', '') !~ '^\d{1,2}:\d{2}(:\d{2})?$' then m := m || 'Clock in must be HH:MM (24-hour).'::text;
  else begin v_in := (p_row->>'clock_in')::time; exception when others then m := m || 'Clock in is not a valid time.'::text; end;
  end if;
  if nullif(btrim(coalesce(p_row->>'clock_out', '')), '') is not null then
    if (p_row->>'clock_out') !~ '^\d{1,2}:\d{2}(:\d{2})?$' then m := m || 'Clock out must be HH:MM (24-hour).'::text;
    else begin v_out := (p_row->>'clock_out')::time; exception when others then m := m || 'Clock out is not a valid time.'::text; end;
    end if;
  else
    m := m || 'Clock out is required for imported attendance.'::text;
  end if;
  if nullif(btrim(coalesce(p_row->>'break_minutes', '')), '') is not null then
    if (p_row->>'break_minutes') !~ '^\d{1,3}$' or (p_row->>'break_minutes')::integer > 600 then m := m || 'Break minutes must be 0–600.'::text;
    else v_break := (p_row->>'break_minutes')::integer; end if;
  end if;
  if nullif(btrim(coalesce(p_row->>'shift', '')), '') is not null then
    select s.id into v_shift from public.hr_shifts s where s.organization_id = any(public.sa_org_ancestry(p_org))
      and lower(s.name) = lower(btrim(p_row->>'shift')) and s.is_active order by s.created_at limit 1;
    if v_shift is null then m := m || 'Unknown shift name.'::text; end if;
  end if;
  if v_date is not null then
    if v_date > v_today then m := m || 'Work date is in the future.'::text; end if;
    if v_date < v_today - 400 then m := m || 'Work date is more than 400 days ago.'::text; end if;
    if v_hire is not null and v_date < v_hire then m := m || 'Work date is before the hire date.'::text; end if;
    if v_end is not null and v_date > v_end then m := m || 'Work date is after the employment end date.'::text; end if;
  end if;
  if v_date is not null and v_in is not null then
    v_tin := public.hr_att_local_ts(p_org, v_date, v_in);
    if v_out is not null then
      v_tout := public.hr_att_local_ts(p_org, v_date, v_out);
      if v_tout <= v_tin then v_tout := v_tout + interval '1 day'; end if;
      if v_tout - v_tin > interval '20 hours' then m := m || 'Shift longer than 20 hours.'::text; end if;
      if v_tout > now() then m := m || 'Clock out is in the future.'::text; end if;
      if v_break is not null and v_break >= extract(epoch from (v_tout - v_tin)) / 60 then m := m || 'Break is longer than the shift.'::text; end if;
    end if;
  end if;
  return jsonb_build_object('messages', to_jsonb(m), 'employee', v_emp, 'employee_no', v_no, 'work_date', v_date,
                            'clock_in_at', v_tin, 'clock_out_at', v_tout, 'break_minutes', coalesce(v_break, 0), 'shift', v_shift);
end $fn$;

create or replace function public.hr_attendance_import_preview(p_actor uuid, p_org uuid, p_file_name text, p_file_sha256 text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_batch uuid; r jsonb; v jsonb; v_outcome text; v_msgs text[]; v_no integer := 0; v_seen text[] := '{}'; v_key text;
        v_dup uuid; v_conf uuid; v_valid integer := 0; v_err integer := 0; v_dupn integer := 0; v_confn integer := 0;
begin
  perform public.hr_att_assert_actor(p_actor);
  if not public.hr_att_hr_authority(p_actor, p_org) then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.attendance.manage';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' or coalesce(btrim(p_file_name), '') = '' then
    raise exception 'hr_import_file_invalid' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'hr_import_empty' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'hr_import_too_many_rows' using errcode = '22023'; end if;
  if exists (select 1 from public.hr_attendance_import_batches where organization_id = p_org and file_sha256 = p_file_sha256 and status = 'committed') then
    raise exception 'hr_import_file_already_committed' using errcode = '23505';
  end if;
  -- an earlier preview of the same file by anyone is superseded (never committed)
  update public.hr_attendance_import_batches set status = 'cancelled', cancelled_at = now()
   where organization_id = p_org and file_sha256 = p_file_sha256 and status = 'previewed';
  insert into public.hr_attendance_import_batches(organization_id, file_name, file_sha256, created_by_ref)
  values (p_org, left(btrim(p_file_name), 200), p_file_sha256, p_actor) returning id into v_batch;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_no := v_no + 1;
    v := public.hr_att_import_validate_row(p_org, r);
    v_msgs := array(select jsonb_array_elements_text(v->'messages'));
    v_outcome := case when cardinality(v_msgs) > 0 then 'error' else 'valid' end;
    if v_outcome = 'valid' then
      v_key := (v->>'employee') || '|' || (v->>'clock_in_at');
      if v_key = any(v_seen) then
        v_outcome := 'duplicate'; v_msgs := v_msgs || 'Same employee and clock-in appear earlier in this file.'::text;
      else
        v_seen := v_seen || v_key;
        select e.id into v_dup from public.hr_attendance_entries e
          where e.user_id = (v->>'employee')::uuid and e.clock_in_at = (v->>'clock_in_at')::timestamptz
            and e.clock_out_at is not distinct from (v->>'clock_out_at')::timestamptz limit 1;
        if v_dup is not null then
          v_outcome := 'duplicate'; v_msgs := v_msgs || 'This attendance is already recorded (no change).'::text;
        else
          v_conf := public.hr_att_overlaps((v->>'employee')::uuid, (v->>'clock_in_at')::timestamptz, (v->>'clock_out_at')::timestamptz, null);
          if v_conf is not null then
            v_outcome := 'conflict'; v_msgs := v_msgs || 'Overlaps attendance already recorded for this employee (not overwritten).'::text;
          end if;
        end if;
      end if;
    end if;
    insert into public.hr_attendance_import_rows(organization_id, batch_ref, row_no, raw, employee_ref, employee_no, work_date,
                                                 clock_in_at, clock_out_at, break_minutes, shift_ref, outcome, messages)
    values (p_org, v_batch, coalesce(nullif(r->>'row_no', '')::integer, v_no), r, nullif(v->>'employee', '')::uuid,
            nullif(v->>'employee_no', '')::integer, nullif(v->>'work_date', '')::date, nullif(v->>'clock_in_at', '')::timestamptz,
            nullif(v->>'clock_out_at', '')::timestamptz, nullif(v->>'break_minutes', '')::integer, nullif(v->>'shift', '')::uuid,
            v_outcome, v_msgs);
    v_valid := v_valid + (v_outcome = 'valid')::int; v_err := v_err + (v_outcome = 'error')::int;
    v_dupn := v_dupn + (v_outcome = 'duplicate')::int; v_confn := v_confn + (v_outcome = 'conflict')::int;
  end loop;
  update public.hr_attendance_import_batches set row_count = v_no, valid_count = v_valid, error_count = v_err,
         duplicate_count = v_dupn, conflict_count = v_confn where id = v_batch;
  perform public.hr_att_audit(p_org, p_actor, 'attendance_import', v_batch, 'import_previewed',
    jsonb_build_object('file_name', left(btrim(p_file_name), 200), 'file_sha256', p_file_sha256, 'rows', v_no, 'valid', v_valid,
                       'errors', v_err, 'duplicates', v_dupn, 'conflicts', v_confn));
  return public.hr_attendance_import_batch_get(p_actor, v_batch);
end $fn$;

create or replace function public.hr_attendance_import_batch_get(p_actor uuid, p_batch uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare b record;
begin
  select * into b from public.hr_attendance_import_batches where id = p_batch;
  if not found then raise exception 'hr_import_batch_not_found' using errcode = '22023'; end if;
  if not public.hr_att_hr_authority(p_actor, b.organization_id) then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.attendance.manage';
  end if;
  return jsonb_build_object('batch', to_jsonb(b), 'rows', coalesce((
    select jsonb_agg(jsonb_build_object('row_no', r.row_no, 'outcome', r.outcome, 'messages', to_jsonb(r.messages),
             'employee_no', r.employee_no, 'employee_name', u.full_name, 'work_date', r.work_date, 'clock_in_at', r.clock_in_at,
             'clock_out_at', r.clock_out_at, 'break_minutes', r.break_minutes, 'entry_id', r.entry_ref, 'raw', r.raw)
           order by r.row_no)
    from public.hr_attendance_import_rows r left join public.users u on u.id = r.employee_ref where r.batch_ref = p_batch), '[]'::jsonb));
end $fn$;

create or replace function public.hr_attendance_import_commit(p_actor uuid, p_batch uuid, p_expected_valid integer)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare b record; r record; v_id uuid; v_imported integer := 0; v_conflicts integer := 0; v_flag jsonb; v_days jsonb := '[]'::jsonb; d record;
begin
  perform public.hr_att_assert_actor(p_actor);
  select * into b from public.hr_attendance_import_batches where id = p_batch for update;
  if not found then raise exception 'hr_import_batch_not_found' using errcode = '22023'; end if;
  if not public.hr_att_hr_authority(p_actor, b.organization_id) then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.attendance.manage';
  end if;
  if b.status = 'committed' then
    return jsonb_build_object('status', 'already_committed', 'imported', b.imported_count, 'batch_id', b.id);   -- idempotent retry
  end if;
  if b.status <> 'previewed' then raise exception 'hr_import_batch_not_open' using errcode = '22023'; end if;
  if p_expected_valid is distinct from b.valid_count then raise exception 'hr_import_preview_changed' using errcode = '22023'; end if;
  if b.valid_count = 0 then raise exception 'hr_import_nothing_valid' using errcode = '22023'; end if;
  if b.created_at < now() - interval '24 hours' then raise exception 'hr_import_preview_expired' using errcode = '22023'; end if;
  if exists (select 1 from public.hr_attendance_import_batches where organization_id = b.organization_id
             and file_sha256 = b.file_sha256 and status = 'committed') then
    raise exception 'hr_import_file_already_committed' using errcode = '23505';
  end if;
  for r in select * from public.hr_attendance_import_rows where batch_ref = p_batch and outcome = 'valid' order by row_no loop
    perform pg_advisory_xact_lock(hashtextextended('hr_att_clock:' || r.employee_ref::text, 0));
    -- re-validated at commit: the person must still be employed here and nothing may overlap now
    if not exists (select 1 from public.hr_att_employment(r.employee_ref) x where x.organization_id = b.organization_id)
       or public.hr_att_overlaps(r.employee_ref, r.clock_in_at, r.clock_out_at, null) is not null then
      update public.hr_attendance_import_rows set outcome = 'conflict',
             messages = messages || 'Changed since the preview: overlaps attendance recorded meanwhile (not imported).'::text
       where id = r.id;
      v_conflicts := v_conflicts + 1;
      continue;
    end if;
    v_flag := public.hr_att_flag(b.organization_id, r.shift_ref, r.work_date, r.clock_in_at, r.clock_out_at);
    insert into public.hr_attendance_entries(organization_id, user_id, shift_id, clock_in_at, clock_out_at, worked_minutes, status,
                                             source, note, work_date, attendance_flag, review_state, recorded_by_ref,
                                             import_batch_ref, break_minutes)
    values (b.organization_id, r.employee_ref, r.shift_ref, r.clock_in_at, r.clock_out_at,
            public.hr_att_minutes(r.clock_in_at, r.clock_out_at, r.break_minutes), 'closed', 'import',
            nullif(left(btrim(coalesce(r.raw->>'note', '')), 500), ''), r.work_date, coalesce(v_flag->>'flag', 'ontime'),
            'not_required', p_actor, p_batch, coalesce(r.break_minutes, 0))
    returning id into v_id;
    update public.hr_attendance_import_rows set outcome = 'imported', entry_ref = v_id where id = r.id;
    v_imported := v_imported + 1;
    v_days := v_days || jsonb_build_object('e', r.employee_ref, 'd', r.work_date);
  end loop;
  for d in select distinct (x->>'e')::uuid as e, (x->>'d')::date as dt from jsonb_array_elements(v_days) x loop
    perform public.hr_att_refresh_timesheet(b.organization_id, d.e, d.dt);
    perform public.hr_att_detect_day(b.organization_id, d.e, d.dt);
  end loop;
  update public.hr_attendance_import_batches set status = 'committed', committed_by_ref = p_actor, committed_at = now(),
         imported_count = v_imported, conflict_count = conflict_count + v_conflicts, valid_count = valid_count - v_conflicts
   where id = p_batch;
  perform public.hr_att_audit(b.organization_id, p_actor, 'attendance_import', p_batch, 'import_committed',
    jsonb_build_object('imported', v_imported, 'conflicts_at_commit', v_conflicts, 'file_sha256', b.file_sha256));
  return jsonb_build_object('status', 'committed', 'batch_id', p_batch, 'imported', v_imported, 'conflicts_at_commit', v_conflicts);
end $fn$;

create or replace function public.hr_attendance_import_cancel(p_actor uuid, p_batch uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare b record;
begin
  perform public.hr_att_assert_actor(p_actor);
  select * into b from public.hr_attendance_import_batches where id = p_batch for update;
  if not found then raise exception 'hr_import_batch_not_found' using errcode = '22023'; end if;
  if not public.hr_att_hr_authority(p_actor, b.organization_id) then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.attendance.manage';
  end if;
  if b.status <> 'previewed' then raise exception 'hr_import_batch_not_open' using errcode = '22023'; end if;
  update public.hr_attendance_import_batches set status = 'cancelled', cancelled_at = now() where id = p_batch;
  perform public.hr_att_audit(b.organization_id, p_actor, 'attendance_import', p_batch, 'import_cancelled', '{}'::jsonb);
  return jsonb_build_object('status', 'cancelled');
end $fn$;

create or replace function public.hr_attendance_import_batches_list(p_actor uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
begin
  if not public.hr_att_hr_authority(p_actor, p_org) then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.attendance.manage';
  end if;
  return coalesce((select jsonb_agg(to_jsonb(b) - 'organization_id' || jsonb_build_object('created_by_name', u.full_name)
                                    order by b.created_at desc)
                   from (select * from public.hr_attendance_import_batches where organization_id = p_org
                         order by created_at desc limit 50) b
                   left join public.users u on u.id = b.created_by_ref), '[]'::jsonb);
end $fn$;

-- ---------------------------------------------------------------------------
-- 11. Overtime workflow (B5)
-- ---------------------------------------------------------------------------
create or replace function public.hr_ot_event(p_org uuid, p_req uuid, p_action text, p_from text, p_to text, p_actor uuid,
                                              p_authority text, p_comment text)
returns void language sql security definer set search_path = pg_catalog, pg_temp as $fn$
  insert into public.hr_overtime_request_events(organization_id, request_ref, action, from_status, to_status, actor_ref, authority, comment)
  values (p_org, p_req, p_action, p_from, p_to, p_actor, p_authority, nullif(left(btrim(coalesce(p_comment, '')), 1000), ''));
$fn$;

create or replace function public.hr_overtime_submit(p_actor uuid, p_request_date date, p_minutes integer, p_reason text,
                                                     p_kind text default 'post', p_entry uuid default null,
                                                     p_planned_start time default null, p_planned_end time default null,
                                                     p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_emp record; v_existing record; v_today date; v_day text; v_cap integer; v_enabled boolean; v_entry record;
        v_exceeds_cap boolean := false; v_exceeds_rec boolean := false; v_id uuid; v_ps timestamptz; v_pe timestamptz;
        v_expected integer;
begin
  perform public.hr_att_assert_actor(p_actor);
  select * into v_emp from public.hr_att_employment(p_actor);
  if v_emp.employment_id is null then raise exception 'hr_onboarding_pending' using errcode = 'P0001'; end if;
  if v_emp.status not in ('active', 'probation') then raise exception 'hr_employment_not_active' using errcode = '42501'; end if;
  if p_idempotency_key is not null then
    select * into v_existing from public.hr_overtime_requests where employee_id = p_actor and idempotency_key = p_idempotency_key;
    if found then return jsonb_build_object('status', v_existing.status, 'request_id', v_existing.id, 'replayed', true); end if;
  end if;
  if p_kind not in ('pre', 'post') then raise exception 'hr_attendance_action_invalid' using errcode = '22023'; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then raise exception 'hr_reason_required' using errcode = '22023'; end if;
  if p_minutes is null or p_minutes < 15 or p_minutes > 720 then raise exception 'hr_ot_minutes_invalid' using errcode = '22023'; end if;
  if p_request_date is null then raise exception 'hr_attendance_time_required' using errcode = '22023'; end if;
  v_today := public.hr_att_local_date(v_emp.organization_id, now());
  if p_kind = 'post' and p_request_date > v_today then raise exception 'hr_ot_post_in_future' using errcode = '22023'; end if;
  if p_kind = 'pre' and p_request_date < v_today then raise exception 'hr_ot_pre_in_past' using errcode = '22023'; end if;
  if p_request_date < v_today - 60 then raise exception 'hr_ot_too_old' using errcode = '22023'; end if;
  if v_emp.hire_date is not null and p_request_date < v_emp.hire_date then raise exception 'hr_attendance_before_hire' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hr_ot:' || p_actor::text || ':' || p_request_date::text, 0));
  if exists (select 1 from public.hr_overtime_requests where employee_id = p_actor and request_date = p_request_date
             and status in ('draft', 'submitted', 'approved')) then
    raise exception 'hr_ot_duplicate' using errcode = '23505';
  end if;
  if p_entry is not null then
    select * into v_entry from public.hr_attendance_entries where id = p_entry;
    if not found or v_entry.user_id <> p_actor or v_entry.work_date <> p_request_date then
      raise exception 'hr_ot_entry_mismatch' using errcode = '22023';
    end if;
  else
    select * into v_entry from public.hr_attendance_entries where user_id = p_actor and work_date = p_request_date
      and clock_out_at is not null order by clock_in_at desc limit 1;
  end if;
  v_day := public.hr_att_day_type(v_emp.organization_id, p_actor, p_request_date);
  select coalesce((p.overtime_policy_json->>'maxDailyMinutes')::integer, null), coalesce((p.overtime_policy_json->>'enabled')::boolean, false)
    into v_cap, v_enabled from public.hr_attendance_policies p where p.organization_id = v_emp.organization_id;
  if v_cap is not null and p_minutes > v_cap then v_exceeds_cap := true; end if;
  if p_kind = 'post' then
    if v_entry.id is null then
      v_exceeds_rec := true;   -- no recorded attendance for that day
    else
      v_expected := case when v_day <> 'normal' then 0
                         else coalesce((select s.expected_work_minutes from public.hr_shifts s where s.id = v_entry.shift_id), 480) end;
      if coalesce(v_entry.worked_minutes, 0) - v_expected < p_minutes then v_exceeds_rec := true; end if;
    end if;
  end if;
  if p_planned_start is not null then v_ps := public.hr_att_local_ts(v_emp.organization_id, p_request_date, p_planned_start); end if;
  if p_planned_end is not null then
    v_pe := public.hr_att_local_ts(v_emp.organization_id, p_request_date, p_planned_end);
    if v_ps is not null and v_pe <= v_ps then v_pe := v_pe + interval '1 day'; end if;
  end if;
  insert into public.hr_overtime_requests(organization_id, employee_id, attendance_entry_id, request_date, ot_minutes, reason, status,
                                          day_type, request_kind, planned_start_at, planned_end_at, submitted_at,
                                          exceeds_policy_cap, exceeds_recorded_time, idempotency_key)
  values (v_emp.organization_id, p_actor, v_entry.id, p_request_date, p_minutes, left(btrim(p_reason), 1000), 'submitted',
          v_day, p_kind, v_ps, v_pe, now(), v_exceeds_cap, v_exceeds_rec, nullif(left(p_idempotency_key, 100), ''))
  returning id into v_id;
  perform public.hr_ot_event(v_emp.organization_id, v_id, 'submitted', null, 'submitted', p_actor, 'self', null);
  return jsonb_build_object('status', 'submitted', 'request_id', v_id, 'day_type', v_day, 'exceeds_policy_cap', v_exceeds_cap,
                            'exceeds_recorded_time', v_exceeds_rec, 'policy_enabled', coalesce(v_enabled, false));
end $fn$;

create or replace function public.hr_overtime_decide(p_actor uuid, p_request uuid, p_decision text, p_comment text,
                                                     p_approved_minutes integer default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare r record; v_auth text; v_minutes integer;
begin
  perform public.hr_att_assert_actor(p_actor);
  if p_decision not in ('approved', 'rejected') then raise exception 'hr_attendance_action_invalid' using errcode = '22023'; end if;
  select * into r from public.hr_overtime_requests where id = p_request for update;
  if not found then raise exception 'hr_ot_not_found' using errcode = '22023'; end if;
  if p_actor = r.employee_id then raise exception 'hr_ot_self_approval' using errcode = '42501'; end if;
  if r.status <> 'submitted' then raise exception 'hr_attendance_already_decided' using errcode = '22023'; end if;
  v_auth := public.hr_att_decider(p_actor, r.organization_id, r.employee_id, 'hr.mss.overtime_approve');
  if v_auth is null then raise exception 'hr_attendance_not_authorized' using errcode = '42501'; end if;
  if p_decision = 'rejected' and (p_comment is null or length(btrim(p_comment)) < 3) then
    raise exception 'hr_comment_required' using errcode = '22023';
  end if;
  v_minutes := case when p_decision = 'approved' then coalesce(p_approved_minutes, r.ot_minutes) end;
  if v_minutes is not null and (v_minutes < 1 or v_minutes > r.ot_minutes) then raise exception 'hr_ot_minutes_invalid' using errcode = '22023'; end if;
  update public.hr_overtime_requests
     set status = p_decision, approver_id = p_actor, approved_at = now(), approver_comment = nullif(btrim(coalesce(p_comment, '')), ''),
         decided_authority = v_auth, approved_minutes = v_minutes,
         day_type = public.hr_att_day_type(r.organization_id, r.employee_id, r.request_date), updated_at = now()
   where id = r.id;
  perform public.hr_ot_event(r.organization_id, r.id, p_decision, 'submitted', p_decision, p_actor, v_auth, p_comment);
  return jsonb_build_object('status', p_decision, 'authority', v_auth, 'approved_minutes', v_minutes);
end $fn$;

create or replace function public.hr_overtime_cancel(p_actor uuid, p_request uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare r record; v_auth text;
begin
  perform public.hr_att_assert_actor(p_actor);
  select * into r from public.hr_overtime_requests where id = p_request for update;
  if not found then raise exception 'hr_ot_not_found' using errcode = '22023'; end if;
  if r.status in ('draft', 'submitted') and p_actor = r.employee_id then
    v_auth := 'self';
  elsif r.status = 'approved' then
    if p_actor = r.employee_id then raise exception 'hr_ot_cancel_approved_by_hr' using errcode = '42501'; end if;
    if r.payroll_consumed_ref is not null then raise exception 'hr_ot_consumed' using errcode = '22023'; end if;
    v_auth := case when public.hr_att_hr_authority(p_actor, r.organization_id) then 'hr' end;
    if v_auth is null then raise exception 'hr_ot_cancel_approved_by_hr' using errcode = '42501'; end if;
    if p_reason is null or length(btrim(p_reason)) < 5 then raise exception 'hr_reason_required' using errcode = '22023'; end if;
  elsif r.status in ('draft', 'submitted') then
    raise exception 'hr_attendance_not_authorized' using errcode = '42501';
  else
    raise exception 'hr_attendance_already_decided' using errcode = '22023';
  end if;
  update public.hr_overtime_requests set status = 'cancelled', cancelled_at = now(), cancel_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         updated_at = now() where id = r.id;
  perform public.hr_ot_event(r.organization_id, r.id, 'cancelled', r.status, 'cancelled', p_actor, v_auth, p_reason);
  return jsonb_build_object('status', 'cancelled');
end $fn$;

-- Requests the actor may see: own (p_scope 'mine'), or decidable ones (p_scope 'queue': HR → organization,
-- manager with hr.mss.overtime_approve → direct reports).
create or replace function public.hr_overtime_list(p_actor uuid, p_scope text, p_status text default null, p_org uuid default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_org uuid; v_hr boolean;
begin
  perform public.hr_att_assert_actor(p_actor);
  if p_scope = 'mine' then
    return coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('approver_name', a.full_name,
             'history', (select coalesce(jsonb_agg(jsonb_build_object('action', ev.action, 'at', ev.created_at, 'comment', ev.comment,
                                                                       'authority', ev.authority) order by ev.created_at), '[]'::jsonb)
                         from public.hr_overtime_request_events ev where ev.request_ref = r.id)) order by r.request_date desc, r.created_at desc)
      from (select * from public.hr_overtime_requests where employee_id = p_actor and (p_status is null or status = p_status)
            order by request_date desc limit 200) r left join public.users a on a.id = r.approver_id), '[]'::jsonb);
  end if;
  v_org := coalesce(p_org, (select organization_id from public.users where id = p_actor));
  v_hr := public.hr_att_hr_authority(p_actor, v_org);
  return coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('employee_name', u.full_name, 'employee_no', e.employee_no,
             'approver_name', a.full_name, 'can_decide', r.status = 'submitted' and r.employee_id <> p_actor,
             'entry', (select jsonb_build_object('clock_in_at', ae.clock_in_at, 'clock_out_at', ae.clock_out_at, 'worked_minutes', ae.worked_minutes)
                       from public.hr_attendance_entries ae where ae.id = r.attendance_entry_id))
           order by r.request_date desc, r.created_at desc)
    from public.hr_overtime_requests r
    join public.users u on u.id = r.employee_id
    left join public.hr_employees e on e.user_id = r.employee_id and e.organization_id = r.organization_id
    left join public.users a on a.id = r.approver_id
    where r.employee_id <> p_actor and (p_status is null or r.status = p_status)
      and ((v_hr and r.organization_id = v_org)
           or public.hr_att_manager_authority(p_actor, r.organization_id, r.employee_id, 'hr.mss.overtime_approve'))
    ), '[]'::jsonb);
end $fn$;

-- ---------------------------------------------------------------------------
-- 12. Read models for the screens
-- ---------------------------------------------------------------------------
create or replace function public.hr_attendance_my_overview(p_actor uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_emp record; v_from date; v_to date;
begin
  perform public.hr_att_assert_actor(p_actor);
  select * into v_emp from public.hr_att_employment(p_actor);
  if v_emp.employment_id is null then raise exception 'hr_onboarding_pending' using errcode = 'P0001'; end if;
  v_to := coalesce(p_to, public.hr_att_local_date(v_emp.organization_id, now()));
  v_from := coalesce(p_from, v_to - 30);
  if v_to - v_from > 93 then raise exception 'hr_attendance_range_invalid' using errcode = '22023'; end if;
  return jsonb_build_object(
    'timezone', public.hr_att_tz(v_emp.organization_id),
    'today', public.hr_att_local_date(v_emp.organization_id, now()),
    'open_entry', (select to_jsonb(e) from public.hr_attendance_entries e where e.user_id = p_actor and e.clock_out_at is null
                   order by e.clock_in_at desc limit 1),
    'entries', coalesce((select jsonb_agg(to_jsonb(e) || jsonb_build_object(
         'exceptions', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'code', x.exception_code, 'status', x.status,
                                                                     'resolution', x.resolution)), '[]'::jsonb)
                        from public.hr_attendance_exceptions x where x.entry_ref = e.id),
         'pending_correction', exists (select 1 from public.hr_attendance_corrections c where c.entry_id = e.id and c.status = 'pending'))
       order by e.clock_in_at desc)
       from public.hr_attendance_entries e where e.user_id = p_actor and e.work_date between v_from and v_to), '[]'::jsonb),
    'day_exceptions', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'code', x.exception_code, 'work_date', x.work_date,
                                                                    'status', x.status, 'resolution', x.resolution) order by x.work_date desc)
       from public.hr_attendance_exceptions x where x.employee_ref = p_actor and x.entry_ref is null
        and x.work_date between v_from and v_to), '[]'::jsonb),
    'corrections', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'status', c.status, 'work_date', c.work_date,
                                     'entry_id', c.entry_id, 'reason', c.reason, 'corrected_clock_in', c.corrected_clock_in,
                                     'corrected_clock_out', c.corrected_clock_out, 'review_comment', c.review_comment,
                                     'created_at', c.created_at) order by c.created_at desc)
       from public.hr_attendance_corrections c where c.employee_ref = p_actor and c.created_at > now() - interval '120 days'), '[]'::jsonb),
    'shifts', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'start_time', s.start_time, 'end_time', s.end_time)
                                         order by s.start_time)
       from public.hr_shifts s where s.organization_id = any(public.sa_org_ancestry(v_emp.organization_id)) and s.is_active), '[]'::jsonb));
end $fn$;

-- HR / manager daily board for one date: every visible employee with their entries and exceptions.
create or replace function public.hr_attendance_day_board(p_actor uuid, p_org uuid, p_date date)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_hr boolean;
begin
  perform public.hr_att_assert_actor(p_actor);
  v_hr := public.hr_att_hr_authority(p_actor, p_org);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'employee_id', e.user_id, 'employee_no', e.employee_no, 'name', u.full_name, 'day_type', public.hr_att_day_type(p_org, e.user_id, p_date),
      'on_leave', public.hr_att_on_leave(e.user_id, p_date),
      'entries', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'clock_in_at', a.clock_in_at, 'clock_out_at', a.clock_out_at,
                         'worked_minutes', a.worked_minutes, 'source', a.source, 'attendance_flag', a.attendance_flag,
                         'review_state', a.review_state) order by a.clock_in_at), '[]'::jsonb)
                  from public.hr_attendance_entries a where a.user_id = e.user_id and a.work_date = p_date),
      'open_exceptions', (select count(*) from public.hr_attendance_exceptions x where x.employee_ref = e.user_id and x.work_date = p_date and x.status = 'open'))
      order by u.full_name)
    from public.hr_employees e join public.users u on u.id = e.user_id and u.organization_id = e.organization_id
    where e.organization_id = p_org and e.onboarding_status = 'completed' and e.status in ('active', 'probation')
      and (v_hr or public.hr_att_manager_authority(p_actor, p_org, e.user_id, 'hr.mss.attendance_view')
              or public.hr_att_manager_authority(p_actor, p_org, e.user_id, 'hr.mss.attendance_approve'))), '[]'::jsonb);
end $fn$;

create or replace function public.hr_attendance_review_queue(p_actor uuid, p_org uuid, p_kind text, p_status text, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_hr boolean;
begin
  perform public.hr_att_assert_actor(p_actor);
  v_hr := public.hr_att_hr_authority(p_actor, p_org);
  if p_kind = 'exceptions' then
    return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'employee_id', x.employee_ref, 'name', u.full_name,
             'employee_no', e.employee_no, 'work_date', x.work_date, 'code', x.exception_code, 'details', x.details, 'status', x.status,
             'resolution', x.resolution, 'resolution_note', x.resolution_note, 'resolved_by', rb.full_name, 'resolved_at', x.resolved_at,
             'entry', (select jsonb_build_object('clock_in_at', a.clock_in_at, 'clock_out_at', a.clock_out_at, 'source', a.source,
                                                 'worked_minutes', a.worked_minutes) from public.hr_attendance_entries a where a.id = x.entry_ref),
             'can_resolve', x.status = 'open' and x.employee_ref <> p_actor and x.maker_ref is distinct from p_actor
                            and (v_hr or (x.exception_code <> 'manual_entry'
                                          and public.hr_att_manager_authority(p_actor, p_org, x.employee_ref, 'hr.mss.attendance_approve'))))
           order by x.work_date desc, u.full_name)
      from public.hr_attendance_exceptions x
      join public.users u on u.id = x.employee_ref
      left join public.hr_employees e on e.user_id = x.employee_ref and e.organization_id = x.organization_id
      left join public.users rb on rb.id = x.resolved_by_ref
      where x.organization_id = p_org and (p_status is null or x.status = p_status)
        and x.work_date between coalesce(p_from, date '2000-01-01') and coalesce(p_to, date '2999-12-31')
        and x.employee_ref <> p_actor
        and (v_hr or public.hr_att_manager_authority(p_actor, p_org, x.employee_ref, 'hr.mss.attendance_view')
                  or public.hr_att_manager_authority(p_actor, p_org, x.employee_ref, 'hr.mss.attendance_approve'))
      limit 500), '[]'::jsonb);
  elsif p_kind = 'corrections' then
    return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'employee_id', c.employee_ref, 'name', u.full_name,
             'employee_no', e.employee_no, 'work_date', c.work_date, 'kind', c.kind, 'status', c.status, 'reason', c.reason,
             'requested_by', rq.full_name, 'requested_by_id', c.requested_by, 'created_at', c.created_at,
             'original_clock_in', c.original_clock_in, 'original_clock_out', c.original_clock_out,
             'corrected_clock_in', c.corrected_clock_in, 'corrected_clock_out', c.corrected_clock_out,
             'corrected_break_minutes', c.corrected_break_minutes, 'review_comment', c.review_comment, 'reviewed_by', rv.full_name,
             'can_decide', c.status = 'pending' and c.requested_by <> p_actor and c.employee_ref <> p_actor
                           and (v_hr or public.hr_att_manager_authority(p_actor, p_org, c.employee_ref, 'hr.mss.attendance_approve')))
           order by c.created_at desc)
      from public.hr_attendance_corrections c
      join public.users u on u.id = c.employee_ref
      left join public.hr_employees e on e.user_id = c.employee_ref and e.organization_id = c.organization_id
      left join public.users rq on rq.id = c.requested_by
      left join public.users rv on rv.id = c.reviewed_by
      where c.organization_id = p_org and (p_status is null or c.status = p_status) and c.employee_ref <> p_actor
        and (v_hr or public.hr_att_manager_authority(p_actor, p_org, c.employee_ref, 'hr.mss.attendance_approve'))
      limit 500), '[]'::jsonb);
  end if;
  raise exception 'hr_attendance_action_invalid' using errcode = '22023';
end $fn$;

-- Period summary per employee (HR reporting). Minutes only; no pay values.
create or replace function public.hr_attendance_period_report(p_actor uuid, p_org uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
begin
  perform public.hr_att_assert_actor(p_actor);
  if not public.hr_att_hr_authority(p_actor, p_org) then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.attendance.manage';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 93 then
    raise exception 'hr_attendance_range_invalid' using errcode = '22023';
  end if;
  return jsonb_build_object('from', p_from, 'to', p_to, 'rows', coalesce((select jsonb_agg(jsonb_build_object(
      'employee_id', e.user_id, 'employee_no', e.employee_no, 'name', u.full_name,
      'days_present', (select count(distinct a.work_date) from public.hr_attendance_entries a where a.user_id = e.user_id and a.work_date between p_from and p_to),
      'worked_minutes', (select coalesce(sum(a.worked_minutes), 0) from public.hr_attendance_entries a where a.user_id = e.user_id and a.work_date between p_from and p_to),
      'late', (select count(*) from public.hr_attendance_exceptions x where x.employee_ref = e.user_id and x.work_date between p_from and p_to and x.exception_code = 'late_arrival' and x.status <> 'cleared'),
      'early', (select count(*) from public.hr_attendance_exceptions x where x.employee_ref = e.user_id and x.work_date between p_from and p_to and x.exception_code = 'early_departure' and x.status <> 'cleared'),
      'absent', (select count(*) from public.hr_attendance_exceptions x where x.employee_ref = e.user_id and x.work_date between p_from and p_to and x.exception_code = 'absent_no_record' and x.status <> 'cleared'),
      'open_exceptions', (select count(*) from public.hr_attendance_exceptions x where x.employee_ref = e.user_id and x.work_date between p_from and p_to and x.status = 'open'),
      'manual_or_imported', (select count(*) from public.hr_attendance_entries a where a.user_id = e.user_id and a.work_date between p_from and p_to and a.source in ('hr_manual', 'import', 'correction')),
      'ot_approved_minutes', (select coalesce(sum(coalesce(o.approved_minutes, o.ot_minutes)), 0) from public.hr_overtime_requests o where o.employee_id = e.user_id and o.request_date between p_from and p_to and o.status = 'approved'),
      'ot_pending', (select count(*) from public.hr_overtime_requests o where o.employee_id = e.user_id and o.request_date between p_from and p_to and o.status = 'submitted'))
      order by u.full_name)
    from public.hr_employees e join public.users u on u.id = e.user_id and u.organization_id = e.organization_id
    where e.organization_id = p_org and e.onboarding_status = 'completed'), '[]'::jsonb));
end $fn$;

-- ---------------------------------------------------------------------------
-- 13. Privileges: internal helpers for nobody; entry points for service_role (server routes pass the session actor)
-- ---------------------------------------------------------------------------
do $g$
declare f text;
begin
  foreach f in array array[
    'hr_att_tz(uuid)', 'hr_att_local_date(uuid,timestamptz)', 'hr_att_local_ts(uuid,date,time)', 'hr_att_assert_actor(uuid)',
    'hr_att_employment(uuid)', 'hr_att_hr_authority(uuid,uuid)', 'hr_att_manager_authority(uuid,uuid,uuid,text)',
    'hr_att_decider(uuid,uuid,uuid,text)', 'hr_att_can_view(uuid,uuid,uuid)', 'hr_att_audit(uuid,uuid,text,uuid,text,jsonb)',
    'hr_att_day_type(uuid,uuid,date)', 'hr_att_on_leave(uuid,date)', 'hr_att_minutes(timestamptz,timestamptz,integer)',
    'hr_att_flag(uuid,uuid,date,timestamptz,timestamptz)', 'hr_att_overlaps(uuid,timestamptz,timestamptz,uuid)',
    'hr_att_refresh_timesheet(uuid,uuid,date)', 'hr_att_detect_day(uuid,uuid,date)', 'hr_att_import_validate_row(uuid,jsonb)',
    'hr_ot_event(uuid,uuid,text,text,text,uuid,text,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'hr_attendance_run_detection(uuid,uuid,date,date)', 'hr_attendance_clock(uuid,text,uuid,text,timestamptz,text)',
    'hr_attendance_manual_entry(uuid,uuid,date,time,time,integer,uuid,text)',
    'hr_attendance_request_correction(uuid,uuid,date,time,time,integer,text,uuid)', 'hr_attendance_cancel_correction(uuid,uuid)',
    'hr_attendance_decide_correction(uuid,uuid,text,text)', 'hr_attendance_resolve_exception(uuid,uuid,text,text)',
    'hr_attendance_import_preview(uuid,uuid,text,text,jsonb)', 'hr_attendance_import_batch_get(uuid,uuid)',
    'hr_attendance_import_commit(uuid,uuid,integer)', 'hr_attendance_import_cancel(uuid,uuid)',
    'hr_attendance_import_batches_list(uuid,uuid)',
    'hr_overtime_submit(uuid,date,integer,text,text,uuid,time,time,text)', 'hr_overtime_decide(uuid,uuid,text,text,integer)',
    'hr_overtime_cancel(uuid,uuid,text)', 'hr_overtime_list(uuid,text,text,uuid)', 'hr_attendance_my_overview(uuid,date,date)',
    'hr_attendance_day_board(uuid,uuid,date)', 'hr_attendance_review_queue(uuid,uuid,text,text,date,date)',
    'hr_attendance_period_report(uuid,uuid,date,date)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $g$;
