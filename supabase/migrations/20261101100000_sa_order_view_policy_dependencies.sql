-- ============================================================================
-- Security & Access — View Orders (supply_chain.order.view), supporting read permissions for standard Group Policies,
-- and the Order Approver reference implementation
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database, so
-- nothing here has been run against a real database (throwaway PostgreSQL 17 only:
-- supabase/tests/security/sa_order_view/run.sh).
--
-- Finding (2026-10-11, orderapp@dev.com: HQ, GUEST level 50, Order Approver active)
--   Approving worked; opening an order showed "Unauthorized". The two paths asked different questions:
--   * Approve: OrdersView asks S&A for supply_chain.order.approve; orders_approve() runs sa_require_operation. S&A
--     decides (the key is S&A-authoritative), so the Order Approver grant is enough.
--   * Order Details (view-order / track-order): the page guard required the Orders destination (S&A) AND the legacy
--     rule canOpenOrderEditor = role level <= 40 (supplyChainNav.canAccessSupplyChainView). A level-50 account fails
--     the legacy half whatever it is granted. The order row itself was readable (orders_select: party organization).
--   * No permission meant "view orders": Order Approver held exactly supply_chain.order.approve, Order Creator exactly
--     supply_chain.order.create. Reading orders had no S&A key to grant, so it fell back to the role level.
--
-- What this adds
--   1. Permission supply_chain.order.view "View orders in scope" (ordinary). Compatibility rule: role level <= 40, the
--      audience of the legacy Order Details rule (canOpenOrderEditor); no legacy permission, so it never widens.
--   2. Mode: NEW_ENFORCED where order approval is already decided by S&A (supply_chain.order.approve NEW_ENFORCED /
--      LEGACY_RETIRED, as on staging), otherwise SHADOW (the level-40 rule decides, as today). No existing mode changes.
--   3. Compatibility roles: the key is materialized on the EXISTING compatibility roles its own rule selects (level 1,
--      level <= 40, never GUEST), audited per role — the same predicate as sa_refresh_compat_role, for this one key.
--      Without it, a NEW_ENFORCED view key would take Order Details away from every level-40 account (the read-only
--      legacy store skips the lifecycle refresh; see 20261025100000). Reach is unchanged: it comes from each person's
--      existing compatibility assignment.
--   4. Supporting-read convention: table sa_permission_dependencies (operation -> the read it needs to be usable) and
--      sa_standard_policy_dependency_gaps() (standard policies missing a declared supporting read). Declarative only:
--      NO decision consults it, a custom policy is never broadened by it, and a dependency is applied to a standard
--      policy only by an explicit, audited mapping change like section 5. Seeded: order approve/create/cancel -> view.
--   5. Standard policies gain the read explicitly (the canonical mapping; existing assignments pick it up, no new or
--      duplicate grant, no assignment row touched; audited per policy and per holder):
--        Order Approver (order-approver)  = supply_chain.order.approve + supply_chain.order.view
--        Order Creator  (order-creator)   = supply_chain.order.create  + supply_chain.order.view   (when 20261028100000 is applied)
--        Supply Chain Full Access         + supply_chain.order.view (sa_extend_standard_policy)
--      Not added: create, cancel, delete, inventory, QR or any other operation. The maker/checker SoD rule
--      (order-maker-checker: create vs approve on the same order) and orders_approve()'s own checks are unchanged.
--
-- Enforcement path of the new key (all decide supply_chain.order.view in its current mode):
--   * Page guards: supply-chain/view-order (view-order, track-order) and the Orders list destination (nav-access.ts).
--   * GET /api/orders/[orderId]/access (the Order Details pre-check): S&A on the order's party organizations
--     (approval organization first, then buyer / seller / warehouse), after the orders_select RLS read.
--   * Database: NOT gated here. orders_select stays the tenant/party rule (buyer, seller or warehouse organization, or
--     HQ power user). It is read by QR, warehouse, documents, finance and messaging flows; gating it needs their full
--     reader list (like sa_inventory_stock_read_permissions) and is a separate, reviewed change — see
--     docs/security/ORDER_VIEW_AND_POLICY_DEPENDENCIES.md §6. Readiness is therefore registered as route wiring +
--     'decision_backstop' (the page guard and the access route are the decisions), never 'rls_gate'.
--
-- Not changed: no existing migration mode, no assignment / grant history, no Root Access grant, no order data, no
-- existing migration, orders_select / orders_approve / any RLS policy.
--
-- Order: requires 20260928100000..20260928130000 (Final Wave), 20261005110000 (profiles), 20261009100000 (standard
-- policy coverage + sa_extend_standard_policy). 20261028100000 (Order Creator) is optional. Mirrors
-- app/src/lib/security-access/order-view.ts and policy-dependencies.ts (lock-step test order-view.test.ts).
--
-- ONE statement on purpose: the staging runner does not carry state between statements. Repeat-safe.
-- Rollback (restores the "Unauthorized" defect; only if intended):
--   delete from public.sa_business_role_permissions rp using public.sa_permissions p
--     where rp.permission_id = p.id and p.permission_key = 'supply_chain.order.view';
--   update public.sa_standard_policy_coverage set permission_keys = array_remove(permission_keys, 'supply_chain.order.view')
--     where role_key = 'supply-chain-full-access';
--   delete from public.sa_enforcement_readiness / sa_migration_modes / sa_legacy_compat_rules where permission_key = 'supply_chain.order.view';
--   delete from public.sa_permission_dependencies; drop function public.sa_standard_policy_dependency_gaps();
--   drop table public.sa_permission_dependencies; delete from public.sa_permissions where permission_key = 'supply_chain.order.view';
-- ============================================================================

