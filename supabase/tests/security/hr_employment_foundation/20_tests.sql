-- HR employment foundation (Wave 2, 20261221100000) — behaviour tests. DISPOSABLE replica only.
-- Requires: B2A + this migration applied, base fixtures (hlc) + 15_w2_fixtures.sql, migration re-applied once (baseline).
-- Each block commits; tests are ordered (later blocks rely on earlier state).

do $t$
declare n bigint; v text; r jsonb;
begin
  ---------------------------------------------------------------- V: history baseline & append-only
  perform hlc.expect(not exists (select 1 from public.hr_employees e
                                 where not exists (select 1 from public.hr_employee_versions v where v.employment_ref = e.id)),
                     'V1 every employment record has at least one version (baseline)');
  perform hlc.expect((select count(*) from public.hr_employee_versions where change_kind = 'baseline' and version_no = 1)
                     = (select count(*) from public.hr_employees), 'V2 exactly one baseline per employment record after re-apply (idempotent)');
  v := hlc.run_as(7, 'select count(*) from public.hr_employee_versions');
  perform hlc.expect(v like 'ERR:%permission denied%', 'V3 API users cannot read the history table directly (' || v || ')');
  v := hlc.run_as(null, format('update public.hr_employee_versions set reason = %L where employment_ref = %L', 'x', hlc.x(101)), 'service_role');
  perform hlc.expect(v like 'ERR:%', 'V4 even service_role cannot rewrite history (' || v || ')');
  begin
    delete from public.hr_employee_versions where employment_ref = hlc.x(101);
    perform hlc.expect(false, 'V5 owner delete of history must fail');
  exception when others then
    perform hlc.expect(sqlerrm like '%hr_history_append_only%', 'V5 history is append-only even for the table owner (' || sqlerrm || ')');
  end;
  v := hlc.run_as(7, 'select count(*) from public.hr_employee_statutory_profiles');
  perform hlc.expect(v like 'ERR:%permission denied%', 'V6 statutory profiles have no API privileges (' || v || ')');
  v := hlc.run_as(7, 'select count(*) from public.hr_employment_finance_contract_v1');
  perform hlc.expect(v like 'ERR:%permission denied%', 'V7 finance contract view is service_role only (' || v || ')');
  v := hlc.run_as(7, format('select public.hr_manager_assignment_error(%L, %L, %L)', hlc.u(1), hlc.o(1), hlc.u(12)));
  perform hlc.expect(v like 'ERR:%permission denied%', 'V8 API users cannot probe manager eligibility directly (' || v || ')');
end $t$;

