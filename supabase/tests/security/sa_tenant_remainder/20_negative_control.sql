-- ============================================================================
-- Negative control — BEFORE 20261021100000, every key NEW_ENFORCED: users WITHOUT any S&A grant for the gate key
-- still write, because the gated policy keeps a tenant predicate as an OR'd alternative. Rolled back at the end.
-- ============================================================================
\set ON_ERROR_STOP on
BEGIN;
SELECT sar_test.set_modes('NEW_ENFORCED');

SELECT sar_test.expect_n('gap: shop staff (no grant) edits its shop–distributor link', sar_test.u('shop_staff'),
  $q$UPDATE public.shop_distributors SET payment_terms = 'NET_7' WHERE shop_id = '00000000-0000-0000-0000-00000000a014'$q$, '1');
SELECT sar_test.expect_n('gap: DIST B manager (grant only at DIST B) edits DIST A''s link — the gate is decided at the actor''s org',
  sar_test.u('distb_mgr'), $q$UPDATE public.shop_distributors SET payment_terms = 'NET_30' WHERE shop_id = '00000000-0000-0000-0000-00000000a014'$q$, '1');
SELECT sar_test.expect_n('gap: distributor staff edits a distributor agreement', sar_test.u('dist_staff'),
  $q$UPDATE public.distributor_products SET min_order_quantity = 5 WHERE id = '00000000-0000-0000-0000-0000000f0001'$q$, '1');
SELECT sar_test.expect_n('gap: any MFR user edits a product image', sar_test.u('mfr_staff'),
  $q$UPDATE public.product_images SET title = 'x' WHERE id = '00000000-0000-0000-0000-0000000f0002'$q$, '1');
SELECT sar_test.expect_n('gap: shop staff changes its organization''s bank account holder', sar_test.u('shop_staff'),
  $q$UPDATE public.organizations SET bank_account_holder_name = 'Someone else' WHERE id = '00000000-0000-0000-0000-00000000a014'$q$, '1');
SELECT sar_test.expect_n('gap: buyer staff edits a draft order', sar_test.u('dist_staff'),
  $q$UPDATE public.orders SET updated_at = now() WHERE id = '00000000-0000-0000-0000-0000000f0010'$q$, '1');
SELECT sar_test.expect_n('gap: buyer staff edits a draft order line', sar_test.u('dist_staff'),
  $q$UPDATE public.order_items SET qty = 2 WHERE id = '00000000-0000-0000-0000-0000000f0011'$q$, '1');
SELECT sar_test.expect_n('gap: issuer-org user edits a document', sar_test.u('user'),
  $q$UPDATE public.documents SET doc_no = 'FX-SO-1b' WHERE id = '00000000-0000-0000-0000-0000000f0020'$q$, '1');
SELECT sar_test.expect_n('gap: issuer-org user edits a document file', sar_test.u('user'),
  $q$UPDATE public.document_files SET file_name = 'x.pdf' WHERE id = '00000000-0000-0000-0000-0000000f0021'$q$, '1');
SELECT sar_test.expect_n('gap: MFR staff updates a reverse job', sar_test.u('mfr_staff'),
  $q$UPDATE public.qr_reverse_jobs SET progress = 5 WHERE id = '00000000-0000-0000-0000-0000000f0031'$q$, '1');
SELECT sar_test.expect_n('gap: MFR staff updates a reverse job item', sar_test.u('mfr_staff'),
  $q$UPDATE public.qr_reverse_job_items SET status = 'failed' WHERE id = '00000000-0000-0000-0000-0000000f0032'$q$, '1');
SELECT sar_test.expect_n('gap: MFR staff consumes a prepared code', sar_test.u('mfr_staff'),
  $q$UPDATE public.qr_prepared_codes SET status = 'consumed' WHERE id = '00000000-0000-0000-0000-0000000f0033'$q$, '1');
SELECT sar_test.expect_n('gap: MFR staff acknowledges an assigned adjustment', sar_test.u('mfr_staff'),
  $q$UPDATE public.stock_adjustments SET manufacturer_notes = 'ack' WHERE id = '00000000-0000-0000-0000-0000000f0040'$q$, '1');
SELECT sar_test.expect_n('gap: MFR staff records a manufacturer action', sar_test.u('mfr_staff'),
  $q$INSERT INTO public.stock_adjustment_manufacturer_actions (adjustment_id, manufacturer_org_id, action_type) VALUES ('00000000-0000-0000-0000-0000000f0040', '00000000-0000-0000-0000-00000000a012', 'acknowledged')$q$, '1');
SELECT sar_test.expect_n('gap: HQ user (no opening-balance grant) writes a classification resolution', sar_test.u('user'),
  $q$INSERT INTO public.stock_count_classification_allocation_resolutions (session_id, variant_id, target_stock_config_id) VALUES ('00000000-0000-0000-0000-0000000f0050', '00000000-0000-0000-0000-0000000e0001', sar_test.config_id())$q$, '1');
SELECT sar_test.expect_n('gap: shop staff writes return status history', sar_test.u('shop_staff'),
  $q$INSERT INTO public.return_case_status_history (return_case_id, to_status) VALUES ('00000000-0000-0000-0000-0000000f0060', 'return_completed')$q$, '1');
SELECT sar_test.expect_n('gap: buyer staff places an order hold', sar_test.u('dist_staff'),
  $q$INSERT INTO public.serapp_order_holds (order_id, buyer_org_id, seller_hq_id, fulfillment_warehouse_id, created_by, expires_at) VALUES ('00000000-0000-0000-0000-0000000f0010', '00000000-0000-0000-0000-00000000a011', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-000000000011', now() + interval '1 hour')$q$, '1');
SELECT sar_test.expect_n('gap: the hard-coded super@dev.com identity manages referral claims without any grant', sar_test.u('super_dev'),
  $q$UPDATE public.referral_claims SET approval_notes = 'x' WHERE id = '00000000-0000-0000-0000-0000000f0070'$q$, '1');
ROLLBACK;
