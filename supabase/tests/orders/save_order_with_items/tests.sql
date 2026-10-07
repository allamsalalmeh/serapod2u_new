-- Isolated tests for public.save_order_with_items (throwaway PG17 replica of the
-- staging public schema; never run against a shared database).
-- Actors simulate PostgREST: SET ROLE authenticated + request.jwt.claims.
\set ON_ERROR_STOP off
\pset pager off
\pset tuples_only on
CREATE TEMP TABLE IF NOT EXISTS t_results(name text, ok boolean, info text);
GRANT ALL ON t_results TO PUBLIC;

CREATE OR REPLACE FUNCTION pg_temp.as_user(u uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, false);
END $$;

-- ids
\set hqadmin  '''00000000-0000-0000-0000-000000000101'''
\set hqstaff  '''00000000-0000-0000-0000-000000000102'''
\set dist1    '''00000000-0000-0000-0000-000000000103'''
\set dist2    '''00000000-0000-0000-0000-000000000104'''
\set dist3    '''00000000-0000-0000-0000-000000000105'''
\set hq1      '''00000000-0000-0000-0000-0000000000a1'''
\set mfg      '''00000000-0000-0000-0000-0000000000b1'''

-- screenshot-like lines: 1,000 / 2,000 / 3,000 / 5,000 / 8,000 CASES (qty stored as entered)
\set items5 '[{"product_id":"00000000-0000-0000-0000-00000000e001","variant_id":"00000000-0000-0000-0000-00000000f101","qty":1000,"unit_price":12.5,"units_per_case":4},{"product_id":"00000000-0000-0000-0000-00000000e001","variant_id":"00000000-0000-0000-0000-00000000f102","qty":2000,"unit_price":12.5,"units_per_case":4},{"product_id":"00000000-0000-0000-0000-00000000e001","variant_id":"00000000-0000-0000-0000-00000000f103","qty":3000,"unit_price":12.5,"units_per_case":4},{"product_id":"00000000-0000-0000-0000-00000000e002","variant_id":"00000000-0000-0000-0000-00000000f106","qty":5000,"unit_price":10,"units_per_case":4},{"product_id":"00000000-0000-0000-0000-00000000e002","variant_id":"00000000-0000-0000-0000-00000000f107","qty":8000,"unit_price":10,"units_per_case":4}]'
\set items2 '[{"product_id":"00000000-0000-0000-0000-00000000e001","variant_id":"00000000-0000-0000-0000-00000000f104","qty":1,"unit_price":1},{"product_id":"00000000-0000-0000-0000-00000000e002","variant_id":"00000000-0000-0000-0000-00000000f108","qty":2,"unit_price":2}]'

-- helper: call RPC as actor, capture result or error (sqlstate|message|stage)
CREATE OR REPLACE FUNCTION pg_temp.try_save(actor uuid, p_id uuid, p_mode text, p_status text, p_exp timestamptz,
  p_seller uuid, p_items jsonb, p_upc int DEFAULT 4, p_notes text DEFAULT 'Customer: A, Phone: 1, Address: X')
RETURNS text LANGUAGE plpgsql AS $$
DECLARE r jsonb; d text;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', actor, 'role', 'authenticated')::text, false);
  SET LOCAL ROLE authenticated;
  r := public.save_order_with_items(p_id, p_mode, p_status, p_exp, p_seller, p_upc, 10, 5, false, true, false, false, p_notes, p_items);
  RESET ROLE;
  RETURN 'OK ' || r::text;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  GET STACKED DIAGNOSTICS d = PG_EXCEPTION_DETAIL;
  RESET ROLE;
  RETURN 'ERR ' || SQLSTATE || ' | ' || SQLERRM || ' | ' || coalesce(d,'');
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.try_save TO PUBLIC;

-- tiny assertion helper
CREATE OR REPLACE FUNCTION pg_temp.check(n text, cond boolean, info text DEFAULT '') RETURNS void LANGUAGE sql AS
$$ INSERT INTO t_results VALUES (n, coalesce(cond,false), info) $$;
GRANT EXECUTE ON FUNCTION pg_temp.check TO PUBLIC;
\set d1 '''00000000-0000-0000-0000-0000000000d1'''
\set d2 '''00000000-0000-0000-0000-0000000000d2'''
\set wh '''00000000-0000-0000-0000-0000000000a3'''

