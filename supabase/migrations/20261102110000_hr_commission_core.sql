-- ============================================================================
-- HR — Staff Sales Commission: permissions, business units, settings, employee
-- rates, cycles, ledger, adjustments, payroll hand-off outbox
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first), after 20261102100000_order_status_events.
-- Validated only on a throwaway PostgreSQL 17 (supabase/tests/hr_commission/run.sh). Creates NO business data: no
-- business unit, no brand mapping, no employee rate, no cycle, no payroll item, no journal.
--
-- Model (see docs/hr/STAFF_COMMISSION.md)
--   Commission = eligible Business Unit sales × the employee's rate for that Business Unit / 100, per commission cycle.
--   * Business Units (hr_commission_business_units) are new master data: the platform has no Business Unit entity. A
--     Business Unit owns brands through an effective-dated mapping (hr_commission_bu_brands); one brand belongs to at
--     most one Business Unit on any day. A sales line is attributed by its product's brand on its approval date.
--   * Sales lines: D2H order lines (order_items.line_total = qty × unit_price; the schema has no discount, tax or
--     shipping column on a line) of orders whose FIRST approval (order_first_approval) falls in the cycle and whose
--     status is eligible (approved, warehouse_packed, shipped_distributor, closed) when calculated and when approved.
--   * Cycle boundaries are [start_at, end_at) instants in Asia/Kuala_Lumpur, persisted on each cycle. Default: 28th of
--     the previous month 00:00 MYT to 28th of the cycle month 00:00 MYT (i.e. through the 27th 23:59:59.999…).
--   * Employee rates are effective-dated per employee × Business Unit, numeric(9,5) percent, never overlapping, and only
--     become effective when approved by a different person (maker-checker).
--   * Ledger: sources (one row per attributed order line), items (employee × Business Unit × rate period), adjustments.
--     Status open → calculated → under_review → approved → locked → payroll_ready. Approved and later cycles are
--     immutable (triggers), their order lines are claimed exactly once (hr_commission_source_claims). A cancellation
--     after approval becomes a pending negative adjustment in a later open cycle, idempotently keyed.
--   * Payroll: approved, locked cycles can be marked Payroll Ready, which prepares hr_commission_payroll_transfers rows
--     (an outbox keyed per cycle × employee). No payroll run, payroll item, payslip or journal is created.
--
-- Security & Access
--   hr.commission.view, hr.commission.manage, hr.commission.approve, reporting.commission.view,
--   reporting.commission.export — all security_sensitive. Compatibility rule: NOBODY (no legacy role receives them):
--   commission is a new capability and compensation data must be granted explicitly. Mode: NEW_ENFORCED when
--   hr.compensation.view is already S&A-authoritative in this environment, otherwise SHADOW; while not authoritative,
--   the database falls back to Super Admin (role level 1) of the same company only. Root Access holders receive every
--   active permission by design (owner-granted, audited). No standard policy is extended here (see 20261102120000).
--   Every write goes through SECURITY DEFINER functions that check hr_commission_allowed(); API roles cannot write the
--   tables directly. Reads are RLS-filtered per company.
--
-- Single-statement-safe: no statement depends on session state created by an earlier one.
-- Rollback (only while no commission data exists): drop the hr_commission_* / hr_employee_commission_* functions and
-- tables, then delete the five permissions' readiness, mode and compat rows and the permissions.
-- ============================================================================

do $pre$
begin
  if to_regclass('public.order_status_events') is null or to_regprocedure('public.order_first_approval(uuid)') is null then
    raise exception 'hr_commission_prerequisite_missing: apply 20261102100000_order_status_events.sql first';
  end if;
  if to_regprocedure('public.sa_actor_has_permission(uuid,text,jsonb)') is null
     or to_regprocedure('public.sa_is_new_authoritative(text)') is null then
    raise exception 'hr_commission_prerequisite_missing: Security & Access evaluator';
  end if;
  if to_regclass('public.hr_employees') is null or to_regclass('public.brands') is null then
    raise exception 'hr_commission_prerequisite_missing: hr_employees / brands';
  end if;
  if not exists (select 1 from pg_extension where extname = 'btree_gist') then
    raise exception 'hr_commission_prerequisite_missing: btree_gist extension';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Permissions (lock-step with app/src/lib/security-access/commission.ts)
-- ---------------------------------------------------------------------------
insert into public.sa_permissions(permission_key, module, resource, action, description, source, audit_sensitivity) values
 ('hr.commission.view','hr','commission','view','View staff commission settings, employee commission rates, cycles and the commission ledger','new','security_sensitive'),
 ('hr.commission.manage','hr','commission','manage','Maintain Business Units, commission settings and employee commission rates (pending approval); calculate cycles; request adjustments','new','security_sensitive'),
 ('hr.commission.approve','hr','commission','approve','Approve employee commission rate changes, adjustments and commission cycles; lock cycles and mark them Payroll Ready','new','security_sensitive'),
 ('reporting.commission.view','reporting','commission','view','View Commission Reporting (employee commission amounts and source orders)','new','security_sensitive'),
 ('reporting.commission.export','reporting','commission','export','Export Commission Reporting to PDF and Excel','new','security_sensitive')
on conflict (permission_key) do nothing;

insert into public.sa_legacy_compat_rules(permission_key, max_role_level, role_codes, legacy_permissions, employee_baseline, notes)
select k, null, '{}', '{}', false, 'Staff commission: no legacy role reproduces this access; grant explicitly (commission.ts).'
from unnest(array['hr.commission.view','hr.commission.manage','hr.commission.approve','reporting.commission.view','reporting.commission.export']) k
on conflict (permission_key) do nothing;

insert into public.sa_migration_modes(permission_key, mode, legacy_permission_key, notes)
select k,
       case when public.sa_is_new_authoritative('hr.compensation.view') then 'NEW_ENFORCED' else 'SHADOW' end,
       null,
       'Staff commission: S&A decides wherever HR compensation is already S&A-authoritative; elsewhere Super Admin of the company only.'
from unnest(array['hr.commission.view','hr.commission.manage','hr.commission.approve','reporting.commission.view','reporting.commission.export']) k
on conflict (permission_key) do nothing;

insert into public.sa_enforcement_readiness(permission_key, route_wiring, database_backstop, intentional_tightening, notes)
select k, true, case when k like '%.view' then 'rls_gate' else 'rpc_guard' end, null,
       'Commission routes authorize through S&A; tables are RLS-filtered with hr_commission_readable_companies() and written only by hr_commission_* functions that call hr_commission_require().'
from unnest(array['hr.commission.view','hr.commission.manage','hr.commission.approve','reporting.commission.view','reporting.commission.export']) k
on conflict (permission_key) do update set route_wiring = excluded.route_wiring, database_backstop = excluded.database_backstop,
  notes = excluded.notes;

-- ---------------------------------------------------------------------------
-- 2. Authorization helpers
-- ---------------------------------------------------------------------------
create or replace function public.hr_commission_permission_keys()
returns text[] language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array['hr.commission.view','hr.commission.manage','hr.commission.approve','reporting.commission.view','reporting.commission.export']::text[]
$$;
revoke all on function public.hr_commission_permission_keys() from public, anon;
grant execute on function public.hr_commission_permission_keys() to authenticated, service_role;

-- The company (root HQ organization) of the verified caller.
create or replace function public.hr_commission_actor_company()
returns uuid language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select public.get_company_id(u.organization_id) from public.users u where u.id = auth.uid() and u.is_active is true
$$;
revoke all on function public.hr_commission_actor_company() from public, anon;
grant execute on function public.hr_commission_actor_company() to authenticated, service_role;

-- May the caller exercise a commission permission for a company?
--   service role: yes (server routes authorize the user first); no API request (owner/maintenance): yes;
--   S&A-authoritative mode: the S&A decision with the company as organization context;
--   otherwise: Super Admin (role level 1) whose company is that company. No other legacy audience.
create or replace function public.hr_commission_allowed(p_permission text, p_company uuid)
returns boolean language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_role text;
  v_uid uuid := auth.uid();
begin
  if not (p_permission = any(public.hr_commission_permission_keys())) then return false; end if;
  if v_claims is null then return current_user not in ('anon', 'authenticated'); end if;
  v_role := v_claims::jsonb->>'role';
  if v_role = 'service_role' then return true; end if;
  if v_uid is null or p_company is null then return false; end if;
  if public.sa_is_new_authoritative(p_permission) then
    return public.sa_actor_has_permission(v_uid, p_permission, jsonb_build_object('organization_id', p_company));
  end if;
  return exists (
    select 1 from public.users u join public.roles r on r.role_code = u.role_code
    where u.id = v_uid and u.is_active is true and r.role_level = 1 and public.get_company_id(u.organization_id) = p_company);
end
$fn$;
revoke all on function public.hr_commission_allowed(text, uuid) from public, anon;
grant execute on function public.hr_commission_allowed(text, uuid) to authenticated, service_role;

create or replace function public.hr_commission_require(p_permission text, p_company uuid, p_resource text default null)
returns void language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $fn$
begin
  if not public.hr_commission_allowed(p_permission, p_company) then
    raise exception 'sa_authorization_required' using errcode = '42501',
      detail = format('permission=%s resource=%s', p_permission, coalesce(p_resource, '-'));
  end if;
end
$fn$;
revoke all on function public.hr_commission_require(text, uuid, text) from public, anon, authenticated;

-- Companies whose commission data the caller may read with a permission (evaluated once per statement by RLS).
-- Candidates are the caller's own company and every company holding commission master data.
create or replace function public.hr_commission_readable_companies(p_permissions text[])
returns uuid[] language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_out uuid[] := array[]::uuid[];
  c uuid;
  k text;
begin
  for c in
    select x from (
      select public.hr_commission_actor_company() as x
      union select company_id from public.hr_commission_settings
      union select company_id from public.hr_commission_business_units
      union select company_id from public.hr_commission_cycles
    ) s where x is not null
  loop
    foreach k in array p_permissions loop
      if public.hr_commission_allowed(k, c) then v_out := v_out || c; exit; end if;
    end loop;
  end loop;
  return v_out;
end
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.hr_commission_business_units (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.organizations(id),
  code text not null,
  name text not null,
  description text,
  is_active boolean not null default true,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid references public.users(id),
  updated_at timestamptz not null default now(),
  constraint hr_commission_bu_code_format check (code ~ '^[A-Z][A-Z0-9_-]{1,29}$'),
  constraint hr_commission_bu_name_present check (length(btrim(name)) between 2 and 120),
  constraint hr_commission_bu_code_uq unique (company_id, code)
);
comment on table public.hr_commission_business_units is 'Commission Business Units (e.g. Cellera, Ellbow, Sera Outdoor). Master data maintained by HR; no rows are seeded.';

create table if not exists public.hr_commission_bu_brands (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.organizations(id),
  business_unit_id uuid not null references public.hr_commission_business_units(id),
  brand_id uuid not null references public.brands(id),
  effective_from date not null,
  effective_to date,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  ended_by uuid references public.users(id),
  ended_at timestamptz,
  constraint hr_commission_bu_brands_range check (effective_to is null or effective_to >= effective_from),
  -- One brand belongs to at most one Business Unit on any day.
  constraint hr_commission_bu_brands_no_overlap exclude using gist (
    company_id with =, brand_id with =, daterange(effective_from, effective_to, '[]') with &&)
);
create index if not exists hr_commission_bu_brands_bu_idx on public.hr_commission_bu_brands(business_unit_id);

create table if not exists public.hr_commission_settings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.organizations(id),
  effective_from date not null,
  cycle_type text not null default 'custom',
  start_day smallint not null default 28,
  end_day smallint default 27,
  cycle_label_format text not null default '{month} {year} Commission Cycle',
  timezone text not null default 'Asia/Kuala_Lumpur',
  eligible_statuses text[] not null default array['approved','warehouse_packed','shipped_distributor','closed'],
  order_types text[] not null default array['D2H'],
  business_unit_ids uuid[],
  approval_workflow text not null default 'maker_checker',
  payroll_mapping jsonb not null default jsonb_build_object('component_code', 'COMMISSION', 'mode', 'future'),
  notes text,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  constraint hr_commission_settings_month_start check (effective_from = date_trunc('month', effective_from)::date),
  constraint hr_commission_settings_cycle check (
    (cycle_type = 'calendar_month' and start_day = 1 and end_day is null)
    or (cycle_type = 'custom' and start_day between 2 and 28 and end_day = start_day - 1)),
  constraint hr_commission_settings_tz check (timezone = 'Asia/Kuala_Lumpur'),
  constraint hr_commission_settings_statuses check (
    cardinality(eligible_statuses) > 0
    and eligible_statuses <@ array['approved','warehouse_packed','shipped_distributor','closed']),
  -- Initial implementation: D2H sales only.
  constraint hr_commission_settings_order_types check (order_types = array['D2H']),
  constraint hr_commission_settings_workflow check (approval_workflow = 'maker_checker'),
  constraint hr_commission_settings_label check (length(btrim(cycle_label_format)) between 3 and 80),
  constraint hr_commission_settings_version_uq unique (company_id, effective_from)
);
comment on table public.hr_commission_settings is 'Effective-dated commission cycle settings (one version per first-of-month). A cycle snapshots the version it was generated with; later versions never change existing cycles.';

