-- ============================================================================
-- Security & Access — View Inventory (inventory.stock.view), the standard
-- "Inventory Viewer" Group Policy, and stock reads decided by S&A
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database, so
-- nothing here has been run against a real database (throwaway PostgreSQL 17 only:
-- supabase/tests/security/sa_inventory_stock_view/run.sh).
--
-- Findings (2026-10-11, orderapp@dev.com: HQ, GUEST level 50; Supply Chain Full Access granted, then revoked — the
-- assignment is status 'revoked' and nothing else is active but Employee Self-Service)
--   The revocation itself worked. Inventory stayed readable because no stock read path ever asked Security & Access:
--   * vw_inventory_on_hand, vw_manual_stock_balance, v_low_stock_alerts and v_stock_movements_display are owned by a
--     superuser, are NOT security_invoker, are granted to authenticated (Phase 0B allowlist) and have NO organization
--     filter. Any signed-in account, of any organization, read every organization's on-hand, allocated and available
--     quantities, manual balances, low-stock lines and movement history straight from PostgREST.
--   * product_inventory SELECT (inventory_read_org_hierarchy) is a tenant rule only (can_access_org OR is_hq_admin):
--     an HQ account reads every warehouse's balances whatever its grants. The Final Wave gate left SELECT untouched.
--   * inventory_org_manage is FOR ALL. Its rewritten expression reduces to can_access_org(organization_id) once
--     inventory.adjustment.post is S&A-authoritative, and FOR ALL includes SELECT — a second tenant-only read path.
--   * No permission meant "view stock on hand": inventory.report.view is movement/stock reports, inventory.transfer.view
--     is transfers, inventory.stock_count.view is stock counts.
--
-- What this adds
--   1. Permission inventory.stock.view "View Inventory" (Supply Chain → Inventory), ordinary sensitivity.
--      Compatibility rule as inventory.report.view (staff level 40, legacy view_inventory); compat roles are NOT
--      refreshed here.
--   2. Mode: NEW_ENFORCED when the Inventory module is already decided by S&A in this environment (inventory.report.view
--      NEW_ENFORCED / LEGACY_RETIRED, as on staging), otherwise SHADOW (legacy decides: today's tenant rule). The new key
--      never becomes the only Supply Chain permission still answered by legacy rules, and an environment still on legacy
--      Supply Chain is not tightened by this file. No existing mode changes.
--   3. One stock read rule, used by the table policy and the four views (sa_inventory_stock_row_visible):
--        always   the existing tenant rule (can_access_org OR is_hq_admin) — organization boundaries are unchanged;
--        and, while inventory.stock.view is S&A-authoritative, the row's organization is in the caller's S&A scope for
--                 one of sa_inventory_stock_read_permissions(): inventory.stock.view, or a stock workflow permission whose
--                 screens show balances (adjust, count, transfer, receive, ship, reports, opening balance, stock
--                 configuration). Scope = sa_readable_organizations (assignments, scopes, delegation, Root Access).
--        product_inventory only: a holder of supply_chain.order.create may also read balances inside the tenant rule
--                 (order forms show the seller's availability; a distributor orders from its parent HQ warehouse,
--                 outside its own scope). Not the views: the Inventory page is not an ordering screen.
--      Order approval, cancellation, documents, catalogue and QR permissions do NOT read stock.
--      Server code (service_role) is unaffected: routes authorize first and then read with the service client.
--   4. product_inventory: the SELECT policy uses the rule; inventory_org_manage is split into INSERT/UPDATE/DELETE
--      policies with byte-identical expressions (writes unchanged; the write-guard trigger still decides quantity
--      changes), so it no longer grants SELECT.
--   5. The four views keep their definitions, columns and grants and gain the rule (and security_barrier). Rows the
--      caller may not read are filtered, not errors, so the screens show "no stock" instead of failing.
--   6. Standard Group Policy "Inventory Viewer" (inventory-viewer): exactly inventory.stock.view, HQ/distributor/
--      warehouse organizations, published, assigned to NO ONE. Read only: no adjustment, transfer, opening balance,
--      configuration or administration permission.
--   7. Supply Chain Full Access gains inventory.stock.view through sa_extend_standard_policy (its coverage covers the
--      inventory module; the extension is audited per holder). Warehouse Manager/Operator are NOT extended: their
--      transfer and count permissions already read stock in their scope, but the Inventory page needs the view
--      permission or a stock workflow permission (see app nav-access.ts SUPPLY_CHAIN_VIEW_DESTINATIONS).
--
-- Not changed: no existing migration mode, no grant history, no assignment, no existing migration, no write rule,
-- stock_movements' own RLS (legacy staff/partner rule: listed as a follow-up), inventory quantities and movements.
--
-- Order: requires 20260928100000..20260928130000 (Final Wave), 20260930100000 (sa_readable_organizations),
-- 20261005110000 (applicability) and 20261009100000 (standard policy coverage + sa_extend_standard_policy). Mirrors
-- app/src/lib/security-access/inventory-stock.ts (lock-step test inventory-stock.test.tsx).
--
-- Repeat-safe. Rollback (only while the policy is unassigned):
--   1. restore the four views from sa_inventory_view_originals.definition (create or replace view ... as <definition>);
--   2. drop policy inventory_read_org_hierarchy on product_inventory and recreate it as
--        for select to authenticated using ((is_active = true) and (can_access_org(organization_id) or is_hq_admin()));
--      drop the inventory_org_manage_{insert,update,delete} policies and recreate inventory_org_manage FOR ALL with
--      sa_inventory_view_originals' recorded policy expressions (view_name = 'product_inventory.inventory_org_manage');
--   3. delete the inventory-viewer role, the stock.view mode/readiness/compat rows, its role permission rows (including
--      the Supply Chain Full Access one, and that policy's coverage entry), then the permission;
--   4. drop the sa_inventory_* functions and sa_inventory_view_originals.
-- ============================================================================

do $pre$
begin
  if to_regclass('public.sa_standard_policy_coverage') is null
     or to_regprocedure('public.sa_extend_standard_policy(text,text[],text)') is null then
    raise exception 'sa_prerequisite_missing: apply 20261009100000_sa_group_policies_full_access.sql first';
  end if;
  if to_regprocedure('public.sa_readable_organizations(uuid,text,boolean)') is null then
    raise exception 'sa_prerequisite_missing: sa_readable_organizations (20260930100000) is required';
  end if;
  if to_regprocedure('public.can_access_org(uuid)') is null or to_regprocedure('public.is_hq_admin()') is null then
    raise exception 'sa_prerequisite_missing: can_access_org(uuid) / is_hq_admin()';
  end if;
  if to_regclass('public.product_inventory') is null then
    raise exception 'sa_prerequisite_missing: public.product_inventory';
  end if;
  if not exists (select 1 from public.sa_standard_policy_coverage where role_key = 'supply-chain-full-access') then
    raise exception 'sa_prerequisite_missing: Supply Chain Full Access coverage row';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Permission, compatibility rule, mode, readiness
-- ---------------------------------------------------------------------------
insert into public.sa_permissions(permission_key, module, resource, action, description, source, audit_sensitivity) values
 ('inventory.stock.view','inventory','stock','view','View Inventory: on-hand, allocated, available and incoming stock for warehouses in scope','new','ordinary')
on conflict (permission_key) do nothing;

insert into public.sa_legacy_compat_rules(permission_key, max_role_level, role_codes, legacy_permissions, employee_baseline, notes) values
 ('inventory.stock.view', 40, '{}', '{view_inventory}', false,
  'View Inventory: same audience as inventory.report.view plus the legacy view_inventory permission (inventory-stock.ts).')
on conflict (permission_key) do nothing;

insert into public.sa_migration_modes(permission_key, mode, legacy_permission_key, notes)
select 'inventory.stock.view',
       case when public.sa_is_new_authoritative('inventory.report.view') then 'NEW_ENFORCED' else 'SHADOW' end,
       null,
       'View Inventory: seeded to match the Inventory module (inventory.report.view) — S&A decides wherever inventory is already S&A-authoritative; elsewhere the tenant rule decides as before.'
on conflict (permission_key) do nothing;

insert into public.sa_enforcement_readiness(permission_key, route_wiring, database_backstop, intentional_tightening, notes) values
 ('inventory.stock.view', true, 'rls_gate',
  'Accounts without an inventory permission no longer read stock balances; ordering screens keep availability through supply_chain.order.create.',
  'Supply Chain page guards and the Inventory destination decide through S&A; product_inventory SELECT and vw_inventory_on_hand / vw_manual_stock_balance / v_low_stock_alerts / v_stock_movements_display filter rows with sa_inventory_stock_row_visible.')
on conflict (permission_key) do update set route_wiring = excluded.route_wiring, database_backstop = excluded.database_backstop,
  intentional_tightening = excluded.intentional_tightening, notes = excluded.notes;

-- ---------------------------------------------------------------------------
-- 2. The stock read rule
-- ---------------------------------------------------------------------------
-- Permissions whose holders read stock balances in their S&A scope. Lock-step with INVENTORY_STOCK_READ_PERMISSIONS.
create or replace function public.sa_inventory_stock_read_permissions()
returns text[] language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array[
    'inventory.stock.view',
    'inventory.report.view',
    'inventory.adjustment.post',
    'inventory.opening_balance.manage',
    'inventory.stock_config.manage',
    'inventory.stock_count.view', 'inventory.stock_count.create', 'inventory.stock_count.verify', 'inventory.stock_count.post',
    'inventory.transfer.request', 'inventory.transfer.approve', 'inventory.transfer.dispatch', 'inventory.transfer.receive',
    'warehouse.receipt.post', 'warehouse.shipment.manage'
  ]::text[]
$$;
revoke all on function public.sa_inventory_stock_read_permissions() from public, anon;
grant execute on function public.sa_inventory_stock_read_permissions() to authenticated, service_role;

-- NULL while inventory.stock.view is on a legacy mode (the tenant rule alone decides, as before). Otherwise the
-- organizations the verified caller may read stock in. Callers wrap it in a scalar subquery so it runs once per statement.
create or replace function public.sa_inventory_stock_scope()
returns uuid[] language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_uid uuid := auth.uid();
  v_orgs uuid[] := array[]::uuid[];
  k text;
begin
  if not public.sa_is_new_authoritative('inventory.stock.view') then return null; end if;
  if v_uid is null then return array[]::uuid[]; end if;
  foreach k in array public.sa_inventory_stock_read_permissions() loop
    -- Only keys the caller can hold at all (an active assignment or delegation names it). The view permission is
    -- always asked, which is also how Root Access (every active permission, every organization) answers.
    continue when k <> 'inventory.stock.view'
      and not exists (
        select 1 from public.sa_role_assignments a
        join public.sa_business_role_permissions rp on rp.role_id = a.role_id
        join public.sa_permissions p on p.id = rp.permission_id and p.permission_key = k
        where a.user_id = v_uid and a.status = 'active')
      and not exists (
        select 1 from public.sa_delegations d where d.delegate_id = v_uid and d.status = 'active' and k = any(d.permission_keys));
    v_orgs := v_orgs || public.sa_readable_organizations(v_uid, k, true);
  end loop;
  return coalesce((select array_agg(distinct x) from unnest(v_orgs) x), array[]::uuid[]);
end
$fn$;
revoke all on function public.sa_inventory_stock_scope() from public, anon;
grant execute on function public.sa_inventory_stock_scope() to authenticated, service_role;

-- Ordering screens: while inventory.stock.view is S&A-authoritative, a holder of supply_chain.order.create (any scope)
-- reads balances inside the tenant rule (product_inventory only).
create or replace function public.sa_inventory_order_availability_reader()
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select public.sa_is_new_authoritative('inventory.stock.view')
     and auth.uid() is not null
     and cardinality(public.sa_readable_organizations(auth.uid(), 'supply_chain.order.create', true)) > 0
$$;
revoke all on function public.sa_inventory_order_availability_reader() from public, anon;
grant execute on function public.sa_inventory_order_availability_reader() to authenticated, service_role;

-- The row decision. p_scope: sa_inventory_stock_scope() (NULL = legacy mode). p_any_scope: the ordering reader flag.
-- No API request (database owner, maintenance) and the service role are not filtered, like sa_require_operation.
create or replace function public.sa_inventory_stock_row_visible(p_org uuid, p_scope uuid[], p_any_scope boolean default false)
returns boolean language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select case
    when nullif(current_setting('request.jwt.claims', true), '') is null then true
    when (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role') = 'service_role' then true
    when p_org is null then false
    else coalesce(public.can_access_org(p_org) or public.is_hq_admin(), false)
         and (p_scope is null or p_org = any(p_scope) or coalesce(p_any_scope, false))
  end
$$;
revoke all on function public.sa_inventory_stock_row_visible(uuid,uuid[],boolean) from public, anon;
grant execute on function public.sa_inventory_stock_row_visible(uuid,uuid[],boolean) to authenticated, service_role;

-- Originals kept for rollback (views and the split policy).
create table if not exists public.sa_inventory_view_originals (
  view_name text primary key,
  definition text not null,
  recorded_at timestamptz not null default now()
);
alter table public.sa_inventory_view_originals enable row level security;
alter table public.sa_inventory_view_originals force row level security;
revoke all on table public.sa_inventory_view_originals from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. product_inventory policies
-- ---------------------------------------------------------------------------
do $pi$
declare
  v_manage record;
begin
  select pg_get_expr(polqual, polrelid) as qual, pg_get_expr(polwithcheck, polrelid) as wcheck
    into v_manage
    from pg_policy where polrelid = 'public.product_inventory'::regclass and polname = 'inventory_org_manage' and polcmd = '*';
  if found then
    insert into public.sa_inventory_view_originals(view_name, definition)
    values ('product_inventory.inventory_org_manage', jsonb_build_object('using', v_manage.qual, 'check', v_manage.wcheck)::text)
    on conflict (view_name) do nothing;
    -- Same expressions per write command; SELECT is no longer granted by this policy.
    execute format('create policy inventory_org_manage_insert on public.product_inventory for insert to authenticated with check (%s)',
                   coalesce(v_manage.wcheck, v_manage.qual));
    execute format('create policy inventory_org_manage_update on public.product_inventory for update to authenticated using (%s) with check (%s)',
                   v_manage.qual, coalesce(v_manage.wcheck, v_manage.qual));
    execute format('create policy inventory_org_manage_delete on public.product_inventory for delete to authenticated using (%s)', v_manage.qual);
    drop policy inventory_org_manage on public.product_inventory;
  end if;
end $pi$;

drop policy if exists inventory_read_org_hierarchy on public.product_inventory;
create policy inventory_read_org_hierarchy on public.product_inventory for select to authenticated
using (
  is_active = true
  and public.sa_inventory_stock_row_visible(organization_id,
        (select public.sa_inventory_stock_scope()),
        (select public.sa_inventory_order_availability_reader()))
);
comment on policy inventory_read_org_hierarchy on public.product_inventory is
  'Tenant rule (can_access_org or is_hq_admin) as before; while inventory.stock.view is S&A-authoritative also the caller''s S&A stock scope, or order creation (availability). See 20261031100000.';

-- ---------------------------------------------------------------------------
-- 4. Views: same definition, columns and grants, rows filtered by the rule
-- ---------------------------------------------------------------------------
do $views$
declare
  r record;
  v_def text;
begin
  for r in select * from (values
    ('vw_inventory_on_hand',      'public.sa_inventory_stock_row_visible(v.organization_id, (select public.sa_inventory_stock_scope()))'),
    ('vw_manual_stock_balance',   'public.sa_inventory_stock_row_visible(v.warehouse_id, (select public.sa_inventory_stock_scope()))'),
    ('v_low_stock_alerts',        'public.sa_inventory_stock_row_visible(v.organization_id, (select public.sa_inventory_stock_scope()))'),
    ('v_stock_movements_display', '(public.sa_inventory_stock_row_visible(v.from_organization_id, (select public.sa_inventory_stock_scope()))'
                                  || ' or public.sa_inventory_stock_row_visible(v.to_organization_id, (select public.sa_inventory_stock_scope())))')
  ) as t(view_name, predicate) loop
    if to_regclass('public.' || r.view_name) is null then
      raise notice 'inventory stock view %: not present, skipped', r.view_name;
      continue;
    end if;
    v_def := pg_get_viewdef(('public.' || r.view_name)::regclass, true);
    if position('sa_inventory_stock_row_visible' in v_def) > 0 then continue; end if;  -- already filtered
    insert into public.sa_inventory_view_originals(view_name, definition) values (r.view_name, v_def)
    on conflict (view_name) do nothing;
    v_def := regexp_replace(v_def, ';\s*$', '');
    execute format('create or replace view public.%I as select v.* from (%s) v where %s', r.view_name, v_def, r.predicate);
    execute format('alter view public.%I set (security_barrier = true)', r.view_name);
  end loop;
end $views$;

-- ---------------------------------------------------------------------------
-- 5. Standard Group Policy "Inventory Viewer" (not assigned to anyone)
-- ---------------------------------------------------------------------------
do $seed$
declare
  v_key constant text := 'inventory-viewer';
  v_perms constant text[] := array['inventory.stock.view'];
  v_role uuid;
  v_existing text;
begin
  select b.source into v_existing from public.sa_business_roles b where b.role_key = v_key;
  if v_existing is not null and v_existing <> 'template' then
    raise exception 'sa_group_policy_key_conflict: % already exists as a non-standard role', v_key;
  end if;

  insert into public.sa_business_roles(role_key, name, description, source, status, applicable_account_types, applicable_org_types)
  values (v_key, 'Inventory Viewer',
    'View inventory records and stock quantities (on hand, allocated, available, incoming) for the warehouses in scope. Read only: no stock additions, adjustments, transfers, opening balances, stock configuration or inventory administration.',
    'template', 'active', '{}', array['HQ','DIST','WH'])
  on conflict (role_key) do nothing
  returning id into v_role;

  if v_role is null then return; end if;

  insert into public.sa_business_role_permissions(role_id, permission_id)
  select v_role, p.id from public.sa_permissions p where p.permission_key = any(v_perms) and p.status = 'active';
  if (select count(*) from public.sa_business_role_permissions where role_id = v_role) <> cardinality(v_perms) then
    raise exception 'sa_group_policy_permission_missing: % (%)', v_key, array_to_string(v_perms, ', ');
  end if;

  insert into public.sa_standard_policy_coverage(role_id, role_key, module_id, module_prefixes, permission_keys)
  values (v_role, v_key, 'supply_chain', array['inventory'], v_perms);

  perform public.sa_log_access_change(null, 'access_profile.standard_seeded', null, 'sa_business_role', v_role::text,
    jsonb_build_object('role_key', v_key, 'module', 'supply_chain', 'permission_count', cardinality(v_perms)),
    'Standard Inventory Viewer group policy seeded (not assigned to anyone)', 'system');
end $seed$;

-- ---------------------------------------------------------------------------
-- 6. Supply Chain Full Access covers the new Inventory permission
-- ---------------------------------------------------------------------------
select public.sa_extend_standard_policy('supply-chain-full-access', array['inventory.stock.view'],
  'View Inventory (inventory.stock.view) split out of the Inventory module; Supply Chain Full Access covers every Supply Chain permission.');

-- ---------------------------------------------------------------------------
-- 7. Post-conditions
-- ---------------------------------------------------------------------------
do $post$
declare
  v_bad text;
begin
  if (select mode from public.sa_migration_modes where permission_key = 'inventory.stock.view') not in ('SHADOW','NEW_ENFORCED','LEGACY_RETIRED') then
    raise exception 'postcondition: inventory.stock.view has no recognised mode';
  end if;
  if exists (select 1 from public.sa_business_roles b where b.role_key = 'inventory-viewer'
             and (select array_agg(p.permission_key order by p.permission_key) from public.sa_business_role_permissions rp
                  join public.sa_permissions p on p.id = rp.permission_id where rp.role_id = b.id) is distinct from array['inventory.stock.view']) then
    raise exception 'postcondition: inventory-viewer must hold exactly inventory.stock.view';
  end if;
  if (select count(*) from public.sa_role_assignments a join public.sa_business_roles b on b.id = a.role_id where b.role_key = 'inventory-viewer') <> 0 then
    raise exception 'postcondition: inventory-viewer must not be assigned by a migration';
  end if;
  if not exists (select 1 from public.sa_business_role_permissions rp join public.sa_business_roles b on b.id = rp.role_id
                 join public.sa_permissions p on p.id = rp.permission_id
                 where b.role_key = 'supply-chain-full-access' and p.permission_key = 'inventory.stock.view') then
    raise exception 'postcondition: Supply Chain Full Access must hold inventory.stock.view';
  end if;
  -- Only the stock rule may grant SELECT on product_inventory.
  select string_agg(polname, ', ') into v_bad from pg_policy
  where polrelid = 'public.product_inventory'::regclass and polcmd in ('r','*')
    and pg_get_expr(polqual, polrelid) not like '%sa_inventory_stock_row_visible%';
  if v_bad is not null then raise exception 'postcondition: product_inventory policies still grant SELECT outside the stock rule: %', v_bad; end if;
  -- Every view that is still readable by authenticated is filtered.
  select string_agg(n, ', ') into v_bad from unnest(array['vw_inventory_on_hand','vw_manual_stock_balance','v_low_stock_alerts','v_stock_movements_display']) n
  where to_regclass('public.' || n) is not null
    and has_table_privilege('authenticated', ('public.' || n)::regclass, 'SELECT')
    and position('sa_inventory_stock_row_visible' in pg_get_viewdef(('public.' || n)::regclass, true)) = 0;
  if v_bad is not null then raise exception 'postcondition: unfiltered inventory views: %', v_bad; end if;
end $post$;