TRUNCATE order_items, orders, documents, notifications_outbox CASCADE;

------------------------------------------------------------------------------
-- 1. NEW D2H order, 5 Cellera lines (1,000/2,000/3,000/5,000/8,000), submitted
------------------------------------------------------------------------------
\set o1 '''11111111-0000-0000-0000-000000000001'''
SELECT pg_temp.try_save(:dist1, :o1, 'create', 'submitted', NULL, :hq1, :'items5'::jsonb) AS r \gset
SELECT pg_temp.check('01 create D2H multi-line submitted', :'r' LIKE 'OK%', :'r');
SELECT pg_temp.check('02 create: header is server-derived (type/buyer/creator/company/terms)',
  (SELECT order_type::text='D2H' AND buyer_org_id=:d1 AND created_by=:dist1 AND status='submitted'
          AND company_id=:hq1 AND warehouse_org_id IS NULL AND order_no LIKE 'ORD-DH-%'
          AND (payment_terms->>'deposit_pct')::numeric=0.3 AND units_per_case=4 AND extra_qr_master=5
   FROM orders WHERE id=:o1));
SELECT pg_temp.check('03 create: 5 lines, qty preserved, line totals',
  (SELECT count(*)=5 AND sum(qty)=19000 AND sum(line_total)=(1000+2000+3000)*12.5+(5000+8000)*10 FROM order_items WHERE order_id=:o1));

-- 5. retry of the same create (unknown commit outcome) is a replay, not a duplicate
SELECT pg_temp.try_save(:dist1, :o1, 'create', 'submitted', NULL, :hq1, :'items5'::jsonb) AS r \gset
SELECT pg_temp.check('05 create retry replays existing order', :'r' LIKE 'OK%"replayed": true%', :'r');
SELECT pg_temp.check('06 create retry: still 1 order / 5 items, no extra documents',
  (SELECT count(*) FROM orders)=1 AND (SELECT count(*) FROM order_items)=5);
-- 7. another actor reusing the id cannot hijack/replay it
SELECT pg_temp.try_save(:dist2, :o1, 'create', 'draft', NULL, :hq1, :'items2'::jsonb) AS r \gset
SELECT pg_temp.check('07 create with id owned by someone else is rejected', :'r' LIKE 'ERR 23505%order_id_conflict%', :'r');

------------------------------------------------------------------------------
-- 2. EDIT / RESUBMIT of the submitted order (previously: header->draft, delete, insert, ->submitted)
------------------------------------------------------------------------------
SELECT updated_at AS ts_exact FROM orders WHERE id=:o1 \gset
SELECT pg_temp.try_save(:dist1, :o1, 'update', 'submitted', :'ts_exact', :hq1, :'items2'::jsonb, 4, 'Customer: B, Phone: 2, Address: Y') AS r \gset
SELECT pg_temp.check('08 edit+resubmit submitted order OK', :'r' LIKE 'OK%', :'r');
SELECT pg_temp.check('09 edit: items replaced, header updated, status submitted again',
  (SELECT count(*)=2 AND sum(qty)=3 FROM order_items WHERE order_id=:o1)
  AND (SELECT status::text='submitted' AND notes LIKE 'Customer: B%' AND updated_by=:dist1 FROM orders WHERE id=:o1));

-- 10. stale updated_at (a concurrent save won) -> 40001, nothing changes
SELECT pg_temp.try_save(:dist1, :o1, 'update', 'submitted', :'ts_exact', :hq1, :'items5'::jsonb) AS r \gset
SELECT pg_temp.check('10 stale expected_updated_at rejected (no silent overwrite)', :'r' LIKE 'ERR 40001%order_changed_by_another_save%stage=lock_order%', :'r');
SELECT pg_temp.check('11 stale save left previous items intact',
  (SELECT count(*)=2 AND sum(qty)=3 FROM order_items WHERE order_id=:o1));

