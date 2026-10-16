-- ============================================================================
-- Negative control — BEFORE 20261022100000, keys NEW_ENFORCED: the gate asks about the caller's OWN organization, so
-- a grant at a shop or at another tenant passes for HQ A's rows. Rolled back.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;
SELECT sar_test.set_modes('NEW_ENFORCED');
SELECT sar_test.expect_n('gap: shop account (grant at its shop) creates HQ A''s registration-bonus settings', sar_test.u('shop_mgr2'), sar_test.sql_bonus_insert('hq_a'), '1');
SELECT sar_test.expect_n('gap: other-tenant manager (grant at DIST B) creates DIST A''s registration-bonus settings', sar_test.u('distb_mgr'), sar_test.sql_bonus_insert('dist_a'), '1');
SELECT sar_test.expect_n('gap: shop account toggles a tenant feature of HQ A', sar_test.u('shop_mgr2'), sar_test.sql_feature_insert('hq_a', 'fx_shop'), '1');
SELECT sar_test.expect_n('gap: other-tenant manager adds a roadtour QR code to HQ A''s campaign', sar_test.u('distb_mgr'), sar_test.sql_qr_insert('fx-tok-neg'), '1');
ROLLBACK;
