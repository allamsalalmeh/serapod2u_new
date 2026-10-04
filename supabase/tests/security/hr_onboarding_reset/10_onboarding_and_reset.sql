-- ============================================================================
-- HR onboarding state + HR data reset — SQL certification suite
-- ----------------------------------------------------------------------------
-- DISPOSABLE ISOLATED DATABASES ONLY. Never run against staging or
-- production (it creates fixture people, grants roles and executes resets).
-- The suite refuses to run unless every user is a fixture identity.
--
-- Prerequisites: a replica schema with the Identity Foundation / Stage 2 and
-- S&A functions, 00_fixtures.sql (run BEFORE the migration so the legacy
-- backfill is exercised), then 20261003100000_hr_onboarding_state_and_data_reset.sql.
-- Every check raises on failure; the run ends with "ALL HR ONBOARDING/RESET CHECKS PASSED".
-- ============================================================================
\set ON_ERROR_STOP 1
set client_min_messages = notice;

do $pre$
begin
  if exists (select 1 from public.users where id::text not like '00000000-0000-0000-0000-0000000000%') then
    raise exception 'Refusing to run: database contains non-fixture users';
  end if;
  if to_regprocedure('public.hr_reset_execute(uuid,uuid,text,uuid,text,text,text)') is null then
    raise exception 'Migration 20261003100000 is not applied';
  end if;
end $pre$;

drop schema if exists t cascade;
create schema t;
create function t.ok(p_name text, p_cond boolean) returns void language plpgsql as $$
begin
  if not coalesce(p_cond, false) then raise exception 'FAIL: %', p_name; end if;
  raise notice 'PASS: %', p_name;
end $$;
create function t.err(p_name text, p_sql text, p_pattern text) returns void language plpgsql as $$
declare v_raised boolean := false; v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    v_raised := true; v_msg := sqlerrm;
  end;
  if not v_raised then raise exception 'FAIL (no error): %', p_name; end if;
  if v_msg !~ p_pattern then raise exception 'FAIL: % — expected /%/, got: %', p_name, p_pattern, v_msg; end if;
  raise notice 'PASS: % (%)', p_name, v_msg;
end $$;
-- Explicit S&A grant of hr.data.reset (organization scope).
create function t.grant_reset(p_user uuid, p_org uuid) returns void language plpgsql as $$
declare v_m uuid; v_s uuid; v_a uuid; v_role uuid;
begin
  select id into v_role from public.sa_business_roles where role_key = 'hr-data-reset-administrator';
  select id into v_m from public.sa_organization_memberships where user_id = p_user and organization_id = p_org;
  if v_m is null then
    insert into public.sa_organization_memberships(user_id, organization_id, status) values (p_user, p_org, 'active') returning id into v_m;
  end if;
  select id into v_s from public.sa_scope_definitions where scope_type = 'organization' and scope_value = p_org::text;
  if v_s is null then
    insert into public.sa_scope_definitions(organization_id, scope_type, scope_value, display_name, status, resource_metadata)
    values (p_org, 'organization', p_org::text, 'org', 'active', '{}'::jsonb) returning id into v_s;
  end if;
  insert into public.sa_role_assignments(user_id, role_id, membership_id, status, source) values (p_user, v_role, v_m, 'active', 'manual') returning id into v_a;
  insert into public.sa_assignment_scopes(assignment_id, scope_id) values (v_a, v_s);
end $$;
create function t.onb(p_user uuid) returns text language sql as $$
  select onboarding_status from public.hr_employees where user_id = p_user and organization_id = (select organization_id from public.users where id = p_user) $$;
-- HR list rule used by the application: completed onboarding in the organization.
create function t.hr_list(p_org uuid) returns uuid[] language sql as $$
  select coalesce(array_agg(u.id order by u.id), '{}') from public.users u
  join public.hr_employees e on e.user_id = u.id and e.organization_id = p_org and e.onboarding_status = 'completed'
  where u.organization_id = p_org $$;

