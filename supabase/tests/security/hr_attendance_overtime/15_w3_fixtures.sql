-- HR Wave 3 (20261222100000 attendance/OT + 20261223100000 leave ledger) — synthetic fixtures on top of
-- ../hr_leave_containment/10_fixtures.sql and ../hr_employment_foundation/15_w2_fixtures.sql. DISPOSABLE replica only.
--   H1 (u7)  explicit Leave & Attendance Administrator (hr.leave.approve + hr.attendance.manage) in HQ Alpha
--   H2 (u22) second explicit attendance administrator in HQ Alpha (maker-checker reviewer)
--   HX (u11) explicit administrator in HQ Beta only
--   L1 (u8)  hr.attendance.manage / OT approval ONLY through the legacy-hq compatibility policy (must never count)
--   M1 (u5)  Manager Self-Service + the REQUESTED keys hr.mss.attendance_approve / hr.mss.overtime_approve (synthetic
--            "future" policy — proves the forward-compatible manager path); M2 (u6) has no MSS at all
--   E1 (u1)  works in Selangor (statutory work_state SGR); E2 (u2) no work state (national holidays only)
-- Reference week: hw3.mon() = Monday of LAST week (Asia/Kuala_Lumpur), so every fixture date is in the past.
do $guard$ begin
  if current_database() not like '%test%' then raise exception 'refusing: disposable *test* replica only'; end if;
end $guard$;

create schema if not exists hw3;
create or replace function hw3.today() returns date language sql stable as $$ select (now() at time zone 'Asia/Kuala_Lumpur')::date $$;
create or replace function hw3.mon() returns date language sql stable as $$
  select hw3.today() - ((extract(isodow from hw3.today())::int + 6) % 7) - 7 $$;
