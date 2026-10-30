-- After 20261216100000. Actors: 1 = explicit platform.identity.delete + hr.employee.delete in o1, 28 = Root Access (owner).
create temp table c0 as select
  (select count(*) from public.users) as users_n, (select count(*) from auth.users) as auth_n,
  (select count(*) from public.hr_employees where organization_id = ipd.o(1) and onboarding_status = 'completed') as onboarded,
  (select count(*) from public.hr_employees where organization_id = ipd.o(1) and onboarding_status <> 'completed') as awaiting,
  (select count(*) from public.sa_access_change_log) as change_log_n,
  (select count(*) from public.sa_authorization_decisions) as decisions_n;

-- ── Authorization ──────────────────────────────────────────────────────────
select ipd.expect(ipd.try($$select ipd.preview(2, 3)$$) like '42501 sa_authorization_required%', 'auth: legacy Super Admin without a grant is refused (no legacy bypass)');
select ipd.expect(ipd.try($$select ipd.exec(2, 3, 1)$$) like '42501 sa_authorization_required%', 'auth: legacy Super Admin refused at execution');
select ipd.expect(ipd.try($$select ipd.preview(13, 3, 'hr')$$) like '42501 sa_authorization_required%', 'auth: HR records officer (hr.employee.manage) cannot fully delete from HR');
select ipd.expect(ipd.try($$select ipd.preview(14, 3, 'hr')$$) like '42501 sa_authorization_required%', 'auth: hr.employee.delete alone (HR registration delete) does not authorize identity deletion');
select ipd.expect(ipd.try($$select ipd.preview(14, 3)$$) like '42501 sa_authorization_required%', 'auth: hr.employee.delete alone refused at the User Management entry too');
select ipd.expect(ipd.try($$select public.identity_deletion_execute(null, ipd.u(3), 'user_management', ipd.x(9001), 't', 'some reason here', 'x')$$) like '42501 sa_actor_required%',
  'auth: anonymous actor refused');
select ipd.expect(ipd.try($$select ipd.preview(1, 3, 'payroll')$$) like '22023 identity_deletion_entry_invalid%', 'auth: unknown entry point refused');
select ipd.expect(not has_function_privilege('authenticated', 'public.identity_deletion_execute(uuid,uuid,text,uuid,text,text,text)', 'execute')
                  and not has_function_privilege('anon', 'public.identity_deletion_preview(uuid,uuid,text)', 'execute')
                  and not has_function_privilege('authenticated', 'public.identity_deletion_record_auth_check(uuid,boolean,text)', 'execute')
                  and not has_table_privilege('service_role', 'public.identity_deletion_requests', 'select'),
  'auth: API roles cannot call the functions or read the record (server-only)');
select ipd.expect(ipd.try($$select ipd.preview(1, 11)$$) like '42501 sa_authorization_required%', 'cross-org: o1 administrator refused for an o2 identity (same answer as unauthorized)');
select ipd.expect(ipd.try($$select ipd.exec(1, 11, 2)$$) like '42501 sa_authorization_required%', 'cross-org: refused at execution');
select ipd.expect(ipd.fully_present(11) and ipd.fully_present(3), 'auth: nothing changed after refused attempts');

-- ── Protections ────────────────────────────────────────────────────────────
select ipd.expect(ipd.codes(ipd.preview(1, 1)) @> array['SELF'] and not (ipd.preview(1, 1)->>'allowed')::boolean, 'self: preview explains SELF');
select ipd.expect(ipd.exec(1, 1, 3, 'user_management', null, 'Pre-go-live test account clean-up', 'ipd-1@example.test')->>'status' = 'blocked', 'self: execution blocked');
select ipd.expect(ipd.fully_present(1), 'self: own identity intact');
select ipd.expect(ipd.codes(ipd.preview(1, 16)) @> array['PROTECTED_SUPER_ADMIN'], 'protect: Super Admin target protected from a non-Super-Admin');
select ipd.expect(not (ipd.codes(ipd.preview(28, 16)) @> array['PROTECTED_SUPER_ADMIN']), 'protect: Root Access holder is not bound by the Super Admin rule');
select ipd.expect(ipd.codes(ipd.preview(28, 12)) @> array['PROTECTED_ROOT'], 'protect: Root Access holder is protected even from Root');
select ipd.expect(ipd.codes(ipd.preview(1, 5)) @> array['TARGET_MORE_PRIVILEGED'], 'protect: a target with grants the actor lacks is protected (sa_actor_dominates)');
begin;
set local session_replication_role = replica;
update public.users set role_code = 'HQ' where id = ipd.u(11);
set local session_replication_role = origin;
select ipd.expect(ipd.codes(ipd.preview(28, 11)) @> array['LAST_ADMINISTRATOR'], 'protect: the last active HQ Admin of an organization is protected');
rollback;
begin;
set local session_replication_role = replica;
update public.hr_go_live_state set phase = 'live' where organization_id = ipd.o(1);
set local session_replication_role = origin;
select ipd.expect(ipd.codes(ipd.preview(28, 3)) @> array['HR_LIVE'], 'go-live: an HR identity cannot be deleted once HR is live');
select ipd.expect(not (ipd.codes(ipd.preview(28, 18)) @> array['HR_LIVE']), 'go-live: a non-HR account is not subject to the HR lifecycle');
rollback;

