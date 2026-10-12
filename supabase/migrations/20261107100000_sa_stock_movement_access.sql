-- ============================================================================
-- Security & Access — Stock Movement report (403) and inventory read security
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database;
-- this file was validated on a disposable PostgreSQL 17 restored from the staging schema + S&A configuration
-- (supabase/tests/security/sa_stock_movement_access/run.sh), applied twice in autocommit mode.
--
-- Supersedes 20261029100000_stock_movements_ordered_view_invoker.sql (never applied; now a no-op). Do not apply
-- the old security_invoker variant: once this file revokes the cost/balance columns on stock_movements an invoker
-- view would fail with 403 again for every caller.
--
-- Findings (2026-10-12, staging read-only)
--   A. vw_stock_movements_ordered (Stock Movement Report, browser) is superuser-owned, not security_invoker, and was
--      made server-only by Phase 0B (20260927110000) → "permission denied for view" (HTTP 403) for every user.
--   B. stock_movements SELECT = stock_movements_view_all: (sa_actor_is_staff(40) OR sa_actor_is_supply_partner())
--      AND can_access_org(from or to). Any staff account with any non-ESS assignment (Order Creator, Order Approver,
--      HR, …) read movements for its whole tenant without an inventory permission.
--   C. unit_cost, total_cost, quantity_before and quantity_after are granted to authenticated on stock_movements and
--      exposed by both movement views: a distributor reading a WH→distributor allocation saw HQ's unit cost and the
--      HQ warehouse balance. product_inventory / vw_inventory_on_hand carry average_cost and total_value; the
--      ordering exception of 20261031 (supply_chain.order.create, tenant rule) let a distributor read its HQ
--      parent's inventory rows including cost.
--   D. can_access_org() and the 20261031 tenant rule start with is_hq_admin() = role_level <= 10, with no
--      organization check. On staging 5 MANUFACTURER_USER accounts (MFG orgs) hold the HQ role (level 10), so the
--      legacy rule gave them every organization. can_access_org also allows ANCESTORS (a distributor "accesses" HQ).
--
-- What this changes (inventory read paths only; no write rule, no data, no grant/assignment, no existing mode)
--   1. Caller classification:
--        sa_inventory_caller_is_hq_side(): an active INTERNAL_EMPLOYEE of an HQ or warehouse (WH) organization, or a
--          Root Access holder. Every other account (distributor, shop, manufacturer, consumer) is a partner.
--        sa_inventory_hq_side_orgs(): HQ and WH organizations. A partner never reads an HQ-side inventory row in full.
--        sa_inventory_tenant_visible(org, ancestors): the tenant rule WITHOUT the role-level shortcut — own
--          organization and descendants (an HQ account therefore still reaches its whole tree), ancestors only where
--          the caller asks for them, Root Access everywhere; partner accounts never reach HQ-side organizations.
--   2. sa_inventory_stock_scope() (product_inventory + the 4 stock views of 20261031) drops HQ-side organizations from a
--      partner's scope, and sa_inventory_stock_row_visible() no longer uses can_access_org()/is_hq_admin():
--        S&A mode     row org in the caller's S&A stock scope (explicit authorization: memberships + scopes,
--                     delegation, Root Access); product_inventory ordering exception through
--                     sa_inventory_tenant_visible(org, ancestors => true) instead of can_access_org.
--        legacy mode  sa_inventory_tenant_visible(org, ancestors => true): the previous tenant rule minus the
--                     role-level shortcut and minus HQ-side rows for partners.
--   3. Stock movements: one rule for the table and both views.
--        sa_stock_movement_scope(): organizations whose movements the caller reads — S&A mode: the inventory stock
--          scope (inventory.stock.view, inventory.report.view or a stock workflow permission, see
--          sa_inventory_stock_read_permissions()); legacy mode: staff/partner gate as before AND own organization +
--          descendants (no ancestors, no role-level shortcut). NULL = not an API request / service role (unfiltered).
--        Row: from_organization_id or to_organization_id in that scope.
--        Fields: quantity_before / quantity_after only when the caller is HQ-side or every organization on the row is
--          in scope; unit_cost / total_cost only for HQ-side callers. Otherwise NULL.
--      stock_movements: stock_movements_view_all replaced by stock_movements_inventory_read; table SELECT replaced by
--        column SELECT without unit_cost, total_cost, quantity_before, quantity_after (direct PostgREST cannot read
--        them; the views return them masked). Browser readers of the table select none of those columns.
--      vw_stock_movements_ordered and v_stock_movements_display: same columns and order, owner-run security_barrier
--        views (NOT security_invoker: the invoker cannot read the revoked columns), filtered and masked by the rule,
--        SELECT granted to authenticated only.
--   4. PostgREST schema cache reload.
--
-- Not changed: can_access_org() and is_hq_admin() themselves (used by ~hundreds of non-inventory policies; their
-- role-level shortcut is a platform-wide follow-up recorded in docs/security/SUPPLY_CHAIN_ACCESS_COVERAGE.md); write
-- policies; stock_movements INSERT (authenticated holds no INSERT privilege; writes go through definer RPCs and the
-- service role, which are unaffected); product_variants.base_cost (catalog, recorded as a follow-up).
--
-- Order: requires 20261031100000_sa_inventory_stock_view (applied on staging), 20261026100000 (Root Access) and
-- 20260929140000 (sa_actor_is_staff / sa_actor_is_supply_partner). Lock-step: app/src/lib/inventory/stock-movement-access.ts.
--
-- Repeat-safe (CREATE OR REPLACE / DROP POLICY IF EXISTS / re-runnable grants; originals recorded once).
-- Rollback (restores the pre-migration behaviour, including its exposure):
--   1. drop policy stock_movements_inventory_read on public.stock_movements; recreate stock_movements_view_all from
--      sa_inventory_view_originals('stock_movements.stock_movements_view_all') as FOR SELECT TO authenticated;
--   2. grant select on public.stock_movements to authenticated;
--   3. recreate both views from sa_inventory_view_originals (keys 'vw_stock_movements_ordered.20261107',
--      'v_stock_movements_display.20261107'); revoke all on vw_stock_movements_ordered from authenticated;
--   4. recreate sa_inventory_stock_scope / sa_inventory_stock_row_visible from 20261031100000 sections 2;
--   5. drop the sa_inventory_caller_is_hq_side / sa_inventory_hq_side_orgs / sa_inventory_tenant_visible /
--      sa_stock_movement_* functions.
-- ============================================================================

