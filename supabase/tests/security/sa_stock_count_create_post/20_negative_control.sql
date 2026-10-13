-- ============================================================================
-- Negative control — run BEFORE 20261019100000. Demonstrates that setting the two keys to NEW_ENFORCED would not
-- have enforced anything (the readiness block was correct, not stale). Every expectation here describes the DEFECT.
-- ============================================================================
\set ON_ERROR_STOP on
SELECT sar_test.set_mode('inventory.stock_count.create', 'NEW_ENFORCED');
SELECT sar_test.set_mode('inventory.stock_count.post', 'NEW_ENFORCED');

-- create: the rewritten RLS keeps can_access_org as an alternative, so S&A does not restrict.
SELECT sar_test.expect_ok('DEFECT create: HQ admin without any S&A create grant still inserts a draft', 'authenticated', sar_test.uid('hq_a'),
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000dd01', 'wh_a1'));
SELECT sar_test.expect_ok('DEFECT create: warehouse-scoped grant (WH A1) still inserts a draft in WH A2', 'authenticated', sar_test.uid2('wh_scoped'),
  sar_test.insert_draft_sql('00000000-0000-0000-0000-00000000dd02', 'wh_a2'));
SELECT sar_test.expect_eq('DEFECT create: HQ admin without grant still discards a draft',
  sar_test.discard_as(sar_test.uid('hq_a'), sar_test.owner_draft('wh_a1')), 'discarded');

-- post: the legacy key alone decided in the database.
CREATE TEMP TABLE nc (name text PRIMARY KEY, id uuid);
GRANT ALL ON nc TO PUBLIC;
INSERT INTO nc VALUES ('legacy_only', sar_test.new_session_in('wh_a1')), ('sa_only', sar_test.new_session_in('wh_a1'));
SELECT sar_test.expect_ok('DEFECT post: legacy-only HQ admin (S&A denies) still prepares', 'authenticated', sar_test.uid('hq_a'), sar_test.prepare_sql((SELECT id FROM nc WHERE name = 'legacy_only')));
SELECT sar_test.expect_ok('DEFECT post: … delivers', 'authenticated', sar_test.uid('hq_a'), sar_test.finalize_sql((SELECT id FROM nc WHERE name = 'legacy_only')));
SELECT sar_test.expect_ok('DEFECT post: … and posts', 'authenticated', sar_test.uid('hq_a'), sar_test.post_sql((SELECT id FROM nc WHERE name = 'legacy_only')));
SELECT sar_test.expect_eq('DEFECT post: posted with movement', sar_test.fp((SELECT id FROM nc WHERE name = 'legacy_only')), 'posted|1|1');
SELECT sar_test.expect_err('DEFECT post: S&A-authorized poster without the legacy key is refused', 'authenticated', sar_test.uid2('sa_only'),
  sar_test.prepare_sql((SELECT id FROM nc WHERE name = 'sa_only')), 'permission_lost');

-- clean slate for the real suites
DELETE FROM public.stock_count_session_items WHERE session_id IN ('00000000-0000-0000-0000-00000000dd01', '00000000-0000-0000-0000-00000000dd02');
SELECT sar_test.set_mode('inventory.stock_count.create', 'SHADOW');
SELECT sar_test.set_mode('inventory.stock_count.post', 'SHADOW');
SELECT 'negative control reproduced the gaps' AS status;
