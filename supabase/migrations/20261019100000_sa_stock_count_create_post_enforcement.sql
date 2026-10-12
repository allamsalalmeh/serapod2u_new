-- ============================================================================
-- Security & Access — complete enforcement for inventory.stock_count.create and inventory.stock_count.post
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database,
-- so nothing in this file has been run against a real database (throwaway PostgreSQL 17 restored from a schema-only
-- staging dump: supabase/tests/security/sa_stock_count_create_post/run.sh).
--
-- Audit (2026-10-07). Both keys were shown as "Blocked: not enforcement-ready" in Migration Modes. The readiness
-- registry was NOT stale: enforcement was genuinely incomplete.
--   inventory.stock_count.create
--     * The browser writes drafts straight to stock_count_sessions / _items / _scope through PostgREST; there is no
--       server route. The only database control was the Final Wave RLS rewrite, and for these tables it decides
--       nothing in NEW_ENFORCED: the rewritten policy is  sa_rls_gate(create, ...) OR (new_mode AND can_access_org(..))
--       so anyone who can reach the warehouse still passes once S&A is authoritative (the tenant predicate is kept as
--       an alternative, not as a condition). Items and scope were also gated on the ACTOR's organization
--       (sa_actor_org_id()), not the session's warehouse.
--     * discard_stock_count_drafts() → archive_stock_count_draft() (SECURITY DEFINER) had no S&A guard.
--     * The Stock Count screen did not ask S&A whether drafts may be saved.
--   inventory.stock_count.post
--     * The verify route only evaluated it as a SHADOW diagnostic (authorize(), never enforced).
--     * The preflight, the verify route and stock_count_user_can_post() (used by prepare_stock_count_verification,
--       verify_and_post_stock_count and verify_and_post_stock_classification) decided through the LEGACY role /
--       department key post_stock_count only, so NEW_ENFORCED / LEGACY_RETIRED could not change who may post.
--     * No database backstop tied the consumption of a verification code (the single point every posting function
--       passes: stock_count_verification_requests.status -> 'posted') to the S&A decision for posting.
--
-- What this adds (every check is a no-op until the key is NEW_ENFORCED / LEGACY_RETIRED, so applying it changes no
-- behaviour while both keys are SHADOW):
--   1. sa_stock_count_context(warehouse)   trusted S&A context {organization_id, warehouse_id} = the warehouse (same
--      convention as the inventory.adjustment.post / transfer guards): organization scopes match through the
--      warehouse's ancestry, warehouse scopes match the warehouse itself, memberships must lie on that chain.
--   2. Create — API-role write guard on stock_count_sessions, stock_count_session_items and stock_count_session_scope
--      (SECURITY INVOKER trigger, the stock_count_session_integrity pattern: SECURITY DEFINER workflow functions and
--      the service role are not API roles and are unaffected). Every insert / update / delete by anon/authenticated
--      requires inventory.stock_count.create for the session's warehouse (old AND new warehouse when it changes).
--      RLS, the draft-only integrity guard, the opening-balance guards and the reference guard keep applying.
--   3. Create — archive_stock_count_draft() (reached from discard_stock_count_drafts) requires the same decision per
--      draft through sa_require_operation; a refused draft is reported in the RPC's existing "failed" list.
--   4. Post — stock_count_user_can_post(): the tenant check is unchanged; in NEW_ENFORCED / LEGACY_RETIRED the S&A
--      decision for the warehouse replaces the legacy role/department key (legacy no longer decides, as the mode
--      contract requires). LEGACY_ENFORCED / SHADOW: byte-for-byte the previous rule.
--   5. Post — decision backstop trigger on stock_count_verification_requests: issuing a code (INSERT) and consuming it
--      into 'posted' (every posting function, including the opening-balance and classification variants) require
--      inventory.stock_count.post for the session's warehouse, evaluated in the database for the acting user.
--   6. TRUNCATE on stock_count_session_scope revoked from anon/authenticated (sessions/items were already revoked).
--   7. Readiness registration for both keys (sa_enforcement_readiness), so Migration Modes stops blocking them.
--      Mirrors app/src/lib/security-access/readiness.ts (STOCK_COUNT_ENFORCEMENT_READY).
--
-- Intentional tightening once enforced (recorded in the registry):
--   create  users who could reach a warehouse (can_access_org / HQ admin) but hold no create grant for it can no
--           longer save, edit or discard Stock Count drafts — including Opening Balance count entry, which writes the
--           same tables. Posting through the screen saves the draft first, so posters also need create.
--   post    the legacy role/department key post_stock_count no longer decides; only S&A grants for the warehouse.
--
-- Not changed: no migration mode, grant, assignment or policy; Stock Count validation, OTP, snapshot hashing, posting
-- arithmetic and RLS read paths are untouched. The verify trigger (sa_stock_count_verify_enforcement) is untouched.
--
-- Order: requires 20260927150000_sa_wave1_readiness.sql, 20260927160000_stock_count_session_integrity.sql,
-- 20260928100000 … 20260928130000 (Final Wave A–D). Independent of 20261019110000. Repeat-safe.
--
-- Rollback (set both keys back to SHADOW first):
--   drop trigger if exists sa_stock_count_create_api_guard on public.stock_count_sessions;
--   drop trigger if exists sa_stock_count_create_api_guard on public.stock_count_session_items;
--   drop trigger if exists sa_stock_count_create_api_guard on public.stock_count_session_scope;
--   drop trigger if exists sa_stock_count_post_enforcement on public.stock_count_verification_requests;
--   drop function if exists public.sa_stock_count_create_api_guard();
--   drop function if exists public.sa_enforce_stock_count_post();
--   drop function if exists public.sa_require_stock_count_create(uuid, uuid);
--   -- archive_stock_count_draft: execute original_definition from sa_function_guard_injections
--   --   where function_signature = 'archive_stock_count_draft(uuid)', then delete that row.
--   -- stock_count_user_can_post: re-create the 20260716_stock_count_verification_preflight_and_permissions_03 body.
--   delete from public.sa_enforcement_readiness where permission_key in ('inventory.stock_count.create','inventory.stock_count.post');
--   drop function if exists public.sa_stock_count_context(uuid);
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Trusted resource context for a Stock Count warehouse
-- ---------------------------------------------------------------------------
create or replace function public.sa_stock_count_context(p_warehouse uuid)
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when p_warehouse is null then '{}'::jsonb
              else jsonb_build_object('organization_id', p_warehouse, 'warehouse_id', p_warehouse) end