do $t$
declare v text; before_n int; e record;
begin
  ---------------------------------------------------------------- L: lifecycle guard
  -- transfer through the identity projection (users → hr_employees) creates a version with kind 'transfer'
  select count(*) into before_n from public.hr_employee_versions where employment_ref = hlc.x(101);
  update public.users set position_id = hlc.x(901) where id = hlc.u(1);
  perform hlc.expect((select count(*) from public.hr_employee_versions where employment_ref = hlc.x(101)) = before_n + 1
                     and (select change_kind from public.hr_employee_versions where employment_ref = hlc.x(101) order by version_no desc limit 1) = 'transfer',
                     'L1 a position change through user management is recorded as a transfer version');
  update public.users set position_id = null where id = hlc.u(1);

  -- archived former employee (M3, u12): employment facts locked
  begin
    update public.hr_employees set department_id = null, employment_type = 'Contract' where user_id = hlc.u(12);
    perform hlc.expect(false, 'L2 archived employee edit must fail');
  exception when others then
    perform hlc.expect(sqlerrm = 'hr_employment_archived_locked', 'L2 a former (archived) employee''s employment facts are locked (' || sqlerrm || ')');
  end;
  begin
    update public.hr_employees set status = 'active' where user_id = hlc.u(12);
    perform hlc.expect(false, 'L3 archived rehire must fail');
  exception when others then
    perform hlc.expect(sqlerrm = 'hr_employment_archived_locked', 'L3 an archived identity cannot be re-employed without reactivation (' || sqlerrm || ')');
  end;
  begin
    update public.users set employment_status = 'active' where id = hlc.u(12);
    perform hlc.expect((select status from public.hr_employees where user_id = hlc.u(12)) = 'terminated',
                       'L3b the user-management path cannot re-employ an archived person (employment stays ended)');
  exception when others then
    perform hlc.expect(sqlerrm = 'hr_employment_archived_locked', 'L3b the user-management path cannot bypass the lifecycle rule (' || sqlerrm || ')');
  end;

  -- new manager validation
  begin
    update public.hr_employees set manager_user_id = hlc.u(12) where user_id = hlc.u(1);
    perform hlc.expect(false, 'L4 archived manager must fail');
  exception when others then
    perform hlc.expect(sqlerrm = 'hr_manager_inactive', 'L4 an archived/former person cannot become a manager (' || sqlerrm || ')');
  end;
  begin
    update public.hr_employees set manager_user_id = hlc.u(10) where user_id = hlc.u(1);
    perform hlc.expect(false, 'L5 cross-company manager must fail');
  exception when others then
    perform hlc.expect(sqlerrm = 'hr_manager_outside_company', 'L5 a manager from another company is refused (' || sqlerrm || ')');
  end;
  -- E1 → M1 → H1: making H1 report to E1 closes a cycle
  begin
    update public.hr_employees set manager_user_id = hlc.u(1) where user_id = hlc.u(7);
    perform hlc.expect(false, 'L6 cycle must fail');
  exception when others then
    perform hlc.expect(sqlerrm = 'hr_manager_cycle', 'L6 a reporting cycle is refused (' || sqlerrm || ')');
  end;
  begin
    update public.hr_employees set manager_user_id = hlc.u(1) where user_id = hlc.u(1);
    perform hlc.expect(false, 'L7 self manager must fail');
  exception when others then
    perform hlc.expect(sqlerrm = 'hr_manager_self', 'L7 self-reporting is refused (' || sqlerrm || ')');
  end;
  -- manager in a child organization of the same company is allowed (E5 in o2 reports to M1 in o1 already; move E5 to M2)
  update public.hr_employees set manager_user_id = hlc.u(6) where user_id = hlc.u(3);
  perform hlc.expect((select manager_user_id from public.hr_employees where user_id = hlc.u(3)) = hlc.u(6),
                     'L8 a manager in the same company (HQ group, other organization) is accepted');
  update public.hr_employees set manager_user_id = hlc.u(5) where user_id = hlc.u(3);
  -- existing invalid line (E4 → archived M3) does not block an unrelated edit
  update public.hr_employees set probation_end = date '2026-12-31' where user_id = hlc.u(13);
  perform hlc.expect((select probation_end from public.hr_employees where user_id = hlc.u(13)) = date '2026-12-31',
                     'L9 an existing (invalid) reporting line is reported, not blocking unrelated edits');
  -- end date rules
  begin
    update public.hr_employees set end_date = date '2025-12-31' where user_id = hlc.u(1);
    perform hlc.expect(false, 'L10 end before hire must fail');
  exception when others then
    perform hlc.expect(sqlerrm = 'hr_employment_end_before_hire', 'L10 end date before hire date is refused (' || sqlerrm || ')');
  end;
end $t$;

do $t$
declare r record; n int;
begin
  ---------------------------------------------------------------- R: reporting-line review
  perform hlc.expect(exists (select 1 from public.hr_reporting_line_review(hlc.o(1)) x
                             where x.employee_user_id = hlc.u(13) and x.issue_code = 'MANAGER_INACTIVE'),
                     'R1 review lists the employee reporting to an archived manager');
  select * into r from public.hr_reporting_line_review(hlc.o(1)) x where x.employee_user_id = hlc.u(21);
  perform hlc.expect(r.issue_code = 'POSITION_DIVERGENCE' and r.expected_manager_user_id = hlc.u(20),
                     'R2 review derives the expected manager from the position hierarchy (' || coalesce(r.issue_code, 'none') || ')');
  perform hlc.expect(not exists (select 1 from public.hr_reporting_line_review(hlc.o(1)) x where x.employee_user_id = hlc.u(12)),
                     'R3 former employees are not listed');
  perform hlc.expect(not exists (select 1 from public.hr_reporting_line_review(hlc.o(1)) x where x.employee_user_id = hlc.u(10)),
                     'R4 review is scoped to the organization (no other-company rows)');
  select count(*) into n from public.hr_reporting_line_review(hlc.o(1)) x where x.employee_user_id = hlc.u(16);
  perform hlc.expect(n = 0, 'R5 employees whose onboarding is not completed are not reviewed');
end $t$;

