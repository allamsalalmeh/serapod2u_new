-- ============================================================================
-- Serapod2U HR — Wave 2 independent verification + Wave 3 PREFLIGHT (READ-ONLY, owner-run, STAGING)
-- Prepared 2026-10-25. Run from the KVM2 script (kvm2_hr_w2_w3_readonly.sh) or:
--   PGOPTIONS='-c default_transaction_read_only=on' psql "<staging>" -X -v env=staging -v ON_ERROR_STOP=0 \
--        -f hr_w2_verify_w3_preflight_readonly.sql > w2_verify_w3_preflight.txt 2>&1
-- One READ ONLY transaction ended with ROLLBACK; ON_ERROR_ROLLBACK isolates each statement. Aggregates only:
-- no names, e-mails, reasons, statutory values or amounts.
-- Part A proves the OWNER-REPORTED Wave 2 application (function bodies byte-equal to the repository file
-- 20261221100000_hr_employment_foundation.sql — complements hr_w2_staging_post_apply_readonly.sql sections 1–9).
-- Part B measures the data conditions the Wave 3 migrations depend on BEFORE they are applied.
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
select :'env' as declared_env, current_database() as db, now() as checked_at, split_part(version(), ' on ', 1) as server_version,
       current_setting('transaction_read_only') as read_only, current_user as role;