-- ---------------------------------------------------------------------------
-- 1. Legacy backfill and automatic anchors
-- ---------------------------------------------------------------------------
do $$ begin
  perform t.ok('legacy backfill keeps every existing record onboarded (no mass reset)',
    not exists (select 1 from hr_employees where onboarding_status <> 'completed' or onboarding_source <> 'legacy_backfill'));
  perform t.ok('legacy hire dates are not presented as confirmed', not exists (select 1 from hr_employees where hire_date_confirmed));
  perform t.ok('HR list unchanged by the migration (all HQ Alpha internal staff)', cardinality(t.hr_list(o(1))) = 6);
  perform t.ok('pre-go-live seeded for organizations with employment records',
    (select count(*) from hr_go_live_state where phase = 'pre_go_live') = 2);
end $$;

-- A new internal identity gets an automatic anchor that is NOT onboarded.
select mkuser(10, 'newsc@hqa.test', '+60120000010', 'Nora Newsc', 'WH_STAFF', o(1));
do $$ begin
  perform t.ok('automatic anchor is pending', t.onb(u(10)) = 'pending');
  perform t.ok('pending anchor has an employee number', (select employee_no from hr_employees where user_id = u(10)) is not null);
  perform t.ok('pending employee is not in the HR list', not (u(10) = any(t.hr_list(o(1)))));
end $$;

-- Profile edits / login / employment edits through users never onboard.
update users set last_login_at = now(), full_name = 'Nora Newsc-Edited' where id = u(10);
update users set department_id = x(1) where id = u(10);
do $$ begin
  perform t.ok('login and profile edits keep the anchor pending', t.onb(u(10)) = 'pending');
  perform t.ok('users → employment forwarding still works', (select department_id from hr_employees where user_id = u(10)) = x(1));
end $$;
select t.err('direct onboarding_status write is refused (database owner, no trusted flag)',
  $q$update hr_employees set onboarding_status = 'completed' where user_id = u(10)$q$, 'hr_onboarding_state_protected');
select t.err('direct insert cannot create an onboarded record either',
  $q$do $i$ begin
       insert into hr_employees(user_id, organization_id, hire_date, onboarding_status) values (u(7), o(1), current_date, 'completed');
       if (select onboarding_status from hr_employees where user_id = u(7)) <> 'pending' then raise exception 'insert_was_onboarded'; end if;
       raise exception 'forced_pending_ok';
     end $i$$q$, 'forced_pending_ok');

-- Operational guard: no HR transactions for a pending employee.
select t.err('attendance for a pending employee is refused',
  $q$insert into hr_attendance_entries(organization_id, user_id, status) values (o(1), u(10), 'open')$q$, 'hr_onboarding_pending');
select t.err('leave request for a pending employee is refused',
  $q$insert into hr_leave_requests(organization_id, employee_id, leave_type_id, status) values (o(1), u(10), x(4), 'pending')$q$, 'hr_onboarding_pending');

-- ---------------------------------------------------------------------------
-- 2. Add Employee: existing Supply Chain user keeps one identity
-- ---------------------------------------------------------------------------
create temp table before_sc as
select (select count(*) from users) as n_users, (select count(*) from auth.users) as n_auth,
       (select count(*) from hr_employees) as n_emp,
       (select employee_no from hr_employees where user_id = u(10)) as emp_no,
       (select role_code from users where id = u(10)) as role_code,
       (select count(*) from sa_organization_memberships where user_id = u(10)) as n_memb,
       (select email || phone from users where id = u(10)) as ids;
insert into orders(id, created_by) values (x(21), u(10));

-- Resolution by email (canonical resolver) finds the same identity.
do $$ declare r jsonb := identity_resolve('NewSC@HQA.test ', null); begin
  perform t.ok('email resolves to the existing identity', r->>'outcome' = 'MATCH' and (r->>'user_id')::uuid = u(10));
