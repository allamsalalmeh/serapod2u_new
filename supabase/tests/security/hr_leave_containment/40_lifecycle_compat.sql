-- B2A compatibility with HR Data Management reset/restore, controlled employee delete/reset (20261214100000),
-- permanent identity deletion (20261216100000) and Archive & Revoke Access (20261217100000/20261218100000).
-- Requires: 05_lifecycle_catalogue_seed.sql, the four lifecycle migrations, 10_fixtures.sql and B2A, in either order.
-- Committed (not rolled back): the operations are the real database functions, called the way the server calls them
-- (service_role → SECURITY DEFINER function, so the function owner performs the writes = B2A "maintenance" path).
do $setup$
begin
  if to_regprocedure('public.identity_deletion_execute(uuid,uuid,text,uuid,text,text,text)') is null
     or to_regprocedure('public.identity_archive_execute(uuid,uuid,text,uuid,text,text,text,boolean,text)') is null
     or to_regprocedure('public.hr_employee_registration_execute(uuid,uuid,uuid,text,uuid,text,text)') is null then
    raise exception 'lifecycle migrations 20261214…20261218 are not applied on this replica';
  end if;
  if to_regclass('public.hr_leave_request_events') is null then raise exception 'B2A not applied'; end if;
  -- The snapshot has no hr_reset_scope rows (data): register the leave tables exactly as 20261003100000 does.
  insert into public.hr_reset_scope(table_name, category, action, delete_order, label)
  select * from (values ('hr_leave_approvals','leave','delete',20,'Leave approval steps'), ('hr_leave_requests','leave','delete',21,'Leave requests'),
                        ('hr_leave_balances','leave','delete',22,'Leave balances'), ('hr_employees','employment_records','keep',null::int,'Employment records and employee numbers')) v(t, c, a, o, l)
  where not exists (select 1 from public.hr_reset_scope s where s.table_name = v.t);
  -- S1 (Super Admin) additionally holds the break-glass identity/HR record policies, scoped to HQ Alpha
  -- (fixture rows: loaded with triggers off, like 10_fixtures.sql).
  set local session_replication_role = replica;
  insert into public.sa_role_assignments(id, user_id, role_id, membership_id, status, source, assignment_reason)
  select hlc.x(650 + k), hlc.u(14), (select id from public.sa_business_roles where role_key = rk), hlc.x(214), 'active', 'manual', 'hlc compat'
  from (values (1, 'platform-data-maintenance-administrator'), (2, 'hr-employee-record-administrator')) t(k, rk)
  on conflict (id) do nothing;
  insert into public.sa_assignment_scopes(assignment_id, scope_id) select hlc.x(650 + k), hlc.x(301) from generate_series(1, 2) k on conflict do nothing;
  set local session_replication_role = origin;
  -- A person whose ONLY trace is an audit event (actor_ref) — the permanent-deletion candidate.
  if not exists (select 1 from public.users where id = hlc.u(30)) then
    set local session_replication_role = replica;
    insert into auth.users(id, email, aud, role) values (hlc.u(30), 'hlc-30@example.test', 'authenticated', 'authenticated');
    insert into public.users(id, email, full_name, role_code, organization_id, is_active, principal_type, account_status, account_scope)
    values (hlc.u(30), 'hlc-30@example.test', 'Former approver (events only)', 'USER', hlc.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal');
    set local session_replication_role = origin;
    insert into public.hr_leave_request_events(organization_id, request_id, actor_ref, actor_db_role, authority, action, from_status, to_status)
    values (hlc.o(1), hlc.x(3), hlc.u(30), 'authenticated', 'manager', 'status_change', 'pending', 'approved');
  end if;
end $setup$;

do $t$
declare p jsonb; r jsonb; v text; v_before text; v_after text; v_events bigint; v_run uuid;
begin
  ---------------------------------------------------------------- HR Data Management: full reset + restore
  p := public.hr_reset_preview(hlc.u(14), hlc.o(1), 'full');
  perform hlc.expect(jsonb_array_length(p->'blockers') = 0, 'R1 reset preview has no blockers with B2A in place ' || coalesce((p->'blockers')::text, ''));
  perform hlc.expect(not exists (select 1 from jsonb_array_elements(p->'delete') d where d->>'table' = 'hr_leave_request_events')
                     and exists (select 1 from jsonb_array_elements(p->'keep') k where k->>'table' = 'hr_leave_request_events'),
                     'R2 events table is kept (registered), never in the delete set');
  select md5(string_agg(md5(to_jsonb(t)::text), ',' order by t.id)) into v_before from public.hr_leave_requests t where t.organization_id = hlc.o(1);
  select count(*) into v_events from public.hr_leave_request_events;
  v := hlc.val_as(null, format($q$select public.hr_reset_execute(%L, %L, 'full', %L, %L, 'Clean HR test data before go-live', %L)->>'status'$q$,
                               hlc.u(14), hlc.o(1), hlc.x(970), p->>'preview_token', p->>'confirmation_phrase'), 'service_role');
  perform hlc.expect(v = 'completed', 'R3 full HR reset completes with B2A in place (' || coalesce(v, 'null') || ')');
  perform hlc.expect((select count(*) from public.hr_leave_requests where organization_id = hlc.o(1)) = 0, 'R4 reset removed the organization''s leave requests');
  perform hlc.expect((select count(*) from public.hr_leave_request_events) = v_events, 'R5 audit events are kept by the reset');
  select id into v_run from public.hr_reset_runs where request_id = hlc.x(970);
  v := hlc.val_as(null, format($q$select public.hr_reset_restore(%L, %L, 'Restore rehearsal on replica')->>'status'$q$, hlc.u(14), v_run), 'service_role');
  perform hlc.expect(v is not null and v not like 'ERR:%', 'R6 restore completes with B2A in place (' || coalesce(v, 'null') || ')');
  select md5(string_agg(md5(to_jsonb(t)::text), ',' order by t.id)) into v_after from public.hr_leave_requests t where t.organization_id = hlc.o(1);
  perform hlc.expect(v_after = v_before, 'R7 restored leave rows are byte-identical (incl. the historical self-approved row)');
  perform hlc.expect((select count(*) from public.hr_leave_request_events where authority = 'maintenance' and action = 'insert'
                      and request_id in (select id from public.hr_leave_requests where organization_id = hlc.o(1)))
                     = (select count(*) from public.hr_leave_requests where organization_id = hlc.o(1)), 'R8 every restored row is recorded as maintenance');
  v := hlc.run_as(2, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(2)));
  perform hlc.expect(v like '%hr_leave_self_approval%' and hlc.status(2) = 'pending', 'R9 self-approval still refused on a restored row (' || v || ')');
  v := hlc.run_as(2, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status)
                               values (%L, %L, %L, current_date, current_date, 'pending')$q$, hlc.o(1), hlc.u(1), hlc.x(401)));
  perform hlc.expect(v like '%hr_leave_on_behalf_refused%', 'R10 on-behalf submission still refused after restore (' || v || ')');

  ---------------------------------------------------------------- Controlled employee delete / reset (20261214100000)
  p := public.hr_employee_registration_preview(hlc.u(14), hlc.o(1), hlc.u(2));
  perform hlc.expect(p::text like '%hr_leave_requests%', 'C1 Delete Employee is still blocked by leave history (existing behaviour)');
  perform hlc.expect(p::text not like '%hr_leave_request_events%', 'C2 the B2A events table never appears as a blocker');
  r := public.hr_employee_registration_execute(hlc.u(14), hlc.o(1), hlc.u(2), 'reset', hlc.x(971), p->>'preview_token', 'Re-register before go-live');
  perform hlc.expect(r->>'status' = 'completed', 'C3 Reset HR Registration completes for an employee with leave history (' || coalesce(r->>'status', r::text) || ')');
  perform hlc.expect((select count(*) from public.hr_leave_requests where employee_id = hlc.u(2)) >= 4, 'C4 leave history kept after registration reset');

  ---------------------------------------------------------------- Permanent identity deletion (20261216100000)
  p := public.identity_deletion_plan(hlc.u(7));
  perform hlc.expect(p::text not like '%hr_leave_request_events%', 'I1 identity deletion plan of an HR approver never lists the events table');
  p := public.identity_deletion_preview(hlc.u(14), hlc.u(30), 'user_management');
  perform hlc.expect(jsonb_array_length(coalesce(p->'blockers', '[]'::jsonb)) = 0,
                     'I2 a person referenced only by leave audit events is deletable ' || coalesce((p->'blockers')::text, p::text));
  r := public.identity_deletion_execute(hlc.u(14), hlc.u(30), 'user_management', hlc.x(972), p->>'preview_token',
                                        'Remove duplicate test identity', p->>'confirmation_phrase');
  perform hlc.expect(r->>'status' in ('completed', 'auth_verification_pending'), 'I3 permanent deletion completes (' || coalesce(r->>'status', r::text) || ')');
  perform hlc.expect(not exists (select 1 from public.users where id = hlc.u(30)), 'I4 identity removed');
  perform hlc.expect(exists (select 1 from public.hr_leave_request_events where actor_ref = hlc.u(30)), 'I5 audit event retained with the bare id (like the other retained logs)');

  ---------------------------------------------------------------- Archive & Revoke Access (20261217100000 / 20261218100000)
  p := public.identity_archive_preview(hlc.u(14), hlc.u(13), 'user_management');
  perform hlc.expect(p::text not like '%hr_leave_request_events%', 'K1 archive preview never lists the events table');
  r := public.identity_archive_execute(hlc.u(14), hlc.u(13), 'user_management', hlc.x(973), p->>'preview_token', null,
                                       p->>'confirmation_phrase', false, 'resigned');
  perform hlc.expect(r->>'status' = 'completed', 'K2 Archive & Revoke Access completes for an employee with pending leave (' || coalesce(r->>'status', r::text) || ')');
  perform hlc.expect(hlc.status(8) = 'pending', 'K3 the archived employee''s leave history is untouched');
  v := hlc.run_as(13, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status)
                                values (%L, %L, %L, current_date, current_date, 'pending')$q$, hlc.o(1), hlc.u(13), hlc.x(401)));
  perform hlc.expect(v like 'ERR:%', 'K4 an archived account can no longer submit leave (' || v || ')');
end $t$;
