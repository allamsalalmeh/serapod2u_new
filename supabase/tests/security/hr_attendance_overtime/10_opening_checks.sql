-- Wave 3B opening balance over the base fixtures (applied after them, as on staging). DISPOSABLE replica only.
do $t$
declare n bigint;
begin
  perform hlc.expect(coalesce(obj_description('public.hr_leave_ledger'::regclass, 'pg_class'), '') like '%[opening balance posted]%',
                     'B0 opening balance marker set once');
  -- every pre-existing balance row: available = entitled + carried_forward + adjustment − taken − pending, as before
  perform hlc.expect(not exists (
      select 1 from public.hr_leave_balances b
      where (public.hr_leave_balance_of(b.employee_id, b.leave_type_id, b.year)->>'entitled')::numeric <> b.entitled
         or (public.hr_leave_balance_of(b.employee_id, b.leave_type_id, b.year)->>'taken')::numeric <> b.taken),
    'B1 hr_leave_balances is the ledger projection after the opening');
  perform hlc.expect((select entitled from public.hr_leave_balances where employee_id = hlc.u(1) and leave_type_id = hlc.x(401) and year = 2026) = 14
                     and (public.hr_leave_balance_of(hlc.u(1), hlc.x(401), 2026)->>'available')::numeric = 14 - 0 - 2,
                     'B2 E1: 14 entitled, approved request posted as taken with an explicit opening reconciliation; available 14 − 2 pending');
  perform hlc.expect(exists (select 1 from public.hr_leave_ledger where request_ref = hlc.x(3) and entry_type = 'taken'),
                     'B3 every approved request is posted as taken (cancellation can reverse it)');
  perform hlc.expect(exists (select 1 from public.hr_leave_ledger where source_key like 'opening:%:reconcile'),
                     'B4 stored taken days not explained by approved requests are kept as an explicit reconciliation line');
  select count(*) into n from public.hr_leave_ledger;
  perform hlc.expect(n > 0 and not exists (select source_key from public.hr_leave_ledger group by 1 having count(*) > 1),
                     'B5 re-applying the migration posted nothing twice');
  perform hlc.expect(exists (select 1 from pg_indexes where indexname = 'hr_leave_balances_key_uniq'), 'B6 one balance row per employee, type and year');
  perform hlc.expect((select count(*) from public.hr_attendance_entries where work_date is null) = 0, 'B7 existing attendance rows received their local work date');
  perform hlc.expect((select count(*) from pg_trigger where tgname in ('hr_attendance_entries_api_guard', 'hr_attendance_corrections_api_guard',
                      'hr_overtime_requests_api_guard', 'hr_w3_leave_requests_quote', 'hr_leave_requests_w3_ledger') and tgenabled = 'O') = 5,
                     'B8 Wave 3 triggers installed and enabled');
  perform hlc.expect((select count(*) from pg_trigger where tgname in ('hr_leave_requests_guard', 'hr_leave_requests_record_event') and tgenabled = 'O') = 2,
                     'B9 B2A guard and event recorder still installed');
end $t$;
