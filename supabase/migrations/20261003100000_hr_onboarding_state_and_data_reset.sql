-- ============================================================================
-- HR — explicit onboarding state, Add Employee onboarding, and pre-go-live
-- HR data reset (onboarding reset / full HR operational reset)
-- ----------------------------------------------------------------------------
-- Problem
--   hr_employees rows are created automatically for every INTERNAL_EMPLOYEE
--   identity (fn_auto_create_hr_employee, identity_users_forward_employment,
--   the Stage 2 backfill). The row is the employment ANCHOR that projects
--   department / position / manager / employment facts onto public.users for
--   other modules (S&A department scope, approvals, org chart). Its existence
--   therefore cannot mean "HR has registered this person", and deleting HR
--   rows does not undo registration (triggers recreate the anchor).
--
-- Onboarding state (new; owned by HR onboarding functions only)
--   hr_employees.onboarding_status
--     pending    automatically created anchor; HR has not registered the person
--     completed  HR completed onboarding (hr_onboarding_complete) — or a legacy
--                record kept by the backfill rule below
--     reset      HR registration was reset (hr_reset_execute); awaiting HR
--   plus onboarding_source ('hr_onboarding' | 'legacy_backfill' | 'restore'),
--   onboarded_at/by, onboarding_reset_at/by/run_id and hire_date_confirmed
--   (a hire date HR confirmed; anchors default it from the login/creation
--   date, which is never presented as a confirmed hire date).
--
--   Ownership: hr_employees_onboarding_guard (BEFORE INSERT/UPDATE) forces
--   every new row to 'pending' and refuses any change of the onboarding
--   columns unless the write comes from one of the SECURITY DEFINER functions
--   below (transaction-local flag + non-API database role). Profile edits,
--   the users→hr forwarding, the auto-create trigger and logins therefore can
--   never onboard (or re-onboard) anyone.
--
--   Employment status, employee numbers, account status, credentials,
--   memberships, role codes and the users projection are NOT part of the
--   onboarding state: a reset is not a resignation, termination, suspension
--   or access revocation.
--
-- Legacy backfill rule (reviewed; no mass reset as a side effect)
--   Every hr_employees row that exists when this migration runs is marked
--   onboarding_status = 'completed', onboarding_source = 'legacy_backfill',
--   hire_date_confirmed = false. This keeps today's HR lists exactly as they
--   are (HR lists showed every internal user). HR resets them deliberately
--   with the Data Management tool, or re-confirms them through Add Employee.
--   Rows created after this migration start 'pending'.
--
-- Operational guard
--   New attendance entries, timesheets, leave requests, compensation,
--   allowances, deductions and payroll lines require a 'completed' employment
--   record in the row's organization (hr_require_onboarded_employee). History
--   is untouched and stays readable by HR administrators.
--
-- HR pre-go-live state
--   hr_go_live_state(organization_id, phase 'pre_go_live' | 'live'). Seeded
--   'pre_go_live' for every organization with employment records (HR has not
--   gone live). 'live' is one-way (hr_mark_go_live). Resets require
--   'pre_go_live', enforced in the database.
--
-- Reset authorization (enforced in the database, every migration mode)
--   Super Admin (legacy role level 1, sa_legacy_is_super_admin) AND an explicit
--   S&A grant of hr.data.reset for the organization (sa_evaluate_permission,
--   no delegation). hr.data.reset has no compatibility rule and no backfill:
--   a Super Admin must be given the "HR Data Reset Administrator" role.
--
-- Reset scope (explicit allowlist, hr_reset_scope)
--   delete: attendance, leave, payroll, compensation, allowances/deductions,
--           performance operational tables — rows of the selected organization
--   keep:   configuration and every other HR area (listed with counts)
--   Dependencies are discovered from pg_constraint at preview AND execution:
--   any row outside the delete set (another table or another organization)
--   that references a row in the delete set blocks the reset, as do payroll
--   runs posted to the General Ledger and HR/GL posting links. Blocked = no
--   change at all (never a partial reset). Allowlisted tables that do not
--   exist are reported as "not present" (nothing to reset).
--
-- Safety
--   preview token (fingerprint of every in-scope row and onboarding state),
--   idempotency key (request_id), per-organization advisory lock, table locks,
--   typed confirmation, reason, snapshot of every affected row inside the
--   same transaction (count-verified; any failure rolls everything back),
--   permanent append-only run record, restore function.
--   Snapshots hold sensitive HR data: RLS on, no policies, no API-role or
--   service_role grants; only the SECURITY DEFINER functions read them.
--
-- Not touched: auth.users, public.users identity fields, credentials,
--   email/phone, organization membership, S&A assignments, departments,
--   positions, Supply Chain / RoadTour / QR / Finance data. No TRUNCATE, no
--   CASCADE deletes are issued (deletes are row-level, org-scoped, ordered).
--
-- Idempotent: yes. Run manually (SQL editor / psql). No migration mode changes.
--
-- Rollback guidance (reverse order):
--   drop triggers hr_employees_onboarding_guard on hr_employees and
--     hr_require_onboarded_<table> on the guarded tables;
--   drop functions hr_onboarding_*, hr_reset_*, hr_mark_go_live,
--     hr_require_onboarded_employee, hr_employees_onboarding_guard,
--     hr_reject_append_only;
--   keep hr_reset_runs / hr_reset_snapshots / hr_reset_restorations /
--     hr_employee_onboarding_log (audit) or archive them before dropping;
--   drop table hr_reset_scope, hr_go_live_state;
--   alter table hr_employees drop the onboarding_* / onboarded_* /
--     hire_date_confirmed columns;
--   delete role grants of 'hr-data-reset-administrator', the role, the
--     hr.data.reset readiness row, mode row and permission.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Onboarding state on the employment record (+ legacy backfill)
-- ---------------------------------------------------------------------------
-- Defaults first fill existing rows (legacy backfill rule, no row rewrite and
-- no trigger fires), then switch to the values new rows must get.
alter table public.hr_employees add column if not exists onboarding_status text not null default 'completed';
alter table public.hr_employees add column if not exists onboarding_source text default 'legacy_backfill';
alter table public.hr_employees alter column onboarding_status set default 'pending';
alter table public.hr_employees alter column onboarding_source drop default;
alter table public.hr_employees add column if not exists onboarded_at timestamptz;
alter table public.hr_employees add column if not exists onboarded_by uuid;
alter table public.hr_employees add column if not exists onboarding_reset_at timestamptz;
alter table public.hr_employees add column if not exists onboarding_reset_by uuid;
alter table public.hr_employees add column if not exists onboarding_reset_run_id uuid;
alter table public.hr_employees add column if not exists hire_date_confirmed boolean not null default false;

alter table public.hr_employees drop constraint if exists hr_employees_onboarding_status_check;
alter table public.hr_employees add constraint hr_employees_onboarding_status_check
  check (onboarding_status in ('pending','completed','reset'));
alter table public.hr_employees drop constraint if exists hr_employees_onboarding_source_check;
alter table public.hr_employees add constraint hr_employees_onboarding_source_check
  check (onboarding_source is null or onboarding_source in ('hr_onboarding','legacy_backfill','restore'));

create index if not exists hr_employees_org_onboarding_idx on public.hr_employees (organization_id, onboarding_status);

comment on column public.hr_employees.onboarding_status is
  'HR registration state: pending (automatic anchor), completed (HR onboarded / legacy record), reset (registration reset; awaiting HR). Written only by hr_onboarding_complete / hr_reset_* (guard trigger).';
comment on column public.hr_employees.hire_date_confirmed is
  'True when HR confirmed hire_date during onboarding. Anchors default hire_date from the login/creation date, which is not a confirmed hire date.';

-- ---------------------------------------------------------------------------
-- 2. Append-only helper and audit tables
-- ---------------------------------------------------------------------------
create or replace function public.hr_reject_append_only()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $fn$
begin
  raise exception '%_is_append_only', tg_table_name using errcode = '42501';
end $fn$;
revoke all on function public.hr_reject_append_only() from public, anon, authenticated;

