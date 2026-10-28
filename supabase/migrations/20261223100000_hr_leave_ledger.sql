-- ============================================================================
-- 20261223100000_hr_leave_ledger.sql
-- Serapod2U HR Core — Wave 3 (B6): Leave balance ledger, working-day calculation, entitlement administration.
--
-- STATUS: migration file prepared. NOT applied to staging or production. Requires B2A (20261219100000), Wave 2
-- (20261221100000) and Wave 3 attendance (20261222100000: work calendar helpers). Replica suite:
-- supabase/tests/security/hr_attendance_overtime/ (leave part).
--
-- What this migration does (additive; B2A leave security is unchanged and still decides every leave transition):
--   1. hr_leave_ledger — append-only balance ledger (days only): entitlement, carry_forward, adjustment (HR, reason),
--      taken (posted when a request is APPROVED), taken_reversal (approved leave cancelled by HR). Idempotent through a
--      unique source key. hr_leave_balances becomes a PROJECTION of the ledger (+ pending requests), kept in step by
--      the database; nothing in the application writes it.
--   2. Opening balance: every existing hr_leave_balances row becomes opening ledger entries (entitled, carried forward,
--      adjustment), every APPROVED request is posted as taken, and any difference between the stored "taken" and the
--      approved requests is kept as an explicit opening reconciliation adjustment — so every employee's AVAILABLE
--      balance is unchanged by the migration. The migration REFUSES to run if hr_leave_balances holds two rows for the
--      same employee, leave type and year (clean them first).
--   3. Working days (server-side, for every submission and content edit by an employee): policy workdays, national
--      and work-state public holidays (Wave 3 calendar), half day = 0.5 on a single working day. total_days is set by
--      the database. Zero working days, an overlapping own submitted/approved request, an inactive/foreign leave type and — only where an
--      entitlement exists for that type and year — an insufficient balance are refused (also re-checked at approval).
--   4. HR administration (explicit hr.leave.approve until hr.leave.manage exists — PD-SA-01; never on one's own
--      record): set an entitlement, adjust a balance (reason), entitlement run per leave type and year from the leave
--      type's OWN configured tiers and pro-rata settings (preview first), carry-forward run using the leave type's OWN
--      configured cap (preview first; expiry is NOT automated — PD-LV-02).
--   5. Read models: quote, my balances (+ledger), organization balance overview, ledger per employee, unpaid leave
--      days per period (payroll readiness; no pay calculation).
--
-- Not decided here (owner): statutory minimum entitlements (PD-LV-01), carry-forward expiry/forfeiture (PD-LV-02),
-- multi-step approval/escalation (PD-LV-03), encashment (PD-LV-04). No S&A change. No payroll effect.
--
-- ROLLBACK (safe; keeps the ledger as evidence):
--   drop trigger if exists hr_w3_leave_requests_quote on public.hr_leave_requests;
--   drop trigger if exists hr_leave_requests_w3_ledger on public.hr_leave_requests;
--   (hr_leave_balances keeps its last projected values; submissions return to client-calculated days.)
--   Functions may stay. hr_leave_ledger is retained; drop only with a recorded owner decision.
-- ============================================================================

do $pre$
begin
  if to_regprocedure('public.hr_leave_requests_guard()') is null or to_regclass('public.hr_leave_request_events') is null then
    raise exception 'hr_w3_prerequisite_missing: B2A (20261219100000_hr_leave_containment_guard) must be applied first';
  end if;
  if to_regprocedure('public.hr_actor_has_explicit(uuid,text,jsonb)') is null then
    raise exception 'hr_w3_prerequisite_missing: Wave 2 (20261221100000_hr_employment_foundation) must be applied first';
  end if;
  if to_regprocedure('public.hr_att_day_type(uuid,uuid,date)') is null then
    raise exception 'hr_w3_prerequisite_missing: 20261222100000_hr_hybrid_attendance_overtime must be applied first';
  end if;
  if exists (select 1 from public.hr_leave_balances group by employee_id, leave_type_id, year having count(*) > 1) then
    raise exception 'hr_leave_balance_duplicates: hr_leave_balances holds more than one row for the same employee, leave type and year — reconcile them before applying this migration';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Ledger
-- ---------------------------------------------------------------------------
create table if not exists public.hr_leave_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  employee_ref uuid not null,
  leave_type_ref uuid not null,
  leave_year integer not null check (leave_year between 2000 and 2100),
  entry_type text not null check (entry_type in ('entitlement', 'carry_forward', 'adjustment', 'taken', 'taken_reversal')),
  days numeric(7,2) not null check (days <> 0 or entry_type = 'entitlement'),
  request_ref uuid,
  reason text,
  actor_ref uuid,
  source_key text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists hr_leave_ledger_key_idx on public.hr_leave_ledger (employee_ref, leave_type_ref, leave_year);
create index if not exists hr_leave_ledger_org_idx on public.hr_leave_ledger (organization_id, leave_year);
alter table public.hr_leave_ledger enable row level security;
alter table public.hr_leave_ledger force row level security;
revoke all on table public.hr_leave_ledger from public, anon, authenticated, service_role;
drop trigger if exists hr_leave_ledger_append_only on public.hr_leave_ledger;
create trigger hr_leave_ledger_append_only before update or delete on public.hr_leave_ledger
  for each row execute function public.hr_w3_append_only();
insert into public.hr_reset_scope(table_name, category, action, delete_order, label)
select 'hr_leave_ledger', 'leave', 'delete', 23, 'Leave balance ledger'
where not exists (select 1 from public.hr_reset_scope where table_name = 'hr_leave_ledger');

