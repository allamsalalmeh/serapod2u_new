-- ============================================================================
-- HR Position Management V1.1 — hr05: Position History, Audit & Permissions
-- ----------------------------------------------------------------------------
-- NOT APPLIED. Apply after 20261210130000_hr04_position_change_approval.sql.
--
-- Adds:
--   1. hr_position_versions     — effective-dated position versions (history).
--   2. hr_position_audit_events — immutable audit trail.
--   3. hr_position_org_chart()  — multi-root, as-of-date position hierarchy RPC.
--   4. Optional reconciliation backfill — maps legacy hr_positions (job titles)
--      into hr_job_classifications idempotently. NOT executed here; see tail.
--
-- Validated against PostgreSQL 17. Creates NO business data (the backfill is a
-- commented manual step).
-- ============================================================================

do $pre$
begin
  if to_regclass('public.hr_position_slots') is null then
    raise exception 'hr05_prerequisite_missing: apply hr01 first (public.hr_position_slots)';
  end if;
  if to_regclass('public.hr_position_change_requests') is null then
    raise exception 'hr05_prerequisite_missing: apply hr04 first (public.hr_position_change_requests)';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Position Versions (historical)
-- ---------------------------------------------------------------------------
create table if not exists public.hr_position_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  position_id uuid not null,
  version_no integer not null,
  effective_from date not null,
  effective_to date,
  name text not null,
  org_tier text,
  lifecycle_status text not null default 'active',
  change_reason text,
  change_request_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint hr_position_versions_effective_check check (effective_to is null or effective_to >= effective_from),
  constraint hr_position_versions_position_fk
    foreign key (position_id) references public.hr_position_slots (id) on delete cascade,
  constraint hr_position_versions_request_fk
    foreign key (change_request_id) references public.hr_position_change_requests (id) on delete set null
);

create index if not exists hr_position_versions_position_idx on public.hr_position_versions (position_id, effective_from);
create index if not exists hr_position_versions_org_idx on public.hr_position_versions (organization_id);

-- ---------------------------------------------------------------------------
-- 2. Audit events (immutable)
-- ---------------------------------------------------------------------------
create table if not exists public.hr_position_audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  actor_user_id uuid,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

create index if not exists hr_position_audit_entity_idx on public.hr_position_audit_events (entity_type, entity_id);
create index if not exists hr_position_audit_org_idx on public.hr_position_audit_events (organization_id, created_at);

alter table public.hr_position_versions enable row level security;
alter table public.hr_position_audit_events enable row level security;

drop policy if exists hr_position_versions_select on public.hr_position_versions;
create policy hr_position_versions_select on public.hr_position_versions
  for select to authenticated
  using (organization_id = public.hr_position_actor_org());

drop policy if exists hr_position_versions_write on public.hr_position_versions;
create policy hr_position_versions_write on public.hr_position_versions
  for all to authenticated using (false) with check (false);

drop policy if exists hr_position_audit_select on public.hr_position_audit_events;
create policy hr_position_audit_select on public.hr_position_audit_events
  for select to authenticated
  using (organization_id = public.hr_position_actor_org());

drop policy if exists hr_position_audit_write on public.hr_position_audit_events;
create policy hr_position_audit_write on public.hr_position_audit_events
  for all to authenticated using (false) with check (false);