-- ── Protected business history ─────────────────────────────────────────────
select ipd.expect(ipd.categories(ipd.preview(28, 6)) @> array['supply_chain'], 'block: Supply Chain order history');
select ipd.expect(ipd.categories(ipd.preview(28, 7)) @> array['payroll'], 'block: payroll history');
select ipd.expect(ipd.categories(ipd.preview(28, 8)) @> array['audit'], 'block: audit_logs actor (mandatory audit evidence, foreign key)');
select ipd.expect(ipd.codes(ipd.preview(28, 9)) @> array['DIRECT_REPORTS'], 'block: manager of other employees');
select ipd.expect(exists (select 1 from jsonb_array_elements(ipd.preview(28, 17)->'blockers') b where b->>'table' = 'sa_access_review_items'),
  'block: another record (access review) points at the person''s assignment');
select ipd.expect(ipd.codes(ipd.preview(28, 22)) @> array['HR_RESET_SNAPSHOT'], 'block: HR records held by a restorable reset snapshot');
select ipd.expect(exists (select 1 from jsonb_array_elements(ipd.preview(28, 27)->'blockers') b where b->>'table' = 'stock_count_sessions' and b->>'foreign_key' = 'false'),
  'block: business attribution without a foreign key (stock_count_sessions.created_by)');
select ipd.expect(ipd.exec(28, 6, 4, 'user_management', null, 'Pre-go-live test account clean-up', 'ipd-6@example.test')->>'status' = 'blocked', 'block: execution refused');
select ipd.expect(ipd.fully_present(6) and (select created_by from public.orders where id = ipd.x(400)) = ipd.u(6),
  'block: identity and order attribution untouched (nothing re-assigned or nulled)');
select ipd.expect((select status = 'blocked' and blockers::text like '%orders%' from public.identity_deletion_requests where request_id = ipd.x(9004)),
  'block: blocked attempt recorded with its blockers');

-- ── Validation ─────────────────────────────────────────────────────────────
select ipd.expect(ipd.try($$select ipd.exec(1, 23, 5, 'user_management', null, 'short')$$) like '22023 identity_deletion_reason_required%', 'validate: reason < 10 characters refused');
select ipd.expect(ipd.try($$select ipd.exec(1, 23, 6, 'user_management', null, 'Pre-go-live test account clean-up', 'someone-else@example.test')$$) like '22023 identity_deletion_confirmation_mismatch%',
  'validate: typed confirmation must identify the target');
create temp table tok as select ipd.preview(1, 23)->>'preview_token' as t;
set session_replication_role = replica;
update public.users set updated_at = updated_at + interval '1 second' where id = ipd.u(23);
set session_replication_role = origin;
select ipd.expect(ipd.exec(1, 23, 7, 'user_management', (select t from tok))->>'status' = 'stale', 'validate: changed identity since preview → stale, nothing deleted');
select ipd.expect(ipd.fully_present(23), 'validate: refused/stale attempts changed nothing');

-- ── Successful permanent deletions ─────────────────────────────────────────
select ipd.expect(ipd.exec(1, 3, 10)->>'status' = 'completed', 'delete: pending employee (User Management entry) completed');
select ipd.expect(not ipd.exists_anywhere(3), 'delete: pending — no login, identity, employment anchor, membership, session or auth identity left');
select ipd.expect((select before_image->'users'->0->>'email' = 'ipd-3@example.test' and before_image->'hr_employees'->0->>'employee_no' = '910003'
                          and before_image->'auth.users'->0 ? 'email' and not (before_image->'auth.users'->0 ? 'encrypted_password')
                   from public.identity_deletion_requests where request_id = ipd.x(9010)),
  'delete: durable before-image (identity, employment, login without credentials)');
select ipd.expect(ipd.exec(1, 4, 11, 'hr', null, 'Pre-go-live test account clean-up', 'ipd-4@example.test')->>'status' = 'completed', 'delete: reset employee (HR entry) completed');
select ipd.expect((select (r->>'replayed')::boolean and r->>'status' = 'completed'
                   from public.identity_deletion_execute(ipd.u(1), ipd.u(4), 'hr', ipd.x(9011), 'x', 'x', 'x') r),
  'retry: the same HR request replays its outcome after the anchor is gone (safe retry of verification)');