end $$;
-- Canonical provisioning with HR authority reuses the identity (no second account).
do $$ declare r jsonb; begin
  r := identity_provision(u(2), u(10), jsonb_build_object('email','newsc@hqa.test','phone','+60120000010','full_name','Nora Newsc',
        'organization_id', o(1), 'account_scope','portal','authorizing_permission','hr.employee.manage','source','hr'));
  perform t.ok('identity_provision reuses the existing identity', r->>'status' = 'ok' and r->>'outcome' = 'REUSED');
end $$;
do $$ declare c jsonb; r jsonb; begin
  c := hr_onboarding_candidate(u(2), o(1), u(10));
  perform t.ok('candidate preview is minimal and masked', c->>'email_masked' = 'ne***@hqa.test' and c ? 'phone_masked' and not (c ? 'email') and (c->>'eligible')::boolean);
  r := hr_onboarding_complete(u(2), u(10), jsonb_build_object('organization_id', o(1), 'department_id', x(1), 'position_id', x(3),
         'manager_user_id', u(2), 'employment_type', 'Full-time', 'hire_date', '2025-02-01'));
  perform t.ok('existing user onboarded', r->>'outcome' = 'ONBOARDED' and (r->>'user_id')::uuid = u(10));
end $$;
do $$ declare b record; begin
  select * into b from before_sc;
  perform t.ok('same user id: no new users / auth rows', (select count(*) from users) = b.n_users and (select count(*) from auth.users) = b.n_auth);
  perform t.ok('employment record reused, employee number preserved',
    (select count(*) from hr_employees) = b.n_emp and (select employee_no from hr_employees where user_id = u(10)) = b.emp_no);
  perform t.ok('login identifiers unchanged', (select email || phone from users where id = u(10)) = b.ids);
  perform t.ok('legacy role code (Supply Chain access) unchanged', (select role_code from users where id = u(10)) = b.role_code);
  perform t.ok('memberships unchanged', (select count(*) from sa_organization_memberships where user_id = u(10)) = b.n_memb);
  perform t.ok('Supply Chain transaction reference intact', (select created_by from orders where id = x(21)) = u(10));
  perform t.ok('onboarded and in HR list', t.onb(u(10)) = 'completed' and u(10) = any(t.hr_list(o(1))));
  perform t.ok('HR facts projected to users', (select (position_id, manager_user_id, join_date, employment_type) from users where id = u(10))
                                                 = (x(3), u(2), '2025-02-01'::date, 'Full-time'::text));
  perform t.ok('hire date confirmed by HR', (select hire_date_confirmed and hire_date = '2025-02-01' from hr_employees where user_id = u(10)));
end $$;
-- Repeat onboarding (double submission) creates nothing.
do $$ declare r jsonb; begin
  r := hr_onboarding_complete(u(2), u(10), jsonb_build_object('organization_id', o(1), 'hire_date', '2020-01-01'));
  perform t.ok('repeat onboarding is a no-op', r->>'outcome' = 'ALREADY_ONBOARDED'
     and (select hire_date from hr_employees where user_id = u(10)) = '2025-02-01'
     and (select count(*) from hr_employees where user_id = u(10)) = 1
     and (select count(distinct employee_no) = count(*) from hr_employees));
end $$;
-- Now a pending → onboarded employee may record HR transactions.
insert into hr_attendance_entries(id, organization_id, user_id, status) values (x(42), o(1), u(10), 'closed');

