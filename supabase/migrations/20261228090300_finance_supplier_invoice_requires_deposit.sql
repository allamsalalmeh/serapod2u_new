-- Supplier invoice recognition (the Balance Request posting) is only allowed once
--   1. the balance request has been acknowledged by HQ, and
--   2. the order's deposit payment has been posted to the GL (when the order has a deposit).
-- Without this, an unacknowledged request with no paid deposit could be posted, crediting
-- Supplier Deposits (1400) for a deposit that was never paid.
--
-- The rule is enforced in two places:
--   * get_balance_request_posting_details: used by both the preview and post_document_to_gl,
--     so the API cannot bypass it;
--   * v_pending_gl_postings: such requests no longer appear in Pending Postings.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Posting details: refuse unacknowledged requests and unposted deposits
-- ---------------------------------------------------------------------------
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
    v_deposit_pct numeric;
    v_balance_pct numeric;
    v_deposit_amount numeric(18,2);
    v_balance_amount numeric(18,2);
    v_supplier_org_id uuid;
    v_supplier_name text;
    v_description text;
BEGIN
    v_company_id := public.get_user_company_id();

    -- Get payment request document
    SELECT * INTO v_request
    FROM public.documents d
    WHERE d.id = p_request_id
    AND d.doc_type = 'PAYMENT_REQUEST'
    AND d.company_id = v_company_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'PAYMENT_REQUEST document not found or not in your company'
        );
    END IF;

    /* finance-require-acknowledged-request */
    IF v_request.status::text NOT IN ('acknowledged', 'completed') THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Balance request ' || COALESCE(v_request.display_doc_no, v_request.doc_no)
                     || ' has not been acknowledged yet. It can be posted after HQ acknowledges it.'
        );
    END IF;

    -- Get the linked order
    SELECT * INTO v_order
    FROM public.orders o
    WHERE o.id = v_request.order_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Order not found for this payment request'
        );
    END IF;

    -- Calculate order total
    SELECT COALESCE(SUM(line_total), 0) INTO v_order_total
    FROM public.order_items
    WHERE order_id = v_order.id;

    IF v_order_total <= 0 THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Order has zero total'
        );
    END IF;

    -- Get payment terms from order
    v_deposit_pct := COALESCE((v_order.payment_terms->>'deposit_pct')::numeric, 0.3);
    v_balance_pct := COALESCE((v_order.payment_terms->>'balance_pct')::numeric, 0.7);

    /* finance-require-posted-deposit */
    IF v_deposit_pct > 0 AND NOT EXISTS (
        SELECT 1
        FROM public.documents dep
        JOIN public.gl_document_postings dp
          ON dp.document_id = dep.id
         AND dp.company_id = dep.company_id
         AND dp.document_type = 'SUPPLIER_DEPOSIT_PAYMENT'
         AND dp.posting_status = 'POSTED'
        WHERE dep.order_id = v_order.id
          AND dep.doc_type = 'PAYMENT'
          AND dep.doc_no NOT LIKE '%-BAL%'
          AND NOT (dep.payload ? 'source_request_id')
    ) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'The deposit payment for order ' || COALESCE(v_order.display_doc_no, v_order.order_no)
                     || ' has not been posted to the GL. Post the deposit payment first.'
        );
    END IF;

    v_deposit_amount := ROUND(v_order_total * v_deposit_pct, 2);
    v_balance_amount := ROUND(v_order_total * v_balance_pct, 2);

    -- Get supplier
    v_supplier_org_id := v_order.seller_org_id;

    SELECT org_name INTO v_supplier_name
    FROM public.organizations
    WHERE id = v_supplier_org_id;

    -- Build description
    v_description := 'Supplier Invoice Recognition: ' || v_order.order_no || ' (Apply ' || ROUND(v_deposit_pct * 100) || '% deposit, ' || ROUND(v_balance_pct * 100) || '% AP)';

    RETURN jsonb_build_object(
        'success', true,
        'request_id', p_request_id,
        'request_doc_no', v_request.doc_no,
        'order_id', v_request.order_id,
        'order_no', v_order.order_no,
        'company_id', v_request.company_id,
        'gl_doc_type', 'SUPPLIER_INVOICE_RECOGNITION',
        'order_total', v_order_total,
        'deposit_pct', v_deposit_pct,
        'balance_pct', v_balance_pct,
        'deposit_amount', v_deposit_amount,
        'balance_amount', v_balance_amount,
        'supplier_org_id', v_supplier_org_id,
        'supplier_name', v_supplier_name,
        'description', v_description
    );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2. Pending Postings: hide supplier invoices that cannot be posted yet.
