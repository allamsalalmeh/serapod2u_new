-- ============================================================================
-- Event Management — database tests (constraints, privileges, atomic RPC)
-- ----------------------------------------------------------------------------
-- DISPOSABLE DATABASE ONLY. NEVER run against staging or production.
--
-- Prerequisites (in order, against an isolated disposable database):
--   1. A schema-only base that contains organizations / brands / users and the
--      identity functions (identity_normalize_email / identity_normalize_phone
--      from 20260929110000_identity_foundation.sql), plus roles anon,
--      authenticated and service_role.
--   2. Apply the three event migrations:
--        psql -d <db> -f 20261007_event01_create_event_tables.sql
--        psql -d <db> -f 20261007_event02_event_qr_functions.sql
--        psql -d <db> -f 20261007_event03_event_constraints_verify.sql
--   3. Run this file:
--        psql -v ON_ERROR_STOP=1 -d <db> -f supabase/tests/security/event-management/event_management.sql
--
-- Concurrency (same-phone) is verified separately with two parallel psql
-- connections; a single SQL file cannot exercise concurrent connections.
--
-- Synthetic fixtures only (uuid ids with recognizable prefixes); no real
-- visitor data.
-- ============================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------
create schema if not exists ev_test;
drop function if exists ev_test.expect(bool, text);
create function ev_test.expect(p_ok boolean, p_label text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAIL [%]', p_label; end if;
  raise notice 'PASS [%]', p_label;
end $$;
drop function if exists ev_test.try_as(text, text);
create function ev_test.try_as(p_role text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('role', p_role, true);
  begin execute p_sql; v := 'OK'; exception when others then v := 'ERR:' || SQLSTATE; end;
  perform set_config('role', 'postgres', true);
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Synthetic fixtures
-- ---------------------------------------------------------------------------
insert into public.organizations (id, org_type_code, org_code, org_name) values
  ('11111111-1111-1111-1111-111111111111','HQ','HQ1','Test HQ'),
  ('22222222-2222-2222-2222-222222222222','HQ','HQ2','Other Org');
insert into public.brands (id, brand_code, brand_name, is_active) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ELLBOW','Ellbow', true);
insert into public.users (id, organization_id, full_name) values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','11111111-1111-1111-1111-111111111111','Staff A'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','11111111-1111-1111-1111-111111111111','Staff B');
insert into public.event_events (id, organization_id, brand_id, name, slug, status, starts_at, ends_at)
values ('dddddddd-dddd-dddd-dddd-dddddddddddd','11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Ellbow Launch','ellbow-launch','active', now() - interval '1 day', now() + interval '1 day');
insert into public.event_staff (event_id, user_id) values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
insert into public.event_qr_tokens (event_id, staff_user_id, kind, token) values
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','staff','stafftok_A'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', null, 'booth','boothtok_1');

-- 1. Direct table access denied for anon/authenticated (Strategy B)
select ev_test.expect(ev_test.try_as('anon','select count(*) from public.event_contacts') like 'ERR:%', 'anon cannot SELECT event_contacts');
select ev_test.expect(ev_test.try_as('authenticated','select count(*) from public.event_events') like 'ERR:%', 'authenticated cannot SELECT event_events');
select ev_test.expect(ev_test.try_as('anon','insert into public.event_events (organization_id,name,slug,status,starts_at,ends_at) values (''11111111-1111-1111-1111-111111111111'',''x'',''x'',''draft'',now(),now())') like 'ERR:%', 'anon cannot INSERT event_events');
select ev_test.expect(ev_test.try_as('service_role','select count(*) from public.event_events') = 'OK', 'service_role can SELECT event_events');

-- 2. RPC EXECUTE denied for anon/authenticated
select ev_test.expect(ev_test.try_as('anon', 'select public.validate_event_qr_token(''stafftok_A'')') like 'ERR:%', 'anon cannot EXECUTE validate_event_qr_token');
select ev_test.expect(ev_test.try_as('authenticated', 'select public.register_event_visitor(''stafftok_A'',''N'',''0111111111'',null,null,null,null,false,null)') like 'ERR:%', 'authenticated cannot EXECUTE register_event_visitor');
select ev_test.expect(ev_test.try_as('service_role', 'select public.validate_event_qr_token(''stafftok_A'')') = 'OK', 'service_role can EXECUTE validate_event_qr_token');

-- 3. Registration happy path + duplicate convergence + fixed attribution
select ev_test.expect((select (public.register_event_visitor('stafftok_A','Amir','0112223333',null,null,null,null,false,'1.2.3.4')->>'status') = 'registered'), 'staff registration succeeds');
select ev_test.expect((select (public.register_event_visitor('boothtok_1','Amir','0112223333',null,null,null,null,false,null)->>'status') = 'duplicate'), 'duplicate via booth returns duplicate');
select ev_test.expect((select count(*) from public.event_contacts where event_id='dddddddd-dddd-dddd-dddd-dddddddddddd') = 1, 'exactly one contact');
select ev_test.expect((select count(*) from public.event_registrations where event_id='dddddddd-dddd-dddd-dddd-dddddddddddd') = 1, 'exactly one registration');
select ev_test.expect((select attributed_staff_user_id from public.event_registrations where event_id='dddddddd-dddd-dddd-dddd-dddddddddddd') = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'attribution stays with staff A (booth resubmit did not overwrite)');

