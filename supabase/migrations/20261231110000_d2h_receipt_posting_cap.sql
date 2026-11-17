-- D2H customer receipts: Finance posts at most the receipt's own amount
--
-- With partial payments each distributor payment has its own RECEIPT with its amount
-- (payload.payment_amount). Until now a receipt could be posted up to everything unpaid
-- on the order, so one receipt of RM 5,600 could take RM 11,200.
--
-- 1. fin_customer_receipt_context: 'receipt_remaining' = receipt amount - posted on it;
--    'remaining_requested' = the smaller of that and what is unpaid on the order.
-- 2. fin_post_customer_receipt: refuses more than the receipt's remaining amount, and
--    closes the receipt when its amount is fully received (patched in place).
-- 3. get_posting_preview (RECEIPT): suggests and allows at most the receipt's remaining
--    amount (patched in place).
-- 4. v_pending_gl_postings (Customer Receipt rows): amount = receipt's remaining amount.
-- 5. A D2H order also closes when the last receipt is issued after Finance has already
--    received the total (trigger on documents), not only when Finance posts.
--
-- Master data is not changed. Existing postings are not changed.

BEGIN;

-- 1 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_customer_receipt_context(p_document_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company_id   uuid := public.get_user_company_id();
    v_doc          record;
    v_order_total  numeric(18,2);
    v_suggested    numeric(18,2);
    v_doc_received numeric(18,2);
    v_order_received numeric(18,2);
    v_invoice_posted boolean;
    v_order_unpaid numeric(18,2);
    v_receipt_remaining numeric(18,2);
BEGIN
    SELECT d.id, d.order_id, d.company_id, d.status::text AS status, d.payment_percentage, d.payload,
           COALESCE(d.display_doc_no, d.doc_no) AS doc_number,
           o.order_type::text AS order_type, COALESCE(o.display_doc_no, o.order_no) AS order_no,
           o.buyer_org_id, b.org_name AS buyer_name
    INTO v_doc
    FROM public.documents d
    JOIN public.orders o ON o.id = d.order_id
    LEFT JOIN public.organizations b ON b.id = o.buyer_org_id
    WHERE d.id = p_document_id AND d.doc_type = 'RECEIPT' AND d.company_id = v_company_id;

    IF v_doc.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Receipt document not found');
    END IF;
    IF v_doc.order_type <> 'D2H' THEN
        RETURN jsonb_build_object('success', false, 'error', 'This receipt is not for a sales (D2H) order');
    END IF;

    SELECT COALESCE(SUM(line_total), 0) INTO v_order_total
    FROM public.order_items WHERE order_id = v_doc.order_id;

    -- The receipt's amount: what the distributor paid (payload), else its % of the order.
    v_suggested := COALESCE(
        NULLIF(v_doc.payload->>'payment_amount', '')::numeric,
        CASE WHEN v_doc.payment_percentage IS NOT NULL
             THEN ROUND(v_order_total * v_doc.payment_percentage / 100.0, 2) END,
        v_order_total);

    SELECT COALESCE(SUM(fp.amount), 0) INTO v_doc_received
    FROM public.fin_payments fp
    WHERE fp.document_id = p_document_id AND fp.status = 'POSTED';

    -- Received on the whole order: actual receipts, plus receipts posted the old way.
    SELECT COALESCE(SUM(fp.amount), 0) INTO v_order_received
    FROM public.fin_payments fp
    WHERE fp.order_id = v_doc.order_id AND fp.direction = 'IN' AND fp.status = 'POSTED';

    v_order_received := v_order_received + COALESCE((
        SELECT SUM(dp.posted_amount)
        FROM public.gl_document_postings dp
        JOIN public.documents r ON r.id = dp.document_id
        WHERE r.order_id = v_doc.order_id AND dp.document_type = 'RECEIPT' AND dp.posting_status = 'POSTED'
          AND NOT EXISTS (SELECT 1 FROM public.fin_payments fp WHERE fp.document_id = dp.document_id)
    ), 0);

    v_invoice_posted := EXISTS (
        SELECT 1 FROM public.gl_document_postings dp
        WHERE dp.document_type = 'SALES_INVOICE' AND dp.posting_status = 'POSTED'
          AND (dp.document_id = v_doc.order_id
               OR dp.document_id IN (SELECT i.id FROM public.documents i
                                     WHERE i.order_id = v_doc.order_id AND i.doc_type = 'INVOICE'))
    );

    v_order_unpaid := GREATEST(v_order_total - v_order_received, 0);
    v_receipt_remaining := GREATEST(v_suggested - v_doc_received, 0);

    RETURN jsonb_build_object(
        'success', true,
        'company_id', v_company_id,
        'gl_doc_type', 'RECEIPT',
        'direction', 'IN',
        'document_id', p_document_id,
        'document_number', v_doc.doc_number,
        'document_status', v_doc.status,
        'order_id', v_doc.order_id,
        'order_no', v_doc.order_no,
        'customer_org_id', v_doc.buyer_org_id,
        'customer_name', v_doc.buyer_name,
        'order_total', v_order_total,
        'requested_amount', v_suggested,
        'paid_on_document', v_doc_received,
        'receipt_remaining', v_receipt_remaining,
        'order_paid_total', v_order_received,
        'order_unpaid', v_order_unpaid,
        'remaining_requested', LEAST(v_receipt_remaining, v_order_unpaid),
        'invoice_posted', v_invoice_posted,
        'stage', CASE WHEN v_invoice_posted THEN 'SETTLEMENT' ELSE 'ADVANCE' END,
        'closed', public.fin_payment_document_closed(p_document_id)
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_customer_receipt_context(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_customer_receipt_context(uuid) TO service_role;

-- 2: fin_post_customer_receipt (patched in place) ---------------------------
DO $patch$
DECLARE
  v_def text;
  v_old text;
BEGIN
  SELECT replace(pg_get_functiondef(p.oid), E'\r', '') INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fin_post_customer_receipt';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fin_post_customer_receipt not found';
  END IF;
  IF position('receipt_remaining' IN v_def) > 0 THEN
    RETURN;  -- already applied
  END IF;

  v_old := $o$    IF p_bank_account_id IS NOT NULL THEN
        SELECT ba.id, ba.gl_account_id INTO v_bank$o$;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'fin_post_customer_receipt: bank anchor not found exactly once';
  END IF;
  v_def := replace(v_def, v_old, $n$    -- At most the receipt's own amount (what the distributor paid on it).
    IF v_amount > COALESCE((v_ctx->>'receipt_remaining')::numeric, v_amount) + 0.005 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'This receipt is for RM ' || to_char((v_ctx->>'requested_amount')::numeric, 'FM999,999,999,990.00')
                     || ' and RM ' || to_char((v_ctx->>'paid_on_document')::numeric, 'FM999,999,999,990.00')
                     || ' is already posted on it. At most RM '
                     || to_char((v_ctx->>'receipt_remaining')::numeric, 'FM999,999,999,990.00')
                     || ' can be posted on this receipt.'
        );
    END IF;

$n$ || v_old);

  v_old := $o$    v_close := COALESCE(p_closes_document, false) OR v_fully_paid;$o$;
  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'fin_post_customer_receipt: close anchor not found';
  END IF;
  v_def := replace(v_def, v_old, $n$    -- Also closed when the receipt's own amount is fully received.
    v_close := COALESCE(p_closes_document, false) OR v_fully_paid
               OR v_doc_paid >= COALESCE((v_ctx->>'requested_amount')::numeric, v_order_total) - 0.005;$n$);

  EXECUTE v_def;
END
$patch$;

-- 3: get_posting_preview, RECEIPT branch (patched in place) -----------------
DO $patch$
DECLARE
  v_def text;
  v_old text;
BEGIN
  SELECT replace(pg_get_functiondef(p.oid), E'\r', '') INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_posting_preview';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_posting_preview not found';
  END IF;
  IF position('receipt_remaining' IN v_def) > 0 THEN
    RETURN;  -- already applied
  END IF;

  v_old := $o$v_total := LEAST((v_payment_ctx->>'requested_amount')::numeric, (v_payment_ctx->>'order_unpaid')::numeric);$o$;
  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'get_posting_preview: receipt total anchor not found';
  END IF;
  v_def := replace(v_def, v_old, $n$v_total := (v_payment_ctx->>'remaining_requested')::numeric;$n$);

  v_old := $o$                'remaining_requested', (v_payment_ctx->>'order_unpaid')::numeric,
                'order_total', (v_payment_ctx->>'order_total')::numeric,
                'order_paid_total', (v_payment_ctx->>'order_paid_total')::numeric,
                'max_amount', (v_payment_ctx->>'order_unpaid')::numeric$o$;
  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'get_posting_preview: receipt extra anchor not found';
  END IF;
  v_def := replace(v_def, v_old, $n$                'remaining_requested', (v_payment_ctx->>'remaining_requested')::numeric,
                'receipt_remaining', (v_payment_ctx->>'receipt_remaining')::numeric,
                'order_unpaid', (v_payment_ctx->>'order_unpaid')::numeric,
                'order_total', (v_payment_ctx->>'order_total')::numeric,
                'order_paid_total', (v_payment_ctx->>'order_paid_total')::numeric,
                'max_amount', (v_payment_ctx->>'remaining_requested')::numeric$n$);

  EXECUTE v_def;
END
$patch$;

-- 4: v_pending_gl_postings, Customer Receipt amount --------------------------
DO $patch$
DECLARE
  v_def text;
  v_label text := '''Customer Receipt''::text AS posting_label,';
  p1 int;
  p2 int;
  v_rest text;
  v_opts text[];
BEGIN
  -- CREATE OR REPLACE VIEW resets the view's options; keep them.
  SELECT c.reloptions INTO v_opts FROM pg_class c WHERE c.oid = 'public.v_pending_gl_postings'::regclass;
  v_def := replace(pg_get_viewdef('public.v_pending_gl_postings'::regclass, true), E'\r', '');
  IF position('fin_receipt_amount_marker' IN v_def) > 0 THEN
    RETURN;  -- already applied
  END IF;
  p1 := position(v_label IN v_def);
  IF p1 = 0 OR position(v_label IN substr(v_def, p1 + length(v_label))) > 0 THEN
    RAISE EXCEPTION 'v_pending_gl_postings: Customer Receipt label not found exactly once';
  END IF;
  p1 := p1 + length(v_label);
  v_rest := substr(v_def, p1);
  p2 := position(' AS amount,' IN v_rest);
  IF p2 = 0 OR p2 > 1200 THEN
    RAISE EXCEPTION 'v_pending_gl_postings: Customer Receipt amount not found';
  END IF;

  v_def := substr(v_def, 1, p1 - 1) || $n$
    LEAST(
      GREATEST(COALESCE(( SELECT sum(oi.line_total) FROM order_items oi WHERE oi.order_id = o.id), 0::numeric)
        - COALESCE(( SELECT sum(fp.amount) FROM fin_payments fp
           WHERE fp.order_id = o.id AND fp.direction = 'IN'::text AND fp.status = 'POSTED'::text), 0::numeric), 0::numeric),
      GREATEST(COALESCE(NULLIF(d.payload ->> 'payment_amount'::text, ''::text)::numeric,
          round(COALESCE(( SELECT sum(oi.line_total) FROM order_items oi WHERE oi.order_id = o.id), 0::numeric)
                * d.payment_percentage::numeric / 100.0, 2),
          COALESCE(( SELECT sum(oi.line_total) FROM order_items oi WHERE oi.order_id = o.id), 0::numeric))
        - COALESCE(( SELECT sum(fp.amount) FROM fin_payments fp
           WHERE fp.document_id = d.id AND fp.status = 'POSTED'::text AND 'fin_receipt_amount_marker'::text <> ''::text), 0::numeric), 0::numeric)
    )$n$ || substr(v_rest, p2);

  EXECUTE 'CREATE OR REPLACE VIEW public.v_pending_gl_postings AS ' || v_def;
  IF v_opts IS NOT NULL AND array_length(v_opts, 1) > 0 THEN
    EXECUTE format('ALTER VIEW public.v_pending_gl_postings SET (%s)', array_to_string(v_opts, ', '));
  END IF;
END
$patch$;

-- 5 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_try_close_d2h_order(p_order_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  v_total numeric;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND OR o.order_type <> 'D2H' OR o.status::text IN ('closed', 'cancelled') THEN
    RETURN;
  END IF;
  v_total := public.d2h_order_total(o.id);
  IF v_total > 0
     AND public.fin_order_received_total(o.id) >= v_total - 0.005
     AND public.d2h_order_paid_amount(o.id) >= v_total - 0.005
     AND NOT EXISTS (SELECT 1 FROM public.documents d
                      WHERE d.order_id = o.id AND d.doc_type = 'PAYMENT' AND d.status = 'pending')
  THEN
    UPDATE public.orders SET status = 'closed', updated_at = now() WHERE id = o.id;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_try_close_d2h_order(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_try_close_d2h_order(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fin_close_d2h_order_when_received()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.direction = 'IN' AND NEW.status = 'POSTED' AND NEW.order_id IS NOT NULL THEN
    PERFORM public.fin_try_close_d2h_order(NEW.order_id);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fin_close_d2h_order_on_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.doc_type = 'RECEIPT' AND NEW.order_id IS NOT NULL THEN
    PERFORM public.fin_try_close_d2h_order(NEW.order_id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_fin_close_d2h_order_on_receipt ON public.documents;
CREATE TRIGGER trg_fin_close_d2h_order_on_receipt
  AFTER INSERT ON public.documents
  FOR EACH ROW WHEN (NEW.doc_type = 'RECEIPT')
  EXECUTE FUNCTION public.fin_close_d2h_order_on_receipt();

NOTIFY pgrst, 'reload schema';

COMMIT;
