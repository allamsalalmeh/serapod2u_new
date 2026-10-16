-- Isolated archive fixtures (never real data). Reuses sa_group_policies fixtures (u1 Super Admin, u2..u9 level 10/20/40).
-- 10 Balakong employee (target) | 11 Alma employee (out of scope for a Balakong administrator) | 12 Balakong employee with history
-- 13 Balakong employee holding an HQ-scoped grant (more privileged than a Balakong-only administrator)
-- 14 Balakong employee (target for the shadow-mode legacy check)
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;
insert into auth.users(id, email) select saf.u(n), 'u' || n || '@dev.com' from generate_series(10, 14) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active) values
  (saf.u(10),'u10@dev.com','Balakong Target','WH_MGR',saf.o(2),true), (saf.u(11),'u11@dev.com','Alma Target','WH_MGR',saf.o(3),true),
  (saf.u(12),'u12@dev.com','Balakong With History','WH_MGR',saf.o(2),true), (saf.u(13),'u13@dev.com','Balakong Privileged','WH_MGR',saf.o(2),true),
  (saf.u(14),'u14@dev.com','Balakong Shadow Target','WH_MGR',saf.o(2),true);
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status)
  select saf.u(n), case n when 11 then saf.o(3) else saf.o(2) end, 'employee', true, 'active' from generate_series(10, 14) n;
insert into public.saf_orders(created_by) values (saf.u(12));
-- Archive administrator policy (platform.identity.delete only) and an HQ-wide payer policy for the privileged target.
insert into public.sa_business_roles(id, role_key, name, source, status) values
  ('00000000-0000-0000-0005-000000000020', 'saf-archive-admin', 'Archive Administrator', 'new', 'active');
insert into public.sa_business_role_permissions(role_id, permission_id)
  select '00000000-0000-0000-0005-000000000020', id from public.sa_permissions where permission_key = 'platform.identity.delete';
create table saf.modes_before_identity as select permission_key, mode from public.sa_migration_modes;
-- u13 also works at HQ (secondary membership) so it can hold an HQ-scoped grant.
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status) values (saf.u(13), saf.o(1), 'employee', false, 'active');