$$;
revoke all on function public.sa_stock_count_context(uuid) from public, anon, authenticated;
grant execute on function public.sa_stock_count_context(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. inventory.stock_count.create — API-role write guard
-- ---------------------------------------------------------------------------
-- Raises 42501 sa_authorization_required unless the verified caller holds inventory.stock_count.create for the
-- warehouse (looked up from the session when not supplied). No-op for requests without claims (migrations, owner),
-- for the service role, and while the key is LEGACY_ENFORCED / SHADOW. Memoised per transaction (sa_cached_*), so
-- a draft save of hundreds of item rows evaluates once.
create or replace function public.sa_require_stock_count_create(p_session_id uuid, p_warehouse uuid)
returns void language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role';
  v_wh uuid := p_warehouse;
begin
  if v_role is null or v_role = 'service_role' then return; end if;
  if not public.sa_cached_mode_is_new('inventory.stock_count.create') then return; end if;
  if v_wh is null and p_session_id is not null then
    select s.warehouse_organization_id into v_wh from public.stock_count_sessions s where s.id = p_session_id;
  end if;
  if v_wh is null or auth.uid() is null
     or not public.sa_cached_actor_allows('inventory.stock_count.create', public.sa_stock_count_context(v_wh)) then
    raise exception 'sa_authorization_required'
      using errcode = '42501',
            detail = format('permission=inventory.stock_count.create resource=stock_count:%s', coalesce(p_session_id::text, '-'));
  end if;
end $$;
revoke all on function public.sa_require_stock_count_create(uuid, uuid) from public, anon;
-- The SECURITY INVOKER trigger below runs as the API role, so that role must be able to call the check. It only
-- ever answers for auth.uid() (raise or return), exactly like sa_require_operation, which is already granted.
grant execute on function public.sa_require_stock_count_create(uuid, uuid) to authenticated, service_role;

create or replace function public.sa_stock_count_create_api_guard()
returns trigger
language plpgsql
-- SECURITY INVOKER on purpose: current_user must be the caller's role (see stock_count_session_api_write_guard).
set search_path = pg_catalog, pg_temp
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return coalesce(new, old);
  end if;
  if tg_table_name = 'stock_count_sessions' then
    if tg_op in ('UPDATE', 'DELETE') then
      perform public.sa_require_stock_count_create(old.id, old.warehouse_organization_id);
    end if;
    if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.warehouse_organization_id is distinct from old.warehouse_organization_id) then
      perform public.sa_require_stock_count_create(new.id, new.warehouse_organization_id);
    end if;
  else
    if tg_op in ('UPDATE', 'DELETE') then
      perform public.sa_require_stock_count_create(old.session_id, null);
    end if;
    if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.session_id is distinct from old.session_id) then
      perform public.sa_require_stock_count_create(new.session_id, null);
    end if;
  end if;
  return coalesce(new, old);
