-- AFTER the fix.
create function saf.modes(p text[]) returns text language sql stable as $$ select string_agg(permission_key || '=' || mode, ',' order by permission_key) from public.sa_migration_modes where permission_key = any(p) $$;
select set_config('saf.k', 'inventory.stock_count.view,inventory.stock_count.create,inventory.stock_count.post', false);

-- 1. Authorized preview works; retirement / readiness blockers are reported as blockers, not as an authorization error.
select saf.expect((select count(*) from public.sa_preview_bulk_migration_mode(saf.u(1), array['inventory.stock_count.view','inventory.stock_count.create','inventory.stock_count.post'], 'LEGACY_RETIRED')) = 3, 'preview returns every row');
select saf.expect((select status from public.sa_preview_bulk_migration_mode(saf.u(1), array['inventory.stock_count.view'], 'LEGACY_RETIRED')) = 'change', 'NEW_ENFORCED + ready -> retirement allowed');
select saf.expect((select blockers from public.sa_preview_bulk_migration_mode(saf.u(1), array['inventory.stock_count.create'], 'LEGACY_RETIRED')) = array['sa_retire_requires_new_enforced'], 'SHADOW -> retire blocked by transition rule');
select saf.expect((select blockers from public.sa_preview_bulk_migration_mode(saf.u(1), array['inventory.stock_count.post'], 'LEGACY_RETIRED')) = array['sa_not_enforcement_ready','sa_retire_requires_new_enforced'], 'not ready + wrong mode both reported');

-- 2. Unauthorized actors stay denied (no admin permission, other organization, inactive context, null actor); no service-role bypass exists.
select saf.expect(saf.try($q$select * from public.sa_preview_bulk_migration_mode(saf.u(2), array['inventory.stock_count.view'], 'LEGACY_RETIRED')$q$) = 'sa_authorization_required', 'member without permission denied');
select saf.expect(saf.try($q$select * from public.sa_preview_bulk_migration_mode(saf.u(3), array['inventory.stock_count.view'], 'LEGACY_RETIRED')$q$) = 'sa_authorization_required', 'manufacturer user denied');
select saf.expect(saf.try($q$select * from public.sa_preview_bulk_migration_mode(saf.u(4), array['inventory.stock_count.view'], 'LEGACY_RETIRED')$q$) = 'sa_authorization_required', 'account with no organization cannot satisfy an organization scope');
select saf.expect(saf.try($q$select * from public.sa_preview_bulk_migration_mode(null, array['inventory.stock_count.view'], 'LEGACY_RETIRED')$q$) = 'sa_actor_required', 'no actor refused');
select saf.expect(saf.try($q$select public.sa_set_migration_mode(saf.u(2), 'inventory.stock_count.create', 'NEW_ENFORCED', 'reason long enough')$q$) = 'sa_authorization_required', 'single change still denied for unauthorized');
select saf.expect(saf.try($q$select public.sa_bulk_set_migration_mode(saf.u(3), array['inventory.stock_count.create'], '{"inventory.stock_count.create":"SHADOW"}', 'NEW_ENFORCED', 'reason long enough', 'g', 'all', gen_random_uuid())$q$) = 'sa_authorization_required', 'bulk apply denied for unauthorized');
select saf.expect(saf.modes(array['inventory.stock_count.create']) = 'inventory.stock_count.create=SHADOW', 'denied attempts changed nothing');

-- 3. Authorized single change now works (same authority as bulk).
select saf.expect(public.sa_set_migration_mode(saf.u(1), 'inventory.stock_count.create', 'NEW_ENFORCED', 'reason long enough') = 'NEW_ENFORCED', 'single change by org-scoped admin');
select public.sa_set_migration_mode(saf.u(1), 'inventory.stock_count.create', 'SHADOW', 'reason long enough');

-- 4. Bulk apply: eligible_only, audit, batch record, idempotent replay, stale-preview rejection.
select set_config('saf.key', gen_random_uuid()::text, false);
select set_config('saf.res', public.sa_bulk_set_migration_mode(saf.u(1), array['inventory.stock_count.view','inventory.stock_count.create'],
  '{"inventory.stock_count.view":"NEW_ENFORCED","inventory.stock_count.create":"SHADOW"}', 'LEGACY_RETIRED', 'retire what is eligible', 'g', 'eligible_only', current_setting('saf.key')::uuid)::text, false);
select saf.expect((current_setting('saf.res')::jsonb->>'changed')::int = 1 and (current_setting('saf.res')::jsonb->>'skipped')::int = 1, 'one changed, blocked one skipped');
select saf.expect(saf.modes(array['inventory.stock_count.view','inventory.stock_count.create']) = 'inventory.stock_count.create=SHADOW,inventory.stock_count.view=LEGACY_RETIRED', 'only the eligible permission moved');
select saf.expect((select count(*) from public.sa_access_change_log where action = 'migration_mode.changed' and (details->>'batch_id') = current_setting('saf.res')::jsonb->>'batchId') = 1, 'per-permission audit row with the batch id');
select saf.expect((select count(*) from public.sa_access_change_log where action = 'migration_mode.bulk_changed') = 1, 'batch summary audit row');
select saf.expect((public.sa_bulk_set_migration_mode(saf.u(1), array['inventory.stock_count.view','inventory.stock_count.create'],
  '{"inventory.stock_count.view":"NEW_ENFORCED","inventory.stock_count.create":"SHADOW"}', 'LEGACY_RETIRED', 'retire what is eligible', 'g', 'eligible_only', current_setting('saf.key')::uuid)->>'replayed')::boolean, 'same key replays without repeating');
select saf.expect((select count(*) from public.sa_access_change_log where action = 'migration_mode.bulk_changed') = 1, 'replay wrote no second audit row');
select saf.expect(saf.try($q$select public.sa_bulk_set_migration_mode(saf.u(1), array['inventory.stock_count.create'], '{"inventory.stock_count.create":"NEW_ENFORCED"}', 'SHADOW', 'stale preview attempt', 'g', 'all', gen_random_uuid())$q$) = 'sa_bulk_stale_preview', 'stale preview rejected');
select saf.expect(saf.try($q$select public.sa_bulk_set_migration_mode(saf.u(1), array['inventory.stock_count.create'], '{"inventory.stock_count.create":"SHADOW"}', 'LEGACY_RETIRED', 'blocked all attempt', 'g', 'all', gen_random_uuid())$q$) like 'sa_bulk_blocked%', 'blocked rows stop an "all" apply');

-- 5. Administrator-lockout safeguard still rolls the whole batch back.
select saf.expect(saf.try($q$select public.sa_bulk_set_migration_mode(saf.u(1), array['security.permission.manage','inventory.stock_count.create'],
  '{"security.permission.manage":"LEGACY_RETIRED","inventory.stock_count.create":"SHADOW"}', 'SHADOW', 'lockout attempt reason', 'g', 'all', gen_random_uuid())$q$) = 'sa_bulk_actor_lockout', 'lockout refused');
select saf.expect(saf.modes(array['security.permission.manage','inventory.stock_count.create']) = 'inventory.stock_count.create=SHADOW,security.permission.manage=LEGACY_RETIRED', 'lockout rolled the batch back');
