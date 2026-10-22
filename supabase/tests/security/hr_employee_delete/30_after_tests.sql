-- After 20261214100000. Cases numbered as in the task brief.
-- Grant the new break-glass policy (exists only after the migration) to the two test administrators.
set session_replication_role = replica;
do $assign$
declare r record; v_id uuid;
begin
  for r in select * from (values (1, 1), (9, 2)) t(n, scope_org) loop
    insert into public.sa_role_assignments(user_id, role_id, membership_id, status, source, assignment_reason)
    values (hed.u(r.n), (select id from public.sa_business_roles where role_key = 'hr-employee-record-administrator'), hed.x(200 + r.n), 'active', 'manual', 'hed test')
    returning id into v_id;
    insert into public.sa_assignment_scopes(assignment_id, scope_id) values (v_id, hed.x(300 + r.scope_org));
  end loop;
end $assign$;
set session_replication_role = origin;

create temp table fp as select n, hed.untouched(n) as h from generate_series(1, 14) n;
create temp table counts0 as
  select count(*) filter (where onboarding_status = 'completed') as onboarded,
         count(*) filter (where onboarding_status <> 'completed') as awaiting
  from public.hr_employees where organization_id = hed.o(1);

-- S&A registration
select hed.expect(public.sa_actor_has_permission(hed.u(1), 'hr.employee.delete', jsonb_build_object('organization_id', hed.o(1))),
  'S&A: HR Employee Record Administrator holder is allowed in its organization');
select hed.expect(not exists (select 1 from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id
                              join public.sa_business_roles b on b.id = rp.role_id
                              where p.permission_key = 'hr.employee.delete' and b.role_key = 'hr-payroll-full-access'),
  'S&A: HR & Payroll Full Access does not hold hr.employee.delete');

-- (9) Unauthorized: legacy Super Admin without the explicit grant, and an HR records officer
select hed.expect(hed.try($$select hed.preview(2, 3)$$) like '42501 sa_authorization_required%', '9: legacy Super Admin (level 1) without the grant is refused (preview)');
select hed.expect(hed.try($$select hed.exec(2, 3, 'delete', 1)$$) like '42501 sa_authorization_required%', '9: legacy Super Admin without the grant is refused (execute)');
select hed.expect(hed.try($$select hed.exec(4, 3, 'delete', 2)$$) like '42501 sa_authorization_required%', '9: hr.employee.manage holder (records officer) is refused');
select hed.expect(hed.try($$select public.hr_employee_registration_execute(null, hed.o(1), hed.u(3), 'delete', hed.x(9003), 't', 'some reason here')$$) like '42501 sa_actor_required%',
  '9: anonymous actor refused');
select hed.expect(not has_function_privilege('authenticated', 'public.hr_employee_registration_execute(uuid,uuid,uuid,text,uuid,text,text)', 'execute')
                  and not has_function_privilege('anon', 'public.hr_employee_registration_preview(uuid,uuid,uuid)', 'execute'),
  '9: API roles cannot call the functions (server-only)');
select hed.expect(hed.state(3) = 'completed', '9: nothing changed after refused attempts');

-- (8) Cross-organization
select hed.expect(hed.try($$select hed.preview(1, 8, 2)$$) like '42501 sa_authorization_required%', '8: o1 administrator cannot act in o2');
select hed.expect(hed.try($$select hed.preview(1, 8, 1)$$) like '22023 hr_employee_not_in_organization%', '8: o2 employee is "not found" in o1 (no disclosure)');
select hed.expect(hed.try($$select hed.exec(9, 3, 'delete', 4, 2)$$) like '22023 hr_employee_not_in_organization%', '8: o2 administrator cannot reach an o1 employee');
select hed.expect(hed.state(8, 2) = 'completed' and hed.state(3) = 'completed', '8: nothing changed');

-- (10) Self
select hed.expect(hed.codes(hed.preview(1, 1), 'delete') @> array['SELF'] and not (hed.preview(1, 1)->>'delete_allowed')::boolean, '10: preview explains SELF');
select hed.expect(hed.try($$select hed.exec(1, 1, 'delete', 5)$$) like '42501 hr_employee_registration_self_prohibited%', '10: self delete refused');
select hed.expect(hed.try($$select hed.exec(1, 1, 'reset', 6)$$) like '42501 hr_employee_registration_self_prohibited%', '10: self reset refused');

-- Reason
select hed.expect(hed.try($$select hed.exec(1, 3, 'delete', 7, 1, null, 'short')$$) like '22023 hr_employee_registration_reason_required%', 'reason < 10 characters refused');

-- (1) Eligible test employee
select hed.expect((hed.preview(1, 3)->>'delete_allowed')::boolean and hed.codes(hed.preview(1, 3), 'delete') = '{}', '1: preview allows delete, no blockers');
select hed.expect(hed.exec(1, 3, 'delete', 10)->>'status' = 'completed', '1: delete completed');
select hed.expect(hed.state(3) = 'pending', '1: registration removed (pending = Awaiting onboarding)');
select hed.expect((select onboarding_source is null and onboarded_at is null and onboarded_by is null and not hire_date_confirmed
                   from public.hr_employees where user_id = hed.u(3)), '1: onboarding columns cleared, hire date unconfirmed');