-- ---------------------------------------------------------------------------
-- 3. Conflicts, other organizations, other principal types
-- ---------------------------------------------------------------------------
do $$ declare r jsonb; begin
  r := identity_resolve('newsc@hqa.test', '+60120000005');
  perform t.ok('email of one person + phone of another = conflict', r->>'outcome' = 'IDENTITY_CONFLICT');
  r := identity_provision(u(2), u(10), jsonb_build_object('email','newsc@hqa.test','phone','+60120000005','full_name','X',
        'organization_id', o(1), 'account_scope','portal','authorizing_permission','hr.employee.manage','source','hr'));
  perform t.ok('provisioning blocks the conflict', r->>'status' = 'blocked' and r->>'code' = 'IDENTITY_CONFLICT');
  perform t.ok('candidate in another organization is blocked (move process)', hr_onboarding_candidate(u(2), o(1), u(5))->>'block_code' = 'IDENTITY_ORG_MOVE_REQUIRED');
  perform t.ok('other organization name is not disclosed', hr_onboarding_candidate(u(2), o(1), u(5))->>'organization_name' is null);
  perform t.ok('distributor user is blocked', hr_onboarding_candidate(u(2), o(1), u(6))->>'eligible' = 'false');
  perform t.ok('consumer is blocked (conversion process)', hr_onboarding_candidate(u(2), o(1), u(7))->>'block_code' = 'IDENTITY_PRINCIPAL_UPGRADE_REQUIRED');
end $$;
select t.err('onboarding another organization''s employee is refused',
  $q$select hr_onboarding_complete(u(2), u(5), jsonb_build_object('organization_id', o(1), 'hire_date', '2025-01-01'))$q$, 'identity_org_move_required');
select t.err('onboarding a distributor user is refused',
  $q$select hr_onboarding_complete(u(2), u(6), jsonb_build_object('organization_id', o(1), 'hire_date', '2025-01-01'))$q$, 'identity_org_move_required');
select t.err('a manager from another organization is refused',
  $q$select hr_onboarding_complete(u(2), u(4), jsonb_build_object('organization_id', o(1), 'hire_date', '2025-01-01', 'manager_user_id', u(5)))$q$, 'identity_hr_reference_outside_organization');
select t.err('hire date is required',
  $q$select hr_onboarding_complete(u(2), u(4), jsonb_build_object('organization_id', o(1)))$q$, 'hr_onboarding_hire_date_required');
select t.err('ordinary staff cannot onboard',
  $q$select hr_onboarding_complete(u(3), u(4), jsonb_build_object('organization_id', o(1), 'hire_date', '2025-01-01'))$q$, 'sa_authorization_required');
select t.err('self-onboarding is refused',
  $q$select hr_onboarding_complete(u(2), u(2), jsonb_build_object('organization_id', o(1), 'hire_date', '2025-01-01'))$q$, 'hr_onboarding_self_prohibited');
do $$ begin
  perform t.ok('name search returns masked candidates only for the organization',
    jsonb_array_length(hr_onboarding_search(u(2), o(1), 'sam')) = 1 and jsonb_array_length(hr_onboarding_search(u(2), o(1), 'ben')) = 0);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Reset authorization and pre-go-live
-- ---------------------------------------------------------------------------
select t.grant_reset(u(1), o(1));
select t.grant_reset(u(9), o(1));
select t.err('HR manager (not Super Admin) cannot preview a reset', $q$select hr_reset_preview(u(2), o(1), 'onboarding')$q$, 'hr_reset_requires_super_admin');
select t.err('reset permission without Super Admin is refused', $q$select hr_reset_preview(u(9), o(1), 'onboarding')$q$, 'hr_reset_requires_super_admin');
select t.err('Super Admin without the explicit S&A grant is refused', $q$select hr_reset_preview(u(8), o(1), 'onboarding')$q$, 'hr_reset_permission_required');
select t.err('grant in HQ Alpha does not reach HQ Beta', $q$select hr_reset_preview(u(1), o(2), 'onboarding')$q$, 'hr_reset_permission_required');
select t.grant_reset(u(1), o(2));
select hr_mark_go_live(u(1), o(2), 'HQ Beta live');
select t.err('reset refused once HR is live', $q$select hr_reset_preview(u(1), o(2), 'full')$q$, 'hr_reset_not_pre_go_live');
select t.err('go-live is one-way', $q$update hr_go_live_state set phase = 'pre_go_live' where organization_id = o(2)$q$, 'hr_go_live_is_one_way');

