-- ============================================================================
-- HR Position Management V1.1 — hr03: Position Assignments (employee ↔ slot)
-- ----------------------------------------------------------------------------
-- NOT APPLIED. Apply after 20261210110000_hr02_position_reporting_relationships.sql.
--
-- Effective-dated employee assignments to position slots. V1 rules:
--   * One active PRIMARY position per employee.
--   * Max one active incumbent per position slot.
--   * Assignment start/end dates; history preserved (rows are never deleted,
--     ended assignments set effective_to / status).
--   * Secondary assignments are out of scope for V1 but the column exists so the
--     constraint surface is stable.
--
-- Validated against PostgreSQL 17. Creates NO business data.
-- ============================================================================

do $pre$
begin
  if to_regclass('public.hr_position_slots') is null then
    raise exception 'hr03_prerequisite_missing: apply hr01 first (public.hr_position_slots)';
  end if;
  if to_regclass('public.users') is null then
    raise exception 'hr03_prerequisite_missing: public.users';
  end if;
end $pre$;

create table if not exists public.hr_position_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  position_id uuid not null,
  employee_user_id uuid not null,
  assignment_type text not null default 'PRIMARY',
  effective_from date not null,
  effective_to date,                          -- null => open-ended (current)
  status text not null default 'active',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hr_position_assignments_type_check check (assignment_type in ('PRIMARY', 'SECONDARY')),
  constraint hr_position_assignments_status_check check (status in ('active', 'ended')),
  constraint hr_position_assignments_effective_check check (effective_to is null or effective_to >= effective_from),
  constraint hr_position_assignments_position_fk
    foreign key (position_id) references public.hr_position_slots (id) on delete cascade,
  constraint hr_position_assignments_employee_fk
    foreign key (employee_user_id) references public.users (id) on delete cascade
);

create index if not exists hr_position_assignments_position_idx on public.hr_position_assignments (position_id);
create index if not exists hr_position_assignments_employee_idx on public.hr_position_assignments (employee_user_id);
create index if not exists hr_position_assignments_eff_idx on public.hr_position_assignments (effective_from, effective_to);
create index if not exists hr_position_assignments_org_idx on public.hr_position_assignments (organization_id);

drop trigger if exists hr_position_assignments_touch on public.hr_position_assignments;
create trigger hr_position_assignments_touch before update on public.hr_position_assignments
  for each row execute function public.hr_position_touch_updated_at();


-- ---------------------------------------------------------------------------
-- Overlap guard: no overlapping active assignments (one active primary per
-- employee AND max one active incumbent per slot).
-- ---------------------------------------------------------------------------
create or replace function public.hr_position_assignments_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_overlap boolean;
begin
  if new.status <> 'active' then return new; end if;

  -- 1) One active PRIMARY position per employee (overlap in time).
  select exists (
    select 1 from public.hr_position_assignments a
    where a.employee_user_id = new.employee_user_id
      and a.assignment_type = 'PRIMARY'
      and new.assignment_type = 'PRIMARY'
      and a.status = 'active'
      and a.id is distinct from new.id
      and a.effective_from <= coalesce(new.effective_to, 'infinity'::date)
      and coalesce(a.effective_to, 'infinity'::date) >= new.effective_from
  ) into v_overlap;
  if v_overlap then
    raise exception 'hr_position_assignment_employee_overlap' using errcode = '23514';
  end if;

  -- 2) Max one active incumbent per position slot (overlap in time).
  select exists (
    select 1 from public.hr_position_assignments a
    where a.position_id = new.position_id
      and a.status = 'active'
      and a.id is distinct from new.id
      and a.effective_from <= coalesce(new.effective_to, 'infinity'::date)
      and coalesce(a.effective_to, 'infinity'::date) >= new.effective_from
  ) into v_overlap;
  if v_overlap then
    raise exception 'hr_position_assignment_slot_overlap' using errcode = '23514';
  end if;

  return new;
end $$;

drop trigger if exists hr_position_assignments_guard_trg on public.hr_position_assignments;
create trigger hr_position_assignments_guard_trg
  before insert or update on public.hr_position_assignments
  for each row execute function public.hr_position_assignments_guard();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.hr_position_assignments enable row level security;

drop policy if exists hr_position_assignments_select on public.hr_position_assignments;
create policy hr_position_assignments_select on public.hr_position_assignments
  for select to authenticated
  using (organization_id = public.hr_position_actor_org());

drop policy if exists hr_position_assignments_write on public.hr_position_assignments;
create policy hr_position_assignments_write on public.hr_position_assignments
  for all to authenticated using (false) with check (false);

-- Rollback: drop trigger hr_position_assignments_guard_trg; drop function
-- hr_position_assignments_guard(); drop table hr_position_assignments;
