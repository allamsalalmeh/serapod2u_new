-- Negative control on the unpatched schema: reproduces the defect's precondition.
select saf.expect(not exists (select 1 from public.sa_permissions where permission_key = 'supply_chain.order.view'), 'before: no View Orders permission');
select saf.expect(saf.keys(saf.role('order-approver')) = array['supply_chain.order.approve'], 'before: Order Approver = approval only');
select saf.expect(saf.keys(saf.role('order-creator')) = array['supply_chain.order.create'], 'before: Order Creator = creation only');
select saf.expect(saf.d(40, 'supply_chain.order.approve', 1) = 'ALLOW', 'before: the approver may approve HQ orders');
select saf.expect(coalesce(saf.d(40, 'supply_chain.order.view', 1), 'DENY') <> 'ALLOW', 'before: nothing lets the approver view orders');
select saf.expect(to_regclass('public.sa_permission_dependencies') is null, 'before: no dependency convention');
