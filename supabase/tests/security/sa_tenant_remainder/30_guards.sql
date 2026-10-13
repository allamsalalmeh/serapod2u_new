-- ============================================================================
-- AFTER 20261021100000. Each statement is its own transaction (autocommit), as PostgREST requests are.
-- ============================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------- SHADOW / LEGACY_ENFORCED: no S&A refusal anywhere
SELECT sar_test.set_modes('SHADOW');
SELECT sar_test.expect_n('shadow: shop staff edits its link (legacy RLS decides, unchanged)', sar_test.u('shop_staff'),
  $q$UPDATE public.shop_distributors SET payment_terms = 'NET_7' WHERE shop_id = '00000000-0000-0000-0000-00000000a014'$q$, '1');
SELECT sar_test.expect_n('shadow: shop staff changes its bank account holder (unchanged)', sar_test.u('shop_staff'),
  $q$UPDATE public.organizations SET bank_account_holder_name = 'Shadow' WHERE id = '00000000-0000-0000-0000-00000000a014'$q$, '1');
SELECT sar_test.expect_n('shadow: issuer-org user edits a document (unchanged)', sar_test.u('user'),
  $q$UPDATE public.documents SET doc_no = 'FX-SO-shadow' WHERE id = '00000000-0000-0000-0000-0000000f0020'$q$, '1');
SELECT sar_test.expect_n('shadow: HQ user writes a classification resolution (unchanged)', sar_test.u('user'),
  $q$INSERT INTO public.stock_count_classification_allocation_resolutions (session_id, variant_id, target_stock_config_id) VALUES ('00000000-0000-0000-0000-0000000f0050', '00000000-0000-0000-0000-0000000e0001', sar_test.config_id())$q$, '1');
-- Workflow-only tables are mode-independent, like return_cases already is.
SELECT sar_test.expect_n('workflow-only: API role cannot write return status history in any mode', sar_test.u('shop_staff'),
  $q$INSERT INTO public.return_case_status_history (return_case_id, to_status) VALUES ('00000000-0000-0000-0000-0000000f0060', 'return_completed')$q$,
  'ERR:42501:return_case_status_history_writes_require_workflow');
SELECT sar_test.expect_eq('shadow: the decision helper is a no-op for anon (an anonymous write keeps its RLS outcome)',
  sar_test.try_as('anon', NULL, $q$SELECT public.sa_api_require_any(array['customer.shop.manage'], array['{}'::jsonb], 'x')$q$), 'OK');
SELECT sar_test.expect_ok('service role still writes return status history', 'service_role', NULL,
  $q$INSERT INTO public.return_case_status_history (return_case_id, to_status) VALUES ('00000000-0000-0000-0000-0000000f0060', 'return_completed')$q$);

-- ---------------------------------------------------------------- NEW_ENFORCED
SELECT sar_test.set_modes('NEW_ENFORCED');

-- shop_distributors (customer.shop.manage)
SELECT sar_test.expect_n('enforced: shop staff without grant cannot edit its link', sar_test.u('shop_staff'),
  $q$UPDATE public.shop_distributors SET payment_terms = 'NET_30' WHERE shop_id = '00000000-0000-0000-0000-00000000a014'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: DIST B manager (gate passes at its own org) cannot edit DIST A''s link', sar_test.u('distb_mgr'),
  $q$UPDATE public.shop_distributors SET payment_terms = 'NET_30' WHERE shop_id = '00000000-0000-0000-0000-00000000a014'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: HQ A manager (grant at HQ A covers the shop by ancestry) edits the link', sar_test.u('hq_mgr'),
  $q$UPDATE public.shop_distributors SET payment_terms = 'NET_30' WHERE shop_id = '00000000-0000-0000-0000-00000000a014'$q$, '1');
SELECT sar_test.expect_n('enforced: shop staff can still save its organization settings (sync trigger re-inserts the link, not re-checked)',
  sar_test.u('shop_staff'), $q$UPDATE public.organizations SET settings = '{"fx": true}'::jsonb WHERE id = '00000000-0000-0000-0000-00000000a014'$q$, '1');