end $$;
revoke all on function public.sa_stock_count_create_api_guard() from public, anon, authenticated;
comment on function public.sa_stock_count_create_api_guard() is
  'S&A backstop for inventory.stock_count.create: API-role writes to Stock Count drafts need the permission for the session warehouse. No-op in LEGACY_ENFORCED/SHADOW and for SECURITY DEFINER workflow functions / service role.';

drop trigger if exists sa_stock_count_create_api_guard on public.stock_count_sessions;
create trigger sa_stock_count_create_api_guard
before insert or update or delete on public.stock_count_sessions
for each row execute function public.sa_stock_count_create_api_guard();

drop trigger if exists sa_stock_count_create_api_guard on public.stock_count_session_items;
create trigger sa_stock_count_create_api_guard
before insert or update or delete on public.stock_count_session_items
for each row execute function public.sa_stock_count_create_api_guard();

drop trigger if exists sa_stock_count_create_api_guard on public.stock_count_session_scope;
create trigger sa_stock_count_create_api_guard
before insert or update or delete on public.stock_count_session_scope
for each row execute function public.sa_stock_count_create_api_guard();

revoke truncate on table public.stock_count_session_scope from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. inventory.stock_count.create — draft discard (archive) RPC
-- ---------------------------------------------------------------------------
select public.sa_inject_operation_guard(
  'public.archive_stock_count_draft(uuid)'::regprocedure, 'inventory.stock_count.create',
  $g$PERFORM public.sa_require_operation('inventory.stock_count.create', public.sa_stock_count_context((SELECT s.warehouse_organization_id FROM public.stock_count_sessions s WHERE s.id = p_session_id)), 'stock_count', p_session_id::text);$g$);