create table if not exists public.hr_employee_onboarding_log (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  organization_id uuid not null,
  user_id uuid not null,
  employment_id uuid,
  event text not null check (event in ('completed','already_completed','reset','restored')),
  previous_status text,
  new_status text,
  actor_id uuid,
  reset_run_id uuid,
  details jsonb not null default '{}'::jsonb
);
create index if not exists hr_employee_onboarding_log_user_idx on public.hr_employee_onboarding_log (user_id, occurred_at desc);
alter table public.hr_employee_onboarding_log enable row level security;
revoke all on table public.hr_employee_onboarding_log from public, anon, authenticated, service_role;
grant select on table public.hr_employee_onboarding_log to service_role;
drop trigger if exists hr_employee_onboarding_log_append_only on public.hr_employee_onboarding_log;
create trigger hr_employee_onboarding_log_append_only before update or delete on public.hr_employee_onboarding_log
for each row execute function public.hr_reject_append_only();
drop trigger if exists hr_employee_onboarding_log_no_truncate on public.hr_employee_onboarding_log;
create trigger hr_employee_onboarding_log_no_truncate before truncate on public.hr_employee_onboarding_log
for each statement execute function public.hr_reject_append_only();

-- Permanent reset record (one per executed or blocked attempt).
create table if not exists public.hr_reset_runs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  organization_id uuid not null,
  organization_name text,
  kind text not null check (kind in ('onboarding','full')),
  status text not null check (status in ('completed','blocked')),
  actor_id uuid not null,
  reason text not null,
  confirmation text not null,
  preview_token text not null,
  counts jsonb not null default '{}'::jsonb,
  onboarding_reset integer not null default 0,
  blockers jsonb not null default '[]'::jsonb,
  snapshot_rows integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists hr_reset_runs_org_idx on public.hr_reset_runs (organization_id, created_at desc);
alter table public.hr_reset_runs enable row level security;
revoke all on table public.hr_reset_runs from public, anon, authenticated, service_role;
grant select on table public.hr_reset_runs to service_role;
drop trigger if exists hr_reset_runs_append_only on public.hr_reset_runs;
create trigger hr_reset_runs_append_only before update or delete on public.hr_reset_runs
for each row execute function public.hr_reject_append_only();
drop trigger if exists hr_reset_runs_no_truncate on public.hr_reset_runs;
create trigger hr_reset_runs_no_truncate before truncate on public.hr_reset_runs
for each statement execute function public.hr_reject_append_only();

-- Restorable snapshot of every affected row (sensitive: no API access at all).
create table if not exists public.hr_reset_snapshots (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.hr_reset_runs(id),
  table_name text not null,
  row_id text not null,
  row_data jsonb not null,
  captured_at timestamptz not null default now()
);
create index if not exists hr_reset_snapshots_run_idx on public.hr_reset_snapshots (run_id, table_name);
alter table public.hr_reset_snapshots enable row level security;
alter table public.hr_reset_snapshots force row level security;
revoke all on table public.hr_reset_snapshots from public, anon, authenticated, service_role;
drop trigger if exists hr_reset_snapshots_append_only on public.hr_reset_snapshots;
create trigger hr_reset_snapshots_append_only before update or delete on public.hr_reset_snapshots
for each row execute function public.hr_reject_append_only();
drop trigger if exists hr_reset_snapshots_no_truncate on public.hr_reset_snapshots;
create trigger hr_reset_snapshots_no_truncate before truncate on public.hr_reset_snapshots
for each statement execute function public.hr_reject_append_only();
comment on table public.hr_reset_snapshots is
  'Rows captured before an HR reset (sensitive HR data). No API-role or service_role access; read only by hr_reset_restore.';

create table if not exists public.hr_reset_restorations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null unique references public.hr_reset_runs(id),
  actor_id uuid not null,
  reason text not null,
  restored_rows integer not null,
  restored_onboarding integer not null,
  created_at timestamptz not null default now()
);
alter table public.hr_reset_restorations enable row level security;
revoke all on table public.hr_reset_restorations from public, anon, authenticated, service_role;
grant select on table public.hr_reset_restorations to service_role;
drop trigger if exists hr_reset_restorations_append_only on public.hr_reset_restorations;
create trigger hr_reset_restorations_append_only before update or delete on public.hr_reset_restorations
for each row execute function public.hr_reject_append_only();

-- ---------------------------------------------------------------------------
-- 3. HR go-live state (pre-go-live gate)
-- ---------------------------------------------------------------------------
create table if not exists public.hr_go_live_state (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  phase text not null check (phase in ('pre_go_live','live')),
  changed_at timestamptz not null default now(),
  changed_by uuid,
  note text
);
alter table public.hr_go_live_state enable row level security;
revoke all on table public.hr_go_live_state from public, anon, authenticated, service_role;
grant select on table public.hr_go_live_state to service_role;

create or replace function public.hr_go_live_one_way()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $fn$
begin
  if tg_op = 'DELETE' or (old.phase = 'live' and new.phase <> 'live') then
    raise exception 'hr_go_live_is_one_way' using errcode = '42501';
  end if;
  return new;
end $fn$;
revoke all on function public.hr_go_live_one_way() from public, anon, authenticated;
drop trigger if exists hr_go_live_state_one_way on public.hr_go_live_state;
create trigger hr_go_live_state_one_way before update or delete on public.hr_go_live_state
for each row execute function public.hr_go_live_one_way();

-- HR has not gone live (owner statement): every organization with employment
-- records starts pre-go-live. Existing rows are never changed.
insert into public.hr_go_live_state (organization_id, phase, note)
select distinct e.organization_id, 'pre_go_live', 'Seeded by 20261003100000: HR not yet live'
from public.hr_employees e join public.organizations o on o.id = e.organization_id
on conflict (organization_id) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Onboarding-state guard (ownership)
-- ---------------------------------------------------------------------------
create or replace function public.hr_onboarding_trusted_write()
returns boolean language sql stable set search_path = pg_catalog, pg_temp as $fn$
  select coalesce(current_setting('hr.onboarding_write', true), '') = 'on'
     and current_user not in ('anon', 'authenticated', 'service_role')
$fn$;
revoke all on function public.hr_onboarding_trusted_write() from public, anon, authenticated;

create or replace function public.hr_employees_onboarding_guard()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $fn$
begin
  if public.hr_onboarding_trusted_write() then return new; end if;
  if tg_op = 'INSERT' then
    -- Automatic anchors (auto-create, forwarding, direct inserts) are never onboarded.
    new.onboarding_status := 'pending';
    new.onboarding_source := null;
    new.onboarded_at := null;
    new.onboarded_by := null;
    new.onboarding_reset_at := null;
    new.onboarding_reset_by := null;
    new.onboarding_reset_run_id := null;
    new.hire_date_confirmed := false;
    return new;
  end if;
  if new.onboarding_status is distinct from old.onboarding_status
     or new.onboarding_source is distinct from old.onboarding_source
     or new.onboarded_at is distinct from old.onboarded_at
     or new.onboarded_by is distinct from old.onboarded_by
     or new.onboarding_reset_at is distinct from old.onboarding_reset_at
     or new.onboarding_reset_by is distinct from old.onboarding_reset_by
     or new.onboarding_reset_run_id is distinct from old.onboarding_reset_run_id
     or new.hire_date_confirmed is distinct from old.hire_date_confirmed then
    raise exception 'hr_onboarding_state_protected' using errcode = '42501',
      hint = 'Onboarding state changes only through HR onboarding or the HR reset tool.';
  end if;
  return new;
end $fn$;
revoke all on function public.hr_employees_onboarding_guard() from public, anon, authenticated;

-- Named to run before the other BEFORE triggers on hr_employees.
drop trigger if exists hr_employees_onboarding_guard on public.hr_employees;
create trigger hr_employees_onboarding_guard
before insert or update on public.hr_employees
for each row execute function public.hr_employees_onboarding_guard();

