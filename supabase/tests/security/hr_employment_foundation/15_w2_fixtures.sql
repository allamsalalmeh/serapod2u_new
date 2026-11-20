-- HR employment foundation (Wave 2, 20261221100000) — additional synthetic fixtures on top of
-- ../hr_leave_containment/10_fixtures.sql (people u1…u16, organizations o1 HQ Alpha / o2 child / o3 HQ Beta).
-- DISPOSABLE replica only; loaded with triggers off (like the base fixtures).
--   H1 (u7)  explicit hr.employee.manage in HQ Alpha (hr-records-officer, non-legacy)
--   HX (u11) explicit hr.employee.manage in HQ Beta only
--   L1 (u8)  holds hr.employee.manage ONLY through the legacy-hq compatibility policy (must never count)
--   R1 (u9)  Root Access
--   u20 P1 HR-created position holder (Head), u21 P2 incumbent of a child position (reports to M2 by employee record)
--   u40      unused identity (pending registration, no HR history) — permanent-deletion candidate
do $guard$ begin
  if current_database() not like '%test%' then raise exception 'refusing: disposable *test* replica only'; end if;
end $guard$;

set session_replication_role = replica;

insert into public.sa_permissions(permission_key, module, resource, action, status, source)
values ('hr.employee.manage','hr','employee','manage','active','new') on conflict (permission_key) do nothing;
insert into public.sa_business_roles(role_key, name, source, status)
values ('hr-records-officer','HR Records Officer','template','active') on conflict (role_key) do nothing;
insert into public.sa_business_role_permissions(role_id, permission_id)
select r.id, p.id from public.sa_business_roles r, public.sa_permissions p
where (r.role_key, p.permission_key) in (('hr-records-officer','hr.employee.manage'), ('legacy-hq','hr.employee.manage'))
on conflict do nothing;
insert into public.sa_migration_modes(permission_key, mode) values ('hr.employee.manage', 'NEW_ENFORCED')
on conflict (permission_key) do update set mode = excluded.mode;

insert into public.sa_role_assignments(id, user_id, role_id, membership_id, status, source, assignment_reason)
select hlc.x(680 + n), hlc.u(n), (select id from public.sa_business_roles where role_key = 'hr-records-officer'), hlc.x(200 + n), 'active', 'manual', 'w2 test'
from unnest(array[7, 11]) n on conflict (id) do nothing;
insert into public.sa_assignment_scopes(assignment_id, scope_id)
select hlc.x(680 + n), hlc.x(case when n = 11 then 303 else 301 end) from unnest(array[7, 11]) n on conflict do nothing;

-- People for the position-derived reporting check and the deletion candidate.
insert into auth.users(id, email, aud, role)
select hlc.u(n), 'hlc-' || n || '@example.test', 'authenticated', 'authenticated' from unnest(array[20, 21, 40]) n on conflict do nothing;
insert into public.users(id, email, full_name, role_code, organization_id, is_active, principal_type, account_status, account_scope, manager_user_id)
values (hlc.u(20), 'hlc-20@example.test', 'P1 head of unit', 'USER', hlc.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal', hlc.u(7)),
       (hlc.u(21), 'hlc-21@example.test', 'P2 unit member', 'USER', hlc.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal', hlc.u(6)),
       (hlc.u(40), 'hlc-40@example.test', 'Unused identity', 'USER', hlc.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal', null)
on conflict (id) do nothing;
insert into public.hr_employees(id, employee_no, user_id, organization_id, hire_date, status, manager_user_id, employment_type,
                                onboarding_status, onboarding_source, onboarded_at, hire_date_confirmed)
values (hlc.x(120), 910020, hlc.u(20), hlc.o(1), date '2026-01-05', 'active', hlc.u(7), 'Full-time', 'completed', 'hr_onboarding', now(), true),
       (hlc.x(121), 910021, hlc.u(21), hlc.o(1), date '2026-01-05', 'active', hlc.u(6), 'Full-time', 'completed', 'hr_onboarding', now(), true),
       (hlc.x(140), 910040, hlc.u(40), hlc.o(1), date '2026-01-05', 'active', null, null, 'pending', null, null, false)
on conflict (id) do nothing;
insert into public.sa_organization_memberships(id, user_id, organization_id, membership_type, is_primary, status, source)
select hlc.x(200 + n), hlc.u(n), hlc.o(1), 'employee', true, 'active', 'manual' from unnest(array[20, 21, 40]) n on conflict (id) do nothing;

-- Positions: HEAD (held by P1) is the PRIMARY parent of MEMBER (held by P2, whose employee manager is M2 → divergence).
insert into public.hr_positions(id, organization_id, code, name, is_active)
values (hlc.x(900), hlc.o(1), 'W2-HEAD', 'Head of Unit', true), (hlc.x(901), hlc.o(1), 'W2-MEM', 'Unit Member', true),
       (hlc.x(902), hlc.o(1), 'W2-E2', 'E2 slot', true)
on conflict (id) do nothing;
insert into public.hr_position_relationships(id, organization_id, position_id, parent_position_id, relationship_type, effective_from, is_active)
values (hlc.x(910), hlc.o(1), hlc.x(901), hlc.x(900), 'PRIMARY', date '2026-01-01', true) on conflict (id) do nothing;
insert into public.hr_position_assignments(id, organization_id, position_id, employee_user_id, assignment_type, effective_from, status)
values (hlc.x(920), hlc.o(1), hlc.x(900), hlc.u(20), 'PRIMARY', date '2026-01-05', 'active'),
       (hlc.x(921), hlc.o(1), hlc.x(901), hlc.u(21), 'PRIMARY', date '2026-01-05', 'active'),
       (hlc.x(922), hlc.o(1), hlc.x(902), hlc.u(2), 'PRIMARY', date '2026-01-05', 'active')
on conflict (id) do nothing;

-- Compensation / allowance / deduction for E2 (u2) — employment-end effects and overlap rules.
insert into public.hr_allowance_types(id, organization_id, code, name) values (hlc.x(930), hlc.o(1), 'TRANS', 'Transport') on conflict (id) do nothing;
insert into public.hr_deduction_types(id, organization_id, code, name) values (hlc.x(931), hlc.o(1), 'LOAN', 'Staff loan') on conflict (id) do nothing;
insert into public.hr_employee_compensation(id, organization_id, employee_id, pay_type, basic_salary, effective_date, status)
values (hlc.x(940), hlc.o(1), hlc.u(2), 'monthly', 4200, date '2026-01-05', 'active'),
       (hlc.x(941), hlc.o(1), hlc.u(1), 'monthly', 3900, date '2026-01-05', 'active')
on conflict (id) do nothing;
insert into public.hr_employee_allowances(id, organization_id, employee_id, allowance_type_id, amount, effective_date)
values (hlc.x(950), hlc.o(1), hlc.u(2), hlc.x(930), 200, date '2026-01-05') on conflict (id) do nothing;
insert into public.hr_employee_deductions(id, organization_id, employee_id, deduction_type_id, amount, effective_date)
values (hlc.x(951), hlc.o(1), hlc.u(2), hlc.x(931), 100, date '2026-01-05') on conflict (id) do nothing;

set session_replication_role = origin;
select hlc.expect(true, 'W2 fixtures loaded');
