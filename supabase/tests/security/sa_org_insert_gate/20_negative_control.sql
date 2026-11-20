-- Unpatched staging schema: reproduces the Add Organization 42501 for a correctly scoped HQ holder.
select smt.expect((select mode from public.sa_migration_modes where permission_key = 'platform.organization.manage') = 'LEGACY_RETIRED',
  'platform.organization.manage is LEGACY_RETIRED (as on staging)');
begin;
select smt.as_user(1);
set local role authenticated;
select smt.expect(smt.add_org('NC-DT001', 'DIST', 1) like '42501%new row violates row-level security policy%',
  'before: HQ Full Access holder cannot create a distributor under the HQ (42501, the reported failure)');
select smt.expect(smt.add_org('NC-HQ001', 'HQ', null) like '42501%', 'before: HQ Full Access holder cannot create a parentless HQ');
rollback;
