-- ============================================================================
-- HR Position Management V1.1 — hr02: Position Reporting Relationships
-- ----------------------------------------------------------------------------
-- NOT APPLIED. Apply after 20261210100000_hr01_position_management_foundation.sql.
--
-- Introduces the position-centric reporting hierarchy. Supports multiple root
-- positions (co-equal Managing Directors) and typed additional relationships:
--   PRIMARY, SECOND_MANAGER, MATRIX_MANAGER, HR_MANAGER, CUSTOM.
--
-- Rules enforced here:
--   * No self-parent.
--   * PRIMARY cycles are rejected (trigger + validation function).
--   * At most one active PRIMARY parent per position for any effective date.
--   * V1 defaults to one active relationship per type per position (effective-date
--     overlap is rejected for the PRIMARY type; additional types are validated in
--     the API layer).
--
-- Validated against PostgreSQL 17. Creates NO business data.
-- Rollback: drop triggers, function and table (order in the tail comment).
-- ============================================================================

do $pre$
begin
  if to_regclass('public.hr_position_slots') is null then
    raise exception 'hr02_prerequisite_missing: apply hr01 first (public.hr_position_slots)';
  end if;
end $pre$;

create table if not exists public.hr_position_relationships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  position_id uuid not null,                 -- child position
  parent_position_id uuid,                   -- null => root position
  relationship_type text not null default 'PRIMARY',
  effective_from date not null,
  effective_to date,                         -- null => open-ended
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hr_position_relationships_type_check
    check (relationship_type in ('PRIMARY', 'SECOND_MANAGER', 'MATRIX_MANAGER', 'HR_MANAGER', 'CUSTOM')),
  constraint hr_position_relationships_no_self check (position_id is distinct from parent_position_id),
  constraint hr_position_relationships_effective_check check (effective_to is null or effective_to >= effective_from),
  constraint hr_position_relationships_position_fk
    foreign key (position_id) references public.hr_position_slots (id) on delete cascade,
  constraint hr_position_relationships_parent_fk
    foreign key (parent_position_id) references public.hr_position_slots (id) on delete cascade
);

create index if not exists hr_position_relationships_position_idx on public.hr_position_relationships (position_id);
create index if not exists hr_position_relationships_parent_idx on public.hr_position_relationships (parent_position_id);
create index if not exists hr_position_relationships_type_idx on public.hr_position_relationships (relationship_type);
create index if not exists hr_position_relationships_eff_idx on public.hr_position_relationships (effective_from, effective_to);

drop trigger if exists hr_position_relationships_touch on public.hr_position_relationships;
create trigger hr_position_relationships_touch before update on public.hr_position_relationships
  for each row execute function public.hr_position_touch_updated_at();


-- ---------------------------------------------------------------------------
-- Cycle detection: would setting position_id -> parent_position_id create a
-- PRIMARY reporting cycle? (pure, reusable by API + trigger)
-- ---------------------------------------------------------------------------
create or replace function public.hr_position_would_cycle(
  p_position_id uuid,
  p_parent_position_id uuid
) returns boolean language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  v_current uuid := p_parent_position_id;
  v_seen uuid[] := array[]::uuid[];
begin
  if p_position_id is null or p_parent_position_id is null then return false; end if;
  if p_position_id = p_parent_position_id then return true; end if;
  loop
    if v_current is null then return false; end if;
    if v_current = p_position_id then return true; end if;
    if v_current = any(v_seen) then return false; end if;
    v_seen := array_append(v_seen, v_current);
    select parent_position_id into v_current
      from public.hr_position_relationships
      where position_id = v_current
        and relationship_type = 'PRIMARY'
        and is_active = true
        and (effective_to is null or effective_to >= current_date)
      order by effective_from desc
      limit 1;
  end loop;
end $$;
revoke all on function public.hr_position_would_cycle(uuid, uuid) from public, anon;
grant execute on function public.hr_position_would_cycle(uuid, uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- Overlap + cycle trigger for PRIMARY relationships (write-time guard)
-- ---------------------------------------------------------------------------
create or replace function public.hr_position_relationships_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if new.relationship_type = 'PRIMARY' then
    if public.hr_position_would_cycle(new.position_id, new.parent_position_id) then
      raise exception 'hr_position_cycle' using errcode = '23514';
    end if;

    -- No overlapping active PRIMARY relationship for the same position.
    if exists (
      select 1 from public.hr_position_relationships r
      where r.position_id = new.position_id
        and r.relationship_type = 'PRIMARY'
        and r.is_active = true
        and r.id is distinct from new.id
        and r.effective_from <= coalesce(new.effective_to, 'infinity'::date)
        and coalesce(r.effective_to, 'infinity'::date) >= new.effective_from
    ) then
      raise exception 'hr_position_primary_overlap' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists hr_position_relationships_guard_trg on public.hr_position_relationships;
create trigger hr_position_relationships_guard_trg
  before insert or update on public.hr_position_relationships
  for each row execute function public.hr_position_relationships_guard();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.hr_position_relationships enable row level security;

drop policy if exists hr_position_relationships_select on public.hr_position_relationships;
create policy hr_position_relationships_select on public.hr_position_relationships
  for select to authenticated
  using (organization_id = public.hr_position_actor_org());

drop policy if exists hr_position_relationships_write on public.hr_position_relationships;
create policy hr_position_relationships_write on public.hr_position_relationships
  for all to authenticated using (false) with check (false);

-- Rollback: drop trigger hr_position_relationships_guard_trg; drop function
-- hr_position_relationships_guard(); drop function hr_position_would_cycle(uuid,uuid);
-- drop table hr_position_relationships;