select hed.expect((select employee_no from public.hr_employees where user_id = hed.u(3)) = 900003, '1: employee number kept');
select hed.expect((select h from fp where n = 3) = hed.untouched(3), '1: identity, login, membership, S&A, employment facts unchanged');
select hed.expect(exists (select 1 from public.hr_employee_registration_actions where request_id = hed.x(9010) and status = 'completed'
                          and actor_id = hed.u(1) and organization_id = hed.o(1) and user_id = hed.u(3) and reason <> '' and before_image is not null),
  '1: audit record with actor, target, organization, reason, before image');
select hed.expect(exists (select 1 from public.hr_employee_onboarding_log where user_id = hed.u(3) and event = 'removed'), '1: onboarding log entry "removed"');
select hed.expect(hed.try($$update public.hr_employee_registration_actions set reason = 'x'$$) like '42501 hr_employee_registration_actions_is_append_only%'
                  and hed.try($$delete from public.hr_employee_registration_actions$$) like '42501%', '1: audit record is append-only');

-- (12) Auto-creation / synchronization triggers do not recreate or re-register
update public.users set department_id = hed.x(2) where id = hed.u(3);
select hed.expect((select count(*) from public.hr_employees where user_id = hed.u(3)) = 1 and hed.state(3) = 'pending'
                  and (select employee_no from public.hr_employees where user_id = hed.u(3)) = 900003
                  and (select department_id from public.hr_employees where user_id = hed.u(3)) = hed.x(2),
  '12: users→HR forwarding updates the same anchor; no recreation, no re-registration, same employee number');
update public.users set department_id = hed.x(1) where id = hed.u(3);
select hed.expect(hed.try($$update public.hr_employees set onboarding_status = 'completed' where user_id = hed.u(3)$$) like '42501 hr_onboarding_state_protected%',
  '12: onboarding guard still refuses direct re-registration');
select hed.expect(hed.try($$insert into public.hr_attendance_entries(organization_id, user_id, clock_in_at) values (hed.o(1), hed.u(3), now())$$) like 'P0001 hr_onboarding_pending%',
  '12: operational guard refuses new HR transactions for the deleted registration');
select hed.expect(public.hr_onboarding_complete(hed.u(4), hed.u(3), jsonb_build_object('organization_id', hed.o(1), 'hire_date', '2026-02-01', 'department_id', hed.x(1)))->>'outcome' = 'ONBOARDED',
  '12: Add Employee re-onboards the deleted registration');
select hed.expect(hed.state(3) = 'completed' and (select employee_no from public.hr_employees where user_id = hed.u(3)) = 900003,
  '12: same person, same employee number after re-onboarding');

-- (11) Repeated / reused requests
select hed.expect((hed.exec(1, 3, 'delete', 10)->>'replayed')::boolean, '11: repeated request returns the recorded outcome');
select hed.expect(hed.state(3) = 'completed', '11: replay changed nothing (person was re-onboarded in between)');
select hed.expect(hed.try($$select hed.exec(1, 11, 'delete', 10)$$) like '22023 hr_employee_registration_request_reused%', '11: request id reused for another target refused');
select hed.expect(hed.exec(1, 3, 'delete', 11, 1, 'stale-token')->>'status' = 'stale', '11: stale preview token refused');
select hed.expect(hed.state(3) = 'completed', '11: stale request changed nothing');

-- (2)(3)(4) System user with S&A access and Supply Chain history
select hed.expect((hed.preview(1, 4)->'kept'->>'access_assignments')::int = 1 and (hed.preview(1, 4)->'kept'->>'login')::boolean,
  '2/3: preview shows login and S&A access are kept');
select hed.expect((hed.preview(1, 4)->>'delete_allowed')::boolean, '4: Supply Chain history references the identity, not the HR registration: delete allowed');
select hed.expect(hed.exec(1, 4, 'delete', 20)->>'status' = 'completed', '2: system user HR registration deleted (completed)');
select hed.expect(hed.state(4) = 'pending', '2: system user HR registration deleted (state)');
select hed.expect((select h from fp where n = 4) = hed.untouched(4), '2/3/4: login, users row, membership, S&A assignment and order unchanged');
select hed.expect(public.sa_actor_has_permission(hed.u(4), 'hr.employee.manage', jsonb_build_object('organization_id', hed.o(1))),
  '3: business access still effective after delete');

-- (5) Manager / direct reports
select hed.expect(hed.codes(hed.preview(1, 5), 'delete') @> array['DIRECT_REPORTS'], '5: manager delete blocked (DIRECT_REPORTS)');
select hed.expect(hed.exec(1, 5, 'delete', 30)->>'status' = 'blocked' and hed.state(5) = 'completed', '5: execute records blocked, nothing changed');
select hed.expect(exists (select 1 from public.hr_employee_registration_actions where request_id = hed.x(9030) and status = 'blocked'), '5: blocked attempt audited');

