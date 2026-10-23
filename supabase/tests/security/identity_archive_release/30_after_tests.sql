-- After 20261217100000. Actors: 1 = explicit platform.identity.delete + hr.employee.delete (o1), 28 = Root Access.
create temp table h0 as select ipd.history_fp() as fp, ipd.history_names() as names;

-- ── Authorization / protections ────────────────────────────────────────────
select ipd.expect(ipd.try($$select public.identity_archive_preview(ipd.u(13), ipd.u(30), 'hr')$$) like '42501 sa_authorization_required%', 'auth: hr.employee.manage cannot archive');
select ipd.expect(ipd.try($$select public.identity_archive_preview(ipd.u(14), ipd.u(30), 'hr')$$) like '42501 sa_authorization_required%', 'auth: hr.employee.delete alone cannot archive');
select ipd.expect(ipd.try($$select public.identity_archive_preview(ipd.u(2), ipd.u(30), 'user_management')$$) like '42501 sa_authorization_required%', 'auth: legacy Super Admin without a grant cannot archive');
select ipd.expect(ipd.try($$select public.identity_archive_preview(ipd.u(1), ipd.u(11), 'user_management')$$) like '42501 sa_authorization_required%', 'auth: cross-organization archive refused');
select ipd.expect(not has_function_privilege('authenticated', 'public.identity_archive_execute(uuid,uuid,text,uuid,text,text,text,boolean,text)', 'execute')
                  and not has_function_privilege('authenticated', 'public.identity_release_identifiers(uuid,uuid,text,uuid,text)', 'execute')
                  and not has_table_privilege('service_role', 'public.identity_identifier_releases', 'select'), 'auth: server-only surface, restricted release snapshot');
select ipd.expect(ipd.archive_codes(public.identity_archive_preview(ipd.u(1), ipd.u(1), 'user_management')) @> array['SELF'], 'protect: self-archive blocked');
select ipd.expect(ipd.archive(1, 1, 1)->>'status' = 'blocked', 'protect: self-archive refused at execution');
select ipd.expect(ipd.archive_codes(public.identity_archive_preview(ipd.u(28), ipd.u(12), 'user_management')) @> array['PROTECTED_ROOT'], 'protect: Root Access holder');
select ipd.expect(ipd.archive_codes(public.identity_archive_preview(ipd.u(1), ipd.u(16), 'user_management')) @> array['PROTECTED_SUPER_ADMIN'], 'protect: Super Admin from a non-Super-Admin');
select ipd.expect(ipd.archive_codes(public.identity_archive_preview(ipd.u(1), ipd.u(30), 'user_management')) @> array['TARGET_MORE_PRIVILEGED'], 'protect: target with access the actor lacks');
select ipd.expect((public.identity_archive_preview(ipd.u(28), ipd.u(30), 'user_management')->>'archive_allowed')::boolean, 'preview: Root may archive 30');
select ipd.expect(not (public.identity_archive_preview(ipd.u(28), ipd.u(30), 'user_management')->>'release_allowed')::boolean is false
                  and (select count(*) from jsonb_array_elements(public.identity_archive_preview(ipd.u(28), ipd.u(30), 'user_management')->'warnings') w
                       where w->>'code' in ('ACCESS_REVOKED','SESSIONS_REVOKED')) = 2, 'preview: explains that access and sessions will be revoked');
select ipd.expect(ipd.try($$select ipd.archive(28, 30, 2, 'user_management', false, null, 'short')$$) like '22023 identity_archive_reason_required%', 'validate: reason');
select ipd.expect(ipd.try($$select ipd.archive(28, 30, 3, 'user_management', false, null, 'Employee left the company', 'nobody@example.test')$$) like '22023 identity_deletion_confirmation_mismatch%', 'validate: typed confirmation');
select ipd.expect(ipd.try($$select ipd.archive(28, 30, 4, 'user_management', false, null, 'Employee left the company', null, 'retired')$$) like '22023 identity_archive_employment_end_invalid%', 'validate: employment end');
select ipd.expect((select account_status from public.users where id = ipd.u(30)) = 'ACTIVE', 'validate: refused attempts changed nothing');

-- ── Hard delete is offered first and stays protected ───────────────────────
select ipd.expect(not (public.identity_deletion_preview(ipd.u(28), ipd.u(30), 'user_management')->>'allowed')::boolean,
  'delete: 30 has protected history → permanent deletion blocked (archive is the alternative, never automatic)');

-- ── Archive & Revoke Access (30: Supply Chain, warehouse, documents, finance, leave, S&A, SoD) ──
select ipd.expect(ipd.archive(28, 30, 10)->>'status' = 'completed', 'archive: completed');
select ipd.expect((select account_status = 'ARCHIVED' and is_active is false and id = ipd.u(30) and full_name = 'Deanna Finance' and employee_no = 910030
                   from public.users where id = ipd.u(30)), 'archive: UUID, name and employee number unchanged; account ARCHIVED');
