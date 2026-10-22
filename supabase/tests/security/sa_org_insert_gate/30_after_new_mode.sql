-- After 20261213100000, platform.organization.manage LEGACY_RETIRED (staging).
create temp table og_cases(n int, code text, typ text, parent int, allowed boolean, label text);
grant all on og_cases to authenticated;
insert into og_cases values
  (1, 'OK-DT001', 'DIST', 1,    true,  'HQ holder: distributor under own HQ'),
  (1, 'OK-SH001', 'SHOP', 4,    true,  'HQ holder: shop under DIST1 (descendant of HQ)'),
  (1, 'OK-WH001', 'WH',   1,    true,  'HQ holder: warehouse under own HQ'),
  (1, 'OK-MF001', 'MFG',  1,    true,  'HQ holder: manufacturer under own HQ'),
  (1, 'OK-MF002', 'MFG',  null, true,  'HQ holder: parentless manufacturer (anchored at own HQ)'),
  (1, 'OK-HQ001', 'HQ',   null, true,  'HQ holder: parentless HQ (anchored at own HQ)'),
  (1, 'NO-DT001', 'DIST', 8,    false, 'HQ holder: distributor under the UNRELATED HQ'),
  (2, 'OK-SH002', 'SHOP', 4,    true,  'DIST1 holder: shop under own distributor'),
  (2, 'NO-DT002', 'DIST', 1,    false, 'DIST1 holder: distributor under the HQ (above its scope)'),
  (2, 'NO-HQ002', 'HQ',   null, false, 'DIST1 holder: parentless HQ'),
  (2, 'NO-SH003', 'SHOP', 9,    false, 'DIST1 holder: shop under unrelated distributor'),
  (3, 'NO-DT003', 'DIST', 1,    false, 'HQ employee without the permission: distributor'),
  (3, 'NO-HQ003', 'HQ',   null, false, 'HQ employee without the permission: parentless HQ'),
  (4, 'OK-DT004', 'DIST', 8,    true,  'Unrelated company holder: distributor under its own HQ'),
  (4, 'NO-DT004', 'DIST', 1,    false, 'Unrelated company holder: distributor under company A HQ'),
  (5, 'OK-DT005', 'DIST', 1,    true,  'Root Access holder: distributor under HQ'),
  (5, 'OK-HQ005', 'HQ',   null, true,  'Root Access holder: parentless HQ'),
  (6, 'NO-MF006', 'MFG',  null, false, 'Standalone MFG holder: parentless manufacturer (chain has no HQ)'),
  (6, 'NO-DT006', 'DIST', 1,    false, 'Standalone MFG holder: distributor under company A HQ'),
  (7, 'NO-DT007', 'DIST', 1,    false, 'Inactive HQ holder: distributor'),
  (8, 'NO-DT008', 'DIST', 1,    false, 'Legacy level-10 HQ admin without the S&A permission (legacy no longer decides)');

do $cases$
declare c record; v text;
begin
  for c in select * from og_cases order by n, code loop
    perform smt.as_user(c.n);
    perform set_config('sa_cache.epoch', c.code, true);
    execute 'set local role authenticated';
    v := smt.add_org(c.code, c.typ, c.parent);
    execute 'reset role';
    if c.allowed then
      perform smt.expect(v is null, format('user %s allowed: %s%s', c.n, c.label, coalesce(' — got ' || v, '')));
    else
      perform smt.expect(v like '42501%', format('user %s denied (42501): %s%s', c.n, c.label, coalesce(' — got ' || v, ' — got success')));
    end if;
  end loop;
end $cases$;

-- Side effects of an allowed create still run: scope definition and the shop → distributor link.
select smt.expect(exists (select 1 from public.sa_scope_definitions sd join public.organizations o on o.id = sd.organization_id
  where o.org_code = 'OK-DT001' and sd.scope_type = 'organization'), 'new distributor received its organization scope definition');
select smt.expect(exists (select 1 from public.shop_distributors sd join public.organizations o on o.id = sd.shop_id
  where o.org_code = 'OK-SH001' and sd.distributor_id = smt.o(4)), 'new shop under DIST1 was linked to DIST1 (trigger ran as caller)');
-- Hierarchy rules still apply on top of the gate.
begin;
select smt.as_user(1);
set local role authenticated;
select smt.expect(smt.add_org('NO-DT011', 'DIST', 6) like 'P0001%', 'hierarchy trigger still rejects a distributor under a shop');
select smt.expect(smt.add_org('NO-DT010', 'DIST', null) like 'P0001%', 'hierarchy trigger still rejects a parentless distributor');
rollback;
-- Context helper never leaks beyond an id and is not callable by anon.
select smt.expect(not has_function_privilege('anon', 'public.sa_org_create_context(uuid)', 'EXECUTE'), 'anon cannot execute sa_org_create_context');
begin;
select smt.as_user(4);
set local role authenticated;
select smt.expect(public.sa_org_create_context(null) = smt.o(8), 'parentless context for the unrelated company is its own HQ');
select smt.expect(public.sa_org_create_context(smt.o(4)) = smt.o(4), 'context with a parent is the parent');
rollback;
