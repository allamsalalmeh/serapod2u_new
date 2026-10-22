-- ============================================================================
-- Security & Access — decide organization CREATE at the new organization's parent, not its own (unborn) id
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database,
-- so nothing in this file has been run against a real database (throwaway PostgreSQL 17 restored from a schema-only
-- staging dump: supabase/tests/security/sa_org_insert_gate/run.sh).
--
-- Apply as supabase_admin (owner of the S&A functions; superuser, so the SECURITY DEFINER helper reads users and
-- organizations regardless of RLS), in ONE transaction:
--   psql -1 -v ON_ERROR_STOP=1 -c "set lock_timeout = '5s'" -f 20261213100000_sa_organization_insert_gate.sql
-- The file has no BEGIN/COMMIT of its own; -1 makes the helper, the policy change and the post-conditions atomic.
--
-- Defect (verified on staging 2026-10-21/22, read-only). The INSERT policy is
--   orgs_insert_admin WITH CHECK
--     sa_rls_gate('platform.organization.manage', id, is_hq_admin() OR is_super_admin())
--     OR (sa_rls_new_mode('platform.organization.manage') AND (false OR false))
-- and the key is LEGACY_RETIRED on staging, so only the S&A branch decides. That branch evaluates the permission
-- with context {organization_id: <the new row's id>}. The row does not exist yet when WITH CHECK runs:
--   * sa_evaluate_permission_core's Root Access branch requires the organization to exist, so Root falls through;
--   * sa_org_ancestry(id) is empty, no membership matches, and the decision is MISSING_MEMBERSHIP.
-- Every caller, Root Administrators included, is denied: Supply Chain → Organizations → Add Organization and
-- /api/organizations/import fail with 42501 "new row violates row-level security policy for table organizations"
-- (staging Kong 403 at 2026-10-21 07:27:40, 2026-10-22 02:33:32 and 02:50:29 UTC).
--
-- Fix. The gate's organization argument becomes sa_org_create_context(parent_org_id, org_type_code):
--   * parent given (DIST, SHOP, WH, MFG under an HQ): the parent organization. The caller must hold
--     platform.organization.manage at the parent or an ancestor of it — the same organization-scope reach as every
--     other S&A gate (an HQ grant covers its distributors and shops). The hierarchy trigger validate_org_hierarchy
--     still decides which parent types are allowed.
--   * no parent, type HQ (a new top-level tenant): Root Administrators only. For an active Root holder the context
--     is the top-level HQ of the caller's own chain (Root's evaluator branch then allows); for anyone else NULL,
--     which sa_rls_gate denies. Nobody but Root would hold access scope at a new HQ afterwards, so HQ-scoped
--     administrators must not be able to mint one.
--   * no parent, any other type (standalone MFG): the top-level active HQ of the caller's own organization chain;
--     the caller must hold the permission there. Callers whose chain does not end at an active HQ (for example a
--     standalone manufacturer's users) get NULL and are denied.
-- sa_org_create_context is SECURITY DEFINER (reads organizations/users regardless of the caller's SELECT policies)
-- and returns only an organization id. It does not authorize anything by itself.
--
-- Unchanged: the legacy expression (is_hq_admin() OR is_super_admin()), so LEGACY_ENFORCED / SHADOW environments
-- behave exactly as before; the dead NEW-mode remainder; every other organizations policy; modes, grants,
-- assignments and readiness rows; triggers. The sa_policy_rewrites row for orgs_insert_admin (staging: 'id') is
-- updated to the new organization expression.
--
-- Fails safe. If the live policy text is neither the expected staging text nor already re-pointed, section 2 raises
-- and nothing is changed (with psql -1 the helper is rolled back too).
--
-- Intentional behaviour once enforced: a holder whose grant is scoped to a distributor (or manufacturer) can create
-- organizations under it (e.g. a distributor's shops), mirroring orgs_update_hierarchy's distributor → own shops
-- rule. Holders on staging (2026-10-22, read-only): legacy-hq 15, legacy-sa 3, platform-settings-full-access 1
-- users; scopes HQ 13, MFG 5, WH 1.
--
-- Order: requires 20260928100000 (sa_org_ancestry, sa_rls_gate) and 20261026100000 (sa_actor_is_root). Independent of
-- 20261022100000_sa_actor_org_gates_row_context (already applied on staging; organizations is not one of its
-- targets). Repeat-safe.
--
-- Rollback (per environment, as supabase_admin, in one transaction):
--   alter policy orgs_insert_admin on public.organizations with check (
--     (sa_rls_gate('platform.organization.manage'::text, id, (is_hq_admin() OR is_super_admin())) OR
--      (sa_rls_new_mode('platform.organization.manage'::text) AND (false OR false))));
--   update public.sa_policy_rewrites set organization_expression = 'id'
--     where table_name = 'organizations' and policy_name = 'orgs_insert_admin';
--   drop function if exists public.sa_org_create_context(uuid, text);
--
-- Verification (after apply):
--   select pg_get_expr(polwithcheck, polrelid) from pg_policy
--     where polrelid = 'public.organizations'::regclass and polname = 'orgs_insert_admin';
--     -- contains sa_org_create_context(parent_org_id, org_type_code) and is_hq_admin() OR is_super_admin()
--   select organization_expression from public.sa_policy_rewrites
--     where table_name = 'organizations' and policy_name = 'orgs_insert_admin';
--     -- sa_org_create_context(parent_org_id, org_type_code)
--   select has_function_privilege('anon', 'public.sa_org_create_context(uuid,text)', 'EXECUTE');  -- false
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Organization context for a new organization
-- ---------------------------------------------------------------------------
create or replace function public.sa_org_create_context(p_parent_org_id uuid, p_org_type_code text)
returns uuid language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select case
    when p_parent_org_id is not null then p_parent_org_id
    -- A new parentless HQ is a new top-level tenant: Root Administrators only.
    when p_org_type_code = 'HQ' and not public.sa_actor_is_root(auth.uid()) then null
    else (
      -- Top of the caller's own organization chain, only if it is an active, parentless HQ.
      select o.id
      from public.users u
      cross join lateral public.sa_org_ancestry(u.organization_id) as a(chain)
      join public.organizations o on o.id = a.chain[array_length(a.chain, 1)]
      where u.id = auth.uid() and u.is_active is true
        and o.org_type_code = 'HQ' and o.parent_org_id is null and o.is_active is true
    )
  end
$$;
revoke all on function public.sa_org_create_context(uuid, text) from public, anon;
grant execute on function public.sa_org_create_context(uuid, text) to authenticated, service_role;
comment on function public.sa_org_create_context(uuid, text) is
  'Organization at which platform.organization.manage is decided for a NEW organization: its parent; for a '
  'parentless HQ the caller''s top-level HQ only if the caller holds Root Access; for another parentless type the '
  'top-level HQ of the caller''s own chain; NULL otherwise. Returns an id only.';

-- ---------------------------------------------------------------------------
-- 2. Re-point the INSERT gate (only the organization argument changes)
-- ---------------------------------------------------------------------------
do $repoint$
declare
  v_check text;
  v_new text;
  v_target constant text := 'sa_rls_gate(''platform.organization.manage''::text, sa_org_create_context(parent_org_id, org_type_code),';
begin
  select pg_get_expr(pol.polwithcheck, pol.polrelid) into v_check
  from pg_policy pol
  where pol.polrelid = 'public.organizations'::regclass and pol.polname = 'orgs_insert_admin';
  if v_check is null then
    raise exception 'sa_org_insert_gate: orgs_insert_admin not found on public.organizations; nothing changed';
  end if;

  if position(v_target in v_check) > 0 then
    raise notice 'sa_org_insert_gate: orgs_insert_admin already re-pointed; nothing changed';
  else
    v_new := regexp_replace(v_check,
      'sa_rls_gate\(''platform\.organization\.manage''::text, id,',
      replace(v_target, '\', '\\'), 'g');
    if v_new is not distinct from v_check then
      raise exception 'sa_org_insert_gate: orgs_insert_admin WITH CHECK is not the expected text; nothing changed. Found: %', v_check;
    end if;
    execute format('alter policy orgs_insert_admin on public.organizations with check (%s)', v_new);
    raise notice 'sa_org_insert_gate: orgs_insert_admin re-pointed to sa_org_create_context(parent_org_id, org_type_code)';
  end if;

  update public.sa_policy_rewrites set organization_expression = 'sa_org_create_context(parent_org_id, org_type_code)'
  where table_name = 'organizations' and policy_name = 'orgs_insert_admin'
    and organization_expression is distinct from 'sa_org_create_context(parent_org_id, org_type_code)';
end $repoint$;

-- ---------------------------------------------------------------------------
-- 3. Post-conditions
-- ---------------------------------------------------------------------------
do $$
declare
  v_check text;
begin
  select pg_get_expr(pol.polwithcheck, pol.polrelid) into v_check
  from pg_policy pol
  where pol.polrelid = 'public.organizations'::regclass and pol.polname = 'orgs_insert_admin';
  if position('sa_rls_gate(''platform.organization.manage''::text, sa_org_create_context(parent_org_id, org_type_code),' in v_check) = 0 then
    raise exception 'postcondition: orgs_insert_admin is not gated at sa_org_create_context(parent_org_id, org_type_code): %', v_check;
  end if;
  if position('(is_hq_admin() OR is_super_admin())' in v_check) = 0 then
    raise exception 'postcondition: orgs_insert_admin legacy expression changed: %', v_check;
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.sa_org_create_context(uuid,text)'::regprocedure) then
    raise exception 'postcondition: sa_org_create_context must be SECURITY DEFINER';
  end if;
  if has_function_privilege('anon', 'public.sa_org_create_context(uuid,text)', 'EXECUTE') then
    raise exception 'postcondition: sa_org_create_context must not be executable by anon';
  end if;
  if exists (select 1 from public.sa_policy_rewrites where table_name = 'organizations' and policy_name = 'orgs_insert_admin'
             and organization_expression is distinct from 'sa_org_create_context(parent_org_id, org_type_code)') then
    raise exception 'postcondition: sa_policy_rewrites row for orgs_insert_admin not updated';
  end if;
end $$;