select ipd.expect(ipd.try($$select public.identity_deletion_execute(ipd.u(28), ipd.u(4), 'hr', ipd.x(9011), 'x', 'Pre-go-live clean-up', 'x')$$) is not null,
  'retry: another actor cannot replay someone else''s request');
select ipd.expect(not ipd.exists_anywhere(4), 'delete: reset — removed from HR AND User Management AND auth');
select ipd.expect(ipd.exec(28, 5, 12)->>'status' = 'completed', 'delete: completed employee with S&A assignment (Root actor) completed');
select ipd.expect(not ipd.exists_anywhere(5) and not exists (select 1 from public.sa_assignment_scopes where assignment_id = ipd.x(510)),
  'delete: S&A assignment and its scopes removed with the identity');
select ipd.expect(ipd.exec(1, 26, 13, 'hr', null, 'Pre-go-live test account clean-up', 'ipd-26@example.test')->>'status' = 'completed', 'delete: from HR removes the central identity and login too');
select ipd.expect(not ipd.exists_anywhere(26), 'delete: HR entry — nothing left');
select ipd.expect(ipd.try($$select ipd.preview(1, 18, 'hr')$$) like '22023 hr_employee_not_in_organization%', 'non-HR: the HR entry only reaches employment records');
select ipd.expect(ipd.exec(1, 18, 14)->>'status' = 'completed', 'non-HR: account deleted from User Management');
select ipd.expect(not ipd.exists_anywhere(18), 'non-HR: nothing left');
select ipd.expect(ipd.exec(1, 24, 15)->>'status' = 'completed', 'retained: account with only an S&A decision log deleted');
select ipd.expect(not ipd.exists_anywhere(24), 'retained: nothing of the identity left');
select ipd.expect((select count(*) from public.sa_authorization_decisions where actor_id = ipd.u(24)) = 1, 'retained: its decision log row is untouched');
select ipd.expect(ipd.exec(1, 10, 16)->>'status' = 'completed', 'delete: employee who reports to a manager completed');
select ipd.expect(not (ipd.codes(ipd.preview(28, 9)) @> array['DIRECT_REPORTS']), 'delete: the former manager has no direct reports left');
select ipd.expect(ipd.exec(1, 21, 17)->>'status' = 'completed', 'recovery: a login left without a central identity is deleted as well');
select ipd.expect(not exists (select 1 from auth.users where id = ipd.u(21)), 'recovery: the orphan login is gone');

-- ── Idempotency ────────────────────────────────────────────────────────────
select ipd.expect(ipd.exec(1, 25, 50)->>'status' = 'completed', 'idempotency: first request completed');
select ipd.expect((select (r->>'replayed')::boolean and r->>'status' = 'completed'
                   from public.identity_deletion_execute(ipd.u(1), ipd.u(25), 'user_management', ipd.x(9050), 'x', 'x', 'x') r),
  'idempotency: same request id returns the recorded outcome');
select ipd.expect(ipd.try($$select public.identity_deletion_execute(ipd.u(1), ipd.u(23), 'user_management', ipd.x(9050), 'x', 'Pre-go-live clean-up', 'x')$$) like '22023 identity_deletion_request_reused%',
  'idempotency: a request id cannot be reused for another target');
select ipd.expect((select count(*) from public.identity_deletion_requests where target_user_id = ipd.u(25)) = 1, 'idempotency: one record, no duplicate cleanup');

-- ── Failure injection (all-or-nothing) ─────────────────────────────────────
create function ipd.fail_auth() returns trigger language plpgsql as $$ begin raise exception 'simulated auth deletion failure'; end $$;
create trigger ipd_fail_auth before delete on auth.users for each row when (old.id = '0000001d-0000-0000-0000-000000000019') execute function ipd.fail_auth();
select ipd.expect(ipd.try($$select ipd.exec(1, 19, 20)$$) like '%simulated auth deletion failure%', 'failure: auth deletion failure surfaces as an error (no success)');
select ipd.expect(ipd.fully_present(19) and exists (select 1 from public.sa_organization_memberships where user_id = ipd.u(19))
                  and exists (select 1 from auth.identities where user_id = ipd.u(19)),
  'failure: auth failure rolled back the central identity, HR anchor and cleanup');