do $migration$
declare
  c_view constant text := 'supply_chain.order.view';
  v_perm uuid;
  v_role record;
  v_holder record;
  v_added integer;
  v_modes_before jsonb;
  v_assign_before text;
  v_bad text;
  v_users integer;
begin
  -- -------------------------------------------------------------------------
  -- 0. Prerequisites and before-state (variables only)
  -- -------------------------------------------------------------------------
  if to_regclass('public.sa_standard_policy_coverage') is null
     or to_regprocedure('public.sa_extend_standard_policy(text,text[],text)') is null then
    raise exception 'sa_prerequisite_missing: apply 20261009100000_sa_group_policies_full_access.sql first';
  end if;
  if to_regprocedure('public.sa_profile_active_holders(uuid)') is null then
    raise exception 'sa_prerequisite_missing: apply 20261005110000_sa_access_profiles.sql first';
  end if;
  if to_regclass('public.sa_enforcement_readiness') is null then
    raise exception 'sa_prerequisite_missing: apply 20260928130000_sa_final_legacy_retirement_support.sql first';
  end if;
  if not exists (select 1 from public.sa_permissions where permission_key = 'supply_chain.order.approve' and status = 'active') then
    raise exception 'sa_prerequisite_missing: supply_chain.order.approve';
  end if;
  if not exists (select 1 from public.sa_business_roles where role_key = 'order-approver' and source = 'template') then
    raise exception 'sa_prerequisite_missing: standard Order Approver policy (order-approver)';
  end if;
  if not exists (select 1 from public.sa_standard_policy_coverage where role_key = 'supply-chain-full-access') then
    raise exception 'sa_prerequisite_missing: Supply Chain Full Access coverage row';
  end if;

  select coalesce(jsonb_object_agg(permission_key, mode), '{}'::jsonb) into v_modes_before
  from public.sa_migration_modes where permission_key <> c_view;
  select md5(coalesce(string_agg(id::text || ':' || role_id::text || ':' || status || ':' || coalesce(effective_until::text, ''), ',' order by id), ''))
    into v_assign_before from public.sa_role_assignments;

  -- -------------------------------------------------------------------------
  -- 1. Permission, compatibility rule, mode, readiness
  -- -------------------------------------------------------------------------
  insert into public.sa_permissions(permission_key, module, resource, action, description, source, audit_sensitivity) values
   (c_view, 'supply_chain', 'order', 'view',
    'View orders in scope: the order list and order details (lines, parties, status and documents) for organizations in the data scope',
    'new', 'ordinary')
  on conflict (permission_key) do nothing;
  select id into v_perm from public.sa_permissions where permission_key = c_view and status = 'active';
  if v_perm is null then raise exception 'sa_permission_inactive: %', c_view; end if;

  insert into public.sa_legacy_compat_rules(permission_key, max_role_level, role_codes, legacy_permissions, employee_baseline, notes) values
   (c_view, 40, '{}', '{}', false,
    'View Orders: the legacy Order Details rule (canOpenOrderEditor, role level <= 40). No legacy permission, so it never widens.')
  on conflict (permission_key) do nothing;

  insert into public.sa_migration_modes(permission_key, mode, legacy_permission_key, notes)
  select c_view,
         case when public.sa_is_new_authoritative('supply_chain.order.approve') then 'NEW_ENFORCED' else 'SHADOW' end,
         null,
         'View Orders: seeded to match order approval (supply_chain.order.approve) — S&A decides wherever approval is already S&A-authoritative; elsewhere the level-40 Order Details rule decides as before.'
  on conflict (permission_key) do nothing;

  insert into public.sa_enforcement_readiness(permission_key, route_wiring, database_backstop, intentional_tightening, notes) values
   (c_view, true, 'decision_backstop',
    'Order Details and the Orders list follow the S&A decision instead of role level 40: a granted View Orders opens them at any level; compatibility roles keep level <= 40.',
    'Supply Chain page guards (supply-chain/view-order, Orders list) and GET /api/orders/[orderId]/access decide through S&A on the order''s party organizations. orders_select remains the tenant/party rule (documented follow-up).')
  on conflict (permission_key) do update set route_wiring = excluded.route_wiring, database_backstop = excluded.database_backstop,
    intentional_tightening = excluded.intentional_tightening, notes = excluded.notes;

  -- -------------------------------------------------------------------------
  -- 2. Supporting-read convention (declarative; never consulted by a decision)
  -- -------------------------------------------------------------------------
  create table if not exists public.sa_permission_dependencies (
    permission_key text not null references public.sa_permissions(permission_key) on update cascade,
    requires_key text not null references public.sa_permissions(permission_key) on update cascade,
    reason text not null check (length(btrim(reason)) >= 10),
    created_at timestamptz not null default now(),
    primary key (permission_key, requires_key),
    check (permission_key <> requires_key)
  );
  alter table public.sa_permission_dependencies enable row level security;
  alter table public.sa_permission_dependencies force row level security;
  revoke all on table public.sa_permission_dependencies from public, anon, authenticated, service_role;
  grant select on table public.sa_permission_dependencies to service_role;
  comment on table public.sa_permission_dependencies is
    'Supporting read permissions an operation needs to be usable (approve needs to see what it approves). Declarative: standard Group Policies are expected to include them explicitly (sa_standard_policy_dependency_gaps); no authorization decision reads this table and custom policies are never broadened by it.';

  insert into public.sa_permission_dependencies(permission_key, requires_key, reason) values
   ('supply_chain.order.approve', c_view, 'An approver opens the order (lines, parties, totals) before approving it.'),
   ('supply_chain.order.create',  c_view, 'A creator reviews, edits and submits its own drafts from the order list and details.'),
   ('supply_chain.order.cancel',  c_view, 'A canceller opens the order to confirm what is cancelled.')
  on conflict (permission_key, requires_key) do nothing;

  create or replace function public.sa_standard_policy_dependency_gaps()
  returns table(role_key text, permission_key text, requires_key text)
  language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
    select b.role_key, d.permission_key, d.requires_key
    from public.sa_business_roles b
    join public.sa_business_role_permissions rp on rp.role_id = b.id
    join public.sa_permissions p on p.id = rp.permission_id
    join public.sa_permission_dependencies d on d.permission_key = p.permission_key
    where b.source = 'template' and b.status = 'active'
      and not exists (
        select 1 from public.sa_business_role_permissions rp2
        join public.sa_permissions p2 on p2.id = rp2.permission_id
        where rp2.role_id = b.id and p2.permission_key = d.requires_key)
    order by 1, 2, 3
  $fn$;
  revoke all on function public.sa_standard_policy_dependency_gaps() from public, anon, authenticated;
  grant execute on function public.sa_standard_policy_dependency_gaps() to service_role;

  -- -------------------------------------------------------------------------
  -- 3. Compatibility roles selected by the key's own rule (level 1 or <= 40, never GUEST)
  -- -------------------------------------------------------------------------
  for v_role in
    select b.id, b.role_key, r.role_code, r.role_level
    from public.roles r
    join public.sa_business_roles b on b.role_key = public.sa_compat_role_key(r.role_code) and b.source = 'legacy'
    where upper(r.role_code) <> 'GUEST'
      and r.role_level is not null and (r.role_level = 1 or r.role_level <= 40)
    order by r.role_level, r.role_code
  loop
    insert into public.sa_business_role_permissions(role_id, permission_id) values (v_role.id, v_perm) on conflict do nothing;
    get diagnostics v_added = row_count;
    if v_added > 0 then
      perform public.sa_log_access_change(null, 'compat_role.permission_materialized', null, 'sa_business_role', v_role.id::text,
        jsonb_build_object('role_key', v_role.role_key, 'role_code', v_role.role_code, 'role_level', v_role.role_level,
                           'permission_key', c_view, 'migration', '20261101100000'),
        'View Orders split out of the level-40 Order Details rule; compatibility roles keep today''s audience', 'system');
    end if;
  end loop;

  -- -------------------------------------------------------------------------
  -- 4. Order Approver and Order Creator: the supporting read, explicitly (audited per policy and per holder)
  -- -------------------------------------------------------------------------
  for v_role in
    select b.id, b.role_key from public.sa_business_roles b
    where b.source = 'template' and b.role_key in ('order-approver', 'order-creator')
    order by b.role_key
  loop
    insert into public.sa_business_role_permissions(role_id, permission_id) values (v_role.id, v_perm) on conflict do nothing;
    get diagnostics v_added = row_count;
    continue when v_added = 0;
    update public.sa_business_roles set version = version + 1, updated_at = now(), updated_by = null where id = v_role.id;
    perform public.sa_log_access_change(null, 'access_profile.standard_extended', null, 'sa_business_role', v_role.id::text,
      jsonb_build_object('role_key', v_role.role_key, 'added', jsonb_build_array(c_view), 'reason', 'supporting_read'),
      'Supporting read: an order operation needs to open the orders it acts on (sa_permission_dependencies)', 'system');
    for v_holder in select * from public.sa_profile_active_holders(v_role.id) loop
      perform public.sa_log_access_change(null, 'assignment.profile_changed', v_holder.user_id, 'sa_role_assignment', v_holder.assignment_id::text,
        jsonb_build_object('role_id', v_role.id, 'added', jsonb_build_array(c_view), 'removed', '[]'::jsonb, 'organization_id', v_holder.organization_id),
        'Supporting read: an order operation needs to open the orders it acts on (sa_permission_dependencies)', 'system');
    end loop;
  end loop;

  -- -------------------------------------------------------------------------
  -- 5. Supply Chain Full Access covers the new Supply Chain permission
  -- -------------------------------------------------------------------------
  perform public.sa_extend_standard_policy('supply-chain-full-access', array[c_view],
    'View Orders (supply_chain.order.view) split out of the Order Details rule; Supply Chain Full Access covers every Supply Chain permission.');

  -- -------------------------------------------------------------------------
  -- 6. Post-conditions (any failure rolls the whole block back)
  -- -------------------------------------------------------------------------
  if (select coalesce(jsonb_object_agg(permission_key, mode), '{}'::jsonb) from public.sa_migration_modes where permission_key <> c_view)
     is distinct from v_modes_before then
    raise exception 'postcondition: an existing migration mode changed';
  end if;
  if (select mode from public.sa_migration_modes where permission_key = c_view) not in ('SHADOW','NEW_ENFORCED','LEGACY_RETIRED') then
    raise exception 'postcondition: % has no recognised mode', c_view;
  end if;
  if (select md5(coalesce(string_agg(id::text || ':' || role_id::text || ':' || status || ':' || coalesce(effective_until::text, ''), ',' order by id), ''))
      from public.sa_role_assignments) is distinct from v_assign_before then
    raise exception 'postcondition: role assignments changed';
  end if;
  if (select array_agg(p.permission_key order by p.permission_key) from public.sa_business_role_permissions rp
      join public.sa_business_roles b on b.id = rp.role_id join public.sa_permissions p on p.id = rp.permission_id
      where b.role_key = 'order-approver') is distinct from array['supply_chain.order.approve', c_view] then
    raise exception 'postcondition: order-approver must hold exactly supply_chain.order.approve and %', c_view;
  end if;
  if exists (select 1 from public.sa_business_roles where role_key = 'order-creator' and source = 'template')
     and (select array_agg(p.permission_key order by p.permission_key) from public.sa_business_role_permissions rp
          join public.sa_business_roles b on b.id = rp.role_id join public.sa_permissions p on p.id = rp.permission_id
          where b.role_key = 'order-creator') is distinct from array['supply_chain.order.create', c_view] then
    raise exception 'postcondition: order-creator must hold exactly supply_chain.order.create and %', c_view;
  end if;
  if not exists (select 1 from public.sa_business_role_permissions rp join public.sa_business_roles b on b.id = rp.role_id
                 where b.role_key = 'supply-chain-full-access' and rp.permission_id = v_perm) then
    raise exception 'postcondition: Supply Chain Full Access must hold %', c_view;
  end if;
  select string_agg(b.role_key, ', ') into v_bad
  from public.sa_business_role_permissions rp
  join public.sa_business_roles b on b.id = rp.role_id and b.source = 'legacy'
  where rp.permission_id = v_perm
    and coalesce((select r.role_level from public.roles r where public.sa_compat_role_key(r.role_code) = b.role_key limit 1), 999) > 40;
  if v_bad is not null then raise exception 'postcondition: View Orders reached a compatibility role above level 40: %', v_bad; end if;
  select string_agg(g.role_key || ':' || g.permission_key, ', ') into v_bad
  from public.sa_standard_policy_dependency_gaps() g
  where g.role_key in ('order-approver', 'order-creator', 'supply-chain-full-access');
  if v_bad is not null then raise exception 'postcondition: supporting reads missing: %', v_bad; end if;
  if exists (select 1 from public.sa_sod_rules where c_view in (left_key, right_key)) then
    raise exception 'postcondition: View Orders must not take part in a separation-of-duties rule';
  end if;

  select count(distinct a.user_id) into v_users
  from public.sa_role_assignments a
  join public.sa_business_role_permissions rp on rp.role_id = a.role_id and rp.permission_id = v_perm
  where a.status = 'active' and (a.effective_until is null or a.effective_until > now());
  raise notice 'people holding % through an active assignment: % (mode %)', c_view, v_users,
    (select mode from public.sa_migration_modes where permission_key = c_view);
  for v_bad in select g.role_key || ': ' || g.permission_key || ' -> ' || g.requires_key from public.sa_standard_policy_dependency_gaps() g loop
    raise notice 'standard policy without a declared supporting read (not changed here): %', v_bad;
  end loop;
end $migration$;