create table if not exists public.hr_employee_commission_profiles (
  employee_id uuid primary key references public.hr_employees(id),
  company_id uuid not null references public.organizations(id),
  is_eligible boolean not null default false,
  notes text,
  updated_by uuid references public.users(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.hr_employee_commission_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.organizations(id),
  employee_id uuid not null references public.hr_employees(id),
  business_unit_id uuid not null references public.hr_commission_business_units(id),
  rate_percent numeric(9,5) not null,
  effective_from date not null,
  effective_to date,
  change_reason text not null,
  request_id uuid,
  requested_by uuid references public.users(id),
  approved_by uuid references public.users(id),
  approved_at timestamptz not null default now(),
  ended_by uuid references public.users(id),
  ended_at timestamptz,
  end_reason text,
  created_at timestamptz not null default now(),
  constraint hr_employee_commission_rules_rate check (rate_percent > 0 and rate_percent <= 100),
  constraint hr_employee_commission_rules_range check (effective_to is null or effective_to >= effective_from),
  constraint hr_employee_commission_rules_no_overlap exclude using gist (
    employee_id with =, business_unit_id with =, daterange(effective_from, effective_to, '[]') with &&)
);
comment on table public.hr_employee_commission_rules is 'Approved, effective-dated commission rates (percent, 5 decimals) per employee and Business Unit. Inclusive effective_to. Written only on approval of a rule request.';
create index if not exists hr_employee_commission_rules_lookup on public.hr_employee_commission_rules(company_id, business_unit_id, effective_from);

create table if not exists public.hr_employee_commission_rule_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.organizations(id),
  employee_id uuid not null references public.hr_employees(id),
  kind text not null,
  business_unit_id uuid references public.hr_commission_business_units(id),
  rate_percent numeric(9,5),
  effective_from date,
  effective_to date,
  target_rule_id uuid references public.hr_employee_commission_rules(id),
  reason text not null,
  status text not null default 'pending',
  requested_by uuid not null references public.users(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references public.users(id),
  decided_at timestamptz,
  decision_note text,
  resulting_rule_id uuid references public.hr_employee_commission_rules(id),
  constraint hr_commission_rule_requests_kind check (
    (kind = 'set_rate' and business_unit_id is not null and rate_percent > 0 and rate_percent <= 100 and effective_from is not null
       and (effective_to is null or effective_to >= effective_from) and target_rule_id is null)
    or (kind = 'end_rule' and target_rule_id is not null and effective_to is not null)),
  constraint hr_commission_rule_requests_status check (status in ('pending','approved','rejected','cancelled')),
  constraint hr_commission_rule_requests_reason check (length(btrim(reason)) >= 5)
);
create index if not exists hr_commission_rule_requests_employee_idx on public.hr_employee_commission_rule_requests(employee_id, requested_at desc);

create table if not exists public.hr_commission_cycles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.organizations(id),
  period_month date not null,
  cycle_code text not null,
  label text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  timezone text not null default 'Asia/Kuala_Lumpur',
  settings_id uuid references public.hr_commission_settings(id),
  settings_snapshot jsonb not null,
  status text not null default 'open',
  calc_version integer not null default 0,
  eligible_sales numeric(15,2) not null default 0,
  total_commission numeric(14,2) not null default 0,
  total_adjustments numeric(14,2) not null default 0,
  net_commission numeric(14,2) not null default 0,
  eligible_employee_count integer not null default 0,
  review_flag_count integer not null default 0,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  calculated_by uuid references public.users(id),
  calculated_at timestamptz,
  submitted_by uuid references public.users(id),
  submitted_at timestamptz,
  approved_by uuid references public.users(id),
  approved_at timestamptz,
  approval_note text,
  flags_acknowledged boolean not null default false,
  locked_by uuid references public.users(id),
  locked_at timestamptz,
  payroll_ready_by uuid references public.users(id),
  payroll_ready_at timestamptz,
  -- Future payroll / GL integration (references only; nothing here posts or creates payroll).
  payroll_component_code text not null default 'COMMISSION',
  payroll_period_start date,
  payroll_period_end date,
  payroll_run_id uuid references public.hr_payroll_runs(id),
  integration_status text not null default 'not_transferred',
  gl_journal_id uuid,
  gl_reversal_journal_id uuid,
  constraint hr_commission_cycles_status check (status in ('open','calculated','under_review','approved','locked','payroll_ready')),
  constraint hr_commission_cycles_month check (period_month = date_trunc('month', period_month)::date),
  constraint hr_commission_cycles_bounds check (end_at > start_at),
  constraint hr_commission_cycles_integration check (integration_status in ('not_transferred','prepared','transferred','reversed')),
  constraint hr_commission_cycles_payroll_period check (payroll_period_end is null or payroll_period_start is null or payroll_period_end >= payroll_period_start),
  constraint hr_commission_cycles_month_uq unique (company_id, period_month),
  constraint hr_commission_cycles_no_overlap exclude using gist (company_id with =, tstzrange(start_at, end_at, '[)') with &&)
);
comment on table public.hr_commission_cycles is 'Commission cycles with persisted [start_at, end_at) boundaries (Asia/Kuala_Lumpur). Approved and later states are immutable snapshots.';

create table if not exists public.hr_commission_calc_runs (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.hr_commission_cycles(id),
  calc_version integer not null,
  calculated_by uuid references public.users(id),
  calculated_at timestamptz not null default now(),
  summary jsonb not null,
  constraint hr_commission_calc_runs_uq unique (cycle_id, calc_version)
);

create table if not exists public.hr_commission_sources (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.hr_commission_cycles(id),
  company_id uuid not null references public.organizations(id),
  calc_version integer not null,
  order_id uuid not null,
  order_item_id uuid not null,
  order_no text not null,
  order_type text not null,
  order_status text not null,
  buyer_org_id uuid,
  buyer_name text,
  approval_at timestamptz not null,
  approval_source text not null,
  approval_date date not null,
  product_id uuid,
  variant_id uuid,
  product_name text,
  brand_id uuid,
  brand_name text,
  business_unit_id uuid references public.hr_commission_business_units(id),
  business_unit_code text,
  business_unit_name text,
  qty integer not null,
  unit_price numeric(12,2) not null,
  line_value numeric(15,2) not null,
  constraint hr_commission_sources_approval_source check (approval_source in ('approval_event','recorded_approved_at')),
  constraint hr_commission_sources_uq unique (cycle_id, order_item_id)
);
comment on table public.hr_commission_sources is 'Attributed sales lines of a cycle calculation (one row per order line, with order, approval, product, brand and Business Unit snapshots).';
create index if not exists hr_commission_sources_cycle_bu_idx on public.hr_commission_sources(cycle_id, business_unit_id, approval_date);
create index if not exists hr_commission_sources_order_idx on public.hr_commission_sources(order_id);

create table if not exists public.hr_commission_items (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.hr_commission_cycles(id),
  company_id uuid not null references public.organizations(id),
  calc_version integer not null,
  employee_id uuid not null references public.hr_employees(id),
  employee_user_id uuid not null,
  employee_name text,
  employee_no integer,
  department_id uuid,
  department_name text,
  business_unit_id uuid not null references public.hr_commission_business_units(id),
  business_unit_code text not null,
  business_unit_name text not null,
  rule_id uuid not null references public.hr_employee_commission_rules(id),
  rate_percent numeric(9,5) not null,
  rule_effective_from date not null,
  rule_effective_to date,
  source_line_count integer not null,
  eligible_sales numeric(15,2) not null,
  commission_raw numeric(24,10) not null,
  commission_amount numeric(14,2) not null,
  constraint hr_commission_items_uq unique (cycle_id, employee_id, business_unit_id, rule_id)
);
comment on table public.hr_commission_items is 'Commission per employee × Business Unit × applicable rate period: eligible_sales × rate_percent / 100, rounded half away from zero to 2 decimals (commission_raw keeps the exact product).';
create index if not exists hr_commission_items_employee_idx on public.hr_commission_items(employee_id, cycle_id);

create table if not exists public.hr_commission_review_flags (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.hr_commission_cycles(id),
  calc_version integer not null,
  flag_type text not null,
  severity text not null default 'review',
  order_id uuid,
  order_item_id uuid,
  order_no text,
  detail jsonb not null default '{}'::jsonb,
  constraint hr_commission_review_flags_type check (flag_type in (
    'approval_timestamp_missing','unattributed_brand','status_reverted','claimed_by_other_cycle',
    'source_value_changed','source_line_removed','late_approval_in_final_cycle','no_eligible_employee')),
  constraint hr_commission_review_flags_severity check (severity in ('info','review'))
);
create index if not exists hr_commission_review_flags_cycle_idx on public.hr_commission_review_flags(cycle_id);

-- Exactly-once claim of an order line by an approved cycle.
create table if not exists public.hr_commission_source_claims (
  order_item_id uuid primary key,
  order_id uuid not null,
  cycle_id uuid not null references public.hr_commission_cycles(id),
  source_id uuid not null references public.hr_commission_sources(id),
  claimed_at timestamptz not null default now()
);

create table if not exists public.hr_commission_adjustments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.organizations(id),
  employee_id uuid not null references public.hr_employees(id),
  business_unit_id uuid references public.hr_commission_business_units(id),
  target_cycle_id uuid not null references public.hr_commission_cycles(id),
  kind text not null,
  amount numeric(14,2) not null,
  reason text not null,
  source_cycle_id uuid references public.hr_commission_cycles(id),
  source_item_id uuid references public.hr_commission_items(id),
  source_order_id uuid,
  source_order_item_id uuid,
  source_order_no text,
  idempotency_key text not null,
  status text not null default 'pending',
  requested_by uuid references public.users(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references public.users(id),
  decided_at timestamptz,
  decision_note text,
  constraint hr_commission_adjustments_kind check (kind in ('manual','cancellation_reversal')),
  constraint hr_commission_adjustments_amount check (amount <> 0),
  constraint hr_commission_adjustments_reversal_negative check (kind <> 'cancellation_reversal' or (amount < 0 and source_item_id is not null and source_order_item_id is not null)),
  constraint hr_commission_adjustments_reason check (length(btrim(reason)) >= 5),
  constraint hr_commission_adjustments_status check (status in ('pending','approved','rejected')),
  constraint hr_commission_adjustments_idem_uq unique (idempotency_key)
);
create index if not exists hr_commission_adjustments_target_idx on public.hr_commission_adjustments(target_cycle_id, status);

-- Payroll hand-off outbox (future). Prepared rows are a contract, not payroll: nothing reads them into a payroll run yet.
create table if not exists public.hr_commission_payroll_transfers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.organizations(id),
  cycle_id uuid not null references public.hr_commission_cycles(id),
  employee_id uuid not null references public.hr_employees(id),
  employee_user_id uuid not null,
  payroll_component_code text not null default 'COMMISSION',
  payroll_period_start date,
  payroll_period_end date,
  gross_commission numeric(14,2) not null,
  adjustments_amount numeric(14,2) not null,
  net_commission numeric(14,2) not null,
  adjustment_details jsonb not null default '[]'::jsonb,
  source_reference text not null,
  idempotency_key text not null,
  transfer_status text not null default 'prepared',
  payroll_run_id uuid references public.hr_payroll_runs(id),
  payroll_run_item_id uuid references public.hr_payroll_run_items(id),
  gl_journal_id uuid,
  gl_reversal_journal_id uuid,
  prepared_by uuid references public.users(id),
  prepared_at timestamptz not null default now(),
  constraint hr_commission_payroll_transfers_status check (transfer_status in ('prepared','transferred','reversed','cancelled')),
  constraint hr_commission_payroll_transfers_idem_uq unique (idempotency_key),
  constraint hr_commission_payroll_transfers_uq unique (cycle_id, employee_id)
);