-- Unique projection key from now on (the precheck proved there are no duplicates).
create unique index if not exists hr_leave_balances_key_uniq on public.hr_leave_balances (employee_id, leave_type_id, year);

-- ---------------------------------------------------------------------------
-- 2. Working days and per-year split
-- ---------------------------------------------------------------------------
-- Working dates of a leave span for an employee: policy workday, not a public holiday. Half day → 0.5 on one date.
create or replace function public.hr_leave_working_dates(p_org uuid, p_employee uuid, p_start date, p_end date)
returns table (d date, day_type text) language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select g::date, public.hr_att_day_type(p_org, p_employee, g::date)
  from generate_series(p_start, p_end, interval '1 day') g
  where p_start is not null and p_end is not null and p_end >= p_start and p_end - p_start <= 366
$fn$;

create or replace function public.hr_leave_year_split(p_org uuid, p_employee uuid, p_start date, p_end date, p_half boolean)
returns table (leave_year integer, days numeric) language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select extract(year from w.d)::integer, sum(case when p_half then 0.5 else 1 end)::numeric
  from public.hr_leave_working_dates(p_org, p_employee, p_start, p_end) w
  where w.day_type = 'normal'
  group by 1
$fn$;

-- The days a stored request counts per year (single-year requests: its stored total; cross-year: working-day split).
create or replace function public.hr_leave_request_years(p_req public.hr_leave_requests)
returns table (leave_year integer, days numeric) language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
begin
  if extract(year from p_req.start_date) = extract(year from p_req.end_date) then
    return query select extract(year from p_req.start_date)::integer, p_req.total_days::numeric;
  else
    return query select s.leave_year, s.days from public.hr_leave_year_split(p_req.organization_id, p_req.employee_id,
                                                  p_req.start_date, p_req.end_date, p_req.is_half_day) s;
  end if;
end $fn$;

-- ---------------------------------------------------------------------------
-- 3. Projection
-- ---------------------------------------------------------------------------
create or replace function public.hr_leave_balance_of(p_employee uuid, p_type uuid, p_year integer, p_exclude_request uuid default null)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  with l as (
    select coalesce(sum(days) filter (where entry_type = 'entitlement'), 0) as entitled,
           coalesce(sum(days) filter (where entry_type = 'carry_forward'), 0) as carried_forward,
           coalesce(sum(days) filter (where entry_type = 'adjustment'), 0) as adjustment,
           coalesce(-sum(days) filter (where entry_type in ('taken', 'taken_reversal')), 0) as taken,
           count(*) filter (where entry_type in ('entitlement', 'carry_forward', 'adjustment')) as setup_entries
    from public.hr_leave_ledger where employee_ref = p_employee and leave_type_ref = p_type and leave_year = p_year),
  p as (
    select coalesce(sum(y.days), 0) as pending
    from public.hr_leave_requests r cross join lateral public.hr_leave_request_years(r) y
    where r.employee_id = p_employee and r.leave_type_id = p_type and r.status = 'pending' and y.leave_year = p_year
      and r.id is distinct from p_exclude_request)
  select jsonb_build_object('year', p_year, 'entitled', l.entitled, 'carried_forward', l.carried_forward, 'adjustment', l.adjustment,
                            'taken', l.taken, 'pending', p.pending,
                            'available', l.entitled + l.carried_forward + l.adjustment - l.taken - p.pending,
                            'has_entitlement', l.setup_entries > 0)
  from l, p
$fn$;

create or replace function public.hr_leave_sync_balance(p_org uuid, p_employee uuid, p_type uuid, p_year integer)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare b jsonb := public.hr_leave_balance_of(p_employee, p_type, p_year);
begin
  insert into public.hr_leave_balances(organization_id, employee_id, leave_type_id, year, entitled, taken, pending, carried_forward, adjustment)
  values (p_org, p_employee, p_type, p_year, (b->>'entitled')::numeric, (b->>'taken')::numeric, (b->>'pending')::numeric,
          (b->>'carried_forward')::numeric, (b->>'adjustment')::numeric)
  on conflict (employee_id, leave_type_id, year) do update
     set entitled = excluded.entitled, taken = excluded.taken, pending = excluded.pending,
         carried_forward = excluded.carried_forward, adjustment = excluded.adjustment, updated_at = now()
   where (hr_leave_balances.entitled, hr_leave_balances.taken, hr_leave_balances.pending, hr_leave_balances.carried_forward,
          hr_leave_balances.adjustment) is distinct from
         (excluded.entitled, excluded.taken, excluded.pending, excluded.carried_forward, excluded.adjustment);
end $fn$;

create or replace function public.hr_leave_post(p_org uuid, p_employee uuid, p_type uuid, p_year integer, p_entry text, p_days numeric,
                                                p_request uuid, p_reason text, p_actor uuid, p_key text)
returns boolean language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare n integer;
begin
  if p_days is null or p_days = 0 then return false; end if;
  insert into public.hr_leave_ledger(organization_id, employee_ref, leave_type_ref, leave_year, entry_type, days, request_ref, reason, actor_ref, source_key)
  values (p_org, p_employee, p_type, p_year, p_entry, round(p_days, 2), p_request, nullif(left(btrim(coalesce(p_reason, '')), 500), ''), p_actor, p_key)
  on conflict (source_key) do nothing;
  get diagnostics n = row_count;
  return n > 0;
end $fn$;

