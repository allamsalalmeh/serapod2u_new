-- System Logs: order activity trigger, audit_logs hardening, User Activity read model, retention.

create function saf.as_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, false) $$;
create function saf.act(p_entity text) returns setof public.system_log_events language sql as $$
  select * from public.system_log_events where kind = 'activity' and entity_id = p_entity order by occurred_at, received_at, id $$;

-- ---------------------------------------------------------------- order activity: committed outcomes from the database
select saf.as_user(saf.u(6));
set role authenticated;
insert into public.orders(id, order_no, order_type, status, buyer_org_id, seller_org_id, created_by)
  values ('00000000-0000-0000-0009-000000000001', 'ORD-T1', 'H2M', 'draft', saf.o(1), saf.o(4), saf.u(6));
update public.orders set status = 'submitted' where id = '00000000-0000-0000-0009-000000000001';
update public.orders set notes = 'urgent' where id = '00000000-0000-0000-0009-000000000001';
update public.orders set updated_at = now() + interval '1 second' where id = '00000000-0000-0000-0009-000000000001';
reset role;
select saf.expect((select array_agg(action order by occurred_at, id) from saf.act('00000000-0000-0000-0009-000000000001'))
  @> array['order.created','order.submitted','order.updated'] and (select count(*) from saf.act('00000000-0000-0000-0009-000000000001')) = 3,
  'create, submit and edit recorded; bookkeeping-only update not recorded');
select saf.expect((select bool_and(actor_id = saf.u(6) and organization_id = saf.o(1) and outcome = 'success' and source = 'database' and module = 'Supply Chain')
  from saf.act('00000000-0000-0000-0009-000000000001')), 'actor and organization come from the authenticated session (JWT), not the client payload');
select saf.expect((select details->'changed_fields' = '["notes"]'::jsonb from saf.act('00000000-0000-0000-0009-000000000001') where action = 'order.updated'), 'edit lists changed field names only (no values)');
select saf.expect((select details->>'status_from' = 'draft' and details->>'status_to' = 'submitted' from saf.act('00000000-0000-0000-0009-000000000001') where action = 'order.submitted'), 'status transition recorded');
select saf.expect((select environment is null from saf.act('00000000-0000-0000-0009-000000000001') limit 1), 'database activity does not claim an environment it cannot know');

-- A failed save (rolled back) records no activity.
select saf.as_user(saf.u(6));
begin;
  set local role authenticated;
  insert into public.orders(id, order_no, order_type, status, created_by) values ('00000000-0000-0000-0009-000000000002', 'ORD-T2', 'H2M', 'draft', saf.u(6));
rollback;
select saf.expect(not exists (select 1 from saf.act('00000000-0000-0000-0009-000000000002')), 'rolled-back order leaves no activity');

-- Logging failure never changes the business outcome: make activity inserts fail, the order write still succeeds.
alter table public.system_log_events add constraint saf_block_activity check (kind <> 'activity') not valid;
select saf.as_user(saf.u(6));
set role authenticated;
insert into public.orders(id, order_no, order_type, status, created_by) values ('00000000-0000-0000-0009-000000000003', 'ORD-T3', 'H2M', 'submitted', saf.u(6));
reset role;
alter table public.system_log_events drop constraint saf_block_activity;
select saf.expect(exists (select 1 from public.orders where id = '00000000-0000-0000-0009-000000000003'), 'order committed although its activity write failed');
select saf.expect(not exists (select 1 from saf.act('00000000-0000-0000-0009-000000000003')), 'no partial activity row');

-- Service-role / worker change: recorded as system actor.
select set_config('request.jwt.claims', '', false);
update public.orders set status = 'approved' where id = '00000000-0000-0000-0009-000000000001';
select saf.expect((select actor_id is null and actor_kind = 'system' and organization_id = saf.o(4) from saf.act('00000000-0000-0000-0009-000000000001') where action = 'order.approved'), 'system change recorded without inventing a user');

-- ---------------------------------------------------------------- audit_logs: server-only actions cannot be forged
select saf.as_user(saf.u(6));
set role authenticated;
select saf.expect(saf.try($q$insert into public.audit_logs(user_id, action, entity_type, entity_id) values ('00000000-0000-0000-0001-000000000006', 'PASSWORD_RESET', 'user', '00000000-0000-0000-0001-000000000003')$q$) like '%row-level security%', 'browser cannot forge PASSWORD_RESET');
select saf.expect(saf.try($q$insert into public.audit_logs(user_id, action, entity_type, entity_id) values ('00000000-0000-0000-0001-000000000006', 'PASSWORD_RESET_FAILED', 'user', null)$q$) like '%row-level security%', 'browser cannot forge PASSWORD_RESET_FAILED');
select saf.expect(saf.try($q$insert into public.audit_logs(user_id, action, entity_type) values ('00000000-0000-0000-0001-000000000006', 'UPDATE', 'products')$q$) = 'OK', 'generic row-trigger actions still insert');
reset role;
-- Server (service role / owner) writes the real outcomes; the failure action is now accepted by the constraint.
insert into public.audit_logs(user_id, action, entity_type, entity_id, new_values, created_at) values
  (saf.u(1), 'PASSWORD_RESET', 'user', saf.u(3), '{"reset_by_admin":true}', now() - interval '3 minutes'),
  (saf.u(5), 'PASSWORD_RESET_FAILED', 'user', saf.u(3), '{"reset_by_admin":true,"reason":"not_authorized"}', now() - interval '2 minutes'),
  (saf.u(1), 'PASSWORD_RESET_FAILED', 'user', saf.u(4), '{"reset_by_admin":true,"reason":"target_protected"}', now() - interval '1 minutes');