select t.err('API role cannot read snapshots', $q$set local role authenticated; select count(*) from hr_reset_snapshots$q$, 'permission denied');
select t.err('API role cannot execute a reset', $q$set local role authenticated; select hr_reset_preview(u(1), o(1), 'onboarding')$q$, 'permission denied');
select t.err('service role cannot read snapshots', $q$set local role service_role; select count(*) from hr_reset_snapshots$q$, 'permission denied');
select t.err('API role cannot change onboarding through the table',
  $q$set local role authenticated; update hr_employees set onboarding_status = 'completed'$q$, 'permission denied|hr_onboarding_state_protected');

-- ---------------------------------------------------------------------------
-- 5. Reset Employee Onboarding
-- ---------------------------------------------------------------------------
create temp table before_onb as
select (select jsonb_agg(to_jsonb(u) - 'updated_at' order by u.id) from users u) as users_rows,
       (select jsonb_agg(jsonb_build_object('id', e.id, 'no', e.employee_no, 'status', e.status, 'dept', e.department_id) order by e.id) from hr_employees e) as emp,
       (select count(*) from hr_leave_requests) as leave_n, (select count(*) from sa_organization_memberships) as memb,
       (select count(*) from hr_employee_profiles) as profiles;
do $$ declare p jsonb; r jsonb; begin
  p := hr_reset_preview(u(1), o(1), 'onboarding');
  perform t.ok('onboarding preview counts completed records', (p->'onboarding'->>'to_reset')::int = 7 and jsonb_array_length(p->'delete') = 0);
  perform t.ok('onboarding preview lists preserved categories and kept data', jsonb_array_length(p->'preserved') >= 5 and jsonb_array_length(p->'keep') > 10);
  perform t.ok('confirmation phrase names the organization', p->>'confirmation_phrase' = 'RESET ONBOARDING HQA');
  perform t.err('wrong confirmation is refused',
    format($q$select hr_reset_execute(u(1), o(1), 'onboarding', gen_random_uuid(), %L, 'Re-register before go-live', 'reset onboarding hqa')$q$, p->>'preview_token'),
    'hr_reset_confirmation_mismatch');
  perform t.err('a reason is required',
    format($q$select hr_reset_execute(u(1), o(1), 'onboarding', gen_random_uuid(), %L, 'short', 'RESET ONBOARDING HQA')$q$, p->>'preview_token'),
    'hr_reset_reason_required');
  r := hr_reset_execute(u(1), o(1), 'onboarding', x(100), p->>'preview_token', 'Re-register all staff before go-live', 'RESET ONBOARDING HQA');
  perform t.ok('onboarding reset completed', r->>'status' = 'completed' and (r->>'onboarding_reset')::int = 7);
end $$;
do $$ declare b record; begin
  select * into b from before_onb;
  perform t.ok('reset employees leave the HR list', cardinality(t.hr_list(o(1))) = 0);
  perform t.ok('other organization untouched', (select onboarding_status from hr_employees where user_id = u(5)) = 'completed');
  perform t.ok('users rows (identity, projections, employment status, account) unchanged',
    (select jsonb_agg(to_jsonb(u) - 'updated_at' order by u.id) from users u) = b.users_rows);
  perform t.ok('employment records, employee numbers, status and departments preserved',
    (select jsonb_agg(jsonb_build_object('id', e.id, 'no', e.employee_no, 'status', e.status, 'dept', e.department_id) order by e.id) from hr_employees e) = b.emp);
  perform t.ok('HR history, memberships and profiles preserved',
    (select count(*) from hr_leave_requests) = b.leave_n and (select count(*) from sa_organization_memberships) = b.memb
    and (select count(*) from hr_employee_profiles) = b.profiles);
  perform t.ok('snapshot captured every reset record', (select count(*) from hr_reset_snapshots where run_id = (select id from hr_reset_runs where request_id = x(100))) = 7);
  perform t.ok('permanent run record written', exists (select 1 from hr_reset_runs where request_id = x(100) and status = 'completed' and actor_id = u(1)));
  perform t.ok('per-employee reset log written', (select count(*) from hr_employee_onboarding_log where event = 'reset') = 7);