--    Only the SUPPLIER_INVOICE_RECOGNITION branch changes; the view keeps its
--    columns, grants and options (re-applied below).
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _v_pending_opts ON COMMIT DROP AS
SELECT reloptions FROM pg_class WHERE oid = 'public.v_pending_gl_postings'::regclass;

CREATE OR REPLACE VIEW public.v_pending_gl_postings AS
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
    'SUPPLIER_DEPOSIT_PAYMENT'::text AS gl_doc_type,
    'Deposit Payment'::text AS posting_label,
    round(COALESCE(( SELECT sum(order_items.line_total) AS sum
           FROM order_items
          WHERE order_items.order_id = o.id), 0::numeric) * COALESCE((o.payment_terms ->> 'deposit_pct'::text)::numeric, 0.3), 2) AS amount,
    seller_org.org_name AS supplier_name,
    buyer_org.org_name AS buyer_name
   FROM documents d
     JOIN orders o ON o.id = d.order_id
     LEFT JOIN organizations seller_org ON seller_org.id = o.seller_org_id
     LEFT JOIN organizations buyer_org ON buyer_org.id = o.buyer_org_id
  WHERE d.doc_type = 'PAYMENT'::document_type AND d.doc_no !~~ '%-BAL%'::text AND NOT d.payload ? 'source_request_id'::text AND NOT (EXISTS ( SELECT 1
           FROM gl_document_postings dp
          WHERE dp.document_id = d.id AND dp.company_id = d.company_id AND dp.posting_status = 'POSTED'::text))
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
    buyer_org.org_name AS buyer_name
   FROM documents d
     JOIN orders o ON o.id = d.order_id
     LEFT JOIN organizations seller_org ON seller_org.id = o.seller_org_id
     LEFT JOIN organizations buyer_org ON buyer_org.id = o.buyer_org_id
  WHERE d.doc_type = 'PAYMENT_REQUEST'::document_type
    -- finance-require-acknowledged-request
    AND d.status::text = ANY (ARRAY['acknowledged'::text, 'completed'::text])
    -- finance-require-posted-deposit
    AND (COALESCE((o.payment_terms ->> 'deposit_pct'::text)::numeric, 0.3) <= 0::numeric OR (EXISTS ( SELECT 1
           FROM documents dep
             JOIN gl_document_postings ddp ON ddp.document_id = dep.id AND ddp.company_id = dep.company_id AND ddp.document_type = 'SUPPLIER_DEPOSIT_PAYMENT'::text AND ddp.posting_status = 'POSTED'::text
          WHERE dep.order_id = o.id AND dep.doc_type = 'PAYMENT'::document_type AND dep.doc_no !~~ '%-BAL%'::text AND NOT dep.payload ? 'source_request_id'::text)))
    AND NOT (EXISTS ( SELECT 1
           FROM gl_document_postings dp
          WHERE dp.document_id = d.id AND dp.company_id = d.company_id AND dp.posting_status = 'POSTED'::text))
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
    'SUPPLIER_BALANCE_PAYMENT'::text AS gl_doc_type,
    'Balance Payment'::text AS posting_label,
    round(COALESCE(( SELECT sum(order_items.line_total) AS sum
           FROM order_items
          WHERE order_items.order_id = o.id), 0::numeric) * COALESCE((o.payment_terms ->> 'balance_pct'::text)::numeric, 0.7), 2) AS amount,
    seller_org.org_name AS supplier_name,
    buyer_org.org_name AS buyer_name
   FROM documents d
     JOIN orders o ON o.id = d.order_id
     LEFT JOIN organizations seller_org ON seller_org.id = o.seller_org_id
     LEFT JOIN organizations buyer_org ON buyer_org.id = o.buyer_org_id
  WHERE d.doc_type = 'PAYMENT'::document_type AND (d.doc_no ~~ '%-BAL%'::text OR d.payload ? 'source_request_id'::text) AND NOT (EXISTS ( SELECT 1
           FROM gl_document_postings dp
          WHERE dp.document_id = d.id AND dp.company_id = d.company_id AND dp.posting_status = 'POSTED'::text))
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
    'SALES_INVOICE'::text AS gl_doc_type,
    'Sales Invoice'::text AS posting_label,
    COALESCE(( SELECT sum(order_items.line_total) AS sum
           FROM order_items
          WHERE order_items.order_id = o.id), 0::numeric) AS amount,
    seller_org.org_name AS supplier_name,
    buyer_org.org_name AS buyer_name
   FROM documents d
     JOIN orders o ON o.id = d.order_id
     LEFT JOIN organizations seller_org ON seller_org.id = o.seller_org_id
     LEFT JOIN organizations buyer_org ON buyer_org.id = o.buyer_org_id
  WHERE d.doc_type = 'INVOICE'::document_type AND o.order_type = 'D2H'::order_type AND NOT (EXISTS ( SELECT 1
           FROM gl_document_postings dp
          WHERE dp.document_id = d.id AND dp.company_id = d.company_id AND dp.posting_status = 'POSTED'::text))