do $pre$
begin
  if to_regprocedure('public.sa_inventory_stock_row_visible(uuid,uuid[],boolean)') is null
     or to_regprocedure('public.sa_inventory_stock_scope()') is null
     or to_regprocedure('public.sa_inventory_stock_read_permissions()') is null
     or to_regclass('public.sa_inventory_view_originals') is null then
    raise exception 'sa_prerequisite_missing: apply 20261031100000_sa_inventory_stock_view.sql first';
  end if;
  if to_regprocedure('public.sa_actor_is_root(uuid)') is null then
    raise exception 'sa_prerequisite_missing: sa_actor_is_root (20261026100000) is required';
  end if;
  if to_regprocedure('public.sa_actor_is_staff(integer)') is null or to_regprocedure('public.sa_actor_is_supply_partner()') is null then
    raise exception 'sa_prerequisite_missing: sa_actor_is_staff / sa_actor_is_supply_partner (20260929140000)';
  end if;
  if to_regprocedure('public.get_org_descendants(uuid)') is null or to_regprocedure('public.sa_org_ancestry(uuid)') is null then
    raise exception 'sa_prerequisite_missing: get_org_descendants(uuid) / sa_org_ancestry(uuid)';
  end if;
  if to_regclass('public.stock_movements') is null or to_regclass('public.vw_stock_movements_ordered') is null
     or to_regclass('public.v_stock_movements_display') is null then
    raise exception 'sa_prerequisite_missing: stock_movements and both movement views';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Caller classification and the tenant rule without the role-level shortcut
