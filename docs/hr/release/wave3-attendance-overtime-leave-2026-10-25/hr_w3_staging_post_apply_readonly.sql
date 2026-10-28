-- ============================================================================
-- Serapod2U HR — Wave 3 post-apply verification (READ-ONLY, owner-run, STAGING)
-- Targets: supabase/migrations/20261222100000_hr_hybrid_attendance_overtime.sql
--          supabase/migrations/20261223100000_hr_leave_ledger.sql
-- Run AFTER the owner applied both files (separately authorized), from kvm2_hr_w2_w3_readonly.sh or:
--   PGOPTIONS='-c default_transaction_read_only=on' psql "<staging>" -X -v env=staging -v ON_ERROR_STOP=0 \
--        -f hr_w3_staging_post_apply_readonly.sql > w3_post_apply.txt 2>&1
-- Before application every section reports "not applied" (that is expected). Aggregates only. Ends with ROLLBACK.
-- ============================================================================
\set QUIET on
\set ON_ERROR_ROLLBACK on
\pset footer off
\if :{?env}
\else
  \echo 'ABORT: pass -v env=staging'
  \quit
\endif
begin transaction read only;
set local statement_timeout = '120s';
set local lock_timeout = '3s';

\echo '=== 0. ENVIRONMENT ==='
select :'env' as declared_env, current_database() as db, now() as checked_at, current_setting('transaction_read_only') as read_only, current_user as role;
select to_regprocedure('public.hr_attendance_clock(uuid,text,uuid,text,timestamptz,text)') is not null as w3a_applied,
       to_regclass('public.hr_leave_ledger') is not null as w3b_applied;

\echo '=== 1. FUNCTION BODIES = REPOSITORY (expected: every row present = t, body_matches_repo = t, definer as listed) ==='
select e.fn, p.oid is not null as present, (md5(p.prosrc) = e.expected_md5 or (e.fn = 'hr_att_day_type(uuid,uuid,date)' and md5(p.prosrc) = '6c4a938ebc09be6273f19c9dc9d582c5')) as body_matches_repo,
       p.prosecdef as security_definer, e.expect_definer,
       coalesce(has_function_privilege('authenticated', p.oid, 'execute'), false) as authenticated_exec,
       coalesce(has_function_privilege('service_role', p.oid, 'execute'), false) as service_role_exec