end $$;
select t.err('run record is append-only', $q$delete from hr_reset_runs$q$, 'hr_reset_runs_is_append_only');
select t.err('snapshots are append-only', $q$update hr_reset_snapshots set row_data = '{}'$q$, 'hr_reset_snapshots_is_append_only');
-- Edits / logins after the reset do not undo it.
update users set last_login_at = now(), department_id = x(2), employment_type = 'Contract' where id = u(3);
do $$ begin
  perform t.ok('profile/login/employment edits keep the reset', t.onb(u(3)) = 'reset');
  perform t.ok('projection edits still flow to the employment record', (select department_id from hr_employees where user_id = u(3)) = x(2));
end $$;
select t.err('new attendance for a reset employee is refused (ESS pending setup)',
  $q$insert into hr_attendance_entries(organization_id, user_id, status) values (o(1), u(3), 'open')$q$, 'hr_onboarding_pending');
-- Replay of the same request returns the recorded outcome.
do $$ declare r jsonb; begin
  r := hr_reset_execute(u(1), o(1), 'onboarding', x(100), 'whatever', 'Re-register all staff before go-live', 'RESET ONBOARDING HQA');
  perform t.ok('double submission is replayed, not re-executed', (r->>'replayed')::boolean and (select count(*) from hr_reset_runs) = 1);
end $$;
-- Re-onboarding after reset.
do $$ declare r jsonb; begin
  r := hr_onboarding_complete(u(2), u(3), jsonb_build_object('organization_id', o(1), 'department_id', x(1), 'position_id', x(3),
         'employment_type', 'Full-time', 'hire_date', '2024-06-01'));
  perform t.ok('reset employee re-onboarded with same employee number', r->>'outcome' = 'REONBOARDED'
    and (r->>'employee_no')::int = (select (x->>'no')::int from before_onb, jsonb_array_elements(emp) x where (x->>'id')::uuid = (select id from hr_employees where user_id = u(3))));
end $$;
-- Super Admin needs onboarding by someone else; onboard u(2) by u(1) so HR can act.
select hr_onboarding_complete(u(1), u(2), jsonb_build_object('organization_id', o(1), 'hire_date', '2023-01-01'));
select hr_onboarding_complete(u(2), u(4), jsonb_build_object('organization_id', o(1), 'hire_date', '2023-03-01'));

-- ---------------------------------------------------------------------------
-- 6. Reset All HR Data: blockers, staleness, rollback, success, restore
-- ---------------------------------------------------------------------------
create temp table cfg_before as
select (select count(*) from departments) d, (select count(*) from hr_positions) p, (select count(*) from hr_leave_types) lt,
       (select count(*) from hr_public_holidays) h, (select count(*) from hr_allowance_types) a, (select count(*) from hr_salary_bands) s,
       (select count(*) from hr_approval_chains) ac, (select count(*) from hr_kpi_metrics) km, (select count(*) from hr_kpi_periods) kp,
       (select count(*) from hr_employee_profiles) prof, (select count(*) from orders) ord, (select count(*) from users) usr,
       (select count(*) from hr_leave_requests where organization_id = o(2)) other_org;