-- distributor_products / product_images (product.catalog.manage)
SELECT sar_test.expect_n('enforced: distributor staff cannot edit an agreement', sar_test.u('dist_staff'),
  $q$UPDATE public.distributor_products SET min_order_quantity = 6 WHERE id = '00000000-0000-0000-0000-0000000f0001'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: HQ A manager edits the agreement', sar_test.u('hq_mgr'),
  $q$UPDATE public.distributor_products SET min_order_quantity = 6 WHERE id = '00000000-0000-0000-0000-0000000f0001'$q$, '1');
SELECT sar_test.expect_n('enforced: MFR user without grant cannot edit a product image', sar_test.u('mfr_staff'),
  $q$UPDATE public.product_images SET title = 'y' WHERE id = '00000000-0000-0000-0000-0000000f0002'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: … nor add one', sar_test.u('mfr_staff'),
  $q$INSERT INTO public.product_images (product_id, image_url) VALUES ('00000000-0000-0000-0000-0000000d0001', 'https://img.test/2.png')$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: HQ A manager edits the image', sar_test.u('hq_mgr'),
  $q$UPDATE public.product_images SET title = 'y' WHERE id = '00000000-0000-0000-0000-0000000f0002'$q$, '1');

-- organizations (platform.organization.manage, structural / banking columns only)
SELECT sar_test.expect_n('enforced: shop staff cannot change its bank account holder', sar_test.u('shop_staff'),
  $q$UPDATE public.organizations SET bank_account_holder_name = 'Someone else' WHERE id = '00000000-0000-0000-0000-00000000a014'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: … nor deactivate its organization', sar_test.u('shop_staff'),
  $q$UPDATE public.organizations SET is_active = false WHERE id = '00000000-0000-0000-0000-00000000a014'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: … but contact details keep tenant RLS', sar_test.u('shop_staff'),
  $q$UPDATE public.organizations SET contact_name = 'Front desk' WHERE id = '00000000-0000-0000-0000-00000000a014'$q$, '1');
SELECT sar_test.expect_n('enforced: … and resending unchanged structural values is not a change', sar_test.u('shop_staff'),
  $q$UPDATE public.organizations SET is_active = true, org_type_code = 'SHOP', contact_title = 'x' WHERE id = '00000000-0000-0000-0000-00000000a014'$q$, '1');

