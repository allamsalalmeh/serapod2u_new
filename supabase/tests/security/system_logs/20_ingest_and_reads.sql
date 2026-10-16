-- System Logs: ingestion, grouping, rate limits, correlation, environment/org separation, reads, privileges.
-- Isolated fixtures only (saf.u / saf.o from sa_group_policies/10_fixtures.sql).

-- Helper: a valid error report with overrides.
create function saf.ev(p_over jsonb) returns jsonb language sql as $$
  select jsonb_build_object('kind','error','source','browser','environment','staging','app_build','b1',
    'fingerprint','0123456789abcdef','category','unexpected','severity','error','module','Orders','action','order.save',
    'message','Failed to save order','actor_id', saf.u(6)::text,'organization_id', saf.o(1)::text,
    'reference_id','ERR-' || replace(gen_random_uuid()::text,'-',''),'occurred_at', now()::text) || p_over $$;
create function saf.ing(p_over jsonb) returns jsonb language sql as $$ select public.system_log_ingest(saf.ev(p_over)) $$;
create function saf.grp(p_fp text) returns public.system_log_groups language sql as $$ select * from public.system_log_groups where fingerprint = p_fp order by first_seen_at limit 1 $$;

-- ---------------------------------------------------------------- privileges
select saf.expect(not has_table_privilege('authenticated','public.system_log_events','SELECT') and not has_table_privilege('anon','public.system_log_events','SELECT'), 'API roles cannot read events');
select saf.expect(not has_table_privilege('authenticated','public.system_log_groups','SELECT'), 'API roles cannot read groups');
select saf.expect(not has_table_privilege('authenticated','public.system_log_events','INSERT') and not has_table_privilege('authenticated','public.system_log_events','UPDATE'), 'API roles cannot write events (no forged activity)');
select saf.expect(not has_function_privilege('authenticated','public.system_log_ingest(jsonb)','EXECUTE') and not has_function_privilege('anon','public.system_log_ingest(jsonb)','EXECUTE'), 'API roles cannot call ingest');
select saf.expect(not has_function_privilege('authenticated','public.system_log_list_errors(uuid[],boolean,timestamptz,timestamptz,text,uuid,text,text,text,text,integer,timestamptz,uuid)','EXECUTE'), 'API roles cannot list errors');
select saf.expect(not has_function_privilege('authenticated','public.system_log_list_activity(uuid[],boolean,timestamptz,timestamptz,uuid,text,text,text,integer,timestamptz,text)','EXECUTE'), 'API roles cannot list activity');
select saf.expect(has_function_privilege('service_role','public.system_log_ingest(jsonb)','EXECUTE'), 'service role may ingest');
set role authenticated;
select saf.expect(saf.try('select count(*) from public.system_log_events') like '%permission denied%', 'authenticated SELECT is refused at runtime');
select saf.expect(saf.try($q$select public.system_log_ingest('{}'::jsonb)$q$) like '%permission denied%', 'authenticated ingest is refused at runtime');
reset role;

-- ---------------------------------------------------------------- grouping + rate limit
select saf.ing('{"fingerprint":"aaaaaaaaaaaaaaaa","reference_id":"ERR-g1-0001"}');
select saf.expect((saf.grp('aaaaaaaaaaaaaaaa')).occurrence_count = 1, 'first occurrence creates a group');
select saf.ing('{"fingerprint":"aaaaaaaaaaaaaaaa","reference_id":"ERR-g1-0002"}');
select saf.ing('{"fingerprint":"aaaaaaaaaaaaaaaa","reference_id":"ERR-g1-0003"}');
select saf.expect((select count(*) from public.system_log_events where group_id = (saf.grp('aaaaaaaaaaaaaaaa')).id) = 3, 'three occurrences stored');
select saf.expect((saf.ing('{"fingerprint":"aaaaaaaaaaaaaaaa","reference_id":"ERR-g1-0004"}')->>'suppressed') = 'true', 'fourth within a minute (same actor) is suppressed');
select saf.expect((saf.grp('aaaaaaaaaaaaaaaa')).occurrence_count = 4, 'suppressed occurrence is still counted');
select saf.expect((select count(*) from public.system_log_events where group_id = (saf.grp('aaaaaaaaaaaaaaaa')).id) = 3, 'suppressed occurrence stores no row');
select saf.expect('ERR-g1-0004' = any((saf.grp('aaaaaaaaaaaaaaaa')).recent_references), 'suppressed reference kept on the group');
-- Another actor in the same org still gets stored rows (per-actor bound).
select saf.ing(jsonb_build_object('fingerprint','aaaaaaaaaaaaaaaa','reference_id','ERR-g1-0005','actor_id',saf.u(7)::text));
select saf.expect(exists (select 1 from public.system_log_events where reference_id = 'ERR-g1-0005'), 'other actor not throttled by the first actor');
-- recent_references capped at 20.
do $$ begin for i in 1..25 loop perform saf.ing(jsonb_build_object('fingerprint','aaaaaaaaaaaaaaaa','reference_id','ERR-cap-' || lpad(i::text, 4, '0'))); end loop; end $$;
select saf.expect(cardinality((saf.grp('aaaaaaaaaaaaaaaa')).recent_references) = 20, 'recent references bounded to 20');
select saf.expect('ERR-cap-0025' = any((saf.grp('aaaaaaaaaaaaaaaa')).recent_references) and not ('ERR-cap-0001' = any((saf.grp('aaaaaaaaaaaaaaaa')).recent_references)), 'newest references kept');

