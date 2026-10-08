-- After 20261025100000 (applied twice).
select saf.expect((public.sa_evaluate_permission(saf.u(1), 'platform.user.password_reset', jsonb_build_object('organization_id', saf.o(1)))->>'decision') = 'ALLOW', 'Super Admin (level 1) may reset in its scope');
select saf.expect((public.sa_evaluate_permission(saf.u(1), 'platform.user.password_reset', jsonb_build_object('organization_id', saf.o(2)))->>'decision') = 'ALLOW', 'Super Admin may reset in a child warehouse (same reach as platform.user.manage)');
select saf.expect((public.sa_evaluate_permission(saf.u(10), 'platform.user.password_reset', jsonb_build_object('organization_id', saf.o(1)))->>'decision') = 'ALLOW', 'HQ level-10 admin may reset');
select saf.expect((public.sa_evaluate_permission(saf.u(10), 'platform.user.password_reset', jsonb_build_object('organization_id', saf.o(4)))->>'decision') = 'DENY', 'HQ admin cannot reset outside its scope (manufacturer)');
select saf.expect((public.sa_evaluate_permission(saf.u(11), 'platform.user.manage', jsonb_build_object('organization_id', saf.o(2)))->>'decision') = 'ALLOW', 'level-20 compat holder still manages users');
select saf.expect((public.sa_evaluate_permission(saf.u(11), 'platform.user.password_reset', jsonb_build_object('organization_id', saf.o(2)))->>'decision') = 'DENY', 'level-20 compat role does NOT gain reset (narrower than profile admin)');
select saf.expect((public.sa_evaluate_permission(saf.u(3), 'platform.user.password_reset', jsonb_build_object('organization_id', saf.o(1)))->>'decision') = 'DENY', 'profile editor (platform.user.manage only, non-compat) still cannot reset');
select saf.expect((public.sa_evaluate_permission(saf.u(8), 'platform.user.password_reset', jsonb_build_object('organization_id', saf.o(4)))->>'decision') = 'DENY', 'partner user cannot reset');

-- Exactly the two compat roles gained exactly one permission; nothing else changed.
select saf.expect((select array_agg(b.role_key order by b.role_key) from public.sa_business_role_permissions rp join public.sa_business_roles b on b.id = rp.role_id
  join public.sa_permissions p on p.id = rp.permission_id where p.permission_key = 'platform.user.password_reset' and b.source = 'legacy') = array['legacy-hq-mgr','legacy-sa'], 'only legacy-sa and legacy-hq-mgr hold reset among compat roles');
select saf.expect((select count(*) from (select rp.role_id, p.permission_key from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id
  except select role_id, permission_key from saf.cr_roles_before) d) = 2, 'exactly two role-permission rows were added');
select saf.expect(not exists (select role_id, permission_key from saf.cr_roles_before except select rp.role_id, p.permission_key from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id), 'no role-permission row removed');
select saf.expect(not exists (select 1 from public.sa_migration_modes m full join saf.cr_modes_before b using (permission_key) where m.mode is distinct from b.mode), 'no migration mode changed (Legacy Retired stays)');
select saf.expect((select mode from public.sa_migration_modes where permission_key = 'platform.user.password_reset') = 'LEGACY_RETIRED', 'reset key stays Legacy Retired');
select saf.expect(not exists ((select id, user_id, role_id, status, effective_until from public.sa_role_assignments except select * from saf.cr_assign_before)
  union all (select * from saf.cr_assign_before except select id, user_id, role_id, status, effective_until from public.sa_role_assignments)), 'no assignment created, removed or altered');
select saf.expect(saf.audit('compat_role.permission_materialized') = 2, 'one audit entry per role (not repeated on re-apply)');
select saf.expect(to_regclass('public.sa_mig_20261025_modes_before') is null and to_regclass('public.sa_mig_20261025_assign_before') is null, 'work tables removed');