-- Blocker 1: payroll posted to the General Ledger.
insert into gl_journals(id) values (x(50));
update hr_payroll_runs set gl_journal_id = x(50) where id = x(35);
-- Blocker 2: Finance-owned payroll journal referencing the run (cross-module).
insert into payroll_journals(id, payroll_run_id) values (x(51), x(35));
do $$ declare p jsonb; r jsonb; v_rows bigint; begin
  v_rows := (select count(*) from hr_leave_requests) + (select count(*) from hr_payroll_runs);
  p := hr_reset_preview(u(1), o(1), 'full');
  perform t.ok('preview reports the GL posting blocker', exists (select 1 from jsonb_array_elements(p->'blockers') b where b->>'code' = 'FINANCE_POSTED'));
  perform t.ok('preview reports the cross-module dependency', exists (select 1 from jsonb_array_elements(p->'blockers') b
     where b->>'code' = 'DEPENDENCY' and b->>'table' = 'payroll_journals'));
  r := hr_reset_execute(u(1), o(1), 'full', x(101), p->>'preview_token', 'Clean HR test data before go-live', 'RESET ALL HR DATA HQA');
  perform t.ok('blocked reset changes nothing', r->>'status' = 'blocked'
     and (select count(*) from hr_leave_requests) + (select count(*) from hr_payroll_runs) = v_rows
     and not exists (select 1 from hr_reset_snapshots s join hr_reset_runs rr on rr.id = s.run_id where rr.request_id = x(101)));
  perform t.ok('blocked attempt is recorded permanently', exists (select 1 from hr_reset_runs where request_id = x(101) and status = 'blocked'));
end $$;
delete from payroll_journals where id = x(51);
update hr_payroll_runs set gl_journal_id = null where id = x(35);

-- Blocker 3: another organization's row referencing an in-scope row.
insert into hr_attendance_corrections(id, organization_id, entry_id, status) values (x(52), o(2), x(33), 'pending');
do $$ declare p jsonb; begin
  p := hr_reset_preview(u(1), o(1), 'full');
  perform t.ok('cross-organization reference blocks', exists (select 1 from jsonb_array_elements(p->'blockers') b where b->>'table' = 'hr_attendance_corrections'));
end $$;
delete from hr_attendance_corrections where id = x(52);

-- Stale preview.
do $$ declare p jsonb; r jsonb; begin
  p := hr_reset_preview(u(1), o(1), 'full');
  perform t.ok('no blockers remain', jsonb_array_length(p->'blockers') = 0);
  update hr_leave_balances set entitled = 14 where id = x(32);
  r := hr_reset_execute(u(1), o(1), 'full', x(102), p->>'preview_token', 'Clean HR test data before go-live', 'RESET ALL HR DATA HQA');
  perform t.ok('stale preview is refused without changes', r->>'status' = 'stale' and exists (select 1 from hr_leave_balances where id = x(32)));
end $$;

-- Rollback: a failure after snapshot/delete started leaves nothing behind.
create function t.boom() returns trigger language plpgsql as $$ begin raise exception 'simulated_failure'; end $$;
create trigger zz_boom before delete on hr_kpi_scorecards for each row execute function t.boom();
do $$ declare p jsonb; v_leave bigint := (select count(*) from hr_leave_requests); begin
  p := hr_reset_preview(u(1), o(1), 'full');
  perform t.ok('preview warns about delete triggers', exists (select 1 from jsonb_array_elements(p->'warnings') w where w->>'trigger' = 'zz_boom'));
  perform t.err('failure mid-reset raises',
    format($q$select hr_reset_execute(u(1), o(1), 'full', %L, %L, 'Clean HR test data before go-live', 'RESET ALL HR DATA HQA')$q$, x(103), p->>'preview_token'),
    'simulated_failure');
  perform t.ok('rollback: data, onboarding, snapshots and run record unchanged',
    (select count(*) from hr_leave_requests) = v_leave and t.onb(u(3)) = 'completed'
    and not exists (select 1 from hr_reset_runs where request_id = x(103)) and (select count(*) from hr_reset_snapshots) = 7);
