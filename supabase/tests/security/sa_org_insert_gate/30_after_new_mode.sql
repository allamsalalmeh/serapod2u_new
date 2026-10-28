-- After 20261213100000, platform.organization.manage LEGACY_RETIRED (staging).
create temp table og_cases(n int, code text, typ text, parent int, allowed boolean, label text);
grant all on og_cases to authenticated;
insert into og_cases values
  -- HQ-scoped organization administrator: every business-valid create in its own company.
  (1, 'OK-DT001', 'DIST', 1,    true,  'HQ holder: distributor under own HQ'),
  (1, 'OK-SH001', 'SHOP', 4,    true,  'HQ holder: shop under DIST1'),
  (1, 'OK-WH001', 'WH',   1,    true,  'HQ holder: warehouse under own HQ'),
  (1, 'OK-WH002', 'WH',   4,    true,  'HQ holder: warehouse under DIST1'),
  (1, 'OK-MF001', 'MFG',  1,    true,  'HQ holder: manufacturer under own HQ'),
  (1, 'OK-MF002', 'MFG',  null, true,  'HQ holder: parentless manufacturer (anchored at own HQ)'),
  (1, 'NO-HQ001', 'HQ',   null, false, 'HQ holder: parentless HQ (new tenant, Root only)'),
  (1, 'NO-DT001', 'DIST', 8,    false, 'HQ holder: distributor under the UNRELATED HQ'),
  (1, 'NO-SH011', 'SHOP', 1,    false, 'HQ holder: invalid pair SHOP under HQ (trigger allows it)'),
  (1, 'NO-DT012', 'DIST', 7,    false, 'HQ holder: invalid pair DIST under MFG (trigger allows it)'),
  (1, 'NO-WH013', 'WH',   7,    false, 'HQ holder: invalid pair WH under MFG (trigger allows it)'),
  (1, 'NO-SH014', 'SHOP', 7,    false, 'HQ holder: invalid pair SHOP under MFG (trigger allows it)'),
  (1, 'NO-SH015', 'SHOP', 2,    false, 'HQ holder: invalid pair SHOP under WH (trigger allows it)'),
  (1, 'NO-EU016', 'END_USER', 1, false, 'HQ holder: END_USER is created only by system flows'),
  (1, 'NO-SH017', 'SHOP', 11,   false, 'HQ holder: shop under an INACTIVE distributor'),
  -- Grants scoped below an HQ never create organizations.
  (2, 'NO-SH002', 'SHOP', 4,    false, 'DIST1-scoped holder: shop under own distributor'),
  (2, 'NO-WH002', 'WH',   4,    false, 'DIST1-scoped holder: warehouse under own distributor'),
  (2, 'NO-DT002', 'DIST', 1,    false, 'DIST1-scoped holder: distributor under the HQ'),
  (2, 'NO-HQ002', 'HQ',   null, false, 'DIST1-scoped holder: parentless HQ'),
  (2, 'NO-SH003', 'SHOP', 9,    false, 'DIST1-scoped holder: shop under unrelated distributor'),
  (9, 'NO-DT009', 'DIST', 7,    false, 'MFG partner (legacy-hq at own MFG): distributor under own MFG'),
  (9, 'NO-WH009', 'WH',   7,    false, 'MFG partner: warehouse under own MFG'),
  (9, 'NO-SH009', 'SHOP', 7,    false, 'MFG partner: shop under own MFG'),
  (9, 'NO-MF009', 'MFG',  null, false, 'MFG partner: parentless manufacturer'),
  (9, 'NO-MF019', 'MFG',  1,    false, 'MFG partner: manufacturer under the HQ'),
  (9, 'NO-DT019', 'DIST', 1,    false, 'MFG partner: distributor under the HQ'),
  (3, 'NO-DT003', 'DIST', 1,    false, 'HQ employee without the permission: distributor'),
  (3, 'NO-HQ003', 'HQ',   null, false, 'HQ employee without the permission: parentless HQ'),
  -- Cross-company isolation.
  (4, 'OK-DT004', 'DIST', 8,    true,  'Unrelated company HQ holder: distributor under its own HQ'),
  (4, 'NO-DT004', 'DIST', 1,    false, 'Unrelated company HQ holder: distributor under company A HQ'),
  (4, 'NO-SH004', 'SHOP', 4,    false, 'Unrelated company HQ holder: shop under company A distributor'),
  -- Root Access: every business-valid create anywhere, nothing invalid.
  (5, 'OK-DT005', 'DIST', 1,    true,  'Root: distributor under HQ'),
  (5, 'OK-HQ005', 'HQ',   null, true,  'Root: parentless HQ'),
  (5, 'OK-MF005', 'MFG',  null, true,  'Root: parentless manufacturer'),
  (5, 'OK-SH005', 'SHOP', 9,    true,  'Root: shop under the unrelated distributor (global)'),
  (5, 'NO-SH051', 'SHOP', 1,    false, 'Root: invalid pair SHOP under HQ'),
  (5, 'NO-DT052', 'DIST', 7,    false, 'Root: invalid pair DIST under MFG'),
  (5, 'NO-SH053', 'SHOP', 11,   false, 'Root: shop under an INACTIVE distributor'),
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
      -- An inactive parent is invisible to non-HQ-admin callers, so the hierarchy trigger (invoker) refuses it before
      -- RLS; sa_org_create_context's own NULL for an inactive parent is asserted directly below.
      perform smt.expect(v like '42501%' or (c.label like '%INACTIVE%' and v like 'P0001 Parent organization not found%'),
        format('user %s denied: %s%s', c.n, c.label, coalesce(' — got ' || v, ' — got success')));
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
-- Registry follows the policy.
select smt.expect((select organization_expression from public.sa_policy_rewrites
  where table_name = 'organizations' and policy_name = 'orgs_insert_admin') = 'sa_org_create_context(parent_org_id, org_type_code)',
  'sa_policy_rewrites row for orgs_insert_admin records the new organization expression');
-- Context helper never leaks beyond an id and is not callable by anon.
select smt.expect(not has_function_privilege('anon', 'public.sa_org_create_context(uuid,text)', 'EXECUTE'), 'anon cannot execute sa_org_create_context');
select smt.expect(to_regprocedure('public.sa_org_create_context(uuid)') is null, 'no one-argument draft of the helper exists');
select smt.expect((select pg_get_userbyid(proowner) from pg_proc where oid = 'public.sa_org_create_context(uuid,text)'::regprocedure) = 'supabase_admin',
  'helper is owned by supabase_admin');
begin;
select smt.as_user(4);
set local role authenticated;
select smt.expect(public.sa_org_create_context(null, 'MFG') = smt.o(8), 'parentless MFG context for the unrelated company is its own HQ');
select smt.expect(public.sa_org_create_context(null, 'HQ') is null, 'parentless HQ context is NULL for a non-Root holder');
select smt.expect(public.sa_org_create_context(smt.o(4), 'SHOP') = smt.o(1), 'context with a parent is the top-level HQ of the parent chain');
select smt.expect(public.sa_org_create_context(smt.o(7), 'DIST') is null, 'context is NULL for an invalid pair (DIST under MFG)');
select smt.expect(public.sa_org_create_context(smt.o(11), 'SHOP') is null, 'context is NULL under an inactive parent');
select smt.expect(public.sa_org_create_context(gen_random_uuid(), 'SHOP') is null, 'context is NULL for a missing parent');
rollback;
begin;
select smt.as_user(5);
set local role authenticated;
select smt.expect(public.sa_org_create_context(null, 'HQ') = smt.o(1), 'parentless HQ context for a Root holder is the own top-level HQ');
rollback;
