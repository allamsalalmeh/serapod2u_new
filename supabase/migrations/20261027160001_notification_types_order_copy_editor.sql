-- =============================================================================
-- Notification Types — order / document display copy  (SQL EDITOR EDITION)
-- File: supabase/migrations/20261027160001_notification_types_order_copy_editor.sql
-- =============================================================================
-- Same change, same checks and same text as
-- 20261027160000_notification_types_order_copy.sql, packaged so that it is safe in
-- the Supabase SQL Editor (which keeps a history, but runs each top-level statement
-- on its own): ALL work is ONE statement (a single DO block), so it either fully
-- applies with every post-check passing, or raises an error and changes nothing.
-- Apply ONE of the two editions, not both (re-running either is harmless: rows
-- already holding the new text are not touched).
--
-- The SQL Editor does not display NOTICEs. The original wording is already
-- recorded by the read-only preflight (section "4 original wording"), e.g.
-- tmp/notification-evidence/20261027-183700-live-preflight.txt for staging — run
-- the preflight and keep its output before applying on production.
-- The final SELECT shows the 13 rows after the change.
-- Rollback: UPDATE the rows back to the text captured by the preflight.
-- =============================================================================

DO $copy$
DECLARE
  v_problem text;
  v_count integer;
  r record;
  v_ack_installed boolean := EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.documents'::regclass
       AND tgname = 'trigger_document_ack_notification'
       AND NOT tgisinternal);
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM set_config('statement_timeout', '60s', true);

  DROP TABLE IF EXISTS pg_temp._nt_copy, pg_temp._nt_before, pg_temp._ns_before;
  CREATE TEMP TABLE _nt_copy (
    event_code text PRIMARY KEY,
    new_name text,
    new_description text NOT NULL,
    requires_ack_trigger boolean NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO _nt_copy (event_code, new_name, new_description, requires_ack_trigger) VALUES
      ('order_submitted', NULL, 'When: a new order is submitted for approval (Draft → Submitted, or saved straight to Submitted). · Transaction: the order itself, on every order type — H2M purchase orders and D2H/S2D sales orders. Approval belongs to HQ, so a distributor or manufacturer is only informed.', false),
      ('order_approved', NULL, 'When: HQ approves a submitted order. The same approval also creates the order''s documents. · Transaction: the order itself, on every order type (H2M, D2H, S2D).', false),
      ('order_rejected', NULL, 'When: a submitted order is rejected, or an order is cancelled — both are sent as this one event. · Transaction: the order itself, on every order type. The message says which of the two happened.', false),
      ('order_closed', NULL, 'When: an order reaches Closed, normally when the final payment is acknowledged. · Transaction: the order itself, on every order type.', false),
      ('qr_batch_generated', NULL, 'When: every QR code for an order batch has been generated and the Excel file is ready. · Transaction: the QR batch of an approved H2M order. H2M only — D2H orders do not generate QR batches.', false),
      ('manufacturer_scan_complete', 'Manufacture Completed', 'When: the manufacturer finishes production and the batch is ready for shipment. · Transaction: the QR batch of an H2M order. H2M only.', false),
      ('warehouse_received', 'Warehouse Received', 'When: warehouse receiving of a batch finishes and inventory has been updated. · Transaction: the QR batch of the H2M order. H2M only.', false),
      ('po_created', NULL, 'When: HQ approves an H2M order, which creates the PO document for the manufacturer. · Transaction: the PO document of an H2M order (issued by HQ to the manufacturer). H2M only — D2H approval creates Sales Order, Delivery Order and Invoice documents instead.', false),
      ('po_acknowledged', NULL, 'When: the manufacturer acknowledges the PO document. · Transaction: the PO document of an H2M order (HQ → manufacturer).', true),
      ('invoice_created', NULL, 'When: an invoice document is created — for D2H when HQ approves the order (or, if none exists yet, when the warehouse marks goods Ready to Ship), and for H2M when the manufacturer acknowledges the PO. · Transaction: the invoice document of the order, on both flows.', false),
      ('invoice_acknowledged', NULL, 'When: the invoice is acknowledged by the party it was issued to. · Transaction: the invoice document. For D2H the distributor acknowledges HQ''s invoice; for H2M HQ acknowledges the manufacturer''s invoice.', true),
      ('payment_received', NULL, 'When: a payment document is acknowledged. · Transaction: the payment document raised against the invoice, on both flows.', true),
      ('receipt_issued', NULL, 'When: a receipt is issued for money received — recorded from the order screen, or created automatically when a payment is acknowledged. · Transaction: the receipt document of the order, on both flows.', false);

  -- 1. Prerequisites — nothing has been changed yet.
  SELECT string_agg(c.event_code || ' (' || COALESCE(n.cnt, 0) || ' rows)', ', ' ORDER BY c.event_code)
    INTO v_problem
    FROM _nt_copy c
    LEFT JOIN (SELECT event_code, count(*) AS cnt FROM public.notification_types GROUP BY event_code) n USING (event_code)
   WHERE COALESCE(n.cnt, 0) <> 1;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'notification_types must hold each expected event exactly once; found: %', v_problem;
  END IF;

  -- Only the known updated_at trigger may fire on UPDATE; anything else could have side effects.
  SELECT string_agg(t.tgname, ', ' ORDER BY t.tgname)
    INTO v_problem
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.notification_types'::regclass
     AND NOT t.tgisinternal
     AND (t.tgtype & 16) <> 0          -- UPDATE triggers
     AND t.tgname <> 'update_notification_types_updated_at';
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected UPDATE trigger(s) on notification_types: % — review before applying', v_problem;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'public.notification_types'::regclass
       AND t.tgname = 'update_notification_types_updated_at'
       AND p.oid <> 'public.update_updated_at()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'update_notification_types_updated_at no longer calls public.update_updated_at() — review before applying';
  END IF;

  -- 2. Snapshot for the post-checks.
  CREATE TEMP TABLE _nt_before ON COMMIT DROP AS
    SELECT t.event_code, t.event_name, t.event_description, t.updated_at,
           md5((to_jsonb(t) - 'event_name' - 'event_description' - 'updated_at')::text) AS other_fields
      FROM public.notification_types t;
  CREATE TEMP TABLE _ns_before ON COMMIT DROP AS
    SELECT count(*) AS n, md5(COALESCE(string_agg(to_jsonb(s)::text, '|' ORDER BY s.id), '')) AS fp
      FROM public.notification_settings s;

  -- 3. The change.
  FOR r IN
    SELECT b.event_code, b.event_name, b.event_description
      FROM _nt_before b JOIN _nt_copy c USING (event_code)
     WHERE b.event_name IS DISTINCT FROM COALESCE(c.new_name, b.event_name)
        OR b.event_description IS DISTINCT FROM c.new_description
     ORDER BY b.event_code
  LOOP
    RAISE NOTICE 'original % | name: % | description: %', r.event_code, r.event_name, r.event_description;
  END LOOP;

  IF NOT v_ack_installed THEN
    RAISE NOTICE 'trigger_document_ack_notification is not installed: po_acknowledged, invoice_acknowledged and payment_received are left unchanged. Re-run this file after 20261030100000_supply_chain_document_notifications.sql.';
  END IF;

  UPDATE public.notification_types t
     SET event_name = COALESCE(c.new_name, t.event_name),
         event_description = c.new_description,
         updated_at = now()
    FROM _nt_copy c
   WHERE t.event_code = c.event_code
     AND (v_ack_installed OR NOT c.requires_ack_trigger)
     AND (t.event_name IS DISTINCT FROM COALESCE(c.new_name, t.event_name)
          OR t.event_description IS DISTINCT FROM c.new_description);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RAISE NOTICE 'notification_types rows updated: %', v_count;

  -- 4. Post-checks — any failure raises, and the whole DO statement is rolled back.
  -- No row added or removed.
  IF (SELECT count(*) FROM public.notification_types) <> (SELECT count(*) FROM _nt_before) THEN
    RAISE EXCEPTION 'notification_types row count changed';
  END IF;

  -- Every non-copy field of every row is unchanged.
  SELECT string_agg(b.event_code, ', ') INTO v_problem
    FROM _nt_before b
    LEFT JOIN public.notification_types t USING (event_code)
   WHERE t.event_code IS NULL
      OR md5((to_jsonb(t) - 'event_name' - 'event_description' - 'updated_at')::text) <> b.other_fields;
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'non-copy fields changed for: %', v_problem;
  END IF;

  -- Rows outside the change set are completely unchanged (name, description, updated_at).
  SELECT string_agg(b.event_code, ', ') INTO v_problem
    FROM _nt_before b
    JOIN public.notification_types t USING (event_code)
   WHERE b.event_code NOT IN (SELECT event_code FROM _nt_copy)
     AND (t.event_name IS DISTINCT FROM b.event_name
          OR t.event_description IS DISTINCT FROM b.event_description
          OR t.updated_at IS DISTINCT FROM b.updated_at);
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'rows outside the copy set changed: %', v_problem;
  END IF;

  -- Target rows hold exactly the new text (acknowledgement rows only when their trigger exists).
  SELECT string_agg(c.event_code, ', ') INTO v_problem
    FROM _nt_copy c
    JOIN public.notification_types t USING (event_code)
   WHERE (v_ack_installed OR NOT c.requires_ack_trigger)
     AND (t.event_description IS DISTINCT FROM c.new_description
          OR (c.new_name IS NOT NULL AND t.event_name IS DISTINCT FROM c.new_name));
  IF v_problem IS NOT NULL THEN
    RAISE EXCEPTION 'copy not applied for: %', v_problem;
  END IF;

  -- notification_settings untouched.
  IF (SELECT count(*) || ':' || md5(COALESCE(string_agg(to_jsonb(s)::text, '|' ORDER BY s.id), '')) FROM public.notification_settings s)
     <> (SELECT n || ':' || fp FROM _ns_before) THEN
    RAISE EXCEPTION 'notification_settings changed during the copy migration';
  END IF;

  RAISE NOTICE 'notification_types copy: all post-checks passed';
END
$copy$;

-- Result (read-only): the 13 rows after the change.
SELECT event_code, category, event_name, event_description, updated_at
  FROM public.notification_types
 WHERE event_code IN ('order_submitted','order_approved','order_rejected','order_closed',
                      'qr_batch_generated','manufacturer_scan_complete','warehouse_received',
                      'po_created','po_acknowledged','invoice_created','invoice_acknowledged',
                      'payment_received','receipt_issued')
 ORDER BY category, event_code;
