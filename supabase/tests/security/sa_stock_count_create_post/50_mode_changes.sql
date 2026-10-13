-- ============================================================================
-- Migration Modes — optional note / required rollback reason / bulk keeps Legacy Retired (20261019110000).
-- Runs after 20261019100000 (create/post are enforcement-ready). Calls go through service_role, as the API does.
-- ============================================================================
\set ON_ERROR_STOP on
\if :{?before_fix}
\else
\set before_fix false
\endif

CREATE TEMP TABLE keys (k text PRIMARY KEY);
INSERT INTO keys VALUES ('inventory.stock_count.create'), ('inventory.stock_count.post'), ('inventory.stock_count.verify'), ('inventory.stock_count.view');
GRANT ALL ON keys TO PUBLIC;
CREATE FUNCTION pg_temp.arr() RETURNS text LANGUAGE sql AS $$ SELECT quote_literal(array_agg(k ORDER BY k)::text) || '::text[]' FROM keys $$;
CREATE FUNCTION pg_temp.expected() RETURNS text LANGUAGE sql AS $$
  SELECT quote_literal(jsonb_object_agg(permission_key, mode)::text) || '::jsonb' FROM public.sa_migration_modes WHERE permission_key IN (SELECT k FROM keys) $$;
CREATE FUNCTION pg_temp.bulk_sql(p_actor uuid, p_target text, p_reason text, p_selection text DEFAULT 'all', p_key uuid DEFAULT gen_random_uuid(), p_expected text DEFAULT NULL)
RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT public.sa_bulk_set_migration_mode(%L::uuid, %s, %s, %L, %L, %L, %L, %L::uuid)::text',
    p_actor, pg_temp.arr(), coalesce(p_expected, pg_temp.expected()), p_target, p_reason, 'supply_chain/stock_count', p_selection, p_key) $$;
CREATE FUNCTION pg_temp.preview(p_actor uuid, p_target text) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(permission_key || '=' || status, ',' ORDER BY permission_key)
  FROM public.sa_preview_bulk_migration_mode(p_actor, (SELECT array_agg(k) FROM keys), p_target) $$;
CREATE FUNCTION pg_temp.modes() RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(split_part(permission_key, '.', 3) || '=' || mode, ',' ORDER BY permission_key) FROM public.sa_migration_modes WHERE permission_key IN (SELECT k FROM keys) $$;
CREATE FUNCTION pg_temp.set_sql(p_actor uuid, p_key text, p_mode text, p_reason text) RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT public.sa_set_migration_mode(%L::uuid, %L, %L, %L)', p_actor, p_key, p_mode, p_reason) $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pg_temp TO PUBLIC;

-- Starting point (as on a partly migrated environment).
SELECT sar_test.set_mode('inventory.stock_count.view', 'LEGACY_RETIRED');
SELECT sar_test.set_mode('inventory.stock_count.verify', 'NEW_ENFORCED');
SELECT sar_test.set_mode('inventory.stock_count.create', 'SHADOW');
SELECT sar_test.set_mode('inventory.stock_count.post', 'SHADOW');

\if :before_fix
-- ---------------------------------------------------------------- negative control (before 20261019110000)
SELECT sar_test.expect_eq('DEFECT: a group move to New Access Active would un-retire view',
  pg_temp.preview(sar_test.uid('sa'), 'NEW_ENFORCED'), 'inventory.stock_count.create=change,inventory.stock_count.post=change,inventory.stock_count.verify=unchanged,inventory.stock_count.view=change');
SELECT sar_test.expect_err('DEFECT: a forward change without text is refused', 'service_role', NULL,
  pg_temp.set_sql(sar_test.uid('sa'), 'inventory.stock_count.create', 'NEW_ENFORCED', NULL), 'sa_reason_required');
SELECT 'mode-change negative control reproduced the gaps' AS status;
\quit
\endif

-- ---------------------------------------------------------------- preview = execution, retired kept, optional note
SELECT sar_test.expect_eq('preview: retired view is kept, ready create/post change, verify unchanged',
  pg_temp.preview(sar_test.uid('sa'), 'NEW_ENFORCED'), 'inventory.stock_count.create=change,inventory.stock_count.post=change,inventory.stock_count.verify=unchanged,inventory.stock_count.view=kept_retired');
