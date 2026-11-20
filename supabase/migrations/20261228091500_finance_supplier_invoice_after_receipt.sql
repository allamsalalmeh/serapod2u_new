-- ============================================================================
-- Supplier invoice of a single-payment H2M order (Full Prepayment / Cash on
-- Delivery): shown in Pending GL Postings as soon as HQ acknowledges it, with
-- whether the goods have reached the warehouse, so Finance posts it only after
-- confirming the receipt (3-way match: PO - warehouse receipt - invoice).
--
-- Decision (pending discussion with Finance): no hard block for now. An
-- earlier draft of this file blocked the invoice until the receipt; running
-- this version removes that block.
--
-- "Received" = a warehouse receipt stock movement for the order, or a QR batch
-- of the order whose warehouse receiving has completed.
-- Note: split orders recognise the invoice from the Balance Request, which is
-- created when the manufacturer completes production (before the receipt).
-- Re-running this file is safe.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fin_order_warehouse_received(p_order_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
           SELECT 1 FROM public.stock_movements sm
            WHERE sm.reference_type = 'order'
              AND sm.reference_id::text = p_order_id::text
              AND (sm.movement_type IN ('purchase_in', 'warehouse_receive')
                   OR (sm.movement_type = 'addition' AND sm.reason = 'warehouse_receive')))
      OR EXISTS (
           SELECT 1 FROM public.qr_batches qb
            WHERE qb.order_id = p_order_id
              AND (qb.receiving_status = 'completed' OR qb.receiving_completed_at IS NOT NULL))
$function$;

-- For the Pending GL Postings page: receipt status of several orders at once.
CREATE OR REPLACE FUNCTION public.fin_orders_warehouse_received(p_order_ids uuid[])
 RETURNS TABLE(order_id uuid, received boolean)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT o.id, public.fin_order_warehouse_received(o.id)
    FROM public.orders o
   WHERE o.id = ANY (p_order_ids)
     AND o.company_id = public.get_user_company_id()
$function$;

REVOKE ALL ON FUNCTION public.fin_order_warehouse_received(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_orders_warehouse_received(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_order_warehouse_received(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_orders_warehouse_received(uuid[]) TO authenticated, service_role;

-- Remove the receipt block of the earlier draft, if it was applied.
DO $patch$
DECLARE
  v_def text;
  v_gate text := ' AND fin_order_warehouse_received(o.id)';
  v_block text := $b$    -- 3-way match: a supplier invoice (single-payment order) waits for the warehouse receipt.
    IF v_request.doc_type::text = 'INVOICE' AND NOT public.fin_order_warehouse_received(v_request.order_id) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Supplier invoice ' || COALESCE(v_request.display_doc_no, v_request.doc_no)
                     || ' can be posted after the goods are received in the warehouse.'
        );
    END IF;

$b$;
BEGIN
  v_def := replace(pg_get_viewdef('public.v_pending_gl_postings'::regclass, true), E'\r', '');
  IF position(v_gate IN v_def) > 0 THEN
    EXECUTE 'CREATE OR REPLACE VIEW public.v_pending_gl_postings AS '
            || rtrim(btrim(replace(v_def, v_gate, '')), ';');
  END IF;

  SELECT replace(pg_get_functiondef(p.oid), E'\r', '') INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_balance_request_posting_details';
  IF position(v_block IN v_def) > 0 THEN
    EXECUTE replace(v_def, v_block, '');
  ELSIF position('fin_order_warehouse_received' IN v_def) > 0 THEN
    RAISE EXCEPTION 'get_balance_request_posting_details: receipt block found but not in the expected form';
  END IF;
END
$patch$;

NOTIFY pgrst, 'reload schema';

COMMIT;