select ipd.expect((select fp from h0) = ipd.history_fp(), 'history: orders, stock movement, document, GL journal, leave, payroll, SoD and assignment rows unchanged');
select ipd.expect((select names from h0) = ipd.history_names() and ipd.history_names() like 'Deanna Finance|Deanna Finance|%', 'history: every record still resolves to "Deanna Finance"');
select ipd.expect(not exists (select 1 from auth.sessions where user_id = ipd.u(30)) and not exists (select 1 from auth.refresh_tokens where user_id = ipd.u(30)::text)
                  and not exists (select 1 from auth.one_time_tokens where user_id = ipd.u(30)), 'login: sessions, refresh tokens (incl. session-less) and one-time tokens revoked');
select ipd.expect(not exists (select 1 from public.telegram_links where user_id = ipd.u(30) and is_active), 'operations: Telegram ordering switched off for the former user');
select ipd.expect((select banned_until > now() + interval '50 years' and recovery_token = '' from auth.users where id = ipd.u(30)), 'login: banned in the same transaction; recovery token cleared');
select ipd.expect(not exists (select 1 from public.auth_verification_codes where user_id = ipd.u(30) and used_at is null and invalidated_at is null),
  'login: unused application OTP / password-reset codes invalidated');
select ipd.expect((public.sa_evaluate_permission(ipd.u(30), 'hr.employee.view', jsonb_build_object('organization_id', ipd.o(1)), true)->>'decision') = 'DENY',
  'S&A: no effective permission (ACCOUNT_INACTIVE)');
select ipd.expect((select status from public.sa_role_assignments where id = ipd.x(560)) = 'revoked'
                  and (select effective_until is not null from public.sa_role_assignments where id = ipd.x(560))
                  and not exists (select 1 from public.sa_organization_memberships where user_id = ipd.u(30) and status in ('active','suspended')),
  'S&A: assignment revoked with an end date (evidence kept, not deleted); memberships ended');
select ipd.expect((select status = 'resigned' and end_date = current_date and onboarding_status = 'completed' from public.hr_employees where user_id = ipd.u(30)),
  'HR: employment ended (resigned, end date) — onboarding state is NOT used to mean "former"');
select ipd.expect(public.identity_resolve('ipd-30@example.test', null)->>'outcome' = 'IDENTITY_ARCHIVED', 'identifiers: still reserved until released');
select ipd.expect(ipd.archive(28, 30, 10)->>'replayed' = 'true', 'idempotency: the same request replays');
select ipd.expect(ipd.try($$select ipd.archive(28, 31, 10)$$) like '22023 identity_archive_request_reused%', 'idempotency: a request id cannot be reused for another person');
select ipd.expect(ipd.archive_codes(public.identity_archive_preview(ipd.u(28), ipd.u(30), 'user_management')) = '{}'
                  and not (public.identity_archive_preview(ipd.u(28), ipd.u(30), 'user_management')->>'archive_allowed')::boolean,
  'idempotency: an archived identity cannot be archived again');
select ipd.expect((select count(*) from public.identity_lifecycle_actions where target_user_id = ipd.u(30) and action = 'archive' and status = 'completed') = 1,
  'record: one completed archive record');

-- ── Release email and phone ────────────────────────────────────────────────
select ipd.expect(ipd.release(28, 30, 20)->>'status' = 'completed', 'release: completed');
select ipd.expect((select email = public.identity_released_placeholder_email(ipd.u(30)) and phone is null and full_name = 'Deanna Finance' from public.users where id = ipd.u(30)),
  'release: identity row keeps its name; email is a non-deliverable placeholder, phone cleared');
select ipd.expect((select email = public.identity_released_placeholder_email(ipd.u(30)) and phone is null and encrypted_password = '' from auth.users where id = ipd.u(30))
                  and not exists (select 1 from auth.identities where user_id = ipd.u(30)),
  'release: login has no usable email, phone, password or provider identity (Google etc.)');
select ipd.expect((select email = 'ipd-30@example.test' and phone = '+60120000030' from identity_identifier_releases where user_id = ipd.u(30) and restored_at is null),
  'release: original values kept only in the restricted snapshot');
select ipd.expect(public.identity_resolve('ipd-30@example.test', null)->>'outcome' = 'IDENTITY_PREVIOUSLY_RELEASED'
                  and public.identity_resolve('ipd-30@example.test', null)->'released_user_ids' ? ipd.u(30)::text
                  and public.identity_resolve(null, '+60120000030')->>'outcome' = 'IDENTITY_PREVIOUSLY_RELEASED',
  'resolver: a released email/phone is flagged (new person needs a decision; never matched to the archived UUID)');
select ipd.expect(ipd.archive_codes(ipd.release(28, 30, 21)) @> array['ALREADY_RELEASED'], 'release: a second release is refused (ALREADY_RELEASED)');
select ipd.expect(ipd.archive_codes(ipd.release(28, 33, 22)) @> array['NOT_ARCHIVED'], 'release: only an archived identity can be released (NOT_ARCHIVED)');

