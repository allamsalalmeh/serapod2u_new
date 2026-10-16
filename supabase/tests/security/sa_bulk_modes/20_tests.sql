\set admin '''00000000-0000-0000-0000-000000000001'''
\set plain '''00000000-0000-0000-0000-000000000002'''
\set inactive '''00000000-0000-0000-0000-000000000003'''
\set key1 '''11111111-1111-4111-8111-111111111111'''

-- 1. Preview: 26 NEW_ENFORCED + 4 SHADOW -> retire = 26 eligible, 4 blocked (never via NEW_ENFORCED)
do $t$ declare r record; begin
  select count(*) filter (where status='change') c, count(*) filter (where status='unchanged') u, count(*) filter (where status='blocked') b,
         bool_and(blockers = array['sa_retire_requires_new_enforced']) filter (where status='blocked') only_retire
    into r from public.sa_preview_bulk_migration_mode('00000000-0000-0000-0000-000000000001', saf.grp(), 'LEGACY_RETIRED');
  perform saf.expect(r.c = 26 and r.u = 0 and r.b = 4, format('retire preview 26/0/4, got %s/%s/%s', r.c, r.u, r.b));
  perform saf.expect(r.only_retire, 'blocked rows must carry sa_retire_requires_new_enforced');
  -- NEW_ENFORCED: SHADOW perms are ready, so all 4 change, 26 already match
  select count(*) filter (where status='change') c, count(*) filter (where status='unchanged') u, count(*) filter (where status='blocked') b
    into r from public.sa_preview_bulk_migration_mode('00000000-0000-0000-0000-000000000001', saf.grp(), 'NEW_ENFORCED');
  perform saf.expect(r.c = 4 and r.u = 26 and r.b = 0, 'new-enforced preview 4 change / 26 unchanged');
  -- Readiness: not-ready permission blocked for NEW_ENFORCED, and for LEGACY_RETIRED reports both blockers in rule order
  select count(*) filter (where status='blocked') b into r from public.sa_preview_bulk_migration_mode('00000000-0000-0000-0000-000000000001', array['inventory.notready.view'], 'NEW_ENFORCED');
  perform saf.expect(r.b = 1, 'not-ready blocked for NEW_ENFORCED');
  perform saf.expect((select blockers from public.sa_preview_bulk_migration_mode('00000000-0000-0000-0000-000000000001', array['inventory.notready.view'], 'LEGACY_RETIRED'))
    = array['sa_not_enforcement_ready','sa_retire_requires_new_enforced'], 'both blockers listed');
  -- Legacy modes never need readiness
  perform saf.expect((select status from public.sa_preview_bulk_migration_mode('00000000-0000-0000-0000-000000000001', array['inventory.notready.view'], 'LEGACY_ENFORCED')) = 'change', 'legacy enforced needs no readiness');
  -- Unknown (forged) key is reported blocked, not silently dropped
  perform saf.expect((select blockers from public.sa_preview_bulk_migration_mode('00000000-0000-0000-0000-000000000001', array['forged.key.view'], 'SHADOW')) = array['sa_permission_unknown'], 'unknown key blocked');
end $t$;