UNION ALL
 SELECT o.id AS document_id,
    'ORDER'::text AS document_type,
    o.order_no AS document_no,
    o.display_doc_no,
    o.id AS order_id,
    o.status::text AS document_status,
    o.order_no,
    o.display_doc_no AS order_display_doc_no,
    o.approved_at AS document_date,
    o.seller_org_id AS company_id,
    'SALES_INVOICE'::text AS gl_doc_type,
    'Sales Invoice (Order)'::text AS posting_label,
    COALESCE(( SELECT sum(order_items.line_total) AS sum
           FROM order_items
          WHERE order_items.order_id = o.id), 0::numeric) AS amount,
    seller_org.org_name AS supplier_name,
    buyer_org.org_name AS buyer_name
   FROM orders o
     LEFT JOIN organizations seller_org ON seller_org.id = o.seller_org_id
     LEFT JOIN organizations buyer_org ON buyer_org.id = o.buyer_org_id
  WHERE o.order_type = 'D2H'::order_type AND o.status = 'approved'::order_status AND NOT (EXISTS ( SELECT 1
           FROM gl_document_postings dp
          WHERE dp.document_id = o.id AND dp.company_id = o.seller_org_id AND dp.posting_status = 'POSTED'::text)) AND NOT (EXISTS ( SELECT 1
           FROM documents d
          WHERE d.order_id = o.id AND d.doc_type = 'INVOICE'::document_type))
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
    'RECEIPT'::text AS gl_doc_type,
    'Customer Receipt'::text AS posting_label,
        CASE
            WHEN d.payment_percentage IS NOT NULL THEN round(COALESCE(( SELECT sum(order_items.line_total) AS sum
               FROM order_items
              WHERE order_items.order_id = o.id), 0::numeric) * (d.payment_percentage::numeric / 100.0), 2)
            ELSE COALESCE(( SELECT sum(order_items.line_total) AS sum
               FROM order_items
              WHERE order_items.order_id = o.id), 0::numeric)
        END AS amount,
    seller_org.org_name AS supplier_name,
    buyer_org.org_name AS buyer_name
   FROM documents d
     JOIN orders o ON o.id = d.order_id
     LEFT JOIN organizations seller_org ON seller_org.id = o.seller_org_id
     LEFT JOIN organizations buyer_org ON buyer_org.id = o.buyer_org_id
  WHERE d.doc_type = 'RECEIPT'::document_type AND o.order_type = 'D2H'::order_type AND NOT (EXISTS ( SELECT 1
           FROM gl_document_postings dp
          WHERE dp.document_id = d.id AND dp.company_id = d.company_id AND dp.posting_status = 'POSTED'::text));

-- Keep the view's original options (for example security_invoker).
DO $$
DECLARE
    v_opts text[];
BEGIN
    SELECT reloptions INTO v_opts FROM _v_pending_opts;
    IF v_opts IS NOT NULL AND array_length(v_opts, 1) > 0 THEN
        EXECUTE format('ALTER VIEW public.v_pending_gl_postings SET (%s)', array_to_string(v_opts, ', '));
    END IF;
END
$$;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification (read only)
-- ---------------------------------------------------------------------------
-- Supplier invoices still pending: each one must have an acknowledged request
-- and a posted deposit. BR26000109-01, BR26000111-01 and BR26000114-01 must be gone.
SELECT COALESCE(display_doc_no, document_no) AS doc, order_display_doc_no AS ord, document_status, amount
FROM public.v_pending_gl_postings
WHERE gl_doc_type = 'SUPPLIER_INVOICE_RECOGNITION'
ORDER BY document_date DESC;

-- View options after the change (should match before).
SELECT reloptions FROM pg_class WHERE oid = 'public.v_pending_gl_postings'::regclass;
