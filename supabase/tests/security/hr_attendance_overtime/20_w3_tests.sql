-- HR Wave 3 — behaviour tests (attendance capture, manual entry, detection, corrections, import, overtime, leave ledger).
-- DISPOSABLE replica only. Requires 20261222100000 + 20261223100000 applied and 15_w3_fixtures.sql loaded.
-- Functions are called as the database owner the way the server routes call them (service_role, session actor passed
-- as p_actor); API-role behaviour (direct writes, function privileges) is exercised with hlc.run_as.

---------------------------------------------------------------- G: privileges & direct-write guard
do $t$
declare v text;
begin
  v := hlc.run_as(1, format($q$insert into public.hr_attendance_entries(organization_id, user_id, clock_in_at, status, source)
                              values (%L, %L, now() - interval '3 hours', 'open', 'mobile')$q$, hlc.o(1), hlc.u(1)));
  perform hlc.expect(v like 'ERR:%hr_attendance_direct_write_refused%', 'G1 an employee cannot write attendance directly with a chosen time (' || v || ')');
  v := hlc.run_as(null, format('update public.hr_attendance_entries set clock_in_at = now() where user_id = %L', hlc.u(1)), 'service_role');
  perform hlc.expect(v like 'ERR:%hr_attendance_direct_write_refused%' or v = 'OK:0', 'G2 service_role cannot rewrite attendance directly (' || v || ')');
  v := hlc.run_as(1, format($q$insert into public.hr_overtime_requests(organization_id, employee_id, request_date, ot_minutes, status)
                              values (%L, %L, current_date, 60, 'approved')$q$, hlc.o(1), hlc.u(1)));
  perform hlc.expect(v like 'ERR:%hr_attendance_direct_write_refused%', 'G3 an employee cannot insert an approved OT request directly (' || v || ')');
  v := hlc.run_as(1, format($q$insert into public.hr_attendance_corrections(organization_id, entry_id, requested_by, reason, status)
                              values (%L, null, %L, 'x', 'approved')$q$, hlc.o(1), hlc.u(1)));
  perform hlc.expect(v like 'ERR:%', 'G4 an employee cannot insert a correction directly (' || v || ')');
  -- defect closed by Wave 3: the old RLS update policy let an employee update their OWN OT row (e.g. to approved)
  perform set_config('session_replication_role', 'replica', true);
  insert into public.hr_overtime_requests(id, organization_id, employee_id, request_date, ot_minutes, status, reason)
  values (hlc.x(1100), hlc.o(1), hlc.u(1), hw3.mon() - 7, 60, 'submitted', 'legacy row');
  perform set_config('session_replication_role', 'origin', true);
  v := hlc.run_as(1, format($q$update public.hr_overtime_requests set status = 'approved', approver_id = %L where id = %L$q$, hlc.u(1), hlc.x(1100)));
  perform hlc.expect(v like 'ERR:%hr_attendance_direct_write_refused%' and (select status from public.hr_overtime_requests where id = hlc.x(1100)) = 'submitted',
                     'G3b an employee can no longer approve their own OT through a direct update (' || v || ')');
  v := hlc.run_as(1, format('select public.hr_attendance_clock(%L, %L)', hlc.u(1), 'clock_in'));
  perform hlc.expect(v like 'ERR:%permission denied%', 'G5 authenticated users cannot call the attendance functions (' || v || ')');
  v := hlc.run_as(7, 'select count(*) from public.hr_attendance_exceptions');
  perform hlc.expect(v like 'ERR:%permission denied%', 'G6 exception table has no API privileges (' || v || ')');
  v := hlc.run_as(7, 'select count(*) from public.hr_leave_ledger');
  perform hlc.expect(v like 'ERR:%permission denied%', 'G7 leave ledger has no API privileges (' || v || ')');
  perform hlc.expect(has_function_privilege('service_role', 'public.hr_overtime_decide(uuid,uuid,text,text,integer)', 'execute')
                     and not has_function_privilege('service_role', 'public.hr_att_detect_day(uuid,uuid,date)', 'execute')
                     and not has_function_privilege('authenticated', 'public.hr_leave_adjust(uuid,uuid,uuid,integer,numeric,text)', 'execute'),
                     'G8 entry points: service_role only; internal helpers: nobody');
end $t$;

---------------------------------------------------------------- A: employee clock (server time)
do $t$
declare r jsonb; v text; e record; ts record;
begin
  r := public.hr_attendance_clock(hlc.u(1), 'clock_in', null, 'mobile', now() - interval '2 hours', 'from phone');
  select * into e from public.hr_attendance_entries where id = (r->>'entry_id')::uuid;
  perform hlc.expect(e.source = 'mobile' and abs(extract(epoch from (e.clock_in_at - now()))) < 5
                     and e.client_clock_in_at < now() - interval '1 hour' and e.work_date = hw3.today(),
                     'A1 clock-in records SERVER time (device time kept separately), channel and local work date');
  v := hw3.err(format('select public.hr_attendance_clock(%L, %L)', hlc.u(1), 'clock_in'));
  perform hlc.expect(v like '%hr_attendance_already_clocked_in%', 'A2 a second clock-in is refused (' || v || ')');
  r := public.hr_attendance_clock(hlc.u(1), 'clock_out', null, 'mobile', null, null);
  select * into e from public.hr_attendance_entries where id = (r->>'entry_id')::uuid;
  perform hlc.expect(e.status = 'closed' and e.clock_out_at is not null and e.worked_minutes >= 0, 'A3 clock-out closes the entry with worked minutes');
  perform hlc.expect(exists (select 1 from public.hr_timesheets where user_id = hlc.u(1) and status = 'pending'), 'A4 weekly timesheet summary maintained');
  perform hlc.expect(exists (select 1 from public.hr_attendance_audit where entity_id = e.id and action = 'clock_out'), 'A5 clock events audited');
  v := hw3.err(format('select public.hr_attendance_clock(%L, %L)', hlc.u(1), 'clock_out'));
  perform hlc.expect(v like '%hr_attendance_not_clocked_in%', 'A6 clock-out without an open entry is refused');
  v := hw3.err(format('select public.hr_attendance_clock(%L, %L)', hlc.u(12), 'clock_in'));
  perform hlc.expect(v like '%sa_actor_inactive%', 'A7 an archived account cannot clock in (' || v || ')');
  v := hw3.err(format('select public.hr_attendance_clock(%L, %L)', hlc.u(16), 'clock_in'));
  perform hlc.expect(v like '%hr_onboarding_pending%', 'A8 an employee awaiting onboarding cannot clock in (' || v || ')');
  v := hw3.err(format('select public.hr_attendance_clock(%L, %L, %L)', hlc.u(2), 'clock_in', hlc.x(999)));
  perform hlc.expect(v like '%hr_attendance_shift_invalid%', 'A9 an unknown shift is refused');
  -- an APPROVED timesheet is never reset by later clock events (defect of the old route)
  insert into public.hr_timesheets(organization_id, user_id, period_start, period_end, total_minutes, status)
  values (hlc.o(1), hlc.u(2), hw3.today() - ((extract(isodow from hw3.today())::int + 6) % 7),
          hw3.today() - ((extract(isodow from hw3.today())::int + 6) % 7) + 6, 999, 'approved');
  perform public.hr_attendance_clock(hlc.u(2), 'clock_in');
  perform public.hr_attendance_clock(hlc.u(2), 'clock_out');
  select * into ts from public.hr_timesheets where user_id = hlc.u(2) and period_start = hw3.today() - ((extract(isodow from hw3.today())::int + 6) % 7);
  perform hlc.expect(ts.status = 'approved' and ts.total_minutes = 999, 'A10 an approved timesheet period is not reset by clock events');