create table if not exists public.hr_commission_audit_log (
  id bigint generated always as identity primary key,
  company_id uuid,
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id text,
  reason text,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp()
);
create index if not exists hr_commission_audit_log_entity_idx on public.hr_commission_audit_log(entity_type, entity_id, occurred_at);

-- ---------------------------------------------------------------------------
-- 4. Grants and RLS: API roles read through RLS, never write directly
-- ---------------------------------------------------------------------------
do $grants$
declare t text;
begin
  foreach t in array array['hr_commission_business_units','hr_commission_bu_brands','hr_commission_settings',
    'hr_employee_commission_profiles','hr_employee_commission_rules','hr_employee_commission_rule_requests',
    'hr_commission_cycles','hr_commission_calc_runs','hr_commission_sources','hr_commission_items',
    'hr_commission_review_flags','hr_commission_source_claims','hr_commission_adjustments',
    'hr_commission_payroll_transfers','hr_commission_audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated, service_role', t);
    execute format('drop policy if exists hr_commission_read on public.%I', t);
  end loop;
end $grants$;

-- HR commission administration data: hr.commission.view.
create policy hr_commission_read on public.hr_employee_commission_profiles for select to authenticated
  using (company_id = any ((select public.hr_commission_readable_companies(array['hr.commission.view']))::uuid[]));
create policy hr_commission_read on public.hr_employee_commission_rules for select to authenticated
  using (company_id = any ((select public.hr_commission_readable_companies(array['hr.commission.view']))::uuid[]));
create policy hr_commission_read on public.hr_employee_commission_rule_requests for select to authenticated
  using (company_id = any ((select public.hr_commission_readable_companies(array['hr.commission.view']))::uuid[]));
create policy hr_commission_read on public.hr_commission_audit_log for select to authenticated
  using (company_id = any ((select public.hr_commission_readable_companies(array['hr.commission.view']))::uuid[]));
create policy hr_commission_read on public.hr_commission_payroll_transfers for select to authenticated
  using (company_id = any ((select public.hr_commission_readable_companies(array['hr.commission.view']))::uuid[]));

-- Settings, Business Units, cycles and the ledger: HR commission view or Commission Reporting view.
create policy hr_commission_read on public.hr_commission_business_units for select to authenticated
  using (company_id = any ((select public.hr_commission_readable_companies(array['hr.commission.view','reporting.commission.view']))::uuid[]));
create policy hr_commission_read on public.hr_commission_bu_brands for select to authenticated
  using (company_id = any ((select public.hr_commission_readable_companies(array['hr.commission.view','reporting.commission.view']))::uuid[]));
create policy hr_commission_read on public.hr_commission_settings for select to authenticated
  using (company_id = any ((select public.hr_commission_readable_companies(array['hr.commission.view','reporting.commission.view']))::uuid[]));
create policy hr_commission_read on public.hr_commission_cycles for select to authenticated
  using (company_id = any ((select public.hr_commission_readable_companies(array['hr.commission.view','reporting.commission.view']))::uuid[]));
create policy hr_commission_read on public.hr_commission_sources for select to authenticated
  using (company_id = any ((select public.hr_commission_readable_companies(array['hr.commission.view','reporting.commission.view']))::uuid[]));
create policy hr_commission_read on public.hr_commission_items for select to authenticated
  using (company_id = any ((select public.hr_commission_readable_companies(array['hr.commission.view','reporting.commission.view']))::uuid[]));
create policy hr_commission_read on public.hr_commission_adjustments for select to authenticated
  using (company_id = any ((select public.hr_commission_readable_companies(array['hr.commission.view','reporting.commission.view']))::uuid[]));
create policy hr_commission_read on public.hr_commission_calc_runs for select to authenticated
  using (exists (select 1 from public.hr_commission_cycles c where c.id = cycle_id
    and c.company_id = any ((select public.hr_commission_readable_companies(array['hr.commission.view','reporting.commission.view']))::uuid[])));
create policy hr_commission_read on public.hr_commission_review_flags for select to authenticated
  using (exists (select 1 from public.hr_commission_cycles c where c.id = cycle_id
    and c.company_id = any ((select public.hr_commission_readable_companies(array['hr.commission.view','reporting.commission.view']))::uuid[])));
create policy hr_commission_read on public.hr_commission_source_claims for select to authenticated
  using (exists (select 1 from public.hr_commission_cycles c where c.id = cycle_id
    and c.company_id = any ((select public.hr_commission_readable_companies(array['hr.commission.view','reporting.commission.view']))::uuid[])));

revoke all on function public.hr_commission_readable_companies(text[]) from public, anon;
grant execute on function public.hr_commission_readable_companies(text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Integrity triggers (apply to every writer, definer functions included)
-- ---------------------------------------------------------------------------
create or replace function public.hr_commission_cycle_is_final(p_cycle uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce((select status in ('approved','locked','payroll_ready') from public.hr_commission_cycles where id = p_cycle), false)
$$;
revoke all on function public.hr_commission_cycle_is_final(uuid) from public, anon, authenticated;

-- Sources, items, review flags and calc runs of a final cycle are frozen.
create or replace function public.hr_commission_ledger_guard()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $fn$
begin
  if public.hr_commission_cycle_is_final(case when tg_op = 'DELETE' then old.cycle_id else new.cycle_id end)
     or (tg_op = 'UPDATE' and public.hr_commission_cycle_is_final(old.cycle_id)) then
    raise exception 'hr_commission_cycle_finalized' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$fn$;

do $trg$
declare t text;
begin
  foreach t in array array['hr_commission_sources','hr_commission_items','hr_commission_review_flags','hr_commission_calc_runs'] loop
    execute format('drop trigger if exists hr_commission_ledger_guard on public.%I', t);
    execute format('create trigger hr_commission_ledger_guard before insert or update or delete on public.%I for each row execute function public.hr_commission_ledger_guard()', t);
  end loop;
end $trg$;

-- Claims exist only for final cycles; they are released only when an approved (unlocked) cycle is returned for review.
create or replace function public.hr_commission_claims_guard()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $fn$
declare v_status text;
begin
  if tg_op = 'UPDATE' then raise exception 'hr_commission_claim_immutable' using errcode = '42501'; end if;
  select status into v_status from public.hr_commission_cycles where id = case when tg_op = 'DELETE' then old.cycle_id else new.cycle_id end;
  if tg_op = 'INSERT' and v_status is distinct from 'approved' then
    raise exception 'hr_commission_claim_requires_approval' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' and v_status is distinct from 'under_review' then
    raise exception 'hr_commission_claim_immutable' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$fn$;
drop trigger if exists hr_commission_claims_guard on public.hr_commission_source_claims;
create trigger hr_commission_claims_guard before insert or update or delete on public.hr_commission_source_claims
  for each row execute function public.hr_commission_claims_guard();

-- Cycle state machine and snapshot immutability.
create or replace function public.hr_commission_cycle_guard()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $fn$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'open' or old.calc_version > 0 then
      raise exception 'hr_commission_cycle_not_deletable' using errcode = '42501';
    end if;
    return old;
  end if;
  if (new.company_id, new.period_month, new.start_at, new.end_at, new.timezone, new.settings_snapshot, new.cycle_code)
     is distinct from (old.company_id, old.period_month, old.start_at, old.end_at, old.timezone, old.settings_snapshot, old.cycle_code) then
    raise exception 'hr_commission_cycle_boundaries_immutable' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'open' and new.status = 'calculated')
    or (old.status = 'calculated' and new.status in ('calculated','under_review'))
    or (old.status = 'under_review' and new.status in ('calculated','approved'))
    or (old.status = 'approved' and new.status in ('locked','under_review'))
    or (old.status = 'locked' and new.status = 'payroll_ready')) then
    raise exception 'hr_commission_cycle_transition_invalid: % -> %', old.status, new.status using errcode = '42501';
  end if;
  if old.status in ('approved','locked','payroll_ready') and not (old.status = 'approved' and new.status = 'under_review') then
    if (new.calc_version, new.eligible_sales, new.total_commission, new.total_adjustments, new.net_commission,
        new.eligible_employee_count, new.review_flag_count, new.calculated_by, new.calculated_at, new.submitted_by,
        new.submitted_at, new.approved_by, new.approved_at, new.approval_note, new.flags_acknowledged)
       is distinct from
       (old.calc_version, old.eligible_sales, old.total_commission, old.total_adjustments, old.net_commission,
        old.eligible_employee_count, old.review_flag_count, old.calculated_by, old.calculated_at, old.submitted_by,
        old.submitted_at, old.approved_by, old.approved_at, old.approval_note, old.flags_acknowledged) then
      raise exception 'hr_commission_cycle_finalized' using errcode = '42501';
    end if;
    if old.status in ('locked','payroll_ready') and (new.locked_by, new.locked_at) is distinct from (old.locked_by, old.locked_at) then
      raise exception 'hr_commission_cycle_finalized' using errcode = '42501';
    end if;
  end if;
  return new;
end
$fn$;
drop trigger if exists hr_commission_cycle_guard on public.hr_commission_cycles;
create trigger hr_commission_cycle_guard before update or delete on public.hr_commission_cycles
  for each row execute function public.hr_commission_cycle_guard();

-- Adjustments: never deleted; decided once; nothing targets or changes in a final cycle.
create or replace function public.hr_commission_adjustment_guard()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $fn$
begin
  if tg_op = 'DELETE' then raise exception 'hr_commission_adjustment_immutable' using errcode = '42501'; end if;
  if public.hr_commission_cycle_is_final(new.target_cycle_id) then
    raise exception 'hr_commission_cycle_finalized' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if old.status <> 'pending'
       or (new.company_id, new.employee_id, new.business_unit_id, new.target_cycle_id, new.kind, new.amount, new.reason,
           new.source_cycle_id, new.source_item_id, new.source_order_id, new.source_order_item_id, new.idempotency_key,
           new.requested_by, new.requested_at)
          is distinct from
          (old.company_id, old.employee_id, old.business_unit_id, old.target_cycle_id, old.kind, old.amount, old.reason,
           old.source_cycle_id, old.source_item_id, old.source_order_id, old.source_order_item_id, old.idempotency_key,
           old.requested_by, old.requested_at) then
      raise exception 'hr_commission_adjustment_immutable' using errcode = '42501';
    end if;
  end if;
  return new;
end
$fn$;
drop trigger if exists hr_commission_adjustment_guard on public.hr_commission_adjustments;
create trigger hr_commission_adjustment_guard before insert or update or delete on public.hr_commission_adjustments
  for each row execute function public.hr_commission_adjustment_guard();

-- Rules: never deleted; only effective_to may change (end), and never before a date a final cycle already paid on.
create or replace function public.hr_commission_rule_guard()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $fn$
declare v_last date;
begin
  if tg_op = 'DELETE' then raise exception 'hr_commission_rule_immutable' using errcode = '42501'; end if;
  if (new.company_id, new.employee_id, new.business_unit_id, new.rate_percent, new.effective_from, new.change_reason,
      new.request_id, new.requested_by, new.approved_by, new.approved_at, new.created_at)
     is distinct from
     (old.company_id, old.employee_id, old.business_unit_id, old.rate_percent, old.effective_from, old.change_reason,
      old.request_id, old.requested_by, old.approved_by, old.approved_at, old.created_at) then
    raise exception 'hr_commission_rule_immutable' using errcode = '42501';
  end if;
  if new.effective_to is distinct from old.effective_to then
    select max(s.approval_date) into v_last
    from public.hr_commission_items i
    join public.hr_commission_cycles c on c.id = i.cycle_id and c.status in ('approved','locked','payroll_ready')
    join public.hr_commission_sources s on s.cycle_id = i.cycle_id and s.business_unit_id = i.business_unit_id
      and s.approval_date between old.effective_from and coalesce(old.effective_to, 'infinity'::date)
    where i.rule_id = old.id;
    if v_last is not null and (new.effective_to is null or new.effective_to < v_last) then
      raise exception 'hr_commission_rule_used_by_final_cycle: %', v_last using errcode = '42501';
    end if;
  end if;
  return new;
end
$fn$;
drop trigger if exists hr_commission_rule_guard on public.hr_employee_commission_rules;
create trigger hr_commission_rule_guard before update or delete on public.hr_employee_commission_rules
  for each row execute function public.hr_commission_rule_guard();