do $t$
declare v text; r jsonb;
begin
  ---------------------------------------------------------------- S: controlled reporting-line changes and leave authority
  -- before: M1 cannot decide E4's leave (E4 reports to archived M3), M3 cannot either
  perform hlc.expect(hlc.val_as(5, format('select public.hr_leave_can_decide(%L, %L)::text', hlc.o(1), hlc.u(13))) = 'false',
                     'S1 before the change M1 cannot decide E4''s leave');
  v := hlc.val_as(null, format($q$select public.hr_set_reporting_line(%L, %L, %L, 'Archived manager replaced')::text$q$, hlc.u(8), hlc.u(13), hlc.u(5)), 'service_role');
  perform hlc.expect(v like 'ERR:%sa_authorization_required%', 'S2 a legacy-compatibility-only holder cannot change reporting lines (' || v || ')');
  v := hlc.val_as(null, format($q$select public.hr_set_reporting_line(%L, %L, %L, 'Archived manager replaced')::text$q$, hlc.u(11), hlc.u(13), hlc.u(5)), 'service_role');
  perform hlc.expect(v like 'ERR:%sa_authorization_required%', 'S3 HR of another company cannot change this company''s reporting lines (' || v || ')');
  v := hlc.val_as(null, format($q$select public.hr_set_reporting_line(%L, %L, %L, 'x')::text$q$, hlc.u(7), hlc.u(13), hlc.u(5)), 'service_role');
  perform hlc.expect(v like 'ERR:%hr_reason_required%', 'S4 a reason is mandatory (' || v || ')');
  v := hlc.val_as(null, format($q$select public.hr_set_reporting_line(%L, %L, %L, 'Archived manager replaced')->>'status'$q$, hlc.u(7), hlc.u(13), hlc.u(5)), 'service_role');
  perform hlc.expect(v = 'changed', 'S5 explicit HR re-points E4 to M1 (' || coalesce(v, 'null') || ')');
  perform hlc.expect(exists (select 1 from public.hr_reporting_line_changes where employee_ref = hlc.u(13) and to_manager_ref = hlc.u(5)
                             and from_manager_ref = hlc.u(12) and actor_ref = hlc.u(7) and source = 'set'),
                     'S6 the change is logged (from/to/actor/source)');
  perform hlc.expect((select reason from public.hr_employee_versions where employment_ref = hlc.x(113) order by version_no desc limit 1)
                     = 'Archived manager replaced'
                     and (select change_kind from public.hr_employee_versions where employment_ref = hlc.x(113) order by version_no desc limit 1) = 'reporting_change',
                     'S7 the version carries the reason and kind reporting_change');
  perform hlc.expect(hlc.val_as(5, format('select public.hr_leave_can_decide(%L, %L)::text', hlc.o(1), hlc.u(13))) = 'true',
                     'S8 after the change the new direct manager (MSS) can decide E4''s leave');
  perform hlc.expect(hlc.val_as(12, format('select public.hr_leave_can_decide(%L, %L)::text', hlc.o(1), hlc.u(13))) = 'false',
                     'S9 the former manager has no authority');
  v := hlc.val_as(null, format($q$select public.hr_set_reporting_line(%L, %L, %L, 'HR moves own line')::text$q$, hlc.u(7), hlc.u(7), hlc.u(6)), 'service_role');
  perform hlc.expect(v like 'ERR:%hr_self_change_prohibited%', 'S10 HR cannot change their own reporting line (' || v || ')');
  v := hlc.val_as(null, format($q$select public.hr_set_reporting_line(%L, %L, %L, 'Point to archived')::text$q$, hlc.u(7), hlc.u(1), hlc.u(12)), 'service_role');
  perform hlc.expect(v like 'ERR:%hr_manager_inactive%', 'S11 the controlled path still refuses an archived manager (' || v || ')');
  -- reassignment of direct reports (subset), then nothing to do
  v := hlc.val_as(null, format($q$select (public.hr_reassign_direct_reports(%L, %L, %L, 'M1 on long leave', array[%L]::uuid[]))::text$q$,
                               hlc.u(9), hlc.u(5), hlc.u(6), hlc.u(1)), 'service_role');
  perform hlc.expect(v::jsonb->>'count' = '1' and (select manager_user_id from public.hr_employees where user_id = hlc.u(1)) = hlc.u(6),
                     'S12 Root reassigns a selected direct report (' || v || ')');
  perform hlc.expect(hlc.val_as(6, format('select public.hr_leave_can_decide(%L, %L)::text', hlc.o(1), hlc.u(1))) = 'false',
                     'S13 the new manager without Manager Self-Service still cannot decide leave (B2A MSS rule intact)');
  perform hlc.expect(hlc.val_as(5, format('select public.hr_leave_can_decide(%L, %L)::text', hlc.o(1), hlc.u(1))) = 'false',
                     'S14 the previous manager lost authority over the reassigned employee');
  v := hlc.val_as(null, format($q$select (public.hr_reassign_direct_reports(%L, %L, %L, 'M1 back', array[%L]::uuid[]))->>'status'$q$,
                               hlc.u(9), hlc.u(6), hlc.u(5), hlc.u(1)), 'service_role');
  perform hlc.expect(v = 'reassigned', 'S15 reassignment back');
  v := hlc.val_as(null, format($q$select (public.hr_reassign_direct_reports(%L, %L, %L, 'Nobody to move'))->>'status'$q$,
                               hlc.u(9), hlc.u(14), hlc.u(5)), 'service_role');
  perform hlc.expect(v = 'nothing_to_do', 'S16 nothing to reassign is reported, not an error');
  v := hlc.run_as(7, format($q$select public.hr_set_reporting_line(%L, %L, %L, 'Direct API call')$q$, hlc.u(7), hlc.u(1), hlc.u(6)));
  perform hlc.expect(v like 'ERR:%permission denied%', 'S17 the functions are not callable by API users directly (' || v || ')');
