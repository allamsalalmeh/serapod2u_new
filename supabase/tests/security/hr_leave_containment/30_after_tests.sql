-- AFTER 20261219100000_hr_leave_containment_guard. One transaction, rolled back at the end so later files start
-- from the fixtures + migration. Probes are the same shapes as 20_before_tests.sql.
begin;
do $t$
declare r text; n int; v text;
begin
  perform hlc.expect(to_regclass('public.hr_leave_request_events') is not null, 'migration present (events table exists)');

  ------------------------------------------------------------------ submission
  r := hlc.run_as(1, format($q$insert into public.hr_leave_requests(id, organization_id, employee_id, leave_type_id, start_date, end_date, status)
                               values (%L, %L, %L, %L, date '2026-12-01', date '2026-12-01', 'pending')$q$, hlc.x(950), hlc.o(1), hlc.u(1), hlc.x(401)));
  perform hlc.expect(r = 'OK:1', 'S1 employee submits own leave (' || r || ')');
  r := hlc.run_as(1, format($q$insert into public.hr_leave_requests(id, organization_id, employee_id, leave_type_id, start_date, end_date)
                               values (%L, %L, %L, %L, date '2026-12-02', date '2026-12-02')$q$, hlc.x(951), hlc.o(1), hlc.u(1), hlc.x(401)));
  perform hlc.expect(r = 'OK:1' and hlc.status(951) = 'draft', 'S2 employee saves a draft (' || r || ')');
  r := hlc.run_as(1, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status)
                               values (%L, %L, %L, current_date, current_date, 'pending')$q$, hlc.o(1), hlc.u(2), hlc.x(401)));
  perform hlc.expect(r like '%hr_leave_on_behalf_refused%', 'S3 on-behalf submission by an employee refused (' || r || ')');
  r := hlc.run_as(7, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status)
                               values (%L, %L, %L, current_date, current_date, 'pending')$q$, hlc.o(1), hlc.u(2), hlc.x(401)));
  perform hlc.expect(r like '%hr_leave_on_behalf_refused%', 'S4 on-behalf submission by explicit HR refused in B2A (' || r || ')');
  r := hlc.run_as(1, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status)
                               values (%L, %L, %L, current_date, current_date, 'approved')$q$, hlc.o(1), hlc.u(1), hlc.x(401)));
  perform hlc.expect(r like '%hr_leave_invalid_transition%', 'S5 insert directly as approved refused (' || r || ')');
  r := hlc.run_as(1, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status, approved_by)
                               values (%L, %L, %L, current_date, current_date, 'pending', %L)$q$, hlc.o(1), hlc.u(1), hlc.x(401), hlc.u(5)));
  perform hlc.expect(r like '%hr_leave_invalid_transition%', 'S6 insert with a pre-filled approver refused (' || r || ')');
  r := hlc.run_as(10, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status)
                               values (%L, %L, %L, current_date, current_date, 'pending')$q$, hlc.o(1), hlc.u(10), hlc.x(401)));
  perform hlc.expect(r like 'ERR:%', 'S7 insert into another organization refused (' || r || ')');
  r := hlc.run_as(16, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status)
                               values (%L, %L, %L, current_date, current_date, 'pending')$q$, hlc.o(1), hlc.u(16), hlc.x(401)));
  perform hlc.expect(r like '%hr_onboarding_pending%', 'S8 not-onboarded employee still refused by the existing onboarding guard (' || r || ')');
  r := hlc.run_as(null, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status)
                                  values (%L, %L, %L, current_date, current_date, 'pending')$q$, hlc.o(1), hlc.u(1), hlc.x(401)), 'anon');
  perform hlc.expect(r like 'ERR:%', 'S9 anonymous insert refused (' || r || ')');

  ------------------------------------------------------------------ self-approval
  r := hlc.run_as(1, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(1)));
  perform hlc.expect(r like '%hr_leave_self_approval%' and hlc.status(1) = 'pending', 'A1 employee self-approval refused (' || r || ')');
  r := hlc.run_as(7, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(7)));
  perform hlc.expect(r like '%hr_leave_self_approval%' and hlc.status(7) = 'pending', 'A2 explicit HR approving own leave refused (' || r || ')');
  r := hlc.run_as(5, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(9)));
  perform hlc.expect(r like '%hr_leave_self_approval%' and hlc.status(9) = 'pending', 'A3 manager approving own leave refused (' || r || ')');
  r := hlc.run_as(9, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(9)));
  perform hlc.expect(r = 'OK:1' and hlc.status(9) = 'approved', 'A3b Root approves someone else''s leave (' || r || ')');

  ------------------------------------------------------------------ manager authority
  r := hlc.run_as(5, format($q$update public.hr_leave_requests set status = 'approved', approved_by = %L, approved_at = now() - interval '9 days', approval_comment = 'ok' where id = %L$q$, hlc.u(7), hlc.x(1)));
  perform hlc.expect(r = 'OK:1' and hlc.status(1) = 'approved', 'M1 direct manager with Manager Self-Service approves a direct report (' || r || ')');
  perform hlc.expect((select approved_by = hlc.u(5) and approved_at > now() - interval '1 minute' from public.hr_leave_requests where id = hlc.x(1)),
                     'M2 approver and time are stamped by the database (client values ignored)');
  r := hlc.run_as(6, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(2)));
  perform hlc.expect(r = 'OK:0' and hlc.status(2) = 'pending', 'M3 direct manager WITHOUT Manager Self-Service cannot approve (' || r || ')');
  r := hlc.run_as(5, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(2)));
  perform hlc.expect(r = 'OK:0' and hlc.status(2) = 'pending', 'M4 manager cannot approve someone who is not a direct report (' || r || ')');
  r := hlc.run_as(12, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(8)));
  perform hlc.expect(r = 'OK:0' and hlc.status(8) = 'pending', 'M5 archived manager cannot approve (' || r || ')');
  r := hlc.run_as(15, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(11)));
  perform hlc.expect(r = 'OK:0' and hlc.status(11) = 'pending', 'M6 delegated Manager Self-Service does not confer leave approval (delegation deferred) (' || r || ')');
  r := hlc.run_as(5, format($q$update public.hr_leave_requests set status = 'rejected', approval_comment = 'clash' where id = %L$q$, hlc.x(5)));
  perform hlc.expect(r = 'OK:1' and hlc.status(5) = 'rejected', 'M7 manager decides a direct report in a child organization of the same HQ (' || r || ')');

  ------------------------------------------------------------------ HR authority and legacy exclusion
  r := hlc.run_as(8, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(2)));
  perform hlc.expect(r = 'OK:0' and hlc.status(2) = 'pending', 'H1 legacy-compatibility-only holder cannot approve (' || r || ')');
  r := hlc.run_as(11, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(2)));
  perform hlc.expect(r = 'OK:0' and hlc.status(2) = 'pending', 'H2 explicit HR of another company cannot approve (' || r || ')');
  r := hlc.run_as(7, format($q$update public.hr_leave_requests set status = 'approved', reason = 'tampered' where id = %L$q$, hlc.x(2)));
  perform hlc.expect(r like '%hr_leave_invalid_transition%' and hlc.status(2) = 'pending', 'H3 approver cannot change request content in the same statement (' || r || ')');
  r := hlc.run_as(7, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(2)));
  perform hlc.expect(r = 'OK:1' and hlc.status(2) = 'approved', 'H4 explicit HR approves (' || r || ')');
  r := hlc.run_as(11, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(6)));
  perform hlc.expect(r = 'OK:1' and hlc.status(6) = 'approved', 'H5 explicit HR approves inside its own company (' || r || ')');

  ------------------------------------------------------------------ transitions after a decision
  r := hlc.run_as(1, format($q$update public.hr_leave_requests set reason = 'edited later' where id = %L$q$, hlc.x(3)));
  perform hlc.expect(r like '%hr_leave_invalid_transition%', 'T1 employee cannot edit a decided request (' || r || ')');
  r := hlc.run_as(1, format($q$update public.hr_leave_requests set status = 'cancelled' where id = %L$q$, hlc.x(3)));
  perform hlc.expect(r like '%hr_leave_invalid_transition%' and hlc.status(3) = 'approved', 'T2 employee cannot cancel approved leave (' || r || ')');
  r := hlc.run_as(5, format($q$update public.hr_leave_requests set status = 'cancelled' where id = %L$q$, hlc.x(3)));
  perform hlc.expect(r like '%hr_leave_not_authorized%' and hlc.status(3) = 'approved', 'T3 manager cannot cancel approved leave (' || r || ')');
  r := hlc.run_as(7, format($q$update public.hr_leave_requests set status = 'cancelled', approval_comment = 'Cancelled at employee request' where id = %L$q$, hlc.x(3)));
  perform hlc.expect(r = 'OK:1' and hlc.status(3) = 'cancelled'
                     and (select cancelled_at is not null and approved_by = hlc.u(5) from public.hr_leave_requests where id = hlc.x(3)),
                     'T4 explicit HR cancels approved leave; original approver preserved (' || r || ')');
  r := hlc.run_as(7, format($q$update public.hr_leave_requests set status = 'pending' where id = %L$q$, hlc.x(5)));
  perform hlc.expect(r like '%hr_leave_invalid_transition%' and hlc.status(5) = 'rejected', 'T5 rejected is terminal (' || r || ')');
  r := hlc.run_as(1, format($q$update public.hr_leave_requests set status = 'cancelled', cancelled_at = now() where id = %L$q$, hlc.x(11)));
  perform hlc.expect(r = 'OK:1' and hlc.status(11) = 'cancelled', 'T6 employee cancels own pending leave (repository shape with cancelled_at) (' || r || ')');
  r := hlc.run_as(1, format($q$update public.hr_leave_requests set reason = 'updated reason', end_date = date '2026-12-02', total_days = 2 where id = %L$q$, hlc.x(950)));
  perform hlc.expect(r = 'OK:1', 'T7 employee edits own pending content (' || r || ')');
  r := hlc.run_as(1, format($q$update public.hr_leave_requests set employee_id = %L where id = %L$q$, hlc.u(2), hlc.x(950)));
  perform hlc.expect(r like '%hr_leave_immutable_field%', 'T8 employee cannot re-assign a request to someone else (' || r || ')');
  r := hlc.run_as(1, format($q$update public.hr_leave_requests set status = 'pending' where id = %L$q$, hlc.x(951)));
  perform hlc.expect(r = 'OK:1' and hlc.status(951) = 'pending', 'T9 employee submits own draft (' || r || ')');
  r := hlc.run_as(5, format($q$update public.hr_leave_requests set reason = 'manager edit' where id = %L$q$, hlc.x(950)));
  perform hlc.expect(r like '%hr_leave_invalid_transition%', 'T10 approver cannot edit pending content (' || r || ')');
  r := hlc.run_as(null, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(950)), 'service_role');
  perform hlc.expect(r like '%hr_leave_not_authorized%' and hlc.status(950) = 'pending', 'T11 service role has NO bypass for user-facing transitions (' || r || ')');

  ------------------------------------------------------------------ delete
  r := hlc.run_as(1, format('delete from public.hr_leave_requests where id = %L', hlc.x(950)));
  perform hlc.expect(r = 'OK:0', 'D1 employee cannot delete leave (' || r || ')');
  r := hlc.run_as(7, format('delete from public.hr_leave_requests where id = %L', hlc.x(950)));
  perform hlc.expect(r = 'OK:0', 'D2 HR cannot delete leave through the API (' || r || ')');

  ------------------------------------------------------------------ confidentiality (requests, balances, approvals)
  v := hlc.val_as(1, 'select string_agg(distinct employee_id::text, '','') from public.hr_leave_requests');
  perform hlc.expect(v = hlc.u(1)::text, 'V1 employee sees only own requests');
  perform hlc.expect(hlc.val_as(1, 'select count(*) from public.hr_leave_balances')::int = 1, 'V2 employee sees only own balance');
  v := hlc.val_as(5, 'select string_agg(distinct employee_id::text, '','' order by employee_id::text) from public.hr_leave_requests');
  perform hlc.expect(v = (select string_agg(x::text, ',' order by x::text) from unnest(array[hlc.u(1), hlc.u(3), hlc.u(5)]) x),
                     'V3 manager sees self and direct reports only (incl. child-org report) [' || coalesce(v, '') || ']');
  perform hlc.expect(hlc.val_as(6, 'select count(*) from public.hr_leave_requests')::int = 0, 'V4 manager without Manager Self-Service sees no team leave');
  perform hlc.expect(hlc.val_as(8, 'select count(*) from public.hr_leave_requests')::int = 0, 'V5 legacy-compatibility-only holder sees no leave (has none of own)');
  perform hlc.expect(hlc.val_as(8, 'select count(*) from public.hr_leave_balances')::int = 0, 'V6 legacy-compatibility-only holder sees no balances');
  perform hlc.expect(hlc.val_as(7, format('select count(*) from public.hr_leave_requests where organization_id in (%L, %L)', hlc.o(1), hlc.o(2)))::int
                     = (select count(*) from public.hr_leave_requests where organization_id in (hlc.o(1), hlc.o(2))), 'V7 explicit HR sees its company (HQ and child)');
  perform hlc.expect(hlc.val_as(7, format('select count(*) from public.hr_leave_requests where organization_id = %L', hlc.o(3)))::int = 0, 'V8 explicit HR does not see another company');
  perform hlc.expect(hlc.val_as(11, format('select count(*) from public.hr_leave_requests where organization_id = %L', hlc.o(1)))::int = 0, 'V9 other-company HR sees nothing of HQ Alpha');
  perform hlc.expect(hlc.val_as(15, format('select count(*) from public.hr_leave_requests where employee_id = %L', hlc.u(1)))::int = 0, 'V10 delegate does not gain team visibility');
  perform hlc.expect(hlc.val_as(1, 'select count(*) from public.hr_leave_approvals')::int = 1, 'V11 employee sees approval steps of own requests only');
  perform hlc.expect(hlc.val_as(2, 'select count(*) from public.hr_leave_approvals')::int = 0, 'V12 other employee sees no approval steps');

  ------------------------------------------------------------------ approval steps and balances writes
  r := hlc.run_as(5, format($q$insert into public.hr_leave_approvals(organization_id, request_id, approver_id, action, actioned_at) values (%L, %L, %L, 'approved', now())$q$, hlc.o(1), hlc.x(1), hlc.u(5)));
  perform hlc.expect(r = 'OK:1', 'W1 deciding manager records an approval step (' || r || ')');
  r := hlc.run_as(1, format($q$insert into public.hr_leave_approvals(organization_id, request_id, approver_id, action, actioned_at) values (%L, %L, %L, 'approved', now())$q$, hlc.o(1), hlc.x(950), hlc.u(1)));
  perform hlc.expect(r like 'ERR:%', 'W2 employee cannot record an approval step for own request (' || r || ')');
  r := hlc.run_as(8, format($q$insert into public.hr_leave_approvals(organization_id, request_id, approver_id, action, actioned_at) values (%L, %L, %L, 'approved', now())$q$, hlc.o(1), hlc.x(950), hlc.u(8)));
  perform hlc.expect(r like 'ERR:%', 'W3 legacy-only holder cannot record an approval step (' || r || ')');
  r := hlc.run_as(5, format($q$insert into public.hr_leave_approvals(organization_id, request_id, approver_id, action, actioned_at) values (%L, %L, %L, 'approved', now())$q$, hlc.o(1), hlc.x(1), hlc.u(7)));
  perform hlc.expect(r like 'ERR:%', 'W4 cannot record an approval step in someone else''s name (' || r || ')');
  r := hlc.run_as(5, format($q$update public.hr_leave_approvals set comment = 'x' where id = %L$q$, hlc.x(800)));
  perform hlc.expect(r = 'OK:0', 'W5 approval steps cannot be edited through the API (' || r || ')');
  r := hlc.run_as(7, format($q$update public.hr_leave_balances set entitled = 99 where employee_id = %L$q$, hlc.u(1)));
  perform hlc.expect(r = 'OK:0', 'W6 balances cannot be written through the API (' || r || ')');
  r := hlc.run_as(1, format($q$insert into public.hr_leave_balances(organization_id, employee_id, leave_type_id, year, entitled) values (%L, %L, %L, 2027, 99)$q$, hlc.o(1), hlc.u(1), hlc.x(401)));
  perform hlc.expect(r like 'ERR:%', 'W7 employee cannot create balances (' || r || ')');

  ------------------------------------------------------------------ audit events
  perform hlc.expect((select count(*) from public.hr_leave_request_events where request_id = hlc.x(1) and to_status = 'approved' and authority = 'manager' and actor_ref = hlc.u(5)) = 1,
                     'E1 manager approval recorded with authority manager');
  perform hlc.expect((select count(*) from public.hr_leave_request_events where request_id = hlc.x(2) and authority = 'hr') = 1, 'E2 HR approval recorded with authority hr');
  perform hlc.expect((select count(*) from public.hr_leave_request_events where request_id = hlc.x(950) and action = 'insert' and authority = 'self') = 1, 'E3 submission recorded with authority self');
  perform hlc.expect((select count(*) from public.hr_leave_request_events where request_id = hlc.x(3) and from_status = 'approved' and to_status = 'cancelled' and authority = 'hr') = 1,
                     'E4 approved-leave cancellation recorded');
  perform hlc.expect((select count(*) from public.hr_leave_request_events where request_id = hlc.x(9) and authority = 'root') = 1, 'E5 Root decision recorded with authority root');
  perform hlc.expect(not exists (select 1 from information_schema.columns where table_name = 'hr_leave_request_events' and column_name in ('reason', 'start_date', 'end_date', 'attachment_url')),
                     'E6 events carry no reason text, dates or attachments');
  perform hlc.expect((select count(*) from public.hr_leave_request_events where request_id = hlc.x(2)) = 1,
                     'E7 the five refused/filtered attempts on R2 left no event; only the HR approval is recorded');
  r := hlc.run_as(1, 'select count(*) from public.hr_leave_request_events');
  perform hlc.expect(r like 'ERR:%permission denied%', 'E8 events are not readable through the API (' || r || ')');
  r := hlc.run_as(7, format($q$insert into public.hr_leave_request_events(organization_id, request_id, action, authority) values (%L, %L, 'insert', 'hr')$q$, hlc.o(1), hlc.x(1)));
  perform hlc.expect(r like 'ERR:%permission denied%', 'E9 events cannot be forged through the API (' || r || ')');
  begin
    update public.hr_leave_request_events set authority = 'x' where request_id = hlc.x(1);
    perform hlc.expect(false, 'E10 events update must fail');
  exception when others then perform hlc.expect(sqlerrm like '%append_only%', 'E10 events are append-only even for the owner (' || sqlerrm || ')'); end;
  begin
    delete from public.hr_leave_request_events where request_id = hlc.x(1);
    perform hlc.expect(false, 'E11 events delete must fail');
  exception when others then perform hlc.expect(sqlerrm like '%append_only%', 'E11 events cannot be deleted (' || sqlerrm || ')'); end;
  perform hlc.expect(not exists (select 1 from pg_constraint where conrelid = 'public.hr_leave_request_events'::regclass and contype = 'f'),
                     'E12 events table has no foreign keys (cannot block reset, restore or identity deletion)');
  perform hlc.expect(not exists (select 1 from pg_attribute a where a.attrelid = 'public.hr_leave_request_events'::regclass and a.attnum > 0
                                 and a.atttypid = 'uuid'::regtype
                                 and (a.attname ~ '(user_id|_by|actor_id|employee_id|employment_id|_user)$' or a.attname in ('consumer_id', 'owner_id'))),
                     'E13 no events column matches the person-column patterns scanned by identity deletion / employee delete');

  ------------------------------------------------------------------ historical records
  perform hlc.expect((select status = 'approved' and approved_by = hlc.u(2) from public.hr_leave_requests where id = hlc.x(4)),
                     'H6 historical self-approved row is left unchanged');
  perform hlc.expect((select status from public.hr_leave_requests where id = hlc.x(10)) = 'Approved', 'H7 legacy status value left unchanged');
  r := hlc.run_as(2, format($q$update public.hr_leave_requests set reason = 'edit legacy row' where id = %L$q$, hlc.x(10)));
  perform hlc.expect(r like '%hr_leave_invalid_transition%', 'H7b rows with a legacy status are frozen for the API (' || r || ')');
  r := hlc.run_as(7, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(10)));
  perform hlc.expect(r like '%hr_leave_invalid_transition%', 'H7c a legacy status cannot be "decided" through the API (' || r || ')');
  v := hlc.val_as(7, format('select string_agg(finding || '':'' || request_id::text, '','' order by request_id::text) from public.hr_leave_containment_review(%L)', hlc.o(1)));
  perform hlc.expect(v like '%self_approved:' || hlc.x(4)::text || '%' and v like '%approved_without_approver:' || hlc.x(12)::text || '%'
                     and v like '%unknown_status:' || hlc.x(10)::text || '%', 'H8 explicit HR receives the suspicious-row report [' || coalesce(v, '') || ']');
  v := hlc.val_as(1, format('select count(*) from public.hr_leave_containment_review(%L)', hlc.o(1)));
  perform hlc.expect(v like 'ERR:%hr_leave_not_authorized%', 'H9 employees cannot read the suspicious-row report (' || v || ')');
  r := hlc.run_as(1, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status)
                               values (%L, %L, %L, current_date, current_date, 'weird')$q$, hlc.o(1), hlc.u(1), hlc.x(401)));
  perform hlc.expect(r like '%hr_leave_invalid_transition%', 'H10 API writes must use a known status (' || r || ')');
  perform hlc.expect(not exists (select 1 from pg_constraint where conrelid = 'public.hr_leave_requests'::regclass and conname = 'hr_leave_requests_status_chk'),
                     'H11 no status CHECK constraint (it would block restore of historical rows)');

  ------------------------------------------------------------------ maintenance path (HR reset/restore, identity functions)
  set local hr.reset_restore = '';
  insert into public.hr_leave_requests(id, organization_id, employee_id, leave_type_id, start_date, end_date, status, approved_by, approved_at)
  values (hlc.x(960), hlc.o(1), hlc.u(1), hlc.x(401), date '2026-07-01', date '2026-07-01', 'approved', hlc.u(5), now() - interval '100 days');
  perform hlc.expect((select count(*) from public.hr_leave_request_events where request_id = hlc.x(960) and authority = 'maintenance') = 1,
                     'P1 database-owned code (owner role) can re-insert a historical approved row; recorded as maintenance');
end $t$;
rollback;