\echo '=== A1. WAVE 2 FUNCTION BODIES = REPOSITORY (expected: 26 rows, all body_matches_repo = t) ==='
select e.fn, p.oid is not null as present, md5(p.prosrc) = e.expected_md5 as body_matches_repo, p.prosecdef as security_definer
from (values
  ('hr_actor_has_explicit(uuid,text,jsonb)', '7540aa8f41c3ec1c45cdd2686c3b2a3b'),
  ('hr_assert_hr_manage(uuid,uuid)', 'a99b128a02cfe2fea86df2e73cbc76eb'),
  ('hr_can_view_employee(uuid,uuid)', '45cf179936d00791e44ce731a55a7840'),
  ('hr_employee_as_of(uuid,date)', 'f681f0dc812e7bc9b07b01af9214c958'),
  ('hr_employee_compensation_log()', 'd9f78f4a616e4319ddab5d1517f67862'),
  ('hr_employee_compensation_no_overlap()', 'e3879b7b8c54912a8acb4f6656e9d383'),
  ('hr_employee_history(uuid,uuid)', '390ad96c6759134b1177d5a13c2995a0'),
  ('hr_employee_profile_get(uuid,uuid)', '0b2828cd358bbbd5c69bf8d0112e6b17'),
  ('hr_employee_profile_save(uuid,uuid,jsonb,jsonb,text)', '938d41901bebba12079a7f60769d35a0'),
  ('hr_employee_profiles_log()', 'f2456718156db74750a1d4c87711baf9'),
  ('hr_employees_end_effects()', '5c5f7cf1d2e98f30c2ab8c256d5d9bfa'),
  ('hr_employees_lifecycle_guard()', '7444af2597d317e6d071078658e09095'),
  ('hr_employees_purge_versions()', '657178fb3a21237a533c27f756c969f8'),
  ('hr_employees_record_version()', 'fec46294f0c79b2d33f4b7ad471a812f'),
  ('hr_employment_change(uuid,uuid,jsonb,date,text)', 'eb1e8383744ef4d51e61b770056f2b50'),
  ('hr_employment_target(uuid)', '14b7935ff10df1f8e27a5f3f53c7c98d'),
  ('hr_history_append_only()', '0f656fea8a8427d759c813ae2dbd7fb8'),
  ('hr_manager_assignment_error(uuid,uuid,uuid)', '3066ee520087547997dded2e0210be79'),
  ('hr_reassign_direct_reports(uuid,uuid,uuid,text,uuid[])', 'cded8c4ac32fb40b426be0fbd255c9b2'),
  ('hr_reporting_line_review(uuid)', 'a2acd55d962b75222c4d833db4328d20'),
  ('hr_reporting_line_review_for(uuid,uuid)', 'dbecfdf66d373e4387ce197294705a91'),
  ('hr_request_db_role()', 'ed7ed49971451ead5a2e439161f8416b'),
  ('hr_set_reporting_line(uuid,uuid,uuid,text)', '6c9ff8f10bb8bfc13463c4d8e1000b23'),
  ('hr_statutory_profile_get(uuid,uuid)', 'ba484a20378fa0af01b09bff61a24d79'),
  ('hr_statutory_profile_save(uuid,uuid,jsonb,text)', 'a3dc88db01c7c03e7f6a4020ca5d92ae'),
  ('hr_statutory_profiles_log()', '7e53bd24a0cfa52e319d1f93ecde491c')
) e(fn, expected_md5)
left join pg_proc p on p.oid = to_regprocedure('public.' || e.fn)
order by 1;
select count(*) filter (where md5(p.prosrc) = e.expected_md5) as matching, count(*) as expected
from (values
  ('hr_actor_has_explicit(uuid,text,jsonb)', '7540aa8f41c3ec1c45cdd2686c3b2a3b'),
  ('hr_assert_hr_manage(uuid,uuid)', 'a99b128a02cfe2fea86df2e73cbc76eb'),
  ('hr_can_view_employee(uuid,uuid)', '45cf179936d00791e44ce731a55a7840'),
  ('hr_employee_as_of(uuid,date)', 'f681f0dc812e7bc9b07b01af9214c958'),
  ('hr_employee_compensation_log()', 'd9f78f4a616e4319ddab5d1517f67862'),
  ('hr_employee_compensation_no_overlap()', 'e3879b7b8c54912a8acb4f6656e9d383'),
  ('hr_employee_history(uuid,uuid)', '390ad96c6759134b1177d5a13c2995a0'),
  ('hr_employee_profile_get(uuid,uuid)', '0b2828cd358bbbd5c69bf8d0112e6b17'),
  ('hr_employee_profile_save(uuid,uuid,jsonb,jsonb,text)', '938d41901bebba12079a7f60769d35a0'),
  ('hr_employee_profiles_log()', 'f2456718156db74750a1d4c87711baf9'),
  ('hr_employees_end_effects()', '5c5f7cf1d2e98f30c2ab8c256d5d9bfa'),
  ('hr_employees_lifecycle_guard()', '7444af2597d317e6d071078658e09095'),
  ('hr_employees_purge_versions()', '657178fb3a21237a533c27f756c969f8'),
  ('hr_employees_record_version()', 'fec46294f0c79b2d33f4b7ad471a812f'),
  ('hr_employment_change(uuid,uuid,jsonb,date,text)', 'eb1e8383744ef4d51e61b770056f2b50'),
  ('hr_employment_target(uuid)', '14b7935ff10df1f8e27a5f3f53c7c98d'),
  ('hr_history_append_only()', '0f656fea8a8427d759c813ae2dbd7fb8'),
  ('hr_manager_assignment_error(uuid,uuid,uuid)', '3066ee520087547997dded2e0210be79'),
  ('hr_reassign_direct_reports(uuid,uuid,uuid,text,uuid[])', 'cded8c4ac32fb40b426be0fbd255c9b2'),
  ('hr_reporting_line_review(uuid)', 'a2acd55d962b75222c4d833db4328d20'),
  ('hr_reporting_line_review_for(uuid,uuid)', 'dbecfdf66d373e4387ce197294705a91'),
  ('hr_request_db_role()', 'ed7ed49971451ead5a2e439161f8416b'),
  ('hr_set_reporting_line(uuid,uuid,uuid,text)', '6c9ff8f10bb8bfc13463c4d8e1000b23'),
  ('hr_statutory_profile_get(uuid,uuid)', 'ba484a20378fa0af01b09bff61a24d79'),
  ('hr_statutory_profile_save(uuid,uuid,jsonb,text)', 'a3dc88db01c7c03e7f6a4020ca5d92ae'),
  ('hr_statutory_profiles_log()', '7e53bd24a0cfa52e319d1f93ecde491c')
) e(fn, expected_md5)
left join pg_proc p on p.oid = to_regprocedure('public.' || e.fn);