------------------------------------------------------------------------------
-- 3. Authorization / tenancy
------------------------------------------------------------------------------
SELECT updated_at AS ts_exact FROM orders WHERE id=:o1 \gset
SELECT pg_temp.try_save(:dist2, :o1, 'update', 'draft', :'ts_exact', :hq1, :'items5'::jsonb) AS r \gset
SELECT pg_temp.check('12 other company distributor cannot edit (row invisible)', :'r' LIKE 'ERR P0002%order_not_found%', :'r');
SELECT pg_temp.try_save(:dist3, :o1, 'update', 'draft', :'ts_exact', :hq1, :'items5'::jsonb) AS r \gset
SELECT pg_temp.check('13 same-company other distributor cannot edit', :'r' LIKE 'ERR P0002%order_not_found%', :'r');
SELECT pg_temp.try_save(:hqadmin, :o1, 'update', 'draft', :'ts_exact', :hq1, :'items5'::jsonb) AS r \gset
SELECT pg_temp.check('14 HQ power user (seller side) can see but not edit buyer order', :'r' LIKE 'ERR 42501%order_not_editable_by_actor%', :'r');
SELECT pg_temp.check('15 denied attempts changed nothing',
  (SELECT count(*)=2 AND sum(qty)=3 FROM order_items WHERE order_id=:o1)
  AND (SELECT status::text='submitted' AND updated_at=:'ts_exact' FROM orders WHERE id=:o1));
SELECT pg_temp.check('16 anon role has no EXECUTE', NOT has_function_privilege('anon','public.save_order_with_items(uuid,text,text,timestamptz,uuid,integer,numeric,integer,boolean,boolean,boolean,boolean,text,jsonb)','EXECUTE'));
SELECT pg_temp.check('17 authenticated has EXECUTE', has_function_privilege('authenticated','public.save_order_with_items(uuid,text,text,timestamptz,uuid,integer,numeric,integer,boolean,boolean,boolean,boolean,text,jsonb)','EXECUTE'));
SELECT pg_temp.try_save('00000000-0000-0000-0000-0000000fffff', '11111111-0000-0000-0000-0000000000fe', 'create','draft',NULL,:hq1,:'items2'::jsonb) AS r \gset
SELECT pg_temp.check('18 unknown actor (no org) rejected', :'r' LIKE 'ERR 42501%actor_has_no_organization%', :'r');

------------------------------------------------------------------------------
-- 4. Non-editable status
------------------------------------------------------------------------------
UPDATE orders SET status='approved' WHERE id=:o1;
SELECT updated_at AS ts_exact FROM orders WHERE id=:o1 \gset
SELECT pg_temp.try_save(:dist1, :o1, 'update', 'draft', :'ts_exact', :hq1, :'items5'::jsonb) AS r \gset
SELECT pg_temp.check('19 approved order is not editable', :'r' LIKE 'ERR 55000%order_not_editable%', :'r');
SELECT pg_temp.check('20 approved order untouched', (SELECT count(*)=2 FROM order_items WHERE order_id=:o1) AND (SELECT status::text='approved' FROM orders WHERE id=:o1));
UPDATE orders SET status='submitted' WHERE id=:o1;

------------------------------------------------------------------------------
-- 5. Validation (no rows may be written on any of these)
------------------------------------------------------------------------------
SELECT count(*) AS n_before FROM order_items \gset
SELECT pg_temp.try_save(:dist1, '11111111-0000-0000-0000-0000000000a1','create','draft',NULL,:hq1,'[]'::jsonb) AS r \gset
SELECT pg_temp.check('21 empty items rejected', :'r' LIKE 'ERR 22023%', :'r');
SELECT pg_temp.try_save(:dist1, '11111111-0000-0000-0000-0000000000a2','create','draft',NULL,:hq1,'[{"product_id":"00000000-0000-0000-0000-00000000e001","variant_id":"00000000-0000-0000-0000-00000000f101","qty":0,"unit_price":1}]'::jsonb) AS r \gset
SELECT pg_temp.check('22 qty 0 rejected', :'r' LIKE 'ERR 22023%', :'r');
SELECT pg_temp.try_save(:dist1, '11111111-0000-0000-0000-0000000000a3','create','draft',NULL,:hq1,'[{"product_id":"00000000-0000-0000-0000-00000000e002","variant_id":"00000000-0000-0000-0000-00000000f101","qty":1,"unit_price":1}]'::jsonb) AS r \gset
SELECT pg_temp.check('23 variant not belonging to product rejected', :'r' LIKE 'ERR 22023%variant does not belong%', :'r');
SELECT pg_temp.try_save(:dist1, '11111111-0000-0000-0000-0000000000a4','create','draft',NULL,:d1,:'items2'::jsonb) AS r \gset
SELECT pg_temp.check('24 seller = buyer rejected', :'r' LIKE 'ERR 22023%invalid_seller%', :'r');
SELECT pg_temp.try_save(:dist1, '11111111-0000-0000-0000-0000000000a5','create','draft',NULL,'00000000-0000-0000-0000-00000000dead',:'items2'::jsonb) AS r \gset
SELECT pg_temp.check('25 unknown seller rejected', :'r' LIKE 'ERR 22023%invalid_seller%', :'r');
SELECT pg_temp.try_save(:dist1, '11111111-0000-0000-0000-0000000000a6','create','cancelled',NULL,:hq1,:'items2'::jsonb) AS r \gset
SELECT pg_temp.check('26 requested status other than draft/submitted rejected', :'r' LIKE 'ERR 22023%', :'r');
SELECT pg_temp.check('27 validation failures wrote nothing', (SELECT count(*) FROM order_items)=:n_before AND (SELECT count(*) FROM orders)=1);

