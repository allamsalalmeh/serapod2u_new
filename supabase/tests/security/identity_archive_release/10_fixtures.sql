-- Archive & Revoke Access / identifier release (20261217100000). Synthetic fixtures added on top of
set check_function_bodies = off;
-- ../identity_permanent_delete/10_fixtures.sql (people 1-28). DISPOSABLE replica only.
set session_replication_role = replica;

-- 30: completed employee with Supply Chain, warehouse, document, finance, leave, S&A and SoD history, live sessions
-- 31: pending employee   32: reset employee (same-person rehire)   33: completed employee for concurrency
create table if not exists ipd.people_ar(n int, org int, role_code text, onboarding text, label text);
insert into ipd.people_ar values
  (30, 1, 'USER', 'completed', 'Deanna Finance'),
  (31, 1, 'USER', 'pending',   'Pending Former'),
  (32, 1, 'USER', 'reset',     'Returning Rehire'),
  (33, 1, 'USER', 'completed', 'Concurrency Archive');
insert into auth.users(id, email, phone, aud, role, encrypted_password, recovery_token, updated_at)
select ipd.u(n), 'ipd-' || n || '@example.test', '6012000' || lpad(n::text, 4, '0'), 'authenticated', 'authenticated', 'bcrypt-hash', 'rt-' || n, now()
from generate_series(30, 33) n;
insert into auth.identities(id, provider_id, user_id, identity_data, provider)
select gen_random_uuid(), ipd.u(n)::text, ipd.u(n), jsonb_build_object('sub', ipd.u(n)::text, 'email', 'ipd-' || n || '@example.test'), 'email'
from generate_series(30, 33) n;
insert into auth.identities(id, provider_id, user_id, identity_data, provider)
values (gen_random_uuid(), 'google-sub-30', ipd.u(30), '{"sub":"google-sub-30"}'::jsonb, 'google');
insert into auth.sessions(id, user_id) select ('0000002f-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, ipd.u(n) from generate_series(30, 33) n;
insert into auth.refresh_tokens(token, user_id, session_id, revoked)
select 'refresh-' || n, ipd.u(n)::text, ('0000002f-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, false from generate_series(30, 33) n;
insert into auth.refresh_tokens(token, user_id, revoked) values ('legacy-refresh-30', ipd.u(30)::text, false);
insert into auth.one_time_tokens(id, user_id, token_type, token_hash, relates_to)
values (gen_random_uuid(), ipd.u(30), 'recovery_token', 'hash-30', 'ipd-30@example.test');
insert into public.auth_verification_codes(id, purpose, channel, user_id, email_normalized, phone_normalized, code_hash, expires_at, max_attempts)
select gen_random_uuid(), 'password_reset', 'email', ipd.u(30), 'ipd-30@example.test', '+60120000030', 'h', now() + interval '5 minutes', 5
where to_regclass('public.auth_verification_codes') is not null;

insert into public.users(id, email, phone, phone_verified_at, full_name, role_code, organization_id, is_active, principal_type, account_status,
                         account_scope, department_id, employee_no, updated_at)
select ipd.u(n), 'ipd-' || n || '@example.test', '+6012000' || lpad(n::text, 4, '0'), now(), label, role_code, ipd.o(org), true,
       'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal', ipd.x(1), 910000 + n, now()
from ipd.people_ar;
insert into public.hr_employees(id, employee_no, user_id, organization_id, hire_date, status, department_id, employment_type,
                                onboarding_status, onboarding_source, onboarded_at, hire_date_confirmed)
select ipd.x(100 + n), 910000 + n, ipd.u(n), ipd.o(org), date '2026-01-05', 'active', ipd.x(1), 'Full-time', onboarding,
       case when onboarding = 'pending' then null else 'hr_onboarding' end,
       case when onboarding = 'pending' then null else now() - interval '5 days' end, onboarding <> 'pending'
from ipd.people_ar;
insert into public.sa_organization_memberships(id, user_id, organization_id, membership_type, is_primary, status, source)
select ipd.x(200 + n), ipd.u(n), ipd.o(org), 'employee', true, 'active', 'manual' from ipd.people_ar;
insert into public.sa_role_assignments(id, user_id, role_id, membership_id, status, source, assignment_reason)
values (ipd.x(560), ipd.u(30), (select id from public.sa_business_roles where role_key = 'hr-records-officer'), ipd.x(230), 'active', 'manual', 'ipd test'),
       (ipd.x(564), ipd.u(32), (select id from public.sa_business_roles where role_key = 'hr-records-officer'), ipd.x(232), 'active', 'manual', 'ipd test');
insert into public.sa_assignment_scopes(assignment_id, scope_id) values (ipd.x(560), ipd.x(301)), (ipd.x(564), ipd.x(301));
insert into public.sa_sod_violations(rule_id, outcome, user_id)
select (select id from public.sa_sod_rules limit 1), 'allowed_monitor', ipd.u(30) where exists (select 1 from public.sa_sod_rules);

insert into public.telegram_links(user_id, organization_id, telegram_user_id, telegram_chat_id, is_active) values (ipd.u(30), ipd.o(1), 9030, 9030, true);

-- History of 30 (and the existing order of 6)
insert into public.orders(id, order_no, order_type, company_id, buyer_org_id, seller_org_id, created_by, approved_by)
values (ipd.x(410), 'IPD-ORD-30', 'H2M', ipd.o(1), ipd.o(1), ipd.o(1), ipd.u(30), ipd.u(30));
insert into public.stock_movements(id, movement_type, variant_id, quantity_change, quantity_before, quantity_after, company_id, created_by, reference_type)
values (ipd.x(411), 'manual_in', ipd.x(900), 5, 0, 5, ipd.o(1), ipd.u(30), 'manual');
insert into public.documents(id, order_id, doc_type, doc_no, issued_by_org_id, issued_to_org_id, company_id, created_by, acknowledged_by)
values (ipd.x(412), ipd.x(410), 'PO', 'IPD-PO-30', ipd.o(1), ipd.o(1), ipd.o(1), ipd.u(30), ipd.u(30));
insert into public.gl_journals(id, company_id, journal_number, description, journal_type, created_by, posted_by, status)
values (ipd.x(413), ipd.o(1), 'IPD-JV-30', 'test journal', 'ADJUSTMENT', ipd.u(30), ipd.u(30), 'POSTED');
insert into public.hr_leave_types(id, organization_id, code, name) values (ipd.x(414), ipd.o(1), 'AL', 'Annual');
insert into public.hr_leave_requests(id, organization_id, employee_id, leave_type_id, start_date, end_date)
values (ipd.x(415), ipd.o(1), ipd.u(30), ipd.x(414), current_date, current_date);

set session_replication_role = origin;

-- Every history row of 30 and 6, by value (the archive must change none of it).
create or replace function ipd.history_fp() returns text language sql stable as $$
  select md5(concat_ws('|',
    (select jsonb_agg(to_jsonb(o) order by o.id)::text from public.orders o where o.id in (ipd.x(400), ipd.x(410))),
    (select to_jsonb(s)::text from public.stock_movements s where s.id = ipd.x(411)),
    (select to_jsonb(d)::text from public.documents d where d.id = ipd.x(412)),
    (select to_jsonb(g)::text from public.gl_journals g where g.id = ipd.x(413)),
    (select to_jsonb(l)::text from public.hr_leave_requests l where l.id = ipd.x(415)),
    (select to_jsonb(p)::text from public.hr_payroll_run_items p where p.id = ipd.x(405)),
    (select jsonb_agg(to_jsonb(v) order by v.id)::text from public.sa_sod_violations v where v.user_id = ipd.u(30)),
    (select jsonb_agg(jsonb_build_object('id', a.id, 'user', a.user_id, 'role', a.role_id) order by a.id)::text from public.sa_role_assignments a where a.user_id = ipd.u(30)))) $$;
-- The names history screens show (joined through the creator's UUID).
create or replace function ipd.history_names() returns text language sql stable as $$
  select concat_ws('|',
    (select u.full_name from public.orders o join public.users u on u.id = o.created_by where o.id = ipd.x(410)),
    (select u.full_name from public.stock_movements s join public.users u on u.id = s.created_by where s.id = ipd.x(411)),
    (select u.full_name from public.documents d join public.users u on u.id = d.acknowledged_by where d.id = ipd.x(412)),
    (select u.full_name from public.gl_journals g join public.users u on u.id = g.posted_by where g.id = ipd.x(413)),
    (select u.full_name from public.hr_leave_requests l join public.users u on u.id = l.employee_id where l.id = ipd.x(415))) $$;
create or replace function ipd.archive(a int, t int, req int, entry text default 'user_management', release boolean default false,
                                       token text default null, reason text default 'Employee left the company', confirmation text default null,
                                       employment_end text default 'resigned') returns jsonb language sql as $$
  select public.identity_archive_execute(ipd.u(a), ipd.u(t), entry, ipd.x(8000 + req),
    coalesce(token, public.identity_archive_preview(ipd.u(a), ipd.u(t), entry)->>'preview_token'), reason,
    coalesce(confirmation, public.identity_archive_preview(ipd.u(a), ipd.u(t), entry)->>'confirmation_phrase'), release, employment_end) $$;
create or replace function ipd.release(a int, t int, req int, entry text default 'user_management') returns jsonb language sql as $$
  select public.identity_release_identifiers(ipd.u(a), ipd.u(t), entry, ipd.x(8000 + req), 'Identifiers released for reuse') $$;
create or replace function ipd.archive_codes(p jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct b->>'code' order by b->>'code'), '{}') from jsonb_array_elements(p->'blockers') b $$;
-- A "registration": what GoTrue createUser + identity_provision write for a new person.
create or replace function ipd.register(n int, p_email text, p_phone text) returns void language plpgsql as $$
begin
  insert into auth.users(id, email, phone, aud, role, updated_at) values (ipd.u(n), p_email, ltrim(p_phone, '+'), 'authenticated', 'authenticated', now());
  insert into public.users(id, email, phone, phone_verified_at, full_name, role_code, organization_id, is_active, principal_type, account_status, account_scope)
  values (ipd.u(n), p_email, p_phone, case when p_phone is not null then now() end, 'New Person ' || n, 'USER', ipd.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal');
end $$;
select ipd.expect(true, 'archive fixtures loaded');
