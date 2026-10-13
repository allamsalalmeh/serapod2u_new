-- ============================================================================
-- AFTER 20261022100000 (autocommit per statement, like PostgREST requests).
-- ============================================================================
\set ON_ERROR_STOP on

-- SHADOW: the legacy expression decides exactly as before (same policies, only the S&A argument moved).
SELECT sar_test.set_modes('SHADOW');
SELECT sar_test.expect_eq('shadow: HQ admin (legacy) still inserts a tenant feature',
  sar_test.n(sar_test.uid('hq_a'), sar_test.sql_feature_insert('hq_a', 'fx_legacy')) NOT LIKE '%sa_authorization%', true);

SELECT sar_test.set_modes('NEW_ENFORCED');
-- refused: grants outside the row organization's chain
SELECT sar_test.expect_n('enforced: shop account cannot create HQ A''s registration-bonus settings', sar_test.u('shop_mgr2'), sar_test.sql_bonus_insert('hq_a'), 'ERR:42501:new row violates row-level security');
SELECT sar_test.expect_n('enforced: other-tenant manager cannot create DIST A''s registration-bonus settings', sar_test.u('distb_mgr'), sar_test.sql_bonus_insert('dist_a'), 'ERR:42501:new row violates row-level security');
SELECT sar_test.expect_n('enforced: shop account cannot toggle HQ A''s tenant feature', sar_test.u('shop_mgr2'), sar_test.sql_feature_insert('hq_a', 'fx_shop'), 'ERR:42501:new row violates row-level security');
SELECT sar_test.expect_n('enforced: other-tenant manager cannot add a QR code to HQ A''s campaign (parent resolved by sa_row_parent_org)',
  sar_test.u('distb_mgr'), sar_test.sql_qr_insert('fx-tok-1'), 'ERR:42501:new row violates row-level security');
SELECT sar_test.expect_n('enforced: HQ A manager without a grant at HQ B cannot create HQ B''s feature', sar_test.u('hq_mgr'), sar_test.sql_feature_insert('hq_b', 'fx_cross'), 'ERR:42501:new row violates row-level security');
-- allowed: grants that cover the row organization
SELECT sar_test.expect_n('enforced: HQ A manager creates HQ A''s registration-bonus settings', sar_test.u('hq_mgr'), sar_test.sql_bonus_insert('hq_a'), '1');
SELECT sar_test.expect_n('enforced: HQ A manager creates DIST A''s settings (HQ grant covers descendants)', sar_test.u('hq_mgr'), sar_test.sql_bonus_insert('dist_a'), '1');
SELECT sar_test.expect_n('enforced: HQ A manager toggles HQ A''s tenant feature', sar_test.u('hq_mgr'), sar_test.sql_feature_insert('hq_a', 'fx_hq'), '1');
SELECT sar_test.expect_n('enforced: HQ A manager adds a QR code to HQ A''s campaign', sar_test.u('hq_mgr'), sar_test.sql_qr_insert('fx-tok-2'), '1');
SELECT sar_test.expect_n('enforced: shop account still writes its OWN organization''s settings', sar_test.u('shop_mgr2'), sar_test.sql_bonus_insert('shop_a'), '1');
SELECT sar_test.expect_n('enforced: DIST B manager still writes DIST B''s settings', sar_test.u('distb_mgr'), sar_test.sql_bonus_insert('dist_b'), '1');

-- The resolver: parent organization only, callable by API roles, nothing else.
SELECT sar_test.expect_eq('sa_row_parent_org resolves a campaign to its organization',
  sar_test.value_as('authenticated', sar_test.u('shop_mgr2'), $q$SELECT public.sa_row_parent_org('roadtour_campaign', '00000000-0000-0000-0000-0000000f0104')::text$q$),
  sar_test.o('hq_a')::text);
SELECT sar_test.expect_eq('sa_row_parent_org returns NULL for an unknown kind',
  sar_test.value_as('anon', NULL, $q$SELECT coalesce(public.sa_row_parent_org('users', '00000000-0000-0000-0000-000000000001')::text, 'null')$q$), 'null');
SELECT sar_test.set_modes('SHADOW');
