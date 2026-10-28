-- HR employment foundation (Wave 2) — compatibility with the identity / HR lifecycle functions (20261214…20261218),
-- run AFTER ../hr_leave_containment/40_lifecycle_compat.sql (which itself must still pass with Wave 2 installed).
-- Real database functions, called the way the server calls them (service_role → SECURITY DEFINER).
do $t$
declare p jsonb; r jsonb; v text; n bigint; ver record;
begin
  ---------------------------------------------------------------- D: permanent deletion of an unused identity
  p := public.identity_deletion_preview(hlc.u(14), hlc.u(40), 'user_management');
  perform hlc.expect(jsonb_array_length(coalesce(p->'blockers', '[]'::jsonb)) = 0,
                     'D1 employment history (baseline version) never blocks deletion of an unused identity ' || coalesce((p->'blockers')::text, p::text));
  perform hlc.expect(p::text not like '%hr_employee_versions%', 'D2 the history table is not listed in the deletion plan');
  select count(*) into n from public.hr_employee_versions where person_ref = hlc.u(40);
  perform hlc.expect(n >= 1, 'D3 the unused identity has a baseline version before deletion');
  r := public.identity_deletion_execute(hlc.u(14), hlc.u(40), 'user_management', hlc.x(980), p->>'preview_token',
                                        'Remove unused test identity', p->>'confirmation_phrase');
  perform hlc.expect(r->>'status' in ('completed', 'auth_verification_pending'), 'D4 permanent deletion completes (' || coalesce(r->>'status', r::text) || ')');
  perform hlc.expect(not exists (select 1 from public.hr_employee_versions where person_ref = hlc.u(40)),
                     'D5 the versions of the deleted (history-free) employment record are removed with it');

  ---------------------------------------------------------------- B: statutory profile blocks permanent deletion
  set local session_replication_role = replica;
  insert into auth.users(id, email, aud, role) values (hlc.u(41), 'hlc-41@example.test', 'authenticated', 'authenticated') on conflict do nothing;
  insert into public.users(id, email, full_name, role_code, organization_id, is_active, principal_type, account_status, account_scope)
  values (hlc.u(41), 'hlc-41@example.test', 'Statutory only', 'USER', hlc.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal') on conflict do nothing;
  set local session_replication_role = origin;
  insert into public.hr_employee_statutory_profiles(user_id, organization_id, nric_no) values (hlc.u(41), hlc.o(1), '850505105555');
  p := public.identity_deletion_preview(hlc.u(14), hlc.u(41), 'user_management');
  perform hlc.expect(exists (select 1 from jsonb_array_elements(p->'blockers') b where b->>'table' = 'hr_employee_statutory_profiles'),
                     'B1 HR statutory master data blocks permanent deletion like other HR records ' || coalesce((p->'blockers')::text, ''));

  ---------------------------------------------------------------- A: Archive & Revoke Access with Wave 2 in place
  -- P2 (u21) holds an active primary position; archive ends employment → end effects + version; employment then locked
  p := public.identity_archive_preview(hlc.u(14), hlc.u(21), 'user_management');
  r := public.identity_archive_execute(hlc.u(14), hlc.u(21), 'user_management', hlc.x(981), p->>'preview_token', null,
                                       p->>'confirmation_phrase', false, 'resigned');
  perform hlc.expect(r->>'status' = 'completed', 'A1 Archive & Revoke Access completes with the lifecycle guard installed (' || coalesce(r->>'status', r::text) || ')');
  select * into ver from public.hr_employee_versions where employment_ref = hlc.x(121) order by version_no desc limit 1;
  perform hlc.expect(ver.change_kind = 'end_of_employment' and ver.status = 'resigned' and ver.end_date = current_date,
                     'A2 the archive is recorded as end_of_employment in history');
  perform hlc.expect((select status from public.hr_position_assignments where id = hlc.x(921)) = 'ended',
                     'A3 the archived employee no longer occupies the position slot');
  begin
    update public.users set department_id = null, employment_type = 'Contract' where id = hlc.u(21);
    perform hlc.expect(false, 'A4 edit after archive must fail');
  exception when others then
    perform hlc.expect(sqlerrm = 'hr_employment_archived_locked', 'A4 after archive the employment facts are locked (' || sqlerrm || ')');
  end;
  perform hlc.expect(exists (select 1 from public.hr_reporting_line_review(hlc.o(1)) x where x.manager_user_id = hlc.u(21)) is false,
                     'A5 the archived person has no direct reports listed (none existed)');

  ---------------------------------------------------------------- O: fresh HR onboarding validates the chosen manager
  set local session_replication_role = replica;
  insert into auth.users(id, email, aud, role) values (hlc.u(42), 'hlc-42@example.test', 'authenticated', 'authenticated') on conflict do nothing;
  insert into public.users(id, email, full_name, role_code, organization_id, is_active, principal_type, account_status, account_scope)
  values (hlc.u(42), 'hlc-42@example.test', 'New hire', 'USER', hlc.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal') on conflict do nothing;
  insert into public.hr_employees(id, employee_no, user_id, organization_id, hire_date, status, onboarding_status)
  values (hlc.x(142), 910042, hlc.u(42), hlc.o(1), current_date, 'active', 'pending') on conflict do nothing;
  set local session_replication_role = origin;
  begin
    r := public.hr_onboarding_complete(hlc.u(9), hlc.u(42), jsonb_build_object('organization_id', hlc.o(1), 'manager_user_id', hlc.u(12),
                                       'hire_date', current_date, 'employment_type', 'Full-time'));
    perform hlc.expect(false, 'O1 onboarding with an archived manager must fail (' || r::text || ')');
  exception when others then
    perform hlc.expect(sqlerrm = 'hr_manager_inactive', 'O1 HR onboarding cannot assign a former (archived) manager (' || sqlerrm || ')');
  end;
  r := public.hr_onboarding_complete(hlc.u(9), hlc.u(42), jsonb_build_object('organization_id', hlc.o(1), 'manager_user_id', hlc.u(5),
                                     'hire_date', current_date, 'employment_type', 'Full-time'));
  perform hlc.expect(r->>'status' = 'ok' and (select onboarding_status from public.hr_employees where user_id = hlc.u(42)) = 'completed',
                     'O2 HR onboarding with an active manager completes (' || r::text || ')');
  perform hlc.expect((select change_kind from public.hr_employee_versions where employment_ref = hlc.x(142) order by version_no desc limit 1) = 'onboarding',
                     'O3 onboarding is recorded in the employment history');

  ---------------------------------------------------------------- H: HR reset preview / registration reset still work
  p := public.hr_reset_preview(hlc.u(14), hlc.o(1), 'full');
  perform hlc.expect(jsonb_array_length(p->'blockers') = 0, 'H1 HR reset preview has no blockers with Wave 2 installed ' || coalesce((p->'blockers')::text, ''));
  perform hlc.expect(exists (select 1 from jsonb_array_elements(p->'keep') k where k->>'table' = 'hr_employee_versions')
                     and not exists (select 1 from jsonb_array_elements(p->'delete') d where d->>'table' like 'hr\_%version%'),
                     'H2 history is in the reset KEEP set, never deleted by a reset');
  select count(*) into n from public.hr_employee_versions;
  v := hlc.val_as(null, format($q$select public.hr_reset_execute(%L, %L, 'full', %L, %L, 'Wave 2 reset rehearsal', %L)->>'status'$q$,
                               hlc.u(14), hlc.o(1), hlc.x(982), p->>'preview_token', p->>'confirmation_phrase'), 'service_role');
  perform hlc.expect(v = 'completed', 'H3 full HR reset completes (' || coalesce(v, 'null') || ')');
  perform hlc.expect((select count(*) from public.hr_employee_versions) >= n, 'H4 no history row was removed by the reset');
  v := hlc.val_as(null, format($q$select public.hr_reset_restore(%L, (select id from public.hr_reset_runs where request_id = %L), 'Restore rehearsal')->>'status'$q$,
                               hlc.u(14), hlc.x(982)), 'service_role');
  perform hlc.expect(v is not null and v not like 'ERR:%', 'H5 restore completes with the lifecycle guard installed (' || coalesce(v, 'null') || ')');
end $t$;
select hlc.expect(true, 'W2 lifecycle compatibility complete');
