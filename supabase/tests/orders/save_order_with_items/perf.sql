-- Before/after timing of the order-save delete path on a large qr_codes table.
-- Run once BEFORE and once AFTER 20261007100000_order_item_fk_indexes_qr_codes.sql.
-- Each timed block runs as `authenticated` with that role's real 8s statement_timeout
-- and is rolled back, so it can be repeated.
\set ON_ERROR_STOP off
\set hq1 '''00000000-0000-0000-0000-0000000000a1'''
\set items '[{"product_id":"00000000-0000-0000-0000-00000000e001","variant_id":"00000000-0000-0000-0000-00000000f101","qty":1000,"unit_price":12.5,"units_per_case":4},{"product_id":"00000000-0000-0000-0000-00000000e001","variant_id":"00000000-0000-0000-0000-00000000f102","qty":2000,"unit_price":12.5,"units_per_case":4},{"product_id":"00000000-0000-0000-0000-00000000e001","variant_id":"00000000-0000-0000-0000-00000000f103","qty":3000,"unit_price":12.5,"units_per_case":4},{"product_id":"00000000-0000-0000-0000-00000000e002","variant_id":"00000000-0000-0000-0000-00000000f106","qty":5000,"unit_price":10,"units_per_case":4},{"product_id":"00000000-0000-0000-0000-00000000e002","variant_id":"00000000-0000-0000-0000-00000000f107","qty":8000,"unit_price":10,"units_per_case":4}]'
\set u '''00000000-0000-0000-0000-000000000103'''
SELECT count(*) AS qr_rows FROM qr_codes \gset
\echo qr_codes rows: :qr_rows
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000103","role":"authenticated"}', false);
\timing on
\echo --- legacy flow, step 2 only: DELETE of 5 order_items lines (as authenticated, 8s timeout)
BEGIN; SET LOCAL ROLE authenticated; SET LOCAL statement_timeout='8s';
UPDATE orders SET status='draft' WHERE id='55555555-0000-0000-0000-000000000005';
DELETE FROM order_items WHERE order_id='55555555-0000-0000-0000-000000000005';
ROLLBACK;
\echo --- RPC update (header+delete+insert+resubmit in one transaction), 5 lines
SELECT updated_at AS ts FROM orders WHERE id='55555555-0000-0000-0000-000000000005' \gset
BEGIN; SET LOCAL ROLE authenticated; SET LOCAL statement_timeout='8s';
SELECT (public.save_order_with_items('55555555-0000-0000-0000-000000000005','update','submitted',:'ts',:hq1,4,10,5,false,true,false,false,'n',:'items'::jsonb))->>'item_count' AS saved_items;
ROLLBACK;
\timing off
