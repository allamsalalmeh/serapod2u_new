-- Wave 3 SAFE rollback rehearsal (header of both migrations): guards/triggers dropped, history kept.
drop trigger if exists hr_attendance_entries_api_guard on public.hr_attendance_entries;
drop trigger if exists hr_attendance_corrections_api_guard on public.hr_attendance_corrections;
drop trigger if exists hr_overtime_requests_api_guard on public.hr_overtime_requests;
drop trigger if exists hr_w3_leave_requests_quote on public.hr_leave_requests;
drop trigger if exists hr_leave_requests_w3_ledger on public.hr_leave_requests;
do $t$
declare n_l bigint; n_x bigint;
begin
  select count(*) into n_l from public.hr_leave_ledger; select count(*) into n_x from public.hr_attendance_exceptions;
  perform hlc.expect(n_l > 0 and n_x > 0, 'RB1 rollback keeps the ledger and exception history');
  perform hlc.expect(not exists (select 1 from pg_trigger where tgname in ('hr_attendance_entries_api_guard', 'hr_attendance_corrections_api_guard', 'hr_overtime_requests_api_guard', 'hr_w3_leave_requests_quote', 'hr_leave_requests_w3_ledger')),
                     'RB2 guard and leave triggers removed (old application build works again)');
  perform hlc.expect((select count(*) from pg_trigger where tgname in ('hr_leave_requests_guard', 'hr_leave_requests_record_event')) = 2,
                     'RB3 rollback never touches B2A leave security');
end $t$;