end $t$;

---------------------------------------------------------------- M: HR manual entry (maker-checker review)
do $t$
declare r jsonb; v text; e record;
begin
  v := hw3.err(format('select public.hr_attendance_manual_entry(%L, %L, %L, %L, %L, 60, %L, %L)', hlc.u(7), hlc.u(1), hw3.mon(), '09:30', '18:00', hlc.x(1002), ''));
  perform hlc.expect(v like '%hr_reason_required%', 'M1 a manual entry needs a reason');
  r := public.hr_attendance_manual_entry(hlc.u(7), hlc.u(1), hw3.mon(), time '09:30', time '18:00', 60, hlc.x(1002), 'Card reader offline');
  select * into e from public.hr_attendance_entries where id = (r->>'entry_id')::uuid;
  perform hlc.expect(e.source = 'hr_manual' and e.recorded_by_ref = hlc.u(7) and e.worked_minutes = 450 and e.attendance_flag = 'late'
                     and e.review_state = 'pending', 'M2 HR records a manual entry (on behalf, reason, late flag, pending review)');
  perform hlc.expect(exists (select 1 from public.hr_attendance_exceptions where entry_ref = e.id and exception_code = 'manual_entry' and status = 'open')
                     and exists (select 1 from public.hr_attendance_exceptions where entry_ref = e.id and exception_code = 'late_arrival'),
                     'M3 manual entry raises an independent review item and the late arrival exception');
  v := hw3.err(format('select public.hr_attendance_manual_entry(%L, %L, %L, %L, %L, 0, null, %L)', hlc.u(7), hlc.u(1), hw3.mon(), '10:00', '11:00', 'Duplicate test'));
  perform hlc.expect(v like '%hr_attendance_overlap%', 'M4 overlapping attendance is refused (' || v || ')');
  v := hw3.err(format('select public.hr_attendance_manual_entry(%L, %L, %L, %L, %L, 0, null, %L)', hlc.u(7), hlc.u(7), hw3.mon(), '09:00', '18:00', 'Own record'));
  perform hlc.expect(v like '%hr_self_change_prohibited%', 'M5 HR cannot create their own attendance');
  v := hw3.err(format('select public.hr_attendance_manual_entry(%L, %L, %L, %L, %L, 0, null, %L)', hlc.u(8), hlc.u(2), hw3.mon() + 6, '09:00', '18:00', 'Legacy attempt'));
  perform hlc.expect(v like '%sa_authorization_required%', 'M6 legacy-compatibility authority never counts (' || v || ')');
  v := hw3.err(format('select public.hr_attendance_manual_entry(%L, %L, %L, %L, %L, 0, null, %L)', hlc.u(11), hlc.u(2), hw3.mon() + 6, '09:00', '18:00', 'Other company'));
  perform hlc.expect(v like '%sa_authorization_required%', 'M7 HR of another company is refused');
  v := hw3.err(format('select public.hr_attendance_manual_entry(%L, %L, %L, %L, %L, 0, null, %L)', hlc.u(7), hlc.u(2), hw3.today() + 1, '09:00', '18:00', 'Future date'));
  perform hlc.expect(v like '%hr_attendance_future_date%', 'M8 a future date is refused');
  -- Saturday work of E2 recorded by H2
  r := public.hr_attendance_manual_entry(hlc.u(22), hlc.u(2), hw3.mon() + 5, time '10:00', time '14:00', 0, null, 'Stock count Saturday');
  perform hlc.expect(exists (select 1 from public.hr_attendance_exceptions where entry_ref = (r->>'entry_id')::uuid and exception_code = 'non_working_day_work'),
                     'M9 work on a rest day is flagged for review');
end $t$;

do $t$
declare x uuid; v text; r jsonb;
begin
  select id into x from public.hr_attendance_exceptions where employee_ref = hlc.u(1) and work_date = hw3.mon() and exception_code = 'manual_entry';
  v := hw3.err(format('select public.hr_attendance_resolve_exception(%L, %L, %L, null)', hlc.u(7), x, 'acknowledged'));
  perform hlc.expect(v like '%hr_attendance_maker_checker%', 'M10 the maker cannot approve their own manual entry (' || v || ')');
  v := hw3.err(format('select public.hr_attendance_resolve_exception(%L, %L, %L, null)', hlc.u(1), x, 'acknowledged'));
  perform hlc.expect(v like '%hr_attendance_self_review%', 'M11 the employee cannot review their own attendance');
  v := hw3.err(format('select public.hr_attendance_resolve_exception(%L, %L, %L, null)', hlc.u(5), x, 'acknowledged'));
  perform hlc.expect(v like '%hr_attendance_not_authorized%', 'M12 a manager cannot confirm an HR manual entry (HR reviews HR entries)');
  r := public.hr_attendance_resolve_exception(hlc.u(22), x, 'acknowledged', null);
  perform hlc.expect(r->>'authority' = 'hr' and (select status from public.hr_attendance_exceptions where id = x) = 'resolved',
                     'M13 a second HR person confirms the manual entry');
  v := hw3.err(format('select public.hr_attendance_resolve_exception(%L, %L, %L, null)', hlc.u(9), x, 'acknowledged'));
  perform hlc.expect(v like '%hr_attendance_already_decided%', 'M14 a resolved item cannot be resolved twice');
end $t$;