-- ---------------------------------------------------------------------------
-- 4. inventory.stock_count.post — in-body posting authority
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stock_count_user_can_post(p_user_id uuid, p_warehouse_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role_level integer;
  v_role_permissions jsonb;
  v_overrides jsonb;
BEGIN
  SELECT r.role_level, coalesce(r.permissions::jsonb, '{}'::jsonb), coalesce(d.permission_overrides::jsonb, '{}'::jsonb)
    INTO v_role_level, v_role_permissions, v_overrides
  FROM public.users u
  LEFT JOIN public.roles r ON r.role_code = u.role_code
  LEFT JOIN public.departments d ON d.id = u.department_id
  WHERE u.id = p_user_id AND coalesce(u.is_active, true) = true;

  IF NOT FOUND OR NOT (public.can_access_org(p_warehouse_id) OR public.is_hq_admin()) THEN RETURN false; END IF;
  -- NEW_ENFORCED / LEGACY_RETIRED: Security & Access decides for this warehouse; the legacy role/department key is
  -- not consulted (a legacy allow cannot override a new deny, a legacy deny cannot block a new allow).
  IF public.sa_is_new_authoritative('inventory.stock_count.post') THEN
    RETURN public.sa_actor_has_permission(p_user_id, 'inventory.stock_count.post', public.sa_stock_count_context(p_warehouse_id));
  END IF;
  IF coalesce(v_overrides->'deny', '[]'::jsonb) ? 'post_stock_count' THEN RETURN false; END IF;
  RETURN v_role_level = 1
    OR coalesce(v_overrides->'allow', '[]'::jsonb) ? 'post_stock_count'
    OR coalesce(v_role_permissions->>'post_stock_count', 'false')::boolean
    OR coalesce(v_role_permissions, '[]'::jsonb) ? 'post_stock_count';
END;
$$;
REVOKE ALL ON FUNCTION public.stock_count_user_can_post(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stock_count_user_can_post(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. inventory.stock_count.post — verification-code backstop
-- ---------------------------------------------------------------------------
create or replace function public.sa_enforce_stock_count_post()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_actor uuid;
  v_wh uuid;
begin
  if not public.sa_is_new_authoritative('inventory.stock_count.post') then
    return new; -- LEGACY_ENFORCED / SHADOW: behaviour unchanged
  end if;
  if tg_op = 'INSERT' then
    v_actor := new.requesting_user_id;                 -- code issued for posting
  elsif new.status = 'posted' and old.status is distinct from 'posted' then
    v_actor := coalesce(new.verified_by, auth.uid());  -- code consumed: the count is being posted
  else
    return new; -- expiry / invalidation / attempt counting stay unrestricted
  end if;
  select s.warehouse_organization_id into v_wh from public.stock_count_sessions s where s.id = new.session_id;
  if v_actor is null or v_wh is null
     or not public.sa_actor_has_permission(v_actor, 'inventory.stock_count.post', public.sa_stock_count_context(v_wh)) then
    raise exception 'sa_authorization_required'
      using errcode = '42501', detail = format('permission=inventory.stock_count.post resource=stock_count:%s', new.session_id);
  end if;
  return new;
end $$;
revoke all on function public.sa_enforce_stock_count_post() from public, anon, authenticated;
drop trigger if exists sa_stock_count_post_enforcement on public.stock_count_verification_requests;
create trigger sa_stock_count_post_enforcement
before insert or update of status on public.stock_count_verification_requests
for each row execute function public.sa_enforce_stock_count_post();
comment on trigger sa_stock_count_post_enforcement on public.stock_count_verification_requests is
  'S&A backstop: in NEW_ENFORCED/LEGACY_RETIRED, issuing or consuming a Stock Count verification code requires inventory.stock_count.post for the session warehouse. No-op in LEGACY_ENFORCED/SHADOW.';

-- ---------------------------------------------------------------------------
-- 6. Readiness registration
-- ---------------------------------------------------------------------------
insert into public.sa_enforcement_readiness(permission_key, route_wiring, database_backstop, intentional_tightening, notes) values
 ('inventory.stock_count.create', true, 'transition_guard',
  'Users who reach a warehouse but hold no create grant for it can no longer save, edit or discard Stock Count drafts (including Opening Balance count entry). Posting through the screen saves the draft first, so posters also need create.',
  'No server route: the Stock Count screen writes drafts through PostgREST and asks S&A (capabilities, warehouse context) before offering Save. sa_stock_count_create_api_guard on sessions/items/scope + archive_stock_count_draft guard.'),
 ('inventory.stock_count.post', true, 'rpc_guard',
  'The legacy role/department key post_stock_count no longer decides; only S&A grants for the warehouse.',
  'Verification request/preflight and verify routes (requireAuthorization), stock_count_user_can_post in prepare/verify-and-post, and sa_stock_count_post_enforcement on code issue/consumption.')
on conflict (permission_key) do nothing;

-- ---------------------------------------------------------------------------
-- 7. Post-conditions
-- ---------------------------------------------------------------------------
do $$
declare
  v_tbl text;
begin
  foreach v_tbl in array array['stock_count_sessions', 'stock_count_session_items', 'stock_count_session_scope'] loop
    if not exists (select 1 from pg_trigger where tgname = 'sa_stock_count_create_api_guard'
                   and tgrelid = ('public.' || v_tbl)::regclass and tgenabled = 'O') then
      raise exception 'postcondition: create guard missing on %', v_tbl;
    end if;
  end loop;
  if (select prosecdef from pg_proc where oid = 'public.sa_stock_count_create_api_guard()'::regprocedure) then
    raise exception 'postcondition: create guard must be SECURITY INVOKER';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'sa_stock_count_post_enforcement'
                 and tgrelid = 'public.stock_count_verification_requests'::regclass) then
    raise exception 'postcondition: post enforcement trigger missing';
  end if;
  if pg_get_functiondef('public.archive_stock_count_draft(uuid)'::regprocedure) not like '%sa-guard:inventory.stock_count.create%' then
    raise exception 'postcondition: archive_stock_count_draft is not guarded';
  end if;
  if pg_get_functiondef('public.stock_count_user_can_post(uuid,uuid)'::regprocedure) not like '%inventory.stock_count.post%' then
    raise exception 'postcondition: stock_count_user_can_post does not consult S&A';
  end if;
  if has_function_privilege('authenticated', 'public.stock_count_user_can_post(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sa_stock_count_context(uuid)', 'EXECUTE') then
    raise exception 'postcondition: internal stock count helpers must not be callable by API roles';
  end if;
  if has_table_privilege('authenticated', 'public.stock_count_session_scope', 'TRUNCATE') then
    raise exception 'postcondition: API roles must not truncate stock_count_session_scope';
  end if;
  if (select count(*) from public.sa_enforcement_readiness
      where permission_key in ('inventory.stock_count.create', 'inventory.stock_count.post')) <> 2 then
    raise exception 'postcondition: readiness registration missing';
  end if;
end $$;