-- 2. Unauthorized / forged callers: nothing changes
do $t$ declare before jsonb := saf.modes(saf.grp()); begin
  perform saf.expect(saf.try($$select public.sa_preview_bulk_migration_mode('00000000-0000-0000-0000-000000000002', saf.grp(), 'SHADOW')$$) like 'sa_authorization_required%', 'plain user preview denied');
  perform saf.expect(saf.try($$select public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000002', saf.grp(), saf.modes(saf.grp()), 'LEGACY_RETIRED', 'plain user attempt', 'g', 'eligible_only', '11111111-1111-4111-8111-111111111111')$$) like 'sa_authorization_required%', 'plain user apply denied');
  perform saf.expect(saf.try($$select public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000003', saf.grp(), saf.modes(saf.grp()), 'LEGACY_RETIRED', 'inactive attempt', 'g', 'eligible_only', '11111111-1111-4111-8111-111111111111')$$) like 'sa_actor_inactive%', 'inactive actor denied');
  perform saf.expect(saf.try($$select public.sa_bulk_set_migration_mode(null, saf.grp(), saf.modes(saf.grp()), 'LEGACY_RETIRED', 'no actor attempt', 'g', 'eligible_only', '11111111-1111-4111-8111-111111111111')$$) like 'sa_actor_required%', 'null actor denied (no system impersonation)');
  perform saf.expect(not has_function_privilege('authenticated', 'public.sa_bulk_set_migration_mode(uuid,text[],jsonb,text,text,text,text,uuid)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.sa_bulk_set_migration_mode(uuid,text[],jsonb,text,text,text,text,uuid)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.sa_preview_bulk_migration_mode(uuid,text[],text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.sa_bulk_set_migration_mode(uuid,text[],jsonb,text,text,text,text,uuid)', 'EXECUTE'), 'only service_role may execute');
  perform saf.expect(not has_function_privilege('service_role', 'public.sa_apply_migration_mode(uuid,text,text,text,uuid)', 'EXECUTE')
    and not has_function_privilege('service_role', 'public.sa_bulk_mode_evaluate(text[],text)', 'EXECUTE'), 'internal functions are not callable by API roles');
  perform saf.expect(saf.modes(saf.grp()) = before and saf.audit_rows() = 0, 'denied calls changed nothing');
end $t$;

-- 3. Input validation, forged selections
do $t$ begin
  perform saf.expect(saf.try($$select public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', saf.grp(), saf.modes(saf.grp()), 'LEGACY_RETIRED', '  short ', 'g', 'eligible_only', '11111111-1111-4111-8111-111111111111')$$) like 'sa_reason_required%', 'reason must be >=10 trimmed chars');
  perform saf.expect(saf.try($$select public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', saf.grp(), saf.modes(saf.grp()), 'BOGUS', 'long enough reason', 'g', 'eligible_only', '11111111-1111-4111-8111-111111111111')$$) like 'sa_mode_invalid%', 'invalid mode');
  perform saf.expect(saf.try($$select public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', saf.grp(), saf.modes(saf.grp()), 'LEGACY_RETIRED', 'long enough reason', 'g', 'whatever', '11111111-1111-4111-8111-111111111111')$$) like 'sa_bulk_selection_invalid%', 'invalid selection');
  perform saf.expect(saf.try($$select public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', saf.grp() || saf.grp(), saf.modes(saf.grp()), 'LEGACY_RETIRED', 'long enough reason', 'g', 'eligible_only', '11111111-1111-4111-8111-111111111111')$$) like 'sa_bulk_selection_invalid%', 'duplicate keys rejected');
  perform saf.expect(saf.try($$select public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', '{}', '{}', 'LEGACY_RETIRED', 'long enough reason', 'g', 'eligible_only', '11111111-1111-4111-8111-111111111111')$$) like 'sa_bulk_selection_invalid%', 'empty selection rejected');
  -- forged: a key that is not registered
  perform saf.expect(saf.try($$select public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', saf.grp() || 'forged.key.view'::text, saf.modes(saf.grp()) || '{"forged.key.view":"SHADOW"}', 'LEGACY_RETIRED', 'long enough reason', 'g', 'eligible_only', '11111111-1111-4111-8111-111111111111')$$) like 'sa_bulk_stale_preview%', 'forged key rejected');
  -- forged: expected map lacks a key / has an extra one
  perform saf.expect(saf.try($$select public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', saf.grp(), saf.modes(saf.grp()) - 'inventory.sc01.view', 'LEGACY_RETIRED', 'long enough reason', 'g', 'eligible_only', '11111111-1111-4111-8111-111111111111')$$) like 'sa_bulk_stale_preview%', 'missing expected key rejected');
  perform saf.expect(saf.try($$select public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', saf.grp(), saf.modes(saf.grp()) || '{"finance.ledger.view":"SHADOW"}', 'LEGACY_RETIRED', 'long enough reason', 'g', 'eligible_only', '11111111-1111-4111-8111-111111111111')$$) like 'sa_bulk_stale_preview%', 'extra expected key rejected');
  perform saf.expect(saf.audit_rows() = 0 and (select count(*) from public.sa_migration_mode_batches) = 0, 'invalid input wrote nothing');
end $t$;

-- 4. Default "all permissions" with blockers: nothing changes
do $t$ declare before jsonb := saf.modes(saf.grp()); begin
  perform saf.expect(saf.try($$select public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', saf.grp(), saf.modes(saf.grp()), 'LEGACY_RETIRED', 'retire stock count group', 'g', 'all', '11111111-1111-4111-8111-111111111111')$$) like 'sa_bulk_blocked: 4%', 'all-selection with 4 blocked fails');
  perform saf.expect(saf.modes(saf.grp()) = before and saf.audit_rows() = 0 and (select count(*) from public.sa_migration_mode_batches) = 0, 'blocked all-selection changed nothing');
end $t$;

-- 5. Stale preview: a relevant mode changed after the preview
do $t$ declare snap jsonb := saf.modes(saf.grp()); r text; begin
  perform public.sa_set_migration_mode('00000000-0000-0000-0000-000000000001', 'inventory.sc27.view', 'NEW_ENFORCED', 'moved after the preview');
  r := saf.try(format($f$select public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', saf.grp(), %L::jsonb, 'LEGACY_RETIRED', 'retire stock count group', 'g', 'eligible_only', '11111111-1111-4111-8111-111111111111')$f$, snap));
  perform saf.expect(r like 'sa_bulk_stale_preview%', 'stale preview rejected: ' || r);
  perform saf.expect((select mode from public.sa_migration_modes where permission_key = 'inventory.sc01.view') = 'NEW_ENFORCED', 'stale batch changed nothing');
  -- restore
  update public.sa_migration_modes set mode = 'SHADOW' where permission_key = 'inventory.sc27.view';
end $t$;

-- 6. Eligible-only: exactly the 26 eligible change; 4 remain; audit with shared batch id, real actor, reason
do $t$ declare res jsonb; b uuid; begin
  perform saf.expect(saf.audit_rows() = 1, 'only the setup change audited so far');
  res := public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', saf.grp(), saf.modes(saf.grp()), 'LEGACY_RETIRED', '  Retire stock count after parity review  ', 'inventory', 'eligible_only', '22222222-2222-4222-8222-222222222222');
  b := (res->>'batchId')::uuid;
  perform saf.expect((res->>'changed')::int = 26 and (res->>'unchanged')::int = 0 and (res->>'skipped')::int = 4 and (res->>'replayed')::boolean = false, 'result totals 26/0/4: ' || res::text);
  perform saf.expect((select count(*) from public.sa_migration_modes where permission_key = any(saf.grp()) and mode = 'LEGACY_RETIRED') = 26, '26 retired');
  perform saf.expect((select count(*) from public.sa_migration_modes where permission_key = any(saf.grp()) and mode = 'SHADOW') = 4, '4 SHADOW untouched');
  perform saf.expect((select count(*) from public.sa_access_change_log where action = 'migration_mode.changed' and details->>'batch_id' = b::text
        and details->>'from' = 'NEW_ENFORCED' and details->>'to' = 'LEGACY_RETIRED' and actor_id = '00000000-0000-0000-0000-000000000001' and actor_kind = 'user'
        and reason = '  Retire stock count after parity review  ') = 26, '26 audit rows: batch id, before/after, real actor, reason');
  perform saf.expect(saf.audit_rows('migration_mode.bulk_changed') = 1, 'one batch summary row');
  perform saf.expect((select count(*) from public.sa_migration_mode_batches where batch_id = b and actor_id = '00000000-0000-0000-0000-000000000001' and changed_count = 26 and skipped_count = 4) = 1, 'batch record');
  perform saf.expect((select count(*) from jsonb_array_elements(res->'items') i where i->>'status' = 'skipped' and i->'blockers' = '["sa_retire_requires_new_enforced"]'::jsonb) = 4, 'skipped items listed with reasons');
  perform saf.expect((select updated_by from public.sa_migration_modes where permission_key = 'inventory.sc01.view') = '00000000-0000-0000-0000-000000000001', 'updated_by is the real actor');
end $t$;

-- 7. Repeated submission: replay, no duplicate changes or audit entries
do $t$ declare r1 jsonb; n bigint := saf.audit_rows(); batches bigint := (select count(*) from public.sa_migration_mode_batches);
  -- Original expected map: 26 NEW_ENFORCED + 4 SHADOW (reconstructed; current state differs, so the hash must match the stored request)
  expected jsonb := (select jsonb_object_agg(k, case when substring(k from 13 for 2)::int <= 26 then 'NEW_ENFORCED' else 'SHADOW' end) from unnest(saf.grp()) k); begin
  r1 := public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', saf.grp(), expected, 'LEGACY_RETIRED', 'Retire stock count after parity review', 'inventory', 'eligible_only', '22222222-2222-4222-8222-222222222222');
  perform saf.expect((r1->>'replayed')::boolean and (r1->>'changed')::int = 26, 'same key replays stored result');
  perform saf.expect(saf.audit_rows() = n and (select count(*) from public.sa_migration_mode_batches) = batches, 'replay wrote no audit rows or batches');
  perform saf.expect(saf.try(format($f$select public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', saf.grp(), %L::jsonb, 'LEGACY_RETIRED', 'a different submission', 'inventory', 'all', '22222222-2222-4222-8222-222222222222')$f$, expected)) like 'sa_bulk_idempotency_conflict%', 'same key, different payload rejected');
end $t$;

-- 8. No-op: everything eligible is already retired; only blocked remain
do $t$ declare n bigint := saf.audit_rows(); begin
  perform saf.expect(saf.try($$select public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', saf.grp(), saf.modes(saf.grp()), 'LEGACY_RETIRED', 'retire again for nothing', 'inventory', 'eligible_only', '33333333-3333-4333-8333-333333333333')$$) like 'sa_bulk_no_changes%', 'no-op batch rejected');
  perform saf.expect(saf.try($$select public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', array['inventory.sc01.view'], saf.modes(array['inventory.sc01.view']), 'LEGACY_RETIRED', 'already retired singleton', 'inventory', 'all', '44444444-4444-4444-8444-444444444444')$$) like 'sa_bulk_no_changes%', 'all-unchanged group rejected');
  perform saf.expect(saf.audit_rows() = n, 'no-op wrote no audit');
end $t$;

-- 9. Rollback on failure mid-batch (test-only trigger fails the 3rd update)
do $t$ declare before jsonb; n bigint := saf.audit_rows(); batches bigint := (select count(*) from public.sa_migration_mode_batches); r text; begin
  create function public.saf_fail_on_sc29() returns trigger language plpgsql as $f$ begin if new.permission_key = 'inventory.sc29.view' then raise exception 'saf_injected_failure'; end if; return new; end $f$;
  create trigger saf_fail before update on public.sa_migration_modes for each row execute function public.saf_fail_on_sc29();
  before := saf.modes(saf.grp());
  r := saf.try($$select public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', saf.grp(), saf.modes(saf.grp()), 'NEW_ENFORCED', 'promote the whole group', 'inventory', 'eligible_only', '55555555-5555-4555-8555-555555555555')$$);
  perform saf.expect(r like '%saf_injected_failure%', 'injected failure surfaced: ' || r);
  perform saf.expect(saf.modes(saf.grp()) = before and saf.audit_rows() = n and (select count(*) from public.sa_migration_mode_batches) = batches, 'whole batch rolled back (no partial changes, audit or batch)');
  drop trigger saf_fail on public.sa_migration_modes;
  -- the same submission can then succeed: nothing was recorded for the failed attempt
  perform saf.expect((public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', saf.grp(), before, 'NEW_ENFORCED', 'promote the whole group', 'inventory', 'eligible_only', '55555555-5555-4555-8555-555555555555')->>'changed')::int = 30, 'retry after rollback applies (all 30 move to NEW_ENFORCED, incl. 26 retired -> new enforced, an existing allowed transition)');
end $t$;

-- 10. Administrator-lockout safeguard
do $t$ declare r text; begin
  -- admin holds only the legacy flag; moving security.permission.manage to NEW_ENFORCED would lock them out
  r := saf.try($$select public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', array['security.permission.manage','finance.ledger.view'], saf.modes(array['security.permission.manage','finance.ledger.view']), 'NEW_ENFORCED', 'cutover the security group', 'security', 'all', '66666666-6666-4666-8666-666666666666')$$);
  perform saf.expect(r like 'sa_bulk_actor_lockout%', 'lockout rejected: ' || r);
  perform saf.expect((select mode from public.sa_migration_modes where permission_key = 'security.permission.manage') = 'SHADOW'
    and (select mode from public.sa_migration_modes where permission_key = 'finance.ledger.view') = 'SHADOW', 'lockout rolled back');
  insert into public.saf_new_grants values ('00000000-0000-0000-0000-000000000001', 'security.permission.manage');
  perform saf.expect((public.sa_bulk_set_migration_mode('00000000-0000-0000-0000-000000000001', array['security.permission.manage','finance.ledger.view'], saf.modes(array['security.permission.manage','finance.ledger.view']), 'NEW_ENFORCED', 'cutover the security group', 'security', 'all', '66666666-6666-4666-8666-666666666666')->>'changed')::int = 2, 'allowed when the actor keeps new-model authority');
end $t$;

-- 11. Single-permission behaviour is unchanged (delegation to the shared implementation)
do $t$ declare n bigint := saf.audit_rows(); begin
  perform saf.expect(saf.try($$select public.sa_set_migration_mode('00000000-0000-0000-0000-000000000001', 'inventory.solo.view', 'LEGACY_RETIRED', 'cannot skip new enforced')$$) like 'sa_retire_requires_new_enforced%', 'single retire from SHADOW still refused');
  perform saf.expect(saf.try($$select public.sa_set_migration_mode('00000000-0000-0000-0000-000000000001', 'inventory.notready.view', 'NEW_ENFORCED', 'not ready must refuse')$$) like 'sa_not_enforcement_ready%', 'single readiness still enforced');
  perform public.sa_set_migration_mode('00000000-0000-0000-0000-000000000001', 'inventory.solo.view', 'LEGACY_ENFORCED', 'single change keeps working');
  perform saf.expect(saf.audit_rows() = n + 1 and (select details ? 'batch_id' from public.sa_access_change_log where action = 'migration_mode.changed' order by occurred_at desc limit 1) = false, 'single change audited without a batch id');
  perform saf.expect(not has_function_privilege('authenticated', 'public.sa_set_migration_mode(uuid,text,text,text)', 'EXECUTE') and has_function_privilege('service_role', 'public.sa_set_migration_mode(uuid,text,text,text)', 'EXECUTE'), 'single-change grants unchanged');
end $t$;