---------------------------------------------------------------- I: Excel bulk import
do $t$
declare r jsonb; v text; b uuid; rows jsonb; h text := repeat('a', 64);
begin
  rows := jsonb_build_array(
    jsonb_build_object('row_no', 2, 'employee_no', '910002', 'work_date', (hw3.mon())::text, 'clock_in', '09:00', 'clock_out', '18:00'),
    jsonb_build_object('row_no', 3, 'employee_no', '910001', 'work_date', (hw3.mon())::text, 'clock_in', '10:00', 'clock_out', '12:00'),
    jsonb_build_object('row_no', 4, 'employee_no', '999999', 'work_date', (hw3.mon())::text, 'clock_in', '09:00', 'clock_out', '18:00'),
    jsonb_build_object('row_no', 5, 'employee_no', '910002', 'work_date', '25/10/2026', 'clock_in', '09:00', 'clock_out', '18:00'),
    jsonb_build_object('row_no', 6, 'employee_no', '910002', 'work_date', (hw3.today() + 3)::text, 'clock_in', '09:00', 'clock_out', '18:00'),
    jsonb_build_object('row_no', 7, 'employee_no', '910002', 'work_date', (hw3.mon())::text, 'clock_in', '09:00', 'clock_out', '17:00'),
    jsonb_build_object('row_no', 8, 'email', 'HLC-22@example.test', 'work_date', (hw3.mon() + 1)::text, 'clock_in', '08:30', 'clock_out', '17:30', 'break_minutes', '60'),
    jsonb_build_object('row_no', 9, 'email', 'hlc-3@example.test', 'work_date', (hw3.mon() + 1)::text, 'clock_in', '08:30', 'clock_out', '17:30'),
    jsonb_build_object('row_no', 10, 'employee_no', '910002', 'email', 'hlc-1@example.test', 'work_date', (hw3.mon() + 1)::text, 'clock_in', '09:00', 'clock_out', '18:00'),
    jsonb_build_object('row_no', 11, 'employee_no', '910005', 'work_date', (hw3.mon() + 1)::text, 'clock_in', '9am', 'clock_out', '18:00'));
  v := hlc.run_as(7, format('select public.hr_attendance_import_preview(%L, %L, %L, %L, %L)', hlc.u(7), hlc.o(1), 'att.xlsx', h, rows));
  perform hlc.expect(v like 'ERR:%permission denied%', 'I1 the import cannot be called from the browser session');
  v := hw3.err(format('select public.hr_attendance_import_preview(%L, %L, %L, %L, %L)', hlc.u(8), hlc.o(1), 'att.xlsx', h, rows));
  perform hlc.expect(v like '%sa_authorization_required%', 'I2 legacy-compatibility users cannot import');
  r := public.hr_attendance_import_preview(hlc.u(7), hlc.o(1), 'att.xlsx', h, rows);
  b := (r->'batch'->>'id')::uuid;
  perform hlc.expect((r->'batch'->>'valid_count')::int = 2 and (r->'batch'->>'conflict_count')::int = 1
                     and (r->'batch'->>'duplicate_count')::int = 1 and (r->'batch'->>'error_count')::int = 6,
                     'I3 preview classifies rows (2 valid, 1 conflict, 1 duplicate, 6 errors): ' || (r->>'batch'));
  perform hlc.expect((select outcome from public.hr_attendance_import_rows where batch_ref = b and row_no = 3) = 'conflict'
                     and (select outcome from public.hr_attendance_import_rows where batch_ref = b and row_no = 7) = 'duplicate'
                     and (select 'Employee number and e-mail belong to different people.' = any(messages) from public.hr_attendance_import_rows where batch_ref = b and row_no = 10)
                     and (select messages[1] like 'No onboarded employee%' from public.hr_attendance_import_rows where batch_ref = b and row_no = 9),
                     'I4 per-row reasons: conflict with recorded attendance, duplicate in file, e-mail/number mismatch, other company');
  perform hlc.expect(not exists (select 1 from public.hr_attendance_entries where import_batch_ref = b), 'I5 nothing is written by the preview');
  v := hw3.err(format('select public.hr_attendance_import_commit(%L, %L, 5)', hlc.u(7), b));
  perform hlc.expect(v like '%hr_import_preview_changed%', 'I6 commit must confirm the previewed valid count');
  r := public.hr_attendance_import_commit(hlc.u(7), b, 2);
  perform hlc.expect((r->>'imported')::int = 2 and (select count(*) from public.hr_attendance_entries where import_batch_ref = b and source = 'import') = 2
                     and (select count(*) from public.hr_attendance_import_rows where batch_ref = b and outcome = 'imported' and entry_ref is not null) = 2,
                     'I7 commit imports the valid rows with per-row outcome and batch reference');
  r := public.hr_attendance_import_commit(hlc.u(7), b, 2);
  perform hlc.expect(r->>'status' = 'already_committed' and (select count(*) from public.hr_attendance_entries where import_batch_ref = b) = 2,
                     'I8 retrying the commit is safe (idempotent)');
  v := hw3.err(format('select public.hr_attendance_import_preview(%L, %L, %L, %L, %L)', hlc.u(22), hlc.o(1), 'copy.xlsx', h, rows));
  perform hlc.expect(v like '%hr_import_file_already_committed%', 'I9 the same file cannot be imported twice');
  perform hlc.expect(exists (select 1 from public.hr_attendance_audit where entity_id = b and action = 'import_committed'), 'I10 import audited');
end $t$;

do $t$
declare r jsonb; b uuid; h text := repeat('b', 64);
begin
  -- commit-time re-validation: attendance recorded between preview and commit is never overwritten
  r := public.hr_attendance_import_preview(hlc.u(7), hlc.o(1), 'late.xlsx', h, jsonb_build_array(
         jsonb_build_object('row_no', 2, 'employee_no', '910006', 'work_date', (hw3.mon() + 1)::text, 'clock_in', '09:00', 'clock_out', '18:00')));
  b := (r->'batch'->>'id')::uuid;
  perform public.hr_attendance_manual_entry(hlc.u(7), hlc.u(6), hw3.mon() + 1, time '09:00', time '12:00', 0, null, 'Recorded meanwhile');
  r := public.hr_attendance_import_commit(hlc.u(7), b, 1);
  perform hlc.expect((r->>'imported')::int = 0 and (r->>'conflicts_at_commit')::int = 1
                     and (select outcome from public.hr_attendance_import_rows where batch_ref = b) = 'conflict',
                     'I11 commit re-validates: a row that now overlaps is reported as conflict, not imported');
end $t$;