-- ---------------------------------------------------------------------------
-- 4. Request triggers (run AFTER the B2A guard; B2A still decides who may do what)
-- ---------------------------------------------------------------------------
-- Definer check, called only by the invoker trigger below for API statements. Callable by API roles, but it refuses
-- anything that is not the caller's own request (or one the caller may decide under B2A), so it cannot probe balances.
create or replace function public.hr_leave_w3_check(p_op text, p_new public.hr_leave_requests, p_old public.hr_leave_requests)
returns numeric language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_type record; v_days numeric; y record; b jsonb; v_recalc boolean; new public.hr_leave_requests := p_new; old public.hr_leave_requests := p_old;
begin
  if auth.uid() is null or (new.employee_id <> auth.uid() and not public.hr_leave_can_decide(new.organization_id, new.employee_id)) then
    return new.total_days;   -- the B2A guard has already refused such a statement; never reveal anything here
  end if;
  v_recalc := p_op = 'INSERT' or (p_op = 'UPDATE' and old.status = 'draft' and new.status = 'pending')
              or (new.status in ('draft', 'pending') and (new.start_date, new.end_date, new.leave_type_id, new.is_half_day,
              coalesce(new.half_day_period, '')) is distinct from (old.start_date, old.end_date, old.leave_type_id, old.is_half_day,
              coalesce(old.half_day_period, '')));
  if v_recalc then
    select * into v_type from public.hr_leave_types t where t.id = new.leave_type_id;
    if not found or v_type.status <> 'active' or not (v_type.organization_id = any(public.sa_org_ancestry(new.organization_id))) then
      raise exception 'hr_leave_type_invalid' using errcode = '22023';
    end if;
    if new.end_date - new.start_date > 366 then raise exception 'hr_leave_span_too_long' using errcode = '22023'; end if;
    if new.is_half_day and new.start_date <> new.end_date then raise exception 'hr_leave_half_day_single_date' using errcode = '22023'; end if;
    select coalesce(sum(s.days), 0) into v_days from public.hr_leave_year_split(new.organization_id, new.employee_id, new.start_date,
                                                                               new.end_date, new.is_half_day) s;
    if v_days <= 0 then raise exception 'hr_leave_no_working_days' using errcode = '22023'; end if;
    -- duplicate protection against submitted/approved leave (a draft is not a claim until it is submitted)
    if new.status <> 'draft' and exists (select 1 from public.hr_leave_requests r
               where r.employee_id = new.employee_id and r.id <> new.id and r.status in ('pending', 'approved')
                 and r.start_date <= new.end_date and new.start_date <= r.end_date
                 and not (r.is_half_day and new.is_half_day and r.start_date = new.start_date
                          and coalesce(r.half_day_period, '') <> coalesce(new.half_day_period, ''))) then
      raise exception 'hr_leave_overlap' using errcode = '23P01';
    end if;
    if new.status in ('draft', 'pending') then
      for y in select * from public.hr_leave_year_split(new.organization_id, new.employee_id, new.start_date, new.end_date, new.is_half_day) loop
        b := public.hr_leave_balance_of(new.employee_id, new.leave_type_id, y.leave_year, new.id);
        if (b->>'has_entitlement')::boolean and (b->>'available')::numeric < y.days then
          raise exception 'hr_leave_insufficient_balance' using errcode = '22023',
            detail = format('%s day(s) requested in %s, %s available', y.days, y.leave_year, b->>'available');
        end if;
      end loop;
    end if;
    return v_days;
  elsif p_op = 'UPDATE' and old.status = 'pending' and new.status = 'approved' then
    for y in select * from public.hr_leave_request_years(new) loop
      b := public.hr_leave_balance_of(new.employee_id, new.leave_type_id, y.leave_year, new.id);
      if (b->>'has_entitlement')::boolean
         and (b->>'entitled')::numeric + (b->>'carried_forward')::numeric + (b->>'adjustment')::numeric - (b->>'taken')::numeric < y.days then
        raise exception 'hr_leave_insufficient_balance' using errcode = '22023',
          detail = format('Approving would exceed the %s balance (%s day(s)).', y.leave_year, y.days);
      end if;
    end loop;
  end if;
  return new.total_days;
end $fn$;
revoke all on function public.hr_leave_w3_check(text, public.hr_leave_requests, public.hr_leave_requests) from public, anon;
grant execute on function public.hr_leave_w3_check(text, public.hr_leave_requests, public.hr_leave_requests) to authenticated, service_role;

-- SECURITY INVOKER (like the B2A guard, E-05): current_user tells an API statement from database-owned maintenance
-- (HR reset/restore, identity lifecycle), which keeps historical values untouched.
create or replace function public.hr_leave_requests_w3_quote()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $fn$
begin
  if current_user not in ('authenticated', 'anon', 'service_role') then return new; end if;
  new.total_days := public.hr_leave_w3_check(tg_op, new, case when tg_op = 'UPDATE' then old end);
  return new;
end $fn$;
revoke all on function public.hr_leave_requests_w3_quote() from public, anon;

create or replace function public.hr_leave_requests_w3_ledger()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare y record; v_years integer[] := '{}'; v_y integer;
begin
  -- HR Data Management restore re-inserts captured rows; the ledger is restored with them
  if nullif(current_setting('hr.reset_restore', true), '') is not null then return null; end if;
  if tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'approved' then
    for y in select * from public.hr_leave_request_years(new) loop
      perform public.hr_leave_post(new.organization_id, new.employee_id, new.leave_type_id, y.leave_year, 'taken', -y.days, new.id,
                                   'Approved leave', new.approved_by, 'taken:' || new.id || ':' || y.leave_year);
    end loop;
  elsif tg_op = 'UPDATE' and old.status = 'approved' and new.status is distinct from 'approved' then
    for y in select l.leave_year, sum(l.days) as days from public.hr_leave_ledger l
             where l.request_ref = new.id and l.entry_type in ('taken', 'taken_reversal') group by 1 loop
      if y.days <> 0 then
        perform public.hr_leave_post(new.organization_id, new.employee_id, new.leave_type_id, y.leave_year, 'taken_reversal', -y.days,
                                     new.id, 'Approved leave ' || new.status, auth.uid(),
                                     'reversal:' || new.id || ':' || y.leave_year || ':' || coalesce(new.cancelled_at::text, now()::text));
      end if;
    end loop;
  end if;
  select array_agg(distinct leave_year) into v_years from (
    select leave_year from public.hr_leave_request_years(new)
    union select leave_year from public.hr_leave_request_years(old) where tg_op = 'UPDATE') x;
  foreach v_y in array coalesce(v_years, '{}') loop
    perform public.hr_leave_sync_balance(new.organization_id, new.employee_id, new.leave_type_id, v_y);
    if tg_op = 'UPDATE' and old.leave_type_id is distinct from new.leave_type_id then
      perform public.hr_leave_sync_balance(old.organization_id, old.employee_id, old.leave_type_id, v_y);
    end if;
  end loop;
  return null;
