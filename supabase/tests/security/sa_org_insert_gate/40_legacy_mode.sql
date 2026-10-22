-- Environments where platform.organization.manage is still LEGACY_ENFORCED: the legacy rule decides, unchanged.
begin;
update public.sa_migration_modes set mode = 'LEGACY_ENFORCED' where permission_key = 'platform.organization.manage';
select smt.as_user(8);
set local role authenticated;
select smt.expect(smt.add_org('LG-DT008', 'DIST', 1) is null, 'legacy: level-10 HQ admin creates a distributor');
reset role;
select smt.as_user(1);
select set_config('sa_cache.epoch', 'legacy-1', true);
set local role authenticated;
select smt.expect(smt.add_org('LG-DT001', 'DIST', 1) like '42501%', 'legacy: non-admin S&A holder still denied (S&A not authoritative yet)');
rollback;
