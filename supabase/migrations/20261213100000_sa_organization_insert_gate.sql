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
-- Fix (least privilege). The gate's organization argument becomes sa_org_create_context(parent_org_id,
-- org_type_code), which is NULL — and sa_rls_gate denies a NULL organization — unless the create is a business-valid
-- one, and otherwise names the top-level HQ at which the permission is decided:
--   * Business parent-type matrix (app/src/lib/utils/orgHierarchy.ts getValidParentTypes, mirrored here because the
--     hierarchy trigger only compares hierarchy levels and also admits e.g. DIST/WH/SHOP under a manufacturer, SHOP
--     under an HQ or a warehouse):
--         HQ   no parent (Root Access only)        MFG  no parent, or under an HQ
--         DIST under an HQ                         WH   under an HQ or a distributor
--         SHOP under a distributor                 any other type / pair: NULL
--     The parent must exist and be active.
--   * Decision organization: the top-level active HQ of the PARENT's chain (for a parentless MFG / HQ: of the
--     caller's own chain). The caller must hold platform.organization.manage at that HQ — i.e. an HQ-scoped
--     organization administrator (catalogue: "Import, configure and remove organizations", HQ_ADMIN, level <= 10;
--     Add Organization is an HQ-only screen). Grants scoped below an HQ (a distributor, a manufacturer, a
--     warehouse) never authorize creating organizations. On staging that excludes the 5 partner MANUFACTURER_USER
--     accounts whose legacy-hq compatibility role (legacy role HQ, level 10) was materialized at their own
--     manufacturer, and the warehouse-scoped legacy-hq holder.
--   * Root Access: the evaluator allows Root at any existing organization, so Root creates every business-valid
--     pair anywhere, and is the only actor who can create a parentless HQ (a new top-level tenant nobody else would
--     hold scope at). Root is still refused business-invalid pairs.
-- sa_org_create_context is SECURITY DEFINER owned by supabase_admin (reads organizations/users regardless of the
-- caller's SELECT policies, and may call sa_actor_is_root, which authenticated cannot execute directly). It returns
-- only an organization id and does not authorize anything by itself.
--
-- Unchanged: the legacy expression (is_hq_admin() OR is_super_admin()), so LEGACY_ENFORCED / SHADOW environments
-- behave exactly as before; the dead NEW-mode remainder; every other organizations policy; modes, grants,
-- assignments and readiness rows; triggers. The sa_policy_rewrites row for orgs_insert_admin (staging: 'id') is
-- updated to the new organization expression.
--
-- Fails safe. If the live policy text is neither the expected staging text nor already re-pointed, section 2 raises
-- and nothing is changed (with psql -1 the helper is rolled back too).
--
-- Holders on staging (2026-10-22, read-only): HQ-scoped 13 (legacy-hq 9, legacy-sa 3, platform-settings-full-access
-- 1) — can create; MFG-scoped 5 partner accounts and WH-scoped 1 — cannot; Root holders 2. Not covered here (they
-- write with the service role after their own checks): shop-request approval and createShopOrganization. Legacy
-- environments keep the legacy rule, which still lets any level <= 10 account create any trigger-valid organization.
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
returns uuid language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_anchor uuid;
  v_parent_type text;
  v_parent_active boolean;
  v_chain uuid[];
begin
  if p_parent_org_id is null then
    -- Parentless: MFG, or HQ for Root Access only. The decision is at the caller's own top-level HQ.
    if p_org_type_code = 'HQ' then
      if not public.sa_actor_is_root(auth.uid()) then return null; end if;
    elsif p_org_type_code is distinct from 'MFG' then
      return null;
    end if;
    select u.organization_id into v_anchor from public.users u where u.id = auth.uid() and u.is_active is true;
  else
    select o.org_type_code, o.is_active into v_parent_type, v_parent_active
    from public.organizations o where o.id = p_parent_org_id;
    if v_parent_active is not true then return null; end if;
    if not (
         (p_org_type_code = 'MFG'  and v_parent_type = 'HQ')
      or (p_org_type_code = 'DIST' and v_parent_type = 'HQ')
      or (p_org_type_code = 'WH'   and v_parent_type in ('HQ', 'DIST'))
      or (p_org_type_code = 'SHOP' and v_parent_type = 'DIST')
    ) then
      return null;
    end if;
    v_anchor := p_parent_org_id;
  end if;
  if v_anchor is null then return null; end if;

  -- Top of the chain, only if it is an active, parentless HQ.
  v_chain := public.sa_org_ancestry(v_anchor);
  return (select o.id from public.organizations o
          where o.id = v_chain[array_length(v_chain, 1)]
            and o.org_type_code = 'HQ' and o.parent_org_id is null and o.is_active is true);
end $$;
revoke all on function public.sa_org_create_context(uuid, text) from public, anon;
grant execute on function public.sa_org_create_context(uuid, text) to authenticated, service_role;
comment on function public.sa_org_create_context(uuid, text) is
  'Organization at which platform.organization.manage is decided for a NEW organization: the top-level active HQ of '
  'the parent''s chain (parentless MFG, or parentless HQ for Root Access only: of the caller''s own chain). NULL '
  'for business-invalid type/parent pairs or an inactive/missing parent. Returns an id only.';

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
  if (select pg_get_userbyid(proowner) from pg_proc where oid = 'public.sa_org_create_context(uuid,text)'::regprocedure)
     is distinct from 'supabase_admin' then
    raise exception 'postcondition: sa_org_create_context must be owned by supabase_admin (apply as supabase_admin)';
  end if;
  if has_function_privilege('anon', 'public.sa_org_create_context(uuid,text)', 'EXECUTE') then
    raise exception 'postcondition: sa_org_create_context must not be executable by anon';
  end if;
  if exists (select 1 from public.sa_policy_rewrites where table_name = 'organizations' and policy_name = 'orgs_insert_admin'
             and organization_expression is distinct from 'sa_org_create_context(parent_org_id, org_type_code)') then
    raise exception 'postcondition: sa_policy_rewrites row for orgs_insert_admin not updated';
  end if;
end $$;