end $fn$;
revoke all on function public.hr_leave_requests_w3_ledger() from public, anon, authenticated, service_role;

drop trigger if exists hr_w3_leave_requests_quote on public.hr_leave_requests;
create trigger hr_w3_leave_requests_quote before insert or update on public.hr_leave_requests
  for each row execute function public.hr_leave_requests_w3_quote();
drop trigger if exists hr_leave_requests_w3_ledger on public.hr_leave_requests;
create trigger hr_leave_requests_w3_ledger after insert or update on public.hr_leave_requests
  for each row execute function public.hr_leave_requests_w3_ledger();

-- ---------------------------------------------------------------------------
-- 5. Opening balance (idempotent; available balance unchanged)
-- ---------------------------------------------------------------------------
do $open$
declare b record; r public.hr_leave_requests; y record; v_posted numeric;
begin
  -- once only: after the first run hr_leave_balances is the ledger's projection and must not be re-read as opening data
  if coalesce(obj_description('public.hr_leave_ledger'::regclass, 'pg_class'), '') like '%[opening balance posted]%' then
    return;
  end if;
  for b in select * from public.hr_leave_balances loop
    perform public.hr_leave_post(b.organization_id, b.employee_id, b.leave_type_id, b.year, 'entitlement', b.entitled, null,
                                 'Opening balance (migration 20261223100000)', null, 'opening:' || b.id || ':entitled');
    perform public.hr_leave_post(b.organization_id, b.employee_id, b.leave_type_id, b.year, 'carry_forward', b.carried_forward, null,
                                 'Opening balance (migration 20261223100000)', null, 'opening:' || b.id || ':carried_forward');
    perform public.hr_leave_post(b.organization_id, b.employee_id, b.leave_type_id, b.year, 'adjustment', b.adjustment, null,
                                 'Opening balance (migration 20261223100000)', null, 'opening:' || b.id || ':adjustment');
  end loop;
  for r in select * from public.hr_leave_requests where status = 'approved' loop
    for y in select * from public.hr_leave_request_years(r) loop
      perform public.hr_leave_post(r.organization_id, r.employee_id, r.leave_type_id, y.leave_year, 'taken', -y.days, r.id,
                                   'Approved leave (opening)', r.approved_by, 'taken:' || r.id || ':' || y.leave_year);
    end loop;
  end loop;
  -- reconcile: stored "taken" that is not explained by approved requests stays visible as an explicit adjustment
  for b in select * from public.hr_leave_balances loop
    select coalesce(-sum(days), 0) into v_posted from public.hr_leave_ledger
     where employee_ref = b.employee_id and leave_type_ref = b.leave_type_id and leave_year = b.year and entry_type in ('taken', 'taken_reversal');
    if not exists (select 1 from public.hr_leave_ledger where source_key = 'opening:' || b.id || ':reconcile') then
      perform public.hr_leave_post(b.organization_id, b.employee_id, b.leave_type_id, b.year, 'adjustment', v_posted - b.taken, null,
                                   'Opening reconciliation: stored taken days differ from approved requests', null,
                                   'opening:' || b.id || ':reconcile');
    end if;
  end loop;
  for b in select distinct organization_id, employee_ref, leave_type_ref, leave_year from public.hr_leave_ledger loop
    perform public.hr_leave_sync_balance(b.organization_id, b.employee_ref, b.leave_type_ref, b.leave_year);
  end loop;
  for b in select distinct q.organization_id, q.employee_id, q.leave_type_id, yy.leave_year as yr
           from public.hr_leave_requests q cross join lateral public.hr_leave_request_years(q) yy where q.status = 'pending' loop
    perform public.hr_leave_sync_balance(b.organization_id, b.employee_id, b.leave_type_id, b.yr);
  end loop;
  execute format('comment on table public.hr_leave_ledger is %L',
    'Append-only leave balance ledger (days). hr_leave_balances is its projection. [opening balance posted] ' || now()::text);
end $open$;

-- ---------------------------------------------------------------------------
-- 6. Authority (explicit HR leave authority of the employee's company; never one's own record)
-- ---------------------------------------------------------------------------
create or replace function public.hr_leave_assert_hr(p_actor uuid, p_org uuid)
returns void language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
begin
  perform public.hr_att_assert_actor(p_actor);
  if not public.hr_actor_has_explicit(p_actor, 'hr.leave.approve', jsonb_build_object('organization_id', p_org)) then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.leave.approve';
  end if;
end $fn$;