-- Idempotent retry and reference conflicts.
select saf.expect((saf.ing('{"fingerprint":"aaaaaaaaaaaaaaaa","reference_id":"ERR-g1-0001"}')->>'duplicate') = 'true', 'same reference + actor is an idempotent retry');
select saf.expect((saf.grp('aaaaaaaaaaaaaaaa')).occurrence_count = 30, 'retry counted nothing (4 + 1 + 25)');
select saf.expect(saf.try($q$select saf.ing(jsonb_build_object('reference_id','ERR-g1-0001','actor_id',saf.u(3)::text))$q$) like '%system_log_reference_conflict%', 'another actor cannot reuse a reference');

-- ---------------------------------------------------------------- environment / organization / build separation
select saf.ing('{"fingerprint":"bbbbbbbbbbbbbbbb","reference_id":"ERR-env-stg","environment":"staging"}');
select saf.ing('{"fingerprint":"bbbbbbbbbbbbbbbb","reference_id":"ERR-env-loc","environment":"local"}');
select saf.ing(jsonb_build_object('fingerprint','bbbbbbbbbbbbbbbb','reference_id','ERR-env-org2','environment','staging','organization_id',saf.o(2)::text,'actor_id',saf.u(4)::text));
select saf.ing('{"fingerprint":"bbbbbbbbbbbbbbbb","reference_id":"ERR-env-b2","environment":"staging","app_build":"b2"}');
select saf.expect((select count(*) from public.system_log_groups where fingerprint = 'bbbbbbbbbbbbbbbb') = 4, 'local vs staging, org 1 vs org 2, build b1 vs b2 are separate groups');
select saf.expect((select environment from public.system_log_events where reference_id = 'ERR-env-loc') = 'local', 'environment recorded as supplied by the server');
select saf.expect(saf.try($q$select saf.ing('{"fingerprint":"cccccccccccccccc","environment":"prod"}')$q$) <> 'OK', 'unknown environment refused');

-- ---------------------------------------------------------------- validation (defence in depth behind the API)
select saf.expect(saf.try($q$select saf.ing(jsonb_build_object('message', repeat('x', 1001)))$q$) like '%violates check constraint%', 'oversized message refused');
select saf.expect(saf.try($q$select saf.ing(jsonb_build_object('stack', repeat('x', 8001)))$q$) like '%violates check constraint%', 'oversized stack refused');
select saf.expect(saf.try($q$select saf.ing('{"category":"bogus"}')$q$) like '%violates check constraint%', 'unknown category refused');
select saf.expect(saf.try($q$select saf.ing('{"fingerprint":"NOT-HEX"}')$q$) like '%violates check constraint%', 'malformed fingerprint refused');
select saf.expect(saf.try($q$select saf.ing('{"reference_id":"bad ref!"}')$q$) like '%violates check constraint%', 'malformed reference refused');
select saf.expect(saf.try($q$select saf.ing('{"kind":"activity"}')$q$) like '%system_log_kind_not_ingestible%', 'activity cannot be ingested (only server triggers write activity)');
select saf.expect(saf.try($q$select saf.ing('{"source":"database"}')$q$) like '%system_log_source_invalid%', 'database source not ingestible');
select saf.expect(saf.try($q$select saf.ing(jsonb_build_object('details', jsonb_build_object('blob', repeat('y', 20000))))$q$) like '%violates check constraint%', 'oversized details refused');
select saf.ing('{"fingerprint":"dddddddddddddddd","reference_id":"ERR-time-0001","occurred_at":"2001-01-01T00:00:00Z"}');
select saf.expect((select occurred_at > now() - interval '1 minute' from public.system_log_events where reference_id = 'ERR-time-0001'), 'implausible client time replaced by receipt time');

