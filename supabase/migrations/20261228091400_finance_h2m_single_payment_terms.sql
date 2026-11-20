-- ============================================================================
-- Finance for H2M orders on a single-payment term (Full Prepayment 100/0 or
-- Cash on Delivery 0/100). These orders have no Balance Request
-- (PAYMENT_REQUEST), which was the only document the supplier invoice could be
-- recognised from, so their invoice never reached Pending GL Postings and a
-- prepayment stayed in 1400 Supplier Deposits.
--
-- 1. fin_terms_single_payment(terms) / fin_first_payment_share(terms):
--    a single-payment term pays 100% on its one PAYMENT document.
-- 2. v_pending_gl_postings:
--    - new branch: the acknowledged supplier INVOICE of a single-payment H2M
--      order is listed as "Supplier Invoice (100%)" (SUPPLIER_INVOICE_RECOGNITION);
--    - the payment of such an order asks for 100% (was total x deposit_pct,
--      i.e. RM 0 for Cash on Delivery) and is labelled "Supplier Payment" for COD.
-- 3. get_balance_request_posting_details accepts that INVOICE document
--    (Dr Inventory 100% / Cr Supplier Deposits = advances actually paid /
--    Cr Accounts Payable = the rest - unchanged logic).
-- 4. get_payment_posting_details: requested amount 100% for those orders.
--
-- Split orders (30/70, 50/50 ...) and D2H are not changed. Master data and
-- existing postings are not changed. Re-running this file is safe.
-- ============================================================================

BEGIN;