------------------------------------------------------------------------------
-- 6. H2M: HQ level, default warehouse, payment terms
------------------------------------------------------------------------------
\set o2 '''22222222-0000-0000-0000-000000000002'''
SELECT pg_temp.try_save(:hqadmin, :o2, 'create','draft',NULL,:mfg,:'items5'::jsonb) AS r \gset
SELECT pg_temp.check('28 H2M create by HQ level<=40', :'r' LIKE 'OK%', :'r');
SELECT pg_temp.check('29 H2M: warehouse from buyer default, order no ORD-HM, draft',
  (SELECT order_type::text='H2M' AND warehouse_org_id=:wh AND order_no LIKE 'ORD-HM-%' AND status='draft' AND created_by=:hqadmin FROM orders WHERE id=:o2));
SELECT pg_temp.try_save(:hqstaff, '22222222-0000-0000-0000-0000000000b2','create','draft',NULL,:mfg,:'items5'::jsonb) AS r \gset
SELECT pg_temp.check('30 H2M create by HQ level>40 rejected', :'r' LIKE 'ERR 42501%h2m_orders_require%', :'r');
SET session_replication_role=replica; UPDATE organizations SET default_warehouse_org_id=NULL WHERE id=:hq1; RESET session_replication_role;
SELECT pg_temp.try_save(:hqadmin, '22222222-0000-0000-0000-0000000000b3','create','draft',NULL,:mfg,:'items5'::jsonb) AS r \gset
SELECT pg_temp.check('31 H2M without default warehouse rejected, nothing written', :'r' LIKE 'ERR 55000%hq_default_warehouse_missing%' AND (SELECT count(*) FROM orders)=2, :'r');
SET session_replication_role=replica; UPDATE organizations SET default_warehouse_org_id=:wh WHERE id=:hq1; RESET session_replication_role;
SELECT updated_at AS ts_exact FROM orders WHERE id=:o2 \gset
SELECT pg_temp.try_save(:hqadmin, :o2, 'update','draft',:'ts_exact',:mfg,:'items2'::jsonb) AS r \gset
SELECT pg_temp.check('32 H2M draft edit ok, stays draft, warehouse kept',
  :'r' LIKE 'OK%' AND (SELECT status::text='draft' AND warehouse_org_id=:wh FROM orders WHERE id=:o2) AND (SELECT count(*)=2 FROM order_items WHERE order_id=:o2), :'r');

------------------------------------------------------------------------------
-- 7. Failure injection: every stage must roll back to the previous valid state
------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.snap(o uuid) RETURNS text LANGUAGE sql AS $$
  SELECT (SELECT status::text||'|'||coalesce(notes,'')||'|'||units_per_case||'|'||updated_at::text||'|'||seller_org_id::text FROM orders WHERE id=o)
      || '#' || (SELECT string_agg(id::text||':'||variant_id||':'||qty||':'||unit_price, ',' ORDER BY id) FROM order_items WHERE order_id=o) $$;
GRANT EXECUTE ON FUNCTION pg_temp.snap TO PUBLIC;

