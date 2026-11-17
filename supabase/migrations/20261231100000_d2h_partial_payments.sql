-- ============================================================================
-- D2H partial payments: the amount actually paid, any number of payments per
-- order, and the order closes when Finance has verified the full amount.
--
-- Before: one PAYMENT document per D2H order (created when the distributor
-- acknowledges the invoice); payment_acknowledge decided deposit / final by
-- counting payments, so a 50/50 or 30/70 order paid once never closed, and the
-- receipt amount came from the term percentage, not from what was paid.
--
-- 1. d2h_set_pending_payment_amount(order, amount): the distributor (or HQ
--    Admin) states the amount of the pending payment. Stored in its payload.
-- 2. d2h_record_next_payment(order, amount, proof): a further PAYMENT document
--    (PAY-...-02, -03 ...) while money is still outstanding.
-- 3. payment_acknowledge (D2H branch only): the receipt carries the amount
--    paid (default: the deposit for the first payment of a split term, else the
--    outstanding amount), never more than outstanding; numbered RCPT-..., -02...
--    The order is NOT closed here any more for D2H.
-- 4. Trigger on fin_payments: when Finance posts receipts covering the order
--    total (and every payment is acknowledged), the D2H order is closed.
-- 5. d2h_order_payment_summary(order): paid / verified / outstanding for the page.
--
-- H2M is unchanged. Master data is not changed. Re-running this file is safe.
-- ============================================================================

BEGIN;

