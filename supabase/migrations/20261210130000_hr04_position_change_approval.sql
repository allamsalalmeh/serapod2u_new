-- ============================================================================
-- HR Position Management V1.1 — hr04: Position Change Requests + Approval Steps
-- ----------------------------------------------------------------------------
-- NOT APPLIED. Apply after 20261210120000_hr03_position_assignments.sql.
--
-- Approval-governed structural changes. Workflow states:
--   draft -> pending -> approved -> scheduled (future) -> effective
--   plus: rejected / returned / cancelled / activation_failed.
--
-- Approvers are SNAPSHOTTED onto approval steps at submit time so a later
-- hierarchy change never silently reroutes an in-flight request. Approval
-- capability and actual approval assignment are both validated at the API layer.
--
-- Validated against PostgreSQL 17. Creates NO business data.
-- ============================================================================

do $pre$
begin
  if to_regclass('public.hr_position_slots') is null then
    raise exception 'hr04_prerequisite_missing: apply hr01 first (public.hr_position_slots)';
  end if;
end $pre$;

create table if not exists public.hr_position_change_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  request_type text not null,
  position_id uuid,
  change_payload jsonb not null default '{}'::jsonb,
  before_snapshot jsonb,
  effective_date date,
  status text not null default 'draft',
  submitted_by uuid,
  submitted_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  activated_at timestamptz,
  activation_error text,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hr_position_change_requests_status_check
    check (status in ('draft','pending','returned','rejected','approved','scheduled','effective','activation_failed','cancelled')),
  constraint hr_position_change_requests_type_check
    check (request_type in ('CREATE_POSITION','UPDATE_POSITION','CHANGE_REPORTING','ASSIGN_EMPLOYEE','REASSIGN_EMPLOYEE','END_ASSIGNMENT','CHANGE_LIFECYCLE')),
  constraint hr_position_change_requests_position_fk
    foreign key (position_id) references public.hr_position_slots (id) on delete cascade
);

create index if not exists hr_position_change_requests_org_idx on public.hr_position_change_requests (organization_id);
create index if not exists hr_position_change_requests_status_idx on public.hr_position_change_requests (organization_id, status);
create index if not exists hr_position_change_requests_position_idx on public.hr_position_change_requests (position_id);

drop trigger if exists hr_position_change_requests_touch on public.hr_position_change_requests;
create trigger hr_position_change_requests_touch before update on public.hr_position_change_requests
  for each row execute function public.hr_position_touch_updated_at();

create table if not exists public.hr_position_approval_steps (
  id uuid primary key default gen_random_uuid(),
  change_request_id uuid not null,
  step_no integer not null,
  approver_type text not null default 'USER',
  approver_ref text,                           -- user id / role code / position id / policy ref
  status text not null default 'pending',
  decision_by uuid,
  decision_at timestamptz,
  comment text,
  created_at timestamptz not null default now(),
  constraint hr_position_approval_steps_type_check check (approver_type in ('USER','ROLE','POSITION','POLICY')),
  constraint hr_position_approval_steps_status_check check (status in ('pending','approved','rejected','returned','skipped')),
  constraint hr_position_approval_steps_request_fk
    foreign key (change_request_id) references public.hr_position_change_requests (id) on delete cascade,
  constraint hr_position_approval_steps_unique_step unique (change_request_id, step_no)
);

create index if not exists hr_position_approval_steps_request_idx on public.hr_position_approval_steps (change_request_id);

alter table public.hr_position_change_requests enable row level security;
alter table public.hr_position_approval_steps enable row level security;

drop policy if exists hr_position_change_requests_select on public.hr_position_change_requests;
create policy hr_position_change_requests_select on public.hr_position_change_requests
  for select to authenticated
  using (organization_id = public.hr_position_actor_org());

drop policy if exists hr_position_change_requests_write on public.hr_position_change_requests;
create policy hr_position_change_requests_write on public.hr_position_change_requests
  for all to authenticated using (false) with check (false);

drop policy if exists hr_position_approval_steps_select on public.hr_position_approval_steps;
create policy hr_position_approval_steps_select on public.hr_position_approval_steps
  for select to authenticated
  using (exists (
    select 1 from public.hr_position_change_requests r
    where r.id = change_request_id
      and r.organization_id = public.hr_position_actor_org()
  ));

drop policy if exists hr_position_approval_steps_write on public.hr_position_approval_steps;
create policy hr_position_approval_steps_write on public.hr_position_approval_steps
  for all to authenticated using (false) with check (false);

-- Rollback: drop table hr_position_approval_steps; drop table hr_position_change_requests;
