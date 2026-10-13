-- ============================================================================
-- inventory.stock_count.create — after 20261019100000. API-role writes (PostgREST simulation) and the discard RPC.
-- ============================================================================
\set ON_ERROR_STOP on
CREATE TEMP TABLE c (name text PRIMARY KEY, id uuid);
GRANT ALL ON c TO PUBLIC;
CREATE FUNCTION pg_temp.cid(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM c WHERE name = p $$;

-- ---------------------------------------------------------------- SHADOW: unchanged
SELECT sar_test.expect_eq('create starts SHADOW', (SELECT mode FROM public.sa_migration_modes WHERE permission_key = 'inventory.stock_count.create'), 'SHADOW');
SELECT sar_test.expect_ok('shadow: HQ admin without S&A grant inserts a draft (legacy decides)', 'authenticated', sar_test.uid('hq_a'),
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000c001', 'wh_a1'));
SELECT sar_test.expect_ok('shadow: … adds an item', 'authenticated', sar_test.uid('hq_a'), sar_test.insert_item_sql('00000000-0000-0000-0000-00000000c001'));
SELECT sar_test.expect_ok('shadow: … adds the scope row', 'authenticated', sar_test.uid('hq_a'), sar_test.insert_scope_sql('00000000-0000-0000-0000-00000000c001'));
-- Legacy is too broad (is_hq_admin() inside can_access_org spans tenants); SHADOW keeps that exactly.
SELECT sar_test.expect_ok('shadow: other-tenant HQ admin still passes legacy RLS (unchanged)', 'authenticated', sar_test.uid('hq_b'),
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000c002', 'wh_a1'));
SELECT sar_test.expect_eq('shadow: HQ admin discards (unchanged)', sar_test.discard_as(sar_test.uid('hq_a'), sar_test.owner_draft('wh_a1')), 'discarded');

-- ---------------------------------------------------------------- NEW_ENFORCED
SELECT sar_test.set_mode('inventory.stock_count.create', 'NEW_ENFORCED');
INSERT INTO c VALUES ('a1', sar_test.owner_draft('wh_a1')), ('a2', sar_test.owner_draft('wh_a2'));

-- authorized: organization grant, warehouse grants on their own warehouse, create-only drafter
SELECT sar_test.expect_ok('enforced: HQ organization grant inserts a draft in WH A1', 'authenticated', sar_test.uid('manager'),
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000c011', 'wh_a1'));
SELECT sar_test.expect_ok('enforced: … and in WH A2', 'authenticated', sar_test.uid('manager'),
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000c012', 'wh_a2'));
SELECT sar_test.expect_ok('enforced: … adds an item (hundreds of rows evaluate once per transaction)', 'authenticated', sar_test.uid('manager'),
  sar_test.insert_item_sql('00000000-0000-0000-0000-00000000c011'));
SELECT sar_test.expect_ok('enforced: … adds the scope row', 'authenticated', sar_test.uid('manager'), sar_test.insert_scope_sql('00000000-0000-0000-0000-00000000c011'));
SELECT sar_test.expect_ok('enforced: … edits the draft', 'authenticated', sar_test.uid('manager'),
  $q$UPDATE public.stock_count_sessions SET notes = 'edited' WHERE id = '00000000-0000-0000-0000-00000000c011'$q$);
SELECT sar_test.expect_ok('enforced: … edits and deletes the item', 'authenticated', sar_test.uid('manager'),
  $q$UPDATE public.stock_count_session_items SET physical_quantity = 8 WHERE session_id = '00000000-0000-0000-0000-00000000c011'; DELETE FROM public.stock_count_session_items WHERE session_id = '00000000-0000-0000-0000-00000000c011'$q$);
SELECT sar_test.expect_ok('enforced: WH A1 staff (warehouse grant) inserts in WH A1', 'authenticated', sar_test.uid2('wh_staff'),
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000c013', 'wh_a1'));
SELECT sar_test.expect_ok('enforced: HQ member scoped to WH A1 inserts in WH A1', 'authenticated', sar_test.uid2('wh_scoped'),
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000c014', 'wh_a1'));
SELECT sar_test.expect_ok('enforced: create-only drafter inserts', 'authenticated', sar_test.uid('user'),
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000c015', 'wh_a2'));

-- unauthorized: no grant / wrong warehouse / other tenant / inactive / anon
SELECT sar_test.expect_err('enforced: HQ admin without S&A grant (legacy allow) is refused', 'authenticated', sar_test.uid('hq_a'),
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000c021', 'wh_a1'), 'sa_authorization_required');
SELECT sar_test.expect_err('enforced: WH A1-scoped HQ member is refused in WH A2 (RLS alone would allow)', 'authenticated', sar_test.uid2('wh_scoped'),
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000c022', 'wh_a2'), 'sa_authorization_required');
SELECT sar_test.expect_err('enforced: WH A1 staff is refused in WH A2', 'authenticated', sar_test.uid2('wh_staff'),
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000c023', 'wh_a2'), '42501');
SELECT sar_test.expect_err('enforced: other-tenant HQ admin (legacy RLS passes) is refused by S&A', 'authenticated', sar_test.uid('hq_b'),
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000c024', 'wh_a1'), 'sa_authorization_required');
SELECT sar_test.expect_err('enforced: inactive account is refused', 'authenticated', sar_test.uid('inactive'),
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000c025', 'wh_a1'), '42501');
SELECT sar_test.expect_err('enforced: anon is refused', 'anon', NULL,
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000c026', 'wh_a1'), '42501');
SELECT sar_test.expect_err('enforced: no-grant user cannot add items to an existing draft', 'authenticated', sar_test.uid('hq_a'),
  sar_test.insert_item_sql(pg_temp.cid('a1')), 'sa_authorization_required');
SELECT sar_test.expect_err('enforced: … nor scope rows', 'authenticated', sar_test.uid('hq_a'),
  sar_test.insert_scope_sql(pg_temp.cid('a1')), 'sa_authorization_required');
SELECT sar_test.expect_err('enforced: … nor edit the draft', 'authenticated', sar_test.uid('hq_a'),
  format($q$UPDATE public.stock_count_sessions SET notes = 'x' WHERE id = %L$q$, pg_temp.cid('a1')), 'sa_authorization_required');
SELECT sar_test.expect_err('enforced: … nor delete it', 'authenticated', sar_test.uid('hq_a'),
  format($q$DELETE FROM public.stock_count_sessions WHERE id = %L$q$, pg_temp.cid('a1')), 'sa_authorization_required');
SELECT sar_test.expect_err('enforced: WH A1-scoped member cannot edit a WH A2 draft', 'authenticated', sar_test.uid2('wh_scoped'),
  format($q$UPDATE public.stock_count_sessions SET notes = 'x' WHERE id = %L$q$, pg_temp.cid('a2')), 'sa_authorization_required');
SELECT sar_test.expect_err('enforced: … nor move its WH A1 draft into WH A2', 'authenticated', sar_test.uid2('wh_scoped'),
  $q$UPDATE public.stock_count_sessions SET warehouse_organization_id = '00000000-0000-0000-0000-00000000a003' WHERE id = '00000000-0000-0000-0000-00000000c014'$q$, 'sa_authorization_required');
SELECT sar_test.expect_eq('enforced: refused writes changed nothing',
  (SELECT count(*) FROM public.stock_count_sessions WHERE id IN ('00000000-0000-0000-0000-00000000c021','00000000-0000-0000-0000-00000000c022','00000000-0000-0000-0000-00000000c023','00000000-0000-0000-0000-00000000c024','00000000-0000-0000-0000-00000000c025','00000000-0000-0000-0000-00000000c026'))::int
  + (SELECT count(*) FROM public.stock_count_session_items WHERE session_id = pg_temp.cid('a1'))::int
  + (SELECT count(*) FROM public.stock_count_sessions WHERE id = pg_temp.cid('a2') AND notes <> 'fixture')::int
  + (SELECT count(*) FROM public.stock_count_sessions WHERE id = '00000000-0000-0000-0000-00000000c014' AND warehouse_organization_id <> sar_test.org('wh_a1'))::int, 0);

-- discard (archive) RPC: per-draft refusal is reported in the RPC's failed list
SELECT sar_test.expect_eq('enforced: no-grant user cannot discard', sar_test.discard_as(sar_test.uid('hq_a'), pg_temp.cid('a1')), 'failed:sa_authorization_required');
SELECT sar_test.expect_eq('enforced: WH A1-scoped member cannot discard a WH A2 draft', sar_test.discard_as(sar_test.uid2('wh_scoped'), pg_temp.cid('a2')), 'failed:sa_authorization_required');
SELECT sar_test.expect_eq('enforced: … the refused drafts are still drafts',
  (SELECT string_agg(status, ',' ORDER BY id) FROM public.stock_count_sessions WHERE id IN (pg_temp.cid('a1'), pg_temp.cid('a2'))), 'draft,draft');
SELECT sar_test.expect_eq('enforced: authorized user discards', sar_test.discard_as(sar_test.uid('manager'), pg_temp.cid('a2')), 'discarded');

-- trusted paths are not API roles: SECURITY DEFINER posting and the service role keep working
INSERT INTO c VALUES ('post', sar_test.new_session_in('wh_a1'));
SELECT sar_test.expect_ok('enforced: posting workflow (SECURITY DEFINER) still updates the session', 'authenticated', sar_test.uid('manager'), sar_test.prepare_sql(pg_temp.cid('post')));
SELECT sar_test.expect_ok('enforced: … delivers', 'authenticated', sar_test.uid('manager'), sar_test.finalize_sql(pg_temp.cid('post')));
SELECT sar_test.expect_ok('enforced: … posts', 'authenticated', sar_test.uid('manager'), sar_test.post_sql(pg_temp.cid('post')));
SELECT sar_test.expect_eq('enforced: posted with one movement', sar_test.fp(pg_temp.cid('post')), 'posted|1|1');
SELECT sar_test.expect_err('enforced: posted counts stay immutable (integrity guard unchanged)', 'authenticated', sar_test.uid('manager'),
  format($q$UPDATE public.stock_count_sessions SET notes = 'rewrite' WHERE id = %L$q$, pg_temp.cid('post')), 'stock_count_posted_session_immutable');
SELECT sar_test.expect_ok('enforced: service role (trusted server) is not an API-role write', 'service_role', NULL,
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000c031', 'wh_a1'));

-- ---------------------------------------------------------------- LEGACY_RETIRED behaves the same
SELECT sar_test.set_mode('inventory.stock_count.create', 'LEGACY_RETIRED');
SELECT sar_test.expect_err('retired: HQ admin without S&A grant is refused', 'authenticated', sar_test.uid('hq_a'),
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000c041', 'wh_a1'), 'sa_authorization_required');
SELECT sar_test.expect_ok('retired: WH A1 staff inserts in WH A1', 'authenticated', sar_test.uid2('wh_staff'),
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000c042', 'wh_a1'));

-- ---------------------------------------------------------------- privileges
SELECT sar_test.expect_eq('API roles cannot truncate the scope table', has_table_privilege('authenticated', 'public.stock_count_session_scope', 'TRUNCATE'), false);
SELECT sar_test.expect_eq('API roles cannot call the internal posting check', has_function_privilege('authenticated', 'public.stock_count_user_can_post(uuid,uuid)', 'EXECUTE'), false);

SELECT sar_test.set_mode('inventory.stock_count.create', 'SHADOW');
SELECT 'stock count create suite passed' AS status;