from (values
  ('hr_att_assert_actor(uuid)', 'bd6884228abf924de822ccee5209647d', true),
  ('hr_att_audit(uuid,uuid,text,uuid,text,jsonb)', 'ea60615ba1cdbfc63a856aa788869deb', true),
  ('hr_att_can_view(uuid,uuid,uuid)', 'e2dafd8f8988ea50f91a5918d1915a10', true),
  ('hr_att_day_type(uuid,uuid,date)', 'bf6a942972a4575294781e086f42a24c', true),
  ('hr_att_decider(uuid,uuid,uuid,text)', '66b7b44f43c72f26fb2a6b2669fdb744', true),
  ('hr_att_detect_day(uuid,uuid,date)', '2122bb7ec9e15d4b026a73bec7d44dc4', true),
  ('hr_att_employment(uuid)', 'e05d695a77413ac18185ed84c6c25c84', true),
  ('hr_att_flag(uuid,uuid,date,timestamp with time zone,timestamp with time zone)', 'd3b0846a9c67bb35e3861a297549bcc4', true),
  ('hr_att_hr_authority(uuid,uuid)', 'e4db0524d12ccb4099374c69becb791f', true),
  ('hr_att_import_validate_row(uuid,jsonb)', 'fced309bfddc6a45c47e9d7d68a496b8', true),
  ('hr_att_local_date(uuid,timestamp with time zone)', 'dcc2739784301c63fc68671173902e59', true),
  ('hr_att_local_ts(uuid,date,time without time zone)', 'aafd466c1f39f6c437bd033102137a02', true),
  ('hr_att_manager_authority(uuid,uuid,uuid,text)', 'b4dff3848f0a4fc66cdb5a043fe0b665', true),
  ('hr_att_minutes(timestamp with time zone,timestamp with time zone,integer)', '2de5106b96b9b1a0b7493b0e5a9de258', false),
  ('hr_att_on_leave(uuid,date)', '733855b40d6ca1c32d469e2501345dc8', true),
  ('hr_att_overlaps(uuid,timestamp with time zone,timestamp with time zone,uuid)', '2172a58bab32e7a8d65b4ee37ab74a92', true),
  ('hr_att_refresh_timesheet(uuid,uuid,date)', 'ef872e297273fe02f53402f1db307e62', true),
  ('hr_att_tz(uuid)', 'ddabc57621f4803fae03e3de305521c8', true),
  ('hr_attendance_api_guard()', '3bc1c0ab48fd60a4c8b1485a1bc0ef67', false),
  ('hr_attendance_cancel_correction(uuid,uuid)', '96d39bfc3758f467c4644b473462fcd3', true),
  ('hr_attendance_clock(uuid,text,uuid,text,timestamp with time zone,text)', '6bfe07bff6524232915c6d5cc81f4c59', true),
  ('hr_attendance_day_board(uuid,uuid,date)', '23fa9c0d1096fe253b18fbec91c7b8b2', true),
  ('hr_attendance_decide_correction(uuid,uuid,text,text)', '6f0895d0702800f20bf7109301ddfa86', true),
  ('hr_attendance_import_batch_get(uuid,uuid)', 'bb45fc01411556a16d01bf857e8c1a44', true),
  ('hr_attendance_import_batches_list(uuid,uuid)', '2f75e2996b935d66ae83607ac3c122c0', true),
  ('hr_attendance_import_cancel(uuid,uuid)', '0c67d6112d54f69a78c0fcb9fb22d337', true),
  ('hr_attendance_import_commit(uuid,uuid,integer)', '317727d1c510523ca57d3416e8ca77d2', true),
  ('hr_attendance_import_preview(uuid,uuid,text,text,jsonb)', 'd52d590c67aac8144005929bea7c8dc9', true),
  ('hr_attendance_manual_entry(uuid,uuid,date,time without time zone,time without time zone,integer,uuid,text)', 'acc52a4e34ec25304a7c9d1158d73aab', true),
  ('hr_attendance_my_overview(uuid,date,date)', '00ed33ffe1fa896172ce0c5c4888daeb', true),
  ('hr_attendance_period_report(uuid,uuid,date,date)', 'e73aa236b0fa6488d9098bea0a376729', true),
  ('hr_attendance_request_correction(uuid,uuid,date,time without time zone,time without time zone,integer,text,uuid)', '2c2b0db5cb51ec72f51f485d6dcd8b8d', true),
  ('hr_attendance_resolve_exception(uuid,uuid,text,text)', '3e8aedceb3a9f07c64330816096739ab', true),
  ('hr_attendance_review_queue(uuid,uuid,text,text,date,date)', 'feff7ab4ca47e965ffdb32166e7058b8', true),
  ('hr_attendance_run_detection(uuid,uuid,date,date)', 'a97ea7f56e32f8cda45ce2adf4748626', true),
  ('hr_leave_adjust(uuid,uuid,uuid,integer,numeric,text)', '38f60bfc0abe388beebc534908d62c5f', true),
  ('hr_leave_assert_hr(uuid,uuid)', '42f5fcb200ca625434f6b66fc30af4b2', true),
  ('hr_leave_balance_of(uuid,uuid,integer,uuid)', '0e5e79e2ef0665a477f942835b946b61', true),
  ('hr_leave_balances_overview(uuid,uuid,integer)', '612cc3524145e261d1ba489e95ae336f', true),
  ('hr_leave_carry_forward_run(uuid,uuid,uuid,integer,boolean,text)', '6dcc41e15c164e22a71cf288ea5e80e6', true),
  ('hr_leave_entitlement_run(uuid,uuid,uuid,integer,boolean,text)', '34d7f21708a5b05890151a987222d13f', true),
  ('hr_leave_ledger_for(uuid,uuid,integer)', 'b95015869d1e43c557dc0a170bab9eb2', true),
  ('hr_leave_my_balances(uuid,integer)', '769ea4b1e21a729420fcc9b2dd175939', true),
  ('hr_leave_post(uuid,uuid,uuid,integer,text,numeric,uuid,text,uuid,text)', '055b114aa693b74bc3dfa31177874f7d', true),
  ('hr_leave_quote(uuid,uuid,date,date,boolean,uuid)', 'db632ce4b01c2a6d4e3ff0fc1f6b9797', true),
  ('hr_leave_request_years(hr_leave_requests)', '3d7342f9837a03b663f3738a38bf7500', true),
  ('hr_leave_requests_w3_ledger()', '95e3bece168b4d7881ef278986ab5d33', true),
  ('hr_leave_requests_w3_quote()', '42ee3836769b94ca63da4d7199f8087f', false),
  ('hr_leave_set_entitlement(uuid,uuid,uuid,integer,numeric,text)', '8ad1d6c8d3c5142696834e09876b78fe', true),
  ('hr_leave_sync_balance(uuid,uuid,uuid,integer)', 'deac165d339467c7b10a60f5f7fe2bbe', true),
  ('hr_leave_target(uuid,uuid,uuid)', '4fea143d0dfbd9cae1ed0d9a0b0da0ee', true),
  ('hr_leave_unpaid_days(uuid,uuid,date,date)', '71ae944a9e8be225df3f6850b5e9c966', true),
  ('hr_leave_w3_check(text,hr_leave_requests,hr_leave_requests)', '374f279f68a5f2ed4782c6ff9090971d', true),
  ('hr_leave_working_dates(uuid,uuid,date,date)', '2e8094039caa4c90106cdaea9f1577b9', true),
  ('hr_leave_year_split(uuid,uuid,date,date,boolean)', '2fd1f6670e827cdf42e778109cc5ddb0', true),
  ('hr_ot_event(uuid,uuid,text,text,text,uuid,text,text)', '6a38a53e020b92bc6344590e4677696f', true),
  ('hr_overtime_cancel(uuid,uuid,text)', '7cfc0a3e315e26ee10b76258fea5c101', true),
  ('hr_overtime_decide(uuid,uuid,text,text,integer)', 'f95fed096f5ad6b59e0e14352dbb6588', true),
  ('hr_overtime_list(uuid,text,text,uuid)', '54533a2aeb613edd1ebd6f4a960559ce', true),
  ('hr_overtime_submit(uuid,date,integer,text,text,uuid,time without time zone,time without time zone,text)', '09a7bb3a6a78a09999b6072e2a8cb626', true),
  ('hr_w3_append_only()', '147d7a7b3d6bd68e98810025e9da3660', false)
) e(fn, expected_md5, expect_definer)
left join pg_proc p on p.oid = to_regprocedure('public.' || e.fn)
order by 1;
-- expected authenticated_exec = f for all EXCEPT hr_leave_w3_check (self-limited) and the trigger function hr_leave_requests_w3_quote
-- (a trigger function cannot be called directly); service_role_exec = t only for the entry points (and that trigger function).
-- hr_att_day_type also matches after the optional correction 20261224100000 (WP holiday alias).