---------------------------------------------------------------- X: exception detection (auto-validation)
do $t$
declare r jsonb; n int;
begin
  -- E2 approved leave on Friday of the reference week (database-owned insert = historical row)
  perform set_config('session_replication_role', 'replica', true);   -- historical fixture row (no API path)
  insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, total_days, status, approved_by, approved_at)
  values (hlc.o(1), hlc.u(2), hlc.x(406), hw3.mon() + 4, hw3.mon() + 4, 1, 'approved', hlc.u(7), now());
  perform set_config('session_replication_role', 'origin', true);
  r := public.hr_attendance_run_detection(hlc.u(7), hlc.o(1), hw3.mon(), hw3.mon() + 6);
  perform hlc.expect((r->>'new_exceptions')::int > 0, 'X1 detection runs for a date range: ' || r::text);
  perform hlc.expect(exists (select 1 from public.hr_attendance_exceptions where employee_ref = hlc.u(1) and work_date = hw3.mon() + 1 and exception_code = 'absent_no_record'),
                     'X2 a working day without attendance or leave is an absence exception');
  perform hlc.expect(not exists (select 1 from public.hr_attendance_exceptions where work_date = hw3.mon() + 2 and exception_code = 'absent_no_record'),
                     'X3 national public holiday: no absence for anyone');
  perform hlc.expect(not exists (select 1 from public.hr_attendance_exceptions where employee_ref = hlc.u(1) and work_date = hw3.mon() + 3 and exception_code = 'absent_no_record')
                     and exists (select 1 from public.hr_attendance_exceptions where employee_ref = hlc.u(2) and work_date = hw3.mon() + 3 and exception_code = 'absent_no_record'),
                     'X4 state holiday follows the employee''s work state (Selangor E1 off, E2 absent)');
  perform hlc.expect(not exists (select 1 from public.hr_attendance_exceptions where employee_ref = hlc.u(2) and work_date = hw3.mon() + 4 and exception_code = 'absent_no_record'),
                     'X5 approved leave: no absence');
  perform hlc.expect(not exists (select 1 from public.hr_attendance_exceptions x join public.hr_attendance_entries e on e.id = x.entry_ref
                                 where e.import_batch_ref is not null and e.user_id = hlc.u(2) and x.exception_code in ('late_arrival', 'early_departure')),
                     'X6 a normal imported day needs no review (auto-validated)');
  select count(*) into n from public.hr_attendance_exceptions;
  r := public.hr_attendance_run_detection(hlc.u(7), hlc.o(1), hw3.mon(), hw3.mon() + 6);
  perform hlc.expect((r->>'new_exceptions')::int = 0 and (select count(*) from public.hr_attendance_exceptions) = n,
                     'X7 detection is idempotent (re-run creates nothing)');
  perform hlc.expect(hw3.err(format('select public.hr_attendance_run_detection(%L, %L, %L, %L)', hlc.u(1), hlc.o(1), hw3.mon(), hw3.mon())) like '%sa_authorization_required%',
                     'X8 only HR runs organization-wide detection');
  perform hlc.expect(hw3.err(format('select public.hr_attendance_run_detection(%L, %L, %L, %L)', hlc.u(7), hlc.o(1), hw3.mon() - 100, hw3.mon())) like '%hr_attendance_range_invalid%',
                     'X9 detection range is bounded');
end $t$;

do $t$
declare x uuid; v text; r jsonb;
begin
  select id into x from public.hr_attendance_exceptions where employee_ref = hlc.u(1) and work_date = hw3.mon() and exception_code = 'late_arrival';
  v := hw3.err(format('select public.hr_attendance_resolve_exception(%L, %L, %L, null)', hlc.u(5), x, 'excused'));
  perform hlc.expect(v like '%hr_comment_required%', 'X10 excusing needs a note');
  v := hw3.err(format('select public.hr_attendance_resolve_exception(%L, %L, %L, %L)', hlc.u(6), x, 'excused', 'Traffic'));
  perform hlc.expect(v like '%hr_attendance_not_authorized%', 'X11 a manager without the approval key (or not the direct manager) is refused');
  v := hw3.err(format('select public.hr_attendance_resolve_exception(%L, %L, %L, %L)', hlc.u(8), x, 'excused', 'Traffic'));
  perform hlc.expect(v like '%hr_attendance_not_authorized%', 'X12 legacy-compatibility authority never counts');
  r := public.hr_attendance_resolve_exception(hlc.u(5), x, 'excused', 'Road closure reported');
  perform hlc.expect(r->>'authority' = 'manager', 'X13 direct manager with hr.mss.attendance_approve resolves (forward-compatible MSS path)');
  perform hlc.expect(jsonb_array_length(public.hr_attendance_review_queue(hlc.u(6), hlc.o(1), 'exceptions', 'open', null, null)) = 0,
                     'X14 a manager without MSS sees no exceptions');
  perform hlc.expect((select bool_and(e->>'employee_id' in (hlc.u(1)::text, hlc.u(3)::text, hlc.u(13)::text, hlc.u(16)::text))
                      from jsonb_array_elements(public.hr_attendance_review_queue(hlc.u(5), hlc.o(1), 'exceptions', null, null, null)) e),
                     'X15 a manager sees only direct reports');
  perform hlc.expect(not exists (select 1 from jsonb_array_elements(public.hr_attendance_review_queue(hlc.u(7), hlc.o(1), 'exceptions', null, null, null)) e
                                 where e->>'employee_id' = hlc.u(7)::text), 'X16 HR never sees their own items in the review queue');
end $t$;