end $t$;

do $t$
declare v text; r jsonb;
begin
  ---------------------------------------------------------------- E: controlled effective-dated employment change
  v := hlc.val_as(null, format($q$select public.hr_employment_change(%L, %L, '{"department_id": null, "employment_type": "Contract"}', date '2026-10-01', 'Converted to contract')::text$q$,
                               hlc.u(7), hlc.u(3)), 'service_role');
  r := v::jsonb;
  perform hlc.expect(r->>'status' = 'changed' and r->>'change_kind' = 'employment_terms', 'E1 HR changes terms of an employee in a child organization (' || v || ')');
  perform hlc.expect((select effective_date from public.hr_employee_versions where employment_ref = hlc.x(103) order by version_no desc limit 1) = date '2026-10-01',
                     'E2 the version is effective on the business date given, not the recording date');
  perform hlc.expect((select v.status from public.hr_employee_as_of(hlc.x(103), date '2026-09-30') v) is not null
                     and (select v.employment_type from public.hr_employee_as_of(hlc.x(103), date '2026-10-02') v) = 'Contract',
                     'E3 as-of lookup returns the terms in force on a date');
  v := hlc.val_as(null, format($q$select public.hr_employment_change(%L, %L, '{"employment_type": "Part-time"}', current_date + 7, 'Future change')::text$q$, hlc.u(7), hlc.u(3)), 'service_role');
  perform hlc.expect(v like 'ERR:%hr_effective_date_invalid%', 'E4 a future-dated change is refused (no silent early apply) (' || v || ')');
  v := hlc.val_as(null, format($q$select public.hr_employment_change(%L, %L, '{"status": "resigned"}', current_date, 'Resigning employee')::text$q$, hlc.u(7), hlc.u(3)), 'service_role');
  perform hlc.expect(v like 'ERR:%hr_status_change_not_allowed%', 'E5 ending employment is not a field change (' || v || ')');
  v := hlc.val_as(null, format($q$select public.hr_employment_change(%L, %L, '{"hire_date": "2020-01-01"}', current_date, 'Backdate hire')::text$q$, hlc.u(7), hlc.u(3)), 'service_role');
  perform hlc.expect(v like 'ERR:%hr_change_field_not_allowed%', 'E6 only allowed fields can be changed (' || v || ')');
  v := hlc.val_as(null, format($q$select public.hr_employment_change(%L, %L, '{"employment_type": "Part-time"}', current_date, 'Own record')::text$q$, hlc.u(7), hlc.u(7)), 'service_role');
  perform hlc.expect(v like 'ERR:%hr_self_change_prohibited%', 'E7 HR cannot change their own employment record (' || v || ')');
  v := hlc.val_as(null, format($q$select public.hr_employment_change(%L, %L, '{"employment_type": "Part-time"}', current_date, 'Not onboarded')::text$q$, hlc.u(7), hlc.u(16)), 'service_role');
  perform hlc.expect(v like 'ERR:%hr_onboarding_pending%', 'E8 an employee whose onboarding is not completed cannot be changed here (' || v || ')');
  v := hlc.val_as(null, format($q$select public.hr_employment_change(%L, %L, jsonb_build_object('position_id', %L), current_date, 'Cross-company position')::text$q$,
                               hlc.u(9), hlc.u(10), hlc.x(900)), 'service_role');
  perform hlc.expect(v like 'ERR:%hr_reference_outside_company%', 'E9 a position of another company is refused (' || v || ')');
  v := hlc.val_as(null, format($q$select public.hr_employment_change(%L, %L, '{"employment_type": "Part-time"}', current_date, 'Legacy admin')::text$q$, hlc.u(8), hlc.u(3)), 'service_role');
  perform hlc.expect(v like 'ERR:%sa_authorization_required%', 'E10 legacy-only access never authorizes an employment change (' || v || ')');
end $t$;

