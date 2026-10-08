-- Before 20261026100000: no Root Access anywhere; record everyone's decisions as the regression baseline.
select saf.expect(to_regclass('public.sa_root_access_grants') is null, 'no Root Access table before the migration');
select saf.expect(to_regprocedure('public.sa_actor_is_root(uuid)') is null, 'no Root Access helper before the migration');
-- Root cause: even the legacy Super Admin is denied outside the organizations its explicit grants cover.
select saf.expect((saf.decide(saf.u(1), 'finance.payment.approve', saf.o(4))->>'decision') = 'DENY', 'legacy Super Admin has no implicit system-wide access in the evaluator');
create table saf.baseline as select * from saf.grid();
select saf.expect((select count(*) from saf.baseline) > 500, 'baseline grid recorded');