CREATE TEMP TABLE r (name text PRIMARY KEY, v jsonb);
GRANT ALL ON r TO PUBLIC;
INSERT INTO r SELECT 'fwd', sar_test.value_as('service_role', NULL, pg_temp.bulk_sql(sar_test.uid('sa'), 'NEW_ENFORCED', NULL))::jsonb;
SELECT sar_test.expect_eq('apply without a note: changed/unchanged/kept/skipped', (SELECT format('%s/%s/%s/%s', v->>'changed', v->>'unchanged', v->>'keptRetired', v->>'skipped') FROM r WHERE name = 'fwd'), '2/1/1/0');
SELECT sar_test.expect_eq('apply: modes after execution (view stays retired)', pg_temp.modes(), 'create=NEW_ENFORCED,post=NEW_ENFORCED,verify=NEW_ENFORCED,view=LEGACY_RETIRED');
SELECT sar_test.expect_eq('preview and execution agree item by item',
  (SELECT string_agg(i->>'permissionKey' || '=' || (i->>'status'), ',' ORDER BY i->>'permissionKey') FROM r, jsonb_array_elements(v->'items') i WHERE name = 'fwd'),
  'inventory.stock_count.create=changed,inventory.stock_count.post=changed,inventory.stock_count.verify=unchanged,inventory.stock_count.view=kept_retired');
SELECT sar_test.expect_eq('audit: one row per changed permission, actor + old/new + module + no note + generated text',
  (SELECT string_agg(format('%s|%s>%s|%s|%s|%s|%s', entity_id, details->>'from', details->>'to', details->>'module', coalesce(details->>'note', '∅'), details->>'reason_generated', (actor_id = sar_test.uid('sa'))::text), ';' ORDER BY entity_id)
   FROM public.sa_access_change_log WHERE action = 'migration_mode.changed' AND details->>'batch_id' = (SELECT v->>'batchId' FROM r WHERE name = 'fwd')),
  'inventory.stock_count.create|SHADOW>NEW_ENFORCED|inventory|∅|true|true;inventory.stock_count.post|SHADOW>NEW_ENFORCED|inventory|∅|true|true');
SELECT sar_test.expect_eq('audit: generated description is accurate',
  (SELECT reason FROM public.sa_access_change_log WHERE action = 'migration_mode.changed' AND entity_id = 'inventory.stock_count.create' ORDER BY occurred_at DESC LIMIT 1),
  'Migration mode of inventory.stock_count.create changed from Monitoring / Shadow to New Access Active. No note provided.');
SELECT sar_test.expect_eq('audit: batch record keeps counts, kept-retired and a generated reason',
  (SELECT format('%s|%s|%s|%s|%s', changed_count, unchanged_count, kept_retired_count, skipped_count, reason) FROM public.sa_migration_mode_batches WHERE batch_id = (SELECT (v->>'batchId')::uuid FROM r WHERE name = 'fwd')),
  '2|1|1|0|Group supply_chain/stock_count moved to New Access Active: 2 changed, 1 unchanged, 1 kept retired, 0 skipped. No note provided.');
SELECT sar_test.expect_eq('audit: batch summary row',
  (SELECT format('%s|%s|%s', details->>'kept_retired', details->>'reason_generated', created_by_ok) FROM (SELECT details, (actor_id = sar_test.uid('sa'))::text AS created_by_ok FROM public.sa_access_change_log WHERE action = 'migration_mode.bulk_changed' AND entity_id = (SELECT v->>'batchId' FROM r WHERE name = 'fwd')) x),
  '1|true|true');