---------------------------------------------------------------- C: corrections
do $t$
declare r jsonb; v text; c uuid; e uuid; c2 uuid;
begin
  r := public.hr_attendance_request_correction(hlc.u(1), null, hw3.mon() + 1, time '09:00', time '18:00', 60, 'Forgot to clock in and out');
  c := (r->>'correction_id')::uuid;
  perform hlc.expect(r->>'kind' = 'missing_day' and r->>'status' = 'pending', 'C1 employee requests a missing-day correction');
  v := hw3.err(format('select public.hr_attendance_request_correction(%L, null, %L, %L, %L, 60, %L)', hlc.u(1), hw3.mon() + 1, '09:00', '18:00', 'Second try'));
  perform hlc.expect(v like '%hr_attendance_correction_pending%', 'C2 only one pending correction per day/entry (' || v || ')');
  v := hw3.err(format('select public.hr_attendance_decide_correction(%L, %L, %L, null)', hlc.u(1), c, 'approved'));
  perform hlc.expect(v like '%hr_attendance_self_review%', 'C3 an employee cannot approve their own correction');
  v := hw3.err(format('select public.hr_attendance_decide_correction(%L, %L, %L, null)', hlc.u(6), c, 'approved'));
  perform hlc.expect(v like '%hr_attendance_not_authorized%', 'C4 an unrelated manager is refused');
  v := hw3.err(format('select public.hr_attendance_decide_correction(%L, %L, %L, %L)', hlc.u(7), c, 'rejected', ''));
  perform hlc.expect(v like '%hr_comment_required%', 'C5 a rejection needs a comment');
  r := public.hr_attendance_decide_correction(hlc.u(7), c, 'approved', 'Confirmed with the manager');
  e := (r->>'entry_id')::uuid;
  perform hlc.expect((select source from public.hr_attendance_entries where id = e) = 'correction'
                     and (select worked_minutes from public.hr_attendance_entries where id = e) = 480,
                     'C6 approval creates the missing entry (source correction, 480 minutes)');
  perform hlc.expect((select resolution from public.hr_attendance_exceptions where employee_ref = hlc.u(1) and work_date = hw3.mon() + 1 and exception_code = 'absent_no_record') = 'corrected',
                     'C7 the absence is resolved as corrected');
  perform hlc.expect((select metadata->'after' is not null from public.hr_attendance_audit where entity_id = c and action = 'correction_approved'),
                     'C8 decision audited with before/after values');
  -- correction of an existing entry: original values preserved
  select id into e from public.hr_attendance_entries where user_id = hlc.u(1) and work_date = hw3.mon() and source = 'hr_manual';
  r := public.hr_attendance_request_correction(hlc.u(1), e, null, time '09:05', null, null, 'Arrived 09:05 (reader delay)');
  c2 := (r->>'correction_id')::uuid;
  perform hlc.expect((select original_clock_in from public.hr_attendance_corrections where id = c2) = (select clock_in_at from public.hr_attendance_entries where id = e),
                     'C9 the correction keeps the original values');
  r := public.hr_attendance_decide_correction(hlc.u(5), c2, 'approved', null);
  perform hlc.expect(r->>'authority' = 'manager' and (select attendance_flag from public.hr_attendance_entries where id = e) = 'ontime'
                     and (select status from public.hr_attendance_entries where id = e) = 'adjusted',
                     'C10 the direct manager (hr.mss.attendance_approve) approves; entry adjusted and re-evaluated (on time)');
  -- HR adjustment on behalf: maker-checker
  select id into e from public.hr_attendance_entries where user_id = hlc.u(2) and import_batch_ref is not null limit 1;
  r := public.hr_attendance_request_correction(hlc.u(7), e, null, null, time '17:30', null, 'Badge-out recorded late');
  c := (r->>'correction_id')::uuid;
  perform hlc.expect(r->>'kind' = 'hr_adjustment', 'C11 HR adjustment is recorded as a correction (maker-checker)');
  v := hw3.err(format('select public.hr_attendance_decide_correction(%L, %L, %L, null)', hlc.u(7), c, 'approved'));
  perform hlc.expect(v like '%hr_attendance_self_review%', 'C12 the HR maker cannot approve their own adjustment');
  r := public.hr_attendance_decide_correction(hlc.u(22), c, 'approved', null);
  perform hlc.expect((select worked_minutes from public.hr_attendance_entries where id = e) = 510, 'C13 a second HR person approves; worked minutes recalculated');
  v := hw3.err(format('select public.hr_attendance_request_correction(%L, %L, null, null, null, null, %L)', hlc.u(2), hlc.x(1), 'Not mine'));
  perform hlc.expect(v like '%hr_attendance_entry_not_found%', 'C14 unknown entry refused');
  v := hw3.err(format('select public.hr_attendance_request_correction(%L, %L, null, %L, null, null, %L)', hlc.u(2), e, '08:00', 'Someone else'));
  perform hlc.expect(v = 'OK', 'C15 the employee may request a correction of their own entry');
  v := hw3.err(format('select public.hr_attendance_request_correction(%L, %L, null, %L, null, null, %L)', hlc.u(1), e, '08:00', 'Someone else entry'));
  perform hlc.expect(v like '%hr_attendance_not_authorized%', 'C16 an employee cannot request a correction of someone else''s entry');
  select id into c from public.hr_attendance_corrections where employee_ref = hlc.u(2) and status = 'pending' and requested_by = hlc.u(2);
  perform hlc.expect(hw3.err(format('select public.hr_attendance_cancel_correction(%L, %L)', hlc.u(1), c)) like '%hr_attendance_not_authorized%'
                     and (public.hr_attendance_cancel_correction(hlc.u(2), c))->>'status' = 'cancelled',
                     'C17 only the requester withdraws a pending correction');
end $t$;

---------------------------------------------------------------- O: overtime
do $t$
declare r jsonb; v text; q1 uuid; q2 uuid; q3 uuid; n int;
begin
  r := public.hr_overtime_submit(hlc.u(1), hw3.mon(), 60, 'Month-end closing', 'post', null, null, null, 'idem-e1-1');
  q1 := (r->>'request_id')::uuid;
  perform hlc.expect(r->>'status' = 'submitted' and (r->>'exceeds_recorded_time')::boolean,
                     'O1 post-OT submitted and flagged when recorded time does not cover it: ' || r::text);
  r := public.hr_overtime_submit(hlc.u(1), hw3.mon(), 60, 'Month-end closing', 'post', null, null, null, 'idem-e1-1');
  perform hlc.expect((r->>'replayed')::boolean and (r->>'request_id')::uuid = q1, 'O2 a retried submission returns the same request (idempotency key)');
  v := hw3.err(format('select public.hr_overtime_submit(%L, %L, 30, %L)', hlc.u(1), hw3.mon(), 'Second claim same day'));
  perform hlc.expect(v like '%hr_ot_duplicate%', 'O3 a second active OT claim for the same day is refused');
  v := hw3.err(format('select public.hr_overtime_decide(%L, %L, %L, null)', hlc.u(1), q1, 'approved'));
  perform hlc.expect(v like '%hr_ot_self_approval%', 'O4 no self-approval');
  v := hw3.err(format('select public.hr_overtime_decide(%L, %L, %L, null)', hlc.u(6), q1, 'approved'));
  perform hlc.expect(v like '%hr_attendance_not_authorized%', 'O5 a manager without the OT key / not the direct manager is refused');
  v := hw3.err(format('select public.hr_overtime_decide(%L, %L, %L, null)', hlc.u(8), q1, 'approved'));
  perform hlc.expect(v like '%hr_attendance_not_authorized%', 'O6 legacy-compatibility authority never approves OT');
  v := hw3.err(format('select public.hr_overtime_decide(%L, %L, %L, null)', hlc.u(11), q1, 'approved'));
  perform hlc.expect(v like '%hr_attendance_not_authorized%', 'O7 HR of another company is refused');
  r := public.hr_overtime_decide(hlc.u(5), q1, 'approved', 'OK', 45);
  perform hlc.expect(r->>'authority' = 'manager' and (r->>'approved_minutes')::int = 45
                     and (select approver_id from public.hr_overtime_requests where id = q1) = hlc.u(5),
                     'O8 the direct manager approves (partially: 45 of 60 minutes)');
  v := hw3.err(format('select public.hr_overtime_decide(%L, %L, %L, null)', hlc.u(7), q1, 'rejected'));
  perform hlc.expect(v like '%hr_attendance_already_decided%', 'O9 a decided request cannot be decided again');
  -- E2: imported 09:00-18:00 covers 60 min; national holiday claim; HR decisions
  r := public.hr_overtime_submit(hlc.u(2), hw3.mon(), 30, 'Supplier delivery');
  q2 := (r->>'request_id')::uuid;
  perform hlc.expect(not (r->>'exceeds_recorded_time')::boolean, 'O10 OT covered by the recorded attendance is not flagged');
  r := public.hr_overtime_submit(hlc.u(2), hw3.mon() + 2, 30, 'Holiday stock-take');
  q3 := (r->>'request_id')::uuid;
  perform hlc.expect(r->>'day_type' = 'public_holiday', 'O11 day type is derived by the database (public holiday)');
  v := hw3.err(format('select public.hr_overtime_decide(%L, %L, %L, %L)', hlc.u(7), q2, 'rejected', ''));
  perform hlc.expect(v like '%hr_comment_required%', 'O12 a rejection needs a comment');
  perform public.hr_overtime_decide(hlc.u(7), q2, 'rejected', 'Covered by shift swap');
  perform public.hr_overtime_decide(hlc.u(7), q3, 'approved', null);
  perform hlc.expect((select decided_authority from public.hr_overtime_requests where id = q3) = 'hr', 'O13 explicit HR approves');
  v := hw3.err(format('select public.hr_overtime_cancel(%L, %L, %L)', hlc.u(2), q3, 'Changed my mind'));
  perform hlc.expect(v like '%hr_ot_cancel_approved_by_hr%', 'O14 the employee cannot cancel approved OT');
  perform public.hr_overtime_cancel(hlc.u(22), q3, 'Holiday work cancelled by management');
  select count(*) into n from public.hr_overtime_request_events where request_ref = q3;
  perform hlc.expect(n = 3 and (select string_agg(action, '>' order by created_at) from public.hr_overtime_request_events where request_ref = q3) = 'submitted>approved>cancelled',
                     'O15 status history is recorded (submitted > approved > cancelled)');
  begin
    update public.hr_overtime_request_events set comment = 'x' where request_ref = q3;
    perform hlc.expect(false, 'O16 history update must fail');
  exception when others then
    perform hlc.expect(sqlerrm like '%hr_history_append_only%', 'O16 OT history is append-only');
  end;
  v := hw3.err(format('select public.hr_overtime_submit(%L, %L, 60, %L, %L)', hlc.u(1), hw3.today() - 1, 'Pre in past', 'pre'));
  perform hlc.expect(v like '%hr_ot_pre_in_past%', 'O17 a pre-approval request cannot be for a past date');
  v := hw3.err(format('select public.hr_overtime_submit(%L, %L, 60, %L, %L)', hlc.u(1), hw3.today() + 1, 'Post in future', 'post'));
  perform hlc.expect(v like '%hr_ot_post_in_future%', 'O18 a post-OT claim cannot be for a future date');
  r := public.hr_overtime_submit(hlc.u(1), hw3.today() + 1, 150, 'Planned system cut-over', 'pre', null, time '18:00', time '20:30');
  perform hlc.expect((r->>'exceeds_policy_cap')::boolean, 'O19 a request above the policy daily cap is flagged (not auto-refused)');
  perform hlc.expect((select bool_and(e->>'employee_id' in (hlc.u(1)::text, hlc.u(3)::text, hlc.u(13)::text, hlc.u(16)::text))
                      from jsonb_array_elements(public.hr_overtime_list(hlc.u(5), 'queue', null, hlc.o(1))) e)
                     and jsonb_array_length(public.hr_overtime_list(hlc.u(6), 'queue', null, hlc.o(1))) = 0,
                     'O20 the manager queue holds only direct reports; a manager without the OT key sees nothing');
  perform hlc.expect(jsonb_array_length(public.hr_overtime_list(hlc.u(1), 'mine', null, null)) = 3, 'O21 the employee sees their own requests with history');
  perform hlc.expect(hw3.err(format('select public.hr_overtime_submit(%L, %L, 5, %L)', hlc.u(2), hw3.mon() + 1, 'Too short')) like '%hr_ot_minutes_invalid%',
                     'O22 minutes are validated');