create or replace function public.hr_leave_target(p_actor uuid, p_employee uuid, p_type uuid)
returns table (organization_id uuid, hire_date date) language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_emp record;
begin
  select * into v_emp from public.hr_att_employment(p_employee);
  if v_emp.employment_id is null then raise exception 'hr_employment_not_found' using errcode = '22023'; end if;
  perform public.hr_leave_assert_hr(p_actor, v_emp.organization_id);
  if p_actor = p_employee then raise exception 'hr_self_change_prohibited' using errcode = '42501'; end if;
  if not exists (select 1 from public.hr_leave_types t where t.id = p_type
                 and t.organization_id = any(public.sa_org_ancestry(v_emp.organization_id))) then
    raise exception 'hr_leave_type_invalid' using errcode = '22023';
  end if;
  return query select v_emp.organization_id, v_emp.hire_date;
end $fn$;

-- ---------------------------------------------------------------------------
-- 7. HR administration
-- ---------------------------------------------------------------------------
create or replace function public.hr_leave_set_entitlement(p_actor uuid, p_employee uuid, p_type uuid, p_year integer, p_days numeric, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare t record; b jsonb; v_delta numeric;
begin
  if p_reason is null or length(btrim(p_reason)) < 5 then raise exception 'hr_reason_required' using errcode = '22023'; end if;
  if p_days is null or p_days < 0 or p_days > 366 or p_year is null or p_year not between 2000 and 2100 then
    raise exception 'hr_leave_days_invalid' using errcode = '22023';
  end if;
  select * into t from public.hr_leave_target(p_actor, p_employee, p_type);
  perform pg_advisory_xact_lock(hashtextextended('hr_leave_bal:' || p_employee || ':' || p_type || ':' || p_year, 0));
  b := public.hr_leave_balance_of(p_employee, p_type, p_year);
  v_delta := p_days - (b->>'entitled')::numeric;
  if v_delta = 0 and (b->>'has_entitlement')::boolean then return jsonb_build_object('status', 'unchanged', 'balance', b); end if;
  if v_delta <> 0 then
    perform public.hr_leave_post(t.organization_id, p_employee, p_type, p_year, 'entitlement', v_delta, null, p_reason, p_actor,
                                 'entitlement:' || gen_random_uuid());
  else
    -- an explicit zero entitlement is still an entitlement (balance enforcement switches on)
    insert into public.hr_leave_ledger(organization_id, employee_ref, leave_type_ref, leave_year, entry_type, days, reason, actor_ref, source_key)
    values (t.organization_id, p_employee, p_type, p_year, 'entitlement', 0, left(btrim(p_reason), 500), p_actor, 'entitlement:' || gen_random_uuid());
  end if;
  perform public.hr_leave_sync_balance(t.organization_id, p_employee, p_type, p_year);
  return jsonb_build_object('status', 'set', 'delta', v_delta, 'balance', public.hr_leave_balance_of(p_employee, p_type, p_year));
end $fn$;

create or replace function public.hr_leave_adjust(p_actor uuid, p_employee uuid, p_type uuid, p_year integer, p_delta numeric, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare t record;
begin
  if p_reason is null or length(btrim(p_reason)) < 5 then raise exception 'hr_reason_required' using errcode = '22023'; end if;
  if p_delta is null or p_delta = 0 or abs(p_delta) > 366 or p_year is null or p_year not between 2000 and 2100
     or (p_delta * 2) <> trunc(p_delta * 2) then
    raise exception 'hr_leave_days_invalid' using errcode = '22023';
  end if;
  select * into t from public.hr_leave_target(p_actor, p_employee, p_type);
  perform pg_advisory_xact_lock(hashtextextended('hr_leave_bal:' || p_employee || ':' || p_type || ':' || p_year, 0));
  perform public.hr_leave_post(t.organization_id, p_employee, p_type, p_year, 'adjustment', p_delta, null, p_reason, p_actor,
                               'adjustment:' || gen_random_uuid());
  perform public.hr_leave_sync_balance(t.organization_id, p_employee, p_type, p_year);
  return jsonb_build_object('status', 'adjusted', 'balance', public.hr_leave_balance_of(p_employee, p_type, p_year));
end $fn$;

-- Entitlement from the leave type's own configuration: tiers by completed years of service at 1 January of the
-- year (entitlement_tiers [{minYearsOfService, maxYearsOfService|null, daysEntitled}]), pro-rata for a hire in that
-- year when pro_rata.enabled (remaining months incl. the hire month / 12; rounding per pro_rata.roundingRule, whole
-- days). Employees who already have an entitlement for that type and year are skipped. Preview first (p_dry_run).
create or replace function public.hr_leave_entitlement_run(p_actor uuid, p_org uuid, p_type uuid, p_year integer, p_dry_run boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare t record; e record; v_years integer; v_days numeric; v_tier jsonb; v_frac numeric; v_rows jsonb := '[]'::jsonb; v_n integer := 0;
        v_rule text; v_status text; v_jan1 date := make_date(p_year, 1, 1);
begin
  perform public.hr_leave_assert_hr(p_actor, p_org);
  if p_year is null or p_year not between 2000 and 2100 then raise exception 'hr_leave_days_invalid' using errcode = '22023'; end if;
  if not coalesce(p_dry_run, true) and (p_reason is null or length(btrim(p_reason)) < 5) then
    raise exception 'hr_reason_required' using errcode = '22023';
  end if;
  select * into t from public.hr_leave_types where id = p_type and organization_id = any(public.sa_org_ancestry(p_org)) and status = 'active';
  if not found then raise exception 'hr_leave_type_invalid' using errcode = '22023'; end if;
  if jsonb_typeof(t.entitlement_tiers) <> 'array' or jsonb_array_length(t.entitlement_tiers) = 0 then
    raise exception 'hr_leave_type_no_tiers' using errcode = '22023';
  end if;
  v_rule := coalesce(t.pro_rata->>'roundingRule', 'round_nearest');
  for e in select x.user_id, x.hire_date, u.full_name, x.employee_no from public.hr_employees x
           join public.users u on u.id = x.user_id and u.organization_id = x.organization_id
           where x.organization_id = p_org and x.onboarding_status = 'completed' and x.status in ('active', 'probation')
             and u.is_active is true and coalesce(u.account_status, 'ACTIVE') <> 'ARCHIVED'
             and (x.hire_date is null or x.hire_date <= make_date(p_year, 12, 31))
             and (t.gender is null or t.gender = 'all' or exists (select 1 from public.hr_employee_statutory_profiles sp
                                                                  where sp.user_id = x.user_id and sp.gender = t.gender))
           order by u.full_name loop
    v_years := case when e.hire_date is null or e.hire_date >= v_jan1 then 0
                    else extract(year from age(v_jan1, e.hire_date))::integer end;
    select tier into v_tier from jsonb_array_elements(t.entitlement_tiers) tier
     where coalesce((tier->>'minYearsOfService')::numeric, 0) <= v_years
       and (tier->>'maxYearsOfService' is null or (tier->>'maxYearsOfService')::numeric > v_years)
     order by coalesce((tier->>'minYearsOfService')::numeric, 0) desc limit 1;
    v_days := coalesce((v_tier->>'daysEntitled')::numeric, 0);
    if coalesce((t.pro_rata->>'enabled')::boolean, false) and e.hire_date is not null and extract(year from e.hire_date) = p_year then
      v_frac := (13 - extract(month from e.hire_date))::numeric / 12;
      v_days := case v_rule when 'round_up' then ceil(v_days * v_frac) when 'round_down' then floor(v_days * v_frac)
                            else round(v_days * v_frac) end;
    end if;
    if (public.hr_leave_balance_of(e.user_id, p_type, p_year)->>'has_entitlement')::boolean then
      v_status := 'skipped_existing';
    elsif e.user_id = p_actor then
      v_status := 'skipped_own_record';
    elsif v_tier is null then
      v_status := 'skipped_no_tier';
    else
      v_status := case when coalesce(p_dry_run, true) then 'would_set' else 'set' end;
      if not coalesce(p_dry_run, true) then
        perform public.hr_leave_post(p_org, e.user_id, p_type, p_year, 'entitlement', v_days, null, p_reason, p_actor,
                                     'run:' || p_type || ':' || p_year || ':' || e.user_id);
        perform public.hr_leave_sync_balance(p_org, e.user_id, p_type, p_year);
        v_n := v_n + 1;
      end if;
    end if;
    v_rows := v_rows || jsonb_build_object('employee_id', e.user_id, 'employee_no', e.employee_no, 'name', e.full_name,
                                           'years_of_service', v_years, 'days', v_days, 'status', v_status);
  end loop;
  return jsonb_build_object('dry_run', coalesce(p_dry_run, true), 'applied', v_n, 'rows', v_rows);
end $fn$;

-- Carry forward unused days of p_from_year into p_from_year + 1, capped by the leave type's carry_forward.maxDays.
-- Expiry/forfeiture is not automated (PD-LV-02): expiryMonths is recorded in the reason only.
create or replace function public.hr_leave_carry_forward_run(p_actor uuid, p_org uuid, p_type uuid, p_from_year integer, p_dry_run boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare t record; e record; b jsonb; v_cap numeric; v_days numeric; v_rows jsonb := '[]'::jsonb; v_n integer := 0; v_status text;
begin
  perform public.hr_leave_assert_hr(p_actor, p_org);
  if not coalesce(p_dry_run, true) and (p_reason is null or length(btrim(p_reason)) < 5) then
    raise exception 'hr_reason_required' using errcode = '22023';
  end if;
  select * into t from public.hr_leave_types where id = p_type and organization_id = any(public.sa_org_ancestry(p_org));
  if not found then raise exception 'hr_leave_type_invalid' using errcode = '22023'; end if;
  if not coalesce((t.carry_forward->>'enabled')::boolean, false) then raise exception 'hr_leave_carry_forward_disabled' using errcode = '22023'; end if;
  v_cap := coalesce((t.carry_forward->>'maxDays')::numeric, 0);
  for e in select distinct l.employee_ref, u.full_name from public.hr_leave_ledger l join public.users u on u.id = l.employee_ref
           where l.organization_id = p_org and l.leave_type_ref = p_type and l.leave_year = p_from_year order by u.full_name loop
    b := public.hr_leave_balance_of(e.employee_ref, p_type, p_from_year);
    v_days := greatest(0, least(v_cap, (b->>'available')::numeric));
    if exists (select 1 from public.hr_leave_ledger where source_key = 'cf:' || p_type || ':' || p_from_year || ':' || e.employee_ref) then
      v_status := 'already_carried';
    elsif e.employee_ref = p_actor then
      v_status := 'skipped_own_record';
    elsif (b->>'pending')::numeric > 0 then
      v_status := 'skipped_pending_requests';
    elsif v_days = 0 then
      v_status := 'nothing_to_carry';
    else
      v_status := case when coalesce(p_dry_run, true) then 'would_carry' else 'carried' end;
      if not coalesce(p_dry_run, true) then
        perform public.hr_leave_post(p_org, e.employee_ref, p_type, p_from_year + 1, 'carry_forward', v_days, null,
                                     p_reason || format(' (from %s; configured expiry %s months — not automated)', p_from_year,
                                                        coalesce(t.carry_forward->>'expiryMonths', '?')),
                                     p_actor, 'cf:' || p_type || ':' || p_from_year || ':' || e.employee_ref);
        perform public.hr_leave_sync_balance(p_org, e.employee_ref, p_type, p_from_year + 1);
        v_n := v_n + 1;
      end if;
    end if;
    v_rows := v_rows || jsonb_build_object('employee_id', e.employee_ref, 'name', e.full_name, 'available', b->'available',
                                           'days', v_days, 'status', v_status);
  end loop;
  return jsonb_build_object('dry_run', coalesce(p_dry_run, true), 'applied', v_n, 'cap', v_cap, 'rows', v_rows);
end $fn$;

-- ---------------------------------------------------------------------------
-- 8. Read models
-- ---------------------------------------------------------------------------
-- Quote for the employee's own application (no write): working days, non-working dates, balance before/after, warnings.
create or replace function public.hr_leave_quote(p_actor uuid, p_type uuid, p_start date, p_end date, p_half_day boolean,
                                                 p_exclude_request uuid default null)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_emp record; t record; v_days numeric := 0; v_split jsonb := '[]'::jsonb; y record; b jsonb; v_warn text[] := '{}';
        v_err text[] := '{}'; v_non jsonb; v_today date;
begin
  perform public.hr_att_assert_actor(p_actor);
  select * into v_emp from public.hr_att_employment(p_actor);
  if v_emp.employment_id is null then raise exception 'hr_onboarding_pending' using errcode = 'P0001'; end if;
  select * into t from public.hr_leave_types where id = p_type and organization_id = any(public.sa_org_ancestry(v_emp.organization_id));
  if not found or t.status <> 'active' then raise exception 'hr_leave_type_invalid' using errcode = '22023'; end if;
  if p_start is null or p_end is null or p_end < p_start then raise exception 'hr_leave_dates_invalid' using errcode = '22023'; end if;
  if p_end - p_start > 366 then raise exception 'hr_leave_span_too_long' using errcode = '22023'; end if;
  if coalesce(p_half_day, false) and p_start <> p_end then v_err := v_err || 'A half day is a single date.'::text; end if;
  v_today := public.hr_att_local_date(v_emp.organization_id, now());
  for y in select * from public.hr_leave_year_split(v_emp.organization_id, p_actor, p_start, p_end, coalesce(p_half_day, false)) loop
    v_days := v_days + y.days;
    b := public.hr_leave_balance_of(p_actor, p_type, y.leave_year, p_exclude_request);
    v_split := v_split || jsonb_build_object('year', y.leave_year, 'days', y.days, 'balance', b,
                                             'available_after', (b->>'available')::numeric - y.days);
    if (b->>'has_entitlement')::boolean and (b->>'available')::numeric < y.days then
      v_err := v_err || format('Not enough balance in %s: %s day(s) requested, %s available.', y.leave_year, y.days, b->>'available');
    end if;
    if not (b->>'has_entitlement')::boolean and t.is_paid_leave then
      v_warn := v_warn || format('No %s entitlement is set up for you in %s yet; HR will review the balance.', t.name, y.leave_year);
    end if;
  end loop;
  if v_days = 0 then v_err := v_err || 'The selected dates contain no working days (rest days or public holidays).'::text; end if;
  select coalesce(jsonb_agg(jsonb_build_object('date', w.d, 'day_type', w.day_type) order by w.d), '[]'::jsonb) into v_non
    from public.hr_leave_working_dates(v_emp.organization_id, p_actor, p_start, p_end) w where w.day_type <> 'normal';
  if t.min_notice_days > 0 and p_start - v_today < t.min_notice_days then
    v_warn := v_warn || format('%s normally needs %s day(s) notice.', t.name, t.min_notice_days);
  end if;
  if t.max_consecutive_days is not null and v_days > t.max_consecutive_days then
    v_warn := v_warn || format('%s allows at most %s consecutive day(s).', t.name, t.max_consecutive_days);
  end if;
  if t.requires_attachment then v_warn := v_warn || 'A supporting document is required for this leave type.'::text; end if;
  if exists (select 1 from public.hr_leave_requests r where r.employee_id = p_actor and r.status in ('pending', 'approved')
             and r.id is distinct from p_exclude_request and r.start_date <= p_end and p_start <= r.end_date) then
    v_err := v_err || 'You already have leave on some of these dates.'::text;
  end if;
  return jsonb_build_object('working_days', v_days, 'per_year', v_split, 'non_working_dates', v_non,
                            'warnings', to_jsonb(v_warn), 'errors', to_jsonb(v_err), 'leave_type', t.name, 'is_paid', t.is_paid_leave);
end $fn$;

-- The employee's balances for a year (all active types of their company) with the ledger lines.
create or replace function public.hr_leave_my_balances(p_actor uuid, p_year integer)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_emp record; v_year integer;
begin
  perform public.hr_att_assert_actor(p_actor);
  select * into v_emp from public.hr_att_employment(p_actor);
  if v_emp.employment_id is null then raise exception 'hr_onboarding_pending' using errcode = 'P0001'; end if;
  v_year := coalesce(p_year, extract(year from public.hr_att_local_date(v_emp.organization_id, now()))::integer);
  return jsonb_build_object('year', v_year, 'types', coalesce((select jsonb_agg(jsonb_build_object(
      'leave_type_id', t.id, 'code', t.code, 'name', t.name, 'color', t.color, 'is_paid', t.is_paid_leave,
      'balance', public.hr_leave_balance_of(p_actor, t.id, v_year),
      'ledger', (select coalesce(jsonb_agg(jsonb_build_object('entry_type', l.entry_type, 'days', l.days, 'reason', l.reason,
                                                              'created_at', l.created_at, 'request_id', l.request_ref) order by l.created_at), '[]'::jsonb)
                 from public.hr_leave_ledger l where l.employee_ref = p_actor and l.leave_type_ref = t.id and l.leave_year = v_year))
      order by t.name)
    from public.hr_leave_types t where t.organization_id = any(public.sa_org_ancestry(v_emp.organization_id)) and t.status = 'active'), '[]'::jsonb));
end $fn$;

create or replace function public.hr_leave_balances_overview(p_actor uuid, p_org uuid, p_year integer)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
begin
  perform public.hr_leave_assert_hr(p_actor, p_org);
  return jsonb_build_object('year', p_year,
    'types', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'code', t.code, 'name', t.name, 'is_paid', t.is_paid_leave,
                                                           'has_tiers', jsonb_array_length(coalesce(t.entitlement_tiers, '[]'::jsonb)) > 0,
                                                           'carry_forward', t.carry_forward) order by t.name)
                       from public.hr_leave_types t where t.organization_id = any(public.sa_org_ancestry(p_org)) and t.status = 'active'), '[]'::jsonb),
    'employees', coalesce((select jsonb_agg(jsonb_build_object('employee_id', e.user_id, 'employee_no', e.employee_no, 'name', u.full_name,
        'hire_date', e.hire_date,
        'balances', (select coalesce(jsonb_object_agg(t.id::text, public.hr_leave_balance_of(e.user_id, t.id, p_year)), '{}'::jsonb)
                     from public.hr_leave_types t where t.organization_id = any(public.sa_org_ancestry(p_org)) and t.status = 'active'))
        order by u.full_name)
      from public.hr_employees e join public.users u on u.id = e.user_id and u.organization_id = e.organization_id
      where e.organization_id = p_org and e.onboarding_status = 'completed' and e.status in ('active', 'probation', 'suspended')), '[]'::jsonb));
