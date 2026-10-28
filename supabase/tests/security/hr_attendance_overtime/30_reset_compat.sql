-- Wave 3 with HR Data Management reset/restore: attendance, OT, exceptions, imports and the leave ledger are removed
-- with a snapshot and restored byte-identical; the direct-write guard never blocks database-owned maintenance.
do $setup$
begin
  insert into public.hr_reset_scope(table_name, category, action, delete_order, label)
  select * from (values ('hr_attendance_corrections','attendance','delete',10,'Attendance corrections'),
                        ('hr_overtime_requests','attendance','delete',12,'Overtime requests'),
                        ('hr_timesheets','attendance','delete',14,'Timesheets'),
                        ('hr_attendance_entries','attendance','delete',15,'Attendance entries (clock in/out)'),
                        ('hr_attendance_audit','attendance','delete',16,'Attendance activity log')) v(t, c, a, o, l)
  where not exists (select 1 from public.hr_reset_scope s where s.table_name = v.t);
end $setup$;

do $t$
declare p jsonb; v text; v_run uuid; h_entries text; h_ledger text; h_ot text; h_x text; h_bal text; n_e bigint;
begin
  select md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' order by t.id), '')) into h_entries from public.hr_attendance_entries t where t.organization_id = hlc.o(1);
  select md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' order by t.id), '')) into h_ledger from public.hr_leave_ledger t where t.organization_id = hlc.o(1);
  select md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' order by t.id), '')) into h_ot from public.hr_overtime_requests t where t.organization_id = hlc.o(1);
  select md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' order by t.id), '')) into h_x from public.hr_attendance_exceptions t where t.organization_id = hlc.o(1);
  select md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' order by t.id), '')) into h_bal from public.hr_leave_balances t where t.organization_id = hlc.o(1);
  select count(*) into n_e from public.hr_attendance_entries where organization_id = hlc.o(1);
  p := public.hr_reset_preview(hlc.u(14), hlc.o(1), 'full');
  perform hlc.expect(jsonb_array_length(p->'blockers') = 0, 'RS1 reset preview has no blockers with Wave 3 ' || coalesce((p->'blockers')::text, ''));
  perform hlc.expect(exists (select 1 from jsonb_array_elements(p->'delete') d where d->>'table' = 'hr_leave_ledger')
                     and exists (select 1 from jsonb_array_elements(p->'delete') d where d->>'table' = 'hr_attendance_exceptions'),
                     'RS2 Wave 3 transactional tables are part of the reset (captured and restorable)');
  v := hlc.val_as(null, format($q$select public.hr_reset_execute(%L, %L, 'full', %L, %L, 'Clean HR test data before go-live', %L)->>'status'$q$,
                               hlc.u(14), hlc.o(1), hlc.x(990), p->>'preview_token', p->>'confirmation_phrase'), 'service_role');
  perform hlc.expect(v = 'completed', 'RS3 full reset completes with the attendance guard in place (' || coalesce(v, 'null') || ')');
  perform hlc.expect(n_e > 0 and (select count(*) from public.hr_attendance_entries where organization_id = hlc.o(1)) = 0
                     and (select count(*) from public.hr_leave_ledger where organization_id = hlc.o(1)) = 0,
                     'RS4 reset removed attendance entries and ledger lines of the organization');
  select id into v_run from public.hr_reset_runs where request_id = hlc.x(990);
  v := hlc.val_as(null, format($q$select public.hr_reset_restore(%L, %L, 'Restore rehearsal on replica')->>'status'$q$, hlc.u(14), v_run), 'service_role');
  perform hlc.expect(v is not null and v not like 'ERR:%', 'RS5 restore completes (' || coalesce(v, 'null') || ')');
  perform hlc.expect(h_entries = (select md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' order by t.id), '')) from public.hr_attendance_entries t where t.organization_id = hlc.o(1)),
                     'RS6 attendance entries restored byte-identical');
  perform hlc.expect(h_ledger = (select md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' order by t.id), '')) from public.hr_leave_ledger t where t.organization_id = hlc.o(1)),
                     'RS7 leave ledger restored byte-identical (no duplicate posting by the triggers)');
  perform hlc.expect(h_ot = (select md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' order by t.id), '')) from public.hr_overtime_requests t where t.organization_id = hlc.o(1))
                     and h_x = (select md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' order by t.id), '')) from public.hr_attendance_exceptions t where t.organization_id = hlc.o(1)),
                     'RS8 OT requests and exceptions restored byte-identical');
  perform hlc.expect(h_bal = (select md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' order by t.id), '')) from public.hr_leave_balances t where t.organization_id = hlc.o(1)),
                     'RS9 balance projection restored unchanged');
  v := hlc.run_as(1, format($q$update public.hr_attendance_entries set clock_in_at = now() where user_id = %L$q$, hlc.u(1)));
  perform hlc.expect(v like 'ERR:%hr_attendance_direct_write_refused%', 'RS10 the direct-write guard still applies after restore');
end $t$;