end $t$;

---------------------------------------------------------------- R: read models / reporting
do $t$
declare r jsonb;
begin
  r := public.hr_attendance_my_overview(hlc.u(1), hw3.mon(), hw3.today());
  perform hlc.expect(jsonb_array_length(r->'entries') >= 3 and r->>'timezone' = 'Asia/Kuala_Lumpur', 'R1 employee history with exceptions and corrections');
  r := public.hr_attendance_day_board(hlc.u(7), hlc.o(1), hw3.mon());
  perform hlc.expect(jsonb_array_length(r) >= 5, 'R2 HR daily board lists the organization''s employees');
  perform hlc.expect(jsonb_array_length(public.hr_attendance_day_board(hlc.u(6), hlc.o(1), hw3.mon())) = 0, 'R3 a manager without MSS sees nobody on the board');
  r := public.hr_attendance_period_report(hlc.u(7), hlc.o(1), hw3.mon(), hw3.mon() + 6);
  perform hlc.expect(exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'employee_id' = hlc.u(1)::text and (x->>'ot_approved_minutes')::int = 45),
                     'R4 period report carries approved OT minutes (45 for E1)');
  perform hlc.expect(hw3.err(format('select public.hr_attendance_period_report(%L, %L, %L, %L)', hlc.u(5), hlc.o(1), hw3.mon(), hw3.mon())) like '%sa_authorization_required%',
                     'R5 the period report is HR-only');
end $t$;

---------------------------------------------------------------- L: leave ledger
do $t$
declare b jsonb; v text; lv date := hw3.mon() + 140; ly int := extract(year from hw3.mon() + 140)::int; r jsonb; q uuid := gen_random_uuid();
begin
  -- L0 opening: every fixture balance kept its available days
  perform hlc.expect(not exists (select 1 from public.hr_leave_balances lb
                                 where (public.hr_leave_balance_of(lb.employee_id, lb.leave_type_id, lb.year)->>'taken')::numeric <> lb.taken
                                    or (public.hr_leave_balance_of(lb.employee_id, lb.leave_type_id, lb.year)->>'entitled')::numeric <> lb.entitled),
                     'L0 hr_leave_balances equals the ledger projection');
  -- the database counts working days, whatever the client sends
  v := hlc.run_as(1, format($q$insert into public.hr_leave_requests(id, organization_id, employee_id, leave_type_id, start_date, end_date, total_days, status)
                              values (%L, %L, %L, %L, %L, %L, 9, 'pending')$q$, q, hlc.o(1), hlc.u(1), hlc.x(401), lv, lv + 4));
  perform hlc.expect(v = 'OK:1' and (select total_days from public.hr_leave_requests where id = q) = 5, 'L1 Mon–Fri = 5 working days (client value 9 ignored): ' || v);
  v := hlc.run_as(1, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status)
                              values (%L, %L, %L, %L, %L, 'pending')$q$, hlc.o(1), hlc.u(1), hlc.x(401), lv + 5, lv + 6));
  perform hlc.expect(v like 'ERR:%hr_leave_no_working_days%', 'L2 a weekend-only request is refused (' || v || ')');
  v := hlc.run_as(1, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status)
                              values (%L, %L, %L, %L, %L, 'pending')$q$, hlc.o(1), hlc.u(1), hlc.x(401), lv + 4, lv + 7));
  perform hlc.expect(v like 'ERR:%hr_leave_overlap%', 'L3 overlapping own leave is refused (' || v || ')');
  v := hlc.run_as(1, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status, is_half_day, half_day_period)
                              values (%L, %L, %L, %L, %L, 'pending', true, 'morning')$q$, hlc.o(1), hlc.u(1), hlc.x(406), lv + 11, lv + 11));
  perform hlc.expect(v = 'OK:1' and (select total_days from public.hr_leave_requests where employee_id = hlc.u(1) and start_date = lv + 11) = 0.5,
                     'L4 a half day counts 0.5');
  -- entitlement + insufficient balance
  v := hw3.err(format('select public.hr_leave_set_entitlement(%L, %L, %L, %s, 3, %L)', hlc.u(7), hlc.u(7), hlc.x(401), ly, 'Own record'));
  perform hlc.expect(v like '%hr_self_change_prohibited%', 'L5 HR cannot set their own entitlement');
  v := hw3.err(format('select public.hr_leave_set_entitlement(%L, %L, %L, %s, 3, %L)', hlc.u(8), hlc.u(2), hlc.x(401), ly, 'Legacy attempt'));
  perform hlc.expect(v like '%sa_authorization_required%', 'L6 legacy-compatibility users cannot administer balances');
  r := public.hr_leave_set_entitlement(hlc.u(7), hlc.u(2), hlc.x(401), ly, 3, 'Probation year entitlement');
  perform hlc.expect((r->'balance'->>'available')::numeric = 3, 'L7 HR sets an entitlement (ledger entry, projection updated)');
  v := hlc.run_as(2, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status)
                              values (%L, %L, %L, %L, %L, 'pending')$q$, hlc.o(1), hlc.u(2), hlc.x(401), lv, lv + 3));
  perform hlc.expect(v like 'ERR:%hr_leave_insufficient_balance%', 'L8 more days than available are refused where an entitlement exists (' || v || ')');
  v := hlc.run_as(2, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status)
                              values (%L, %L, %L, %L, %L, 'pending')$q$, hlc.o(1), hlc.u(2), hlc.x(401), lv, lv + 1));
  perform hlc.expect(v = 'OK:1', 'L9 within the balance it is accepted');
  b := public.hr_leave_balance_of(hlc.u(2), hlc.x(401), ly);
  perform hlc.expect((b->>'pending')::numeric = 2 and (b->>'available')::numeric = 1
                     and (select pending from public.hr_leave_balances where employee_id = hlc.u(2) and leave_type_id = hlc.x(401) and year = ly) = 2,
                     'L10 pending days reduce the available balance (projection kept in step)');