end $fn$;

create or replace function public.hr_leave_ledger_for(p_actor uuid, p_employee uuid, p_year integer)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_emp record;
begin
  perform public.hr_att_assert_actor(p_actor);
  select * into v_emp from public.hr_att_employment(p_employee);
  if v_emp.employment_id is null then raise exception 'hr_employment_not_found' using errcode = '22023'; end if;
  if p_actor <> p_employee and not public.hr_actor_has_explicit(p_actor, 'hr.leave.approve', jsonb_build_object('organization_id', v_emp.organization_id))
     and not (v_emp.manager_user_id = p_actor
              and public.hr_actor_has_explicit(p_actor, 'hr.mss.leave_view', jsonb_build_object('organization_id', v_emp.organization_id, 'owner_user_id', p_employee))) then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.leave.approve';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'leave_type', t.name, 'leave_type_id', l.leave_type_ref, 'year', l.leave_year,
            'entry_type', l.entry_type, 'days', l.days, 'reason', l.reason, 'request_id', l.request_ref, 'actor', a.full_name,
            'created_at', l.created_at) order by l.created_at)
    from public.hr_leave_ledger l join public.hr_leave_types t on t.id = l.leave_type_ref left join public.users a on a.id = l.actor_ref
    where l.employee_ref = p_employee and (p_year is null or l.leave_year = p_year)), '[]'::jsonb);
