-- ============================================================================
-- HR Position Management V1.1 — hr01: Foundation (Job Classifications + Position Master)
-- ----------------------------------------------------------------------------
-- NOT APPLIED. Apply by hand per environment (staging first). Supabase migration
-- naming: YYYYMMDDHHMMSS_hrNN_<description>.sql — first HR sequence number; no
-- prior hrNN migrations exist in the repo.
--
-- Introduces the position-centric data model as ADDITIVE tables only. Nothing drops,
-- renames or backfills existing HR data. Legacy `hr_positions` (flat job-title catalog)
-- is preserved; `hr_job_classifications` becomes the canonical classification and the
-- optional hr05 reconciliation backfill maps legacy titles idempotently.
--
-- Entities:
--   hr_job_classifications  — job classification (title/family shared by many slots)
--   hr_position_slots       — position master (one individual, slot-based position)
--
-- Invariants (SAP EC Position Management reference):
--   * Immutable internal id (uuid pk) + unique business `position_code` per org.
--   * Many slots may share one job classification.
--   * A position exists independently of its incumbent (occupancy tracked in hr03).
--   * Organizational Tier is separate from Job Grade and from S&A level.
--
-- Validated against PostgreSQL 17. Creates NO business data.
-- ============================================================================

do $pre$
begin
  if to_regclass('public.departments') is null then
    raise exception 'hr01_prerequisite_missing: public.departments';
  end if;
  if to_regclass('public.hr_positions') is null then
    raise exception 'hr01_prerequisite_missing: public.hr_positions (legacy job-title catalog)';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- Shared updated_at trigger (idempotent)
-- ---------------------------------------------------------------------------
create or replace function public.hr_position_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- RLS actor-organization helper (used by SELECT policies)
-- ---------------------------------------------------------------------------
create or replace function public.hr_position_actor_org()
returns uuid language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select organization_id from public.users where id = auth.uid();
$$;
revoke all on function public.hr_position_actor_org() from public, anon;
grant execute on function public.hr_position_actor_org() to authenticated, service_role;

-- ============================================================================
-- 1. Job Classifications
-- ============================================================================
create table if not exists public.hr_job_classifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  code text not null,
  name text not null,
  family text,
  job_grade text,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hr_job_classifications_org_code_key unique (organization_id, code)
);

comment on table public.hr_job_classifications is
  'Job classification (job family/title) shared by many position slots. The legacy hr_positions catalog maps onto this via the hr05 reconciliation backfill.';

create index if not exists hr_job_classifications_org_idx on public.hr_job_classifications (organization_id);
create index if not exists hr_job_classifications_family_idx on public.hr_job_classifications (organization_id, family);

drop trigger if exists hr_job_classifications_touch on public.hr_job_classifications;
create trigger hr_job_classifications_touch before update on public.hr_job_classifications
  for each row execute function public.hr_position_touch_updated_at();



-- ============================================================================
-- 2. Position Master (individual position slots)
-- ============================================================================
create table if not exists public.hr_position_slots (
  id uuid primary key default gen_random_uuid(),          -- immutable internal id
  organization_id uuid not null,
  position_code text not null,                            -- unique business identifier per org
  name text not null,
  job_classification_id uuid,
  department_id uuid,
  business_unit text,
  org_tier text not null default 'Unassigned',            -- business rank; NOT a security/access level
  lifecycle_status text not null default 'active',
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hr_position_slots_org_code_key unique (organization_id, position_code),
  constraint hr_position_slots_lifecycle_check check (lifecycle_status in ('active', 'inactive', 'frozen', 'closed')),
  constraint hr_position_slots_code_check check (position_code ~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'),
  constraint hr_position_slots_job_classification_fk
    foreign key (job_classification_id) references public.hr_job_classifications (id) on delete set null,
  constraint hr_position_slots_department_fk
    foreign key (department_id) references public.departments (id) on delete set null
);

comment on table public.hr_position_slots is
  'Position master: one individual slot-based position (e.g. WH-OP-001). Occupancy and lifecycle are tracked separately from the incumbent (hr_position_assignments).';

comment on column public.hr_position_slots.org_tier is
  'Organizational tier (business rank), configurable. Distinct from reporting depth, security/access level, and job grade.';

create index if not exists hr_position_slots_org_idx on public.hr_position_slots (organization_id);
create index if not exists hr_position_slots_jc_idx on public.hr_position_slots (job_classification_id);
create index if not exists hr_position_slots_dept_idx on public.hr_position_slots (department_id);
create index if not exists hr_position_slots_tier_idx on public.hr_position_slots (organization_id, org_tier);
create index if not exists hr_position_slots_lifecycle_idx on public.hr_position_slots (organization_id, lifecycle_status);

drop trigger if exists hr_position_slots_touch on public.hr_position_slots;
create trigger hr_position_slots_touch before update on public.hr_position_slots
  for each row execute function public.hr_position_touch_updated_at();


-- ============================================================================
-- Row Level Security (baseline). Additional-manager scoped visibility is
-- enforced at the API layer for V1 (see hr05 helper predicates).
-- ============================================================================
alter table public.hr_job_classifications enable row level security;
alter table public.hr_position_slots enable row level security;

drop policy if exists hr_job_classifications_select on public.hr_job_classifications;
create policy hr_job_classifications_select on public.hr_job_classifications
  for select to authenticated
  using (organization_id = public.hr_position_actor_org());

drop policy if exists hr_position_slots_select on public.hr_position_slots;
create policy hr_position_slots_select on public.hr_position_slots
  for select to authenticated
  using (organization_id = public.hr_position_actor_org());

-- Writes go through the service role after server-side S&A checks (matching the
-- existing HR profile-change / compensation review pattern).
drop policy if exists hr_job_classifications_write on public.hr_job_classifications;
create policy hr_job_classifications_write on public.hr_job_classifications
  for all to authenticated using (false) with check (false);

drop policy if exists hr_position_slots_write on public.hr_position_slots;
create policy hr_position_slots_write on public.hr_position_slots
  for all to authenticated using (false) with check (false);

do $post$
begin
  if not has_table_privilege('authenticated', 'public.hr_position_slots', 'SELECT') then
    raise exception 'postcondition: authenticated must be able to SELECT position slots (RLS-scoped)';
  end if;
end $post$;
