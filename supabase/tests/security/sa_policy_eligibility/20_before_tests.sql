-- Negative control on the UNPATCHED schema: the gaps the eligibility migration closes really exist. Rolled back.
begin;
-- An HQ policy with no eligibility list is grantable to a Distributor and a Shop membership (empty list = "anywhere").
select saf.expect(saf.grant_ok(23, 22, 'warehouse-manager', 11, 11) = 'OK', 'before: HQ Warehouse Manager grantable to a Distributor');
select saf.expect(saf.grant_ok(23, 33, 'order-approver', 6, 7) = 'OK', 'before: Order Approver grantable to a Shop');
-- Consumers count as "internal" staff.
select saf.expect(saf.grant_ok(23, 30, 'order-approver', 30, 30) = 'OK', 'before: an End User membership receives a Group Policy');
-- Access-request approval never checked applicability at all: a Shop member obtains an HQ-only Full Access policy.
select saf.expect(saf.approve(23, saf.request(12, 'supply-chain-full-access', 6, 7)) = 'OK', 'before: access-request approval grants an internal-only policy to a Shop');
select saf.expect(saf.active(12, 'supply-chain-full-access') = 1, 'before: the Shop member now holds it');
-- A custom policy without metadata goes anywhere.
select saf.expect(saf.grant_ok(23, 8, 'saf-custom-any', 4, 4) = 'OK', 'before: unclassified custom policy grantable to a Manufacturer');
rollback;
