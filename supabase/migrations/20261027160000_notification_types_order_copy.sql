-- =============================================================================
-- Notification Types — order / document display copy
-- File: supabase/migrations/20261027160000_notification_types_order_copy.sql
-- Authoritative wording migration (the only one; no 20261028120000 file exists).
-- =============================================================================
-- What it changes
--   notification_types.event_name        2 rows (manufacturer_scan_complete,
--                                        warehouse_received)
--   notification_types.event_description 13 rows (order/document events)
--   notification_types.updated_at        the rows actually changed
-- The text is identical to app/src/lib/notifications/notificationOrderCopy.ts
-- (a unit test compares them).
--
-- What it never changes (asserted below, not only promised)
--   every other notification_types column (category = routing key,
--   default_enabled, available_channels, is_system, sort_order,
--   default_template_code, ...), every other notification_types row, and the
--   whole of notification_settings (enabled, channels, recipients, templates,
--   routing). It adds no trigger and no function.
--
-- Acknowledgement events
--   po_acknowledged, invoice_acknowledged and payment_received only fire once
--   20261030100000_supply_chain_document_notifications.sql is applied. Their
--   new description is written only if that migration's trigger exists;
--   otherwise they are left as they are and a NOTICE says so. Re-run this file
--   after the trigger migration to complete them.
--
-- Run as one transaction. Safe to re-run: rows already holding the new text
-- are not touched again (updated_at is kept). Fails without changing anything
-- if an expected event is missing or duplicated, or if notification_types has
-- an UPDATE trigger other than the known updated_at trigger.
--
-- Evidence: before changing anything it prints (NOTICE) the original
-- event_name / event_description of every row it changes. The preflight file
-- 20261030_notification_sql_preflight_readonly.sql returns the same rows as a
-- result set — save that output before applying.
-- Rollback: UPDATE the rows back to the text captured by the preflight.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE _nt_copy (
  event_code text PRIMARY KEY,
  new_name text,                 -- NULL = keep the stored name
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
DO $pre$
DECLARE
  v_problem text;
BEGIN
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
END
$pre$;

-- 2. Snapshot for the post-checks.
CREATE TEMP TABLE _nt_before ON COMMIT DROP AS
  SELECT t.event_code,
         t.event_name,
         t.event_description,
         t.updated_at,
         md5((to_jsonb(t) - 'event_name' - 'event_description' - 'updated_at')::text) AS other_fields
    FROM public.notification_types t;

CREATE TEMP TABLE _ns_before ON COMMIT DROP AS
  SELECT count(*) AS n, md5(COALESCE(string_agg(to_jsonb(s)::text, '|' ORDER BY s.id), '')) AS fp
    FROM public.notification_settings s;

-- 3. Evidence of the original text, then the change.
DO $apply$
DECLARE
  v_ack_installed boolean := EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.documents'::regclass
       AND tgname = 'trigger_document_ack_notification'
       AND NOT tgisinternal);
  r record;
  v_count integer;
BEGIN
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
END
$apply$;

-- 4. Post-checks — any failure rolls the whole file back.
DO $post$
DECLARE
  v_problem text;
  v_ack_installed boolean := EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.documents'::regclass
       AND tgname = 'trigger_document_ack_notification'
       AND NOT tgisinternal);
BEGIN
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
$post$;

COMMIT;
