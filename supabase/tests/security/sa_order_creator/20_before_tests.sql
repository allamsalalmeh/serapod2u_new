-- Negative control on the UNPATCHED schema: reproduces the order@dev.com defect.
select saf.expect(saf.role('order-creator') is null, 'no Order Creator policy exists before the migration');
select saf.expect(saf.keys(saf.role('order-approver')) = array['supply_chain.order.approve'], 'Order Approver holds only order approval');
select saf.expect(not exists (select 1 from public.sa_business_roles r join public.sa_business_role_permissions bp on bp.role_id = r.id
  join public.sa_permissions p on p.id = bp.permission_id where p.permission_key = 'supply_chain.order.create' and r.source = 'template'
  and r.role_key <> 'supply-chain-full-access'), 'only Supply Chain Full Access grants order creation before the migration');

-- Order Approver only: S&A denies creation (correct).
select saf.expect((saf.decide(saf.u(20), 'supply_chain.order.create', saf.o(1))->>'decision') = 'DENY', 'Order Approver does not imply order creation');
-- Root cause: even an explicit S&A grant of order creation cannot create an H2M order at level 50.
select public.sa_assign_role(saf.u(1), saf.u(21), saf.role('supply-chain-full-access'), saf.o(1), array[saf.s(1)], now(), null, 'Root-cause reproduction');
select saf.expect((saf.decide(saf.u(21), 'supply_chain.order.create', saf.o(1))->>'decision') = 'ALLOW', 'S&A allows the explicitly granted person');
select saf.as_api_user(saf.u(21)); set role authenticated;
select saf.expect(saf.save(saf.oid(1), saf.o(4)) like 'h2m_orders_require_hq_access_level_40%', 'DEFECT: legacy level 40 overrides the S&A grant in the RPC');
select saf.expect(saf.try(format($q$insert into public.orders(id, order_type, company_id, buyer_org_id, seller_org_id, status) values (%L, 'H2M', %L, %L, %L, 'draft')$q$,
  saf.oid(2), saf.o(1), saf.o(1), saf.o(4))) like '%row-level security%', 'DEFECT: legacy level 40 overrides the S&A grant in orders_insert');
reset role; select saf.as_owner();
select public.sa_revoke_assignment(saf.u(1), saf.assignment(saf.u(21), 'supply-chain-full-access'), 'end of reproduction');
select saf.expect((saf.decide(saf.u(21), 'supply_chain.order.create', saf.o(1))->>'decision') = 'DENY', 'reproduction grant revoked');