do $t$
declare v text; c record; a record; d record; p record; ver record;
begin
  ---------------------------------------------------------------- X: end of employment, end effects, rehire
  -- E2 resigns via user management (the projection path the HR screen uses)
  perform set_config('hr.change_reason', 'Resigned (notice served)', false);
  update public.users set employment_status = 'resigned' where id = hlc.u(2);
  perform set_config('hr.change_reason', '', false);
  select * into ver from public.hr_employee_versions where employment_ref = hlc.x(102) order by version_no desc limit 1;
  perform hlc.expect(ver.change_kind = 'end_of_employment' and ver.end_date = current_date and ver.status = 'resigned',
                     'X1 ending employment stamps the end date and records an end_of_employment version');
  select * into c from public.hr_employee_compensation where id = hlc.x(940);
  perform hlc.expect(c.end_date = current_date and c.status = 'active', 'X2 the active salary ends at the end date (row kept, history intact)');
  select * into a from public.hr_employee_allowances where id = hlc.x(950);
  select * into d from public.hr_employee_deductions where id = hlc.x(951);
  perform hlc.expect(a.end_date = current_date and d.end_date = current_date, 'X3 recurring allowance and deduction end at the end date');
  select * into p from public.hr_position_assignments where id = hlc.x(922);
  perform hlc.expect(p.effective_to = current_date and p.status = 'ended', 'X4 the primary position assignment ends (slot freed)');
  perform hlc.expect(exists (select 1 from public.hr_compensation_change_log where compensation_ref = hlc.x(940) and 'end_date' = any(changed_columns)
                             and reason in ('Employment ended', 'Resigned (notice served)')),
                     'X5 the compensation change is logged with the reason');
  -- leaver's pending leave is untouched; the B2A guard is unaffected
  perform hlc.expect(hlc.status(2) = 'pending', 'X6 the leaver''s pending leave request is kept unchanged');
  -- rehire (identity not archived): end date cleared, version rehire
  update public.hr_employees set status = 'active' where user_id = hlc.u(2);
  select * into ver from public.hr_employee_versions where employment_ref = hlc.x(102) order by version_no desc limit 1;
  perform hlc.expect(ver.change_kind = 'rehire' and ver.end_date is null
                     and (select end_date from public.hr_employees where user_id = hlc.u(2)) is null,
                     'X7 rehiring a non-archived former employee clears the end date and records a rehire version');
  perform hlc.expect((select count(*) from public.hr_employee_versions where employment_ref = hlc.x(102) and change_kind = 'end_of_employment') = 1,
                     'X8 the previous end of employment stays in history');
end $t$;

do $t$
declare v text;
begin
  ---------------------------------------------------------------- C: compensation integrity
  begin
    insert into public.hr_employee_compensation(organization_id, employee_id, pay_type, basic_salary, effective_date, status)
    values (hlc.o(1), hlc.u(1), 'monthly', 4100, date '2026-06-01', 'active');
    perform hlc.expect(false, 'C1 overlap must fail');
  exception when others then
    perform hlc.expect(sqlerrm = 'hr_compensation_overlap', 'C1 a second active salary overlapping the current one is refused (' || sqlerrm || ')');
  end;
  -- supersede pattern used by the compensation route: old row superseded + ended, new row active
  update public.hr_employee_compensation set status = 'superseded', end_date = date '2026-06-01' where id = hlc.x(941);
  insert into public.hr_employee_compensation(organization_id, employee_id, pay_type, basic_salary, effective_date, status)
  values (hlc.o(1), hlc.u(1), 'monthly', 4100, date '2026-06-01', 'active');
  perform hlc.expect((select count(*) from public.hr_employee_compensation where employee_id = hlc.u(1) and status = 'active') = 1,
                     'C2 the supersede-then-insert revision pattern still works');
  begin
    insert into public.hr_employee_compensation(organization_id, employee_id, pay_type, basic_salary, effective_date, end_date, status)
    values (hlc.o(1), hlc.u(5), 'monthly', 5000, date '2026-06-01', date '2026-05-01', 'active');
    perform hlc.expect(false, 'C3 end before start must fail');
  exception when others then
    perform hlc.expect(sqlerrm like '%hr_emp_comp_dates_chk%', 'C3 a salary ending before it starts is refused (' || sqlerrm || ')');
  end;
  perform hlc.expect((select count(*) from public.hr_compensation_change_log where employee_ref = hlc.u(1)) >= 2
                     and exists (select 1 from public.hr_compensation_change_log where employee_ref = hlc.u(1) and action = 'insert'
                                 and (new_values->>'basic_salary')::numeric = 4100),
                     'C4 every compensation change is logged (old/new values, sealed table)');
  v := hlc.run_as(7, 'select count(*) from public.hr_compensation_change_log');
  perform hlc.expect(v like 'ERR:%permission denied%', 'C5 the compensation log is not readable through the API (' || v || ')');
end $t$;

