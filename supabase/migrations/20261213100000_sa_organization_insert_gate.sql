-- ============================================================================
-- Security & Access — decide organization CREATE at the new organization's parent, not its own (unborn) id
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database,
-- so nothing in this file has been run against a real database (throwaway PostgreSQL 17 restored from a schema-only
-- staging dump: supabase/tests/security/sa_org_insert_gate/run.sh).
--
-- Defect (verified on staging 2026-10-21, read-only). The INSERT policy is
--   orgs_insert_admin WITH CHECK
--     sa_rls_gate('platform.organization.manage', id, is_hq_admin() OR is_super_admin())
--     OR (sa_rls_new_mode('platform.organization.manage') AND (false OR false))
-- and the key is LEGACY_RETIRED on staging, so only the S&A branch decides. That branch evaluates the permission
-- with context {organization_id: <the new row's id>}. The row does not exist yet when WITH CHECK runs, so
-- sa_org_ancestry(id) is empty, no membership matches, and sa_evaluate_permission returns MISSING_MEMBERSHIP for
-- every caller who is not Root Access. Effect: Supply Chain → Organizations → Add Organization and
-- /api/organizations/import fail with 42501 "new row violates row-level security policy for table organizations"
-- (staging Kong 403, 2026-10-21 07:27:40 UTC).
--
-- Fix. The gate's organization argument becomes sa_org_create_context(parent_org_id):
--   * parent given (DIST, SHOP, WH, MFG under an HQ): the parent organization. The caller must hold
--     platform.organization.manage at the parent or an ancestor of it — the same organization-scope reach as every
--     other S&A gate (an HQ grant covers its distributors and shops). The hierarchy trigger validate_org_hierarchy
--     still decides which parent types are allowed.
--   * no parent (HQ, standalone MFG): the top-level HQ of the caller's own organization chain (the "tenant" HQ).
--     The caller must hold the permission at that HQ. Callers whose chain does not end at an active HQ (for example
--     a standalone manufacturer's users) get NULL, and sa_rls_gate denies a NULL organization.
-- sa_org_create_context is SECURITY DEFINER (reads organizations/users regardless of the caller's SELECT policies)
-- and returns only an organization id. It does not authorize anything by itself.
--
-- Unchanged: the legacy expression (is_hq_admin() OR is_super_admin()), so LEGACY_ENFORCED / SHADOW environments
-- behave exactly as before; the dead NEW-mode remainder; every other organizations policy; modes, grants,
-- assignments and readiness rows; triggers. sa_policy_rewrites is updated only if a row exists for this policy
-- (staging has none).
--
-- Intentional behaviour once enforced: a holder whose grant is scoped to a distributor can create organizations
-- under that distributor (e.g. its shops), mirroring orgs_update_hierarchy's distributor → own shops rule. Holders
-- on staging (2026-10-22 replica): legacy-sa, legacy-hq, platform-settings-full-access.
--
-- Order: requires 20260928100000 (sa_org_ancestry, sa_rls_gate). Repeat-safe.
--
-- Rollback (per environment):
--   alter policy orgs_insert_admin on public.organizations with check (
--     (sa_rls_gate('platform.organization.manage'::text, id, (is_hq_admin() OR is_super_admin())) OR
--      (sa_rls_new_mode('platform.organization.manage'::text) AND (false OR false))));
--   drop function if exists public.sa_org_create_context(uuid);
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Organization context for a new organization
-- ---------------------------------------------------------------------------
create or replace function public.sa_org_create_context(p_parent_org_id uuid)
returns uuid language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select case
    when p_parent_org_id is not null then p_parent_org_id
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
revoke all on function public.sa_org_create_context(uuid) from public, anon;
grant execute on function public.sa_org_create_context(uuid) to authenticated, service_role;
comment on function public.sa_org_create_context(uuid) is
  'Organization at which platform.organization.manage is decided for a NEW organization: its parent, or for a '
  'parentless organization the top-level HQ of the caller''s own chain (NULL otherwise). Returns an id only.';

-- ---------------------------------------------------------------------------
-- 2. Re-point the INSERT gate (only the organization argument changes)
-- ---------------------------------------------------------------------------
do $repoint$
declare
  v_check text;
  v_new text;
begin
  select pg_get_expr(pol.polwithcheck, pol.polrelid) into v_check
  from pg_policy pol
  where pol.polrelid = 'public.organizations'::regclass and pol.polname = 'orgs_insert_admin';
  if v_check is null then
    raise exception 'orgs_insert_admin not found on public.organizations';
  end if;

  v_new := regexp_replace(v_check,
    'sa_rls_gate\(''platform\.organization\.manage''::text, id,',
    'sa_rls_gate(''platform.organization.manage''::text, sa_org_create_context(parent_org_id),', 'g');

  if v_new is distinct from v_check then
    execute format('alter policy orgs_insert_admin on public.organizations with check (%s)', v_new);
    update public.sa_policy_rewrites set organization_expression = 'sa_org_create_context(parent_org_id)'
    where table_name = 'organizations' and policy_name = 'orgs_insert_admin';
    raise notice 'sa_org_insert_gate: orgs_insert_admin re-pointed to sa_org_create_context(parent_org_id)';
  else
    raise notice 'sa_org_insert_gate: orgs_insert_admin already re-pointed';
  end if;
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
  if v_check !~ 'sa_rls_gate\(''platform\.organization\.manage''::text, sa_org_create_context\(parent_org_id\),' then
    raise exception 'postcondition: orgs_insert_admin is not gated at sa_org_create_context(parent_org_id): %', v_check;
  end if;
  if v_check !~ 'is_hq_admin\(\) OR is_super_admin\(\)' then
    raise exception 'postcondition: orgs_insert_admin legacy expression changed: %', v_check;
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.sa_org_create_context(uuid)'::regprocedure) then
    raise exception 'postcondition: sa_org_create_context must be SECURITY DEFINER';
  end if;
  if has_function_privilege('anon', 'public.sa_org_create_context(uuid)', 'EXECUTE') then
    raise exception 'postcondition: sa_org_create_context must not be executable by anon';
  end if;
end $$;