end $t$;

do $t$
declare v text; lv date := hw3.mon() + 140; ly int := extract(year from hw3.mon() + 140)::int; q uuid; b jsonb;
begin
  select id into q from public.hr_leave_requests where employee_id = hlc.u(2) and start_date = lv and leave_type_id = hlc.x(401);
  -- E2's manager is M2 (no MSS): H1 decides (B2A rule unchanged)
  v := hlc.run_as(7, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, q));
  perform hlc.expect(v = 'OK:1', 'L11 HR approves (B2A authority unchanged): ' || v);
  b := public.hr_leave_balance_of(hlc.u(2), hlc.x(401), ly);
  perform hlc.expect((b->>'taken')::numeric = 2 and (b->>'pending')::numeric = 0 and (b->>'available')::numeric = 1
                     and exists (select 1 from public.hr_leave_ledger where request_ref = q and entry_type = 'taken' and days = -2),
                     'L12 approval posts the taken days to the ledger');
  v := hlc.run_as(7, format($q$update public.hr_leave_requests set status = 'cancelled' where id = %L$q$, q));
  b := public.hr_leave_balance_of(hlc.u(2), hlc.x(401), ly);
  perform hlc.expect(v = 'OK:1' and (b->>'taken')::numeric = 0 and (b->>'available')::numeric = 3
                     and exists (select 1 from public.hr_leave_ledger where request_ref = q and entry_type = 'taken_reversal' and days = 2),
                     'L13 HR cancellation of approved leave posts a reversal (history kept)');
  begin
    update public.hr_leave_ledger set days = 99 where request_ref = q;
    perform hlc.expect(false, 'L14 ledger update must fail');
  exception when others then
    perform hlc.expect(sqlerrm like '%hr_history_append_only%', 'L14 the ledger is append-only');
  end;
  -- approval re-checks the balance: E2 applies 3 days, HR reduces the balance meanwhile
  v := hlc.run_as(2, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status)
                              values (%L, %L, %L, %L, %L, 'pending')$q$, hlc.o(1), hlc.u(2), hlc.x(401), lv + 14, lv + 16));
  perform public.hr_leave_adjust(hlc.u(7), hlc.u(2), hlc.x(401), ly, -1, 'Correction of entitlement');
  select id into q from public.hr_leave_requests where employee_id = hlc.u(2) and start_date = lv + 14;
  v := hlc.run_as(7, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, q));
  perform hlc.expect(v like 'ERR:%hr_leave_insufficient_balance%', 'L15 approval is refused when it would exceed the balance (' || v || ')');
  perform hlc.expect(hw3.err(format('select public.hr_leave_adjust(%L, %L, %L, %s, 0.3, %L)', hlc.u(7), hlc.u(2), hlc.x(401), ly, 'Odd fraction')) like '%hr_leave_days_invalid%',
                     'L16 adjustments are whole or half days');
end $t$;

do $t$
declare r jsonb; ly int := extract(year from hw3.mon() + 140)::int; v text;
begin
  r := public.hr_leave_entitlement_run(hlc.u(7), hlc.o(1), hlc.x(401), ly, true, null);
  perform hlc.expect((r->>'applied')::int = 0 and exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'employee_id' = hlc.u(1)::text
                     and (x->>'days')::numeric = 12 and x->>'status' = 'would_set')
                     and exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'employee_id' = hlc.u(2)::text and x->>'status' = 'skipped_existing')
                     and exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'employee_id' = hlc.u(7)::text and x->>'status' = 'skipped_own_record'),
                     'L17 entitlement preview uses the leave type''s tiers (E1 4 years → 12); existing and own records skipped');
  r := public.hr_leave_entitlement_run(hlc.u(7), hlc.o(1), hlc.x(401), extract(year from hw3.today())::int, true, null);
  perform hlc.expect(exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'employee_id' = hlc.u(22)::text and (x->>'days')::numeric = 8),
                     'L18 tier 0–2 years → 8 days');
  v := hw3.err(format('select public.hr_leave_entitlement_run(%L, %L, %L, %s, false, null)', hlc.u(7), hlc.o(1), hlc.x(401), ly));
  perform hlc.expect(v like '%hr_reason_required%', 'L19 applying the run needs a reason');
  r := public.hr_leave_entitlement_run(hlc.u(7), hlc.o(1), hlc.x(401), ly, false, 'Annual entitlement run');
  perform hlc.expect((r->>'applied')::int > 0 and (public.hr_leave_balance_of(hlc.u(1), hlc.x(401), ly)->>'entitled')::numeric = 12, 'L20 run applied');
  r := public.hr_leave_entitlement_run(hlc.u(7), hlc.o(1), hlc.x(401), ly, false, 'Annual entitlement run again');
  perform hlc.expect((r->>'applied')::int = 0, 'L21 re-running applies nothing twice');
  -- carry forward into the next year, capped at the type's configured 5 days
  r := public.hr_leave_carry_forward_run(hlc.u(7), hlc.o(1), hlc.x(401), ly, true, null);
  perform hlc.expect(exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'employee_id' = hlc.u(22)::text and (x->>'days')::numeric = 5
                            and x->>'status' = 'would_carry')
                     and exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'employee_id' = hlc.u(1)::text and x->>'status' = 'skipped_pending_requests'),
                     'L22 carry-forward preview: capped at 5; employees with pending requests skipped');
  r := public.hr_leave_carry_forward_run(hlc.u(7), hlc.o(1), hlc.x(401), ly, false, 'Year-end carry forward');
  perform hlc.expect((public.hr_leave_balance_of(hlc.u(22), hlc.x(401), ly + 1)->>'carried_forward')::numeric = 5, 'L23 carry-forward posted to the next year');
  r := public.hr_leave_carry_forward_run(hlc.u(7), hlc.o(1), hlc.x(401), ly, false, 'Year-end carry forward again');
  perform hlc.expect((r->>'applied')::int = 0, 'L24 carry-forward is idempotent');