\echo '=== 2. TRIGGERS (expected: 7 rows, tgenabled = O) ==='
select c.relname as tbl, t.tgname, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid
where not t.tgisinternal and t.tgname in ('hr_attendance_entries_api_guard', 'hr_attendance_corrections_api_guard', 'hr_overtime_requests_api_guard',
  'hr_overtime_request_events_append_only', 'hr_w3_leave_requests_quote', 'hr_leave_requests_w3_ledger', 'hr_leave_ledger_append_only')
order by 1, 2;

\echo '=== 3. SEALED TABLES (expected: rls + forced, no anon/authenticated/service_role privileges) ==='
select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
       has_table_privilege('authenticated', c.oid, 'select') as auth_select, has_table_privilege('service_role', c.oid, 'select') as svc_select
from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
where c.relname in ('hr_attendance_exceptions', 'hr_attendance_import_batches', 'hr_attendance_import_rows', 'hr_overtime_request_events', 'hr_leave_ledger')
order by 1;

\echo '=== 4. RESET SCOPE (expected: 5 rows, action delete, categories attendance/leave) ==='
select table_name, category, action, delete_order from public.hr_reset_scope
where table_name in ('hr_attendance_exceptions', 'hr_overtime_request_events', 'hr_attendance_import_rows', 'hr_attendance_import_batches', 'hr_leave_ledger')
order by 1;

\echo '=== 5. ATTENDANCE BACKFILL (expected: entries_without_work_date = 0) ==='
select count(*) as entries, count(*) filter (where work_date is null) as entries_without_work_date,
       count(*) filter (where review_state = 'pending') as pending_review from public.hr_attendance_entries;
select count(*) as corrections, count(*) filter (where employee_ref is null) as corrections_without_employee from public.hr_attendance_corrections;

\echo '=== 6. LEAVE OPENING BALANCE (expected: marker set; projection_mismatches = 0; duplicate keys = 0) ==='
select coalesce(obj_description('public.hr_leave_ledger'::regclass, 'pg_class'), '') like '%[opening balance posted]%' as opening_marker;
select entry_type, count(*) as lines, sum(days) as days from public.hr_leave_ledger group by 1 order by 1;
select count(*) as projection_mismatches from public.hr_leave_balances b
where (public.hr_leave_balance_of(b.employee_id, b.leave_type_id, b.year)->>'taken')::numeric <> b.taken
   or (public.hr_leave_balance_of(b.employee_id, b.leave_type_id, b.year)->>'entitled')::numeric <> b.entitled
   or (public.hr_leave_balance_of(b.employee_id, b.leave_type_id, b.year)->>'pending')::numeric <> b.pending;
select count(*) as duplicate_balance_keys from (select 1 from public.hr_leave_balances group by employee_id, leave_type_id, year having count(*) > 1) d;
select count(*) as approved_requests_without_taken_line from public.hr_leave_requests r
where r.status = 'approved' and not exists (select 1 from public.hr_leave_ledger l where l.request_ref = r.id and l.entry_type = 'taken');

\echo '=== 7. B2A STILL INTACT (expected: 6 b2a policies, 0 others; guard + recorder enabled) ==='
select count(*) filter (where policyname like '%\_b2a\_%') as b2a_policies, count(*) filter (where policyname not like '%\_b2a\_%') as other
from pg_policies where tablename in ('hr_leave_requests', 'hr_leave_approvals', 'hr_leave_balances');
select tgname, tgenabled from pg_trigger where tgname in ('hr_leave_requests_guard', 'hr_leave_requests_record_event');

\echo '=== 8. OPERATION COUNTS SINCE APPLICATION (aggregates; for UAT evidence) ==='
select exception_code, status, count(*) from public.hr_attendance_exceptions group by 1, 2 order by 1, 2;
select status, count(*) from public.hr_attendance_import_batches group by 1 order by 1;
select action, authority, count(*) from public.hr_overtime_request_events group by 1, 2 order by 1, 2;

\echo '=== END (rolled back) ==='
rollback;