create or replace function hw3.err(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'OK'; exception when others then return 'ERR:' || sqlerrm; end $$;
grant usage on schema hw3 to anon, authenticated, service_role;
grant execute on all functions in schema hw3 to anon, authenticated, service_role;

set session_replication_role = replica;

insert into public.sa_permissions(permission_key, module, resource, action, status, source) values
 ('hr.attendance.manage','hr','attendance','manage','active','new'),
 ('hr.mss.attendance_view','hr','mss','attendance_view','active','new'),
 ('hr.mss.attendance_approve','hr','mss','attendance_approve','active','new'),
 ('hr.mss.overtime_approve','hr','mss','overtime_approve','active','new')
on conflict (permission_key) do nothing;
insert into public.sa_business_roles(role_key, name, source, status)
values ('w3-future-mss-approvals', 'Synthetic future MSS approvals (attendance/OT)', 'template', 'active') on conflict (role_key) do nothing;
insert into public.sa_business_role_permissions(role_id, permission_id)
select r.id, p.id from public.sa_business_roles r, public.sa_permissions p
where (r.role_key, p.permission_key) in (('hr-leave-attendance-administrator', 'hr.attendance.manage'),
       ('manager-self-service', 'hr.mss.attendance_view'),
       ('w3-future-mss-approvals', 'hr.mss.attendance_approve'), ('w3-future-mss-approvals', 'hr.mss.overtime_approve'),
       ('legacy-hq', 'hr.attendance.manage'), ('legacy-hq', 'hr.mss.overtime_approve'), ('legacy-hq', 'hr.mss.attendance_approve'))
on conflict do nothing;

insert into auth.users(id, email, aud, role) values (hlc.u(22), 'hlc-22@example.test', 'authenticated', 'authenticated') on conflict do nothing;
insert into public.users(id, email, full_name, role_code, organization_id, is_active, principal_type, account_status, account_scope)
values (hlc.u(22), 'hlc-22@example.test', 'H2 second HR', 'HR_MANAGER', hlc.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal') on conflict do nothing;
insert into public.hr_employees(id, employee_no, user_id, organization_id, hire_date, status, employment_type, onboarding_status,
                                onboarding_source, onboarded_at, hire_date_confirmed)
values (hlc.x(122), 910022, hlc.u(22), hlc.o(1), date '2025-03-01', 'active', 'Full-time', 'completed', 'hr_onboarding', now(), true)
on conflict do nothing;
insert into public.sa_organization_memberships(id, user_id, organization_id, membership_type, is_primary, status, source)
values (hlc.x(222), hlc.u(22), hlc.o(1), 'employee', true, 'active', 'manual') on conflict do nothing;
insert into public.sa_role_assignments(id, user_id, role_id, membership_id, status, source, assignment_reason)
values (hlc.x(1622), hlc.u(22), (select id from public.sa_business_roles where role_key = 'hr-leave-attendance-administrator'), hlc.x(222), 'active', 'manual', 'w3'),
       (hlc.x(1605), hlc.u(5), (select id from public.sa_business_roles where role_key = 'w3-future-mss-approvals'), hlc.x(205), 'active', 'manual', 'w3')
on conflict do nothing;
insert into public.sa_assignment_scopes(assignment_id, scope_id) values (hlc.x(1622), hlc.x(301)), (hlc.x(1605), hlc.x(301)) on conflict do nothing;

-- E1 hired 2023 (tier 2+ years), E2 hired this year in March (pro-rata)
update public.hr_employees set hire_date = date '2023-01-09' where user_id = hlc.u(1);
update public.hr_employees set hire_date = make_date(extract(year from hw3.today())::int, 3, 2) where user_id = hlc.u(2);

insert into public.hr_attendance_policies(id, organization_id, workdays, grace_minutes, timezone, require_shift, late_after_minutes,
                                          early_leave_before_minutes, max_open_entry_hours, overtime_policy_json)
values (hlc.x(1001), hlc.o(1), array['Mon','Tue','Wed','Thu','Fri'], 10, 'Asia/Kuala_Lumpur', false, 15, 15, 16,
        '{"enabled": true, "autoApprove": false, "maxDailyMinutes": 120, "rate": 1.5}'::jsonb)
on conflict (organization_id) do nothing;
insert into public.hr_shifts(id, organization_id, name, start_time, end_time, break_minutes, is_active, expected_work_minutes)
values (hlc.x(1002), hlc.o(1), 'Office 9-6', time '09:00', time '18:00', 60, true, 480) on conflict do nothing;
insert into public.hr_public_holidays(id, organization_id, name, date, is_recurring, state)
values (hlc.x(1003), hlc.o(1), 'W3 National Day', hw3.mon() + 2, false, null),
       (hlc.x(1004), hlc.o(1), 'W3 Selangor Day', hw3.mon() + 3, false, 'Selangor')
on conflict do nothing;
insert into public.hr_employee_statutory_profiles(user_id, organization_id, work_state) values (hlc.u(1), hlc.o(1), 'SGR')
on conflict (user_id) do update set work_state = 'SGR';

-- Leave configuration of HQ Alpha's annual leave (HR-configured tiers / pro-rata / carry-forward) and an unpaid type
update public.hr_leave_types set
  entitlement_tiers = '[{"id":"t1","minYearsOfService":0,"maxYearsOfService":2,"daysEntitled":8},{"id":"t2","minYearsOfService":2,"maxYearsOfService":null,"daysEntitled":12}]'::jsonb,
  pro_rata = '{"enabled": true, "basedOn": "join_date", "roundingRule": "round_down"}'::jsonb,
  carry_forward = '{"enabled": true, "maxDays": 5, "expiryMonths": 3}'::jsonb
where id = hlc.x(401);
insert into public.hr_leave_types(id, organization_id, code, name, status, is_paid_leave) values
 (hlc.x(405), hlc.o(1), 'UL', 'Unpaid leave', 'active', false),
 (hlc.x(406), hlc.o(1), 'ML', 'Medical leave', 'active', true)
on conflict do nothing;

set session_replication_role = origin;
select hlc.expect(true, 'W3 fixtures loaded');
