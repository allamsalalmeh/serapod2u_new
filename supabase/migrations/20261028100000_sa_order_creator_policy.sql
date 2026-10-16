-- ============================================================================
-- Security & Access — standard "Order Creator" Group Policy and an H2M rule
-- that follows Security & Access once order creation is S&A-authoritative
-- ----------------------------------------------------------------------------
-- Requires 20261005110000_sa_access_profiles.sql (applicability columns),
-- 20261007100200_save_order_with_items_rpc.sql and
-- 20260621_h2m_hq_access_level_40.sql (orders_insert).
--
-- Findings (2026-10-08 investigation, order@dev.com)
--   * supply_chain.order.create is registered and LEGACY_RETIRED, but NO
--     standard Group Policy grants it except Supply Chain Full Access. Order
--     Approver holds only supply_chain.order.approve (by design: the
--     order-maker-checker SoD rule separates the two). Administrators had
--     nothing narrower to grant.
--   * With the permission retired, the server already decides creation by
--     S&A (/api/orders/save, D2H routes, sa_orders_api_write_guard), yet three
--     H2M checks still demanded legacy role_level <= 40 regardless of S&A:
--     the save_order_with_items RPC, the orders_insert RLS policy and the UI.
--     An HQ person explicitly granted order creation was therefore refused.
--
-- Changes (additive / idempotent)
--   1. Standard profile "Order Creator" (order-creator): ONLY
--      supply_chain.order.create. Applies to HQ, distributor and shop
--      organizations (the organization types the order workflow lets create
--      an order: H2M, D2H, S2D). No approval, cancellation, deletion, stock,
--      warehouse or security permission.
--   2. sa_actor_may_create_h2m(): the single H2M rule.
--        - actor's organization is HQ (unchanged), AND
--        - while supply_chain.order.create is LEGACY_ENFORCED / SHADOW:
--          role_level <= 40 exactly as before;
--        - once it is NEW_ENFORCED / LEGACY_RETIRED: the S&A decision for
--          supply_chain.order.create in the actor's own organization (Root
--          Access answers through the evaluator as everywhere else).
--      Nothing is broadened in legacy modes; in S&A modes S&A decides, which
--      the API and the write-guard trigger already require anyway.
--   3. orders_insert RLS and save_order_with_items use that rule instead of
--      the hard-coded level check. The organization, seller, product and
--      warehouse rules of both are unchanged.
--
-- No migration mode is changed. Nothing is assigned to anyone.
-- Rollback: restore orders_insert from 20260621_h2m_hq_access_level_40.sql
-- and save_order_with_items from 20261007100200_save_order_with_items_rpc.sql;
-- drop the profile row if it is unassigned.
-- ============================================================================

-- 1. Standard profile ---------------------------------------------------------
insert into public.sa_business_roles(role_key, name, description, source, status, applicable_org_types)
values ('order-creator', 'Order Creator',
        'Creates, edits and submits orders for its organization (H2M at HQ, D2H, S2D). Order types, sellers, products and stock follow the existing Supply Chain rules. Does not approve, cancel or delete orders.',
        'template', 'active', array['HQ','DIST','SHOP'])
on conflict (role_key) do nothing;

do $seed$
begin
  if not exists (select 1 from public.sa_permissions where permission_key = 'supply_chain.order.create' and status = 'active') then
    raise exception 'supply_chain.order.create is not an active permission; Order Creator cannot be seeded';
  end if;
  insert into public.sa_business_role_permissions(role_id, permission_id)
  select br.id, p.id from public.sa_business_roles br
  join public.sa_permissions p on p.permission_key = 'supply_chain.order.create'
  where br.role_key = 'order-creator'
  on conflict do nothing;
  -- A standard policy is exactly its reviewed list: fail instead of shipping a widened copy.
  if (select array_agg(p.permission_key order by p.permission_key)
      from public.sa_business_role_permissions bp
      join public.sa_business_roles br on br.id = bp.role_id
      join public.sa_permissions p on p.id = bp.permission_id
      where br.role_key = 'order-creator') is distinct from array['supply_chain.order.create'] then
    raise exception 'order-creator must hold exactly supply_chain.order.create';
  end if;
end $seed$;

-- 2. The H2M rule -------------------------------------------------------------
create or replace function public.sa_actor_may_create_h2m()
returns boolean language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(
    public.get_org_type(public.current_user_org_id()) = 'HQ'
    and case when public.sa_is_new_authoritative('supply_chain.order.create')
             then public.sa_actor_has_permission(auth.uid(), 'supply_chain.order.create',
                    jsonb_build_object('organization_id', public.current_user_org_id()))
             else public.current_user_role_level() <= 40 end,
    false)
$$;
revoke all on function public.sa_actor_may_create_h2m() from public, anon;
grant execute on function public.sa_actor_may_create_h2m() to authenticated, service_role;
comment on function public.sa_actor_may_create_h2m() is
  'H2M creation rule: HQ organization, and legacy role_level <= 40 until supply_chain.order.create is S&A-authoritative, then the S&A decision in the actor''s organization.';

-- 3a. orders_insert (only the H2M clause changes) ---------------------------
drop policy if exists orders_insert on public.orders;
create policy orders_insert
on public.orders
for insert
to authenticated
with check (
    (
        buyer_org_id = public.current_user_org_id()
        or seller_org_id = public.current_user_org_id()
        or (
            public.get_org_type(public.current_user_org_id()) = 'HQ'
            and public.is_power_user()
            and company_id = public.get_company_id(public.current_user_org_id())
        )
    )
    and (
        order_type <> 'H2M'
        or public.sa_actor_may_create_h2m()
    )
);
comment on policy orders_insert on public.orders is
    'Preserves existing D2H/S2D insert rules; H2M additionally requires sa_actor_may_create_h2m() (HQ, legacy level 40 or the S&A decision once authoritative).';

-- 3b. save_order_with_items: replace the level check in place -----------------
-- Only the H2M block changes; the rest of the function is kept byte for byte.
-- Repeat-safe: a definition that already calls the rule is left alone.
do $rpc$
declare
  v_def text;
  v_old constant text := $old$      SELECT r.role_level INTO v_role_level
      FROM public.users u
      JOIN public.roles r ON r.role_code = u.role_code
      WHERE u.id = v_actor;
      IF v_role_level IS NULL OR v_role_level > 40 THEN
        RAISE EXCEPTION 'h2m_orders_require_hq_access_level_40' USING ERRCODE = '42501';
      END IF;$old$;
  v_new constant text := $new$      -- HQ + legacy level 40, or the S&A decision once supply_chain.order.create is authoritative
      IF NOT public.sa_actor_may_create_h2m() THEN
        RAISE EXCEPTION 'h2m_orders_require_order_create_access' USING ERRCODE = '42501';
      END IF;$new$;
begin
  v_def := pg_get_functiondef('public.save_order_with_items(uuid,text,text,timestamptz,uuid,integer,numeric,integer,boolean,boolean,boolean,boolean,text,jsonb)'::regprocedure);
  if position('sa_actor_may_create_h2m' in v_def) > 0 then return; end if;
  if position(v_old in v_def) = 0 then
    raise exception 'save_order_with_items does not contain the expected H2M level check; refusing to rewrite it';
  end if;
  execute replace(v_def, v_old, v_new);
end $rpc$;
