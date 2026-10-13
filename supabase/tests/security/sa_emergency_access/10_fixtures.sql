-- Isolated emergency-access fixtures (never real data). Builds on sa_group_policies fixtures:
-- u1 legacy Super Admin (HQ) | u2 HQ administrator (level 10) | u3 plain HQ member | u4 Balakong employee
-- u5 Balakong administrator | u6 HQ employee (usual target) | u7 HQ payer | u8 manufacturer user
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;

-- Modes mirror staging (read-only check 2026-10-08): the 11 other Security & Access permissions Legacy Retired and
-- registered; security.emergency_access.grant Monitoring and unregistered; business permissions enforced.
insert into public.sa_enforcement_readiness(permission_key, route_wiring, database_backstop, notes)
select k, true, 'governance_function', 'fixture (mirrors staging registration)'
from unnest(array['security.access.view','security.role.assign','security.permission.manage','security.role.manage','security.scope.manage',
  'security.policy.manage','security.audit.view','security.access_request.approve','security.access_review.manage',
  'security.delegation.manage','security.service_identity.manage','finance.payment.approve','finance.journal.post']) k
on conflict (permission_key) do nothing;
-- Explicit Security & Access Full Access for the Super Admin and the HQ administrator BEFORE legacy is retired
-- (otherwise nobody could administer). Written through the real internal assignment function.
select public.sa_create_assignment_internal(null, saf.u(1), saf.role('security-access-full-access'), saf.o(1), array[saf.s(1)], now(), null, 'fixture', 'manual');
select public.sa_create_assignment_internal(null, saf.u(2), saf.role('security-access-full-access'), saf.o(1), array[saf.s(1)], now(), null, 'fixture', 'manual');
update public.sa_migration_modes set mode = 'LEGACY_RETIRED' where permission_key like 'security.%' and permission_key <> 'security.emergency_access.grant';
update public.sa_migration_modes set mode = 'NEW_ENFORCED' where permission_key in ('finance.payment.approve', 'finance.journal.post');
update public.sa_migration_modes set mode = 'SHADOW' where permission_key = 'security.emergency_access.grant';

-- Balakong-only emergency administrator (u5): may grant emergency access and approve payments, Balakong scope only.
insert into public.sa_business_roles(id, role_key, name, source, status) values
  ('00000000-0000-0000-0005-000000000030', 'saf-emergency-balakong', 'Emergency Admin (Balakong)', 'new', 'active');
insert into public.sa_business_role_permissions(role_id, permission_id)
  select '00000000-0000-0000-0005-000000000030', id from public.sa_permissions where permission_key in ('security.emergency_access.grant', 'finance.payment.approve');
select public.sa_create_assignment_internal(null, saf.u(5), '00000000-0000-0000-0005-000000000030', saf.o(2), array[saf.s(2)], now(), null, 'fixture', 'manual');
-- A journal poster role for the SoD target.
insert into public.sa_business_roles(id, role_key, name, source, status) values
  ('00000000-0000-0000-0005-000000000031', 'saf-journal', 'Journal Poster', 'new', 'active');
insert into public.sa_business_role_permissions(role_id, permission_id)
  select '00000000-0000-0000-0005-000000000031', id from public.sa_permissions where permission_key = 'finance.journal.post';
-- u4 also works at HQ (secondary membership) so it can be an HQ target that already posts journals.
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status) values (saf.u(4), saf.o(1), 'employee', false, 'active');
select public.sa_create_assignment_internal(null, saf.u(4), '00000000-0000-0000-0005-000000000031', saf.o(1), array[saf.s(1)], now(), null, 'fixture', 'manual');

create table saf.modes_before_emergency as select permission_key, mode from public.sa_migration_modes;

-- Step-up fixture: a GoTrue-shaped session for p_user. p_age = time since the TOTP verification.
create function saf.session(p_user uuid, p_age interval default interval '10 seconds', p_aal text default 'aal2',
  p_factor_status text default 'verified', p_not_after timestamptz default null) returns uuid language plpgsql as $$
declare v_factor uuid := gen_random_uuid(); v_session uuid := gen_random_uuid();
begin
  insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status) values (v_factor, p_user, 'fixture', 'totp', p_factor_status::auth.factor_status);
  insert into auth.sessions(id, user_id, factor_id, aal, not_after) values (v_session, p_user, case when p_aal = 'aal2' then v_factor end, p_aal::auth.aal_level, p_not_after);
  insert into auth.mfa_amr_claims(session_id, created_at, updated_at, authentication_method) values (v_session, now() - p_age, now() - p_age, 'password');
  if p_aal = 'aal2' then
    insert into auth.mfa_amr_claims(session_id, created_at, updated_at, authentication_method) values (v_session, now() - p_age, now() - p_age, 'totp');
  end if;
  return v_session;
end $$;
-- Grant call helper (returns 'OK' or the error text).
create function saf.grant(p_actor uuid, p_target uuid, p_org uuid, p_keys text[], p_scope uuid, p_session uuid,
  p_minutes int default 30, p_reason text default 'Month-end payment run blocked; approver on leave', p_key uuid default gen_random_uuid()) returns text language sql as $$
  select saf.try(format('select public.sa_grant_emergency_access(%L, %L, %L, %L::text[], %L, %L, %s, %L, %L)',
    p_actor, p_target, p_org, p_keys, p_scope, p_reason, p_minutes, p_session, p_key)) $$;
create function saf.decide(p_user uuid, p_key text, p_org uuid) returns jsonb language sql as $$
  select public.sa_evaluate_permission(p_user, p_key, jsonb_build_object('organization_id', p_org)) $$;
grant execute on all functions in schema saf to public;
