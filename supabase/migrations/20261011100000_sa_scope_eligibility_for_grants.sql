-- ============================================================================
-- S&A: scope eligibility for NEW Group Policy grants (HQ → HQ + its own warehouses)
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the
-- staging database, so nothing in this file has been run against a real database.
--
-- Approved meaning (data scope only; it adds no permission, bypasses no approval, grants nothing to partners):
--   * HQ recipient   → the HQ itself ("HQ and all its warehouses") or a warehouse that explicitly belongs to that HQ
--                      (an active organization of type WH whose parent_org_id is the HQ). Never a Shop, Distributor or
--                      Manufacturer scope.
--   * WH recipient   → that warehouse only.
--   * Other recipient→ its own organization or an organization beneath it (the hierarchy the evaluator already honours).
--   * Only `organization` / `warehouse` scope types are judged; department, territory, ... scopes keep their existing rules.
--
-- What this changes:
--   1. sa_scope_eligible_for_membership(membership_org, scope) — one SQL definition of the rule above, mirrored by
--      app/src/lib/security-access/scope-eligibility.ts (lock-step test).
--   2. A BEFORE INSERT trigger on sa_assignment_scopes that applies it to administrator grants (assignment source
--      'manual' or 'access_request'). Automatic access ('backfill', 'derived') is untouched.
--   3. sa_scope_eligibility_report() — read-only list of EXISTING grants that would not satisfy the rule today.
--
-- What this does NOT change (deliberately):
--   * No existing assignment, scope definition or scope link is rewritten, deleted or re-evaluated. Existing grants
--     keep working exactly as before. Only new inserts are checked.
--   * sa_scope_matches / sa_evaluate_permission are untouched. An `organization` scope on an HQ already covers its
--     warehouses dynamically through parent_org_id (new warehouse → covered at once; moved or removed → coverage follows
--     the relationship); a `warehouse` scope matches only that warehouse_id and returns "missing context" (deny) for
--     operations that carry no warehouse. NOTE: through the same parent chain an HQ organization scope also reaches
--     partner organizations attached beneath the HQ; narrowing that is a business decision (see the hand-off notes).
--
-- Effect on existing grants before rollout: run `select * from public.sa_scope_eligibility_report();` (service role).
-- Rows listed are existing grants that a NEW grant could no longer repeat (for example an HQ person holding a Distributor
-- scope). They are reported, never altered. Re-granting such a row after rollout is refused with sa_scope_not_eligible.
--
-- Idempotent (create or replace / drop trigger if exists). Autocommit-safe (no session temp tables or settings).
-- Requires 20260928100000_sa_final_governance_foundation.sql (sa_org_ancestry, sa_assignment_scopes).
--
-- Rollback: drop trigger if exists sa_assignment_scope_eligibility on public.sa_assignment_scopes;
--           drop function if exists public.sa_assignment_scope_eligibility_guard();
--           drop function if exists public.sa_scope_eligibility_report();
--           drop function if exists public.sa_scope_eligible_for_membership(uuid, uuid);
-- ============================================================================

create or replace function public.sa_scope_eligible_for_membership(p_membership_org uuid, p_scope uuid)
returns boolean language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  s record;       -- the scope definition
  r record;       -- the recipient (membership) organization
  t record;       -- the organization the scope stands for
