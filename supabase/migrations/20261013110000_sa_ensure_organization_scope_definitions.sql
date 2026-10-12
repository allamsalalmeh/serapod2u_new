-- S&A: every active organization has its canonical own-organization scope definition (UNAPPLIED — review, then apply).
--
-- Why: the Add User / S&A pickers offer a recipient only scopes that already exist as sa_scope_definitions rows
-- (scope-eligibility.ts canonicalScopeChoices: a target organization without a usable definition simply has no choice).
-- Definitions are created only by the Wave 1 backfill (organizations that already had a portal membership) and by the
-- lifecycle when a user first joins an organization — i.e. AFTER the first user exists. An organization that never had a
-- user (typically a freshly created Manufacturer) therefore has no definition, and creating its FIRST user shows
-- "No further scope available for this policy" with Add policy disabled. The picker is correct to fail closed there:
-- a missing scope is never treated as global access.
--
-- Change (data only; adds no permission and no grant):
--   1. Backfill: insert the canonical definition (type 'warehouse' for WH, otherwise 'organization'; scope_value = the
--      organization id; same shape as 20260927140000 and sa_ensure_scope_internal) for each active organization that has
--      NO definition of that type. Existing definitions — including deprecated ones — are never changed or reactivated.
--   2. Trigger: new organizations get the same definition on insert, so the gap cannot reopen.
--
-- Not changed: scope eligibility (20261011100000), who may grant what, existing grants, assignments, access modes,
-- organization hierarchy. A scope definition by itself authorizes nothing; a grant still needs an eligible policy, an
-- authorized administrator and the database guards.
--
-- Review before applying:  select o.id, o.org_name, o.org_type_code from public.organizations o
--   where o.is_active is not false and not exists (select 1 from public.sa_scope_definitions d
--     where d.organization_id = o.id and d.scope_value = o.id::text and d.scope_type = case when o.org_type_code = 'WH' then 'warehouse' else 'organization' end);
-- Rollback: drop trigger if exists organizations_ensure_scope_definition on public.organizations;
--           drop function if exists public.organizations_ensure_scope_definition();
--           (backfilled rows carry resource_metadata->>'source' = 'org_scope_backfill_20261013' and can be deleted if unreferenced.)
-- No session temp tables.

insert into public.sa_scope_definitions(organization_id, scope_type, scope_value, display_name, resource_metadata)
select o.id,
       case when o.org_type_code = 'WH' then 'warehouse' else 'organization' end,
       o.id::text,
       o.org_name,
       jsonb_build_object('source', 'org_scope_backfill_20261013', 'org_type_code', o.org_type_code)
from public.organizations o
where o.is_active is not false
  and not exists (
    select 1 from public.sa_scope_definitions d
    where d.organization_id = o.id and d.scope_value = o.id::text
      and d.scope_type = case when o.org_type_code = 'WH' then 'warehouse' else 'organization' end)
on conflict do nothing;

create or replace function public.organizations_ensure_scope_definition()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if new.is_active is not false then
    insert into public.sa_scope_definitions(organization_id, scope_type, scope_value, display_name, resource_metadata)
    values (new.id, case when new.org_type_code = 'WH' then 'warehouse' else 'organization' end, new.id::text, new.org_name,
            jsonb_build_object('source', 'org_scope_trigger', 'org_type_code', new.org_type_code))
    on conflict do nothing;
  end if;
  return new;
end $$;
revoke all on function public.organizations_ensure_scope_definition() from public, anon, authenticated;

drop trigger if exists organizations_ensure_scope_definition on public.organizations;
create trigger organizations_ensure_scope_definition after insert on public.organizations
  for each row execute function public.organizations_ensure_scope_definition();
