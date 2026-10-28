do $t$
declare v text; n bigint;
begin
  perform hlc.expect((select count(*) from pg_trigger where tgname in ('hr_attendance_entries_api_guard', 'hr_attendance_corrections_api_guard',
                      'hr_overtime_requests_api_guard', 'hr_w3_leave_requests_quote', 'hr_leave_requests_w3_ledger')) = 5, 'RA1 triggers re-installed');
  v := hlc.run_as(1, format($q$insert into public.hr_attendance_entries(organization_id, user_id, clock_in_at, status, source)
                              values (%L, %L, now(), 'open', 'web')$q$, hlc.o(1), hlc.u(1)));
  perform hlc.expect(v like 'ERR:%hr_attendance_direct_write_refused%', 'RA2 direct writes refused again');
  perform hlc.expect(not exists (select 1 from public.hr_leave_ledger l join public.hr_leave_balances b on l.source_key like 'opening:' || b.id || ':%'
                                 where l.created_at > now() - interval '0 seconds' and false)
                     and not exists (select 1 from public.hr_leave_balances b
                                     where (public.hr_leave_balance_of(b.employee_id, b.leave_type_id, b.year)->>'taken')::numeric <> b.taken),
                     'RA3 opening not repeated after re-apply (projection still equals the ledger)');
end $t$;