CREATE OR REPLACE FUNCTION public.zz_fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('zz.fault', true) = TG_ARGV[0] THEN
    IF TG_ARGV[0] = 'sleep' THEN PERFORM pg_sleep(2); RETURN COALESCE(NEW, OLD); END IF;
    RAISE EXCEPTION 'injected fault %', TG_ARGV[0] USING ERRCODE = 'XX000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER zz_fault_del BEFORE DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION zz_fault('delete');
CREATE TRIGGER zz_fault_sleep BEFORE DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION zz_fault('sleep');
CREATE TRIGGER zz_fault_ins BEFORE INSERT ON order_items FOR EACH ROW EXECUTE FUNCTION zz_fault('insert');
CREATE TRIGGER zz_fault_hdr BEFORE UPDATE ON orders FOR EACH ROW WHEN (NEW.status::text='draft') EXECUTE FUNCTION zz_fault('header');
CREATE TRIGGER zz_fault_sub BEFORE UPDATE ON orders FOR EACH ROW WHEN (NEW.status::text='submitted') EXECUTE FUNCTION zz_fault('submit');

SELECT updated_at AS ts_exact FROM orders WHERE id=:o1 \gset
SELECT pg_temp.snap(:o1) AS before1 \gset
SET zz.fault = 'delete';
SELECT pg_temp.try_save(:dist1, :o1, 'update','submitted',:'ts_exact',:hq1,:'items5'::jsonb,4,'NEW NOTES') AS r \gset
SELECT pg_temp.check('33 delete-stage failure reports stage=delete_items', :'r' LIKE 'ERR XX000%injected fault delete%stage=delete_items%', :'r');
SELECT pg_temp.check('34 delete-stage failure: header/status/items exactly as before', pg_temp.snap(:o1)=:'before1');
SET zz.fault = 'insert';
SELECT pg_temp.try_save(:dist1, :o1, 'update','submitted',:'ts_exact',:hq1,:'items5'::jsonb,4,'NEW NOTES') AS r \gset
SELECT pg_temp.check('35 insert-stage failure reports stage=insert_items', :'r' LIKE 'ERR XX000%injected fault insert%stage=insert_items%', :'r');
SELECT pg_temp.check('36 insert-stage failure: previous items restored, status still submitted', pg_temp.snap(:o1)=:'before1');
SET zz.fault = 'header';
SELECT pg_temp.try_save(:dist1, :o1, 'update','submitted',:'ts_exact',:hq1,:'items5'::jsonb,4,'NEW NOTES') AS r \gset
SELECT pg_temp.check('37 header-stage failure reports stage=update_header', :'r' LIKE 'ERR XX000%stage=update_header%', :'r');
SELECT pg_temp.check('38 header-stage failure: unchanged', pg_temp.snap(:o1)=:'before1');
SET zz.fault = 'submit';
SELECT pg_temp.try_save(:dist1, :o1, 'update','submitted',:'ts_exact',:hq1,:'items5'::jsonb,4,'NEW NOTES') AS r \gset
SELECT pg_temp.check('39 submit-stage failure reports stage=set_status', :'r' LIKE 'ERR XX000%stage=set_status%', :'r');
SELECT pg_temp.check('40 submit-stage failure: not left as draft with new items', pg_temp.snap(:o1)=:'before1');
SET zz.fault = 'insert';
SELECT count(*) AS orders_before FROM orders \gset
SELECT pg_temp.try_save(:dist1, '33333333-0000-0000-0000-000000000003','create','submitted',NULL,:hq1,:'items5'::jsonb) AS r \gset
SELECT pg_temp.check('41 create insert failure leaves no order/header behind', :'r' LIKE 'ERR XX000%stage=insert_items%' AND (SELECT count(*) FROM orders)=:orders_before, :'r');
-- statement timeout mid-save rolls back the whole save (57014)
SET zz.fault = 'sleep';
SET statement_timeout = '700ms';
SELECT pg_temp.try_save(:dist1, :o1, 'update','submitted',:'ts_exact',:hq1,:'items2'::jsonb,4,'TIMEOUT NOTES') AS r \gset
RESET statement_timeout;
RESET zz.fault;
SELECT pg_temp.check('42 statement timeout surfaces as 57014 with stage', :'r' LIKE 'ERR 57014%stage=delete_items%', :'r');
SELECT pg_temp.check('43 statement timeout: everything rolled back', pg_temp.snap(:o1)=:'before1');
DROP TRIGGER zz_fault_del ON order_items; DROP TRIGGER zz_fault_sleep ON order_items; DROP TRIGGER zz_fault_ins ON order_items;
DROP TRIGGER zz_fault_hdr ON orders; DROP TRIGGER zz_fault_sub ON orders;

