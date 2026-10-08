-- Reproduces the staging state of 2026-10-08 before 20261025100000: legacy authorization read-only, compatibility roles
-- that hold platform.user.manage but never received platform.user.password_reset, and both keys Legacy Retired.
insert into public.sa_settings(setting_key, setting_value, description) values ('legacy_authorization.read_only', 'true'::jsonb, 'test')
  on conflict (setting_key) do update set setting_value = 'true'::jsonb;
insert into public.sa_business_roles(id, role_key, name, source, status) values
  ('00000000-0000-0000-0006-000000000001', public.sa_compat_role_key('SA'), 'Legacy SA', 'legacy', 'active'),
  ('00000000-0000-0000-0006-000000000002', public.sa_compat_role_key('HQ_MGR'), 'Legacy HQ_MGR', 'legacy', 'active'),
  ('00000000-0000-0000-0006-000000000003', public.sa_compat_role_key('WH_MGR'), 'Legacy WH_MGR', 'legacy', 'active');
insert into public.sa_business_role_permissions(role_id, permission_id)
  select r, p.id from unnest(array['00000000-0000-0000-0006-000000000001','00000000-0000-0000-0006-000000000002','00000000-0000-0000-0006-000000000003']::uuid[]) r
  cross join public.sa_permissions p where p.permission_key = 'platform.user.manage';
-- Fresh fixtures (u4/u6 already received User Password Administrator in 20_reset_tests): u10 HQ level-10 admin, u11 level-20 manager.
insert into auth.users(id, email) values (saf.u(10), 'u10@dev.com'), (saf.u(11), 'u11@dev.com');
insert into public.users(id, email, full_name, role_code, organization_id, is_active) values (saf.u(10), 'u10@dev.com', 'HQ Admin', 'HQ_MGR', saf.o(1), true), (saf.u(11), 'u11@dev.com', 'WH Manager', 'WH_MGR', saf.o(2), true);
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status) values (saf.u(10), saf.o(1), 'employee', true, 'active'), (saf.u(11), saf.o(2), 'employee', true, 'active');
-- Compatibility assignments are made by the lifecycle sync (source backfill), never through Grant Policy.
-- u1 Super Admin (SA, HQ scope), u10 HQ admin (HQ_MGR, HQ scope), u11 warehouse manager (WH_MGR, Balakong scope).
select public.sa_create_assignment_internal(null, saf.u(1), '00000000-0000-0000-0006-000000000001', saf.o(1), array[saf.s(1)], now(), null, 'compat SA', 'backfill');
select public.sa_create_assignment_internal(null, saf.u(10), '00000000-0000-0000-0006-000000000002', saf.o(1), array[saf.s(1)], now(), null, 'compat HQ_MGR', 'backfill');
select public.sa_create_assignment_internal(null, saf.u(11), '00000000-0000-0000-0006-000000000003', saf.o(2), array[saf.s(2)], now(), null, 'compat WH_MGR', 'backfill');
update public.sa_migration_modes set mode = 'LEGACY_RETIRED' where permission_key in ('platform.user.password_reset', 'platform.user.manage');

-- The incident: User Management works, reset is denied for everyone in the designed audience.
select saf.expect((public.sa_evaluate_permission(saf.u(1), 'platform.user.manage', jsonb_build_object('organization_id', saf.o(1)))->>'decision') = 'ALLOW', 'before: Super Admin holds platform.user.manage');
select saf.expect((public.sa_evaluate_permission(saf.u(1), 'platform.user.password_reset', jsonb_build_object('organization_id', saf.o(1)))->>'decision') = 'DENY', 'before: Super Admin cannot reset (the reported bug)');
select saf.expect((public.sa_evaluate_permission(saf.u(10), 'platform.user.password_reset', jsonb_build_object('organization_id', saf.o(1)))->>'decision') = 'DENY', 'before: HQ level-10 admin cannot reset');

create table saf.cr_modes_before as select permission_key, mode from public.sa_migration_modes;
create table saf.cr_assign_before as select id, user_id, role_id, status, effective_until from public.sa_role_assignments;
create table saf.cr_roles_before as select rp.role_id, p.permission_key from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id;