-- Brand mappings: never deleted; only an open mapping may be ended, not earlier than a final cycle's use of it.
create or replace function public.hr_commission_bu_brand_guard()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $fn$
declare v_last date;
begin
  if tg_op = 'DELETE' then raise exception 'hr_commission_mapping_immutable' using errcode = '42501'; end if;
  if (new.company_id, new.business_unit_id, new.brand_id, new.effective_from, new.created_by, new.created_at)
     is distinct from (old.company_id, old.business_unit_id, old.brand_id, old.effective_from, old.created_by, old.created_at) then
    raise exception 'hr_commission_mapping_immutable' using errcode = '42501';
  end if;
  if new.effective_to is distinct from old.effective_to then
    select max(s.approval_date) into v_last
    from public.hr_commission_sources s
    join public.hr_commission_cycles c on c.id = s.cycle_id and c.status in ('approved','locked','payroll_ready')
    where s.brand_id = old.brand_id and s.business_unit_id = old.business_unit_id
      and s.approval_date >= old.effective_from;
    if v_last is not null and (new.effective_to is null or new.effective_to < v_last) then
      raise exception 'hr_commission_mapping_used_by_final_cycle: %', v_last using errcode = '42501';
    end if;
  end if;
  return new;
end
$fn$;
drop trigger if exists hr_commission_bu_brand_guard on public.hr_commission_bu_brands;
create trigger hr_commission_bu_brand_guard before update or delete on public.hr_commission_bu_brands
  for each row execute function public.hr_commission_bu_brand_guard();

create or replace function public.hr_commission_append_only()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $fn$
begin
  raise exception 'hr_commission_append_only: %', tg_table_name using errcode = '42501';
end
$fn$;
drop trigger if exists hr_commission_append_only on public.hr_commission_audit_log;
create trigger hr_commission_append_only before update or delete on public.hr_commission_audit_log
  for each row execute function public.hr_commission_append_only();
drop trigger if exists hr_commission_append_only on public.hr_commission_settings;
create trigger hr_commission_append_only before update or delete on public.hr_commission_settings
  for each row execute function public.hr_commission_append_only();

-- Payroll transfers: amounts and keys are immutable once prepared.
create or replace function public.hr_commission_transfer_guard()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $fn$
begin
  if tg_op = 'DELETE' then raise exception 'hr_commission_transfer_immutable' using errcode = '42501'; end if;
  if (new.company_id, new.cycle_id, new.employee_id, new.employee_user_id, new.gross_commission, new.adjustments_amount,
      new.net_commission, new.adjustment_details, new.source_reference, new.idempotency_key, new.prepared_by, new.prepared_at)
     is distinct from
     (old.company_id, old.cycle_id, old.employee_id, old.employee_user_id, old.gross_commission, old.adjustments_amount,
      old.net_commission, old.adjustment_details, old.source_reference, old.idempotency_key, old.prepared_by, old.prepared_at) then
    raise exception 'hr_commission_transfer_immutable' using errcode = '42501';
  end if;
  return new;
end
$fn$;
drop trigger if exists hr_commission_transfer_guard on public.hr_commission_payroll_transfers;
create trigger hr_commission_transfer_guard before update or delete on public.hr_commission_payroll_transfers
  for each row execute function public.hr_commission_transfer_guard();

-- ---------------------------------------------------------------------------
-- 6. Internal helpers
-- ---------------------------------------------------------------------------
create or replace function public.hr_commission_audit(p_company uuid, p_action text, p_entity_type text, p_entity_id text,
  p_details jsonb default '{}'::jsonb, p_reason text default null)
returns void language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  insert into public.hr_commission_audit_log(company_id, actor_id, action, entity_type, entity_id, reason, details)
  values (p_company, auth.uid(), p_action, p_entity_type, p_entity_id, p_reason, coalesce(p_details, '{}'::jsonb))
$$;
revoke all on function public.hr_commission_audit(uuid, text, text, text, jsonb, text) from public, anon, authenticated;

-- The company of an HR employee record.
create or replace function public.hr_commission_employee_company(p_employee uuid)
returns uuid language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select public.get_company_id(e.organization_id) from public.hr_employees e where e.id = p_employee
$$;
revoke all on function public.hr_commission_employee_company(uuid) from public, anon, authenticated;

-- Default settings used when a company has saved none (the 28th–27th cycle, D2H, the four approved statuses).
create or replace function public.hr_commission_default_settings()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('source', 'default', 'cycle_type', 'custom', 'start_day', 28, 'end_day', 27,
    'cycle_label_format', '{month} {year} Commission Cycle', 'timezone', 'Asia/Kuala_Lumpur',
    'eligible_statuses', jsonb_build_array('approved','warehouse_packed','shipped_distributor','closed'),
    'order_types', jsonb_build_array('D2H'), 'business_unit_ids', null, 'approval_workflow', 'maker_checker',
    'payroll_mapping', jsonb_build_object('component_code', 'COMMISSION', 'mode', 'future'))
$$;

-- Boundaries of the cycle for a period month: [start, end) in Asia/Kuala_Lumpur.
--   start_day 1:  1st of the month 00:00 → 1st of the next month 00:00 (calendar month)
--   start_day d:  d-th of the previous month 00:00 → d-th of the month 00:00 (default d = 28: 28th → 27th inclusive)
create or replace function public.hr_commission_cycle_bounds(p_period_month date, p_start_day integer)
returns table(start_at timestamptz, end_at timestamptz)
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select
    case when p_start_day = 1
      then make_timestamptz(extract(year from p_period_month)::int, extract(month from p_period_month)::int, 1, 0, 0, 0, 'Asia/Kuala_Lumpur')
      else make_timestamptz(extract(year from (p_period_month - interval '1 month'))::int, extract(month from (p_period_month - interval '1 month'))::int, p_start_day, 0, 0, 0, 'Asia/Kuala_Lumpur')
    end,
    case when p_start_day = 1
      then make_timestamptz(extract(year from (p_period_month + interval '1 month'))::int, extract(month from (p_period_month + interval '1 month'))::int, 1, 0, 0, 0, 'Asia/Kuala_Lumpur')
      else make_timestamptz(extract(year from p_period_month)::int, extract(month from p_period_month)::int, p_start_day, 0, 0, 0, 'Asia/Kuala_Lumpur')
    end
$$;
grant execute on function public.hr_commission_cycle_bounds(date, integer) to authenticated, service_role;

-- The period month an instant belongs to under a start day (pure; persisted cycles stay authoritative).
create or replace function public.hr_commission_period_for(p_at timestamptz, p_start_day integer)
returns date language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
    when p_start_day > 1 and extract(day from (p_at at time zone 'Asia/Kuala_Lumpur')) >= p_start_day
      then (date_trunc('month', (p_at at time zone 'Asia/Kuala_Lumpur')) + interval '1 month')::date
    else date_trunc('month', (p_at at time zone 'Asia/Kuala_Lumpur'))::date
  end