-- orders / order_items (supply_chain.order.create)
SELECT sar_test.expect_n('enforced: buyer staff without grant cannot edit a draft order', sar_test.u('dist_staff'),
  $q$UPDATE public.orders SET updated_at = now() WHERE id = '00000000-0000-0000-0000-0000000f0010'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: … nor delete it', sar_test.u('dist_staff'),
  $q$DELETE FROM public.orders WHERE id = '00000000-0000-0000-0000-0000000f0010'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: … nor edit its lines', sar_test.u('dist_staff'),
  $q$UPDATE public.order_items SET qty = 3 WHERE id = '00000000-0000-0000-0000-0000000f0011'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: … nor add a line', sar_test.u('dist_staff'),
  $q$INSERT INTO public.order_items (order_id, product_id, variant_id, qty, unit_price, company_id) VALUES ('00000000-0000-0000-0000-0000000f0010', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000e0001', 1, 10, '00000000-0000-0000-0000-00000000a001')$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: HQ A manager (seller side) edits the order', sar_test.u('hq_mgr'),
  $q$UPDATE public.orders SET updated_at = now() WHERE id = '00000000-0000-0000-0000-0000000f0010'$q$, '1');
SELECT sar_test.expect_n('enforced: … and its line', sar_test.u('hq_mgr'),
  $q$UPDATE public.order_items SET qty = 3 WHERE id = '00000000-0000-0000-0000-0000000f0011'$q$, '1');

-- documents / document_files (supply_chain.document.manage; acknowledgement stays with the existing guard)
SELECT sar_test.expect_n('enforced: issuer-org user without grant cannot edit a document', sar_test.u('user'),
  $q$UPDATE public.documents SET doc_no = 'FX-SO-x' WHERE id = '00000000-0000-0000-0000-0000000f0020'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: … nor its file', sar_test.u('user'),
  $q$UPDATE public.document_files SET file_name = 'y.pdf' WHERE id = '00000000-0000-0000-0000-0000000f0021'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: HQ A manager edits the document', sar_test.u('hq_mgr'),
  $q$UPDATE public.documents SET doc_no = 'FX-SO-2' WHERE id = '00000000-0000-0000-0000-0000000f0020'$q$, '1');
SELECT sar_test.expect_n('enforced: … and its file', sar_test.u('hq_mgr'),
  $q$UPDATE public.document_files SET file_name = 'y.pdf' WHERE id = '00000000-0000-0000-0000-0000000f0021'$q$, '1');
SELECT sar_test.expect_n('enforced: recipient with acknowledge-only grant still acknowledges a payment (no manage needed)', sar_test.u('dist_staff'),
  $q$UPDATE public.documents SET status = 'acknowledged', acknowledged_by = '00000000-0000-0000-0000-000000000011', acknowledged_at = now() WHERE id = '00000000-0000-0000-0000-0000000f0022'$q$, '1');

-- reverse jobs / items / prepared codes (manufacturing.scan.reverse | manufacturing.production.manage)
SELECT sar_test.expect_n('enforced: MFR staff without grant cannot update a reverse job', sar_test.u('mfr_staff'),
  $q$UPDATE public.qr_reverse_jobs SET progress = 6 WHERE id = '00000000-0000-0000-0000-0000000f0031'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: … nor create one', sar_test.u('mfr_staff'),
  $q$INSERT INTO public.qr_reverse_jobs (batch_id, order_id, manufacturer_org_id) VALUES ('00000000-0000-0000-0000-0000000f0030', '00000000-0000-0000-0000-0000000f0010', '00000000-0000-0000-0000-00000000a012')$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: … nor update an item', sar_test.u('mfr_staff'),
  $q$UPDATE public.qr_reverse_job_items SET status = 'failed' WHERE id = '00000000-0000-0000-0000-0000000f0032'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: … nor consume a prepared code', sar_test.u('mfr_staff'),
  $q$UPDATE public.qr_prepared_codes SET status = 'consumed' WHERE id = '00000000-0000-0000-0000-0000000f0033'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: MFR operator with production grant (MODEC routes) updates the job', sar_test.u('mfr_op'),
  $q$UPDATE public.qr_reverse_jobs SET progress = 6 WHERE id = '00000000-0000-0000-0000-0000000f0031'$q$, '1');
SELECT sar_test.expect_n('enforced: … creates a job for its manufacturer', sar_test.u('mfr_op'),
  $q$INSERT INTO public.qr_reverse_jobs (batch_id, order_id, manufacturer_org_id) VALUES ('00000000-0000-0000-0000-0000000f0030', '00000000-0000-0000-0000-0000000f0010', '00000000-0000-0000-0000-00000000a012')$q$, '1');
SELECT sar_test.expect_n('enforced: … updates an item', sar_test.u('mfr_op'),
  $q$UPDATE public.qr_reverse_job_items SET status = 'failed' WHERE id = '00000000-0000-0000-0000-0000000f0032'$q$, '1');
SELECT sar_test.expect_n('enforced: … consumes a prepared code', sar_test.u('mfr_op'),
  $q$UPDATE public.qr_prepared_codes SET status = 'consumed' WHERE id = '00000000-0000-0000-0000-0000000f0033'$q$, '1');

-- stock_adjustments (manufacturing.adjustment.manage) + workflow-only manufacturer actions
SELECT sar_test.expect_n('enforced: MFR staff without grant cannot acknowledge an adjustment', sar_test.u('mfr_staff'),
  $q$UPDATE public.stock_adjustments SET manufacturer_notes = 'ack' WHERE id = '00000000-0000-0000-0000-0000000f0040'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: production-only operator cannot either', sar_test.u('mfr_op'),
  $q$UPDATE public.stock_adjustments SET manufacturer_notes = 'ack' WHERE id = '00000000-0000-0000-0000-0000000f0040'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: HQ user without grant cannot report an adjustment', sar_test.u('user'),
  $q$INSERT INTO public.stock_adjustments (organization_id, status) VALUES ('00000000-0000-0000-0000-00000000a001', 'pending')$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: HQ A manager reports an adjustment', sar_test.u('hq_mgr'),
  $q$INSERT INTO public.stock_adjustments (organization_id, status) VALUES ('00000000-0000-0000-0000-00000000a001', 'pending')$q$, '1');
SELECT sar_test.expect_n('workflow-only: manufacturer actions are service-role only', sar_test.u('hq_mgr'),
  $q$INSERT INTO public.stock_adjustment_manufacturer_actions (adjustment_id, manufacturer_org_id, action_type) VALUES ('00000000-0000-0000-0000-0000000f0040', '00000000-0000-0000-0000-00000000a012', 'acknowledged')$q$,
  'ERR:42501:stock_adjustment_manufacturer_actions_writes_require_workflow');
SELECT sar_test.expect_n('workflow-only: order holds are service-role only', sar_test.u('hq_mgr'),
  $q$INSERT INTO public.serapp_order_holds (order_id, buyer_org_id, seller_hq_id, fulfillment_warehouse_id, created_by, expires_at) VALUES ('00000000-0000-0000-0000-0000000f0010', '00000000-0000-0000-0000-00000000a011', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-000000000014', now() + interval '1 hour')$q$,
  'ERR:42501:serapp_order_holds_writes_require_workflow');
SELECT sar_test.expect_ok('service role still places an order hold', 'service_role', NULL,
  $q$INSERT INTO public.serapp_order_holds (order_id, buyer_org_id, seller_hq_id, fulfillment_warehouse_id, created_by, expires_at) VALUES ('00000000-0000-0000-0000-0000000f0010', '00000000-0000-0000-0000-00000000a011', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-000000000014', now() + interval '1 hour')$q$);

-- classification allocation resolutions (inventory.opening_balance.manage at the session warehouse)
SELECT sar_test.expect_n('enforced: HQ user without grant cannot write a resolution', sar_test.u('user'),
  $q$DELETE FROM public.stock_count_classification_allocation_resolutions WHERE session_id = '00000000-0000-0000-0000-0000000f0050'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.expect_n('enforced: HQ A manager (grant covers WH A1) rewrites the resolutions', sar_test.u('hq_mgr'),
  $q$DELETE FROM public.stock_count_classification_allocation_resolutions WHERE session_id = '00000000-0000-0000-0000-0000000f0050'$q$, '1');

-- referral_claims: the hard-coded identity no longer passes; anon refused everywhere
SELECT sar_test.expect_n('enforced: super@dev.com without a grant no longer manages referral claims (RLS filters the row)', sar_test.u('super_dev'),
  $q$UPDATE public.referral_claims SET approval_notes = 'y' WHERE id = '00000000-0000-0000-0000-0000000f0070'$q$, '0');
-- The helpers answer only for the caller and never leak parent rows.
SELECT sar_test.expect_err('enforced: anon gets a denial from the decision helper', 'anon', NULL,
  $q$SELECT public.sa_api_require_any(array['customer.shop.manage'], array['{"organization_id":"00000000-0000-0000-0000-00000000a014"}'::jsonb], 'x')$q$, 'sa_authorization_required');
SELECT sar_test.expect_err('an unauthorized caller only learns "denied" from the resolver', 'authenticated', sar_test.u('shop_staff'),
  $q$SELECT public.sa_api_require_resource(array['supply_chain.order.create'], 'order', '00000000-0000-0000-0000-0000000f0010')$q$, 'sa_authorization_required');

-- LEGACY_RETIRED behaves like NEW_ENFORCED.
SELECT sar_test.set_modes('LEGACY_RETIRED');
SELECT sar_test.expect_n('retired: buyer staff without grant still cannot edit the order', sar_test.u('dist_staff'),
  $q$UPDATE public.orders SET updated_at = now() WHERE id = '00000000-0000-0000-0000-0000000f0010'$q$, 'ERR:42501:sa_authorization_required');
SELECT sar_test.set_modes('SHADOW');