begin
  select sd.scope_type, sd.scope_value, sd.organization_id, sd.status into s
  from public.sa_scope_definitions sd where sd.id = p_scope;
  if not found then return false; end if;
  -- Only the structural scope types carry HQ / warehouse meaning; the rest keep their existing rules.
  if s.scope_type not in ('organization', 'warehouse') then return true; end if;
  if s.organization_id is null or s.scope_value is distinct from s.organization_id::text then return false; end if;

  select o.org_type_code into r from public.organizations o where o.id = p_membership_org;
  if not found then return false; end if;
  select o.org_type_code, o.parent_org_id, o.is_active into t from public.organizations o where o.id = s.organization_id;
  if not found then return false; end if;

  if t.org_type_code = 'WH' then
    -- A warehouse: its canonical `warehouse` scope (an `organization` definition on a warehouse is the legacy duplicate).
    if r.org_type_code = 'HQ' then
      return coalesce(t.parent_org_id = p_membership_org, false) and t.is_active is not false;
    elsif r.org_type_code = 'WH' then
      return s.organization_id = p_membership_org;
    end if;
    return coalesce(p_membership_org = any(public.sa_org_ancestry(s.organization_id)), false) and t.is_active is not false;
  end if;

  -- Not a warehouse: an `organization` scope only.
  if s.scope_type <> 'organization' then return false; end if;
  if r.org_type_code = 'HQ' then return s.organization_id = p_membership_org; end if;     -- never a partner of the HQ
  if r.org_type_code = 'WH' then return s.organization_id = p_membership_org; end if;
  return coalesce(p_membership_org = any(public.sa_org_ancestry(s.organization_id)), false) and t.is_active is not false;
end
$fn$;
revoke all on function public.sa_scope_eligible_for_membership(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sa_scope_eligible_for_membership(uuid, uuid) to service_role;
comment on function public.sa_scope_eligible_for_membership(uuid, uuid) is
  'Is this scope offerable to a person whose membership is in this organization? HQ: itself or its own active warehouses; WH: itself; other: itself or beneath it. Only organization/warehouse scopes are judged.';

create or replace function public.sa_assignment_scope_eligibility_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_source text; v_org uuid;
begin
  select a.source, m.organization_id into v_source, v_org
  from public.sa_role_assignments a
  join public.sa_organization_memberships m on m.id = a.membership_id
  where a.id = new.assignment_id;
  -- Automatic access (backfill / derived) and unknown assignments are not administrator grants.
  if v_source is null or v_source not in ('manual', 'access_request') then return new; end if;
  if not public.sa_scope_eligible_for_membership(v_org, new.scope_id) then
    raise exception 'sa_scope_not_eligible' using errcode = '23514',
      hint = 'An HQ account can receive its HQ scope or one of its own warehouses only; other accounts receive their own organization or one beneath it.';
  end if;
  return new;
end
$fn$;
revoke all on function public.sa_assignment_scope_eligibility_guard() from public, anon, authenticated;

drop trigger if exists sa_assignment_scope_eligibility on public.sa_assignment_scopes;
create trigger sa_assignment_scope_eligibility before insert on public.sa_assignment_scopes
  for each row execute function public.sa_assignment_scope_eligibility_guard();

-- Read-only impact report: existing administrator grants a NEW grant could no longer repeat. Never alters anything.
create or replace function public.sa_scope_eligibility_report()
returns table (assignment_id uuid, user_id uuid, membership_org uuid, membership_org_type text, scope_id uuid,
               scope_type text, scope_org uuid, scope_org_type text, role_key text, source text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select a.id, a.user_id, m.organization_id, mo.org_type_code, sd.id, sd.scope_type, sd.organization_id, so.org_type_code, br.role_key, a.source
  from public.sa_assignment_scopes x
  join public.sa_role_assignments a on a.id = x.assignment_id and a.status = 'active'
  join public.sa_organization_memberships m on m.id = a.membership_id
  join public.sa_scope_definitions sd on sd.id = x.scope_id and sd.status = 'active'
  left join public.organizations mo on mo.id = m.organization_id
  left join public.organizations so on so.id = sd.organization_id
  left join public.sa_business_roles br on br.id = a.role_id
  where a.source in ('manual', 'access_request')
    and not public.sa_scope_eligible_for_membership(m.organization_id, sd.id)
  order by m.organization_id, a.user_id
$fn$;
revoke all on function public.sa_scope_eligibility_report() from public, anon, authenticated;
grant execute on function public.sa_scope_eligibility_report() to service_role;
comment on function public.sa_scope_eligibility_report() is
  'Existing administrator grants whose scope a new grant could no longer repeat under sa_scope_eligible_for_membership. Read-only; service role only.';
