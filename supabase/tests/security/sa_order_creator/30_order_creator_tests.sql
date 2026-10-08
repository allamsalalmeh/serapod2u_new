-- After 20261028100000 (applied twice). supply_chain.order.create/approve/cancel are LEGACY_RETIRED unless stated.
-- ── Policy definition ───────────────────────────────────────────────────────────────────────────────────────────
select saf.expect((select count(*) from public.sa_business_roles where role_key = 'order-creator') = 1, 'one Order Creator after two applications');
select saf.expect((select source = 'template' and status = 'active' and applicable_org_types = array['HQ','DIST','SHOP']
  from public.sa_business_roles where role_key = 'order-creator'), 'standard, published, HQ/distributor/shop');
select saf.expect(saf.keys(saf.role('order-creator')) = array['supply_chain.order.create'], 'Order Creator holds exactly order creation');
select saf.expect(saf.keys(saf.role('order-approver')) = array['supply_chain.order.approve'], 'Order Approver unchanged');
select saf.expect(not has_function_privilege('anon', 'public.sa_actor_may_create_h2m()', 'EXECUTE'), 'anon cannot call the H2M rule');
select saf.expect((select count(*) from public.sa_role_assignments where role_id = saf.role('order-creator')) = 0, 'the migration assigns nobody');

-- ── 1. No Order Creator → denied ────────────────────────────────────────────────────────────────────────────────
select saf.as_api_user(saf.u(21)); set role authenticated;
select saf.expect(saf.save(saf.oid(10), saf.o(4)) like 'h2m_orders_require_order_create_access%', 'no grant: RPC refuses H2M');
select saf.expect(saf.try(format($q$insert into public.orders(id, order_type, company_id, buyer_org_id, seller_org_id, status) values (%L, 'H2M', %L, %L, %L, 'draft')$q$,
  saf.oid(11), saf.o(1), saf.o(1), saf.o(4))) ~ '(sa_authorization_required|row-level security)', 'no grant: direct insert refused (write guard or RLS)');
reset role; select saf.as_owner();
-- Order Approver only (order@dev.com) → denied.
select saf.as_api_user(saf.u(20)); set role authenticated;
select saf.expect(saf.save(saf.oid(12), saf.o(4)) like 'h2m_orders_require_order_create_access%', 'Order Approver only: create refused');
reset role; select saf.as_owner();
-- Legacy level 10 without any S&A grant no longer creates once retired (S&A decides, the API already required it).
select saf.as_api_user(saf.u(3)); set role authenticated;
select saf.expect(saf.save(saf.oid(13), saf.o(4)) like 'h2m_orders_require_order_create_access%', 'retired: role level alone is not authority');
reset role; select saf.as_owner();

-- ── 2-5. Grant Order Creator → create draft and submit ─────────────────────────────────────────────────────────
select public.sa_assign_role(saf.u(1), saf.u(20), saf.role('order-creator'), saf.o(1), array[saf.s(1)], now(), null, 'Creates HQ orders');
select saf.expect((saf.decide(saf.u(20), 'supply_chain.order.create', saf.o(1))->>'decision') = 'ALLOW', 'granted: S&A allows creation');
select saf.expect((saf.decide(saf.u(20), 'supply_chain.order.cancel', saf.o(1))->>'decision') = 'DENY', 'granted: cancel not implied');
select saf.as_api_user(saf.u(20)); set role authenticated;
select saf.expect(saf.save(saf.oid(20), saf.o(4)) = 'OK:draft', 'granted: H2M draft created through the RPC');
select saf.expect(saf.save(saf.oid(21), saf.o(4), 'submitted') = 'OK:submitted', 'granted: H2M created and submitted');
select saf.expect((select order_type::text || '|' || buyer_org_id || '|' || warehouse_org_id || '|' || created_by from public.orders where id = saf.oid(20))
  = 'H2M|' || saf.o(1) || '|' || saf.o(2) || '|' || saf.u(20), 'type, buyer, warehouse and creator derived on the server');
-- Business rules unchanged: own organization is not a valid seller; unknown seller refused.
select saf.expect(saf.save(saf.oid(22), saf.o(1)) like 'invalid_seller_organization%', 'seller rule unchanged (own org)');
select saf.expect(saf.save(saf.oid(23), gen_random_uuid()) like 'invalid_seller_organization%', 'seller rule unchanged (unknown org)');
-- ── 6-7. Approve / cancel stay independent ─────────────────────────────────────────────────────────────────────
select saf.expect(saf.try(format($q$update public.orders set status = 'approved' where id = %L$q$, saf.oid(21))) like 'order_approval_requires_workflow%', 'approve only through the workflow');
reset role; select saf.as_owner();
select public.sa_revoke_assignment(saf.u(1), saf.assignment(saf.u(20), 'order-approver'), 'test: creator without approval');
select saf.as_api_user(saf.u(20)); set role authenticated;
select saf.expect(saf.try(format($q$update public.orders set status = 'cancelled' where id = %L$q$, saf.oid(21))) like 'sa_authorization_required%', 'cancel denied without order.cancel');
select saf.expect((select status from public.orders where id = saf.oid(21)) = 'submitted', 'order left submitted');
reset role; select saf.as_owner();
select saf.expect((saf.decide(saf.u(20), 'supply_chain.order.approve', saf.o(1))->>'decision') = 'DENY', 'Order Creator does not imply approval');

