-- ============================================================================
-- Security & Access — Warehouse Manager: Full Access to Products, Inventory and Quality & Returns,
--                      and warehouse-scoped grants that actually reach their warehouse
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database,
-- so nothing in this file has been run against a real database (throwaway PostgreSQL 17 with the real S&A migrations:
-- supabase/tests/security/sa_warehouse_manager/run.sh).
--
-- Found (staging, read-only, 2026-10-12): orderapp@dev.com holds Warehouse Manager scoped to the `warehouse` scope
-- "Serapod Warehouse Balakong" and sees only Dashboard and HR.
--   a. The policy held 9 permissions: the Wave 1 seed copied `inventory.%` ONCE (stock count + transfer). Every later
--      Inventory key (View Inventory, Add Stock, Movement Reports, settings, returns) and the product catalogue were never
--      added, and the policy had no row in sa_standard_policy_coverage, so the controlled update process skipped it.
--   b. A `warehouse` scope matched only a context that names `warehouse_id`. Every decision made on an organization id —
--      the RLS write gates (sa_api_require_any_org), sa_require_operation contexts built from organization columns, and
--      the application's organization resources — answered MISSING_CONTEXT, even when that organization IS the
--      warehouse. (The application already treated a warehouse organization as its own warehouse for warehouse staff:
--      guardUserOperation; the database did not.)
--   c. sa_readable_organizations (list scope for stock, movement and report reads) followed `organization` scopes only,
--      so a warehouse-scoped grant read nothing at all.
--
-- What this changes:
--   1. sa_scope_matches: a `warehouse` scope also matches a context WITHOUT warehouse_id whose organization_id is that
--      same warehouse. Exact equality only: never a descendant, never the parent HQ, never another warehouse. A context
--      that names warehouse_id is decided exactly as before; any other context stays MISSING_CONTEXT as before.
--   2. sa_readable_organizations: a `warehouse` scope reaches exactly that warehouse (when it lies inside the grant's
--      membership organization, the same containment the organization branch requires). Body otherwise identical to
--      20261026100000 (Root Access branch, organization closure, delegation).
--   3. Warehouse Manager joins the controlled update process (coverage row = its CURRENT live permission set, module
--      supply_chain, prefixes inventory + product), then sa_extend_standard_policy adds the missing keys (SoD-checked,
--      audited once as access_profile.standard_extended plus assignment.profile_changed per active holder). Existing
--      grants receive the permissions immediately: assignments reference the policy, nothing is re-granted, no history
--      is rewritten, no scope is changed.
--
-- Warehouse Manager after this migration (exactly these 19 keys):
--   Products            product.catalog.view, product.catalog.manage
--   Inventory           inventory.stock.view, inventory.stock_config.manage, inventory.opening_balance.manage,
--                       inventory.adjustment.post, inventory.report.view,
--                       inventory.stock_count.view/create/verify/post,
--                       inventory.transfer.view/request/approve/dispatch/receive/cancel
--   Quality & Returns   inventory.return.request, inventory.return.manage
-- NOT included: supply_chain.* (Order Management), qr.* / manufacturing.* / warehouse.receipt.post /
-- warehouse.shipment.manage (QR Tracking), platform.organization.manage (Organizations).
--
-- Scope reality (reported, not widened): product master data, stock configuration, return settings and the return
-- workflow are decided on the ORGANIZATION (HQ) — a warehouse-only scope cannot match them, so a Warehouse Manager
-- granted on one warehouse still does not get Products / Inventory Settings / Quality & Returns. They need a grant
-- whose scope covers the organization (which also covers every warehouse below it). See
-- docs/security/WAREHOUSE_MANAGER_FULL_ACCESS.md.
--
-- Production safeguards are untouched: every RPC keeps its own guard (sa_require_operation), stock movement and
-- transfer validations, stock-count maker/checker and OTP, production delete guards, decision audit.
--
-- Order: requires 20261009100000 (coverage + sa_extend_standard_policy), 20261026100000 (Root Access body of
-- sa_readable_organizations), 20261030100000 (eligibility), 20261031100000 (inventory.stock.view). Repeat-safe.
--
-- Rollback:
--   * re-run sa_scope_matches from 20260928100000 and sa_readable_organizations from 20261026100000;
--   * policy: delete from public.sa_business_role_permissions rp using public.sa_business_roles b, public.sa_permissions p
--       where rp.role_id = b.id and p.id = rp.permission_id and b.role_key = 'warehouse-manager'
--         and p.permission_key not like 'inventory.stock_count.%'
--         and p.permission_key not in ('inventory.transfer.view','inventory.transfer.request','inventory.transfer.approve',
--                                      'inventory.transfer.dispatch','inventory.transfer.receive');
--     delete from public.sa_standard_policy_coverage where role_key = 'warehouse-manager';
--   (the audit rows stay: they record what happened.)
-- ============================================================================

