-- ============================================================================
-- System Logs — diagnostic store, User Activity read model, retention
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database,
-- so nothing in this file has been run against a real database (tested on a throwaway PostgreSQL 17 only:
-- supabase/tests/security/system_logs/run.sh).
--
-- Audit (2026-10-07) of what already exists, and what this migration does with it
--   * No application error store existed. Errors went to console.* only (browser and server), workers logged
--     "[Cron] ... responded 500" lines, and there were no error boundaries. This migration adds ONE diagnostic store:
--       system_log_groups  one row per (organization, environment, build, fingerprint): first/last seen, count
--       system_log_events  stored occurrences (bounded per minute), each with a reference id
--   * Business/security activity is NOT copied. User Activity is read at query time from the authoritative sources:
--       sa_access_change_log  (append-only; Group Policy grant/revoke/restore, identity status changes, lifecycle,
--                              migration modes, access requests) — written by the S&A database functions
--       audit_logs            only the server-written actions PASSWORD_RESET / PASSWORD_RESET_FAILED
--     Orders had NO audit trail at all (the browser writes public.orders directly through PostgREST), so section 4
--     adds a database trigger that records committed order create / submit / status / edit events. A failed save
--     rolls back with its transaction and is therefore never recorded as activity (it can still appear under Errors
--     as a browser report, which is not an audit record).
--   * audit_logs accepted INSERT from any authenticated session (policy audit_insert_system WITH CHECK (true)), so a
--     browser could write a row that looks like a server audit event. Section 5 adds a RESTRICTIVE policy that refuses
--     the server-only action names from API roles (the service role bypasses RLS; the generic row trigger writes
--     INSERT/UPDATE/DELETE and is unaffected). audit_action_valid did not allow PASSWORD_RESET_FAILED, so the
--     reset route's failure/denial audits were rejected; that value is added (existing values unchanged).
--
-- Security
--   * Every table is service-role only (RLS forced, no API-role grants). The application reads through
--     /api/system-logs/*, which authorizes platform.system_logs.view (next migration) and passes the readable
--     organization set into the list/detail functions. Functions are service-role only.
--   * Ingestion never trusts identity from the browser: the API derives actor and organization from the session and
--     passes them here. Lengths, enumerations and JSON size are enforced again by CHECK constraints.
--   * Environment is recorded from the server's runtime configuration ('production','staging','local',
--     'development','test'). Localhost and staging share this database; their rows stay distinguishable.
--
-- Retention: diagnostic events (kind = 'error') and idle groups older than 30 days, in bounded batches, through
--   system_log_purge_expired() called by the existing internal scheduler (/api/cron/system-log-retention).
--   Activity rows written by the order trigger are business audit and are NOT purged (same as audit_logs and
--   sa_access_change_log, whose retention is unchanged).
--
-- Order: independent of Security & Access. Apply before 20261017110000_sa_system_logs_view_permission.sql.
-- Repeat-safe (if not exists / create or replace / drop policy if exists).
-- Rollback:
--   drop trigger if exists system_log_order_activity on public.orders;
--   drop policy if exists audit_logs_server_actions_reserved on public.audit_logs;
--   drop function if exists public.system_log_order_activity(), public.system_log_ingest(jsonb),
--     public.system_log_list_errors(uuid[],boolean,timestamptz,timestamptz,text,uuid,text,text,text,text,integer,timestamptz,uuid),
--     public.system_log_list_activity(uuid[],boolean,timestamptz,timestamptz,uuid,text,text,text,integer,timestamptz,text),
--     public.system_log_event_detail(uuid,uuid[],boolean), public.system_log_purge_expired(integer), public.system_log_status();
--   drop table if exists public.system_log_events, public.system_log_groups;
--   -- audit_action_valid: restore the previous list only if no PASSWORD_RESET_FAILED rows exist.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.system_log_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  environment text not null check (environment in ('production','staging','local','development','test')),
  app_build text not null default 'unknown' check (length(app_build) between 1 and 64),
  fingerprint text not null check (fingerprint ~ '^[a-f0-9]{16,64}$'),
  source text not null check (source in ('browser','server','worker')),
  category text not null check (category in ('network','timeout','authentication','permission','validation','not_found',
                                             'conflict','rate_limited','server','unexpected','cancelled')),
  severity text not null check (severity in ('error','warning','info')),
  module text check (length(module) <= 80),
  action text check (length(action) <= 160),
  code text check (length(code) <= 80),
  http_status integer check (http_status between 0 and 599),
  message text not null check (length(message) <= 1000),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrence_count bigint not null default 1 check (occurrence_count >= 1),
  last_event_id uuid,
  last_reference_id text,
  -- References of occurrences that were counted but not stored (rate-limited), newest last, at most 20.
  recent_references text[] not null default '{}' check (cardinality(recent_references) <= 20)
);
create unique index if not exists system_log_groups_identity_uidx on public.system_log_groups
  (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), environment, app_build, fingerprint);
create index if not exists system_log_groups_last_seen_idx on public.system_log_groups (last_seen_at);
create index if not exists system_log_groups_recent_refs_idx on public.system_log_groups using gin (recent_references);
comment on table public.system_log_groups is
  'System Logs: one row per repeated diagnostic error (organization + environment + build + fingerprint). Sanitized text only.';

create table if not exists public.system_log_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('error','activity')),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  reference_id text not null check (reference_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$'),
  correlation_id text check (correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$'),
  -- Browser report of a failed API call: the X-Request-ID the server returned (links to the server's own report).
  server_reference_id text check (server_reference_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$'),
  group_id uuid references public.system_log_groups(id) on delete set null,
  -- false when this row is the browser side of a failure the server already reported (not counted twice).
  counted boolean not null default true,
  duplicate_of uuid references public.system_log_events(id) on delete set null,
  organization_id uuid,
  actor_id uuid references public.users(id) on delete set null,
  actor_kind text not null default 'user' check (actor_kind in ('user','system')),
  environment text check (environment in ('production','staging','local','development','test')),
  app_build text check (length(app_build) <= 64),
  source text not null check (source in ('browser','server','worker','database')),
  severity text not null check (severity in ('error','warning','info')),
  category text check (category in ('network','timeout','authentication','permission','validation','not_found',
                                    'conflict','rate_limited','server','unexpected','cancelled')),
  code text check (length(code) <= 80),
  module text check (length(module) <= 80),
  action text check (length(action) <= 160),
  page_path text check (length(page_path) <= 300),
  api_route text check (length(api_route) <= 300),
  http_method text check (http_method in ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS')),
  http_status integer check (http_status between 0 and 599),
  message text not null check (length(message) <= 1000),
  stack text check (length(stack) <= 8000),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 16384),
  client jsonb not null default '{}'::jsonb check (jsonb_typeof(client) = 'object' and pg_column_size(client) <= 2048),
  -- Activity rows only.
  outcome text check (outcome in ('success','failure','denied')),
  entity_type text check (length(entity_type) <= 80),
  entity_id text check (length(entity_id) <= 120),
  constraint system_log_events_kind_shape check (
    (kind = 'error' and category is not null and environment is not null and outcome is null)
    or (kind = 'activity' and outcome is not null))
);
create unique index if not exists system_log_events_reference_uidx on public.system_log_events (reference_id);
create index if not exists system_log_events_kind_time_idx on public.system_log_events (kind, occurred_at desc, id desc);
create index if not exists system_log_events_org_time_idx on public.system_log_events (organization_id, kind, occurred_at desc, id desc);
create index if not exists system_log_events_env_time_idx on public.system_log_events (kind, environment, occurred_at desc, id desc);
create index if not exists system_log_events_actor_time_idx on public.system_log_events (actor_id, occurred_at desc) where actor_id is not null;
create index if not exists system_log_events_group_idx on public.system_log_events (group_id, received_at desc) where group_id is not null;
create index if not exists system_log_events_correlation_idx on public.system_log_events (correlation_id) where correlation_id is not null;
create index if not exists system_log_events_server_ref_idx on public.system_log_events (server_reference_id) where server_reference_id is not null;
create index if not exists system_log_events_retention_idx on public.system_log_events (received_at) where kind = 'error';
comment on table public.system_log_events is
  'System Logs: stored diagnostic occurrences (kind=error, 30-day retention) and order activity written by trigger (kind=activity). Sanitized text only; never request bodies, credentials or tokens.';

alter table public.system_log_groups enable row level security;
alter table public.system_log_groups force row level security;
alter table public.system_log_events enable row level security;
alter table public.system_log_events force row level security;
revoke all on table public.system_log_groups from public, anon, authenticated;
revoke all on table public.system_log_events from public, anon, authenticated;
grant select, insert, update, delete on table public.system_log_groups to service_role;
grant select, insert, update, delete on table public.system_log_events to service_role;

-- ---------------------------------------------------------------------------
-- 2. Ingestion (service role; the API has already authenticated, sanitized and fingerprinted)
-- ---------------------------------------------------------------------------
-- Bounds: per group and actor at most 3 stored rows per minute, per group at most 20, per actor at most 30.
-- Beyond that the occurrence is COUNTED on its group and its reference kept in recent_references, but no row is stored.
create or replace function public.system_log_ingest(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_ref text := p->>'reference_id';
  v_actor uuid := nullif(p->>'actor_id', '')::uuid;
  v_org uuid := nullif(p->>'organization_id', '')::uuid;
  v_source text := p->>'source';
  v_env text := p->>'environment';
  v_build text := coalesce(nullif(left(p->>'app_build', 64), ''), 'unknown');
  v_srv_ref text := nullif(p->>'server_reference_id', '');
  -- 'DIG-<digest>': the Next.js error digest both the server render and the browser error boundary see.
  v_corr text := nullif(p->>'correlation_id', '');
  v_occurred timestamptz;
  v_group uuid;
  v_dup public.system_log_events;
  v_existing public.system_log_events;
  v_event uuid;
  v_recent_actor integer;
  v_recent_group integer;
  v_recent_any integer;
begin
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'system_log_payload_invalid' using errcode = '22023'; end if;
  if coalesce(p->>'kind', 'error') <> 'error' then raise exception 'system_log_kind_not_ingestible' using errcode = '22023'; end if;
  if v_source not in ('browser','server','worker') then raise exception 'system_log_source_invalid' using errcode = '22023'; end if;
  if v_ref is null then raise exception 'system_log_reference_required' using errcode = '22023'; end if;

  -- Idempotent retry of the same report (same reference, same actor): return the stored row, count nothing.
  select * into v_existing from public.system_log_events where reference_id = v_ref;
  if found then
    if v_existing.actor_id is not distinct from v_actor and v_existing.source = v_source then
      return jsonb_build_object('stored', true, 'duplicate', true, 'reference_id', v_ref, 'event_id', v_existing.id);
    end if;
    raise exception 'system_log_reference_conflict' using errcode = '23505';
  end if;

  -- Reported time is kept only within 24h before / 5 min after receipt (clock skew, buffered retries).
  v_occurred := coalesce(nullif(p->>'occurred_at', '')::timestamptz, now());
  if v_occurred < now() - interval '24 hours' or v_occurred > now() + interval '5 minutes' then v_occurred := now(); end if;

  -- Browser (or scheduler) side of a failure the server already reported for the same actor: link it, do not count
  -- it twice. Linked only by real identifiers: the X-Request-ID the server returned, or the shared render digest.
  if v_source in ('browser','worker') and (v_srv_ref is not null or v_corr like 'DIG-%') then
    select * into v_dup from public.system_log_events e
    where e.kind = 'error' and e.source = 'server' and e.actor_id is not distinct from v_actor
      and ((v_srv_ref is not null and e.reference_id = v_srv_ref and e.received_at > now() - interval '24 hours')
        or (v_corr like 'DIG-%' and e.correlation_id = v_corr and e.received_at > now() - interval '10 minutes'))
    order by e.received_at desc limit 1;
    if found then
      insert into public.system_log_events(kind, occurred_at, reference_id, correlation_id, server_reference_id, group_id, counted,
        duplicate_of, organization_id, actor_id, actor_kind, environment, app_build, source, severity, category, code, module, action,
        page_path, api_route, http_method, http_status, message, stack, details, client)
      values ('error', v_occurred, v_ref, coalesce(v_dup.correlation_id, v_corr), v_srv_ref, v_dup.group_id, false, v_dup.id, v_org, v_actor,
        case when v_actor is null then 'system' else 'user' end, v_env, v_build, v_source, p->>'severity', p->>'category',
        p->>'code', p->>'module', p->>'action', p->>'page_path', p->>'api_route', p->>'http_method', nullif(p->>'http_status','')::integer,
        p->>'message', p->>'stack', coalesce(p->'details', '{}'::jsonb), coalesce(p->'client', '{}'::jsonb))
      returning id into v_event;
      return jsonb_build_object('stored', true, 'correlated', true, 'reference_id', v_ref, 'event_id', v_event, 'duplicate_of', v_dup.id);
    end if;
  end if;

  insert into public.system_log_groups as g (organization_id, environment, app_build, fingerprint, source, category, severity,
    module, action, code, http_status, message, first_seen_at, last_seen_at, occurrence_count, last_reference_id)
  values (v_org, v_env, v_build, p->>'fingerprint', v_source, p->>'category', p->>'severity', p->>'module', p->>'action',
    p->>'code', nullif(p->>'http_status','')::integer, p->>'message', v_occurred, v_occurred, 1, v_ref)
  on conflict (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), environment, app_build, fingerprint)
  do update set occurrence_count = g.occurrence_count + 1,
    last_seen_at = greatest(g.last_seen_at, excluded.last_seen_at),
    first_seen_at = least(g.first_seen_at, excluded.first_seen_at),
    severity = case when excluded.severity = 'error' then 'error' else g.severity end,
    message = excluded.message, http_status = coalesce(excluded.http_status, g.http_status),
    last_reference_id = excluded.last_reference_id
  returning g.id into v_group;

  select count(*) filter (where e.actor_id is not distinct from v_actor), count(*)
    into v_recent_actor, v_recent_group
  from public.system_log_events e where e.group_id = v_group and e.received_at > now() - interval '1 minute';
  select count(*) into v_recent_any from public.system_log_events e
  where v_actor is not null and e.actor_id = v_actor and e.kind = 'error' and e.received_at > now() - interval '1 minute';

  if v_recent_actor >= 3 or v_recent_group >= 20 or v_recent_any >= 30 then
    update public.system_log_groups
      set recent_references = (select coalesce(array_agg(r order by n), '{}') from (
            select r, n from unnest(recent_references || array[v_ref]) with ordinality as t(r, n) order by n desc limit 20) x)
    where id = v_group;
    return jsonb_build_object('stored', false, 'suppressed', true, 'reference_id', v_ref, 'group_id', v_group);
  end if;

  insert into public.system_log_events(kind, occurred_at, reference_id, correlation_id, server_reference_id, group_id, counted,
    organization_id, actor_id, actor_kind, environment, app_build, source, severity, category, code, module, action,
    page_path, api_route, http_method, http_status, message, stack, details, client)
  values ('error', v_occurred, v_ref, v_corr, v_srv_ref, v_group, true, v_org, v_actor,
    case when v_actor is null then 'system' else 'user' end, v_env, v_build, v_source, p->>'severity', p->>'category',
    p->>'code', p->>'module', p->>'action', p->>'page_path', p->>'api_route', p->>'http_method', nullif(p->>'http_status','')::integer,
    p->>'message', p->>'stack', coalesce(p->'details', '{}'::jsonb), coalesce(p->'client', '{}'::jsonb))
  returning id into v_event;
  update public.system_log_groups set last_event_id = v_event where id = v_group;

  -- Server report arriving after the browser's/scheduler's report of the same failure: that row becomes the linked copy.
  if v_source = 'server' then
    with linked as (
      update public.system_log_events b set counted = false, duplicate_of = v_event,
        correlation_id = coalesce(b.correlation_id, v_corr)
      where b.source in ('browser','worker') and b.counted and b.kind = 'error' and b.actor_id is not distinct from v_actor
        and ((b.server_reference_id = v_ref and b.received_at > now() - interval '24 hours')
          or (v_corr like 'DIG-%' and b.correlation_id = v_corr and b.received_at > now() - interval '10 minutes'))
      returning b.group_id)
    update public.system_log_groups g set occurrence_count = greatest(1, g.occurrence_count - x.n)
    from (select group_id, count(*) n from linked where group_id is not null group by group_id) x
    where g.id = x.group_id;
  end if;

  return jsonb_build_object('stored', true, 'reference_id', v_ref, 'event_id', v_event, 'group_id', v_group);
end $$;
revoke all on function public.system_log_ingest(jsonb) from public, anon, authenticated;
grant execute on function public.system_log_ingest(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Reads (service role; p_all_orgs = true only when S&A answered "every organization")
-- ---------------------------------------------------------------------------
create or replace function public.system_log_list_errors(
  p_orgs uuid[], p_all_orgs boolean, p_from timestamptz, p_to timestamptz, p_environment text, p_actor uuid,
  p_module text, p_severity text, p_category text, p_search text, p_limit integer,
  p_cursor_time timestamptz default null, p_cursor_id uuid default null)
returns table(id uuid, occurred_at timestamptz, reference_id text, organization_id uuid, actor_id uuid, actor_name text,
  actor_email text, environment text, app_build text, source text, severity text, category text, code text, module text,
  action text, page_path text, api_route text, http_method text, http_status integer, message text,
  group_id uuid, occurrence_count bigint, correlation_id text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select e.id, e.occurred_at, e.reference_id, e.organization_id, e.actor_id, u.full_name, u.email, e.environment, e.app_build,
    e.source, e.severity, e.category, e.code, e.module, e.action, e.page_path, e.api_route, e.http_method, e.http_status, e.message,
    e.group_id, g.occurrence_count, e.correlation_id
  from public.system_log_events e
  left join public.system_log_groups g on g.id = e.group_id
  left join public.users u on u.id = e.actor_id
  -- Linked browser copies (counted = false) are listed only when searched by their exact reference, so a reference
  -- quoted by a user is always found while the same failure is not listed twice.
  where e.kind = 'error' and (e.counted or (p_search is not null and e.reference_id = p_search))
    and (p_all_orgs or e.organization_id = any(coalesce(p_orgs, '{}')))
    and e.occurred_at >= p_from and e.occurred_at < p_to
    and (p_environment is null or e.environment = p_environment)
    and (p_actor is null or e.actor_id = p_actor)
    and (p_module is null or e.module = p_module)
    and (p_severity is null or e.severity = p_severity)
    and (p_category is null or e.category = p_category)
    and (p_search is null
         or e.reference_id = p_search or e.correlation_id = p_search or e.server_reference_id = p_search
         or e.message ilike '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
         or (g.id is not null and e.id = g.last_event_id and p_search = any(g.recent_references)))
    and (p_cursor_time is null or (e.occurred_at, e.id) < (p_cursor_time, p_cursor_id))
  order by e.occurred_at desc, e.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 101)
$$;
revoke all on function public.system_log_list_errors(uuid[],boolean,timestamptz,timestamptz,text,uuid,text,text,text,text,integer,timestamptz,uuid) from public, anon, authenticated;
grant execute on function public.system_log_list_errors(uuid[],boolean,timestamptz,timestamptz,text,uuid,text,text,text,text,integer,timestamptz,uuid) to service_role;

-- User Activity: authoritative sources only, merged at read time with keyset pagination on (time, sort_key).
-- Each source is filtered (scope, module, outcome, search) BEFORE its own limit so scoped pages are never short.
create or replace function public.system_log_list_activity(
  p_orgs uuid[], p_all_orgs boolean, p_from timestamptz, p_to timestamptz, p_actor uuid, p_module text, p_outcome text,
  p_search text, p_limit integer, p_cursor_time timestamptz default null, p_cursor_key text default null)
returns table(sort_key text, occurred_at timestamptz, source_table text, organization_id uuid, actor_id uuid, actor_name text,
  actor_email text, module text, action text, outcome text, message text, entity_type text, entity_id text, target_user_id uuid,
  correlation_id text, reference_id text, details jsonb)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 101);
  v_like text := case when p_search is null then null
                      else '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%' end;
begin
  return query
  with sa as (
    select * from (
      select 'sa:' || c.id::text as k, c.occurred_at as t, 'sa_access_change_log'::text as src,
        coalesce(case when (c.details->>'organization_id') ~ '^[0-9a-f-]{36}$' then (c.details->>'organization_id')::uuid end,
                 tu.organization_id, au.organization_id) as org,
        c.actor_id as actor, au.full_name as aname, au.email as aemail,
        case when c.action like 'identity.%' or c.action like 'lifecycle.%' then 'User Management' else 'Security & Access' end as mdl,
        c.action as act, 'success'::text as res,
        left(coalesce(c.reason, ''), 300) as msg, c.entity_type as et, c.entity_id as eid, c.target_user_id as tgt,
        c.correlation_id as corr, null::text as ref,
        jsonb_strip_nulls(jsonb_build_object('target', tu.full_name, 'from', c.details->'from', 'to', c.details->'to',
          'role_id', c.details->'role_id', 'actor_kind', c.actor_kind)) as det
      from public.sa_access_change_log c
      left join public.users au on au.id = c.actor_id
      left join public.users tu on tu.id = c.target_user_id
      where c.occurred_at >= p_from and c.occurred_at < p_to
        and c.action in ('assignment.granted','assignment.revoked','assignment.restored','assignment.removed',
                         'identity.status_changed','identity.reactivated','lifecycle.suspended','lifecycle.leaver',
                         'migration_mode.changed','migration_mode.bulk_changed','access_request.submitted')
        and (p_actor is null or c.actor_id = p_actor)
        and (p_cursor_time is null or (c.occurred_at, 'sa:' || c.id::text) < (p_cursor_time, p_cursor_key))
    ) s
    where (p_all_orgs or s.org = any(coalesce(p_orgs, '{}'))) and (p_module is null or s.mdl = p_module)
      and (p_outcome is null or s.res = p_outcome)
      and (v_like is null or s.act ilike v_like or s.msg ilike v_like or s.eid = p_search or s.corr = p_search)
    order by s.t desc, s.k desc limit v_limit
  ), au as (
    select * from (
      select 'au:' || a.id::text as k, a.created_at as t, 'audit_logs'::text as src,
        coalesce(tu.organization_id, xu.organization_id) as org,
        a.user_id as actor, xu.full_name as aname, xu.email as aemail, 'User Management'::text as mdl,
        'user.password_reset'::text as act,
        case when a.action = 'PASSWORD_RESET' then 'success'
             when a.new_values->>'reason' = 'not_authorized' then 'denied' else 'failure' end as res,
        left(coalesce(a.new_values->>'reason', ''), 300) as msg, 'user'::text as et, a.entity_id::text as eid, a.entity_id as tgt,
        null::text as corr, null::text as ref,
        jsonb_strip_nulls(jsonb_build_object('target', tu.full_name, 'reason', a.new_values->'reason')) as det
      from public.audit_logs a
      left join public.users xu on xu.id = a.user_id
      left join public.users tu on tu.id = a.entity_id
      where a.action in ('PASSWORD_RESET','PASSWORD_RESET_FAILED')
        and a.created_at >= p_from and a.created_at < p_to
        and (p_actor is null or a.user_id = p_actor)
        and (p_cursor_time is null or (a.created_at, 'au:' || a.id::text) < (p_cursor_time, p_cursor_key))
    ) s
    where (p_all_orgs or s.org = any(coalesce(p_orgs, '{}'))) and (p_module is null or s.mdl = p_module)
      and (p_outcome is null or s.res = p_outcome)
      and (v_like is null or s.act ilike v_like or s.msg ilike v_like or s.eid = p_search)
    order by s.t desc, s.k desc limit v_limit
  ), ev as (
    select * from (
      select 'ev:' || e.id::text as k, e.occurred_at as t, 'system_log_events'::text as src, e.organization_id as org,
        e.actor_id as actor, u.full_name as aname, u.email as aemail, e.module as mdl, e.action as act, e.outcome as res,
        e.message as msg, e.entity_type as et, e.entity_id as eid, null::uuid as tgt, e.correlation_id as corr,
        e.reference_id as ref, e.details as det
      from public.system_log_events e left join public.users u on u.id = e.actor_id
      where e.kind = 'activity' and e.occurred_at >= p_from and e.occurred_at < p_to
        and (p_actor is null or e.actor_id = p_actor)
        and (p_cursor_time is null or (e.occurred_at, 'ev:' || e.id::text) < (p_cursor_time, p_cursor_key))
    ) s
    where (p_all_orgs or s.org = any(coalesce(p_orgs, '{}'))) and (p_module is null or s.mdl = p_module)
      and (p_outcome is null or s.res = p_outcome)
      and (v_like is null or s.act ilike v_like or s.msg ilike v_like or s.eid = p_search or s.ref = p_search)
    order by s.t desc, s.k desc limit v_limit
  ), merged as (select * from sa union all select * from au union all select * from ev)
  select m.k, m.t, m.src, m.org, m.actor, m.aname, m.aemail, m.mdl, m.act, m.res, m.msg, m.et, m.eid, m.tgt, m.corr, m.ref, m.det
  from merged m
  order by m.t desc, m.k desc
  limit v_limit;
end $$;
revoke all on function public.system_log_list_activity(uuid[],boolean,timestamptz,timestamptz,uuid,text,text,text,integer,timestamptz,text) from public, anon, authenticated;
grant execute on function public.system_log_list_activity(uuid[],boolean,timestamptz,timestamptz,uuid,text,text,text,integer,timestamptz,text) to service_role;

-- Detail: the event, its group, and related events linked by real ids only (correlation id, server reference,
-- duplicate link, same group). Out-of-scope events are never returned.
create or replace function public.system_log_event_detail(p_id uuid, p_orgs uuid[], p_all_orgs boolean)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  e public.system_log_events;
  g public.system_log_groups;
  v_related jsonb;
  v_actor jsonb;
begin
  select * into e from public.system_log_events where id = p_id;
  if not found or not (p_all_orgs or e.organization_id = any(coalesce(p_orgs, '{}'))) then return null; end if;
  if e.group_id is not null then select * into g from public.system_log_groups where id = e.group_id; end if;
  select jsonb_build_object('id', u.id, 'name', u.full_name, 'email', u.email) into v_actor from public.users u where u.id = e.actor_id;
  select coalesce(jsonb_agg(r order by r->>'occurred_at' desc), '[]'::jsonb) into v_related from (
    select jsonb_build_object('id', x.id, 'occurred_at', x.occurred_at, 'reference_id', x.reference_id, 'source', x.source,
      'kind', x.kind, 'severity', x.severity, 'category', x.category, 'module', x.module, 'action', x.action,
      'api_route', x.api_route, 'http_status', x.http_status, 'message', x.message, 'counted', x.counted,
      'link', case when x.id = e.duplicate_of or x.duplicate_of = e.id then 'same_failure'
                   when e.correlation_id is not null and x.correlation_id = e.correlation_id then 'correlation_id'
                   when x.reference_id = e.server_reference_id or x.server_reference_id = e.reference_id then 'server_reference'
                   else 'same_group' end) as r
    from public.system_log_events x
    where x.id <> e.id and (p_all_orgs or x.organization_id = any(coalesce(p_orgs, '{}')))
      and (x.id = e.duplicate_of or x.duplicate_of = e.id
           or (e.correlation_id is not null and x.correlation_id = e.correlation_id)
           or (e.server_reference_id is not null and x.reference_id = e.server_reference_id)
           or x.server_reference_id = e.reference_id
           or (e.group_id is not null and x.group_id = e.group_id))
    order by x.occurred_at desc limit 20) s;
  return jsonb_build_object(
    'event', to_jsonb(e) - 'group_id',
    'actor', v_actor,
    'group', case when g.id is null then null else jsonb_build_object('id', g.id, 'fingerprint', g.fingerprint,
      'first_seen_at', g.first_seen_at, 'last_seen_at', g.last_seen_at, 'occurrence_count', g.occurrence_count,
      'environment', g.environment, 'app_build', g.app_build, 'recent_references', to_jsonb(g.recent_references)) end,
    'related', v_related);
end $$;
revoke all on function public.system_log_event_detail(uuid,uuid[],boolean) from public, anon, authenticated;
grant execute on function public.system_log_event_detail(uuid,uuid[],boolean) to service_role;

-- Admin state: installed + retention facts (no row content).
create or replace function public.system_log_status()
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('installed', true, 'schema_version', 1, 'retention_days', 30,
    'oldest_error_at', (select min(received_at) from public.system_log_events where kind = 'error'),
    'order_activity_trigger', exists (select 1 from pg_trigger where tgname = 'system_log_order_activity' and not tgisinternal))
$$;
revoke all on function public.system_log_status() from public, anon, authenticated;
grant execute on function public.system_log_status() to service_role;

-- ---------------------------------------------------------------------------
-- 4. Order activity (committed outcomes only; never blocks the order write)
-- ---------------------------------------------------------------------------
create or replace function public.system_log_order_activity()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_actor uuid;
  v_org uuid;
  v_action text;
  v_changed text[];
  v_origin text;
begin
  begin
    v_actor := nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid;
    if tg_op = 'INSERT' then
      v_action := case when new.status::text = 'submitted' then 'order.created_submitted' else 'order.created' end;
    elsif new.status is distinct from old.status then
      v_action := case new.status::text when 'submitted' then 'order.submitted' when 'approved' then 'order.approved'
                    when 'cancelled' then 'order.cancelled' else 'order.status_changed' end;
    else
      -- Edits: a signed-in user changed business fields (timestamps and bookkeeping excluded).
      select coalesce(array_agg(k order by k), '{}') into v_changed
      from jsonb_each(to_jsonb(new)) n(k, v)
      where k not in ('updated_at','updated_by','created_at','base_seq','display_doc_no') and n.v is distinct from to_jsonb(old)->k;
      if v_actor is null or cardinality(v_changed) = 0 then return null; end if;
      v_action := 'order.updated';
    end if;
    select u.organization_id into v_org from public.users u where u.id = v_actor;
    -- Observed request origin (browser-supplied header, informational only — not the environment).
    v_origin := left(substring(coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'origin', '') from '^https?://([^/?#]+)'), 120);
    insert into public.system_log_events(kind, occurred_at, reference_id, organization_id, actor_id, actor_kind, source, severity,
      module, action, message, outcome, entity_type, entity_id, details)
    values ('activity', now(), 'ACT-' || replace(gen_random_uuid()::text, '-', ''), coalesce(v_org, new.seller_org_id, new.buyer_org_id),
      v_actor, case when v_actor is null then 'system' else 'user' end, 'database', 'info', 'Supply Chain', v_action,
      left(coalesce(new.display_doc_no, new.order_no, new.id::text), 120), 'success', 'order', new.id::text,
      jsonb_strip_nulls(jsonb_build_object('order_no', new.order_no, 'display_doc_no', new.display_doc_no,
        'order_type', new.order_type::text, 'status_from', case when tg_op = 'UPDATE' then old.status::text end,
        'status_to', new.status::text, 'changed_fields', case when v_changed is not null then to_jsonb(v_changed) end,
        'request_origin_observed', nullif(v_origin, ''))));
  exception when others then
    raise warning 'system_log_order_activity skipped: %', sqlstate;
  end;
  return null;
end $$;
revoke all on function public.system_log_order_activity() from public, anon, authenticated;

drop trigger if exists system_log_order_activity on public.orders;
create trigger system_log_order_activity after insert or update on public.orders
  for each row execute function public.system_log_order_activity();

-- ---------------------------------------------------------------------------
-- 5. audit_logs: server-only actions cannot be written from an API role; allow the recorded reset failure
-- ---------------------------------------------------------------------------
alter table public.audit_logs drop constraint if exists audit_action_valid;
alter table public.audit_logs add constraint audit_action_valid check (
  action = any (array['INSERT'::text, 'UPDATE'::text, 'DELETE'::text,
                      'PASSWORD_RESET'::text, 'PASSWORD_RESET_FAILED'::text, 'BULK_ENABLE_STOCK_CONFIGURATIONS'::text])) not valid;
alter table public.audit_logs validate constraint audit_action_valid;

drop policy if exists audit_logs_server_actions_reserved on public.audit_logs;
create policy audit_logs_server_actions_reserved on public.audit_logs as restrictive for insert to authenticated, anon
  with check (action not in ('PASSWORD_RESET','PASSWORD_RESET_FAILED','BULK_ENABLE_STOCK_CONFIGURATIONS'));

-- Bounded User Activity reads of the two server-written actions (small partial index).
create index if not exists audit_logs_password_reset_time_idx on public.audit_logs (created_at desc)
  where action in ('PASSWORD_RESET','PASSWORD_RESET_FAILED');

-- ---------------------------------------------------------------------------
-- 6. Retention (diagnostics only; called by /api/cron/system-log-retention)
-- ---------------------------------------------------------------------------
create or replace function public.system_log_purge_expired(p_batch_limit integer default 5000)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_limit integer := least(greatest(coalesce(p_batch_limit, 5000), 1), 10000);
  v_events integer;
  v_groups integer;
begin
  if not pg_try_advisory_xact_lock(hashtext('system_log_purge_expired')) then
    return jsonb_build_object('status', 'locked', 'deleted_events', 0, 'deleted_groups', 0);
  end if;
  with doomed as (
    select id from public.system_log_events
    where kind = 'error' and received_at < now() - interval '30 days'
    order by received_at limit v_limit)
  delete from public.system_log_events e using doomed d where e.id = d.id;
  get diagnostics v_events = row_count;
  with doomed as (
    select g.id from public.system_log_groups g
    where g.last_seen_at < now() - interval '30 days'
      and not exists (select 1 from public.system_log_events e where e.group_id = g.id)
    limit v_limit)
  delete from public.system_log_groups g using doomed d where g.id = d.id;
  get diagnostics v_groups = row_count;
  return jsonb_build_object('status', 'completed', 'deleted_events', v_events, 'deleted_groups', v_groups,
    'more_remaining', v_events >= v_limit or v_groups >= v_limit);
end $$;
revoke all on function public.system_log_purge_expired(integer) from public, anon, authenticated;
grant execute on function public.system_log_purge_expired(integer) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Post-conditions
-- ---------------------------------------------------------------------------
do $post$
begin
  if has_table_privilege('authenticated', 'public.system_log_events', 'SELECT')
     or has_table_privilege('anon', 'public.system_log_events', 'SELECT')
     or has_table_privilege('authenticated', 'public.system_log_groups', 'SELECT')
     or has_table_privilege('authenticated', 'public.system_log_events', 'INSERT') then
    raise exception 'postcondition: system log tables must be service-role only';
  end if;
  if has_function_privilege('authenticated', 'public.system_log_ingest(jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.system_log_ingest(jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.system_log_purge_expired(integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.system_log_event_detail(uuid,uuid[],boolean)', 'EXECUTE') then
    raise exception 'postcondition: system log functions must be service-role only';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'system_log_order_activity' and tgrelid = 'public.orders'::regclass) then
    raise exception 'postcondition: order activity trigger missing';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'audit_logs'
                 and policyname = 'audit_logs_server_actions_reserved' and permissive = 'RESTRICTIVE') then
    raise exception 'postcondition: audit_logs reserved-action policy missing';
  end if;
end $post$;