-- ---------------------------------------------------------------- correlation (browser + server = one failure)
select saf.ing('{"fingerprint":"eeeeeeeeeeeeeeee","reference_id":"REQ-server-0001","source":"server","correlation_id":"REQ-server-0001","api_route":"/api/orders","http_status":500}');
select saf.expect((saf.ing('{"fingerprint":"ffffffffffffffff","reference_id":"ERR-browser-0001","server_reference_id":"REQ-server-0001"}')->>'correlated') = 'true', 'browser report of the same failure is correlated');
select saf.expect((select not counted and duplicate_of = (select id from public.system_log_events where reference_id = 'REQ-server-0001') from public.system_log_events where reference_id = 'ERR-browser-0001'), 'browser row linked, not counted');
select saf.expect((select count(*) from public.system_log_groups where fingerprint = 'ffffffffffffffff') = 0, 'no second group for the correlated browser report');
select saf.expect((saf.grp('eeeeeeeeeeeeeeee')).occurrence_count = 1, 'server group counted once');
-- Another actor cannot attach to someone else's server failure.
select saf.ing(jsonb_build_object('fingerprint','ffffffffffffffff','reference_id','ERR-browser-0002','server_reference_id','REQ-server-0001','actor_id',saf.u(3)::text));
select saf.expect((select counted and duplicate_of is null from public.system_log_events where reference_id = 'ERR-browser-0002'), 'cross-actor server reference is not linked');
-- Browser first, server later: the browser row becomes the linked copy and its group count is corrected.
select saf.ing('{"fingerprint":"1111111111111111","reference_id":"ERR-browser-0003","server_reference_id":"REQ-server-0002"}');
select saf.expect((saf.grp('1111111111111111')).occurrence_count = 1, 'browser-first report counted provisionally');
select saf.ing('{"fingerprint":"2222222222222222","reference_id":"REQ-server-0002","source":"server"}');
select saf.expect((select not counted and duplicate_of is not null from public.system_log_events where reference_id = 'ERR-browser-0003'), 'late server report links the earlier browser row');

-- ---------------------------------------------------------------- reads: scope, filters, search, pagination
select saf.expect((select count(*) from public.system_log_list_errors(array[saf.o(1)], false, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, null, null, 100)
                   where organization_id <> saf.o(1)) = 0, 'scoped list never returns another organization');
select saf.expect(exists (select 1 from public.system_log_list_errors(array[saf.o(2)], false, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, null, null, 100) where reference_id = 'ERR-env-org2'), 'org 2 viewer sees org 2');
select saf.expect(not exists (select 1 from public.system_log_list_errors(array[]::uuid[], false, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, null, null, 100)), 'empty scope lists nothing');
select saf.expect(not exists (select 1 from public.system_log_list_errors(null, false, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, null, null, 100)), 'null scope lists nothing (fails closed)');
select saf.expect((select bool_and(environment = 'local') from public.system_log_list_errors(null, true, now() - interval '1 day', now() + interval '1 minute', 'local', null, null, null, null, null, 100)), 'environment filter keeps localhost apart from staging');
select saf.expect(not exists (select 1 from public.system_log_list_errors(null, true, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, null, null, 100) where reference_id = 'ERR-browser-0001'), 'linked browser duplicates are not listed twice');
select saf.expect((select count(*) from public.system_log_list_errors(null, true, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, null, 'ERR-env-loc', 100)) = 1, 'search by reference');
select saf.expect((select count(*) from public.system_log_list_errors(null, true, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, null, 'ERR-browser-0001', 100)) = 1, 'a linked browser reference quoted by the user is still found by exact search');
select saf.expect((select count(*) from public.system_log_list_errors(null, true, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, null, 'ERR-cap-0025', 100)) = 1, 'search by a suppressed reference finds its group''s latest row');
select saf.expect((select count(*) from public.system_log_list_errors(null, true, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, null, '100%_', 100)) = 0, 'search wildcards are literal');
select saf.expect((select count(*) from public.system_log_list_errors(null, true, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, null, null, 500)) <= 101, 'page size bounded to 101');
-- Keyset pagination: pages of 5 cover everything once, in order.
do $$
declare v_ct timestamptz; v_ci uuid; v_seen uuid[] := '{}'; v_page int := 0; r record; v_n int; v_total int;
begin
  select count(*) into v_total from public.system_log_list_errors(null, true, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, null, null, 101);
  loop
    v_n := 0;
    for r in select * from public.system_log_list_errors(null, true, now() - interval '1 day', now() + interval '1 minute', null, null, null, null, null, null, 5, v_ct, v_ci) loop
      if r.id = any(v_seen) then raise exception 'ASSERTION FAILED: page overlap'; end if;
      v_seen := v_seen || r.id; v_ct := r.occurred_at; v_ci := r.id; v_n := v_n + 1;
    end loop;
    v_page := v_page + 1;
    exit when v_n < 5 or v_page > 50;
  end loop;
  if cardinality(v_seen) <> v_total then raise exception 'ASSERTION FAILED: pagination saw % of %', cardinality(v_seen), v_total; end if;