do $pre$
begin
  if to_regprocedure('public.sa_extend_standard_policy(text,text[],text)') is null then
    raise exception 'sa_prerequisite_missing: sa_extend_standard_policy (20261009100000)';
  end if;
  if to_regprocedure('public.sa_actor_is_root(uuid)') is null then
    raise exception 'sa_prerequisite_missing: sa_actor_is_root (20261026100000)';
  end if;
  if not exists (select 1 from public.sa_permissions where permission_key = 'inventory.stock.view' and status = 'active') then
    raise exception 'sa_prerequisite_missing: inventory.stock.view (20261031100000)';
  end if;
  if not exists (select 1 from public.sa_business_roles where role_key = 'warehouse-manager' and source = 'template') then
    raise exception 'sa_prerequisite_missing: standard Warehouse Manager policy';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. A warehouse scope matches its own warehouse organization
-- ---------------------------------------------------------------------------
-- Returns true / false, or null when the resource context lacks the attribute the scope needs (MISSING_CONTEXT; never
-- treated as a match). Only the `warehouse` branch differs from 20260928100000.
create or replace function public.sa_scope_matches(
  p_actor uuid, p_scope_type text, p_scope_value text, p_context jsonb, p_ancestry uuid[])
returns boolean language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_owner uuid;
begin
  if p_scope_type = 'organization' then
    if coalesce(array_length(p_ancestry, 1), 0) = 0 then return null; end if;
    return p_scope_value = any(p_ancestry::text[]);
  elsif p_scope_type = 'warehouse' then
    if nullif(p_context->>'warehouse_id', '') is not null then
      return p_scope_value = p_context->>'warehouse_id';
    end if;
    -- A warehouse is an organization: a resource of exactly that organization is a resource of the warehouse.
    -- Anything else (the parent HQ, a sibling, a descendant) still lacks warehouse context.
    if p_scope_value = nullif(p_context->>'organization_id', '') then return true; end if;
    return null;
  elsif p_scope_type = 'department' then
    if nullif(p_context->>'department_id', '') is null then return null; end if;
    return p_scope_value = p_context->>'department_id';
  elsif p_scope_type = 'own_record' then
    if nullif(p_context->>'owner_user_id', '') is null then return null; end if;
    return p_context->>'owner_user_id' = p_actor::text;
  elsif p_scope_type = 'direct_reports' then
    if nullif(p_context->>'owner_user_id', '') is null then return null; end if;
    v_owner := (p_context->>'owner_user_id')::uuid;
    return exists (select 1 from public.users u where u.id = v_owner and u.manager_user_id = p_actor);
  else
    -- Generic typed scopes (territory, campaign, program, cost_center,
    -- document_type, ...) match an attribute of the same name supplied by the
    -- server from trusted resource data. No attribute → missing context.
    if nullif(p_context->'attributes'->>p_scope_type, '') is null then return null; end if;
    return p_scope_value = p_context->'attributes'->>p_scope_type;
  end if;