do $t$
declare v text;
begin
  ---------------------------------------------------------------- P: statutory profile capture
  v := hlc.run_as(null, format($q$insert into public.hr_employee_statutory_profiles(user_id, organization_id, id_type, nric_no, date_of_birth,
        citizenship_status, tax_residency, marital_status, children_count, epf_no, socso_no, income_tax_no, work_state, updated_by_ref)
        values (%L, %L, 'nric', '900101145678', date '1990-01-01', 'citizen', 'resident', 'married', 2, '12345678', 'A1234567', 'SG1234567890', 'SGR', %L)$q$,
        hlc.u(1), hlc.o(1), hlc.u(7)), 'service_role');
  perform hlc.expect(v = 'OK:1', 'P1 the server (service_role) records a statutory profile (' || v || ')');
  v := hlc.run_as(null, format($q$update public.hr_employee_statutory_profiles set nric_no = '9001011456' where user_id = %L$q$, hlc.u(1)), 'service_role');
  perform hlc.expect(v like 'ERR:%check%', 'P2 an invalid NRIC format is refused (' || v || ')');
  v := hlc.run_as(null, format($q$update public.hr_employee_statutory_profiles set work_state = 'XYZ' where user_id = %L$q$, hlc.u(1)), 'service_role');
  perform hlc.expect(v like 'ERR:%check%', 'P3 an unknown work state is refused (' || v || ')');
  v := hlc.run_as(null, format($q$update public.hr_employee_statutory_profiles set marital_status = 'single', children_count = 0 where user_id = %L$q$, hlc.u(1)), 'service_role');
  perform hlc.expect(v = 'OK:1', 'P4 a valid update is accepted');
  perform hlc.expect((select count(*) from public.hr_statutory_profile_changes where person_ref = hlc.u(1)) = 2
                     and exists (select 1 from public.hr_statutory_profile_changes where person_ref = hlc.u(1) and action = 'update'
                                 and changed_columns = array['children_count','marital_status']),
                     'P5 changes are logged by column NAME only');
  perform hlc.expect(not exists (select 1 from public.hr_statutory_profile_changes c, jsonb_each_text(to_jsonb(c)) kv
                                 where c.person_ref = hlc.u(1) and kv.value like '%900101145678%'),
                     'P6 statutory values are never copied into the log');
  v := hlc.run_as(1, format('select nric_no from public.hr_employee_statutory_profiles where user_id = %L', hlc.u(1)));
  perform hlc.expect(v like 'ERR:%permission denied%', 'P7 not even the employee reads the table directly (server route only) (' || v || ')');
  perform hlc.expect((select statutory_profile_complete from public.hr_employment_finance_contract_v1 where person_id = hlc.u(1)) is true
                     and (select statutory_profile_complete from public.hr_employment_finance_contract_v1 where person_id = hlc.u(5)) is false,
                     'P8 the finance contract exposes statutory completeness, not values');
  perform hlc.expect(not exists (select 1 from information_schema.columns where table_name = 'hr_employment_finance_contract_v1'
                                 and column_name in ('basic_salary','hourly_rate','nric_no','passport_no','epf_no','socso_no','income_tax_no')),
                     'P9 the finance contract carries no salary amount and no statutory number');
end $t$;

do $t$
begin
  ---------------------------------------------------------------- K: payroll component readiness & reset classification
  begin
    update public.hr_allowance_types set payroll_component_code = 'bad code' where id = hlc.x(930);
    perform hlc.expect(false, 'K1 invalid component code must fail');
  exception when others then
    perform hlc.expect(sqlerrm like '%component_code_chk%', 'K1 component codes are format-checked');
  end;
  update public.hr_allowance_types set payroll_component_code = 'ALW_TRANSPORT' where id = hlc.x(930);
  perform hlc.expect((select payroll_component_code from public.hr_allowance_types where id = hlc.x(930)) = 'ALW_TRANSPORT',
                     'K2 a component code can be recorded (no posting, no FK until P-F03)');
  perform hlc.expect((select count(*) from public.hr_reset_scope where action = 'keep' and table_name in
                      ('hr_employee_versions','hr_reporting_line_changes','hr_compensation_change_log','hr_employee_statutory_profiles','hr_statutory_profile_changes',
                       'hr_employee_profiles')) = 6,
                     'K3 all new tables are classified as KEPT by HR Data Management reset');
end $t$;

