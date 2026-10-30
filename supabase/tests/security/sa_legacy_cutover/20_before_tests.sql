-- Negative control on the unpatched staging schema: documents the findings the migrations close.
select pht.expect(pht.has(2, 'customer.loyalty.adjust'), 'before: Legacy USER alone grants customer.loyalty.adjust (compatibility policy authorizes)');
select pht.expect(pht.has(2, 'finance.report.view_sensitive'), 'before: Legacy USER alone grants finance.report.view_sensitive');
select pht.expect(pht.has(4, 'security.role.assign'), 'before: Legacy SA without Root grants security.role.assign');
select pht.expect(pht.has(5, 'ecommerce.channel.manage'), 'before: Customer & Growth Full Access grants Payment Gateway administration');
select pht.expect(pht.has(1, 'ecommerce.channel.manage'), 'before: Alif-like user holds Payment Gateway administration through C&G Full Access');
select pht.expect(to_regprocedure('public.sa_retire_legacy_compat_role(text,text,boolean)') is null, 'before: no legacy cutover switch exists');
-- Baselines that must not change.
select pht.expect(not pht.has(5, 'customer.loyalty.adjust', 3), 'cross-organization: C&G Full Access in HQ does not authorize another tenant');
select pht.expect(pht.has(6, 'finance.ledger.view'), 'before: user 6 holds finance.ledger.view only through Legacy USER (its explicit grant expired)');
select pht.expect(not pht.has(7, 'customer.crm.view'), 'inactive data scope authorizes nothing');
select pht.expect(pht.has(3, 'security.role.assign'), 'Root Administrator holds security.role.assign');
select pht.expect(pht.has(9, 'reporting.analytics.view', 1) and not pht.has(9, 'reporting.analytics.view', 3), 'multi-membership: Reporting Viewer only inside its organization tree');