-- ---------------------------------------------------------------------------
-- 5. Operational guard: new HR transactions need a completed onboarding
-- ---------------------------------------------------------------------------
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
  if not exists (select 1 from public.hr_employees e
                 where e.user_id = v_user and e.organization_id = v_org and e.onboarding_status = 'completed') then
    raise exception 'hr_onboarding_pending' using errcode = 'P0001',
      detail = format('%s: employee %s has not completed HR onboarding in organization %s', tg_table_name, v_user, v_org),
      hint = 'HR must complete onboarding (HR → People → Add Employee) before HR transactions are recorded.';
  end if;
  return new;
end $fn$;
revoke all on function public.hr_require_onboarded_employee() from public, anon, authenticated;

do $guards$
declare
  r record;
begin
  for r in
    select * from (values
      ('hr_attendance_entries', 'user_id'),
      ('hr_timesheets', 'user_id'),
      ('hr_leave_requests', 'employee_id'),
      ('hr_employee_compensation', 'employee_id'),
      ('hr_employee_allowances', 'employee_id'),
      ('hr_employee_deductions', 'employee_id'),
      ('hr_payroll_run_items', 'employee_user_id')
    ) as t(tbl, col)
  loop
    if to_regclass('public.' || r.tbl) is not null
       and exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || r.tbl) and a.attname = r.col and not a.attisdropped)
       and exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.' || r.tbl) and a.attname = 'organization_id' and not a.attisdropped) then
      execute format('drop trigger if exists %I on public.%I', 'hr_require_onboarded_' || r.tbl, r.tbl);
      execute format('create trigger %I before insert on public.%I for each row execute function public.hr_require_onboarded_employee(%L)',
                     'hr_require_onboarded_' || r.tbl, r.tbl, r.col);
    end if;
  end loop;
end
$guards$;

-- ---------------------------------------------------------------------------
-- 6. Permission: hr.data.reset (explicit grant only)
-- ---------------------------------------------------------------------------
insert into public.sa_permissions(permission_key, module, resource, action, description, source, audit_sensitivity) values
 ('hr.data.reset','hr','data','reset','Reset HR onboarding and HR operational data of an organization before HR goes live (destructive; Super Admin only, snapshot kept)','new','security_sensitive')
on conflict (permission_key) do nothing;

insert into public.sa_migration_modes(permission_key, mode, legacy_permission_key, notes)
values ('hr.data.reset', 'SHADOW', null,
        'The database always requires Super Admin plus an explicit S&A grant of this permission, in every mode (no legacy or compatibility path).')
on conflict (permission_key) do nothing;

insert into public.sa_enforcement_readiness(permission_key, route_wiring, database_backstop, intentional_tightening, notes)
values ('hr.data.reset', true, 'governance_function',
        'Always requires an explicit S&A assignment (no compatibility grant, no delegation) plus Super Admin, in every migration mode.',
        'HR Data Management routes and hr_reset_preview / hr_reset_execute / hr_reset_restore.')
on conflict (permission_key) do nothing;

insert into public.sa_business_roles(role_key, name, description, source) values
 ('hr-data-reset-administrator','HR Data Reset Administrator',
  'Resets HR onboarding and HR operational data before HR goes live. Granted explicitly to Super Admins; never backfilled.','template')
on conflict (role_key) do nothing;

insert into public.sa_business_role_permissions(role_id, permission_id)
select br.id, p.id from public.sa_business_roles br, public.sa_permissions p
where br.role_key = 'hr-data-reset-administrator' and p.permission_key = 'hr.data.reset'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 7. Reset scope (explicit allowlist + kept categories)
-- ---------------------------------------------------------------------------
create table if not exists public.hr_reset_scope (
  table_name text primary key,
  category text not null,
  action text not null check (action in ('delete','keep')),
  delete_order integer,
  label text not null,
  constraint hr_reset_scope_order check ((action = 'delete') = (delete_order is not null))
);
alter table public.hr_reset_scope enable row level security;
revoke all on table public.hr_reset_scope from public, anon, authenticated, service_role;
grant select on table public.hr_reset_scope to service_role;

-- Re-runs bring the list back to exactly this definition.
delete from public.hr_reset_scope;
insert into public.hr_reset_scope(table_name, category, action, delete_order, label) values
 -- delete (children before parents)
 ('hr_attendance_corrections','attendance','delete',10,'Attendance corrections'),
 ('hr_overtime_calculations','attendance','delete',11,'Overtime calculations'),
 ('hr_overtime_requests','attendance','delete',12,'Overtime requests'),
 ('hr_timesheet_entries','attendance','delete',13,'Timesheet entries'),
 ('hr_timesheets','attendance','delete',14,'Timesheets'),
 ('hr_attendance_entries','attendance','delete',15,'Attendance entries (clock in/out)'),
 ('hr_attendance_audit','attendance','delete',16,'Attendance activity log'),
 ('hr_leave_approvals','leave','delete',20,'Leave approval steps'),
 ('hr_leave_requests','leave','delete',21,'Leave requests'),
 ('hr_leave_balances','leave','delete',22,'Leave balances'),
 ('hr_payslip_access_logs','payroll','delete',30,'Payslip access log'),
 ('hr_payroll_audit','payroll','delete',31,'Payroll run audit trail'),
 ('hr_payroll_run_items','payroll','delete',32,'Payroll lines'),
 ('hr_payroll_runs','payroll','delete',33,'Payroll runs'),
 ('hr_employee_compensation','compensation','delete',40,'Employee compensation'),
 ('hr_employee_allowances','allowances_deductions','delete',50,'Employee allowances'),
 ('hr_employee_deductions','allowances_deductions','delete',51,'Employee deductions'),
 ('hr_kpi_evidence','performance','delete',60,'KPI evidence'),
 ('hr_kpi_adjustments','performance','delete',61,'KPI adjustments'),
 ('hr_kpi_reviews','performance','delete',62,'KPI reviews'),
 ('hr_kpi_scorecard_items','performance','delete',63,'KPI scorecard lines'),
 ('hr_kpi_scorecards','performance','delete',64,'KPI scorecards'),
 ('hr_kpi_actuals','performance','delete',65,'KPI actuals'),
 ('hr_kpi_targets','performance','delete',66,'KPI targets'),
 ('hr_kpi_assignments','performance','delete',67,'KPI assignments'),
 ('hr_performance_reviews','performance','delete',68,'Performance reviews'),
 -- keep: HR configuration and shared setup
 ('departments','configuration','keep',null,'Departments'),
 ('hr_positions','configuration','keep',null,'Positions'),
 ('hr_public_holidays','configuration','keep',null,'Public holidays'),
 ('hr_attendance_policies','configuration','keep',null,'Attendance policy and workweek'),
 ('hr_shifts','configuration','keep',null,'Shifts'),
 ('hr_overtime_policies','configuration','keep',null,'Overtime policies'),
 ('hr_leave_types','configuration','keep',null,'Leave types'),
 ('hr_approval_chains','configuration','keep',null,'Approval rules'),
 ('hr_delegation_rules','configuration','keep',null,'Approval delegation rules'),
 ('hr_salary_bands','configuration','keep',null,'Salary bands'),
 ('hr_allowance_types','configuration','keep',null,'Allowance types'),
 ('hr_deduction_types','configuration','keep',null,'Deduction types'),
 ('hr_settings','configuration','keep',null,'HR settings'),
 ('hr_gl_mappings','configuration','keep',null,'HR GL mappings'),
 ('hr_kpi_metrics','configuration','keep',null,'KPI library'),
 ('hr_kpi_periods','configuration','keep',null,'KPI periods'),
 ('hr_kpi_objectives','configuration','keep',null,'KPI objectives'),
 ('hr_appraisal_cycles','configuration','keep',null,'Appraisal cycles'),
 ('hr_review_templates','configuration','keep',null,'Review templates'),
 -- keep: employment anchors and HR areas outside this reset
 ('hr_employees','employment_records','keep',null,'Employment records and employee numbers'),
 ('hr_employee_profiles','employment_records','keep',null,'Employee profiles'),
 ('hr_contracts','not_in_scope','keep',null,'Employment contracts'),
 ('hr_expense_claims','not_in_scope','keep',null,'Expense claims'),
 ('hr_benefit_enrollments','not_in_scope','keep',null,'Benefit enrollments'),
 ('hr_benefit_contribution_runs','not_in_scope','keep',null,'Benefit contribution runs'),
 ('hr_job_postings','not_in_scope','keep',null,'Recruitment'),
 ('hr_course_enrollments','not_in_scope','keep',null,'Learning enrollments'),
 ('hr_certifications','not_in_scope','keep',null,'Certifications'),
 ('hr_policy_acknowledgements','not_in_scope','keep',null,'Policy acknowledgements'),
 ('hr_onboarding_instances','not_in_scope','keep',null,'Onboarding checklists'),
 ('hr_document_requests','not_in_scope','keep',null,'Document requests'),
 ('hr_profile_change_requests','not_in_scope','keep',null,'Profile change requests'),
 ('hr_kpi_snapshots','not_in_scope','keep',null,'KPI snapshots'),
 ('hr_kpi_audit_log','not_in_scope','keep',null,'KPI audit log');