-- ---------------------------------------------------------------------------
create or replace function public.sa_inventory_caller_is_hq_side()
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select auth.uid() is not null and (
    exists (
      select 1 from public.users u join public.organizations o on o.id = u.organization_id
      where u.id = auth.uid() and u.is_active is true and u.principal_type = 'INTERNAL_EMPLOYEE'
        and o.org_type_code in ('HQ', 'WH'))
    or public.sa_actor_is_root(auth.uid()))
$$;
comment on function public.sa_inventory_caller_is_hq_side() is
  'Inventory: the caller is an active internal employee of an HQ or warehouse organization (or holds Root Access). Only these callers read HQ-side stock rows in full, unit/total costs and other organizations'' balances. See 20261107100000.';
revoke all on function public.sa_inventory_caller_is_hq_side() from public, anon;
grant execute on function public.sa_inventory_caller_is_hq_side() to authenticated, service_role;

create or replace function public.sa_inventory_hq_side_orgs()
returns uuid[] language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce(array_agg(o.id), array[]::uuid[]) from public.organizations o where o.org_type_code in ('HQ', 'WH')
$$;
revoke all on function public.sa_inventory_hq_side_orgs() from public, anon;
grant execute on function public.sa_inventory_hq_side_orgs() to authenticated, service_role;

-- can_access_org() without "is_hq_admin() → every organization": own organization and descendants, optionally
-- ancestors; Root Access reaches every organization; partners never reach HQ-side organizations.
-- search_path includes public: get_org_descendants() refers to organizations unqualified.
create or replace function public.sa_inventory_tenant_visible(p_org uuid, p_include_ancestors boolean default false)
returns boolean language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select p_org is not null and auth.uid() is not null and (
    public.sa_actor_is_root(auth.uid())
    or exists (
      select 1 from public.users u
      join public.organizations caller_org on caller_org.id = u.organization_id
      join public.organizations target on target.id = p_org
      where u.id = auth.uid() and u.is_active is true
        and (u.organization_id = p_org
             or p_org in (select d.org_id from public.get_org_descendants(u.organization_id) d)
             or (p_include_ancestors and p_org = any(public.sa_org_ancestry(u.organization_id))))
        and (target.org_type_code not in ('HQ', 'WH')
             or (u.principal_type = 'INTERNAL_EMPLOYEE' and caller_org.org_type_code in ('HQ', 'WH')))))
$$;
comment on function public.sa_inventory_tenant_visible(uuid, boolean) is
  'Inventory tenant rule: can_access_org without the role-level (is_hq_admin) shortcut; ancestors only on request; partners never reach HQ/WH organizations. See 20261107100000.';
