-- Negative control: staging schema + 20261214100000, WITHOUT 20261216100000.
select ipd.expect(to_regprocedure('public.identity_deletion_execute(uuid,uuid,text,uuid,text,text,text)') is null, 'before: no canonical permanent deletion exists');
select ipd.expect('hr_employees.user_id' = any(public.identity_history_references(ipd.u(3))),
  'before: a PENDING employee''s own employment anchor counts as history → User Management Delete User archives instead of deleting');
select ipd.expect(not (public.hr_employee_registration_preview(ipd.u(1), ipd.o(1), ipd.u(3))->>'delete_allowed')::boolean
                  and (public.hr_employee_registration_preview(ipd.u(1), ipd.o(1), ipd.u(3))->'blockers'->'delete')::text like '%NOT_REGISTERED%',
  'before: HR Delete Employee refuses a pending employee (NOT_REGISTERED: it only moves completed|reset → pending)');
select ipd.expect((public.hr_employee_registration_preview(ipd.u(1), ipd.o(1), ipd.u(4))->>'delete_allowed')::boolean,
  'before: HR Delete Employee allows a reset employee — and keeps login, identity and anchor');
set role service_role;
select ipd.expect(ipd.try($$delete from public.users where id = '0000001d-0000-0000-0000-000000000003'$$) like '23503 identity_has_history%',
  'before: a service-role hard delete of the pending employee is refused by users_history_delete_guard');
reset role;
