-- After the refused, rolled-back apply: staging text intact, no helper, registry untouched.
select smt.expect((select pg_get_expr(polwithcheck, polrelid) from pg_policy
  where polrelid = 'public.organizations'::regclass and polname = 'orgs_insert_admin')
  = '(sa_rls_gate(''platform.organization.manage''::text, id, (is_hq_admin() OR is_super_admin())) OR (sa_rls_new_mode(''platform.organization.manage''::text) AND (false OR false)))',
  'fail-safe: orgs_insert_admin still has the original staging text');
select smt.expect(to_regprocedure('public.sa_org_create_context(uuid,text)') is null, 'fail-safe: helper rolled back with the transaction');
select smt.expect((select organization_expression from public.sa_policy_rewrites
  where table_name = 'organizations' and policy_name = 'orgs_insert_admin') = 'id', 'fail-safe: registry row untouched');