-- ── A different person registers with the released email ──────────────────
select ipd.register(40, 'ipd-30@example.test', null);
select ipd.expect(public.identity_resolve('ipd-30@example.test', null)->>'user_id' = ipd.u(40)::text, 'reuse: the email now resolves to the NEW identity');
select ipd.expect(ipd.u(40) <> ipd.u(30) and (select created_by from public.orders where id = ipd.x(410)) = ipd.u(30)
                  and (select fp from h0) = ipd.history_fp() and (select names from h0) = ipd.history_names(),
  'reuse: new UUID; old transactions still point to — and show — the archived person');
select ipd.expect(not exists (select 1 from public.sa_role_assignments where user_id = ipd.u(40) and role_id = (select id from public.sa_business_roles where role_key = 'hr-records-officer'))
                  and (select employee_no from public.hr_employees where user_id = ipd.u(40)) is distinct from 910030
                  and not exists (select 1 from public.hr_leave_requests where employee_id = ipd.u(40)),
  'reuse: the new person inherits no grants, employee number or HR history');
select ipd.expect(ipd.try($$select public.identity_set_account_status(ipd.u(28), ipd.u(30), 'ACTIVE', 'Returning employee')$$) like '23505 identity_released_identifier_taken%',
  'reuse: the archived account cannot be revived onto an email someone else now owns');
select ipd.expect((select account_status from public.users where id = ipd.u(30)) = 'ARCHIVED', 'reuse: it stays archived');

-- ── Pending / reset employees, released phone reused, HR entry ──────────────
select ipd.expect(ipd.archive(1, 31, 30, 'hr', true)->>'status' = 'completed', 'archive: pending employee from HR with release');
select ipd.expect((select onboarding_status = 'pending' and status = 'resigned' from public.hr_employees where user_id = ipd.u(31))
                  and (select account_status from public.users where id = ipd.u(31)) = 'ARCHIVED',
  'archive: pending employee is a former employee by account state — not by onboarding state');
select ipd.register(41, 'someone-else-41@example.test', '+60120000031');
select ipd.expect(public.identity_resolve(null, '+60120000031')->>'user_id' = ipd.u(41)::text and ipd.u(41) <> ipd.u(31), 'reuse: released phone registered by a different person (new UUID)');
select ipd.expect(ipd.archive(1, 4, 31, 'hr')->>'status' = 'completed', 'archive: reset employee from HR');

-- ── Same person returns (rehire = reactivation, not a new identity) ────────
select ipd.expect(ipd.archive(28, 32, 40, 'user_management', true)->>'status' = 'completed', 'rehire: archived with release');
select ipd.expect(public.identity_resolve('ipd-32@example.test', null)->>'outcome' = 'IDENTITY_PREVIOUSLY_RELEASED', 'rehire: provisioning would be stopped for a decision, not silently create a duplicate');
select public.identity_set_account_status(ipd.u(28), ipd.u(32), 'ACTIVE', 'Rehired: same person returning');
select ipd.expect((select account_status = 'ACTIVE' and email = 'ipd-32@example.test' and phone = '+60120000032' from public.users where id = ipd.u(32))
                  and (select banned_until is null and email = 'ipd-32@example.test' from auth.users where id = ipd.u(32))
                  and public.identity_resolve('ipd-32@example.test', null)->>'user_id' = ipd.u(32)::text,
  'rehire: same UUID back with its identifiers; ban lifted');
select ipd.expect((select status from public.sa_role_assignments where id = ipd.x(564)) = 'revoked',
  'rehire: previously granted access is NOT restored (must be granted again)');

-- ── Hard delete still works; archived history blocks it ────────────────────
select ipd.expect(ipd.exec(1, 3, 90)->>'status' = 'completed', 'delete: eligible pending identity still permanently deleted');
select ipd.expect(exists (select 1 from jsonb_array_elements(public.identity_deletion_preview(ipd.u(28), ipd.u(31), 'user_management')->'blockers') b
                          where b->>'table' = 'identity_identifier_releases'), 'delete: a released identity keeps its release record (cannot be hard-deleted)');

-- ── Existing operations unaffected ─────────────────────────────────────────
insert into public.orders(id, order_no, order_type, company_id, buyer_org_id, seller_org_id, created_by)
values (ipd.x(420), 'IPD-ORD-NEW', 'H2M', ipd.o(1), ipd.o(1), ipd.o(1), ipd.u(28));
select ipd.expect(exists (select 1 from public.orders where id = ipd.x(420)), 'operations: a new order by an active user still works');
select public.identity_set_account_status(ipd.u(28), ipd.u(9), 'SUSPENDED', 'temporary hold');
select public.identity_set_account_status(ipd.u(28), ipd.u(9), 'ACTIVE', 'hold lifted');
select ipd.expect((select account_status from public.users where id = ipd.u(9)) = 'ACTIVE', 'regression: suspend / reactivate an active account unchanged');
select ipd.expect(ipd.try($$update public.identity_lifecycle_actions set reason = 'x' where request_id = ipd.x(8010)$$) is not null
                  and ipd.try($$delete from public.identity_identifier_releases where user_id = ipd.u(30)$$) is not null, 'record: append-only');