\echo '=== A2. WAVE 2 APPEND-ONLY + GRANTS SPOT CHECK (expected: authenticated cannot execute the service entry points) ==='
select f.fn, coalesce(has_function_privilege('authenticated', to_regprocedure('public.' || f.fn), 'execute'), false) as authenticated_exec,
       coalesce(has_function_privilege('service_role', to_regprocedure('public.' || f.fn), 'execute'), false) as service_role_exec
from (values ('hr_employment_change(uuid,uuid,jsonb,date,text)'), ('hr_set_reporting_line(uuid,uuid,uuid,text)'),
             ('hr_statutory_profile_save(uuid,uuid,jsonb,text)'), ('hr_actor_has_explicit(uuid,text,jsonb)')) f(fn);

\echo '=== A3. IDENTITY / RESET COMPATIBILITY (expected: Wave 2 history tables kept; no FK from history to users) ==='
select table_name, action from public.hr_reset_scope where table_name like 'hr_employee_versions' or table_name like 'hr_%profile%' or table_name like 'hr_%change%' order by 1;
select conrelid::regclass as tbl, conname from pg_constraint
where contype = 'f' and conrelid in ('public.hr_employee_versions'::regclass, 'public.hr_reporting_line_changes'::regclass, 'public.hr_compensation_change_log'::regclass);

\echo '=== B1. WAVE 3 PREREQUISITES PRESENT (expected: all t) ==='
select to_regprocedure('public.hr_actor_has_explicit(uuid,text,jsonb)') is not null as wave2_explicit_authority,
       to_regprocedure('public.hr_request_db_role()') is not null as wave2_db_role,
       to_regclass('public.hr_employee_statutory_profiles') is not null as wave2_statutory_profiles,
       to_regprocedure('public.hr_leave_requests_guard()') is not null as b2a_guard,
       to_regclass('public.hr_leave_request_events') is not null as b2a_events,
       to_regprocedure('public.sa_evaluate_permission_core(uuid,text,jsonb,boolean,boolean)') is not null as sa_core,
       to_regprocedure('public.sa_org_ancestry(uuid)') is not null as sa_ancestry;

\echo '=== B2. WAVE 3 ALREADY APPLIED? (expected before application: all f) ==='
select to_regprocedure('public.hr_attendance_clock(uuid,text,uuid,text,timestamptz,text)') is not null as w3a_attendance,
       to_regclass('public.hr_leave_ledger') is not null as w3b_leave_ledger;

\echo '=== B3. LEAVE LEDGER BLOCKER: duplicate hr_leave_balances keys (expected: 0 — otherwise 20261223100000 refuses) ==='
select count(*) as duplicate_balance_keys from (select 1 from public.hr_leave_balances group by employee_id, leave_type_id, year having count(*) > 1) d;
select count(*) as balance_rows, count(*) filter (where carried_forward <> 0) as with_carry_forward, count(*) filter (where adjustment <> 0) as with_adjustment,
       count(*) filter (where taken <> 0) as with_taken from public.hr_leave_balances;

\echo '=== B4. LEAVE OPENING RECONCILIATION SIZE (stored taken vs approved requests; informational) ==='
select count(*) as balance_rows_where_taken_differs from public.hr_leave_balances b
where b.taken <> coalesce((select sum(r.total_days) from public.hr_leave_requests r where r.employee_id = b.employee_id and r.leave_type_id = b.leave_type_id
                           and r.status = 'approved' and extract(year from r.start_date) = b.year), 0);