do $t$
declare v text; j jsonb;
begin
  ---------------------------------------------------------------- G: server entry points (history, statutory, review)
  v := hlc.val_as(null, format('select public.hr_employee_history(%L, %L)::text', hlc.u(2), hlc.u(2)), 'service_role');
  j := v::jsonb;
  perform hlc.expect(jsonb_array_length(j) >= 3 and j->0->>'change_kind' is not null and j->0->>'actor_name' is null,
                     'G1 an employee reads their own employment history (no actor names exposed to self)');
  v := hlc.val_as(null, format('select jsonb_array_length(public.hr_employee_history(%L, %L))::text', hlc.u(7), hlc.u(2)), 'service_role');
  perform hlc.expect(v ~ '^\d+$', 'G2 explicit HR reads an employee''s history (' || v || ')');
  v := hlc.val_as(null, format('select public.hr_employee_history(%L, %L)::text', hlc.u(1), hlc.u(2)), 'service_role');
  perform hlc.expect(v like 'ERR:%sa_authorization_required%', 'G3 a colleague cannot read someone else''s history (' || left(v, 60) || ')');
  v := hlc.val_as(null, format('select public.hr_employee_history(%L, %L)::text', hlc.u(8), hlc.u(2)), 'service_role');
  perform hlc.expect(v like 'ERR:%sa_authorization_required%', 'G4 legacy-only access cannot read history (' || left(v, 60) || ')');
  v := hlc.val_as(null, format('select public.hr_employee_history(%L, %L)::text', hlc.u(11), hlc.u(2)), 'service_role');
  perform hlc.expect(v like 'ERR:%sa_authorization_required%', 'G5 HR of another company cannot read history (' || left(v, 60) || ')');

  v := hlc.val_as(null, format($q$select public.hr_statutory_profile_save(%L, %L, '{"nric_no": "880808085555", "citizenship_status": "citizen", "work_state": "PNG"}', 'Onboarding documents')::text$q$, hlc.u(7), hlc.u(5)), 'service_role');
  perform hlc.expect(v::jsonb->>'status' = 'created', 'G6 explicit HR records a statutory profile (' || v || ')');
  v := hlc.val_as(null, format($q$select public.hr_statutory_profile_save(%L, %L, '{"marital_status": "married"}', 'Marriage certificate')::text$q$, hlc.u(7), hlc.u(5)), 'service_role');
  perform hlc.expect(v::jsonb->>'status' = 'updated'
                     and (select nric_no from public.hr_employee_statutory_profiles where user_id = hlc.u(5)) = '880808085555'
                     and (select marital_status from public.hr_employee_statutory_profiles where user_id = hlc.u(5)) = 'married',
                     'G7 a partial update keeps the other fields');
  v := hlc.val_as(null, format($q$select public.hr_statutory_profile_save(%L, %L, '{"salary": 1}', 'Bad field')::text$q$, hlc.u(7), hlc.u(5)), 'service_role');
  perform hlc.expect(v like 'ERR:%hr_change_field_not_allowed%', 'G8 unknown fields are refused (' || v || ')');
  v := hlc.val_as(null, format($q$select public.hr_statutory_profile_save(%L, %L, '{"marital_status": "single"}', 'Own record edit')::text$q$, hlc.u(7), hlc.u(7)), 'service_role');
  perform hlc.expect(v like 'ERR:%hr_self_change_prohibited%', 'G9 HR cannot edit their own statutory record (' || v || ')');
  v := hlc.val_as(null, format($q$select public.hr_statutory_profile_save(%L, %L, '{"marital_status": "single"}', 'Legacy edit')::text$q$, hlc.u(8), hlc.u(5)), 'service_role');
  perform hlc.expect(v like 'ERR:%sa_authorization_required%', 'G10 legacy-only access cannot edit statutory data (' || v || ')');
  v := hlc.val_as(null, format('select public.hr_statutory_profile_get(%L, %L)::text', hlc.u(5), hlc.u(5)), 'service_role');
  perform hlc.expect(v::jsonb->'profile'->>'nric_no' = '880808085555' and v::jsonb->>'can_edit' = 'false',
                     'G11 the employee reads their own statutory data (read only)');
  v := hlc.val_as(null, format('select public.hr_statutory_profile_get(%L, %L)::text', hlc.u(6), hlc.u(5)), 'service_role');
  perform hlc.expect(v like 'ERR:%sa_authorization_required%', 'G12 a colleague/manager cannot read statutory data (' || left(v, 60) || ')');
  perform hlc.expect(not (hlc.val_as(null, format('select public.hr_statutory_profile_get(%L, %L)::text', hlc.u(7), hlc.u(5)), 'service_role')::jsonb->'profile' ? 'updated_by_ref'),
                     'G13 the server payload carries no internal actor reference');

  v := hlc.val_as(null, format('select jsonb_array_length(public.hr_reporting_line_review_for(%L, %L))::text', hlc.u(7), hlc.o(1)), 'service_role');
  perform hlc.expect(v ~ '^\d+$', 'G14 explicit HR runs the reporting-line review (' || v || ')');
  v := hlc.val_as(null, format('select public.hr_reporting_line_review_for(%L, %L)::text', hlc.u(11), hlc.o(1)), 'service_role');
  perform hlc.expect(v like 'ERR:%sa_authorization_required%', 'G15 HR of another company cannot review this company (' || left(v, 60) || ')');
  v := hlc.val_as(null, format('select public.hr_reporting_line_review_for(%L, %L)::text', hlc.u(5), hlc.o(1)), 'service_role');
  perform hlc.expect(v like 'ERR:%sa_authorization_required%', 'G16 a manager (MSS) cannot run the HR review (' || left(v, 60) || ')');