-- 1 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_terms_single_payment(p_terms jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT d <= 0.001 OR d >= 0.999
  FROM (SELECT CASE WHEN x > 1 THEN x / 100 ELSE x END AS d
          FROM (SELECT COALESCE((p_terms->>'deposit_pct')::numeric, 0.3) AS x) a) b
$function$;

CREATE OR REPLACE FUNCTION public.fin_first_payment_share(p_terms jsonb)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE WHEN public.fin_terms_single_payment(p_terms) THEN 1::numeric
              ELSE COALESCE((p_terms->>'deposit_pct')::numeric, 0.3) END
$function$;

GRANT EXECUTE ON FUNCTION public.fin_terms_single_payment(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_first_payment_share(jsonb) TO authenticated, service_role;

-- 2 + 4 ---------------------------------------------------------------------
DO $patch$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  -- v_pending_gl_postings
  v_def := replace(pg_get_viewdef('public.v_pending_gl_postings'::regclass, true), E'\r', '');
  IF position('fin_first_payment_share' IN v_def) = 0 THEN
    v_def := rtrim(btrim(v_def), ';');

    -- the first (deposit) payment of a single-payment order is 100%
    v_old := $o$COALESCE((o.payment_terms ->> 'deposit_pct'::text)::numeric, 0.3)$o$;
    IF (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'v_pending_gl_postings: deposit amount anchor not found exactly once';
    END IF;
    v_def := replace(v_def, v_old, 'fin_first_payment_share(o.payment_terms)');

    v_old := $o$'Deposit Payment'::text AS posting_label$o$;
    IF position(v_old IN v_def) = 0 THEN
      RAISE EXCEPTION 'v_pending_gl_postings: deposit label anchor not found';
    END IF;
    v_def := replace(v_def, v_old,
      $n$CASE WHEN COALESCE((o.payment_terms ->> 'deposit_pct'::text)::numeric, 0.3) <= 0.001 THEN 'Supplier Payment'::text ELSE 'Deposit Payment'::text END AS posting_label$n$);

    v_def := v_def || $n$
UNION ALL
 SELECT d.id AS document_id,
    d.doc_type::text AS document_type,
    d.doc_no AS document_no,
    d.display_doc_no,
    d.order_id,
    d.status::text AS document_status,
    o.order_no,
    o.display_doc_no AS order_display_doc_no,
    d.created_at AS document_date,
    d.company_id,
    'SUPPLIER_INVOICE_RECOGNITION'::text AS gl_doc_type,
    'Supplier Invoice (100%)'::text AS posting_label,
    COALESCE(( SELECT sum(order_items.line_total) AS sum
           FROM order_items
          WHERE order_items.order_id = o.id), 0::numeric) AS amount,
    seller_org.org_name AS supplier_name,
    buyer_org.org_name AS buyer_name,
    0::numeric AS paid_amount
   FROM documents d
     JOIN orders o ON o.id = d.order_id
     LEFT JOIN organizations seller_org ON seller_org.id = o.seller_org_id
     LEFT JOIN organizations buyer_org ON buyer_org.id = o.buyer_org_id
  WHERE d.doc_type = 'INVOICE'::document_type AND o.order_type = 'H2M'::order_type
    AND (d.status::text = ANY (ARRAY['acknowledged'::text, 'completed'::text]))
    AND fin_terms_single_payment(o.payment_terms)
    AND NOT (EXISTS ( SELECT 1 FROM documents r
          WHERE r.order_id = o.id AND r.doc_type = 'PAYMENT_REQUEST'::document_type))
    AND NOT (EXISTS ( SELECT 1
           FROM gl_document_postings dp
             JOIN documents x ON x.id = dp.document_id
          WHERE x.order_id = o.id AND dp.document_type = 'SUPPLIER_INVOICE_RECOGNITION'::text
            AND dp.posting_status = 'POSTED'::text))$n$;
    EXECUTE 'CREATE OR REPLACE VIEW public.v_pending_gl_postings AS ' || v_def;
  END IF;

  -- get_payment_posting_details
  SELECT replace(pg_get_functiondef(p.oid), E'\r', '') INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_payment_posting_details';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_payment_posting_details not found';
  END IF;
  IF position('fin_first_payment_share' IN v_def) = 0 THEN
    v_old := $o$            v_payment_amount := ROUND(v_order_total * v_deposit_pct, 2);$o$;
    IF position(v_old IN v_def) = 0 THEN
      RAISE EXCEPTION 'get_payment_posting_details: deposit amount anchor not found';
    END IF;
    v_def := replace(v_def, v_old,
      $n$            v_payment_amount := ROUND(v_order_total * public.fin_first_payment_share(v_order.payment_terms), 2);$n$);

    v_old := $o$        WHEN v_is_deposit THEN 'Supplier Deposit Payment ('$o$;
    IF position(v_old IN v_def) = 0 THEN
      RAISE EXCEPTION 'get_payment_posting_details: description anchor not found';
    END IF;
    v_def := replace(v_def, v_old,
      $n$        WHEN v_is_deposit AND public.fin_terms_single_payment(v_order.payment_terms) THEN 'Supplier Payment (100%): ' || v_payment.doc_no
        WHEN v_is_deposit THEN 'Supplier Deposit Payment ('$n$);
    EXECUTE v_def;
  END IF;
END
$patch$;

-- 3 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_balance_request_posting_details(p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_request record;
    v_order record;
    v_company_id uuid;
    v_order_total numeric(18,2);
    v_deposit_amount numeric(18,2);
    v_balance_amount numeric(18,2);
    v_supplier_org_id uuid;
    v_supplier_name text;
    v_description text;
    v_label text;
BEGIN
    v_company_id := public.get_user_company_id();

    -- The Balance Request, or (single-payment H2M orders, which have none) the supplier invoice.
    SELECT * INTO v_request
    FROM public.documents d
    WHERE d.id = p_request_id
    AND d.company_id = v_company_id
    AND (
        d.doc_type = 'PAYMENT_REQUEST'
        OR (d.doc_type = 'INVOICE' AND EXISTS (
            SELECT 1 FROM public.orders o
            WHERE o.id = d.order_id
              AND o.order_type = 'H2M'
              AND public.fin_terms_single_payment(o.payment_terms)
              AND NOT EXISTS (SELECT 1 FROM public.documents r
                              WHERE r.order_id = o.id AND r.doc_type = 'PAYMENT_REQUEST')))
    );

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Balance request or supplier invoice not found or not in your company');
    END IF;

    v_label := CASE WHEN v_request.doc_type::text = 'INVOICE' THEN 'Supplier invoice ' ELSE 'Balance request ' END;

    /* finance-require-acknowledged-request */
    IF v_request.status::text NOT IN ('acknowledged', 'completed') THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', v_label || COALESCE(v_request.display_doc_no, v_request.doc_no)
                     || ' has not been acknowledged yet. It can be posted after HQ acknowledges it.'
        );
    END IF;

    -- One supplier invoice recognition per order.
    IF EXISTS (
        SELECT 1 FROM public.gl_document_postings dp
        JOIN public.documents x ON x.id = dp.document_id
        WHERE x.order_id = v_request.order_id
          AND dp.document_id <> p_request_id
          AND dp.document_type = 'SUPPLIER_INVOICE_RECOGNITION'
          AND dp.posting_status = 'POSTED')
    THEN
        RETURN jsonb_build_object('success', false, 'error', 'The supplier invoice of this order is already posted');
    END IF;

    SELECT * INTO v_order FROM public.orders o WHERE o.id = v_request.order_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Order not found for this document');
    END IF;

    SELECT COALESCE(SUM(line_total), 0) INTO v_order_total
    FROM public.order_items WHERE order_id = v_order.id;

    IF v_order_total <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Order has zero total');
    END IF;

    /* finance-apply-actual-advances */
    v_deposit_amount := LEAST(public.fin_order_supplier_advances(v_order.id), v_order_total);
    v_balance_amount := v_order_total - v_deposit_amount;

    v_supplier_org_id := v_order.seller_org_id;
    SELECT org_name INTO v_supplier_name FROM public.organizations WHERE id = v_supplier_org_id;

    v_description := 'Supplier Invoice Recognition: ' || v_order.order_no
                     || ' (advances applied RM ' || to_char(v_deposit_amount, 'FM999,999,999,990.00')
                     || ', payable RM ' || to_char(v_balance_amount, 'FM999,999,999,990.00') || ')';

    RETURN jsonb_build_object(
        'success', true,
        'request_id', p_request_id,
        'request_doc_no', v_request.doc_no,
        'order_id', v_request.order_id,
        'order_no', v_order.order_no,
        'company_id', v_request.company_id,
        'gl_doc_type', 'SUPPLIER_INVOICE_RECOGNITION',
        'order_total', v_order_total,
        'deposit_amount', v_deposit_amount,
        'balance_amount', v_balance_amount,
        'supplier_org_id', v_supplier_org_id,
        'supplier_name', v_supplier_name,
        'description', v_description
    );
END;
$function$;

NOTIFY pgrst, 'reload schema';

COMMIT;