-- ---------------------------------------------------------------- rollback requires a reason
SELECT sar_test.expect_err('rollback to Monitoring without a reason is refused', 'service_role', NULL, pg_temp.bulk_sql(sar_test.uid('sa'), 'SHADOW', NULL), 'sa_reason_required');
SELECT sar_test.expect_err('… a blank reason is refused', 'service_role', NULL, pg_temp.bulk_sql(sar_test.uid('sa'), 'SHADOW', '          '), 'sa_reason_required');
SELECT sar_test.expect_err('… a short reason is refused', 'service_role', NULL, pg_temp.bulk_sql(sar_test.uid('sa'), 'SHADOW', 'too short'), 'sa_reason_required');
SELECT sar_test.expect_eq('… nothing changed', pg_temp.modes(), 'create=NEW_ENFORCED,post=NEW_ENFORCED,verify=NEW_ENFORCED,view=LEGACY_RETIRED');
SELECT sar_test.expect_err('a note over 500 characters is refused', 'service_role', NULL, pg_temp.bulk_sql(sar_test.uid('sa'), 'SHADOW', repeat('x', 501)), 'sa_reason_too_long');
INSERT INTO r SELECT 'back', sar_test.value_as('service_role', NULL, pg_temp.bulk_sql(sar_test.uid('sa'), 'SHADOW', '  Parity regression on WH A2  '))::jsonb;
SELECT sar_test.expect_eq('rollback with a reason: all 4 move back (a retired one too — a rollback is explicit)', (SELECT format('%s/%s/%s', v->>'changed', v->>'keptRetired', v->>'note') FROM r WHERE name = 'back'), '4/0/Parity regression on WH A2');
SELECT sar_test.expect_eq('rollback audit carries the reason as the note',
  (SELECT string_agg(DISTINCT format('%s|%s|%s', reason, details->>'note', details->>'reason_generated'), ';') FROM public.sa_access_change_log WHERE action = 'migration_mode.changed' AND details->>'batch_id' = (SELECT v->>'batchId' FROM r WHERE name = 'back')),
  'Parity regression on WH A2|Parity regression on WH A2|false');

-- ---------------------------------------------------------------- blocked / eligible-only / stale / replay
SELECT sar_test.expect_err('LEGACY_RETIRED "all" with blocked permissions is refused', 'service_role', NULL, pg_temp.bulk_sql(sar_test.uid('sa'), 'LEGACY_RETIRED', NULL), 'sa_bulk_blocked');
SELECT sar_test.expect_err('eligible-only with nothing eligible is refused', 'service_role', NULL, pg_temp.bulk_sql(sar_test.uid('sa'), 'LEGACY_RETIRED', NULL, 'eligible_only'), 'sa_bulk_no_changes');
SELECT sar_test.expect_ok('single forward change with an optional note', 'service_role', NULL, pg_temp.set_sql(sar_test.uid('sa'), 'inventory.stock_count.verify', 'NEW_ENFORCED', 'Re-enable after fix'));
INSERT INTO r SELECT 'elig', sar_test.value_as('service_role', NULL, pg_temp.bulk_sql(sar_test.uid('sa'), 'LEGACY_RETIRED', NULL, 'eligible_only'))::jsonb;
SELECT sar_test.expect_eq('eligible-only retires the eligible one and skips the blocked ones', (SELECT format('%s/%s', v->>'changed', v->>'skipped') FROM r WHERE name = 'elig'), '1/3');
SELECT sar_test.expect_eq('… blocked keys unchanged', pg_temp.modes(), 'create=SHADOW,post=SHADOW,verify=LEGACY_RETIRED,view=SHADOW');
SELECT sar_test.expect_err('a stale preview is refused', 'service_role', NULL,
  pg_temp.bulk_sql(sar_test.uid('sa'), 'NEW_ENFORCED', NULL, 'all', gen_random_uuid(), quote_literal('{"inventory.stock_count.create":"NEW_ENFORCED","inventory.stock_count.post":"SHADOW","inventory.stock_count.verify":"LEGACY_RETIRED","inventory.stock_count.view":"SHADOW"}') || '::jsonb'), 'sa_bulk_stale_preview');
SELECT sar_test.expect_eq('preview after: retired verify kept, the rest change', pg_temp.preview(sar_test.uid('sa'), 'NEW_ENFORCED'),
  'inventory.stock_count.create=change,inventory.stock_count.post=change,inventory.stock_count.verify=kept_retired,inventory.stock_count.view=change');
CREATE TEMP TABLE idem (k uuid);
INSERT INTO idem VALUES (gen_random_uuid());
GRANT ALL ON idem TO PUBLIC;
SELECT sar_test.expect_ok('apply once', 'service_role', NULL, pg_temp.bulk_sql(sar_test.uid('sa'), 'NEW_ENFORCED', 'Second wave', 'all', (SELECT k FROM idem)));
SELECT sar_test.expect_eq('replay of the same submission changes and audits nothing',
  (SELECT count(*) FROM public.sa_access_change_log)::text || '|' || (sar_test.value_as('service_role', NULL, pg_temp.bulk_sql(sar_test.uid('sa'), 'NEW_ENFORCED', 'Second wave', 'all', (SELECT k FROM idem), quote_literal('{"inventory.stock_count.create":"SHADOW","inventory.stock_count.post":"SHADOW","inventory.stock_count.verify":"LEGACY_RETIRED","inventory.stock_count.view":"SHADOW"}') || '::jsonb'))::jsonb->>'replayed') || '|' || (SELECT count(*) FROM public.sa_access_change_log)::text,
  (SELECT count(*) FROM public.sa_access_change_log)::text || '|true|' || (SELECT count(*) FROM public.sa_access_change_log)::text);