end $t$;

do $t$
declare v text; j jsonb;
begin
  ---------------------------------------------------------------- F: HR Profile sheet (personal + statutory, one source)
  v := hlc.val_as(null, format($q$select public.hr_employee_profile_save(%L, %L, '{"emergency_name": "Spouse", "emergency_phone": "0123456789", "bank_account_no": "123456789012"}', null, null)::text$q$, hlc.u(1), hlc.u(1)), 'service_role');
  perform hlc.expect(v::jsonb->>'status' = 'saved', 'F1 an employee saves own contact/emergency/bank details (' || v || ')');
  v := hlc.val_as(null, format($q$select public.hr_employee_profile_save(%L, %L, '{"notes": "self note"}', null, null)::text$q$, hlc.u(1), hlc.u(1)), 'service_role');
  perform hlc.expect(v like 'ERR:%hr_change_field_not_allowed%', 'F2 an employee cannot edit HR-only personal fields (' || v || ')');
  v := hlc.val_as(null, format($q$select public.hr_employee_profile_save(%L, %L, null, '{"nric_no": "900101145678"}', null)::text$q$, hlc.u(2), hlc.u(2)), 'service_role');
  perform hlc.expect(v like 'ERR:%hr_statutory_self_edit_refused%', 'F3 an employee cannot change own statutory details (' || v || ')');
  v := hlc.val_as(null, format($q$select public.hr_employee_profile_save(%L, %L, '{"highest_education": "degree", "blood_type": "O+"}', '{"nric_no": "910202145679", "gender": "female", "nationality": "Malaysian"}', 'Onboarding form')::text$q$, hlc.u(7), hlc.u(2)), 'service_role');
  perform hlc.expect(v::jsonb->>'status' = 'saved' and v::jsonb->'statutory'->>'status' in ('created','updated'),
                     'F4 explicit HR saves personal and statutory sections in one call (' || v || ')');
  j := hlc.val_as(null, format('select public.hr_employee_profile_get(%L, %L)::text', hlc.u(2), hlc.u(2)), 'service_role')::jsonb;
  perform hlc.expect(j->'statutory'->>'nric_no' = '910202145679' and j->'profile'->>'highest_education' = 'degree'
                     and (j->>'can_edit_statutory')::boolean = false and (j->>'can_edit_personal')::boolean = true,
                     'F5 the employee reads one merged profile and may edit only the self-service fields');
  v := hlc.val_as(null, format('select public.hr_employee_profile_get(%L, %L)::text', hlc.u(6), hlc.u(2)), 'service_role');
  perform hlc.expect(v like 'ERR:%sa_authorization_required%', 'F6 a manager without HR authority cannot read the profile (' || left(v, 60) || ')');
  v := hlc.val_as(null, format('select public.hr_employee_profile_get(%L, %L)::text', hlc.u(8), hlc.u(2)), 'service_role');
  perform hlc.expect(v like 'ERR:%sa_authorization_required%', 'F7 legacy-only access cannot read the profile (' || left(v, 60) || ')');
  v := hlc.val_as(null, format($q$select public.hr_employee_profile_save(%L, %L, '{"notes": "x"}', null, 'Former employee note')::text$q$, hlc.u(7), hlc.u(12)), 'service_role');
  perform hlc.expect(v like 'ERR:%hr_employment_archived_locked%', 'F8 a former employee''s profile is read-only (' || v || ')');
  v := hlc.val_as(null, format($q$select public.hr_employee_profile_save(%L, %L, '{"bank_account_no": "12-34"}', null, null)::text$q$, hlc.u(1), hlc.u(1)), 'service_role');
  perform hlc.expect(v like 'ERR:%check%', 'F9 a malformed bank account number is refused (' || v || ')');
  perform hlc.expect(exists (select 1 from public.hr_statutory_profile_changes where person_ref = hlc.u(1) and 'profile.bank_account_no' = any(changed_columns))
                     and not exists (select 1 from public.hr_statutory_profile_changes c, jsonb_each_text(to_jsonb(c)) kv
                                     where c.person_ref = hlc.u(1) and kv.value like '%123456789012%'),
                     'F10 profile changes are logged by field name only (no bank number in the log)');
end $t$;

select hlc.expect(true, 'W2 behaviour tests complete');
