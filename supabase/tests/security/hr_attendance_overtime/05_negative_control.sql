-- Wave 3 NEGATIVE CONTROL: the gaps Wave 3 closes must exist WITHOUT it (B2A + Wave 2 installed, Wave 3 not yet).
-- One transaction, rolled back. DISPOSABLE replica only.
begin;
do $t$
declare v text; n int;
begin
  -- the employee writes attendance with any time they like (device/client time), straight through PostgREST
  v := hlc.run_as(1, format($q$insert into public.hr_attendance_entries(organization_id, user_id, clock_in_at, clock_out_at, worked_minutes, status, source)
                              values (%L, %L, now() - interval '30 days', now() - interval '29 days', 1440, 'closed', 'mobile')$q$, hlc.o(1), hlc.u(1)));
  perform hlc.expect(v = 'OK:1', 'N1 WITHOUT Wave 3 an employee can insert attendance with a chosen time (' || v || ')');
  -- and approve their own overtime with a direct update (legacy RLS update policy on hr_overtime_requests)
  perform set_config('session_replication_role', 'replica', true);
  insert into public.hr_overtime_requests(id, organization_id, employee_id, request_date, ot_minutes, status, reason)
  values (hlc.x(1199), hlc.o(1), hlc.u(1), current_date - 3, 60, 'submitted', 'negative control');
  perform set_config('session_replication_role', 'origin', true);
  v := hlc.run_as(1, format($q$update public.hr_overtime_requests set status = 'approved', approver_id = %L where id = %L$q$, hlc.u(1), hlc.x(1199)));
  perform hlc.expect(v = 'OK:1' and (select status from public.hr_overtime_requests where id = hlc.x(1199)) = 'approved',
                     'N2 WITHOUT Wave 3 an employee can approve their own OT through a direct update (' || v || ')');
  -- leave days are whatever the client sends (weekend counted, no balance check)
  v := hlc.run_as(1, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, total_days, status)
                              values (%L, %L, %L, date '2027-03-06', date '2027-03-07', 2, 'pending')$q$, hlc.o(1), hlc.u(1), hlc.x(401)));
  perform hlc.expect(v = 'OK:1', 'N3 WITHOUT Wave 3 a weekend-only leave request is accepted with client-calculated days (' || v || ')');
end $t$;
rollback;