end $$;
revoke all on function public.sa_scope_matches(uuid,text,text,jsonb,uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. List scope: a warehouse scope reaches exactly its warehouse
-- ---------------------------------------------------------------------------
create or replace function public.sa_readable_organizations(p_actor uuid, p_permission text, p_include_delegation boolean default true)
returns uuid[] language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_now timestamptz := now();
  v_direct uuid[];
  v_delegated uuid[] := array[]::uuid[];
  d record;
begin
  if p_actor is null or p_permission is null then return array[]::uuid[]; end if;
  if not exists (select 1 from public.users u where u.id = p_actor and u.is_active is true) then
    return array[]::uuid[];
  end if;

  if public.sa_actor_is_root(p_actor)
     and exists (select 1 from public.sa_permissions p where p.permission_key = p_permission and p.status = 'active') then
    return coalesce((select array_agg(o.id) from public.organizations o), array[]::uuid[]);
  end if;

  -- (organization, ancestor) closure, same depth limit as sa_org_ancestry.
  with recursive up(id, anc, depth) as (
    select o.id, o.id, 0 from public.organizations o
    union all
    select up.id, o.parent_org_id, up.depth + 1
    from up join public.organizations o on o.id = up.anc
    where o.parent_org_id is not null and up.depth < 10
  ),
  grants as (
    select m.organization_id as m_org, (sd.scope_value)::uuid as s_org, sd.scope_type
    from public.sa_role_assignments a
    join public.sa_business_roles br on br.id = a.role_id and br.status = 'active'
    join public.sa_business_role_permissions rp on rp.role_id = br.id
    join public.sa_permissions p on p.id = rp.permission_id and p.status = 'active' and p.permission_key = p_permission
    join public.sa_organization_memberships m on m.id = a.membership_id and m.user_id = p_actor and m.status = 'active'
      and (m.effective_from is null or m.effective_from <= v_now)
      and (m.effective_until is null or m.effective_until > v_now)
    join public.sa_assignment_scopes x on x.assignment_id = a.id
    join public.sa_scope_definitions sd on sd.id = x.scope_id and sd.status = 'active' and sd.scope_type in ('organization', 'warehouse')
    where a.user_id = p_actor and a.status = 'active'
      and (a.effective_from is null or a.effective_from <= v_now)
      and (a.effective_until is null or a.effective_until > v_now)
      and sd.scope_value ~ '^[0-9a-fA-F-]{36}$'
  )
  select coalesce(array_agg(distinct u1.id), array[]::uuid[]) into v_direct
  from grants g
  join up u1 on u1.anc = g.m_org
  join up u2 on u2.id = u1.id and u2.anc = g.s_org
  -- organization: the scope organization and everything below it; warehouse: that warehouse alone.
  where g.scope_type = 'organization' or u1.id = g.s_org;

  if p_include_delegation then
    for d in
      select dl.delegator_id, dl.organization_id from public.sa_delegations dl
      where dl.delegate_id = p_actor and dl.status = 'active'
        and dl.effective_from <= v_now and dl.effective_until > v_now
        and p_permission = any(dl.permission_keys)
    loop
      -- A delegate reaches X when the delegation's organization is X or an
      -- ancestor of X and the delegator directly reaches X.
      v_delegated := v_delegated || coalesce((
        select array_agg(x) from unnest(public.sa_readable_organizations(d.delegator_id, p_permission, false)) x
        where d.organization_id = any(public.sa_org_ancestry(x))), array[]::uuid[]);
    end loop;
  end if;

  return coalesce((select array_agg(distinct x) from unnest(v_direct || v_delegated) x), array[]::uuid[]);
end
$fn$;
revoke all on function public.sa_readable_organizations(uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.sa_readable_organizations(uuid,text,boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Warehouse Manager: controlled update to Full Access of its three areas
-- ---------------------------------------------------------------------------
do $wm$
declare
  v_role uuid;
  v_live text[];
  v_target constant text[] := array[
    'product.catalog.view', 'product.catalog.manage',
    'inventory.stock.view', 'inventory.stock_config.manage', 'inventory.opening_balance.manage',
    'inventory.adjustment.post', 'inventory.report.view',
    'inventory.stock_count.view', 'inventory.stock_count.create', 'inventory.stock_count.verify', 'inventory.stock_count.post',
    'inventory.transfer.view', 'inventory.transfer.request', 'inventory.transfer.approve', 'inventory.transfer.dispatch',
    'inventory.transfer.receive', 'inventory.transfer.cancel',
    'inventory.return.request', 'inventory.return.manage'];
  v_missing text;
begin
  select id into v_role from public.sa_business_roles where role_key = 'warehouse-manager' and source = 'template';

  select string_agg(k, ', ' order by k) into v_missing from unnest(v_target) k
  where not exists (select 1 from public.sa_permissions p where p.permission_key = k and p.status = 'active');
  if v_missing is not null then
    raise exception 'sa_group_policy_permission_missing: warehouse-manager (%)', v_missing
      using hint = 'Apply the migrations that register these permissions first. Nothing is omitted silently.';
  end if;

  -- Adopt the policy into the controlled update process with what it holds TODAY (nothing added yet).
  if not exists (select 1 from public.sa_standard_policy_coverage where role_id = v_role) then
    select coalesce(array_agg(p.permission_key order by p.permission_key), '{}') into v_live
    from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id
    where rp.role_id = v_role;
    insert into public.sa_standard_policy_coverage(role_id, role_key, module_id, module_prefixes, permission_keys)
    values (v_role, 'warehouse-manager', 'supply_chain', array['inventory', 'product'], v_live);
  end if;

  perform public.sa_extend_standard_policy('warehouse-manager', v_target,
    'Warehouse Manager = Full Access to Products, Inventory and Quality & Returns (Order Management, QR Tracking and Organizations excluded).');
end $wm$;

-- ---------------------------------------------------------------------------
-- 4. Post-conditions
-- ---------------------------------------------------------------------------
do $post$
declare
  v_keys text[];
  v_bad text;
begin
  select array_agg(p.permission_key order by p.permission_key) into v_keys
  from public.sa_business_roles b join public.sa_business_role_permissions rp on rp.role_id = b.id
  join public.sa_permissions p on p.id = rp.permission_id
  where b.role_key = 'warehouse-manager';
  select string_agg(k, ', ') into v_bad from unnest(v_keys) k
  where not (k like 'inventory.%' or k like 'product.%');
  if v_bad is not null then raise exception 'postcondition: Warehouse Manager holds keys outside Products/Inventory/Returns: %', v_bad; end if;
  -- Every active Inventory / product catalogue key is covered (a newer key would otherwise be silently missing).
  select string_agg(p.permission_key, ', ') into v_bad from public.sa_permissions p
  where p.status = 'active' and (p.permission_key like 'inventory.%' or p.permission_key like 'product.%')
    and not (p.permission_key = any(v_keys));
  if v_bad is not null then raise exception 'postcondition: Warehouse Manager misses Inventory/Products keys: %', v_bad; end if;
  if (select permission_keys from public.sa_standard_policy_coverage where role_key = 'warehouse-manager') is distinct from v_keys then
    raise exception 'postcondition: Warehouse Manager coverage differs from its live permission set';
  end if;
end $post$;