-- Amount paid so far = receipts issued (one per acknowledged payment).
CREATE OR REPLACE FUNCTION public.d2h_order_paid_amount(p_order_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(SUM(NULLIF(r.payload->>'payment_amount', '')::numeric), 0)
    FROM public.documents r
   WHERE r.order_id = p_order_id AND r.doc_type = 'RECEIPT'
$function$;

-- Money Finance has posted as received for the order.
CREATE OR REPLACE FUNCTION public.fin_order_received_total(p_order_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(SUM(fp.amount), 0)
    FROM public.fin_payments fp
   WHERE fp.order_id = p_order_id AND fp.direction = 'IN' AND fp.status = 'POSTED'
$function$;

CREATE OR REPLACE FUNCTION public.d2h_order_total(p_order_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(SUM(line_total), 0) FROM public.order_items WHERE order_id = p_order_id
$function$;

-- The distributor (buyer) or HQ Admin may state / record D2H payments.
CREATE OR REPLACE FUNCTION public.d2h_may_record_payment(p_buyer_org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT auth.uid() IS NOT NULL AND (
         COALESCE(public.is_hq_admin(), false)
      OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.organization_id = p_buyer_org_id))
$function$;

-- 1 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.d2h_set_pending_payment_amount(p_order_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  v_doc_id uuid;
  v_outstanding numeric;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND OR o.order_type <> 'D2H' THEN
    RAISE EXCEPTION 'd2h_order_not_found' USING ERRCODE = '22023';
  END IF;
  IF NOT public.d2h_may_record_payment(o.buyer_org_id) THEN
    RAISE EXCEPTION 'not_authorized_to_record_payment' USING ERRCODE = '42501';
  END IF;

  SELECT d.id INTO v_doc_id FROM public.documents d
   WHERE d.order_id = o.id AND d.doc_type = 'PAYMENT' AND d.status = 'pending'
   ORDER BY d.created_at DESC LIMIT 1 FOR UPDATE;
  IF v_doc_id IS NULL THEN
    RAISE EXCEPTION 'no_pending_payment' USING ERRCODE = '55000';
  END IF;

  v_outstanding := public.d2h_order_total(o.id) - public.d2h_order_paid_amount(o.id);
  IF p_amount IS NULL OR p_amount <= 0 OR round(p_amount, 2) > round(v_outstanding, 2) THEN
    RAISE EXCEPTION 'invalid_payment_amount' USING ERRCODE = '22023',
      DETAIL = 'outstanding=' || round(v_outstanding, 2);
  END IF;

  UPDATE public.documents
     SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('amount', round(p_amount, 2)),
         updated_at = now()
   WHERE id = v_doc_id;

  RETURN jsonb_build_object('document_id', v_doc_id, 'amount', round(p_amount, 2));
END;
$function$;

-- 2 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.d2h_record_next_payment(p_order_id uuid, p_amount numeric, p_payment_proof_url text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  v_invoice_id uuid;
  v_count integer;
  v_outstanding numeric;
  v_doc_no text;
  v_pay_id uuid;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR o.order_type <> 'D2H' THEN
    RAISE EXCEPTION 'd2h_order_not_found' USING ERRCODE = '22023';
  END IF;
  IF o.status::text IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'order_not_open' USING ERRCODE = '55000';
  END IF;
  IF NOT public.d2h_may_record_payment(o.buyer_org_id) THEN
    RAISE EXCEPTION 'not_authorized_to_record_payment' USING ERRCODE = '42501';
  END IF;

  SELECT d.id INTO v_invoice_id FROM public.documents d
   WHERE d.order_id = o.id AND d.doc_type = 'INVOICE' AND d.status::text IN ('acknowledged', 'completed')
   ORDER BY d.created_at DESC LIMIT 1;
  IF v_invoice_id IS NULL THEN
    RAISE EXCEPTION 'invoice_not_acknowledged' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.documents d
              WHERE d.order_id = o.id AND d.doc_type = 'PAYMENT' AND d.status = 'pending') THEN
    RAISE EXCEPTION 'payment_already_pending' USING ERRCODE = '55000';
  END IF;

  v_outstanding := public.d2h_order_total(o.id) - public.d2h_order_paid_amount(o.id);
  IF v_outstanding <= 0.005 THEN
    RAISE EXCEPTION 'nothing_outstanding' USING ERRCODE = '55000';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR round(p_amount, 2) > round(v_outstanding, 2) THEN
    RAISE EXCEPTION 'invalid_payment_amount' USING ERRCODE = '22023',
      DETAIL = 'outstanding=' || round(v_outstanding, 2);
  END IF;
  IF public.is_payment_proof_required(o.company_id) AND p_payment_proof_url IS NULL THEN
    RAISE EXCEPTION 'payment_proof_required' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_count FROM public.documents d WHERE d.order_id = o.id AND d.doc_type = 'PAYMENT';
  v_doc_no := public.format_doc_no_from_order('PAY', o.order_no) || '-' || lpad((v_count + 1)::text, 2, '0');

  INSERT INTO public.documents (
    order_id, doc_type, doc_no, status,
    issued_by_org_id, issued_to_org_id,
    company_id, created_by, payload
  ) VALUES (
    o.id, 'PAYMENT', v_doc_no, 'pending',
    o.buyer_org_id, o.seller_org_id,
    o.company_id, auth.uid(),
    jsonb_build_object('invoice_id', v_invoice_id, 'amount', round(p_amount, 2), 'sequence', v_count + 1)
  )
  RETURNING id INTO v_pay_id;

  IF p_payment_proof_url IS NOT NULL THEN
    INSERT INTO public.document_files (document_id, file_url, company_id, uploaded_by)
    VALUES (v_pay_id, p_payment_proof_url, o.company_id, auth.uid());
  END IF;

  RETURN jsonb_build_object('document_id', v_pay_id, 'doc_no', v_doc_no, 'amount', round(p_amount, 2));
END;
$function$;

-- 3: payment_acknowledge - D2H branch (patched in place) ---------------------
DO $patch$
DECLARE
  v_def text;
  v_old text;
BEGIN
  SELECT replace(pg_get_functiondef(p.oid), E'\r', '') INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'payment_acknowledge';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'payment_acknowledge not found';
  END IF;
  IF position('d2h_order_paid_amount' IN v_def) > 0 THEN
    RETURN;  -- already applied
  END IF;

  v_old := $o$  v_receipt_doc_no text;
BEGIN$o$;
  IF position(v_old IN v_def) = 0 THEN RAISE EXCEPTION 'payment_acknowledge: declare anchor not found'; END IF;
  v_def := replace(v_def, v_old, $n$  v_receipt_doc_no text;
  v_paid_before numeric := 0;
  v_d2h boolean := false;
BEGIN$n$);

  v_old := $o$  IF v_is_split THEN
    IF v_ack_cnt >= 1 THEN$o$;
  IF position(v_old IN v_def) = 0 THEN RAISE EXCEPTION 'payment_acknowledge: split anchor not found'; END IF;
  v_def := replace(v_def, v_old, $n$  IF o.order_type = 'D2H' THEN
    -- D2H: any number of payments of the amount actually paid (payload amount);
    -- default: the deposit for the first payment of a split term, else what is outstanding.
    -- The order closes when Finance has verified the total (trigger on fin_payments).
    v_d2h := true;
    v_paid_before := public.d2h_order_paid_amount(o.id);
    v_receipt_amount := COALESCE(v_parsed_amount,
      CASE WHEN v_is_split AND v_ack_cnt = 0 THEN v_deposit_amount ELSE v_order_total - v_paid_before END);
    v_receipt_amount := LEAST(GREATEST(v_receipt_amount, 0), GREATEST(v_order_total - v_paid_before, 0));
    IF v_receipt_amount <= 0 THEN
      RAISE EXCEPTION 'This order is already fully paid';
    END IF;
    v_is_final := v_paid_before + v_receipt_amount >= v_order_total - 0.005;
    v_is_deposit := NOT v_is_final;
    v_payment_percentage := CASE
      WHEN v_is_final OR v_order_total <= 0 THEN 100
      ELSE LEAST(99, GREATEST(ROUND(v_receipt_amount / v_order_total * 100)::int, 1)) END;
    v_doc_suffix := CASE WHEN v_ack_cnt = 0 THEN '' ELSE '-' || lpad((v_ack_cnt + 1)::text, 2, '0') END;
  ELSIF v_is_split THEN
    IF v_ack_cnt >= 1 THEN$n$);

  v_old := $o$  IF v_is_final THEN
    UPDATE public.orders$o$;
  IF position(v_old IN v_def) = 0 THEN RAISE EXCEPTION 'payment_acknowledge: close anchor not found'; END IF;
  v_def := replace(v_def, v_old, $n$  IF v_is_final AND NOT v_d2h THEN
    UPDATE public.orders$n$);

  EXECUTE v_def;
END
$patch$;

-- 4 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_close_d2h_order_when_received()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  o public.orders%ROWTYPE;
  v_total numeric;
BEGIN
  IF NEW.direction <> 'IN' OR NEW.status <> 'POSTED' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO o FROM public.orders WHERE id = NEW.order_id;
  IF NOT FOUND OR o.order_type <> 'D2H' OR o.status::text IN ('closed', 'cancelled') THEN
    RETURN NEW;
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
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_fin_close_d2h_order_when_received ON public.fin_payments;
CREATE TRIGGER trg_fin_close_d2h_order_when_received
  AFTER INSERT OR UPDATE OF status ON public.fin_payments
  FOR EACH ROW EXECUTE FUNCTION public.fin_close_d2h_order_when_received();

-- 5 -------------------------------------------------------------------------
-- Invoker: the order is read under the caller's RLS; nothing is returned for an order they cannot see.
CREATE OR REPLACE FUNCTION public.d2h_order_payment_summary(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  o record;
  v_total numeric;
  v_paid numeric;
  v_verified numeric;
  v_pending record;
  v_invoice_ack boolean;
BEGIN
  SELECT id, order_type, status, buyer_org_id INTO o FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND OR o.order_type <> 'D2H' THEN
    RETURN NULL;
  END IF;
  v_total := public.d2h_order_total(o.id);
  v_paid := public.d2h_order_paid_amount(o.id);
  v_verified := public.fin_order_received_total(o.id);
  SELECT d.id, d.doc_no, d.display_doc_no, NULLIF(d.payload->>'amount', '')::numeric AS amount INTO v_pending
    FROM public.documents d
   WHERE d.order_id = o.id AND d.doc_type = 'PAYMENT' AND d.status = 'pending'
   ORDER BY d.created_at DESC LIMIT 1;
  v_invoice_ack := EXISTS (SELECT 1 FROM public.documents d
                            WHERE d.order_id = o.id AND d.doc_type = 'INVOICE' AND d.status::text IN ('acknowledged', 'completed'));
  RETURN jsonb_build_object(
    'order_total', round(v_total, 2),
    'paid', round(v_paid, 2),
    'verified', round(v_verified, 2),
    'outstanding', round(GREATEST(v_total - v_paid, 0), 2),
    'pending_payment_id', v_pending.id,
    'pending_payment_no', COALESCE(v_pending.display_doc_no, v_pending.doc_no),
    'pending_amount', v_pending.amount,
    'invoice_acknowledged', v_invoice_ack,
    'order_status', o.status,
    'can_record', public.d2h_may_record_payment(o.buyer_org_id)
      AND o.status::text NOT IN ('closed', 'cancelled')
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.d2h_order_paid_amount(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_order_received_total(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.d2h_order_total(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.d2h_may_record_payment(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.d2h_set_pending_payment_amount(uuid, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.d2h_record_next_payment(uuid, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.d2h_order_payment_summary(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_close_d2h_order_when_received() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.d2h_order_paid_amount(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_order_received_total(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.d2h_order_total(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.d2h_may_record_payment(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.d2h_set_pending_payment_amount(uuid, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.d2h_record_next_payment(uuid, numeric, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.d2h_order_payment_summary(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
