-- NEGATIVE CONTROL on the unpatched schema (production snapshot policies). Every assertion here proves that a hole
-- EXISTS before 20261219100000, so the same probes in 30_after_tests.sql are meaningful. Runs inside one transaction
-- that is rolled back, so the fixtures stay pristine for the migration.
begin;
do $t$
declare r text;
begin
  -- SEC-1: on-behalf insert (E1 files leave for E2) succeeds
  r := hlc.run_as(1, format($q$insert into public.hr_leave_requests(id, organization_id, employee_id, leave_type_id, start_date, end_date, status)
                               values (%L, %L, %L, %L, current_date, current_date, 'pending')$q$, hlc.x(900), hlc.o(1), hlc.u(2), hlc.x(401)));
  perform hlc.expect(r = 'OK:1', 'control: on-behalf insert succeeds before the fix (' || r || ')');

  -- SEC-1: insert directly as approved succeeds
  r := hlc.run_as(1, format($q$insert into public.hr_leave_requests(id, organization_id, employee_id, leave_type_id, start_date, end_date, status)
                               values (%L, %L, %L, %L, current_date, current_date, 'approved')$q$, hlc.x(901), hlc.o(1), hlc.u(1), hlc.x(401)));
  perform hlc.expect(r = 'OK:1', 'control: insert with status approved succeeds before the fix (' || r || ')');

  -- SEC-2: employee self-approves
  r := hlc.run_as(1, format($q$update public.hr_leave_requests set status = 'approved', approved_by = %L where id = %L$q$, hlc.u(1), hlc.x(1)));
  perform hlc.expect(r = 'OK:1' and hlc.status(1) = 'approved', 'control: employee self-approval succeeds before the fix (' || r || ')');

  -- SEC-3: organization-wide read of other people's leave and balances
  perform hlc.expect(hlc.val_as(1, format('select count(*) from public.hr_leave_requests where employee_id <> %L', hlc.u(1)))::int > 0,
                     'control: employee reads other employees'' leave before the fix');
  perform hlc.expect(hlc.val_as(1, format('select count(*) from public.hr_leave_balances where employee_id <> %L', hlc.u(1)))::int > 0,
                     'control: employee reads other employees'' balances before the fix');

  -- SEC-4: legacy role level (HQ_ADMIN, level 10) approves without any explicit grant
  r := hlc.run_as(8, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(2)));
  perform hlc.expect(r = 'OK:1' and hlc.status(2) = 'approved', 'control: legacy role-level approver approves before the fix (' || r || ')');
end $t$;
rollback;