-- ── 8. Revoke → removed ──────────────────────────────────────────────────────────────────────────────────────────
select public.sa_revoke_assignment(saf.u(1), saf.assignment(saf.u(20), 'order-creator'), 'no longer creates orders');
select saf.as_api_user(saf.u(20)); set role authenticated;
select saf.expect(saf.save(saf.oid(30), saf.o(4)) like 'h2m_orders_require_order_create_access%', 'revoked: create refused');
reset role; select saf.as_owner();
-- Expired grant → removed.
select public.sa_assign_role(saf.u(1), saf.u(21), saf.role('order-creator'), saf.o(1), array[saf.s(1)], now(), null, 'Creates HQ orders');
select saf.as_api_user(saf.u(21)); set role authenticated;
select saf.expect(saf.save(saf.oid(31), saf.o(4)) = 'OK:draft', 'current grant: create allowed');
reset role; select saf.as_owner();
update public.sa_role_assignments set effective_from = now() - interval '2 days', effective_until = now() - interval '1 day'
  where id = saf.assignment(saf.u(21), 'order-creator');
select saf.as_api_user(saf.u(21)); set role authenticated;
select saf.expect(saf.save(saf.oid(32), saf.o(4)) like 'h2m_orders_require_order_create_access%', 'expired: create refused');
reset role; select saf.as_owner();

-- ── 9. Scope: a grant limited to a warehouse does not reach HQ ──────────────────────────────────────────────────
select set_config('saf.scope_grant', saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], now(), null, 'Balakong only')$q$,
  saf.u(1), saf.u(24), saf.role('order-creator'), saf.o(1), saf.s(2))), false);
select saf.expect(current_setting('saf.scope_grant') = 'OK', 'warehouse-scoped Order Creator grant recorded: ' || current_setting('saf.scope_grant'));
select saf.as_api_user(saf.u(24)); set role authenticated;
select saf.expect(saf.save(saf.oid(40), saf.o(4)) like 'h2m_orders_require_order_create_access%', 'warehouse-scoped grant does not authorize HQ H2M');
reset role; select saf.as_owner();

-- ── Root Administrator ─────────────────────────────────────────────────────────────────────────────────────────
select saf.expect(public.sa_bootstrap_root_access(saf.u(23), 'Initial Root Administrator for order tests (SEC-200)') is not null, 'Root bootstrapped');
select saf.as_api_user(saf.u(23)); set role authenticated;
select saf.expect(saf.save(saf.oid(50), saf.o(4)) = 'OK:draft', 'Root Administrator creates H2M through the Root Access model');
reset role; select saf.as_owner();

-- ── 10. D2H / organization rules ───────────────────────────────────────────────────────────────────────────────
select saf.as_api_user(saf.u(22)); set role authenticated;
select saf.expect(saf.try(format($q$insert into public.orders(id, order_type, company_id, buyer_org_id, seller_org_id, status) values (%L, 'D2H', %L, %L, %L, 'draft')$q$,
  saf.oid(60), saf.o(1), saf.o(11), saf.o(1))) like 'sa_authorization_required%', 'distributor without grant: D2H refused');
reset role; select saf.as_owner();
select public.sa_assign_role(saf.u(1), saf.u(22), saf.role('order-creator'), saf.o(11), array[saf.s(11)], now(), null, 'Distributor orders to HQ');
select saf.as_api_user(saf.u(22)); set role authenticated;
select saf.expect(saf.try(format($q$insert into public.orders(id, order_type, company_id, buyer_org_id, seller_org_id, status) values (%L, 'D2H', %L, %L, %L, 'draft')$q$,
  saf.oid(61), saf.o(1), saf.o(11), saf.o(1))) = 'OK', 'distributor with Order Creator: D2H allowed (rules unchanged)');
select saf.expect(saf.try(format($q$insert into public.orders(id, order_type, company_id, buyer_org_id, seller_org_id, status) values (%L, 'H2M', %L, %L, %L, 'draft')$q$,
  saf.oid(62), saf.o(1), saf.o(11), saf.o(4))) like '%row-level security%', 'distributor can never create H2M');
select saf.expect(saf.save(saf.oid(63), saf.o(1)) = 'OK:draft', 'distributor RPC create derives D2H');
select saf.expect((select order_type::text from public.orders where id = saf.oid(63)) = 'D2H', 'order type derived from organization');
reset role; select saf.as_owner();
select saf.expect(saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], now(), null, 'manufacturer attempt')$q$,
  saf.u(23), saf.u(8), saf.role('order-creator'), saf.o(4), saf.s(4))) like 'sa_profile_not_applicable%', 'not grantable to a manufacturer, even by Root');

-- ── Legacy mode: nothing broadened ─────────────────────────────────────────────────────────────────────────────
update public.sa_migration_modes set mode = 'LEGACY_ENFORCED' where permission_key = 'supply_chain.order.create';
select public.sa_assign_role(saf.u(1), saf.u(20), saf.role('order-creator'), saf.o(1), array[saf.s(1)], now(), null, 'Legacy-mode check');
select saf.as_api_user(saf.u(20)); set role authenticated;
select saf.expect(saf.save(saf.oid(70), saf.o(4)) like 'h2m_orders_require_order_create_access%', 'legacy mode: level 50 refused even with the policy');
reset role; select saf.as_owner();
select saf.as_api_user(saf.u(3)); set role authenticated;
select saf.expect(saf.save(saf.oid(71), saf.o(4)) = 'OK:draft', 'legacy mode: level 10 HQ creates as before');
reset role; select saf.as_owner();
select saf.as_api_user(saf.u(4)); set role authenticated;
select saf.expect(saf.save(saf.oid(72), saf.o(4)) like 'organization_type_cannot_create_orders%', 'warehouse organization still cannot create orders');
reset role; select saf.as_owner();