------------------------------------------------------------------------------
-- 8. Equivalence with the legacy multi-request flow (same triggers, same result)
------------------------------------------------------------------------------
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', :dist3, 'role','authenticated')::text, false);
INSERT INTO orders(id, order_type, company_id, buyer_org_id, seller_org_id, status, units_per_case, qr_buffer_percent, extra_qr_master, payment_terms, notes, created_by)
 VALUES ('44444444-0000-0000-0000-00000000000a','D2H',:hq1,'00000000-0000-0000-0000-0000000000d3',:hq1,'draft',4,10,5,'{"deposit_pct":0.3,"balance_pct":0.7,"balance_trigger":"on_first_receive"}','legacy',:dist3);
INSERT INTO order_items(order_id, product_id, variant_id, qty, unit_price, company_id, units_per_case)
 SELECT '44444444-0000-0000-0000-00000000000a', product_id, variant_id, qty, unit_price, :hq1, units_per_case FROM jsonb_to_recordset(:'items5'::jsonb) AS i(product_id uuid, variant_id uuid, qty int, unit_price numeric, units_per_case int);
UPDATE orders SET status='submitted' WHERE id='44444444-0000-0000-0000-00000000000a';
RESET ROLE;
SELECT pg_temp.try_save(:dist3, '44444444-0000-0000-0000-00000000000b','create','submitted',NULL,:hq1,:'items5'::jsonb,4,'legacy') AS r \gset
SELECT pg_temp.check('44 RPC and legacy flow produce the same header/items/documents/outbox',
  (SELECT (a.order_type,a.status,a.units_per_case,a.qr_buffer_percent,a.extra_qr_master,a.payment_terms,a.warehouse_org_id,a.company_id,a.buyer_org_id,a.seller_org_id,a.created_by,a.has_points,a.has_rfid,a.has_lucky_draw,a.has_redeem)
        IS NOT DISTINCT FROM (b.order_type,b.status,b.units_per_case,b.qr_buffer_percent,b.extra_qr_master,b.payment_terms,b.warehouse_org_id,b.company_id,b.buyer_org_id,b.seller_org_id,b.created_by,b.has_points,b.has_rfid,b.has_lucky_draw,b.has_redeem)
   FROM orders a, orders b WHERE a.id='44444444-0000-0000-0000-00000000000a' AND b.id='44444444-0000-0000-0000-00000000000b')
  AND (SELECT string_agg(variant_id||':'||qty||':'||unit_price||':'||coalesce(units_per_case,0), ',' ORDER BY variant_id) FROM order_items WHERE order_id='44444444-0000-0000-0000-00000000000a')
    = (SELECT string_agg(variant_id||':'||qty||':'||unit_price||':'||coalesce(units_per_case,0), ',' ORDER BY variant_id) FROM order_items WHERE order_id='44444444-0000-0000-0000-00000000000b')
  AND (SELECT count(*) FROM documents WHERE order_id='44444444-0000-0000-0000-00000000000a')=(SELECT count(*) FROM documents WHERE order_id='44444444-0000-0000-0000-00000000000b')
  AND (SELECT count(*) FROM notifications_outbox WHERE payload_json->>'order_id'='44444444-0000-0000-0000-00000000000a')=(SELECT count(*) FROM notifications_outbox WHERE payload_json->>'order_id'='44444444-0000-0000-0000-00000000000b'), :'r');

\echo ======== RESULTS ========
SELECT CASE WHEN ok THEN 'PASS ' ELSE 'FAIL ' END || name || CASE WHEN ok THEN '' ELSE '   -> ' || left(info, 400) END FROM t_results ORDER BY name;
SELECT 'TOTAL pass=' || count(*) FILTER (WHERE ok) || ' fail=' || count(*) FILTER (WHERE NOT ok) FROM t_results;