-- (6) Attendance / leave
select hed.expect(hed.codes(hed.preview(1, 6), 'delete') @> array['HR_RECORDS']
                  and (hed.preview(1, 6)->'categories') ?& array['attendance','leave'], '6: attendance + leave block delete (categories reported)');
select hed.expect(hed.exec(1, 6, 'delete', 40)->>'status' = 'blocked' and hed.state(6) = 'completed', '6: delete blocked, nothing changed');

-- (7) Payroll / commission
select hed.expect((hed.preview(1, 7)->'categories') ?& array['payroll','commission'] and not (hed.preview(1, 7)->>'delete_allowed')::boolean,
  '7: payroll line + commission profile block delete');
select hed.expect(hed.exec(1, 7, 'delete', 50)->>'status' = 'blocked' and hed.state(7) = 'completed', '7: delete blocked, nothing changed');

-- Reset HR Registration (case B alternative) for blocked people: history kept
select hed.expect((hed.preview(1, 6)->>'reset_allowed')::boolean, 'reset: allowed with HR history');
select hed.expect(hed.exec(1, 6, 'reset', 60)->>'status' = 'completed', 'reset: completed → reset (completed)');
select hed.expect(hed.state(6) = 'reset', 'reset: completed → reset (state)');
select hed.expect((select h from fp where n = 6) = hed.untouched(6), 'reset: attendance, leave, identity, access unchanged');
select hed.expect((select employee_no from public.hr_employees where user_id = hed.u(6)) = 900006, 'reset: employee number kept');
select hed.expect(hed.codes(hed.preview(1, 6), 'reset') @> array['NOT_COMPLETED'], 'reset: a second reset is blocked (NOT_COMPLETED)');
select hed.expect(hed.exec(1, 5, 'reset', 61)->>'status' = 'completed' and (select manager_user_id from public.users where id = hed.u(6)) = hed.u(5),
  'reset: manager reset keeps the reporting line projection');

-- Never-registered anchor and reset-without-records
select hed.expect(hed.codes(hed.preview(1, 10), 'delete') @> array['NOT_REGISTERED'] and hed.codes(hed.preview(1, 10), 'reset') @> array['NOT_COMPLETED'],
  'pending anchor: nothing to delete or reset');
select hed.expect(hed.exec(1, 11, 'delete', 70)->>'status' = 'completed', 'reset registration without HR records can be deleted (completed)');
select hed.expect(hed.state(11) = 'pending', 'reset registration without HR records can be deleted (state)');

-- HR live
begin;
update public.hr_go_live_state set phase = 'live' where organization_id = hed.o(1);
select hed.expect(hed.codes(hed.preview(1, 12), 'delete') @> array['HR_LIVE'] and hed.codes(hed.preview(1, 12), 'reset') @> array['HR_LIVE'], 'HR live blocks delete and reset');
select hed.expect(hed.exec(1, 12, 'delete', 80)->>'status' = 'blocked' and hed.state(12) = 'completed', 'HR live: nothing changed');
rollback;

-- (13) Rollback on failure: the onboarding log insert fails after the state change
create function hed.boom() returns trigger language plpgsql as $$ begin raise exception 'hed_injected_failure'; end $$;
create trigger hed_boom before insert on public.hr_employee_onboarding_log for each row execute function hed.boom();
select hed.expect(hed.try($$select hed.exec(1, 14, 'delete', 90)$$) like '%hed_injected_failure%', '13: injected failure surfaces');
drop trigger hed_boom on public.hr_employee_onboarding_log;
select hed.expect(hed.state(14) = 'completed' and (select onboarded_at is not null and hire_date_confirmed from public.hr_employees where user_id = hed.u(14)),
  '13: employee record unchanged after failure');
select hed.expect(not exists (select 1 from public.hr_employee_registration_actions where request_id = hed.x(9090)), '13: no action record kept');
select hed.expect((select h from fp where n = 14) = hed.untouched(14), '13: nothing else changed');

-- (14) Counts: deleted 3 (re-onboarded), 4, 11 and reset 5, 6 in o1
select hed.expect((select count(*) filter (where onboarding_status = 'completed') from public.hr_employees where organization_id = hed.o(1))
                  = (select onboarded from counts0) - 3, '14: onboarded count dropped by exactly three (4 deleted, 5 and 6 reset; 3 re-onboarded; 11 was not onboarded)');
select hed.expect((select count(*) filter (where onboarding_status <> 'completed') from public.hr_employees where organization_id = hed.o(1))
                  = (select awaiting from counts0) + 3, '14: awaiting count rose by the same three');
select hed.expect((select count(*) from public.hr_employees where organization_id = hed.o(1)) = 12, '14: no employment record created or deleted');
select hed.expect(hed.state(8, 2) = 'completed', '14: other organization untouched');

-- Business data unchanged for everyone
select hed.expect(not exists (select 1 from fp where n not in (3) and h <> hed.untouched(n)),
  'identity, login, access, employment facts and history unchanged for every fixture person (3 changed only by the re-onboarding test)');