-- ---------------------------------------------------------------------------
-- 3. Multi-root, as-of-date position org chart
-- ---------------------------------------------------------------------------
create or replace function public.hr_position_org_chart(
  p_organization_id uuid,
  p_as_of date default current_date
) returns table (
  id uuid,
  position_code text,
  name text,
  job_classification_id uuid,
  job_classification_name text,
  department_id uuid,
  business_unit text,
  org_tier text,
  lifecycle_status text,
  parent_position_id uuid,
  relationship_type text,
  incumbent_user_id uuid,
  incumbent_name text,
  occupancy text,
  depth integer,
  path uuid[]
) language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  return query
  with rel as (
    select
      r.position_id,
      r.parent_position_id,
      r.relationship_type
    from public.hr_position_relationships r
    where r.organization_id = p_organization_id
      and r.is_active = true
      and r.effective_from <= p_as_of
      and (r.effective_to is null or r.effective_to >= p_as_of)
  ),
  current_assign as (
    select distinct on (a.position_id)
      a.position_id,
      a.employee_user_id,
      u.full_name
    from public.hr_position_assignments a
    join public.users u on u.id = a.employee_user_id
    where a.organization_id = p_organization_id
      and a.status = 'active'
      and a.assignment_type = 'PRIMARY'
      and a.effective_from <= p_as_of
      and (a.effective_to is null or a.effective_to >= p_as_of)
    order by a.position_id, a.effective_from desc
  ),
  rec as (
    select
      s.id, s.position_code, s.name, s.job_classification_id, jc.name as job_classification_name,
      s.department_id, s.business_unit, s.org_tier, s.lifecycle_status,
      rel.parent_position_id, rel.relationship_type,
      ca.employee_user_id as incumbent_user_id, ca.full_name as incumbent_name,
      case when ca.employee_user_id is null then 'VACANT' else 'FILLED' end as occupancy,
      0 as depth,
      array[s.id]::uuid[] as path
    from public.hr_position_slots s
    left join rel on rel.position_id = s.id and rel.relationship_type = 'PRIMARY'
    left join public.hr_job_classifications jc on jc.id = s.job_classification_id
    left join current_assign ca on ca.position_id = s.id
    where s.organization_id = p_organization_id
      and s.is_active = true
      and rel.parent_position_id is null

    union all

    select
      s.id, s.position_code, s.name, s.job_classification_id, jc.name as job_classification_name,
      s.department_id, s.business_unit, s.org_tier, s.lifecycle_status,
      rel.parent_position_id, rel.relationship_type,
      ca.employee_user_id as incumbent_user_id, ca.full_name as incumbent_name,
      case when ca.employee_user_id is null then 'VACANT' else 'FILLED' end as occupancy,
      rec.depth + 1,
      rec.path || s.id
    from public.hr_position_slots s
    join rel on rel.position_id = s.id and rel.relationship_type = 'PRIMARY'
    join rec on rec.id = rel.parent_position_id
    left join public.hr_job_classifications jc on jc.id = s.job_classification_id
    left join current_assign ca on ca.position_id = s.id
    where s.organization_id = p_organization_id
      and s.is_active = true
      and not (s.id = any(rec.path))
  )
  select * from rec
  order by path;
end $$;
revoke all on function public.hr_position_org_chart(uuid, date) from public, anon;
grant execute on function public.hr_position_org_chart(uuid, date) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. Optional reconciliation backfill (MANUAL STEP — do not run automatically)
-- ---------------------------------------------------------------------------
-- Maps legacy hr_positions (job-title catalog) into hr_job_classifications so an
-- organization can adopt the position-centric model without re-keying its job
-- titles. Idempotent; never fabricates dates; does not touch incumbents.
--
-- To run (staging first), execute manually:
--   insert into public.hr_job_classifications (organization_id, code, name, family, job_grade, is_active)
--   select p.organization_id,
--          p.code,
--          p.name,
--          coalesce(p.category, 'Uncategorized'),
--          null,
--          p.is_active
--   from public.hr_positions p
--   on conflict (organization_id, code) do update
--     set name = excluded.name,
--         family = excluded.family,
--         is_active = excluded.is_active,
--         updated_at = now();
--
-- Reconciliation report:
--   select p.organization_id,
--          count(*) filter (where jc.id is not null) as mapped,
--          count(*) filter (where jc.id is null)     as unmapped
--   from public.hr_positions p
--   left join public.hr_job_classifications jc
--     on jc.organization_id = p.organization_id and jc.code = p.code
--   group by p.organization_id;

-- Rollback: drop function hr_position_org_chart(uuid,date); drop table
-- hr_position_audit_events; drop table hr_position_versions;