end $fn$;

-- Payroll readiness (no pay calculation): approved UNPAID leave days per employee in a period (working days).
create or replace function public.hr_leave_unpaid_days(p_actor uuid, p_org uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
begin
  perform public.hr_leave_assert_hr(p_actor, p_org);
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 93 then raise exception 'hr_leave_dates_invalid' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('employee_id', x.employee_id, 'name', u.full_name, 'unpaid_days', x.days) order by u.full_name)
    from (select r.employee_id, sum(case when r.is_half_day then 0.5 else 1 end) as days
          from public.hr_leave_requests r join public.hr_leave_types t on t.id = r.leave_type_id and not t.is_paid_leave
          cross join lateral public.hr_leave_working_dates(r.organization_id, r.employee_id, greatest(r.start_date, p_from), least(r.end_date, p_to)) w
          where r.organization_id = p_org and r.status = 'approved' and r.start_date <= p_to and p_from <= r.end_date and w.day_type = 'normal'
          group by r.employee_id) x join public.users u on u.id = x.employee_id), '[]'::jsonb);
end $fn$;

-- ---------------------------------------------------------------------------
-- 9. Privileges
-- ---------------------------------------------------------------------------
do $g$
declare f text;
begin
  foreach f in array array['hr_leave_working_dates(uuid,uuid,date,date)', 'hr_leave_year_split(uuid,uuid,date,date,boolean)',
    'hr_leave_request_years(public.hr_leave_requests)', 'hr_leave_balance_of(uuid,uuid,integer,uuid)', 'hr_leave_sync_balance(uuid,uuid,uuid,integer)',
    'hr_leave_post(uuid,uuid,uuid,integer,text,numeric,uuid,text,uuid,text)', 'hr_leave_assert_hr(uuid,uuid)', 'hr_leave_target(uuid,uuid,uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated, service_role', f);
  end loop;
  foreach f in array array['hr_leave_set_entitlement(uuid,uuid,uuid,integer,numeric,text)', 'hr_leave_adjust(uuid,uuid,uuid,integer,numeric,text)',
    'hr_leave_entitlement_run(uuid,uuid,uuid,integer,boolean,text)', 'hr_leave_carry_forward_run(uuid,uuid,uuid,integer,boolean,text)',
    'hr_leave_quote(uuid,uuid,date,date,boolean,uuid)', 'hr_leave_my_balances(uuid,integer)', 'hr_leave_balances_overview(uuid,uuid,integer)',
    'hr_leave_ledger_for(uuid,uuid,integer)', 'hr_leave_unpaid_days(uuid,uuid,date,date)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $g$;