end $t$;

do $t$
declare r jsonb; lv date := hw3.mon() + 140; v text;
begin
  r := public.hr_leave_quote(hlc.u(1), hlc.x(401), lv + 21, lv + 27, false, null);
  perform hlc.expect((r->>'working_days')::numeric = 5 and jsonb_array_length(r->'non_working_dates') = 2, 'L25 quote: 5 working days, 2 rest days listed');
  r := public.hr_leave_quote(hlc.u(1), hlc.x(401), lv, lv, false, null);
  perform hlc.expect(jsonb_array_length(r->'errors') > 0, 'L26 quote reports a clash with own leave');
  r := public.hr_leave_my_balances(hlc.u(1), extract(year from lv)::int);
  perform hlc.expect(exists (select 1 from jsonb_array_elements(r->'types') t where t->>'leave_type_id' = hlc.x(401)::text
                             and jsonb_array_length(t->'ledger') > 0), 'L27 employee sees balance and ledger lines');
  perform hlc.expect(hw3.err(format('select public.hr_leave_ledger_for(%L, %L, null)', hlc.u(2), hlc.u(1))) like '%sa_authorization_required%',
                     'L28 a colleague cannot read another employee''s ledger');
  perform hlc.expect(hw3.err(format('select public.hr_leave_ledger_for(%L, %L, null)', hlc.u(5), hlc.u(1))) = 'OK',
                     'L29 the direct manager with MSS leave view can read it');
  r := public.hr_leave_balances_overview(hlc.u(7), hlc.o(1), extract(year from lv)::int);
  perform hlc.expect(jsonb_array_length(r->'employees') >= 5, 'L30 HR balance overview');
  -- probing someone else's balance through the check helper reveals nothing
  v := hlc.val_as(1, format($q$select public.hr_leave_w3_check('INSERT', (select r from public.hr_leave_requests r where employee_id = %L limit 1), null)::text$q$, hlc.u(2)));
  perform hlc.expect(v is null or v not like 'ERR:%insufficient%', 'L31 the check helper cannot be used to probe other people''s balances (' || coalesce(v, 'null') || ')');
  -- unpaid leave for payroll readiness
  perform set_config('session_replication_role', 'replica', true);   -- historical fixture row (no API path)
  insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, total_days, status, approved_by, approved_at)
  values (hlc.o(1), hlc.u(22), hlc.x(405), hw3.mon(), hw3.mon() + 6, 5, 'approved', hlc.u(7), now());
  perform set_config('session_replication_role', 'origin', true);
  r := public.hr_leave_unpaid_days(hlc.u(7), hlc.o(1), hw3.mon(), hw3.mon() + 6);
  perform hlc.expect(exists (select 1 from jsonb_array_elements(r) x where x->>'employee_id' = hlc.u(22)::text and (x->>'unpaid_days')::numeric = 4),
                     'L32 unpaid days count working days only (national holiday excluded; H2 has no state holiday → 4 of 5)');
end $t$;


---------------------------------------------------------------- B: B2A leave authority unchanged with Wave 3 installed
do $t$
declare v text; lv date := hw3.mon() + 175; q1 uuid := gen_random_uuid(); q2 uuid := gen_random_uuid();
begin
  v := hlc.run_as(1, format($q$insert into public.hr_leave_requests(id, organization_id, employee_id, leave_type_id, start_date, end_date, status)
                              values (%L, %L, %L, %L, %L, %L, 'pending')$q$, q1, hlc.o(1), hlc.u(1), hlc.x(406), lv, lv));
  perform hlc.expect(v = 'OK:1', 'BA1 employee submits own leave (' || v || ')');
  v := hlc.run_as(1, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status)
                              values (%L, %L, %L, %L, %L, 'pending')$q$, hlc.o(1), hlc.u(2), hlc.x(406), lv + 1, lv + 1));
  perform hlc.expect(v like '%hr_leave_on_behalf_refused%', 'BA2 on-behalf submission still refused (' || v || ')');
  v := hlc.run_as(1, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, q1));
  perform hlc.expect(v like '%hr_leave_self_approval%', 'BA3 self-approval still refused (' || v || ')');
  v := hlc.run_as(6, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, q1));
  perform hlc.expect(v = 'OK:0' or v like '%not_authorized%', 'BA4 a manager without MSS cannot decide (' || v || ')');
  v := hlc.run_as(5, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, q1));
  perform hlc.expect(v = 'OK:1' and exists (select 1 from public.hr_leave_ledger where request_ref = q1 and entry_type = 'taken'),
                     'BA5 the direct manager with MSS approves; the ledger records it (' || v || ')');
  v := hlc.run_as(1, format($q$update public.hr_leave_requests set status = 'cancelled' where id = %L$q$, q1));
  perform hlc.expect(v like '%hr_leave_invalid_transition%', 'BA6 an employee cannot cancel approved leave (' || v || ')');
  v := hlc.run_as(1, format($q$insert into public.hr_leave_requests(id, organization_id, employee_id, leave_type_id, start_date, end_date, status)
                              values (%L, %L, %L, %L, %L, %L, 'draft')$q$, q2, hlc.o(1), hlc.u(1), hlc.x(406), lv, lv));
  perform hlc.expect(v = 'OK:1', 'BA7 a draft may overlap (not a claim yet)');
  v := hlc.run_as(1, format($q$update public.hr_leave_requests set status = 'pending' where id = %L$q$, q2));
  perform hlc.expect(v like '%hr_leave_overlap%', 'BA8 submitting an overlapping draft is refused (' || v || ')');
  perform hlc.expect((select count(*) from public.hr_leave_request_events where request_id = q1) >= 2, 'BA9 B2A events still recorded');
end $t$;

select hlc.expect(true, 'W3 behaviour tests complete');