revoke all on function public.sa_inventory_tenant_visible(uuid, boolean) from public, anon;
grant execute on function public.sa_inventory_tenant_visible(uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Stock rule of 20261031 (product_inventory + vw_inventory_on_hand, vw_manual_stock_balance, v_low_stock_alerts)
-- ---------------------------------------------------------------------------
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
  -- 20261107: a partner account (distributor, shop, manufacturer) never reads HQ/warehouse stock, whatever it holds.
  if not public.sa_inventory_caller_is_hq_side() then
    v_orgs := coalesce((select array_agg(x) from unnest(v_orgs) x where not (x = any(public.sa_inventory_hq_side_orgs()))),
                       array[]::uuid[]);
  end if;
  return coalesce((select array_agg(distinct x) from unnest(v_orgs) x), array[]::uuid[]);
end
$fn$;
revoke all on function public.sa_inventory_stock_scope() from public, anon;
grant execute on function public.sa_inventory_stock_scope() to authenticated, service_role;

-- The row decision. p_scope: sa_inventory_stock_scope() (NULL = legacy mode). p_any_scope: the ordering reader flag
-- (product_inventory only). No API request (database owner, maintenance) and the service role are not filtered.
create or replace function public.sa_inventory_stock_row_visible(p_org uuid, p_scope uuid[], p_any_scope boolean default false)
returns boolean language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select case
    when nullif(current_setting('request.jwt.claims', true), '') is null then true
    when (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role') = 'service_role' then true
    when p_org is null then false
    when p_scope is not null then
      p_org = any(p_scope)
      or (coalesce(p_any_scope, false) and public.sa_inventory_tenant_visible(p_org, true))
    else public.sa_inventory_tenant_visible(p_org, true)
  end
$$;
revoke all on function public.sa_inventory_stock_row_visible(uuid,uuid[],boolean) from public, anon;
grant execute on function public.sa_inventory_stock_row_visible(uuid,uuid[],boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Stock movement rule
-- ---------------------------------------------------------------------------
-- NULL = unfiltered (no API request, or the service role). Otherwise the organizations whose movements the caller reads.
create or replace function public.sa_stock_movement_scope()
returns uuid[] language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_uid uuid := auth.uid();
  v_scope uuid[];
  v_org uuid;
begin
  if v_claims is null or (v_claims::jsonb->>'role') = 'service_role' then return null; end if;
  if v_uid is null then return array[]::uuid[]; end if;

  v_scope := public.sa_inventory_stock_scope();
  if v_scope is not null then return v_scope; end if;   -- S&A decides (staging): permission-aware scope

  -- Legacy mode: the previous staff/partner gate, own organization + descendants only.
  if not (public.sa_actor_is_staff(40) or public.sa_actor_is_supply_partner()) then return array[]::uuid[]; end if;
  if public.sa_actor_is_root(v_uid) then
    return coalesce((select array_agg(o.id) from public.organizations o), array[]::uuid[]);
  end if;
  select u.organization_id into v_org from public.users u where u.id = v_uid and u.is_active is true;
  if v_org is null then return array[]::uuid[]; end if;
  return coalesce((
    select array_agg(d.org_id) from public.get_org_descendants(v_org) d
    where public.sa_inventory_caller_is_hq_side() or not (d.org_id = any(public.sa_inventory_hq_side_orgs()))),
    array[]::uuid[]);
end
$fn$;
comment on function public.sa_stock_movement_scope() is
  'Organizations whose stock movements the caller reads (S&A inventory stock scope, or the legacy staff/partner gate on own organization + descendants). NULL = not an API request. See 20261107100000.';
revoke all on function public.sa_stock_movement_scope() from public, anon;
grant execute on function public.sa_stock_movement_scope() to authenticated, service_role;

create or replace function public.sa_stock_movement_row_visible(p_from uuid, p_to uuid, p_scope uuid[])
returns boolean language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p_scope is null or p_from = any(p_scope) or p_to = any(p_scope)
$$;
revoke all on function public.sa_stock_movement_row_visible(uuid,uuid,uuid[]) from public, anon;
grant execute on function public.sa_stock_movement_row_visible(uuid,uuid,uuid[]) to authenticated, service_role;

-- Balances (quantity_before/after): HQ-side callers, or every organization on the row is in the caller's scope.
create or replace function public.sa_stock_movement_balance_visible(p_from uuid, p_to uuid, p_scope uuid[], p_hq_side boolean)
returns boolean language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p_scope is null or coalesce(p_hq_side, false)
      or ((p_from is null or p_from = any(p_scope)) and (p_to is null or p_to = any(p_scope)))
$$;
revoke all on function public.sa_stock_movement_balance_visible(uuid,uuid,uuid[],boolean) from public, anon;
grant execute on function public.sa_stock_movement_balance_visible(uuid,uuid,uuid[],boolean) to authenticated, service_role;

-- Originals kept for rollback (recorded once).
do $orig$
begin
  insert into public.sa_inventory_view_originals(view_name, definition)
  select 'stock_movements.stock_movements_view_all', pg_get_expr(p.polqual, p.polrelid)
  from pg_policy p where p.polrelid = 'public.stock_movements'::regclass and p.polname = 'stock_movements_view_all'
  on conflict (view_name) do nothing;
  insert into public.sa_inventory_view_originals(view_name, definition)
  values ('vw_stock_movements_ordered.20261107', pg_get_viewdef('public.vw_stock_movements_ordered'::regclass, true)),
         ('v_stock_movements_display.20261107', pg_get_viewdef('public.v_stock_movements_display'::regclass, true))
  on conflict (view_name) do nothing;
end $orig$;

-- 3a. stock_movements: permission-aware rows, no cost/balance columns through the table.
drop policy if exists stock_movements_view_all on public.stock_movements;
drop policy if exists stock_movements_inventory_read on public.stock_movements;
create policy stock_movements_inventory_read on public.stock_movements for select to authenticated
using (public.sa_stock_movement_row_visible(from_organization_id, to_organization_id, (select public.sa_stock_movement_scope())));
comment on policy stock_movements_inventory_read on public.stock_movements is
  'Rows whose source or destination organization is in the caller''s inventory scope (sa_stock_movement_scope). Replaces stock_movements_view_all. See 20261107100000.';

do $cols$
declare
  v_cols text;
begin
  revoke select on table public.stock_movements from anon, authenticated;
  revoke select (unit_cost, total_cost, quantity_before, quantity_after) on table public.stock_movements from anon, authenticated;
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into v_cols
  from pg_attribute a
  where a.attrelid = 'public.stock_movements'::regclass and a.attnum > 0 and not a.attisdropped
    and a.attname not in ('unit_cost', 'total_cost', 'quantity_before', 'quantity_after');
  execute format('grant select (%s) on table public.stock_movements to authenticated', v_cols);
end $cols$;

-- 3b. Both movement views: same columns, owner-run, filtered and masked by the rule.
create or replace view public.vw_stock_movements_ordered as
select sm.id,
       sm.movement_type,
       sm.reference_type,
       sm.reference_id,
       sm.reference_no,
       sm.variant_id,
       sm.from_organization_id,
       sm.to_organization_id,
       sm.quantity_change,
       case when public.sa_stock_movement_balance_visible(sm.from_organization_id, sm.to_organization_id,
                   (select public.sa_stock_movement_scope()), (select public.sa_inventory_caller_is_hq_side()))
            then sm.quantity_before end as quantity_before,
       case when public.sa_stock_movement_balance_visible(sm.from_organization_id, sm.to_organization_id,
                   (select public.sa_stock_movement_scope()), (select public.sa_inventory_caller_is_hq_side()))
            then sm.quantity_before + sm.quantity_change end as quantity_after,
       case when (select public.sa_stock_movement_scope()) is null or (select public.sa_inventory_caller_is_hq_side())
            then sm.unit_cost end::numeric(12,2) as unit_cost,
       case when (select public.sa_stock_movement_scope()) is null or (select public.sa_inventory_caller_is_hq_side())
            then sm.total_cost end::numeric(15,2) as total_cost,
       sm.manufacturer_id,
       sm.warehouse_location,
       sm.reason,
       sm.notes,
       sm.company_id,
       sm.created_by,
       sm.created_at,
       sm.stock_config_id,
       c.config_code,
       c.config_label,
       c.stock_sku,
       c.volume_ml,
       c.packaging,
       sm.stock_config_id is null as is_legacy_configuration,
       pv.variant_code,
       pv.variant_name,
       p.product_name,
       coalesce(dst.org_name, src.org_name) as organization_name,
       coalesce(dst.org_code, src.org_code) as organization_code,
       mfg.org_name as manufacturer_name,
       u.email as created_by_email
from public.stock_movements sm
left join public.inventory_stock_configurations c on c.id = sm.stock_config_id and c.variant_id = sm.variant_id
left join public.product_variants pv on pv.id = sm.variant_id
left join public.products p on p.id = pv.product_id
left join public.organizations src on src.id = sm.from_organization_id
left join public.organizations dst on dst.id = sm.to_organization_id
left join public.organizations mfg on mfg.id = sm.manufacturer_id
left join public.users u on u.id = sm.created_by
where public.sa_stock_movement_row_visible(sm.from_organization_id, sm.to_organization_id, (select public.sa_stock_movement_scope()))
order by sm.created_at, sm.id;

create or replace view public.v_stock_movements_display as
select v.id, v.created_at, v.movement_type, v.variant_id, v.from_organization_id, v.to_organization_id,
       v.quantity_change, v.quantity_before, v.quantity_after, v.unit_cost, v.reference_id, v.reason, v.created_by,
       v.reference_type, v.stock_config_id, v.config_code, v.config_label, v.stock_sku, v.volume_ml, v.packaging,
       v.is_legacy_configuration
from (
  select sm.id,
         sm.created_at,
         sm.movement_type,
         sm.variant_id,
         sm.from_organization_id,
         sm.to_organization_id,
         sm.quantity_change,
         case when public.sa_stock_movement_balance_visible(sm.from_organization_id, sm.to_organization_id,
                     (select public.sa_stock_movement_scope()), (select public.sa_inventory_caller_is_hq_side()))
              then sm.quantity_before end as quantity_before,
         case when public.sa_stock_movement_balance_visible(sm.from_organization_id, sm.to_organization_id,
                     (select public.sa_stock_movement_scope()), (select public.sa_inventory_caller_is_hq_side()))
              then sm.quantity_before + sm.quantity_change end as quantity_after,
         case when (select public.sa_stock_movement_scope()) is null or (select public.sa_inventory_caller_is_hq_side())
              then sm.unit_cost end::numeric(12,2) as unit_cost,
         sm.reference_id,
         sm.reason,
         sm.created_by,
         sm.reference_type,
         sm.stock_config_id,
         c.config_code,
         c.config_label,
         c.stock_sku,
         c.volume_ml,
         c.packaging,
         sm.stock_config_id is null as is_legacy_configuration
  from public.stock_movements sm
  left join public.inventory_stock_configurations c on c.id = sm.stock_config_id and c.variant_id = sm.variant_id
  where not (sm.movement_type = 'order_fulfillment' and sm.quantity_before = 0 and (sm.quantity_before + sm.quantity_change) = 0)
    and not (sm.from_organization_id is null and sm.to_organization_id is null)
    and public.sa_stock_movement_row_visible(sm.from_organization_id, sm.to_organization_id, (select public.sa_stock_movement_scope()))
) v;

alter view public.vw_stock_movements_ordered set (security_invoker = false, security_barrier = true);
alter view public.v_stock_movements_display set (security_invoker = false, security_barrier = true);
revoke all on table public.vw_stock_movements_ordered from public, anon, authenticated;
revoke all on table public.v_stock_movements_display from public, anon, authenticated;
grant select on table public.vw_stock_movements_ordered to authenticated;
grant select on table public.v_stock_movements_display to authenticated;
grant select on table public.vw_stock_movements_ordered to service_role;
grant select on table public.v_stock_movements_display to service_role;

comment on view public.vw_stock_movements_ordered is
  'Stock Movement Report. Rows: sa_stock_movement_scope(); balances/costs masked for callers outside the HQ side (20261107100000). Must stay owner-run (not security_invoker): authenticated cannot read the cost/balance columns of stock_movements.';
comment on view public.v_stock_movements_display is
  'Movement history (/api/movements, ship metrics). Same rule and masking as vw_stock_movements_ordered (20261107100000).';

-- ---------------------------------------------------------------------------
-- 4. Readiness note, PostgREST schema cache
-- ---------------------------------------------------------------------------
update public.sa_enforcement_readiness
   set notes = coalesce(notes || ' ', '') || '20261107100000: stock_movements and both movement views decide rows through sa_stock_movement_scope (same stock scope); cost/balance fields masked for partner accounts.'
 where permission_key = 'inventory.report.view'
   and position('20261107100000' in coalesce(notes, '')) = 0;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- 5. Post-conditions
-- ---------------------------------------------------------------------------
do $post$
declare
  v_bad text;
begin
  if exists (select 1 from pg_policy where polrelid = 'public.stock_movements'::regclass and polname = 'stock_movements_view_all') then
    raise exception 'postcondition: stock_movements_view_all still present';
  end if;
  select string_agg(polname, ', ') into v_bad from pg_policy
  where polrelid = 'public.stock_movements'::regclass and polcmd in ('r', '*')
    and pg_get_expr(polqual, polrelid) not like '%sa_stock_movement_scope%';
  if v_bad is not null then raise exception 'postcondition: stock_movements policies grant SELECT outside the movement rule: %', v_bad; end if;
  if has_table_privilege('authenticated', 'public.stock_movements', 'SELECT') then
    raise exception 'postcondition: authenticated still holds table-level SELECT on stock_movements';
  end if;
  select string_agg(c, ', ') into v_bad from unnest(array['unit_cost','total_cost','quantity_before','quantity_after']) c
  where has_column_privilege('authenticated', 'public.stock_movements', c, 'SELECT')
     or has_column_privilege('anon', 'public.stock_movements', c, 'SELECT');
  if v_bad is not null then raise exception 'postcondition: sensitive stock_movements columns readable: %', v_bad; end if;
  if not has_column_privilege('authenticated', 'public.stock_movements', 'quantity_change', 'SELECT') then
    raise exception 'postcondition: operational stock_movements columns must stay readable';
  end if;
  select string_agg(n, ', ') into v_bad from unnest(array['vw_stock_movements_ordered','v_stock_movements_display']) n
  where not has_table_privilege('authenticated', ('public.' || n)::regclass, 'SELECT')
     or has_table_privilege('anon', ('public.' || n)::regclass, 'SELECT')
     or has_table_privilege('authenticated', ('public.' || n)::regclass, 'INSERT,UPDATE,DELETE')
     or position('sa_stock_movement_scope' in pg_get_viewdef(('public.' || n)::regclass, true)) = 0
     or coalesce((select reloptions @> array['security_invoker=true'] from pg_class where oid = ('public.' || n)::regclass), false)
     or not coalesce((select reloptions @> array['security_barrier=true'] from pg_class where oid = ('public.' || n)::regclass), false);
  if v_bad is not null then raise exception 'postcondition: movement views not granted/filtered/owner-run barrier: %', v_bad; end if;
  if position('is_hq_admin' in pg_get_functiondef('public.sa_inventory_stock_row_visible(uuid,uuid[],boolean)'::regprocedure)) > 0
     or position('can_access_org' in pg_get_functiondef('public.sa_inventory_stock_row_visible(uuid,uuid[],boolean)'::regprocedure)) > 0 then
    raise exception 'postcondition: the stock rule must not use the role-level shortcut';
  end if;
  select string_agg(f, ', ') into v_bad from unnest(array[
    'public.sa_inventory_caller_is_hq_side()', 'public.sa_inventory_hq_side_orgs()', 'public.sa_inventory_tenant_visible(uuid,boolean)',
    'public.sa_stock_movement_scope()', 'public.sa_inventory_stock_scope()', 'public.sa_inventory_stock_row_visible(uuid,uuid[],boolean)']) f
  where has_function_privilege('anon', f::regprocedure, 'EXECUTE');
  if v_bad is not null then raise exception 'postcondition: anon can execute %', v_bad; end if;
end $post$;