-- 4. Mandatory fields + phone validation (mobile only)
select ev_test.expect((select (public.register_event_visitor('boothtok_1',null,'0113334444',null,null,null,null,false,null)->>'status') = 'name_required'), 'name required');
select ev_test.expect((select (public.register_event_visitor('boothtok_1','Bad Phone','abc',null,null,null,null,false,null)->>'status') = 'phone_invalid'), 'phone invalid');
select ev_test.expect((select (public.register_event_visitor('boothtok_1','Landline','0312345678',null,null,null,null,false,null)->>'status') = 'phone_invalid'), 'landline rejected (not mobile)');

-- 5. Booth attribution is NULL
select ev_test.expect((select (public.register_event_visitor('boothtok_1','Bella','0115556666',null,null,null,null,false,null)->>'status') = 'registered'), 'booth-only registration succeeds');
select ev_test.expect((select attributed_staff_user_id from public.event_registrations r join public.event_contacts c on c.id=r.contact_id where c.phone_normalized='+60115556666') is null, 'booth registration attributed to NULL');

-- 6. One ACTIVE booth QR per event (partial unique index)
select ev_test.expect(ev_test.try_as('service_role', 'insert into public.event_qr_tokens (event_id, staff_user_id, kind) values (''dddddddd-dddd-dddd-dddd-dddddddddddd'', null, ''booth'')') like 'ERR:%', 'second active booth QR for same event rejected');

-- 7. Revoked token rejected + historical attribution preserved
update public.event_qr_tokens set status='revoked' where token='boothtok_1';
select ev_test.expect((select (public.register_event_visitor('boothtok_1','C','0117778888',null,null,null,null,false,null)->>'status') = 'revoked'), 'revoked token rejected');
select ev_test.expect((select (public.validate_event_qr_token('boothtok_1')->>'status') = 'revoked'), 'validate returns revoked');
select ev_test.expect((select attributed_staff_user_id from public.event_registrations r join public.event_contacts c on c.id=r.contact_id where c.phone_normalized='+60115556666') is null, 'booth attribution preserved after token revocation');

-- 8. One ACTIVE staff QR per (event, staff)
select ev_test.expect(ev_test.try_as('service_role', 'insert into public.event_qr_tokens (event_id, staff_user_id, kind) values (''dddddddd-dddd-dddd-dddd-dddddddddddd'',''bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'',''staff'')') like 'ERR:%', 'second active staff QR for same staff rejected');

-- 9. Composite FK: registration cannot reference a token of another event
insert into public.event_events (id, organization_id, name, slug, status, starts_at, ends_at)
values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','11111111-1111-1111-1111-111111111111','Other Event','other','active', now() - interval '1 day', now() + interval '1 day');
insert into public.event_qr_tokens (event_id, staff_user_id, kind, token) values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', null,'booth','other_booth');
select ev_test.expect(ev_test.try_as('service_role', 'insert into public.event_registrations (event_id, contact_id, qr_token_id) values (''dddddddd-dddd-dddd-dddd-dddddddddddd'', (select id from public.event_contacts limit 1), (select id from public.event_qr_tokens where token=''other_booth''))') like 'ERR:%', 'cross-event token registration rejected (composite FK)');

-- 10. NOT NULL name / phone
select ev_test.expect(ev_test.try_as('service_role', 'insert into public.event_contacts (event_id, name, phone_normalized) values (''dddddddd-dddd-dddd-dddd-dddddddddddd'', null, ''+60123456789'')') like 'ERR:%', 'null name rejected');
select ev_test.expect(ev_test.try_as('service_role', 'insert into public.event_contacts (event_id, name, phone_normalized) values (''dddddddd-dddd-dddd-dddd-dddddddddddd'', ''X'', null)') like 'ERR:%', 'null phone rejected');

-- 11. UNIQUE (event_id, phone_normalized)
insert into public.event_contacts (event_id, name, phone_normalized) values ('dddddddd-dddd-dddd-dddd-dddddddddddd','X','+60199999999');
select ev_test.expect(ev_test.try_as('service_role', 'insert into public.event_contacts (event_id, name, phone_normalized) values (''dddddddd-dddd-dddd-dddd-dddddddddddd'', ''Y'', ''+60199999999'')') like 'ERR:%', 'duplicate phone in same event rejected');

\echo '=== EVENT MANAGEMENT DB TESTS PASSED ==='