select status, count(*) from public.hr_leave_requests group by 1 order by 1;

\echo '=== B5. ATTENDANCE DATA THAT WAVE 3 WILL CLASSIFY (informational) ==='
select source, status, count(*) as entries, count(*) filter (where clock_out_at is null) as open_entries from public.hr_attendance_entries group by 1, 2 order by 1, 2;
select count(*) as overlapping_entry_pairs from public.hr_attendance_entries a join public.hr_attendance_entries b
  on b.user_id = a.user_id and b.id > a.id
 and tstzrange(a.clock_in_at, coalesce(a.clock_out_at, a.clock_in_at + interval '1 minute')) && tstzrange(b.clock_in_at, coalesce(b.clock_out_at, b.clock_in_at + interval '1 minute'));
select status, count(*) from public.hr_attendance_corrections group by 1 order by 1;
select status, count(*) from public.hr_overtime_requests group by 1 order by 1;
select count(*) as employees_with_two_active_ot_same_day from (select 1 from public.hr_overtime_requests where status in ('draft','submitted','approved')
  group by employee_id, request_date having count(*) > 1) d;

\echo '=== B6. CALENDAR INPUTS (policies per organization, holiday state labels, work states captured) ==='
select count(*) as attendance_policies, count(*) filter (where timezone <> 'Asia/Kuala_Lumpur') as non_kl_timezone from public.hr_attendance_policies;
select coalesce(nullif(btrim(state), ''), '(national)') as holiday_state, count(*) from public.hr_public_holidays group by 1 order by 1;
select work_state, count(*) from public.hr_employee_statutory_profiles group by 1 order by 1;
select count(*) as active_shifts, count(*) filter (where expected_work_minutes is null) as shifts_without_expected_minutes from public.hr_shifts where is_active;

\echo '=== B7. LEAVE TYPE CONFIGURATION USED BY THE ENTITLEMENT / CARRY-FORWARD RUNS (counts only) ==='
select count(*) as active_types, count(*) filter (where jsonb_array_length(coalesce(entitlement_tiers, '[]'::jsonb)) > 0) as with_tiers,
       count(*) filter (where coalesce((carry_forward->>'enabled')::boolean, false)) as carry_forward_enabled,
       count(*) filter (where coalesce((pro_rata->>'enabled')::boolean, false)) as pro_rata_enabled
from public.hr_leave_types where status = 'active';

\echo '=== B8. S&A COVERAGE FOR WAVE 3 (explicit vs legacy holders; requested MSS keys exist?) ==='
select p.permission_key,
       count(distinct a.user_id) filter (where br.source <> 'legacy') as holders_explicit,
       count(distinct a.user_id) filter (where br.source = 'legacy') as holders_legacy_compat
from public.sa_permissions p
left join public.sa_business_role_permissions bp on bp.permission_id = p.id
left join public.sa_business_roles br on br.id = bp.role_id and br.status = 'active'
left join public.sa_role_assignments a on a.role_id = br.id and a.status = 'active'
where p.permission_key in ('hr.attendance.manage', 'hr.leave.approve', 'hr.mss.attendance_view', 'hr.mss.leave_view', 'hr.mss.leave_approve',
                           'hr.self_service.use', 'hr.mss.attendance_approve', 'hr.mss.overtime_approve')
group by 1 order by 1;
select k as requested_key, exists (select 1 from public.sa_permissions where permission_key = k) as exists_in_catalogue
from unnest(array['hr.mss.attendance_approve', 'hr.mss.overtime_approve', 'hr.leave.manage', 'hr.leave.view']) k;

\echo '=== B9. DIRECT WRITERS THAT WAVE 3 WILL STOP (recent API-role writes are expected from the OLD app build) ==='
select date_trunc('day', created_at)::date as day, count(*) as entries_created from public.hr_attendance_entries
where created_at > now() - interval '14 days' group by 1 order by 1;

\echo '=== END (rolled back) ==='
rollback;