-- ---------------------------------------------------------------- User Activity read model
-- Authoritative S&A change: a real grant through the real function.
select public.sa_assign_role(saf.u(1), saf.u(6), saf.role('system-log-viewer'), saf.o(1), array[saf.s(1)], now(), null, 'Diagnostics rota');
select saf.expect(exists (select 1 from public.system_log_list_activity(null, true, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, 100)
  where source_table = 'sa_access_change_log' and action = 'assignment.granted' and actor_id = saf.u(1) and target_user_id = saf.u(6)), 'Group Policy grant comes from sa_access_change_log');
select saf.expect((select array_agg(outcome order by occurred_at) from public.system_log_list_activity(null, true, now() - interval '1 day', now() + interval '1 minute', null, 'User Management', null, null, 100)
  where source_table = 'audit_logs') = array['success','denied','failure'], 'password reset success / denied / failure from audit_logs');
select saf.expect(not exists (select 1 from public.system_log_list_activity(null, true, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, 100)
  where source_table = 'audit_logs' and action <> 'user.password_reset'), 'generic audit rows (INSERT/UPDATE) are not shown as user activity');
select saf.expect(exists (select 1 from public.system_log_list_activity(null, true, now() - interval '1 day', now() + interval '1 minute', null, 'Supply Chain', null, null, 100) where action = 'order.submitted'), 'order activity listed');
select saf.expect((select count(*) from public.system_log_list_activity(null, true, now() - interval '1 day', now() + interval '1 minute', null, null, 'failure', null, 100)) = 1, 'outcome filter');
-- Scope: org 2 viewer sees nothing from HQ; HQ viewer does not see the org 4 (system) order approval.
select saf.expect(not exists (select 1 from public.system_log_list_activity(array[saf.o(2)], false, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, 100) where organization_id <> saf.o(2)), 'activity scoped by organization');
select saf.expect(not exists (select 1 from public.system_log_list_activity(array[saf.o(1)], false, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, 100) where action = 'order.approved'), 'other organization''s activity hidden');
select saf.expect(not exists (select 1 from public.system_log_list_activity(null, false, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, 100)), 'null scope lists no activity');
select saf.expect((select count(*) from public.system_log_list_activity(null, true, now() - interval '1 day', now() + interval '1 minute', null, null, null, 'ORD-T1', 100)) >= 1, 'search by order number');
-- Keyset pagination across the three sources: pages of 2 see every row once.
do $$
declare v_ct timestamptz; v_ck text; v_seen text[] := '{}'; v_n int; v_total int; v_page int := 0; r record;
begin
  select count(*) into v_total from public.system_log_list_activity(null, true, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, 101);
  loop
    v_n := 0;
    for r in select * from public.system_log_list_activity(null, true, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, 2, v_ct, v_ck) loop
      if r.sort_key = any(v_seen) then raise exception 'ASSERTION FAILED: activity page overlap'; end if;
      v_seen := v_seen || r.sort_key; v_ct := r.occurred_at; v_ck := r.sort_key; v_n := v_n + 1;
    end loop;
    v_page := v_page + 1;
    exit when v_n < 2 or v_page > 100;
  end loop;
  if cardinality(v_seen) <> v_total then raise exception 'ASSERTION FAILED: activity pagination saw % of %', cardinality(v_seen), v_total; end if;
end $$;

-- ---------------------------------------------------------------- retention: diagnostics only
create table saf.sl_audit_before as select (select count(*) from public.audit_logs) a, (select count(*) from public.sa_access_change_log) c;
insert into public.system_log_groups(id, environment, app_build, fingerprint, source, category, severity, message, first_seen_at, last_seen_at)
  values ('00000000-0000-0000-0009-0000000000a1', 'staging', 'old', '9999999999999999', 'server', 'server', 'error', 'old', now() - interval '40 days', now() - interval '40 days');
insert into public.system_log_events(kind, occurred_at, received_at, reference_id, group_id, environment, source, severity, category, message)
  select 'error', now() - interval '40 days', now() - interval '40 days', 'ERR-old-' || n, '00000000-0000-0000-0009-0000000000a1', 'staging', 'server', 'error', 'server', 'old'
  from generate_series(1, 7) n;
insert into public.system_log_events(kind, occurred_at, received_at, reference_id, source, severity, message, outcome, entity_type, entity_id)
  values ('activity', now() - interval '400 days', now() - interval '400 days', 'ACT-old-1', 'database', 'info', 'old order', 'success', 'order', 'x');
select saf.expect((public.system_log_purge_expired(5)->>'deleted_events')::int = 5, 'purge is batch-bounded');
select saf.expect((public.system_log_purge_expired(5000)->>'deleted_events')::int = 2, 'second batch removes the rest');
select saf.expect(not exists (select 1 from public.system_log_groups where id = '00000000-0000-0000-0009-0000000000a1'), 'idle expired group removed');
select saf.expect(exists (select 1 from public.system_log_events where reference_id = 'ACT-old-1'), 'activity (business audit) is not purged');
select saf.expect(exists (select 1 from public.system_log_events where reference_id = 'ERR-g1-0002'), 'recent diagnostics kept');
select saf.expect((select a from saf.sl_audit_before) = (select count(*) from public.audit_logs) and (select c from saf.sl_audit_before) = (select count(*) from public.sa_access_change_log), 'audit_logs and sa_access_change_log untouched by retention');
select saf.expect((public.system_log_status()->>'installed')::boolean and (public.system_log_status()->>'order_activity_trigger')::boolean, 'status reports installed + trigger');