end $$;

-- Detail: scope, group facts, related events by real links only.
select saf.expect(public.system_log_event_detail((select id from public.system_log_events where reference_id = 'ERR-env-org2'), array[saf.o(1)], false) is null, 'out-of-scope detail is null');
select saf.expect((public.system_log_event_detail((select id from public.system_log_events where reference_id = 'REQ-server-0001'), array[saf.o(1)], false)->'related') @> '[{"reference_id":"ERR-browser-0001","link":"same_failure"}]', 'detail lists the correlated browser report');
select saf.expect((public.system_log_event_detail((select id from public.system_log_events where reference_id = 'ERR-g1-0002'), null, true)->'group'->>'occurrence_count')::int = 30, 'detail carries group occurrence count');
select saf.expect(not ((public.system_log_event_detail((select id from public.system_log_events where reference_id = 'ERR-g1-0002'), array[saf.o(1)], false)->'related')::text like '%ERR-env-org2%'), 'related events stay inside scope');

-- Render digest correlation (server component error seen by the server and by the browser error boundary).
select saf.ing('{"fingerprint":"3333333333333333","reference_id":"REQ-render-0001","source":"server","correlation_id":"DIG-1234567890"}');
select saf.expect((saf.ing('{"fingerprint":"4444444444444444","reference_id":"ERR-boundary-0001","correlation_id":"DIG-1234567890"}')->>'correlated') = 'true', 'browser boundary report linked to the server render error by digest');
select saf.expect(not exists (select 1 from public.system_log_groups where fingerprint = '4444444444444444'), 'digest-correlated report not counted twice');
select saf.ing(jsonb_build_object('fingerprint','4444444444444444','reference_id','ERR-boundary-0002','correlation_id','DIG-1234567890','actor_id',saf.u(3)::text));
select saf.expect((select counted from public.system_log_events where reference_id = 'ERR-boundary-0002'), 'another actor''s digest is not linked');
select saf.ing('{"fingerprint":"5555555555555555","reference_id":"ERR-boundary-0003","correlation_id":"DIG-999"}');
select saf.ing('{"fingerprint":"6666666666666666","reference_id":"REQ-render-0002","source":"server","correlation_id":"DIG-999"}');
select saf.expect((select not counted from public.system_log_events where reference_id = 'ERR-boundary-0003'), 'late server render report links the earlier boundary report');
select saf.expect((saf.ing('{"fingerprint":"7777777777777777","reference_id":"ERR-plain-corr","correlation_id":"OP-abcdef"}')->>'correlated') is null, 'non-digest correlation ids never auto-link');

-- Worker (scheduler) report of a crashed worker route links to the route's server report (no double count).
select saf.ing('{"fingerprint":"8888888888888888","reference_id":"REQ-cron-0001","source":"server","actor_id":null,"organization_id":null,"api_route":"/api/cron/x"}');
select saf.expect((saf.ing('{"fingerprint":"9999999999999990","reference_id":"JOB-cron-0001","source":"worker","actor_id":null,"organization_id":null,"server_reference_id":"REQ-cron-0001"}')->>'correlated') = 'true', 'scheduler report linked to the server report by X-Request-ID');
select saf.expect((select actor_kind = 'system' and not counted from public.system_log_events where reference_id = 'JOB-cron-0001'), 'worker row is a system actor and not counted twice');