$$;
grant execute on function public.hr_commission_period_for(timestamptz, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Access summary for the screens (same rule the database enforces)
-- ---------------------------------------------------------------------------
create or replace function public.hr_commission_my_access()
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_company uuid := public.hr_commission_actor_company();
  v_out jsonb := jsonb_build_object('company_id', v_company);
  k text;
begin
  foreach k in array public.hr_commission_permission_keys() loop
    v_out := v_out || jsonb_build_object(k, coalesce(v_company is not null and public.hr_commission_allowed(k, v_company), false));
  end loop;
  return v_out;
end
$fn$;
revoke all on function public.hr_commission_my_access() from public, anon;
grant execute on function public.hr_commission_my_access() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Business Units and brand mapping (hr.commission.manage)
-- ---------------------------------------------------------------------------
create or replace function public.hr_commission_save_business_unit(p_id uuid, p_code text, p_name text, p_description text,
  p_is_active boolean, p_reason text)
returns public.hr_commission_business_units
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_company uuid := public.hr_commission_actor_company();
  v_row public.hr_commission_business_units;
begin
  if p_id is not null then
    select company_id into v_company from public.hr_commission_business_units where id = p_id;
    if not found then raise exception 'hr_commission_business_unit_not_found'; end if;
  end if;
  perform public.hr_commission_require('hr.commission.manage', v_company, 'business_unit');
  if p_id is null then
    insert into public.hr_commission_business_units(company_id, code, name, description, is_active, created_by, updated_by)
    values (v_company, upper(btrim(p_code)), btrim(p_name), nullif(btrim(p_description), ''), coalesce(p_is_active, true), auth.uid(), auth.uid())
    returning * into v_row;
  else
    -- The code is the stable identifier and never changes.
    update public.hr_commission_business_units
       set name = btrim(p_name), description = nullif(btrim(p_description), ''), is_active = coalesce(p_is_active, is_active),
           updated_by = auth.uid(), updated_at = now()
     where id = p_id returning * into v_row;
  end if;
  perform public.hr_commission_audit(v_company, case when p_id is null then 'business_unit.created' else 'business_unit.updated' end,
    'business_unit', v_row.id::text, jsonb_build_object('code', v_row.code, 'name', v_row.name, 'is_active', v_row.is_active), p_reason);
  return v_row;
end
$fn$;

create or replace function public.hr_commission_map_brand(p_business_unit uuid, p_brand uuid, p_effective_from date, p_reason text)
returns public.hr_commission_bu_brands
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_company uuid;
  v_row public.hr_commission_bu_brands;
begin
  select company_id into v_company from public.hr_commission_business_units where id = p_business_unit and is_active;
  if not found then raise exception 'hr_commission_business_unit_not_found'; end if;
  perform public.hr_commission_require('hr.commission.manage', v_company, 'business_unit_brand');
  if not exists (select 1 from public.brands b where b.id = p_brand) then raise exception 'hr_commission_brand_not_found'; end if;
  if p_effective_from is null then raise exception 'hr_commission_effective_from_required'; end if;
  -- A mapping may not start inside a period a final cycle already covers.
  if exists (select 1 from public.hr_commission_cycles c where c.company_id = v_company
             and c.status in ('approved','locked','payroll_ready')
             and (c.end_at at time zone 'Asia/Kuala_Lumpur')::date > p_effective_from) then
    raise exception 'hr_commission_mapping_inside_final_cycle' using errcode = '22023';
  end if;
  insert into public.hr_commission_bu_brands(company_id, business_unit_id, brand_id, effective_from, created_by)
  values (v_company, p_business_unit, p_brand, p_effective_from, auth.uid()) returning * into v_row;
  perform public.hr_commission_audit(v_company, 'business_unit.brand_mapped', 'business_unit_brand', v_row.id::text,
    jsonb_build_object('business_unit_id', p_business_unit, 'brand_id', p_brand, 'effective_from', p_effective_from), p_reason);
  return v_row;
end
$fn$;

create or replace function public.hr_commission_end_brand_mapping(p_mapping uuid, p_effective_to date, p_reason text)
returns public.hr_commission_bu_brands
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare v_row public.hr_commission_bu_brands;
begin
  select * into v_row from public.hr_commission_bu_brands where id = p_mapping for update;
  if not found then raise exception 'hr_commission_mapping_not_found'; end if;
  perform public.hr_commission_require('hr.commission.manage', v_row.company_id, 'business_unit_brand');
  if v_row.effective_to is not null then raise exception 'hr_commission_mapping_already_ended'; end if;
  if p_effective_to is null or p_effective_to < v_row.effective_from then raise exception 'hr_commission_effective_to_invalid' using errcode = '22023'; end if;
  update public.hr_commission_bu_brands set effective_to = p_effective_to, ended_by = auth.uid(), ended_at = now()
   where id = p_mapping returning * into v_row;
  perform public.hr_commission_audit(v_row.company_id, 'business_unit.brand_unmapped', 'business_unit_brand', v_row.id::text,
    jsonb_build_object('effective_to', p_effective_to), p_reason);
  return v_row;
end
$fn$;

-- ---------------------------------------------------------------------------
-- 9. Settings (hr.commission.manage). A new version applies only to cycles generated later.
-- ---------------------------------------------------------------------------
create or replace function public.hr_commission_save_settings(p_effective_from date, p_cycle_type text, p_start_day integer,
  p_cycle_label_format text, p_eligible_statuses text[], p_business_unit_ids uuid[], p_notes text)
returns public.hr_commission_settings
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_company uuid := public.hr_commission_actor_company();
  v_last_cycle date;
  v_row public.hr_commission_settings;
begin
  perform public.hr_commission_require('hr.commission.manage', v_company, 'commission_settings');
  if p_effective_from is null or p_effective_from <> date_trunc('month', p_effective_from)::date then
    raise exception 'hr_commission_settings_effective_month' using errcode = '22023', hint = 'Settings take effect from the first day of a cycle month.';
  end if;
  select max(period_month) into v_last_cycle from public.hr_commission_cycles where company_id = v_company;
  if v_last_cycle is not null and p_effective_from <= v_last_cycle then
    raise exception 'hr_commission_settings_overlap_existing_cycles: %', v_last_cycle using errcode = '22023',
      hint = 'Existing cycles keep their settings; choose a month after the latest generated cycle.';
  end if;
  if p_business_unit_ids is not null and exists (
       select 1 from unnest(p_business_unit_ids) b
       where not exists (select 1 from public.hr_commission_business_units u where u.id = b and u.company_id = v_company)) then
    raise exception 'hr_commission_business_unit_not_found';
  end if;
  insert into public.hr_commission_settings(company_id, effective_from, cycle_type, start_day, end_day, cycle_label_format,
    eligible_statuses, business_unit_ids, notes, created_by)
  values (v_company, p_effective_from, p_cycle_type, p_start_day,
    case when p_cycle_type = 'custom' then p_start_day - 1 end,
    coalesce(nullif(btrim(p_cycle_label_format), ''), '{month} {year} Commission Cycle'),
    coalesce(p_eligible_statuses, array['approved','warehouse_packed','shipped_distributor','closed']),
    case when cardinality(p_business_unit_ids) = 0 then null else p_business_unit_ids end,
    nullif(btrim(p_notes), ''), auth.uid())
  returning * into v_row;
  perform public.hr_commission_audit(v_company, 'settings.saved', 'commission_settings', v_row.id::text, to_jsonb(v_row), p_notes);
  return v_row;
end
$fn$;

-- ---------------------------------------------------------------------------
-- 10. Employee eligibility and rate changes (manage requests, approve decides — never the same person)
-- ---------------------------------------------------------------------------
create or replace function public.hr_commission_set_eligibility(p_employee uuid, p_is_eligible boolean, p_reason text)
returns public.hr_employee_commission_profiles
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_company uuid := public.hr_commission_employee_company(p_employee);
  v_row public.hr_employee_commission_profiles;
begin
  if v_company is null then raise exception 'hr_commission_employee_not_found'; end if;
  perform public.hr_commission_require('hr.commission.manage', v_company, 'employee:' || p_employee);
  if p_reason is null or length(btrim(p_reason)) < 5 then raise exception 'hr_commission_reason_required' using errcode = '22023'; end if;
  if not exists (select 1 from public.hr_employees e where e.id = p_employee and e.onboarding_status = 'completed') then
    raise exception 'hr_onboarding_pending' using errcode = 'P0001',
      hint = 'HR must complete onboarding (HR → People → Add Employee) before commission is set up.';
  end if;
  insert into public.hr_employee_commission_profiles(employee_id, company_id, is_eligible, updated_by)
  values (p_employee, v_company, coalesce(p_is_eligible, false), auth.uid())
  on conflict (employee_id) do update set is_eligible = excluded.is_eligible, updated_by = auth.uid(), updated_at = now()
  returning * into v_row;
  perform public.hr_commission_audit(v_company, 'employee.eligibility_set', 'employee', p_employee::text,
    jsonb_build_object('is_eligible', v_row.is_eligible), p_reason);
  return v_row;
end
$fn$;

create or replace function public.hr_commission_request_rate(p_employee uuid, p_business_unit uuid, p_rate_percent numeric,
  p_effective_from date, p_effective_to date, p_reason text)
returns public.hr_employee_commission_rule_requests
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_company uuid := public.hr_commission_employee_company(p_employee);
  v_row public.hr_employee_commission_rule_requests;
begin
  if v_company is null then raise exception 'hr_commission_employee_not_found'; end if;
  perform public.hr_commission_require('hr.commission.manage', v_company, 'employee:' || p_employee);
  if not exists (select 1 from public.hr_employees e where e.id = p_employee and e.onboarding_status = 'completed') then
    raise exception 'hr_onboarding_pending' using errcode = 'P0001',
      hint = 'HR must complete onboarding (HR → People → Add Employee) before commission is set up.';
  end if;
  if not exists (select 1 from public.hr_commission_business_units u where u.id = p_business_unit and u.company_id = v_company and u.is_active) then
    raise exception 'hr_commission_business_unit_not_found';
  end if;
  if p_rate_percent is null or p_rate_percent <= 0 or p_rate_percent > 100 or p_rate_percent <> round(p_rate_percent, 5) then
    raise exception 'hr_commission_rate_invalid' using errcode = '22023', hint = 'A rate is a percentage above 0 and at most 100, with up to 5 decimals.';
  end if;
  insert into public.hr_employee_commission_rule_requests(company_id, employee_id, kind, business_unit_id, rate_percent,
    effective_from, effective_to, reason, requested_by)
  values (v_company, p_employee, 'set_rate', p_business_unit, p_rate_percent, p_effective_from, p_effective_to, btrim(coalesce(p_reason, '')), auth.uid())
  returning * into v_row;
  perform public.hr_commission_audit(v_company, 'rule.requested', 'rule_request', v_row.id::text,
    jsonb_build_object('employee_id', p_employee, 'business_unit_id', p_business_unit, 'rate_percent', p_rate_percent,
      'effective_from', p_effective_from, 'effective_to', p_effective_to), p_reason);
  return v_row;
end
$fn$;

create or replace function public.hr_commission_request_rule_end(p_rule uuid, p_effective_to date, p_reason text)
returns public.hr_employee_commission_rule_requests
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_rule public.hr_employee_commission_rules;
  v_row public.hr_employee_commission_rule_requests;
begin
  select * into v_rule from public.hr_employee_commission_rules where id = p_rule;
  if not found then raise exception 'hr_commission_rule_not_found'; end if;
  perform public.hr_commission_require('hr.commission.manage', v_rule.company_id, 'rule:' || p_rule);
  if p_effective_to is null or p_effective_to < v_rule.effective_from
     or (v_rule.effective_to is not null and p_effective_to >= v_rule.effective_to) then
    raise exception 'hr_commission_effective_to_invalid' using errcode = '22023';
  end if;
  insert into public.hr_employee_commission_rule_requests(company_id, employee_id, kind, target_rule_id, effective_to, reason, requested_by)
  values (v_rule.company_id, v_rule.employee_id, 'end_rule', p_rule, p_effective_to, btrim(coalesce(p_reason, '')), auth.uid())
  returning * into v_row;
  perform public.hr_commission_audit(v_rule.company_id, 'rule.end_requested', 'rule_request', v_row.id::text,
    jsonb_build_object('rule_id', p_rule, 'effective_to', p_effective_to), p_reason);
  return v_row;
end
$fn$;

create or replace function public.hr_commission_cancel_rule_request(p_request uuid, p_reason text)
returns public.hr_employee_commission_rule_requests
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare v_row public.hr_employee_commission_rule_requests;
begin
  select * into v_row from public.hr_employee_commission_rule_requests where id = p_request for update;
  if not found then raise exception 'hr_commission_request_not_found'; end if;
  perform public.hr_commission_require('hr.commission.manage', v_row.company_id, 'rule_request:' || p_request);
  if v_row.status <> 'pending' then raise exception 'hr_commission_request_not_pending'; end if;
  update public.hr_employee_commission_rule_requests set status = 'cancelled', decided_by = auth.uid(), decided_at = now(),
    decision_note = nullif(btrim(p_reason), '') where id = p_request returning * into v_row;
  perform public.hr_commission_audit(v_row.company_id, 'rule.request_cancelled', 'rule_request', p_request::text, '{}'::jsonb, p_reason);
  return v_row;
end
$fn$;

create or replace function public.hr_commission_decide_rule_request(p_request uuid, p_approve boolean, p_note text)
returns public.hr_employee_commission_rule_requests
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_req public.hr_employee_commission_rule_requests;
  v_prev public.hr_employee_commission_rules;
  v_rule public.hr_employee_commission_rules;
  v_employee_user uuid;
begin
  select * into v_req from public.hr_employee_commission_rule_requests where id = p_request for update;
  if not found then raise exception 'hr_commission_request_not_found'; end if;
  perform public.hr_commission_require('hr.commission.approve', v_req.company_id, 'rule_request:' || p_request);
  if v_req.status <> 'pending' then raise exception 'hr_commission_request_not_pending'; end if;
  select user_id into v_employee_user from public.hr_employees where id = v_req.employee_id;
  if auth.uid() is not null and (auth.uid() = v_req.requested_by or auth.uid() = v_employee_user) then
    raise exception 'sod_violation: commission rate maker/checker' using errcode = '42501',
      detail = 'The requester and the employee concerned cannot approve a commission rate change.';
  end if;
  if not coalesce(p_approve, false) then
    if p_note is null or length(btrim(p_note)) < 5 then raise exception 'hr_commission_reason_required' using errcode = '22023'; end if;
    update public.hr_employee_commission_rule_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(),
      decision_note = btrim(p_note) where id = p_request returning * into v_req;
    perform public.hr_commission_audit(v_req.company_id, 'rule.request_rejected', 'rule_request', p_request::text, '{}'::jsonb, p_note);
    return v_req;
  end if;

  if v_req.kind = 'end_rule' then
    update public.hr_employee_commission_rules
       set effective_to = v_req.effective_to, ended_by = auth.uid(), ended_at = now(), end_reason = v_req.reason
     where id = v_req.target_rule_id
     returning * into v_rule;
  else
    -- An open-ended (or later-ending) rate that started earlier is closed the day before the new rate begins.
    -- Any other overlap (a rate starting on or after the new date) must be ended explicitly first.
    if exists (select 1 from public.hr_employee_commission_rules r
               where r.employee_id = v_req.employee_id and r.business_unit_id = v_req.business_unit_id
                 and r.effective_from >= v_req.effective_from
                 and daterange(r.effective_from, r.effective_to, '[]') && daterange(v_req.effective_from, v_req.effective_to, '[]')) then
      raise exception 'hr_commission_rate_overlap' using errcode = '23P01',
        hint = 'A rate already starts on or after this date for this Business Unit; end it first.';
    end if;
    select * into v_prev from public.hr_employee_commission_rules r
     where r.employee_id = v_req.employee_id and r.business_unit_id = v_req.business_unit_id
       and r.effective_from < v_req.effective_from
       and (r.effective_to is null or r.effective_to >= v_req.effective_from)
     for update;
    if found then
      if v_req.effective_to is not null and (v_prev.effective_to is null or v_prev.effective_to > v_req.effective_to) then
        raise exception 'hr_commission_rate_overlap' using errcode = '23P01',
          hint = 'The new rate would split an existing rate; end the existing rate or leave the new rate open-ended.';
      end if;
      update public.hr_employee_commission_rules
         set effective_to = v_req.effective_from - 1, ended_by = auth.uid(), ended_at = now(),
             end_reason = 'Superseded by rate change ' || v_req.id
       where id = v_prev.id;
    end if;
    insert into public.hr_employee_commission_rules(company_id, employee_id, business_unit_id, rate_percent, effective_from,
      effective_to, change_reason, request_id, requested_by, approved_by)
    values (v_req.company_id, v_req.employee_id, v_req.business_unit_id, v_req.rate_percent, v_req.effective_from,
      v_req.effective_to, v_req.reason, v_req.id, v_req.requested_by, auth.uid())
    returning * into v_rule;
  end if;

  update public.hr_employee_commission_rule_requests set status = 'approved', decided_by = auth.uid(), decided_at = now(),
    decision_note = nullif(btrim(p_note), ''), resulting_rule_id = v_rule.id where id = p_request returning * into v_req;
  perform public.hr_commission_audit(v_req.company_id, 'rule.request_approved', 'rule_request', p_request::text,
    jsonb_build_object('rule_id', v_rule.id, 'kind', v_req.kind, 'superseded_rule_id', v_prev.id), p_note);
  return v_req;
end
$fn$;

-- ---------------------------------------------------------------------------
-- 11. Cycles
-- ---------------------------------------------------------------------------
create or replace function public.hr_commission_ensure_cycle(p_period_month date)
returns public.hr_commission_cycles
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_company uuid := public.hr_commission_actor_company();
  v_month date := date_trunc('month', p_period_month)::date;
  v_settings public.hr_commission_settings;
  v_snapshot jsonb;
  v_start_day integer;
  v_start timestamptz;
  v_end timestamptz;
  v_prev public.hr_commission_cycles;
  v_next public.hr_commission_cycles;
  v_row public.hr_commission_cycles;
  v_label text;
begin
  perform public.hr_commission_require('hr.commission.manage', v_company, 'commission_cycle');
  select * into v_row from public.hr_commission_cycles where company_id = v_company and period_month = v_month;
  if found then return v_row; end if;

  select * into v_settings from public.hr_commission_settings
   where company_id = v_company and effective_from <= v_month order by effective_from desc limit 1;
  if found then
    v_snapshot := to_jsonb(v_settings) || jsonb_build_object('source', 'settings');
    v_start_day := v_settings.start_day;
  else
    v_snapshot := public.hr_commission_default_settings();
    v_start_day := 28;
  end if;
  -- No cycle beyond the one that is currently running (or the next, under a later start day).
  if v_month > (public.hr_commission_period_for(now(), v_start_day) + interval '1 month')::date then
    raise exception 'hr_commission_cycle_in_future' using errcode = '22023';
  end if;

  select b.start_at, b.end_at into v_start, v_end from public.hr_commission_cycle_bounds(v_month, v_start_day) b;
  -- Contiguity: a cycle starts exactly where the previous one ended and ends where the next one starts, so a settings
  -- change can neither leave a gap nor overlap.
  select * into v_prev from public.hr_commission_cycles where company_id = v_company and period_month = (v_month - interval '1 month')::date;
  if found then v_start := v_prev.end_at; end if;
  select * into v_next from public.hr_commission_cycles where company_id = v_company and period_month = (v_month + interval '1 month')::date;
  if found then v_end := v_next.start_at; end if;
  if v_end <= v_start then raise exception 'hr_commission_cycle_bounds_invalid' using errcode = '22023'; end if;

  v_label := replace(replace(coalesce(v_snapshot->>'cycle_label_format', '{month} {year} Commission Cycle'),
    '{month}', trim(to_char(v_month, 'Month'))), '{year}', to_char(v_month, 'YYYY'));
  insert into public.hr_commission_cycles(company_id, period_month, cycle_code, label, start_at, end_at, settings_id,
    settings_snapshot, created_by)
  values (v_company, v_month, to_char(v_month, 'YYYY-MM'), v_label, v_start, v_end, v_settings.id, v_snapshot, auth.uid())
  returning * into v_row;
  perform public.hr_commission_audit(v_company, 'cycle.created', 'commission_cycle', v_row.id::text,
    jsonb_build_object('period_month', v_month, 'start_at', v_start, 'end_at', v_end, 'settings_source', v_snapshot->>'source'));
  return v_row;
end
$fn$;

-- Calculation: replaces the cycle's sources, items and review flags with a fresh, versioned calculation.
create or replace function public.hr_commission_calculate(p_cycle uuid)
returns public.hr_commission_cycles
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_cycle public.hr_commission_cycles;
  v_version integer;
  v_statuses text[];
  v_types text[];
  v_bus uuid[];
  v_summary jsonb;
  v_sales numeric(15,2);
  v_commission numeric(14,2);
  v_adjust numeric(14,2);
  v_employees integer;
  v_flags integer;
begin
  select * into v_cycle from public.hr_commission_cycles where id = p_cycle for update;
  if not found then raise exception 'hr_commission_cycle_not_found'; end if;
  perform public.hr_commission_require('hr.commission.manage', v_cycle.company_id, 'commission_cycle:' || p_cycle);
  if v_cycle.status not in ('open','calculated','under_review') then
    raise exception 'hr_commission_cycle_finalized' using errcode = '42501';
  end if;
  v_version := v_cycle.calc_version + 1;
  select coalesce(array_agg(x), array['approved','warehouse_packed','shipped_distributor','closed'])
    into v_statuses from jsonb_array_elements_text(v_cycle.settings_snapshot->'eligible_statuses') x;
  select coalesce(array_agg(x), array['D2H']) into v_types from jsonb_array_elements_text(v_cycle.settings_snapshot->'order_types') x;
  if jsonb_typeof(v_cycle.settings_snapshot->'business_unit_ids') = 'array' then
    select array_agg(x::uuid) into v_bus from jsonb_array_elements_text(v_cycle.settings_snapshot->'business_unit_ids') x;
  end if;

  delete from public.hr_commission_review_flags where cycle_id = p_cycle;
  delete from public.hr_commission_items where cycle_id = p_cycle;
  delete from public.hr_commission_sources where cycle_id = p_cycle;

  -- Orders of the company and order types, with their first approval resolved exactly like order_first_approval().
  create temporary table if not exists pg_temp.hr_commission_calc_orders (
    order_id uuid primary key, order_no text, order_type text, status text, buyer_org_id uuid, approval_at timestamptz,
    approval_source text, order_date date) on commit drop;
  truncate pg_temp.hr_commission_calc_orders;
  insert into pg_temp.hr_commission_calc_orders
  select o.id, coalesce(o.display_doc_no, o.order_no), o.order_type::text, o.status::text, o.buyer_org_id,
         case when ev.first_at is not null then ev.first_at else least(o.approved_at, ev.recorded_before) end,
         case when ev.first_at is not null then 'approval_event'
              when coalesce(o.approved_at, ev.recorded_before) is not null then 'recorded_approved_at'
              else 'unavailable' end,
         o.order_date
  from public.orders o
  left join lateral (
    select min(e.occurred_at) filter (where e.is_first_approval) as first_at, min(e.approved_at_before) as recorded_before
    from public.order_status_events e where e.order_id = o.id and e.to_status = 'approved'
  ) ev on true
  where o.company_id = v_cycle.company_id and o.order_type::text = any(v_types);

  -- Flags: approved-stage orders without any approval timestamp, dated (order_date) inside the cycle. Never guessed.
  insert into public.hr_commission_review_flags(cycle_id, calc_version, flag_type, order_id, order_no, detail)
  select p_cycle, v_version, 'approval_timestamp_missing', c.order_id, c.order_no,
         jsonb_build_object('status', c.status, 'order_date', c.order_date)
  from pg_temp.hr_commission_calc_orders c
  where c.approval_source = 'unavailable' and c.status = any(v_statuses)
    and c.order_date >= (v_cycle.start_at at time zone 'Asia/Kuala_Lumpur')::date
    and c.order_date < (v_cycle.end_at at time zone 'Asia/Kuala_Lumpur')::date;

  -- Flags: approved in the window but now back before approval (neither eligible nor cancelled).
  insert into public.hr_commission_review_flags(cycle_id, calc_version, flag_type, order_id, order_no, detail)
  select p_cycle, v_version, 'status_reverted', c.order_id, c.order_no, jsonb_build_object('status', c.status, 'approval_at', c.approval_at)
  from pg_temp.hr_commission_calc_orders c
  where c.approval_at >= v_cycle.start_at and c.approval_at < v_cycle.end_at
    and not (c.status = any(v_statuses)) and c.status <> 'cancelled';

  -- Attributed sources: eligible-status orders first approved inside [start_at, end_at), one row per order line.
  insert into public.hr_commission_sources(cycle_id, company_id, calc_version, order_id, order_item_id, order_no, order_type,
    order_status, buyer_org_id, buyer_name, approval_at, approval_source, approval_date, product_id, variant_id, product_name,
    brand_id, brand_name, business_unit_id, business_unit_code, business_unit_name, qty, unit_price, line_value)
  select p_cycle, v_cycle.company_id, v_version, c.order_id, oi.id, c.order_no, c.order_type, c.status, c.buyer_org_id,
         bo.org_name, c.approval_at, c.approval_source, (c.approval_at at time zone 'Asia/Kuala_Lumpur')::date,
         oi.product_id, oi.variant_id, p.product_name, p.brand_id, b.brand_name, m.business_unit_id, u.code, u.name,
         oi.qty, oi.unit_price, oi.line_total
  from pg_temp.hr_commission_calc_orders c
  join public.order_items oi on oi.order_id = c.order_id
  left join public.organizations bo on bo.id = c.buyer_org_id
  left join public.products p on p.id = oi.product_id
  left join public.brands b on b.id = p.brand_id
  left join public.hr_commission_bu_brands m on m.company_id = v_cycle.company_id and m.brand_id = p.brand_id
    and (c.approval_at at time zone 'Asia/Kuala_Lumpur')::date between m.effective_from and coalesce(m.effective_to, 'infinity'::date)
  left join public.hr_commission_business_units u on u.id = m.business_unit_id
  where c.approval_at >= v_cycle.start_at and c.approval_at < v_cycle.end_at
    and c.status = any(v_statuses)
    and not exists (select 1 from public.hr_commission_source_claims cl where cl.order_item_id = oi.id and cl.cycle_id <> p_cycle)
    and (v_bus is null or m.business_unit_id is null or m.business_unit_id = any(v_bus));

  -- Flags: lines whose brand maps to no Business Unit on the approval date (excluded from commission, never assigned).
  insert into public.hr_commission_review_flags(cycle_id, calc_version, flag_type, order_id, order_item_id, order_no, detail)
  select p_cycle, v_version, 'unattributed_brand', s.order_id, s.order_item_id, s.order_no,
         jsonb_build_object('brand_id', s.brand_id, 'brand_name', s.brand_name, 'product_name', s.product_name, 'line_value', s.line_value)
  from public.hr_commission_sources s where s.cycle_id = p_cycle and s.business_unit_id is null;

  -- Flags: lines in the window already claimed by another (final) cycle.
  insert into public.hr_commission_review_flags(cycle_id, calc_version, flag_type, order_id, order_item_id, order_no, detail)
  select p_cycle, v_version, 'claimed_by_other_cycle', c.order_id, oi.id, c.order_no, jsonb_build_object('claimed_by_cycle', cl.cycle_id)
  from pg_temp.hr_commission_calc_orders c
  join public.order_items oi on oi.order_id = c.order_id
  join public.hr_commission_source_claims cl on cl.order_item_id = oi.id and cl.cycle_id <> p_cycle
  where c.approval_at >= v_cycle.start_at and c.approval_at < v_cycle.end_at;

  -- Flags: eligible approvals that fall inside an already final cycle's window but were never claimed by it
  -- (e.g. an approval timestamp that only became known later). Not moved automatically.
  insert into public.hr_commission_review_flags(cycle_id, calc_version, flag_type, order_id, order_item_id, order_no, detail)
  select p_cycle, v_version, 'late_approval_in_final_cycle', c.order_id, oi.id, c.order_no,
         jsonb_build_object('final_cycle_id', f.id, 'approval_at', c.approval_at)
  from pg_temp.hr_commission_calc_orders c
  join public.hr_commission_cycles f on f.company_id = v_cycle.company_id and f.status in ('approved','locked','payroll_ready')
    and c.approval_at >= f.start_at and c.approval_at < f.end_at
  join public.order_items oi on oi.order_id = c.order_id
  where c.status = any(v_statuses)
    and f.start_at < v_cycle.start_at
    and not exists (select 1 from public.hr_commission_sources fs where fs.cycle_id = f.id and fs.order_item_id = oi.id)
    and not exists (select 1 from public.hr_commission_source_claims cl where cl.order_item_id = oi.id);

  -- Flags: lines of final cycles whose order line changed or disappeared since it was paid (review; never auto-adjusted).
  insert into public.hr_commission_review_flags(cycle_id, calc_version, flag_type, order_id, order_item_id, order_no, detail)
  select p_cycle, v_version, case when oi.id is null then 'source_line_removed' else 'source_value_changed' end,
         s.order_id, s.order_item_id, s.order_no,
         jsonb_build_object('final_cycle_id', s.cycle_id, 'paid_line_value', s.line_value, 'current_line_value', oi.line_total)
  from public.hr_commission_sources s
  join public.hr_commission_cycles f on f.id = s.cycle_id and f.company_id = v_cycle.company_id and f.status in ('approved','locked','payroll_ready')
  left join public.order_items oi on oi.id = s.order_item_id
  where (oi.id is null or oi.line_total is distinct from s.line_value)
    and s.business_unit_id is not null
    -- Resolved once a decided manual adjustment names the order and the cycle it was paid in.
    and not exists (select 1 from public.hr_commission_adjustments a where a.kind = 'manual' and a.status <> 'pending'
                    and a.source_cycle_id = s.cycle_id and a.source_order_no = s.order_no);

  -- Items: employee × Business Unit × applicable approved rate (by approval date), for eligible employees still employed.
  insert into public.hr_commission_items(cycle_id, company_id, calc_version, employee_id, employee_user_id, employee_name,
    employee_no, department_id, department_name, business_unit_id, business_unit_code, business_unit_name, rule_id,
    rate_percent, rule_effective_from, rule_effective_to, source_line_count, eligible_sales, commission_raw, commission_amount)
  select p_cycle, v_cycle.company_id, v_version, r.employee_id, e.user_id, max(usr.full_name), e.employee_no,
         coalesce(e.department_id, max(usr.department_id::text)::uuid), max(d.dept_name),
         r.business_unit_id, max(s.business_unit_code), max(s.business_unit_name), r.id, r.rate_percent, r.effective_from, r.effective_to,
         count(*), sum(s.line_value), sum(s.line_value) * r.rate_percent / 100, round(sum(s.line_value) * r.rate_percent / 100, 2)
  from public.hr_commission_sources s
  join public.hr_employee_commission_rules r on r.company_id = v_cycle.company_id and r.business_unit_id = s.business_unit_id
    and s.approval_date between r.effective_from and coalesce(r.effective_to, 'infinity'::date)
  join public.hr_employee_commission_profiles pr on pr.employee_id = r.employee_id and pr.is_eligible
  join public.hr_employees e on e.id = r.employee_id
    and (e.end_date is null or s.approval_date <= e.end_date)
    and (e.hire_date is null or s.approval_date >= e.hire_date)
  left join public.users usr on usr.id = e.user_id
  left join public.departments d on d.id = coalesce(e.department_id, usr.department_id)
  where s.cycle_id = p_cycle and s.business_unit_id is not null
  group by r.employee_id, e.user_id, e.employee_no, e.department_id, r.business_unit_id, r.id, r.rate_percent, r.effective_from, r.effective_to;

  -- Flags: attributed Business Unit sales nobody earns commission on (informational).
  insert into public.hr_commission_review_flags(cycle_id, calc_version, flag_type, severity, detail)
  select p_cycle, v_version, 'no_eligible_employee', 'info',
         jsonb_build_object('business_unit_id', s.business_unit_id, 'business_unit_name', max(s.business_unit_name), 'eligible_sales', sum(s.line_value))
  from public.hr_commission_sources s
  where s.cycle_id = p_cycle and s.business_unit_id is not null
    and not exists (select 1 from public.hr_commission_items i where i.cycle_id = p_cycle and i.business_unit_id = s.business_unit_id)
  group by s.business_unit_id;

  -- Reversals: lines paid in a final cycle whose order is now cancelled → one pending negative adjustment per paid
  -- item and line, in this open cycle. The idempotency key makes a reversal exist at most once, whatever its status.
  insert into public.hr_commission_adjustments(company_id, employee_id, business_unit_id, target_cycle_id, kind, amount, reason,
    source_cycle_id, source_item_id, source_order_id, source_order_item_id, source_order_no, idempotency_key, requested_by)
  select v_cycle.company_id, i.employee_id, i.business_unit_id, p_cycle, 'cancellation_reversal',
         -round(s.line_value * i.rate_percent / 100, 2),
         'Order ' || s.order_no || ' cancelled after commission cycle ' || f.cycle_code || ' was approved',
         f.id, i.id, s.order_id, s.order_item_id, s.order_no,
         'reversal:' || s.order_item_id || ':' || i.id, auth.uid()
  from public.hr_commission_sources s
  join public.hr_commission_cycles f on f.id = s.cycle_id and f.company_id = v_cycle.company_id and f.status in ('approved','locked','payroll_ready')
  join public.orders o on o.id = s.order_id and o.status = 'cancelled'
  join public.hr_commission_items i on i.cycle_id = s.cycle_id and i.business_unit_id = s.business_unit_id
    and s.approval_date between i.rule_effective_from and coalesce(i.rule_effective_to, 'infinity'::date)
  where f.period_month < v_cycle.period_month
    and round(s.line_value * i.rate_percent / 100, 2) <> 0
  on conflict (idempotency_key) do nothing;

  select coalesce(sum(line_value) filter (where business_unit_id is not null), 0) into v_sales from public.hr_commission_sources where cycle_id = p_cycle;
  select coalesce(sum(commission_amount), 0), count(distinct employee_id) into v_commission, v_employees from public.hr_commission_items where cycle_id = p_cycle;
  select coalesce(sum(amount), 0) into v_adjust from public.hr_commission_adjustments where target_cycle_id = p_cycle and status = 'approved';
  select count(*) into v_flags from public.hr_commission_review_flags where cycle_id = p_cycle and severity = 'review';

  v_summary := jsonb_build_object(
    'orders_considered', (select count(*) from pg_temp.hr_commission_calc_orders where approval_at >= v_cycle.start_at and approval_at < v_cycle.end_at),
    'cancelled_excluded', (select count(*) from pg_temp.hr_commission_calc_orders where approval_at >= v_cycle.start_at and approval_at < v_cycle.end_at and status = 'cancelled'),
    'source_lines', (select count(*) from public.hr_commission_sources where cycle_id = p_cycle),
    'unattributed_lines', (select count(*) from public.hr_commission_sources where cycle_id = p_cycle and business_unit_id is null),
    'recorded_approval_lines', (select count(*) from public.hr_commission_sources where cycle_id = p_cycle and approval_source = 'recorded_approved_at'),
    'eligible_sales', v_sales, 'total_commission', v_commission, 'approved_adjustments', v_adjust,
    'pending_adjustments', (select count(*) from public.hr_commission_adjustments where target_cycle_id = p_cycle and status = 'pending'),
    'eligible_employees', v_employees, 'review_flags', v_flags);

  insert into public.hr_commission_calc_runs(cycle_id, calc_version, calculated_by, summary) values (p_cycle, v_version, auth.uid(), v_summary);

  update public.hr_commission_cycles
     set status = 'calculated', calc_version = v_version, eligible_sales = v_sales, total_commission = v_commission,
         total_adjustments = v_adjust, net_commission = v_commission + v_adjust, eligible_employee_count = v_employees,
         review_flag_count = v_flags, calculated_by = auth.uid(), calculated_at = now(),
         submitted_by = null, submitted_at = null, flags_acknowledged = false
   where id = p_cycle returning * into v_cycle;
  perform public.hr_commission_audit(v_cycle.company_id, 'cycle.calculated', 'commission_cycle', p_cycle::text, v_summary);
  return v_cycle;
end
$fn$;

create or replace function public.hr_commission_submit_cycle(p_cycle uuid, p_note text)
returns public.hr_commission_cycles
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare v_cycle public.hr_commission_cycles;
begin
  select * into v_cycle from public.hr_commission_cycles where id = p_cycle for update;
  if not found then raise exception 'hr_commission_cycle_not_found'; end if;
  perform public.hr_commission_require('hr.commission.manage', v_cycle.company_id, 'commission_cycle:' || p_cycle);
  if v_cycle.status <> 'calculated' then raise exception 'hr_commission_cycle_not_calculated' using errcode = '22023'; end if;
  update public.hr_commission_cycles set status = 'under_review', submitted_by = auth.uid(), submitted_at = now()
   where id = p_cycle returning * into v_cycle;
  perform public.hr_commission_audit(v_cycle.company_id, 'cycle.submitted', 'commission_cycle', p_cycle::text,
    jsonb_build_object('calc_version', v_cycle.calc_version, 'net_commission', v_cycle.net_commission), p_note);
  return v_cycle;
end
$fn$;

-- Return to Calculated (from Under Review) or to Under Review (from Approved, before Lock). Releases the claims.
create or replace function public.hr_commission_return_cycle(p_cycle uuid, p_reason text)
returns public.hr_commission_cycles
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare v_cycle public.hr_commission_cycles;
begin
  select * into v_cycle from public.hr_commission_cycles where id = p_cycle for update;
  if not found then raise exception 'hr_commission_cycle_not_found'; end if;
  perform public.hr_commission_require('hr.commission.approve', v_cycle.company_id, 'commission_cycle:' || p_cycle);
  if p_reason is null or length(btrim(p_reason)) < 5 then raise exception 'hr_commission_reason_required' using errcode = '22023'; end if;
  if v_cycle.status = 'under_review' then
    update public.hr_commission_cycles set status = 'calculated', submitted_by = null, submitted_at = null
     where id = p_cycle returning * into v_cycle;
  elsif v_cycle.status = 'approved' then
    update public.hr_commission_cycles set status = 'under_review', approved_by = null, approved_at = null, approval_note = null,
           flags_acknowledged = false
     where id = p_cycle returning * into v_cycle;
    delete from public.hr_commission_source_claims where cycle_id = p_cycle;
  else
    raise exception 'hr_commission_cycle_not_returnable' using errcode = '22023';
  end if;
  perform public.hr_commission_audit(v_cycle.company_id, 'cycle.returned', 'commission_cycle', p_cycle::text,
    jsonb_build_object('status', v_cycle.status), p_reason);
  return v_cycle;
end
$fn$;

create or replace function public.hr_commission_approve_cycle(p_cycle uuid, p_acknowledge_flags boolean, p_note text)
returns public.hr_commission_cycles
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_cycle public.hr_commission_cycles;
  v_statuses text[];
  v_bad text;
  v_recipient boolean;
begin
  select * into v_cycle from public.hr_commission_cycles where id = p_cycle for update;
  if not found then raise exception 'hr_commission_cycle_not_found'; end if;
  perform public.hr_commission_require('hr.commission.approve', v_cycle.company_id, 'commission_cycle:' || p_cycle);
  if v_cycle.status <> 'under_review' then raise exception 'hr_commission_cycle_not_under_review' using errcode = '22023'; end if;
  if auth.uid() is not null and (auth.uid() = v_cycle.calculated_by or auth.uid() = v_cycle.submitted_by) then
    raise exception 'sod_violation: commission cycle maker/checker' using errcode = '42501',
      detail = 'The person who calculated or submitted a commission cycle cannot approve it.';
  end if;
  if now() < v_cycle.end_at then
    raise exception 'hr_commission_cycle_not_ended' using errcode = '22023', hint = 'A cycle can be approved only after its end boundary.';
  end if;
  if v_cycle.review_flag_count > 0 and not coalesce(p_acknowledge_flags, false) then
    raise exception 'hr_commission_review_flags_unacknowledged: %', v_cycle.review_flag_count using errcode = '22023';
  end if;
  if exists (select 1 from public.hr_commission_adjustments where target_cycle_id = p_cycle and status = 'pending') then
    raise exception 'hr_commission_pending_adjustments' using errcode = '22023';
  end if;
  -- Finalization re-check: every source order is still approved-stage and every line still has the calculated value.
  select coalesce(array_agg(x), array['approved','warehouse_packed','shipped_distributor','closed'])
    into v_statuses from jsonb_array_elements_text(v_cycle.settings_snapshot->'eligible_statuses') x;
  select s.order_no into v_bad
  from public.hr_commission_sources s
  left join public.orders o on o.id = s.order_id
  left join public.order_items oi on oi.id = s.order_item_id
  where s.cycle_id = p_cycle
    and (o.id is null or not (o.status::text = any(v_statuses)) or oi.id is null or oi.line_total is distinct from s.line_value)
  limit 1;
  if v_bad is not null then
    raise exception 'hr_commission_source_changed: %', v_bad using errcode = '22023', hint = 'Recalculate the cycle before approving.';
  end if;
  -- Approved adjustments are part of the snapshot.
  update public.hr_commission_cycles c
     set total_adjustments = coalesce((select sum(a.amount) from public.hr_commission_adjustments a where a.target_cycle_id = p_cycle and a.status = 'approved'), 0),
         net_commission = c.total_commission + coalesce((select sum(a.amount) from public.hr_commission_adjustments a where a.target_cycle_id = p_cycle and a.status = 'approved'), 0),
         status = 'approved', approved_by = auth.uid(), approved_at = now(), approval_note = nullif(btrim(p_note), ''),
         flags_acknowledged = coalesce(p_acknowledge_flags, false)
   where c.id = p_cycle returning * into v_cycle;
  insert into public.hr_commission_source_claims(order_item_id, order_id, cycle_id, source_id)
  select s.order_item_id, s.order_id, p_cycle, s.id from public.hr_commission_sources s
  where s.cycle_id = p_cycle and s.business_unit_id is not null;
  select exists (select 1 from public.hr_commission_items i where i.cycle_id = p_cycle and i.employee_user_id = auth.uid()) into v_recipient;
  perform public.hr_commission_audit(v_cycle.company_id, 'cycle.approved', 'commission_cycle', p_cycle::text,
    jsonb_build_object('calc_version', v_cycle.calc_version, 'net_commission', v_cycle.net_commission,
      'flags_acknowledged', v_cycle.flags_acknowledged, 'approver_is_recipient', v_recipient), p_note);
  return v_cycle;
end
$fn$;

create or replace function public.hr_commission_lock_cycle(p_cycle uuid, p_note text)
returns public.hr_commission_cycles
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare v_cycle public.hr_commission_cycles;
begin
  select * into v_cycle from public.hr_commission_cycles where id = p_cycle for update;
  if not found then raise exception 'hr_commission_cycle_not_found'; end if;
  perform public.hr_commission_require('hr.commission.approve', v_cycle.company_id, 'commission_cycle:' || p_cycle);
  if v_cycle.status <> 'approved' then raise exception 'hr_commission_cycle_not_approved' using errcode = '22023'; end if;
  update public.hr_commission_cycles set status = 'locked', locked_by = auth.uid(), locked_at = now()
   where id = p_cycle returning * into v_cycle;
  perform public.hr_commission_audit(v_cycle.company_id, 'cycle.locked', 'commission_cycle', p_cycle::text, '{}'::jsonb, p_note);
  return v_cycle;
end
$fn$;

-- Payroll Ready: prepares one outbox row per employee (net of approved adjustments). Creates NO payroll run or item.
create or replace function public.hr_commission_mark_payroll_ready(p_cycle uuid, p_payroll_period_start date, p_payroll_period_end date, p_note text)
returns public.hr_commission_cycles
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare v_cycle public.hr_commission_cycles;
begin
  select * into v_cycle from public.hr_commission_cycles where id = p_cycle for update;
  if not found then raise exception 'hr_commission_cycle_not_found'; end if;
  perform public.hr_commission_require('hr.commission.approve', v_cycle.company_id, 'commission_cycle:' || p_cycle);
  if v_cycle.status <> 'locked' then raise exception 'hr_commission_cycle_not_locked' using errcode = '22023'; end if;
  if p_payroll_period_start is null or p_payroll_period_end is null or p_payroll_period_end < p_payroll_period_start then
    raise exception 'hr_commission_payroll_period_invalid' using errcode = '22023';
  end if;
  insert into public.hr_commission_payroll_transfers(company_id, cycle_id, employee_id, employee_user_id, payroll_period_start,
    payroll_period_end, gross_commission, adjustments_amount, net_commission, adjustment_details, source_reference,
    idempotency_key, prepared_by)
  select v_cycle.company_id, p_cycle, x.employee_id, x.employee_user_id, p_payroll_period_start, p_payroll_period_end,
         x.gross, coalesce(a.total, 0), x.gross + coalesce(a.total, 0), coalesce(a.details, '[]'::jsonb),
         'hr_commission_cycle:' || p_cycle || ':v' || v_cycle.calc_version,
         'commission:' || p_cycle || ':' || x.employee_id, auth.uid()
  from (
    select employee_id, employee_user_id, sum(commission_amount) as gross
    from public.hr_commission_items where cycle_id = p_cycle group by employee_id, employee_user_id
    union
    select a.employee_id, e.user_id, 0 from public.hr_commission_adjustments a join public.hr_employees e on e.id = a.employee_id
    where a.target_cycle_id = p_cycle and a.status = 'approved'
      and not exists (select 1 from public.hr_commission_items i where i.cycle_id = p_cycle and i.employee_id = a.employee_id)
  ) x
  left join lateral (
    select sum(a.amount) as total,
           jsonb_agg(jsonb_build_object('adjustment_id', a.id, 'kind', a.kind, 'amount', a.amount, 'reason', a.reason,
             'source_cycle_id', a.source_cycle_id, 'source_order_no', a.source_order_no) order by a.requested_at) as details
    from public.hr_commission_adjustments a where a.target_cycle_id = p_cycle and a.status = 'approved' and a.employee_id = x.employee_id
  ) a on true
  on conflict (idempotency_key) do nothing;
  update public.hr_commission_cycles set status = 'payroll_ready', payroll_ready_by = auth.uid(), payroll_ready_at = now(),
         payroll_period_start = p_payroll_period_start, payroll_period_end = p_payroll_period_end, integration_status = 'prepared'
   where id = p_cycle returning * into v_cycle;
  perform public.hr_commission_audit(v_cycle.company_id, 'cycle.payroll_ready', 'commission_cycle', p_cycle::text,
    jsonb_build_object('payroll_period_start', p_payroll_period_start, 'payroll_period_end', p_payroll_period_end), p_note);
  return v_cycle;
end
$fn$;

-- ---------------------------------------------------------------------------
-- 12. Manual adjustments (manage requests, approve decides — never the requester or the employee concerned)
-- ---------------------------------------------------------------------------
create or replace function public.hr_commission_request_adjustment(p_employee uuid, p_business_unit uuid, p_target_cycle uuid,
  p_amount numeric, p_reason text, p_source_cycle uuid, p_source_order_no text)
returns public.hr_commission_adjustments
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_cycle public.hr_commission_cycles;
  v_row public.hr_commission_adjustments;
begin
  select * into v_cycle from public.hr_commission_cycles where id = p_target_cycle;
  if not found then raise exception 'hr_commission_cycle_not_found'; end if;
  perform public.hr_commission_require('hr.commission.manage', v_cycle.company_id, 'commission_adjustment');
  if public.hr_commission_employee_company(p_employee) is distinct from v_cycle.company_id then raise exception 'hr_commission_employee_not_found'; end if;
  if v_cycle.status not in ('open','calculated','under_review') then raise exception 'hr_commission_cycle_finalized' using errcode = '42501'; end if;
  if p_amount is null or p_amount = 0 or p_amount <> round(p_amount, 2) then raise exception 'hr_commission_amount_invalid' using errcode = '22023'; end if;
  if p_business_unit is not null and not exists (select 1 from public.hr_commission_business_units where id = p_business_unit and company_id = v_cycle.company_id) then
    raise exception 'hr_commission_business_unit_not_found';
  end if;
  insert into public.hr_commission_adjustments(company_id, employee_id, business_unit_id, target_cycle_id, kind, amount, reason,
    source_cycle_id, source_order_no, idempotency_key, requested_by)
  values (v_cycle.company_id, p_employee, p_business_unit, p_target_cycle, 'manual', p_amount, btrim(coalesce(p_reason, '')),
    p_source_cycle, nullif(btrim(p_source_order_no), ''), 'manual:' || gen_random_uuid(), auth.uid())
  returning * into v_row;
  perform public.hr_commission_audit(v_cycle.company_id, 'adjustment.requested', 'commission_adjustment', v_row.id::text,
    jsonb_build_object('employee_id', p_employee, 'amount', p_amount, 'target_cycle_id', p_target_cycle), p_reason);
  return v_row;
end
$fn$;

create or replace function public.hr_commission_decide_adjustment(p_adjustment uuid, p_approve boolean, p_note text)
returns public.hr_commission_adjustments
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_row public.hr_commission_adjustments;
  v_employee_user uuid;
begin
  select * into v_row from public.hr_commission_adjustments where id = p_adjustment for update;
  if not found then raise exception 'hr_commission_adjustment_not_found'; end if;
  perform public.hr_commission_require('hr.commission.approve', v_row.company_id, 'commission_adjustment:' || p_adjustment);
  if v_row.status <> 'pending' then raise exception 'hr_commission_adjustment_not_pending'; end if;
  select user_id into v_employee_user from public.hr_employees where id = v_row.employee_id;
  if auth.uid() is not null and (auth.uid() = v_row.requested_by or auth.uid() = v_employee_user) then
    raise exception 'sod_violation: commission adjustment maker/checker' using errcode = '42501';
  end if;
  if not coalesce(p_approve, false) and (p_note is null or length(btrim(p_note)) < 5) then
    raise exception 'hr_commission_reason_required' using errcode = '22023';
  end if;
  update public.hr_commission_adjustments
     set status = case when coalesce(p_approve, false) then 'approved' else 'rejected' end,
         decided_by = auth.uid(), decided_at = now(), decision_note = nullif(btrim(p_note), '')
   where id = p_adjustment returning * into v_row;
  -- Keep the open cycle's totals current; final cycles cannot reach here (guard trigger).
  update public.hr_commission_cycles c
     set total_adjustments = coalesce((select sum(a.amount) from public.hr_commission_adjustments a where a.target_cycle_id = c.id and a.status = 'approved'), 0),
         net_commission = c.total_commission + coalesce((select sum(a.amount) from public.hr_commission_adjustments a where a.target_cycle_id = c.id and a.status = 'approved'), 0)
   where c.id = v_row.target_cycle_id and c.status in ('open','calculated','under_review');
  perform public.hr_commission_audit(v_row.company_id, 'adjustment.' || v_row.status, 'commission_adjustment', p_adjustment::text,
    jsonb_build_object('amount', v_row.amount, 'kind', v_row.kind), p_note);
  return v_row;
end
$fn$;

-- ---------------------------------------------------------------------------
-- 12b. Privileged-read audit (report views, drill-downs, exports). Only a caller who may read commission data can
-- record it; the action vocabulary is fixed.
-- ---------------------------------------------------------------------------
create or replace function public.hr_commission_log_access(p_action text, p_entity_type text, p_entity_id text, p_details jsonb)
returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare v_company uuid := public.hr_commission_actor_company();
begin
  if p_action not in ('report_viewed','report_exported','employee_viewed','drilldown_viewed') then
    raise exception 'hr_commission_access_action_invalid' using errcode = '22023';
  end if;
  if not (public.hr_commission_allowed('hr.commission.view', v_company) or public.hr_commission_allowed('reporting.commission.view', v_company)) then
    raise exception 'sa_authorization_required' using errcode = '42501';
  end if;
  if p_action = 'report_exported' and not public.hr_commission_allowed('reporting.commission.export', v_company) then
    raise exception 'sa_authorization_required' using errcode = '42501';
  end if;
  perform public.hr_commission_audit(v_company, 'access.' || p_action, coalesce(p_entity_type, 'commission_report'), p_entity_id,
    coalesce(p_details, '{}'::jsonb) - 'password' - 'token');
end
$fn$;

-- ---------------------------------------------------------------------------
-- 13. Function grants: RPCs to authenticated (each checks hr_commission_require) and service_role
-- ---------------------------------------------------------------------------
do $fgrants$
declare f text;
begin
  foreach f in array array[
    'hr_commission_save_business_unit(uuid,text,text,text,boolean,text)',
    'hr_commission_map_brand(uuid,uuid,date,text)',
    'hr_commission_end_brand_mapping(uuid,date,text)',
    'hr_commission_save_settings(date,text,integer,text,text[],uuid[],text)',
    'hr_commission_set_eligibility(uuid,boolean,text)',
    'hr_commission_request_rate(uuid,uuid,numeric,date,date,text)',
    'hr_commission_request_rule_end(uuid,date,text)',
    'hr_commission_cancel_rule_request(uuid,text)',
    'hr_commission_decide_rule_request(uuid,boolean,text)',
    'hr_commission_ensure_cycle(date)',
    'hr_commission_calculate(uuid)',
    'hr_commission_submit_cycle(uuid,text)',
    'hr_commission_return_cycle(uuid,text)',
    'hr_commission_approve_cycle(uuid,boolean,text)',
    'hr_commission_lock_cycle(uuid,text)',
    'hr_commission_mark_payroll_ready(uuid,date,date,text)',
    'hr_commission_request_adjustment(uuid,uuid,uuid,numeric,text,uuid,text)',
    'hr_commission_decide_adjustment(uuid,boolean,text)',
    'hr_commission_log_access(text,text,text,jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
  foreach f in array array['hr_commission_ledger_guard()','hr_commission_claims_guard()','hr_commission_cycle_guard()',
    'hr_commission_adjustment_guard()','hr_commission_rule_guard()','hr_commission_bu_brand_guard()',
    'hr_commission_append_only()','hr_commission_transfer_guard()','hr_commission_employee_company(uuid)',
    'hr_commission_default_settings()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $fgrants$;