-- ---------------------------------------------------------------------------
-- 8. Authorization helpers
-- ---------------------------------------------------------------------------
create or replace function public.hr_reset_actor_check(p_actor uuid, p_org uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_super boolean;
  v_perm boolean;
  v_phase text;
begin
  v_super := p_actor is not null and public.sa_legacy_is_super_admin(p_actor);
  v_perm := p_actor is not null and p_org is not null
    and coalesce(public.sa_evaluate_permission(p_actor, 'hr.data.reset', jsonb_build_object('organization_id', p_org), false)->>'decision', 'DENY') = 'ALLOW';
  select g.phase into v_phase from public.hr_go_live_state g where g.organization_id = p_org;
  return jsonb_build_object('super_admin', v_super, 'reset_permission', v_perm,
                            'phase', coalesce(v_phase, 'not_configured'),
                            'eligible', v_super and v_perm and v_phase = 'pre_go_live');
end $fn$;
revoke all on function public.hr_reset_actor_check(uuid,uuid) from public, anon, authenticated;
grant execute on function public.hr_reset_actor_check(uuid,uuid) to service_role;

create or replace function public.hr_reset_authorize(p_actor uuid, p_org uuid)
returns void language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v jsonb;
begin
  if p_actor is null then raise exception 'sa_actor_required' using errcode = '42501'; end if;
  if not exists (select 1 from public.users u where u.id = p_actor and u.is_active is true) then
    raise exception 'sa_actor_inactive' using errcode = '42501';
  end if;
  if p_org is null or not exists (select 1 from public.organizations o where o.id = p_org) then
    raise exception 'hr_reset_organization_unknown' using errcode = '22023';
  end if;
  v := public.hr_reset_actor_check(p_actor, p_org);
  if not (v->>'super_admin')::boolean then
    raise exception 'hr_reset_requires_super_admin' using errcode = '42501';
  end if;
  if not (v->>'reset_permission')::boolean then
    raise exception 'hr_reset_permission_required' using errcode = '42501', detail = 'hr.data.reset';
  end if;
  if v->>'phase' <> 'pre_go_live' then
    raise exception 'hr_reset_not_pre_go_live' using errcode = '42501', detail = v->>'phase';
  end if;
end $fn$;
revoke all on function public.hr_reset_authorize(uuid,uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. Reset plan (shared by preview and execution; no authorization, no writes)
-- ---------------------------------------------------------------------------
create or replace function public.hr_reset_plan(p_org uuid, p_kind text)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  s record;
  c record;
  v_reg regclass;
  v_n bigint;
  v_hash text;
  v_hashes text := '';
  v_delete jsonb := '[]'::jsonb;
  v_keep jsonb := '[]'::jsonb;
  v_absent jsonb := '[]'::jsonb;
  v_blockers jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_regs regclass[] := array[]::regclass[];
  v_orders integer[] := array[]::integer[];
  v_ids text[] := array[]::text[];
  v_row_ids text[];
  v_child_order integer;
  v_parent_order integer;
  v_child_in_scope boolean;
  v_col text;
  v_pcol text;
  v_onb_completed bigint;
  v_onb_awaiting bigint;
  v_onb_hash text;
  v_org record;
  v_total bigint := 0;
begin
  if p_kind not in ('onboarding','full') then raise exception 'hr_reset_kind_invalid' using errcode = '22023'; end if;
  select o.id, o.org_name, o.org_code into v_org from public.organizations o where o.id = p_org;
  if not found then raise exception 'hr_reset_organization_unknown' using errcode = '22023'; end if;

  -- Onboarding (both kinds)
  select count(*) filter (where e.onboarding_status = 'completed'),
         count(*) filter (where e.onboarding_status in ('pending','reset')),
         coalesce(md5(string_agg(e.id::text || ':' || e.onboarding_status, ',' order by e.id)), '')
    into v_onb_completed, v_onb_awaiting, v_onb_hash
  from public.hr_employees e where e.organization_id = p_org;

  -- Allowlisted tables
  for s in select * from public.hr_reset_scope order by action, delete_order nulls last, table_name loop
    v_reg := to_regclass('public.' || s.table_name);
    if v_reg is null then
      if s.action = 'delete' then
        v_absent := v_absent || jsonb_build_array(jsonb_build_object('table', s.table_name, 'category', s.category, 'label', s.label));
      end if;
      continue;
    end if;
    if not exists (select 1 from pg_attribute a where a.attrelid = v_reg and a.attname = 'organization_id' and not a.attisdropped) then
      if s.action = 'delete' and p_kind = 'full' then
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'SCOPE_TABLE_SHAPE', 'table', s.table_name,
          'message', format('%s has no organization column; it cannot be reset per organization.', s.label)));
      else
        v_keep := v_keep || jsonb_build_array(jsonb_build_object('table', s.table_name, 'category', s.category, 'label', s.label, 'count', null));
      end if;
      continue;
    end if;
    if s.action = 'delete' and p_kind = 'full' then
      if not exists (select 1 from pg_attribute a where a.attrelid = v_reg and a.attname = 'id' and not a.attisdropped) then
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'SCOPE_TABLE_SHAPE', 'table', s.table_name,
          'message', format('%s has no id column; it cannot be snapshotted row by row.', s.label)));
        continue;
      end if;
      execute format('select count(*), coalesce(md5(string_agg(md5(t::text), '','' order by t.id::text)), '''') from %s t where t.organization_id = $1', v_reg)
        into v_n, v_hash using p_org;
      v_hashes := v_hashes || s.table_name || '=' || v_hash || ';';
      v_total := v_total + v_n;
      v_regs := v_regs || v_reg;
      v_orders := v_orders || s.delete_order;
      v_delete := v_delete || jsonb_build_array(jsonb_build_object('table', s.table_name, 'category', s.category, 'label', s.label,
                                                                  'order', s.delete_order, 'count', v_n));
      if v_n > 0 then
        execute format('select coalesce(array_agg(t.id::text), array[]::text[]) from %s t where t.organization_id = $1', v_reg)
          into v_row_ids using p_org;
        v_ids := v_ids || v_row_ids;
        -- ON DELETE triggers on in-scope tables are reported (they fire, atomically).
        v_warnings := v_warnings || coalesce((
          select jsonb_agg(jsonb_build_object('code', 'DELETE_TRIGGER', 'table', s.table_name, 'trigger', t.tgname))
          from pg_trigger t where t.tgrelid = v_reg and not t.tgisinternal and (t.tgtype & 8) = 8), '[]'::jsonb);
      end if;
    else
      execute format('select count(*) from %s t where t.organization_id = $1', v_reg) into v_n using p_org;
      v_keep := v_keep || jsonb_build_array(jsonb_build_object('table', s.table_name, 'category',
        case when s.action = 'delete' then 'kept_by_onboarding_reset:' || s.category else s.category end,
        'label', s.label, 'count', v_n));
    end if;
  end loop;

  if p_kind = 'full' then
    -- Delete order inside the allowlist must respect every foreign key.
    for c in
      select con.conname, con.conrelid::regclass as child, con.confrelid::regclass as parent,
             (select relname from pg_class where oid = con.conrelid)::text as child_name,
             (select relname from pg_class where oid = con.confrelid)::text as parent_name
      from pg_constraint con
      where con.contype = 'f' and con.conrelid = any(v_regs) and con.confrelid = any(v_regs) and con.conrelid <> con.confrelid
    loop
      v_child_order := v_orders[array_position(v_regs, c.child)];
      v_parent_order := v_orders[array_position(v_regs, c.parent)];
      if v_child_order >= v_parent_order then
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'SCOPE_ORDER', 'table', c.child_name,
          'message', format('Reset order is wrong: %s must be removed before %s (%s).', c.child_name, c.parent_name, c.conname)));
      end if;
    end loop;

    -- Every reference into the delete set from outside it blocks the reset.
    for c in
      select con.conname, con.conrelid::regclass as child, con.confrelid::regclass as parent, con.conkey, con.confkey,
             cardinality(con.conkey) as ncols,
             (select relname from pg_class where oid = con.conrelid)::text as child_name,
             (select relname from pg_class where oid = con.confrelid)::text as parent_name
      from pg_constraint con
      where con.contype = 'f' and con.confrelid = any(v_regs)
    loop
      v_child_in_scope := c.child = any(v_regs);
      if c.ncols <> 1 then
        if not v_child_in_scope then
          v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'UNSUPPORTED_DEPENDENCY', 'table', c.child_name,
            'message', format('%s has a multi-column reference to %s (%s) that cannot be checked safely.', c.child_name, c.parent_name, c.conname)));
        end if;
        continue;
      end if;
      select a.attname into v_col from pg_attribute a where a.attrelid = c.child and a.attnum = c.conkey[1];
      select a.attname into v_pcol from pg_attribute a where a.attrelid = c.parent and a.attnum = c.confkey[1];
      if v_child_in_scope then
        if c.child = c.parent then
          execute format('select count(*) from %1$s r where r.%2$I in (select p.%3$I from %1$s p where p.organization_id = $1) and r.organization_id is distinct from $1',
                         c.child, v_col, v_pcol) into v_n using p_org;
        else
          execute format('select count(*) from %1$s r where r.%2$I in (select p.%3$I from %4$s p where p.organization_id = $1) and r.organization_id is distinct from $1',
                         c.child, v_col, v_pcol, c.parent) into v_n using p_org;
        end if;
      else
        execute format('select count(*) from %1$s r where r.%2$I in (select p.%3$I from %4$s p where p.organization_id = $1)',
                       c.child, v_col, v_pcol, c.parent) into v_n using p_org;
      end if;
      if v_n > 0 then
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'DEPENDENCY', 'table', c.child_name, 'column', v_col,
          'references', c.parent_name, 'count', v_n,
          'message', format('%s record(s) in %s.%s still reference %s; they cannot be preserved if the reset runs.', v_n, c.child_name, v_col, c.parent_name)));
      end if;
    end loop;

    -- Payroll already posted to the General Ledger.
    if to_regclass('public.hr_payroll_runs') is not null then
      execute $q$
        select count(*) from public.hr_payroll_runs r
        where r.organization_id = $1
          and (nullif(to_jsonb(r)->>'gl_journal_id', '') is not null
               or nullif(to_jsonb(r)->>'gl_reversal_journal_id', '') is not null
               or nullif(to_jsonb(r)->>'gl_posted_at', '') is not null
               or coalesce(to_jsonb(r)->>'gl_status', '') ~* '^(posted|reversed|partially)')$q$
        into v_n using p_org;
      if v_n > 0 then
        v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'FINANCE_POSTED', 'table', 'hr_payroll_runs', 'count', v_n,
          'message', format('%s payroll run(s) were posted to the General Ledger. Reverse them in Finance first.', v_n)));
      end if;
    end if;
    if cardinality(v_ids) > 0 then
      if to_regclass('public.hr_gl_postings') is not null then
        execute 'select count(*) from public.hr_gl_postings g where g.document_id::text = any($1)' into v_n using v_ids;
        if v_n > 0 then
          v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'FINANCE_POSTED', 'table', 'hr_gl_postings', 'count', v_n,
            'message', format('%s HR document(s) in scope have General Ledger postings.', v_n)));
        end if;
      end if;
      if to_regclass('public.gl_document_postings') is not null then
        execute 'select count(*) from public.gl_document_postings g where g.document_id::text = any($1)' into v_n using v_ids;
        if v_n > 0 then
          v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('code', 'FINANCE_POSTED', 'table', 'gl_document_postings', 'count', v_n,
            'message', format('%s HR document(s) in scope have Finance document postings.', v_n)));
        end if;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'organization', jsonb_build_object('id', v_org.id, 'name', v_org.org_name, 'code', v_org.org_code),
    'kind', p_kind,
    'onboarding', jsonb_build_object('to_reset', v_onb_completed, 'already_awaiting', v_onb_awaiting),
    'delete', v_delete,
    'delete_total', v_total,
    'not_present', v_absent,
    'keep', v_keep,
    'blockers', v_blockers,
    'warnings', v_warnings,
    'confirmation_phrase', case when p_kind = 'full' then 'RESET ALL HR DATA ' else 'RESET ONBOARDING ' end
                           || upper(coalesce(nullif(btrim(v_org.org_code), ''), left(v_org.id::text, 8))),
    'preview_token', md5(p_org::text || '|' || p_kind || '|' || v_onb_hash || '|' || v_hashes || '|' || v_blockers::text));
end $fn$;
revoke all on function public.hr_reset_plan(uuid,text) from public, anon, authenticated, service_role;

-- Preview (authorized). Returns the plan plus the actor's eligibility.
create or replace function public.hr_reset_preview(p_actor uuid, p_org uuid, p_kind text)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
begin
  perform public.hr_reset_authorize(p_actor, p_org);
  return public.hr_reset_plan(p_org, p_kind)
    || jsonb_build_object('generated_at', now(),
         'preserved', jsonb_build_array(
           'Login accounts (auth.users), central user identities, credentials, email and phone',
           'Organization membership, Security & Access roles and all non-HR access',
           'Employment records, employee numbers and employee profiles',
           'Department, position and reporting-line projections used by other modules',
           'Employment status (a reset is not a resignation, termination or suspension)',
           'Supply Chain, RoadTour, QR, Finance and other module history',
           'HR configuration: departments, positions, holidays, workweek, leave types, approval rules, salary and allowance/deduction setup'));
end $fn$;
revoke all on function public.hr_reset_preview(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.hr_reset_preview(uuid,uuid,text) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Execution (one transaction; snapshot → delete → onboarding reset)
-- ---------------------------------------------------------------------------
create or replace function public.hr_reset_execute(
  p_actor uuid, p_org uuid, p_kind text, p_request_id uuid, p_preview_token text, p_reason text, p_confirmation text)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_plan jsonb;
  v_existing record;
  v_run uuid;
  d jsonb;
  v_reg regclass;
  v_expected bigint;
  v_snap bigint;
  v_deleted bigint;
  v_snap_total bigint := 0;
  v_onb integer := 0;
  v_counts jsonb := '{}'::jsonb;
begin
  if p_request_id is null then raise exception 'hr_reset_request_id_required' using errcode = '22023'; end if;
  perform public.hr_reset_authorize(p_actor, p_org);

  -- Double submission: the same request returns its recorded outcome.
  select * into v_existing from public.hr_reset_runs where request_id = p_request_id;
  if found then
    return jsonb_build_object('status', v_existing.status, 'replayed', true, 'run_id', v_existing.id,
                              'counts', v_existing.counts, 'onboarding_reset', v_existing.onboarding_reset,
                              'blockers', v_existing.blockers);
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'hr_reset_reason_required' using errcode = '22023';
  end if;

  -- One reset per organization at a time.
  perform pg_advisory_xact_lock(hashtextextended('hr_reset:' || p_org::text, 0));
  select * into v_existing from public.hr_reset_runs where request_id = p_request_id;
  if found then
    return jsonb_build_object('status', v_existing.status, 'replayed', true, 'run_id', v_existing.id,
                              'counts', v_existing.counts, 'onboarding_reset', v_existing.onboarding_reset,
                              'blockers', v_existing.blockers);
  end if;

  -- Freeze in-scope data for the rest of the transaction.
  lock table public.hr_employees in share row exclusive mode;
  if p_kind = 'full' then
    for d in select x from jsonb_array_elements(public.hr_reset_plan(p_org, p_kind)->'delete') x loop
      execute format('lock table public.%I in share row exclusive mode', d->>'table');
    end loop;
  end if;

  v_plan := public.hr_reset_plan(p_org, p_kind);
  if p_confirmation is distinct from v_plan->>'confirmation_phrase' then
    raise exception 'hr_reset_confirmation_mismatch' using errcode = '22023';
  end if;
  if p_preview_token is distinct from v_plan->>'preview_token' then
    return jsonb_build_object('status', 'stale', 'message', 'The data changed since the preview. Review the new preview before resetting.');
  end if;

  if jsonb_array_length(v_plan->'blockers') > 0 then
    insert into public.hr_reset_runs(request_id, organization_id, organization_name, kind, status, actor_id, reason, confirmation,
                                     preview_token, blockers)
    values (p_request_id, p_org, v_plan->'organization'->>'name', p_kind, 'blocked', p_actor, btrim(p_reason), p_confirmation,
            p_preview_token, v_plan->'blockers')
    returning id into v_run;
    return jsonb_build_object('status', 'blocked', 'run_id', v_run, 'blockers', v_plan->'blockers');
  end if;

  for d in select x from jsonb_array_elements(v_plan->'delete') x loop
    v_counts := v_counts || jsonb_build_object(d->>'table', (d->>'count')::bigint);
  end loop;

  insert into public.hr_reset_runs(request_id, organization_id, organization_name, kind, status, actor_id, reason, confirmation,
                                   preview_token, counts, onboarding_reset, snapshot_rows)
  values (p_request_id, p_org, v_plan->'organization'->>'name', p_kind, 'completed', p_actor, btrim(p_reason), p_confirmation,
          p_preview_token, v_counts, (v_plan->'onboarding'->>'to_reset')::integer,
          (v_plan->>'delete_total')::integer + (v_plan->'onboarding'->>'to_reset')::integer)
  returning id into v_run;

  -- Snapshot first. Any failure here aborts the whole transaction.
  insert into public.hr_reset_snapshots(run_id, table_name, row_id, row_data)
  select v_run, 'hr_employees', e.id::text, to_jsonb(e)
  from public.hr_employees e where e.organization_id = p_org and e.onboarding_status = 'completed';
  get diagnostics v_snap = row_count;
  if v_snap <> (v_plan->'onboarding'->>'to_reset')::bigint then
    raise exception 'hr_reset_snapshot_incomplete' using errcode = 'P0001', detail = 'hr_employees';
  end if;
  v_snap_total := v_snap;

  for d in select x from jsonb_array_elements(v_plan->'delete') x order by (x->>'order')::integer loop
    v_reg := to_regclass('public.' || (d->>'table'));
    v_expected := (d->>'count')::bigint;
    execute format('insert into public.hr_reset_snapshots(run_id, table_name, row_id, row_data) select $1, %L, t.id::text, to_jsonb(t) from %s t where t.organization_id = $2',
                   d->>'table', v_reg) using v_run, p_org;
    get diagnostics v_snap = row_count;
    if v_snap <> v_expected then
      raise exception 'hr_reset_snapshot_incomplete' using errcode = 'P0001', detail = d->>'table';
    end if;
    v_snap_total := v_snap_total + v_snap;
  end loop;

  -- Delete (children first), each count must match its snapshot.
  for d in select x from jsonb_array_elements(v_plan->'delete') x order by (x->>'order')::integer loop
    v_reg := to_regclass('public.' || (d->>'table'));
    execute format('delete from %s t where t.organization_id = $1', v_reg) using p_org;
    get diagnostics v_deleted = row_count;
    if v_deleted <> (d->>'count')::bigint then
      raise exception 'hr_reset_count_mismatch' using errcode = 'P0001',
        detail = format('%s: expected %s, deleted %s', d->>'table', d->>'count', v_deleted);
    end if;
  end loop;

  -- Onboarding reset: registration only; identity, access and employment facts stay.
  perform set_config('hr.onboarding_write', 'on', true);
  with changed as (
    update public.hr_employees e set
      onboarding_status = 'reset', onboarding_reset_at = now(), onboarding_reset_by = p_actor, onboarding_reset_run_id = v_run
    where e.organization_id = p_org and e.onboarding_status = 'completed'
    returning e.id, e.user_id
  ), logged as (
    insert into public.hr_employee_onboarding_log(organization_id, user_id, employment_id, event, previous_status, new_status, actor_id, reset_run_id)
    select p_org, c.user_id, c.id, 'reset', 'completed', 'reset', p_actor, v_run from changed c
    returning 1
  )
  select count(*) into v_onb from logged;
  perform set_config('hr.onboarding_write', 'off', true);
  if v_onb <> (v_plan->'onboarding'->>'to_reset')::integer then
    raise exception 'hr_reset_count_mismatch' using errcode = 'P0001', detail = 'hr_employees onboarding';
  end if;

  if v_snap_total <> (v_plan->>'delete_total')::bigint + v_onb then
    raise exception 'hr_reset_snapshot_incomplete' using errcode = 'P0001', detail = 'total';
  end if;

  return jsonb_build_object('status', 'completed', 'run_id', v_run, 'counts', v_counts,
                            'onboarding_reset', v_onb, 'snapshot_rows', v_snap_total);
end $fn$;
revoke all on function public.hr_reset_execute(uuid,uuid,text,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.hr_reset_execute(uuid,uuid,text,uuid,text,text,text) to service_role;

-- ---------------------------------------------------------------------------
-- 11. Restore a reset from its snapshot (owner/ops; same authorization)
-- ---------------------------------------------------------------------------
create or replace function public.hr_reset_restore(p_actor uuid, p_run_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_run record;
  t record;
  v_reg regclass;
  v_cols text;
  v_n bigint;
  v_rows bigint := 0;
  v_onb integer := 0;
begin
  select * into v_run from public.hr_reset_runs where id = p_run_id;
  if not found or v_run.status <> 'completed' then raise exception 'hr_reset_run_not_restorable' using errcode = '22023'; end if;
  perform public.hr_reset_authorize(p_actor, v_run.organization_id);
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'hr_reset_reason_required' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('hr_reset:' || v_run.organization_id::text, 0));
  if exists (select 1 from public.hr_reset_restorations where run_id = p_run_id) then
    raise exception 'hr_reset_already_restored' using errcode = '22023';
  end if;

  perform set_config('hr.reset_restore', p_run_id::text, true);
  -- Parents before children (reverse of the delete order).
  for t in
    select distinct s.table_name, sc.delete_order from public.hr_reset_snapshots s
    join public.hr_reset_scope sc on sc.table_name = s.table_name
    where s.run_id = p_run_id and s.table_name <> 'hr_employees'
    order by sc.delete_order desc
  loop
    v_reg := to_regclass('public.' || t.table_name);
    if v_reg is null then raise exception 'hr_reset_restore_table_missing' using errcode = 'P0001', detail = t.table_name; end if;
    select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
    from pg_attribute a where a.attrelid = v_reg and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';
    execute format('insert into %1$s (%2$s) overriding system value select %2$s from jsonb_populate_recordset(null::%1$s, (select jsonb_agg(s.row_data) from public.hr_reset_snapshots s where s.run_id = $1 and s.table_name = %3$L))',
                   v_reg, v_cols, t.table_name) using p_run_id;
    get diagnostics v_n = row_count;
    v_rows := v_rows + v_n;
  end loop;
  perform set_config('hr.reset_restore', '', true);

  -- Onboarding: only records still reset by this run (re-onboarded ones stay).
  perform set_config('hr.onboarding_write', 'on', true);
  with restored as (
    update public.hr_employees e set
      onboarding_status = s.row_data->>'onboarding_status',
      onboarding_source = s.row_data->>'onboarding_source',
      onboarded_at = nullif(s.row_data->>'onboarded_at', '')::timestamptz,
      onboarded_by = nullif(s.row_data->>'onboarded_by', '')::uuid,
      onboarding_reset_at = nullif(s.row_data->>'onboarding_reset_at', '')::timestamptz,
      onboarding_reset_by = nullif(s.row_data->>'onboarding_reset_by', '')::uuid,
      onboarding_reset_run_id = nullif(s.row_data->>'onboarding_reset_run_id', '')::uuid,
      hire_date_confirmed = coalesce((s.row_data->>'hire_date_confirmed')::boolean, false)
    from public.hr_reset_snapshots s
    where s.run_id = p_run_id and s.table_name = 'hr_employees' and s.row_id = e.id::text
      and e.onboarding_status = 'reset' and e.onboarding_reset_run_id = p_run_id
    returning e.id, e.user_id, e.organization_id
  ), logged as (
    insert into public.hr_employee_onboarding_log(organization_id, user_id, employment_id, event, previous_status, new_status, actor_id, reset_run_id)
    select r.organization_id, r.user_id, r.id, 'restored', 'reset', 'completed', p_actor, p_run_id from restored r
    returning 1
  )
  select count(*) into v_onb from logged;
  perform set_config('hr.onboarding_write', 'off', true);

  insert into public.hr_reset_restorations(run_id, actor_id, reason, restored_rows, restored_onboarding)
  values (p_run_id, p_actor, btrim(p_reason), v_rows, v_onb);
  return jsonb_build_object('status', 'restored', 'run_id', p_run_id, 'restored_rows', v_rows, 'restored_onboarding', v_onb);
end $fn$;
revoke all on function public.hr_reset_restore(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.hr_reset_restore(uuid,uuid,text) to service_role;

-- One-way go-live (Super Admin + HR settings).
create or replace function public.hr_mark_go_live(p_actor uuid, p_org uuid, p_note text)
returns text language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $fn$
begin
  if not public.sa_legacy_is_super_admin(p_actor) then raise exception 'hr_reset_requires_super_admin' using errcode = '42501'; end if;
  perform public.sa_assert_actor_permission(p_actor, 'hr.settings.manage', jsonb_build_object('organization_id', p_org), true);
  insert into public.hr_go_live_state(organization_id, phase, changed_at, changed_by, note)
  values (p_org, 'live', now(), p_actor, p_note)
  on conflict (organization_id) do update set phase = 'live', changed_at = now(), changed_by = p_actor, note = excluded.note
  where public.hr_go_live_state.phase <> 'live';
  return 'live';
end $fn$;
revoke all on function public.hr_mark_go_live(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.hr_mark_go_live(uuid,uuid,text) to service_role;

-- ---------------------------------------------------------------------------
-- 12. HR onboarding (Add Employee) — one central identity
-- ---------------------------------------------------------------------------
create or replace function public.hr_mask_email(p_email text)
returns text language sql immutable set search_path = pg_catalog, pg_temp as $fn$
  select case when p_email is null or position('@' in p_email) = 0 then null
              else left(split_part(p_email, '@', 1), 2) || '***@' || split_part(p_email, '@', 2) end
$fn$;
create or replace function public.hr_mask_phone(p_phone text)
returns text language sql immutable set search_path = pg_catalog, pg_temp as $fn$
  select case when p_phone is null or length(p_phone) < 5 then null
              else left(p_phone, 4) || repeat('•', greatest(length(p_phone) - 7, 1)) || right(p_phone, 3) end
$fn$;
revoke all on function public.hr_mask_email(text) from public, anon;
revoke all on function public.hr_mask_phone(text) from public, anon;

-- Minimal, authorized preview of one identity for HR onboarding.
create or replace function public.hr_onboarding_candidate(p_actor uuid, p_org uuid, p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  u record;
  e record;
  v_block text;
begin
  perform public.sa_assert_actor_permission(p_actor, 'hr.employee.manage', jsonb_build_object('organization_id', p_org),
                                            public.identity_legacy_hr_admin(p_actor));
  select pu.id, pu.full_name, pu.email, pu.phone, pu.principal_type, pu.account_status, pu.organization_id,
         (select o.org_name from public.organizations o where o.id = pu.organization_id) as org_name,
         exists (select 1 from auth.users au where au.id = pu.id) as has_login
    into u from public.users pu where pu.id = p_user;
  if not found then return jsonb_build_object('found', false); end if;
  select x.id, x.employee_no, x.onboarding_status, x.status, x.hire_date, x.hire_date_confirmed,
         x.department_id, x.position_id, x.manager_user_id, x.employment_type
    into e from public.hr_employees x where x.user_id = p_user and x.organization_id = p_org;

  v_block := case
    when u.account_status = 'ARCHIVED' then 'IDENTITY_ARCHIVED'
    when u.account_status not in ('ACTIVE','INVITED') then 'IDENTITY_INACTIVE'
    when u.principal_type = 'CONSUMER' then 'IDENTITY_PRINCIPAL_UPGRADE_REQUIRED'
    when u.organization_id is distinct from p_org then 'IDENTITY_ORG_MOVE_REQUIRED'
    when u.principal_type <> 'INTERNAL_EMPLOYEE' then 'IDENTITY_NOT_INTERNAL_EMPLOYEE'
    when e.status in ('resigned','terminated') then 'EMPLOYMENT_ENDED'
    when u.id = p_actor then 'SELF_ONBOARDING'
  end;

  return jsonb_build_object(
    'found', true,
    'user_id', u.id,
    'full_name', u.full_name,
    'email_masked', public.hr_mask_email(u.email),
    'phone_masked', public.hr_mask_phone(u.phone),
    'principal_type', u.principal_type,
    'account_status', u.account_status,
    'same_organization', u.organization_id is not distinct from p_org,
    -- Another organization's name is not disclosed to this HR administrator.
    'organization_name', case when u.organization_id is not distinct from p_org then u.org_name end,
    'has_login', u.has_login,
    'employment', case when e.id is null then null else jsonb_build_object(
       'employee_no', e.employee_no, 'onboarding_status', e.onboarding_status, 'employment_status', e.status,
       'hire_date', case when e.hire_date_confirmed then e.hire_date end, 'hire_date_confirmed', e.hire_date_confirmed,
       'department_id', e.department_id, 'position_id', e.position_id, 'manager_user_id', e.manager_user_id,
       'employment_type', e.employment_type) end,
    'block_code', v_block,
    'eligible', v_block is null);
end $fn$;
revoke all on function public.hr_onboarding_candidate(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.hr_onboarding_candidate(uuid,uuid,uuid) to service_role;

-- Name search helps selection only (never an identity-match key).
create or replace function public.hr_onboarding_search(p_actor uuid, p_org uuid, p_query text)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_q text := btrim(coalesce(p_query, ''));
begin
  perform public.sa_assert_actor_permission(p_actor, 'hr.employee.manage', jsonb_build_object('organization_id', p_org),
                                            public.identity_legacy_hr_admin(p_actor));
  if length(v_q) < 2 then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(x order by x->>'full_name') from (
      select jsonb_build_object('user_id', u.id, 'full_name', u.full_name, 'email_masked', public.hr_mask_email(u.email),
                                'employee_no', e.employee_no, 'onboarding_status', coalesce(e.onboarding_status, 'pending')) as x
      from public.users u
      left join public.hr_employees e on e.user_id = u.id and e.organization_id = p_org
      where u.organization_id = p_org and u.principal_type = 'INTERNAL_EMPLOYEE' and u.account_status in ('ACTIVE','INVITED')
        and u.full_name ilike '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      order by u.full_name limit 20) s), '[]'::jsonb);
end $fn$;
revoke all on function public.hr_onboarding_search(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.hr_onboarding_search(uuid,uuid,text) to service_role;

-- Complete HR onboarding for an existing central identity (same organization).
-- p_payload: organization_id, department_id, position_id, manager_user_id,
--            employment_type, hire_date (required).
create or replace function public.hr_onboarding_complete(p_actor uuid, p_user uuid, p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_org uuid := nullif(p_payload->>'organization_id', '')::uuid;
  v_dept uuid := nullif(p_payload->>'department_id', '')::uuid;
  v_pos uuid := nullif(p_payload->>'position_id', '')::uuid;
  v_mgr uuid := nullif(p_payload->>'manager_user_id', '')::uuid;
  v_type text := nullif(p_payload->>'employment_type', '');
  v_hire date := nullif(p_payload->>'hire_date', '')::date;
  u record;
  e record;
  v_has_record boolean;
  v_prev text;
begin
  if p_actor is null or p_user is null or v_org is null then raise exception 'hr_onboarding_input_required' using errcode = '22023'; end if;
  perform public.sa_assert_actor_permission(p_actor, 'hr.employee.manage', jsonb_build_object('organization_id', v_org),
                                            public.identity_legacy_hr_admin(p_actor));
  if p_actor = p_user then raise exception 'hr_onboarding_self_prohibited' using errcode = '42501'; end if;
  if v_hire is null then raise exception 'hr_onboarding_hire_date_required' using errcode = '22023'; end if;
  if v_hire > current_date + 366 then raise exception 'hr_onboarding_hire_date_invalid' using errcode = '22023'; end if;
  if v_type is not null and v_type not in ('Full-time','Part-time','Contract','Intern') then
    raise exception 'hr_onboarding_employment_type_invalid' using errcode = '22023';
  end if;

  select pu.id, pu.principal_type, pu.account_status, pu.organization_id into u
  from public.users pu where pu.id = p_user for update;
  if not found then raise exception 'hr_onboarding_identity_unknown' using errcode = '22023'; end if;
  if u.account_status = 'ARCHIVED' then raise exception 'identity_archived' using errcode = '22023'; end if;
  if u.account_status not in ('ACTIVE','INVITED') then raise exception 'identity_inactive' using errcode = '22023'; end if;
  if u.principal_type = 'CONSUMER' then raise exception 'identity_principal_upgrade_required' using errcode = '22023'; end if;
  if u.organization_id is distinct from v_org then raise exception 'identity_org_move_required' using errcode = '22023'; end if;
  if u.principal_type <> 'INTERNAL_EMPLOYEE' then raise exception 'identity_not_internal_employee' using errcode = '22023'; end if;

  if (v_dept is not null and not exists (select 1 from public.departments d where d.id = v_dept and d.organization_id = v_org))
     or (v_pos is not null and not exists (select 1 from public.hr_positions p where p.id = v_pos and p.organization_id = v_org))
     or (v_mgr is not null and (v_mgr = p_user or not exists (select 1 from public.users m where m.id = v_mgr and m.organization_id = v_org))) then
    raise exception 'identity_hr_reference_outside_organization' using errcode = '22023';
  end if;

  select * into e from public.hr_employees x where x.user_id = p_user and x.organization_id = v_org for update;
  v_has_record := found;
  if v_has_record and e.onboarding_status = 'completed' then
    insert into public.hr_employee_onboarding_log(organization_id, user_id, employment_id, event, previous_status, new_status, actor_id)
    values (v_org, p_user, e.id, 'already_completed', 'completed', 'completed', p_actor);
    return jsonb_build_object('status', 'ok', 'outcome', 'ALREADY_ONBOARDED', 'user_id', p_user,
                              'employment_id', e.id, 'employee_no', e.employee_no);
  end if;
  if v_has_record and e.status in ('resigned','terminated') then
    raise exception 'hr_employment_ended' using errcode = '22023',
      hint = 'A former employee is re-hired through the employment lifecycle, not onboarding.';
  end if;

  perform set_config('hr.onboarding_write', 'on', true);
  if not v_has_record then
    -- The anchor normally exists (auto-created); create it if a legacy identity lacks it.
    insert into public.hr_employees (user_id, organization_id, hire_date, status, department_id, position_id, manager_user_id,
                                     employment_type, onboarding_status, onboarding_source, onboarded_at, onboarded_by, hire_date_confirmed)
    values (p_user, v_org, v_hire, 'active', v_dept, v_pos, v_mgr, v_type, 'completed', 'hr_onboarding', now(), p_actor, true)
    returning * into e;
    v_prev := null;
  else
    v_prev := e.onboarding_status;
    update public.hr_employees x set
      department_id = v_dept, position_id = v_pos, manager_user_id = v_mgr, employment_type = v_type,
      hire_date = v_hire, hire_date_confirmed = true,
      onboarding_status = 'completed', onboarding_source = 'hr_onboarding', onboarded_at = now(), onboarded_by = p_actor,
      updated_at = now()
    where x.id = e.id
    returning * into e;
  end if;
  perform set_config('hr.onboarding_write', 'off', true);

  insert into public.hr_employee_onboarding_log(organization_id, user_id, employment_id, event, previous_status, new_status, actor_id, details)
  values (v_org, p_user, e.id, 'completed', v_prev, 'completed', p_actor,
          jsonb_build_object('department_id', v_dept, 'position_id', v_pos, 'manager_user_id', v_mgr,
                             'employment_type', v_type, 'hire_date', v_hire, 'source', nullif(p_payload->>'source', '')));

  return jsonb_build_object('status', 'ok', 'outcome', case when v_prev = 'reset' then 'REONBOARDED' else 'ONBOARDED' end,
                            'user_id', p_user, 'employment_id', e.id, 'employee_no', e.employee_no);
end $fn$;
revoke all on function public.hr_onboarding_complete(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.hr_onboarding_complete(uuid,uuid,jsonb) to service_role;

-- Own onboarding state (ESS). Read through the trusted server.
create or replace function public.hr_onboarding_state(p_user uuid, p_org uuid)
returns text language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select coalesce((select e.onboarding_status from public.hr_employees e where e.user_id = p_user and e.organization_id = p_org), 'none')
$fn$;
revoke all on function public.hr_onboarding_state(uuid,uuid) from public, anon, authenticated;
grant execute on function public.hr_onboarding_state(uuid,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 13. Post-conditions
-- ---------------------------------------------------------------------------
do $post$
declare v_bad integer;
begin
  select count(*) into v_bad from public.hr_employees where onboarding_status is null;
  if v_bad > 0 then raise exception 'postcondition: % employment records without onboarding state', v_bad; end if;

  select count(*) into v_bad from public.hr_reset_scope s
  where s.action = 'delete' and s.table_name in ('hr_employees','users','departments','hr_positions','hr_leave_types','hr_public_holidays',
                                                 'hr_approval_chains','hr_salary_bands','hr_allowance_types','hr_deduction_types',
                                                 'organizations','gl_journals','gl_accounts');
  if v_bad > 0 then raise exception 'postcondition: configuration or identity tables must never be in the reset allowlist'; end if;

  select count(*) into v_bad from public.hr_reset_scope s where s.action = 'delete' and s.table_name not like 'hr\_%';
  if v_bad > 0 then raise exception 'postcondition: reset allowlist may contain HR tables only'; end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in ('hr_reset_plan','hr_reset_preview','hr_reset_execute','hr_reset_restore','hr_reset_authorize','hr_reset_actor_check',
                                 'hr_onboarding_complete','hr_onboarding_candidate','hr_onboarding_search','hr_onboarding_state','hr_mark_go_live',
                                 'hr_require_onboarded_employee','hr_employees_onboarding_guard')
               and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))) then
    raise exception 'postcondition: HR onboarding/reset functions must not be executable by API roles';
  end if;
  if has_table_privilege('authenticated', 'public.hr_reset_snapshots', 'SELECT')
     or has_table_privilege('service_role', 'public.hr_reset_snapshots', 'SELECT') then
    raise exception 'postcondition: reset snapshots must not be readable by API roles';
  end if;
  if (select mode from public.sa_migration_modes where permission_key = 'hr.data.reset') is distinct from 'SHADOW' then
    raise exception 'postcondition: hr.data.reset must be seeded SHADOW (the database always requires an explicit grant)';
  end if;
  if exists (select 1 from public.sa_role_assignments a join public.sa_business_roles br on br.id = a.role_id
             where br.role_key = 'hr-data-reset-administrator' and a.source = 'backfill') then
    raise exception 'postcondition: hr.data.reset must never be backfilled';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'hr_employees_onboarding_guard' and tgrelid = 'public.hr_employees'::regclass) then
    raise exception 'postcondition: onboarding guard trigger missing';
  end if;
end
$post$;