select ipd.expect(not exists (select 1 from public.identity_deletion_requests where target_user_id = ipd.u(19)), 'failure: no completed/executing record left behind');
drop trigger ipd_fail_auth on auth.users;
create function ipd.fail_cleanup() returns trigger language plpgsql as $$ begin raise exception 'simulated cleanup failure'; end $$;
create trigger ipd_fail_cleanup before delete on public.sa_organization_memberships for each row when (old.user_id = '0000001d-0000-0000-0000-000000000020') execute function ipd.fail_cleanup();
select ipd.expect(ipd.try($$select ipd.exec(1, 20, 21)$$) like '%simulated cleanup failure%', 'failure: database cleanup failure surfaces as an error');
select ipd.expect(ipd.fully_present(20) and exists (select 1 from auth.sessions where user_id = ipd.u(20)), 'failure: cleanup failure left the identity and login whole');
drop trigger ipd_fail_cleanup on public.sa_organization_memberships;
select ipd.expect(ipd.exec(1, 20, 22)->>'status' = 'completed', 'failure: a retry after the fault succeeds');
select ipd.expect(not ipd.exists_anywhere(20), 'failure: retry left nothing behind');

-- ── No recreation ──────────────────────────────────────────────────────────
update public.users set department_id = ipd.x(1), join_date = date '2026-01-06' where organization_id = ipd.o(1);
select ipd.expect(not exists (select 1 from public.hr_employees where user_id in (ipd.u(3), ipd.u(4), ipd.u(5), ipd.u(26), ipd.u(20))),
  'recreate: employment sync triggers do not recreate deleted employees');
select ipd.expect(ipd.try($$insert into public.hr_employees(user_id, organization_id, hire_date, status) values (ipd.u(3), ipd.o(1), current_date, 'active')$$) like '23503%',
  'recreate: an employment record cannot reference a deleted identity');

-- ── Counts ─────────────────────────────────────────────────────────────────
-- deleted with a central identity: 3 4 5 26 18 24 10 25 20 (9); login only: 21
select ipd.expect((select count(*) from public.users) = (select users_n from c0) - 9, 'counts: User Management total down by the 9 deleted identities');
select ipd.expect((select count(*) from auth.users) = (select auth_n from c0) - 10, 'counts: auth accounts down by 10 (incl. the orphan login)');
select ipd.expect((select count(*) from public.hr_employees where organization_id = ipd.o(1) and onboarding_status = 'completed') = (select onboarded from c0) - 3
                  and (select count(*) from public.hr_employees where organization_id = ipd.o(1) and onboarding_status <> 'completed') = (select awaiting from c0) - 5,
  'counts: HR onboarded −3 (5, 24, 10) and awaiting −5 (3, 4, 26, 25, 20)');
select ipd.expect((select count(*) from public.sa_access_change_log) >= (select change_log_n from c0)
                  and (select count(*) from public.sa_authorization_decisions) >= (select decisions_n from c0),
  'retained: S&A change log and decision log were not reduced');

-- ── Record integrity / guards ──────────────────────────────────────────────
select ipd.expect(ipd.try($$update public.identity_deletion_requests set reason = 'tampered reason' where request_id = ipd.x(9010)$$) like '42501 identity_deletion_record_append_only%'
                  and ipd.try($$delete from public.identity_deletion_requests where request_id = ipd.x(9010)$$) like '42501 identity_deletion_record_append_only%',
  'record: append-only');
select public.identity_deletion_record_auth_check(ipd.x(9010), false, 'auth service did not answer');
select ipd.expect((select auth_verification like 'verification_failed%' from public.identity_deletion_requests where request_id = ipd.x(9010)), 'record: failed auth verification recorded');
select public.identity_deletion_record_auth_check(ipd.x(9010), true, null);
select public.identity_deletion_record_auth_check(ipd.x(9010), false, 'later call ignored');
select ipd.expect((select auth_verification from public.identity_deletion_requests where request_id = ipd.x(9010)) = 'verified_absent', 'record: a successful re-verification is final');
select ipd.expect((public.identity_deletion_actor_check(ipd.u(1), 'hr')->>'permission')::boolean
                  and not (public.identity_deletion_actor_check(ipd.u(14), 'hr')->>'permission')::boolean
                  and not (public.identity_deletion_actor_check(ipd.u(13), 'user_management')->>'permission')::boolean
                  and (public.identity_deletion_actor_check(ipd.u(28), 'user_management')->>'permission')::boolean,
  'actor check: offered only to actors holding the required permissions');
set role service_role;
select ipd.expect(ipd.try($$delete from public.users where id = '0000001d-0000-0000-0000-000000000023'$$) like '23503 identity_has_history%',
  'guard: a direct service-role hard delete of an employee is still refused (users_history_delete_guard intact)');
reset role;
select ipd.expect(ipd.fully_present(23), 'guard: identity intact after the refused direct delete');

-- ── HR controlled delete regression (registration delete keeps the identity) ─
select ipd.expect((public.hr_employee_registration_preview(ipd.u(1), ipd.o(1), ipd.u(16))->>'found')::boolean, 'regression: HR registration preview still works');