SELECT sar_test.expect_eq('verify stayed retired through the group move', pg_temp.modes(), 'create=NEW_ENFORCED,post=NEW_ENFORCED,verify=LEGACY_RETIRED,view=NEW_ENFORCED');

-- ---------------------------------------------------------------- single permission control
SELECT sar_test.expect_err('single rollback without a reason is refused', 'service_role', NULL, pg_temp.set_sql(sar_test.uid('sa'), 'inventory.stock_count.create', 'SHADOW', NULL), 'sa_reason_required');
SELECT sar_test.expect_err('single rollback to Legacy enforced with a short reason is refused', 'service_role', NULL, pg_temp.set_sql(sar_test.uid('sa'), 'inventory.stock_count.create', 'LEGACY_ENFORCED', 'short'), 'sa_reason_required');
SELECT sar_test.expect_ok('single rollback with a reason', 'service_role', NULL, pg_temp.set_sql(sar_test.uid('sa'), 'inventory.stock_count.create', 'SHADOW', 'Rollback after parity issue'));
SELECT sar_test.expect_ok('single no-op (already SHADOW) needs no reason and writes no audit', 'service_role', NULL, pg_temp.set_sql(sar_test.uid('sa'), 'inventory.stock_count.create', 'SHADOW', NULL));
SELECT sar_test.expect_eq('… exactly one rollback audit row', (SELECT count(*) FROM public.sa_access_change_log WHERE entity_id = 'inventory.stock_count.create' AND details->>'to' = 'SHADOW' AND details->>'batch_id' IS NULL)::int, 1);
SELECT sar_test.expect_ok('single forward change without a note', 'service_role', NULL, pg_temp.set_sql(sar_test.uid('sa'), 'inventory.stock_count.create', 'NEW_ENFORCED', '   '));
SELECT sar_test.expect_eq('… mode notes hold the generated description',
  (SELECT notes FROM public.sa_migration_modes WHERE permission_key = 'inventory.stock_count.create'), 'Migration mode of inventory.stock_count.create changed from Monitoring / Shadow to New Access Active. No note provided.');
SELECT sar_test.expect_ok('explicit individual control can still move a retired permission back to New Access Active', 'service_role', NULL,
  pg_temp.set_sql(sar_test.uid('sa'), 'inventory.stock_count.verify', 'NEW_ENFORCED', NULL));
SELECT sar_test.expect_err('readiness still guards: unregistered permission cannot be enforced', 'service_role', NULL,
  pg_temp.set_sql(sar_test.uid('sa'), 'inventory.transfer.request', 'NEW_ENFORCED', NULL), 'sa_not_enforcement_ready');

-- ---------------------------------------------------------------- authority
SELECT sar_test.expect_err('an actor without Manage permissions cannot preview', 'service_role', NULL,
  format('SELECT count(*) FROM public.sa_preview_bulk_migration_mode(%L::uuid, %s, %L)', sar_test.uid('manager'), pg_temp.arr(), 'NEW_ENFORCED'), 'sa_authorization_required');
SELECT sar_test.expect_err('… nor apply a group change', 'service_role', NULL, pg_temp.bulk_sql(sar_test.uid('manager'), 'SHADOW', 'A good long reason'), 'sa_authorization_required');
SELECT sar_test.expect_err('… nor change one permission', 'service_role', NULL, pg_temp.set_sql(sar_test.uid('manager'), 'inventory.stock_count.create', 'SHADOW', 'A good long reason'), 'sa_authorization_required');
SELECT sar_test.expect_err('API roles cannot call the governance functions', 'authenticated', sar_test.uid('sa'), pg_temp.set_sql(sar_test.uid('sa'), 'inventory.stock_count.create', 'SHADOW', 'A good long reason'), '42501');

SELECT 'mode change suite passed' AS status;