end $$;
drop trigger zz_boom on hr_kpi_scorecards;

-- Success.
create temp table full_before as
select (select count(*) from hr_leave_requests where organization_id = o(1)) l, (select count(*) from hr_attendance_entries where organization_id = o(1)) a,
       (select count(*) from hr_payroll_runs where organization_id = o(1)) pr, (select count(*) from hr_kpi_scorecard_items where organization_id = o(1)) ki,
       (select count(*) from hr_employees where organization_id = o(1) and onboarding_status = 'completed') onb;
do $$ declare p jsonb; r jsonb; c record; fb record; begin
  select * into fb from full_before;
  p := hr_reset_preview(u(1), o(1), 'full');
  perform t.ok('full preview counts by category', (select (x->>'count')::int from jsonb_array_elements(p->'delete') x where x->>'table' = 'hr_leave_requests') = fb.l);
  r := hr_reset_execute(u(1), o(1), 'full', x(104), p->>'preview_token', 'Clean HR test data before go-live', 'RESET ALL HR DATA HQA');
  perform t.ok('full reset completed', r->>'status' = 'completed' and (r->>'onboarding_reset')::int = fb.onb);
  perform t.ok('operational data of the organization removed',
    not exists (select 1 from hr_leave_requests where organization_id = o(1)) and not exists (select 1 from hr_attendance_entries where organization_id = o(1))
    and not exists (select 1 from hr_payroll_runs where organization_id = o(1)) and not exists (select 1 from hr_kpi_scorecards where organization_id = o(1))
    and not exists (select 1 from hr_employee_compensation where organization_id = o(1)) and not exists (select 1 from hr_employee_allowances where organization_id = o(1)));
  select * into c from cfg_before;
  perform t.ok('configuration, profiles, Supply Chain and identities preserved',
    (select count(*) from departments) = c.d and (select count(*) from hr_positions) = c.p and (select count(*) from hr_leave_types) = c.lt
    and (select count(*) from hr_public_holidays) = c.h and (select count(*) from hr_allowance_types) = c.a and (select count(*) from hr_salary_bands) = c.s
    and (select count(*) from hr_approval_chains) = c.ac and (select count(*) from hr_kpi_metrics) = c.km and (select count(*) from hr_kpi_periods) = c.kp
    and (select count(*) from hr_employee_profiles) = c.prof and (select count(*) from orders) = c.ord and (select count(*) from users) = c.usr);
  perform t.ok('other organization''s HR data untouched', (select count(*) from hr_leave_requests where organization_id = o(2)) = c.other_org);
  perform t.ok('snapshot rows equal affected rows', (select snapshot_rows from hr_reset_runs where request_id = x(104))
     = (select count(*) from hr_reset_snapshots s join hr_reset_runs rr on rr.id = s.run_id where rr.request_id = x(104)));
end $$;

-- Restore from the snapshot.
do $$ declare r jsonb; fb record; begin
  select * into fb from full_before;
  r := hr_reset_restore(u(1), (select id from hr_reset_runs where request_id = x(104)), 'Restore rehearsal on replica');
  perform t.ok('restore re-inserts every captured row and onboarding state',
    (select count(*) from hr_leave_requests where organization_id = o(1)) = fb.l
    and (select count(*) from hr_payroll_runs where organization_id = o(1)) = fb.pr
    and (select count(*) from hr_kpi_scorecard_items where organization_id = o(1)) = fb.ki
    and (select count(*) from hr_employees where organization_id = o(1) and onboarding_status = 'completed') = fb.onb);
  perform t.err('a run is restored at most once',
    format($q$select hr_reset_restore(u(1), %L, 'Restore rehearsal on replica')$q$, (select id from hr_reset_runs where request_id = x(104))),
    'hr_reset_already_restored');
end $$;

do $$ begin raise notice 'ALL HR ONBOARDING/RESET CHECKS PASSED'; end $$;
