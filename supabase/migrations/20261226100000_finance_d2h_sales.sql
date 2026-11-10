-- Sales cycle (D2H) in Finance
--
--   * Sales invoice (INVOICE document) posts revenue, cost of goods sold at the
--     product's fixed cost (product_variants.base_cost) and applies customer money
--     received before the invoice:
--       Dr 1200 AR / Cr 4100 Sales            order total
--       Dr 5100 COGS / Cr 1300 Inventory      sum(qty x base_cost)  - blocked if a product has no cost
--       Dr Customer Deposits / Cr 1200 AR     advances received
--   * Customer receipt (RECEIPT document) posts the amount actually received, in one or
--     more receipts up to the order total: Dr Bank / Cr Customer Deposits before the
--     invoice is posted, Cr AR after. Closes when the order is fully received.
--   * D2H PAYMENT documents (distributor's payment proof) are no longer listed: they are
--     requests, not money received (they were shown as Supplier Deposits).
--   * "Sales Invoice (Order)" rows (approved orders without an invoice) are removed.
--   * Reversal order for sales: receipts after the invoice -> invoice -> advance receipts.
--   * New setting gl_settings.customer_deposit_account_id (2200 Customer Deposits created
--     when missing).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Customer Deposits account (liability) and its setting
--    Uses an existing "2300 Deposits Received" (full chart template) when present,
--    otherwise creates 2200 Customer Deposits (2300 if 2200 is already used).
-- ---------------------------------------------------------------------------
ALTER TABLE public.gl_settings ADD COLUMN IF NOT EXISTS customer_deposit_account_id uuid
    REFERENCES public.gl_accounts(id);
COMMENT ON COLUMN public.gl_settings.customer_deposit_account_id IS
    'Liability for customer (distributor) money received before the sales invoice is posted.';

DO $$
DECLARE
    s       record;
    v_acct  uuid;
    v_code  text;
BEGIN
    FOR s IN SELECT * FROM public.gl_settings WHERE customer_deposit_account_id IS NULL LOOP
        SELECT id INTO v_acct FROM public.gl_accounts
        WHERE company_id = s.company_id AND account_type = 'LIABILITY'
          AND (name ILIKE '%customer deposit%' OR (code = '2300' AND name ILIKE '%deposit%'))
        ORDER BY code LIMIT 1;

        IF v_acct IS NULL THEN
            v_code := CASE WHEN EXISTS (SELECT 1 FROM public.gl_accounts WHERE company_id = s.company_id AND code = '2200')
                           THEN '2300' ELSE '2200' END;
            IF NOT EXISTS (SELECT 1 FROM public.gl_accounts WHERE company_id = s.company_id AND code = v_code) THEN
                INSERT INTO public.gl_accounts (company_id, code, name, account_type, subtype, normal_balance, description, is_active)
                VALUES (s.company_id, v_code, 'Customer Deposits', 'LIABILITY', 'Current Liability', 'CREDIT',
                        'Money received from customers before their sales invoice is posted', true)
                RETURNING id INTO v_acct;
            END IF;
        END IF;

        IF v_acct IS NOT NULL THEN
            UPDATE public.gl_settings SET customer_deposit_account_id = v_acct WHERE id = s.id;
        END IF;
    END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Receipt documents count as payment documents for closing
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_payment_document_closed(p_document_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT EXISTS (SELECT 1 FROM public.fin_document_closures c WHERE c.document_id = p_document_id)
        OR EXISTS (SELECT 1 FROM public.gl_document_postings dp
                   WHERE dp.document_id = p_document_id
                     AND dp.document_type IN ('SUPPLIER_DEPOSIT_PAYMENT', 'SUPPLIER_BALANCE_PAYMENT', 'RECEIPT')
                     AND dp.posting_status = 'POSTED');
$function$;
REVOKE ALL ON FUNCTION public.fin_payment_document_closed(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_payment_document_closed(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fin_close_payment_document_internal(p_document_id uuid, p_kind text, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_doc       record;
    v_type      text;
    v_paid      numeric(18,2);
    v_last_jnl  uuid;
BEGIN
    SELECT d.id, d.company_id, d.doc_type::text AS doc_type, COALESCE(d.display_doc_no, d.doc_no) AS doc_number,
           (d.doc_no LIKE '%-BAL%' OR COALESCE(d.payload, '{}'::jsonb) ? 'source_request_id') AS is_balance
    INTO v_doc
    FROM public.documents d WHERE d.id = p_document_id;
    IF v_doc.id IS NULL OR public.fin_payment_document_closed(p_document_id) THEN
        RETURN;
    END IF;

    INSERT INTO public.fin_document_closures (document_id, company_id, kind, reason, closed_by)
    VALUES (p_document_id, v_doc.company_id, p_kind, p_reason, auth.uid());

    INSERT INTO public.fin_document_closure_events (document_id, company_id, action, kind, reason, actor_id)
    VALUES (p_document_id, v_doc.company_id, 'CLOSED', p_kind, p_reason, auth.uid());

    -- Keep the one-posting-per-document record the AP / AR pages read, when there were payments.
    v_type := CASE WHEN v_doc.doc_type = 'RECEIPT' THEN 'RECEIPT'
                   WHEN v_doc.is_balance THEN 'SUPPLIER_BALANCE_PAYMENT'
                   ELSE 'SUPPLIER_DEPOSIT_PAYMENT' END;
    SELECT COALESCE(SUM(amount), 0) INTO v_paid
    FROM public.fin_payments WHERE document_id = p_document_id AND status = 'POSTED';
    SELECT journal_id INTO v_last_jnl
    FROM public.fin_payments WHERE document_id = p_document_id AND status = 'POSTED'
    ORDER BY created_at DESC LIMIT 1;

    IF v_last_jnl IS NOT NULL THEN
        INSERT INTO public.gl_document_postings (
            company_id, document_type, document_id, document_number,
            journal_id, posted_amount, posting_status, created_by
        ) VALUES (
            v_doc.company_id, v_type, p_document_id, v_doc.doc_number,
            v_last_jnl, v_paid, 'POSTED', auth.uid()
        )
        ON CONFLICT (company_id, document_type, document_id) DO NOTHING;
    END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_close_payment_document_internal(uuid,text,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_close_payment_document_internal(uuid,text,text) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Sales invoice context: revenue, cost at base_cost, advances to apply
--    Accepts the INVOICE document id (or, for older postings, the order id).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_sales_invoice_context(p_document_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_company_id  uuid := public.get_user_company_id();
    v_doc         record;
    v_order       record;
    v_revenue     numeric(18,2);
    v_cost        numeric(18,2);
    v_missing     text;
    v_advances    numeric(18,2);
    v_receipts_settled numeric(18,2);
BEGIN
    SELECT d.id, d.order_id, COALESCE(d.display_doc_no, d.doc_no) AS doc_number
    INTO v_doc
    FROM public.documents d
    WHERE d.id = p_document_id AND d.doc_type = 'INVOICE' AND d.company_id = v_company_id;

    SELECT o.id, o.order_no, o.display_doc_no, o.order_type::text AS order_type, o.buyer_org_id,
           b.org_name AS buyer_name
    INTO v_order
    FROM public.orders o
    LEFT JOIN public.organizations b ON b.id = o.buyer_org_id
    WHERE o.id = COALESCE(v_doc.order_id, p_document_id) AND o.company_id = v_company_id;

    IF v_order.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Sales invoice not found');
    END IF;
    IF v_order.order_type <> 'D2H' THEN
        RETURN jsonb_build_object('success', false, 'error', 'This is not a sales (D2H) order');
    END IF;

    SELECT COALESCE(SUM(oi.line_total), 0),
           COALESCE(SUM(oi.qty * COALESCE(pv.base_cost, 0)), 0),
           string_agg(DISTINCT pv.variant_name, ', ') FILTER (WHERE COALESCE(pv.base_cost, 0) <= 0)
    INTO v_revenue, v_cost, v_missing
    FROM public.order_items oi
    LEFT JOIN public.product_variants pv ON pv.id = oi.variant_id
    WHERE oi.order_id = v_order.id;

    -- Customer money received before the invoice was posted (held in Customer Deposits).
    SELECT COALESCE(SUM(fp.amount) FILTER (WHERE fp.stage = 'ADVANCE'), 0),
           COALESCE(SUM(fp.amount) FILTER (WHERE fp.stage = 'SETTLEMENT'), 0)
    INTO v_advances, v_receipts_settled
    FROM public.fin_payments fp
    WHERE fp.order_id = v_order.id AND fp.direction = 'IN' AND fp.status = 'POSTED';

    RETURN jsonb_build_object(
        'success', true,
        'company_id', v_company_id,
        'invoice_document_id', v_doc.id,
        'document_number', COALESCE(v_doc.doc_number, v_order.display_doc_no, v_order.order_no),
        'order_id', v_order.id,
        'order_no', COALESCE(v_order.display_doc_no, v_order.order_no),
        'customer_org_id', v_order.buyer_org_id,
        'customer_name', v_order.buyer_name,
        'revenue', ROUND(v_revenue, 2),
        'cost', ROUND(v_cost, 2),
        'products_without_cost', v_missing,
        'advances_received', v_advances,
        'advances_applied', LEAST(v_advances, ROUND(v_revenue, 2)),
        'receipts_after_invoice', v_receipts_settled
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_sales_invoice_context(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_sales_invoice_context(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Customer receipt context (RECEIPT document of a D2H order)
--    The receipt's own amount (from payment-term %) is only a suggestion; Finance
--    posts the amount actually received, in one or more receipts, up to the order total.
-- ---------------------------------------------------------------------------
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
        'order_paid_total', v_order_received,
        'order_unpaid', GREATEST(v_order_total - v_order_received, 0),
        'remaining_requested', GREATEST(v_order_total - v_order_received, 0),
        'invoice_posted', v_invoice_posted,
        'stage', CASE WHEN v_invoice_posted THEN 'SETTLEMENT' ELSE 'ADVANCE' END,
        'closed', public.fin_payment_document_closed(p_document_id)
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_customer_receipt_context(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_customer_receipt_context(uuid) TO service_role;

-- Either kind of payment document (supplier payment or customer receipt).
CREATE OR REPLACE FUNCTION public.fin_payment_document_context(p_document_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF EXISTS (SELECT 1 FROM public.documents WHERE id = p_document_id AND doc_type = 'RECEIPT') THEN
        RETURN public.fin_customer_receipt_context(p_document_id);
    END IF;
    RETURN public.fin_supplier_payment_context(p_document_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_payment_document_context(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_payment_document_context(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Post a customer receipt at the amount actually received
--    Before the sales invoice is posted: Dr Bank / Cr Customer Deposits (advance)
--    After:                              Dr Bank / Cr Accounts Receivable
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_post_customer_receipt(
    p_document_id     uuid,
    p_amount          numeric,
    p_receipt_date    date,
    p_bank_account_id uuid    DEFAULT NULL,
    p_reference       text    DEFAULT NULL,
    p_closes_document boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id   uuid;
    v_ctx          jsonb;
    v_amount       numeric(18,2);
    v_order_id     uuid;
    v_order_total  numeric(18,2);
    v_order_paid   numeric(18,2);
    v_stage        text;
    v_settings     record;
    v_credit_acct  uuid;
    v_bank         record;
    v_doc_number   text;
    v_journal_id   uuid;
    v_journal_no   text;
    v_description  text;
    v_customer_id  uuid;
    v_today        date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
    v_doc_paid     numeric(18,2);
    v_fully_paid   boolean;
    v_close        boolean;
    v_other        record;
BEGIN
  /* sa-guard:finance.journal.post */
  PERFORM public.sa_require_operation('finance.journal.post', jsonb_build_object('organization_id', public.get_user_company_id()), 'CUSTOMER_RECEIPT', p_document_id::text);
    IF public.sa_legacy_guard_unless_new('finance.journal.post') AND NOT public.is_hq_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only HQ Admins can post to GL');
    END IF;

    v_company_id := public.get_user_company_id();

    PERFORM 1 FROM public.documents WHERE id = p_document_id AND company_id = v_company_id FOR UPDATE;
    PERFORM 1 FROM public.orders o
      WHERE o.id = (SELECT order_id FROM public.documents WHERE id = p_document_id) FOR UPDATE;

    v_ctx := public.fin_customer_receipt_context(p_document_id);
    IF NOT COALESCE((v_ctx->>'success')::boolean, false) THEN
        RETURN v_ctx;
    END IF;

    v_order_id    := (v_ctx->>'order_id')::uuid;
    v_order_total := (v_ctx->>'order_total')::numeric;
    v_order_paid  := (v_ctx->>'order_paid_total')::numeric;
    v_stage       := v_ctx->>'stage';
    v_customer_id := (v_ctx->>'customer_org_id')::uuid;
    v_doc_number  := v_ctx->>'document_number';

    IF COALESCE((v_ctx->>'closed')::boolean, false) THEN
        RETURN jsonb_build_object('success', false, 'error',
            'This receipt document is closed. Reopen it to post another receipt on it.');
    END IF;

    v_amount := ROUND(COALESCE(p_amount, 0), 2);
    IF v_amount <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Enter the amount actually received (more than zero)');
    END IF;
    IF p_receipt_date IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Enter the receipt date');
    END IF;
    IF p_receipt_date > v_today THEN
        RETURN jsonb_build_object('success', false, 'error', 'The receipt date cannot be in the future');
    END IF;

    IF v_order_paid + v_amount > v_order_total THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Total receipts for this order would be RM ' || to_char(v_order_paid + v_amount, 'FM999,999,999,990.00')
                     || ', more than the order total of RM ' || to_char(v_order_total, 'FM999,999,999,990.00')
                     || '. At most RM ' || to_char(GREATEST(v_order_total - v_order_paid, 0), 'FM999,999,999,990.00') || ' can be received.'
        );
    END IF;

    IF p_bank_account_id IS NOT NULL THEN
        SELECT ba.id, ba.gl_account_id INTO v_bank
        FROM public.bank_accounts ba
        WHERE ba.id = p_bank_account_id AND ba.company_id = v_company_id AND ba.is_active;
    ELSE
        SELECT ba.id, ba.gl_account_id INTO v_bank
        FROM public.bank_accounts ba
        WHERE ba.company_id = v_company_id AND ba.is_active AND ba.is_default
        ORDER BY ba.created_at
        LIMIT 1;
    END IF;
    IF v_bank.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Bank account not found or inactive. Choose an active bank account.');
    END IF;
    IF v_bank.gl_account_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'The bank account is not linked to a GL account');
    END IF;

    SELECT * INTO v_settings FROM public.gl_settings WHERE company_id = v_company_id;
    v_credit_acct := CASE WHEN v_stage = 'ADVANCE' THEN v_settings.customer_deposit_account_id
                          ELSE v_settings.ar_control_account_id END;
    IF v_credit_acct IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error',
            CASE WHEN v_stage = 'ADVANCE' THEN 'Customer Deposits account not configured. Please set it in Default Accounts.'
                 ELSE 'Accounts Receivable account not configured' END);
    END IF;

    v_description := CASE WHEN v_stage = 'ADVANCE' THEN 'Customer Advance Receipt: ' ELSE 'Customer Receipt: ' END
                     || v_doc_number
                     || COALESCE(' Ref ' || NULLIF(btrim(p_reference), ''), '');

    v_journal_no := public.generate_journal_number(v_company_id, 'RECEIPT');

    INSERT INTO public.gl_journals (
        company_id, journal_number, journal_date, posting_date, description, journal_type,
        status, total_debit, total_credit, created_by, posted_by, posted_at
    ) VALUES (
        v_company_id, v_journal_no, p_receipt_date, p_receipt_date, v_description, 'RECEIPT',
        'POSTED', v_amount, v_amount, auth.uid(), auth.uid(), now()
    ) RETURNING id INTO v_journal_id;

    INSERT INTO public.gl_journal_lines (journal_id, account_id, line_number, description,
        debit_amount, credit_amount, entity_type, entity_id, created_by)
    VALUES
        (v_journal_id, v_bank.gl_account_id, 1, v_description, v_amount, 0, NULL, NULL, auth.uid()),
        (v_journal_id, v_credit_acct, 2, v_description, 0, v_amount, 'CUSTOMER', v_customer_id, auth.uid());

    INSERT INTO public.fin_payments (
        company_id, direction, document_id, document_type, order_id, party_org_id, stage,
        amount, payment_date, bank_account_id, reference, journal_id, closes_document, created_by
    ) VALUES (
        v_company_id, 'IN', p_document_id, 'RECEIPT', v_order_id, v_customer_id, v_stage,
        v_amount, p_receipt_date, v_bank.id, NULLIF(btrim(p_reference), ''), v_journal_id,
        COALESCE(p_closes_document, false), auth.uid()
    );

    SELECT COALESCE(SUM(amount), 0) INTO v_doc_paid
    FROM public.fin_payments WHERE document_id = p_document_id AND status = 'POSTED';

    -- Closed when Finance marks the last receipt, or when the whole order is received.
    v_fully_paid := v_order_paid + v_amount >= v_order_total;
    v_close := COALESCE(p_closes_document, false) OR v_fully_paid;

    IF v_close THEN
        PERFORM public.fin_close_payment_document_internal(
            p_document_id,
            CASE WHEN COALESCE(p_closes_document, false) THEN 'LAST_PAYMENT' ELSE 'AUTO' END,
            CASE WHEN COALESCE(p_closes_document, false) THEN 'Marked as the last receipt' ELSE 'Order fully received' END);
    END IF;

    IF v_fully_paid THEN
        FOR v_other IN
            SELECT d.id FROM public.documents d
            WHERE d.order_id = v_order_id AND d.company_id = v_company_id
              AND d.doc_type = 'RECEIPT' AND d.id <> p_document_id
              AND NOT public.fin_payment_document_closed(d.id)
        LOOP
            PERFORM public.fin_close_payment_document_internal(v_other.id, 'AUTO', 'Order fully received');
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'journal_id', v_journal_id,
        'journal_number', v_journal_no,
        'document_type', 'RECEIPT',
        'document_id', p_document_id,
        'document_number', v_doc_number,
        'stage', v_stage,
        'posted_amount', v_amount,
        'paid_on_document', v_doc_paid,
        'order_received', v_order_paid + v_amount,
        'document_closed', v_close,
        'posting_date', p_receipt_date
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_post_customer_receipt(uuid,numeric,date,uuid,text,boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fin_post_customer_receipt(uuid,numeric,date,uuid,text,boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Close / reopen work for receipts too
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_close_payment_document(p_document_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_ctx jsonb;
BEGIN
  /* sa-guard:finance.journal.post */
  PERFORM public.sa_require_operation('finance.journal.post', jsonb_build_object('organization_id', public.get_user_company_id()), 'PAYMENT_DOCUMENT_CLOSE', p_document_id::text);
    IF public.sa_legacy_guard_unless_new('finance.journal.post') AND NOT public.is_hq_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only HQ Admins can close payment documents');
    END IF;

    IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Enter the reason for closing this document');
    END IF;

    PERFORM 1 FROM public.documents WHERE id = p_document_id AND company_id = public.get_user_company_id() FOR UPDATE;

    v_ctx := public.fin_payment_document_context(p_document_id);
    IF NOT COALESCE((v_ctx->>'success')::boolean, false) THEN
        RETURN v_ctx;
    END IF;
    IF COALESCE((v_ctx->>'closed')::boolean, false) THEN
        RETURN jsonb_build_object('success', false, 'error', 'This document is already closed');
    END IF;

    PERFORM public.fin_close_payment_document_internal(p_document_id, 'MANUAL', btrim(p_reason));

    RETURN jsonb_build_object('success', true, 'document_id', p_document_id, 'closed', true,
        'paid_on_document', (v_ctx->>'paid_on_document')::numeric);
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_close_payment_document(uuid,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fin_close_payment_document(uuid,text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fin_reopen_payment_document(p_document_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_ctx jsonb;
    v_company_id uuid;
BEGIN
  /* sa-guard:finance.payment.approve */
  PERFORM public.sa_require_operation('finance.payment.approve', jsonb_build_object('organization_id', public.get_user_company_id()), 'PAYMENT_DOCUMENT_REOPEN', p_document_id::text);
    IF public.sa_legacy_guard_unless_new('finance.payment.approve') AND NOT public.is_hq_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only HQ Admins can reopen payment documents');
    END IF;

    IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Enter the reason for reopening this document');
    END IF;

    v_company_id := public.get_user_company_id();
    PERFORM 1 FROM public.documents WHERE id = p_document_id AND company_id = v_company_id FOR UPDATE;

    v_ctx := public.fin_payment_document_context(p_document_id);
    IF NOT COALESCE((v_ctx->>'success')::boolean, false) THEN
        RETURN v_ctx;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.fin_document_closures WHERE document_id = p_document_id) THEN
        RETURN jsonb_build_object('success', false, 'error',
            CASE WHEN COALESCE((v_ctx->>'closed')::boolean, false)
                 THEN 'This document was posted before actual payments were introduced and cannot be reopened'
                 ELSE 'This document is not closed' END);
    END IF;

    IF (v_ctx->>'order_unpaid')::numeric <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error',
            'The order is fully paid, so nothing more can be posted on this document');
    END IF;

    DELETE FROM public.fin_document_closures WHERE document_id = p_document_id;
    DELETE FROM public.gl_document_postings
    WHERE document_id = p_document_id
      AND company_id = v_company_id
      AND document_type IN ('SUPPLIER_DEPOSIT_PAYMENT', 'SUPPLIER_BALANCE_PAYMENT', 'RECEIPT');

    INSERT INTO public.fin_document_closure_events (document_id, company_id, action, kind, reason, actor_id)
    VALUES (p_document_id, v_company_id, 'REOPENED', NULL, btrim(p_reason), auth.uid());

    RETURN jsonb_build_object('success', true, 'document_id', p_document_id, 'closed', false);
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_reopen_payment_document(uuid,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fin_reopen_payment_document(uuid,text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Posting preview: sales invoice with cost and advances; customer receipts
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_posting_preview(p_document_type text, p_document_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id uuid;
    v_settings record;
    v_lines jsonb := '[]'::jsonb;
    v_total numeric(18,2);
    v_description text;
    v_entity_id uuid;
    v_entity_name text;
    v_cash_account record;
    v_ap_account record;
    v_ar_account record;
    v_sales_account record;
    v_deposit_account record;
    v_cogs_account record;
    v_inventory_account record;
    v_debit_account record;
    v_payment_ctx jsonb;
    v_request_details jsonb;
    v_deposit_amount numeric(18,2);
    v_balance_amount numeric(18,2);
    v_order_total numeric(18,2);
    v_extra jsonb := '{}'::jsonb;
    v_customer_deposit_account record;
    v_credit_account record;
    v_sales_ctx jsonb;
    v_revenue numeric(18,2);
    v_cost numeric(18,2);
    v_advances numeric(18,2);
BEGIN
    v_company_id := public.get_user_company_id();

    SELECT * INTO v_settings FROM public.gl_settings WHERE company_id = v_company_id;
    IF v_settings IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'GL Settings not configured for this company');
    END IF;

    /* cash-from-default-bank */
    SELECT g.id, g.name, g.code INTO v_cash_account
    FROM public.bank_accounts ba
    JOIN public.gl_accounts g ON g.id = ba.gl_account_id
    WHERE ba.company_id = v_company_id AND ba.is_default AND ba.is_active
    ORDER BY ba.created_at
    LIMIT 1;
    IF v_cash_account.id IS NULL THEN
        SELECT id, name, code INTO v_cash_account FROM public.gl_accounts WHERE id = v_settings.cash_account_id;
    END IF;
    SELECT id, name, code INTO v_ap_account FROM public.gl_accounts WHERE id = v_settings.ap_control_account_id;
    SELECT id, name, code INTO v_ar_account FROM public.gl_accounts WHERE id = v_settings.ar_control_account_id;
    SELECT id, name, code INTO v_sales_account FROM public.gl_accounts WHERE id = v_settings.sales_revenue_account_id;
    SELECT id, name, code INTO v_deposit_account FROM public.gl_accounts WHERE id = v_settings.supplier_deposit_account_id;
    SELECT id, name, code INTO v_cogs_account FROM public.gl_accounts WHERE id = v_settings.cogs_account_id;
    SELECT id, name, code INTO v_inventory_account FROM public.gl_accounts WHERE id = v_settings.inventory_account_id;
    SELECT id, name, code INTO v_customer_deposit_account FROM public.gl_accounts WHERE id = v_settings.customer_deposit_account_id;

    CASE p_document_type

        -- Supplier payments (deposit or balance document): the actual amount is entered
        -- at posting; the preview shows the remaining requested amount.
        WHEN 'SUPPLIER_DEPOSIT_PAYMENT', 'SUPPLIER_BALANCE_PAYMENT' THEN
            v_payment_ctx := public.fin_supplier_payment_context(p_document_id);
            IF NOT (v_payment_ctx->>'success')::boolean THEN
                RETURN v_payment_ctx;
            END IF;

            IF (v_payment_ctx->>'gl_doc_type') <> p_document_type THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'This document is a ' || (v_payment_ctx->>'gl_doc_type') || ', not a ' || p_document_type);
            END IF;

            /* finance-supplier-ack-setting */
            IF COALESCE((v_payment_ctx->>'blocked_by_ack')::boolean, false) THEN
                RETURN jsonb_build_object('success', false, 'error', 'The supplier has not acknowledged this payment yet. Finance settings require the supplier''s acknowledgment before a payment can be posted.');
            END IF;

            v_total := LEAST(
                CASE WHEN (v_payment_ctx->>'remaining_requested')::numeric > 0
                     THEN (v_payment_ctx->>'remaining_requested')::numeric
                     ELSE (v_payment_ctx->>'requested_amount')::numeric END,
                (v_payment_ctx->>'order_unpaid')::numeric);
            v_entity_id := (v_payment_ctx->>'supplier_org_id')::uuid;
            v_entity_name := v_payment_ctx->>'supplier_name';

            IF v_payment_ctx->>'stage' = 'ADVANCE' THEN
                v_debit_account := v_deposit_account;
                v_description := 'Supplier Advance Payment: ' || (v_payment_ctx->>'payment_doc_no');
            ELSE
                v_debit_account := v_ap_account;
                v_description := 'Supplier Payment: ' || (v_payment_ctx->>'payment_doc_no');
            END IF;

            IF v_debit_account.id IS NULL THEN
                RETURN jsonb_build_object('success', false, 'error',
                    CASE WHEN v_payment_ctx->>'stage' = 'ADVANCE' THEN 'Supplier Deposits account not configured'
                         ELSE 'Accounts Payable account not configured' END);
            END IF;

            v_lines := jsonb_build_array(
                jsonb_build_object('account_id', v_debit_account.id, 'account_name', v_debit_account.name,
                    'account_code', v_debit_account.code, 'debit', v_total, 'credit', 0,
                    'entity_type', 'SUPPLIER', 'entity_id', v_entity_id, 'entity_name', v_entity_name),
                jsonb_build_object('account_id', v_cash_account.id, 'account_name', v_cash_account.name,
                    'account_code', v_cash_account.code, 'debit', 0, 'credit', v_total,
                    'entity_type', NULL, 'entity_id', NULL, 'entity_name', NULL)
            );

            v_extra := jsonb_build_object(
                'is_payment', true,
                'direction', 'OUT',
                'stage', v_payment_ctx->>'stage',
                'requested_amount', (v_payment_ctx->>'requested_amount')::numeric,
                'paid_on_document', (v_payment_ctx->>'paid_on_document')::numeric,
                'remaining_requested', (v_payment_ctx->>'remaining_requested')::numeric,
                'order_total', (v_payment_ctx->>'order_total')::numeric,
                'order_paid_total', (v_payment_ctx->>'order_paid_total')::numeric,
                'max_amount', (v_payment_ctx->>'order_unpaid')::numeric
            );

        -- Supplier invoice: Dr Inventory 100%, Cr Supplier Deposits (advances actually
        -- paid), Cr Accounts Payable (the rest). Zero lines are left out.
        WHEN 'SUPPLIER_INVOICE_RECOGNITION' THEN
            v_request_details := public.get_balance_request_posting_details(p_document_id);
            IF NOT (v_request_details->>'success')::boolean THEN
                RETURN v_request_details;
            END IF;

            v_order_total := (v_request_details->>'order_total')::numeric;
            v_deposit_amount := (v_request_details->>'deposit_amount')::numeric;
            v_balance_amount := (v_request_details->>'balance_amount')::numeric;
            v_description := v_request_details->>'description';
            v_entity_id := (v_request_details->>'supplier_org_id')::uuid;
            v_entity_name := v_request_details->>'supplier_name';

            /* finance-purchases-to-inventory */
            IF v_inventory_account.id IS NULL THEN
                RETURN jsonb_build_object('success', false, 'error', 'Inventory account not configured. Please set it in Default Accounts.');
            END IF;
            IF v_deposit_amount > 0 AND v_deposit_account.id IS NULL THEN
                RETURN jsonb_build_object('success', false, 'error', 'Supplier Deposits account not configured');
            END IF;
            IF v_balance_amount > 0 AND v_ap_account.id IS NULL THEN
                RETURN jsonb_build_object('success', false, 'error', 'Accounts Payable account not configured');
            END IF;

            v_total := v_order_total;

            v_lines := jsonb_build_array(
                jsonb_build_object('account_id', v_inventory_account.id, 'account_name', v_inventory_account.name,
                    'account_code', v_inventory_account.code, 'debit', v_order_total, 'credit', 0,
                    'entity_type', 'SUPPLIER', 'entity_id', v_entity_id, 'entity_name', v_entity_name)
            );
            IF v_deposit_amount > 0 THEN
                v_lines := v_lines || jsonb_build_array(
                    jsonb_build_object('account_id', v_deposit_account.id, 'account_name', v_deposit_account.name,
                        'account_code', v_deposit_account.code, 'debit', 0, 'credit', v_deposit_amount,
                        'entity_type', 'SUPPLIER', 'entity_id', v_entity_id, 'entity_name', v_entity_name));
            END IF;
            IF v_balance_amount > 0 THEN
                v_lines := v_lines || jsonb_build_array(
                    jsonb_build_object('account_id', v_ap_account.id, 'account_name', v_ap_account.name,
                        'account_code', v_ap_account.code, 'debit', 0, 'credit', v_balance_amount,
                        'entity_type', 'SUPPLIER', 'entity_id', v_entity_id, 'entity_name', v_entity_name));
            END IF;

        -- Sales invoice (D2H): revenue, cost of goods sold at the product's fixed cost
        -- (base_cost), and customer money received before the invoice applied to it.
        --   Dr Accounts Receivable / Cr Sales            (order total)
        --   Dr Cost of Goods Sold  / Cr Inventory        (qty x base_cost)
        --   Dr Customer Deposits   / Cr Accounts Receivable (advances received)
        WHEN 'SALES_INVOICE' THEN
            v_sales_ctx := public.fin_sales_invoice_context(p_document_id);
            IF NOT COALESCE((v_sales_ctx->>'success')::boolean, false) THEN
                RETURN v_sales_ctx;
            END IF;

            v_revenue := (v_sales_ctx->>'revenue')::numeric;
            v_cost := (v_sales_ctx->>'cost')::numeric;
            v_advances := (v_sales_ctx->>'advances_applied')::numeric;
            v_entity_id := (v_sales_ctx->>'customer_org_id')::uuid;
            v_entity_name := v_sales_ctx->>'customer_name';
            v_description := 'Sales Invoice: ' || (v_sales_ctx->>'document_number');

            IF v_revenue IS NULL OR v_revenue = 0 THEN
                RETURN jsonb_build_object('success', false, 'error', 'The sales invoice has no amount');
            END IF;
            IF v_sales_ctx->>'products_without_cost' IS NOT NULL THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'These products have no cost (base_cost), so cost of goods sold cannot be posted: '
                    || (v_sales_ctx->>'products_without_cost') || '. Set their cost in Products first.');
            END IF;
            IF v_ar_account.id IS NULL THEN
                RETURN jsonb_build_object('success', false, 'error', 'Accounts Receivable account not configured');
            END IF;
            IF v_sales_account.id IS NULL THEN
                RETURN jsonb_build_object('success', false, 'error', 'Sales Revenue account not configured');
            END IF;
            IF v_cost > 0 AND (v_cogs_account.id IS NULL OR v_inventory_account.id IS NULL) THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Cost of Goods Sold and Inventory accounts must be configured in Default Accounts');
            END IF;
            IF v_advances > 0 AND v_customer_deposit_account.id IS NULL THEN
                RETURN jsonb_build_object('success', false, 'error', 'Customer Deposits account not configured. Please set it in Default Accounts.');
            END IF;

            v_total := v_revenue;
            v_lines := jsonb_build_array(
                jsonb_build_object('account_id', v_ar_account.id, 'account_name', v_ar_account.name,
                    'account_code', v_ar_account.code, 'debit', v_revenue, 'credit', 0,
                    'entity_type', 'CUSTOMER', 'entity_id', v_entity_id, 'entity_name', v_entity_name),
                jsonb_build_object('account_id', v_sales_account.id, 'account_name', v_sales_account.name,
                    'account_code', v_sales_account.code, 'debit', 0, 'credit', v_revenue,
                    'entity_type', NULL, 'entity_id', NULL, 'entity_name', NULL)
            );
            IF v_cost > 0 THEN
                v_lines := v_lines || jsonb_build_array(
                    jsonb_build_object('account_id', v_cogs_account.id, 'account_name', v_cogs_account.name,
                        'account_code', v_cogs_account.code, 'debit', v_cost, 'credit', 0,
                        'entity_type', NULL, 'entity_id', NULL, 'entity_name', NULL),
                    jsonb_build_object('account_id', v_inventory_account.id, 'account_name', v_inventory_account.name,
                        'account_code', v_inventory_account.code, 'debit', 0, 'credit', v_cost,
                        'entity_type', NULL, 'entity_id', NULL, 'entity_name', NULL));
            END IF;
            IF v_advances > 0 THEN
                v_lines := v_lines || jsonb_build_array(
                    jsonb_build_object('account_id', v_customer_deposit_account.id, 'account_name', v_customer_deposit_account.name,
                        'account_code', v_customer_deposit_account.code, 'debit', v_advances, 'credit', 0,
                        'entity_type', 'CUSTOMER', 'entity_id', v_entity_id, 'entity_name', v_entity_name),
                    jsonb_build_object('account_id', v_ar_account.id, 'account_name', v_ar_account.name,
                        'account_code', v_ar_account.code, 'debit', 0, 'credit', v_advances,
                        'entity_type', 'CUSTOMER', 'entity_id', v_entity_id, 'entity_name', v_entity_name));
            END IF;

            v_extra := jsonb_build_object(
                'revenue', v_revenue,
                'cost_of_sales', v_cost,
                'gross_profit', v_revenue - v_cost,
                'advances_applied', v_advances
            );

        -- Customer receipt (D2H): the amount actually received is entered at posting;
        -- the preview suggests the receipt's amount, at most what is unpaid on the order.
        WHEN 'RECEIPT' THEN
            v_payment_ctx := public.fin_customer_receipt_context(p_document_id);
            IF NOT COALESCE((v_payment_ctx->>'success')::boolean, false) THEN
                RETURN v_payment_ctx;
            END IF;
            IF COALESCE((v_payment_ctx->>'closed')::boolean, false) THEN
                RETURN jsonb_build_object('success', false, 'error', 'This receipt document is closed. Reopen it to post another receipt on it.');
            END IF;

            v_total := LEAST((v_payment_ctx->>'requested_amount')::numeric, (v_payment_ctx->>'order_unpaid')::numeric);
            v_entity_id := (v_payment_ctx->>'customer_org_id')::uuid;
            v_entity_name := v_payment_ctx->>'customer_name';

            IF v_payment_ctx->>'stage' = 'ADVANCE' THEN
                v_credit_account := v_customer_deposit_account;
                v_description := 'Customer Advance Receipt: ' || (v_payment_ctx->>'document_number');
            ELSE
                v_credit_account := v_ar_account;
                v_description := 'Customer Receipt: ' || (v_payment_ctx->>'document_number');
            END IF;

            IF v_credit_account.id IS NULL THEN
                RETURN jsonb_build_object('success', false, 'error',
                    CASE WHEN v_payment_ctx->>'stage' = 'ADVANCE' THEN 'Customer Deposits account not configured. Please set it in Default Accounts.'
                         ELSE 'Accounts Receivable account not configured' END);
            END IF;

            v_lines := jsonb_build_array(
                jsonb_build_object('account_id', v_cash_account.id, 'account_name', v_cash_account.name,
                    'account_code', v_cash_account.code, 'debit', v_total, 'credit', 0,
                    'entity_type', NULL, 'entity_id', NULL, 'entity_name', NULL),
                jsonb_build_object('account_id', v_credit_account.id, 'account_name', v_credit_account.name,
                    'account_code', v_credit_account.code, 'debit', 0, 'credit', v_total,
                    'entity_type', 'CUSTOMER', 'entity_id', v_entity_id, 'entity_name', v_entity_name)
            );

            v_extra := jsonb_build_object(
                'is_payment', true,
                'direction', 'IN',
                'stage', v_payment_ctx->>'stage',
                'requested_amount', (v_payment_ctx->>'requested_amount')::numeric,
                'paid_on_document', (v_payment_ctx->>'paid_on_document')::numeric,
                'remaining_requested', (v_payment_ctx->>'order_unpaid')::numeric,
                'order_total', (v_payment_ctx->>'order_total')::numeric,
                'order_paid_total', (v_payment_ctx->>'order_paid_total')::numeric,
                'max_amount', (v_payment_ctx->>'order_unpaid')::numeric
            );

        ELSE
            RETURN jsonb_build_object('success', false, 'error', 'Unknown document type: ' || p_document_type || '. Supported: SUPPLIER_DEPOSIT_PAYMENT, SUPPLIER_INVOICE_RECOGNITION, SUPPLIER_BALANCE_PAYMENT, SALES_INVOICE, RECEIPT');
    END CASE;

    RETURN jsonb_build_object(
        'success', true,
        'document_type', p_document_type,
        'document_id', p_document_id,
        'description', v_description,
        'total_amount', v_total,
        'lines', v_lines,
        'is_balanced', true
    ) || v_extra;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 8. Posting: receipts route to fin_post_customer_receipt; no double sales posting
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_document_to_gl(p_document_type text, p_document_id uuid, p_posting_date date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id uuid;
    v_journal_id uuid;
    v_journal_number text;
    v_journal_type text;
    v_preview jsonb;
    v_line jsonb;
    v_line_number integer := 0;
    v_total_debit numeric(18,2) := 0;
    v_total_credit numeric(18,2) := 0;
    v_doc_number text;
    v_payment_ctx jsonb;
    v_amount numeric(18,2);
BEGIN
  /* sa-guard:finance.journal.post */
  PERFORM public.sa_require_operation('finance.journal.post', jsonb_build_object('organization_id', public.get_user_company_id()), p_document_type, p_document_id::text);
    IF public.sa_legacy_guard_unless_new('finance.journal.post') AND NOT public.is_hq_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only HQ Admins can post to GL');
    END IF;

    v_company_id := public.get_user_company_id();

    IF public.is_document_posted(p_document_type, p_document_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'Document is already posted to GL');
    END IF;

    /* finance-actual-supplier-payments */
    IF p_document_type IN ('SUPPLIER_DEPOSIT_PAYMENT', 'SUPPLIER_BALANCE_PAYMENT') THEN
        v_payment_ctx := public.fin_supplier_payment_context(p_document_id);
        IF NOT COALESCE((v_payment_ctx->>'success')::boolean, false) THEN
            RETURN v_payment_ctx;
        END IF;
        IF (v_payment_ctx->>'gl_doc_type') <> p_document_type THEN
            RETURN jsonb_build_object('success', false, 'error',
                'This document is a ' || (v_payment_ctx->>'gl_doc_type') || ', not a ' || p_document_type);
        END IF;
        v_amount := LEAST((v_payment_ctx->>'remaining_requested')::numeric, (v_payment_ctx->>'order_unpaid')::numeric);
        IF v_amount <= 0 THEN
            RETURN jsonb_build_object('success', false, 'error',
                'Nothing remains to pay on this document by its terms. Open it and enter the actual amount.');
        END IF;
        RETURN public.fin_post_supplier_payment(p_document_id, v_amount, p_posting_date, NULL, NULL, true);
    END IF;

    /* finance-d2h-sales */
    -- Customer receipt without an amount (batch posting): the suggested amount, to the default bank.
    IF p_document_type = 'RECEIPT' THEN
        v_payment_ctx := public.fin_customer_receipt_context(p_document_id);
        IF NOT COALESCE((v_payment_ctx->>'success')::boolean, false) THEN
            RETURN v_payment_ctx;
        END IF;
        v_amount := LEAST((v_payment_ctx->>'requested_amount')::numeric, (v_payment_ctx->>'order_unpaid')::numeric);
        IF v_amount <= 0 THEN
            RETURN jsonb_build_object('success', false, 'error',
                'Nothing remains to be received on this order. Open the receipt to check it.');
        END IF;
        RETURN public.fin_post_customer_receipt(p_document_id, v_amount, p_posting_date, NULL, NULL, false);
    END IF;

    -- A sales order posted the old way (by order id) must not be posted again from its invoice.
    IF p_document_type = 'SALES_INVOICE' AND EXISTS (
        SELECT 1 FROM public.gl_document_postings dp
        JOIN public.documents d ON d.order_id = dp.document_id
        WHERE d.id = p_document_id AND dp.document_type = 'SALES_INVOICE' AND dp.posting_status = 'POSTED')
    THEN
        RETURN jsonb_build_object('success', false, 'error', 'This sales order was already posted to GL');
    END IF;

    v_preview := public.get_posting_preview(p_document_type, p_document_id);
    IF NOT (v_preview->>'success')::boolean THEN
        RETURN v_preview;
    END IF;

    v_journal_type := CASE p_document_type
        WHEN 'SUPPLIER_DEPOSIT_PAYMENT' THEN 'SUPPLIER_DEPOSIT'
        WHEN 'SUPPLIER_INVOICE_RECOGNITION' THEN 'SUPPLIER_PAYMENT'
        WHEN 'SUPPLIER_BALANCE_PAYMENT' THEN 'SUPPLIER_PAYMENT'
        WHEN 'SALES_INVOICE' THEN 'SALES_INVOICE'
        WHEN 'RECEIPT' THEN 'RECEIPT'
        ELSE 'ADJUSTMENT'
    END;

    v_journal_number := public.generate_journal_number(v_company_id, v_journal_type);

    FOR v_line IN SELECT * FROM jsonb_array_elements(v_preview->'lines')
    LOOP
        v_total_debit := v_total_debit + COALESCE((v_line->>'debit')::numeric, 0);
        v_total_credit := v_total_credit + COALESCE((v_line->>'credit')::numeric, 0);
    END LOOP;

    IF v_total_debit <> v_total_credit THEN
        RETURN jsonb_build_object('success', false, 'error', 'Journal is not balanced. Debit: ' || v_total_debit || ', Credit: ' || v_total_credit);
    END IF;

    SELECT COALESCE(display_doc_no, doc_no) INTO v_doc_number FROM public.documents WHERE id = p_document_id;

    IF v_doc_number IS NULL AND p_document_type = 'SALES_INVOICE' THEN
        SELECT COALESCE(display_doc_no, order_no) INTO v_doc_number FROM public.orders WHERE id = p_document_id;
    END IF;

    INSERT INTO public.gl_journals (
        company_id, journal_number, journal_date, posting_date, description, journal_type,
        status, total_debit, total_credit, created_by, posted_by, posted_at
    ) VALUES (
        v_company_id, v_journal_number, p_posting_date, p_posting_date,
        COALESCE(v_preview->>'description', 'Journal Entry'), v_journal_type,
        'POSTED', v_total_debit, v_total_credit, auth.uid(), auth.uid(), now()
    ) RETURNING id INTO v_journal_id;

    FOR v_line IN SELECT * FROM jsonb_array_elements(v_preview->'lines')
    LOOP
        v_line_number := v_line_number + 1;
        INSERT INTO public.gl_journal_lines (
            journal_id, account_id, line_number, description, debit_amount, credit_amount,
            entity_type, entity_id, created_by
        ) VALUES (
            v_journal_id,
            (v_line->>'account_id')::uuid,
            v_line_number,
            v_line->>'description',
            COALESCE((v_line->>'debit')::numeric, 0),
            COALESCE((v_line->>'credit')::numeric, 0),
            CASE WHEN v_line->>'entity_type' = '' THEN NULL ELSE v_line->>'entity_type' END,
            CASE WHEN v_line->>'entity_id' = '' THEN NULL ELSE (v_line->>'entity_id')::uuid END,
            auth.uid()
        );
    END LOOP;

    INSERT INTO public.gl_document_postings (
        company_id, document_type, document_id, document_number, journal_id,
        posted_amount, posting_status, created_by
    ) VALUES (
        v_company_id, p_document_type, p_document_id, v_doc_number, v_journal_id,
        CASE WHEN p_document_type = 'SALES_INVOICE' THEN COALESCE((v_preview->>'total_amount')::numeric, v_total_debit)
             ELSE v_total_debit END,
        'POSTED', auth.uid()
    );

    RETURN jsonb_build_object(
        'success', true,
        'journal_id', v_journal_id,
        'journal_number', v_journal_number,
        'document_type', p_document_type,
        'document_id', p_document_id,
        'document_number', v_doc_number,
        'posted_amount', CASE WHEN p_document_type = 'SALES_INVOICE' THEN COALESCE((v_preview->>'total_amount')::numeric, v_total_debit) ELSE v_total_debit END,
        'posting_date', p_posting_date,
        'lines_created', v_line_number
    );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 9. Reversal: sales order of reversal; receipts reopen their document
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_reverse_journal(p_journal_id uuid, p_reason text, p_reversal_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id  uuid := public.get_user_company_id();
    v_today       date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
    v_reason      text := NULLIF(btrim(COALESCE(p_reason, '')), '');
    v_journal     record;
    v_payment     record;
    v_posting     record;
    v_order_id    uuid;
    v_rev_id      uuid := gen_random_uuid();
    v_rev_number  text;
    v_doc_type    text;
    v_doc_id      uuid;
    v_blockers    text;
    v_doc         record;
BEGIN
  /* sa-guard:finance.payment.approve */
  PERFORM public.sa_require_operation('finance.payment.approve', jsonb_build_object('organization_id', v_company_id), 'JOURNAL_REVERSAL', p_journal_id::text);
    IF public.sa_legacy_guard_unless_new('finance.payment.approve') AND NOT public.is_hq_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only HQ Admins can reverse journals');
    END IF;

    IF v_reason IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Enter the reason for the reversal');
    END IF;
    IF length(v_reason) > 300 THEN
        RETURN jsonb_build_object('success', false, 'error', 'The reason is too long (300 characters at most)');
    END IF;

    SELECT * INTO v_journal FROM public.gl_journals
    WHERE id = p_journal_id AND company_id = v_company_id FOR UPDATE;
    IF v_journal.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Journal not found');
    END IF;
    -- Segregation of duties: whoever created, edited or posted a journal cannot reverse it.
    IF auth.uid() IS NOT NULL AND (v_journal.created_by = auth.uid() OR v_journal.posted_by = auth.uid()
                                   OR v_journal.last_edited_by = auth.uid()) THEN
        RETURN jsonb_build_object('success', false, 'error',
            'You created, edited or posted this journal. Another user with reversal permission must reverse it.');
    END IF;
    IF v_journal.status = 'REVERSED' OR v_journal.reversal_journal_id IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'This journal has already been reversed');
    END IF;
    IF v_journal.status <> 'POSTED' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only posted journals can be reversed');
    END IF;
    IF v_journal.is_reversal OR v_journal.journal_type = 'REVERSAL' THEN
        RETURN jsonb_build_object('success', false, 'error', 'A reversal journal cannot be reversed');
    END IF;
    IF v_journal.journal_type IN ('PAYROLL_RUN', 'PAYROLL_PAYMENT', 'EXPENSE_CLAIM', 'EXPENSE_REIMBURSEMENT') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Payroll and expense journals are reversed from the HR module');
    END IF;

    IF p_reversal_date IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Enter the reversal date');
    END IF;
    IF p_reversal_date > v_today THEN
        RETURN jsonb_build_object('success', false, 'error', 'The reversal date cannot be in the future');
    END IF;
    IF p_reversal_date < v_journal.journal_date THEN
        RETURN jsonb_build_object('success', false, 'error',
            'The reversal date cannot be before the journal date (' || to_char(v_journal.journal_date, 'DD/MM/YYYY') || ')');
    END IF;
    IF EXISTS (SELECT 1 FROM public.fiscal_periods fp WHERE fp.company_id = v_company_id)
       AND NOT public.is_posting_date_allowed(p_reversal_date, v_company_id) THEN
        RETURN jsonb_build_object('success', false, 'error',
            'Reversal date ' || to_char(p_reversal_date, 'DD/MM/YYYY') || ' is not in an open accounting period');
    END IF;

    -- What the journal came from.
    SELECT * INTO v_payment FROM public.fin_payments
    WHERE journal_id = p_journal_id AND status = 'POSTED' LIMIT 1;

    IF v_payment.id IS NULL THEN
        SELECT * INTO v_posting FROM public.gl_document_postings
        WHERE journal_id = p_journal_id AND company_id = v_company_id AND posting_status = 'POSTED'
          AND document_type NOT IN ('PAYROLL_RUN', 'PAYROLL_PAYMENT', 'EXPENSE_CLAIM', 'EXPENSE_REIMBURSEMENT')
        LIMIT 1;
    END IF;

    IF v_payment.id IS NOT NULL THEN
        v_doc_type := v_payment.document_type;
        v_doc_id   := v_payment.document_id;
        v_order_id := v_payment.order_id;
        PERFORM 1 FROM public.orders WHERE id = v_order_id FOR UPDATE;

        -- An advance already applied by a posted invoice (supplier or sales): reverse the invoice first.
        IF v_payment.stage = 'ADVANCE' AND EXISTS (
            SELECT 1 FROM public.gl_document_postings dp
            JOIN public.documents r ON r.id = dp.document_id
            WHERE r.order_id = v_order_id
              AND dp.document_type = CASE WHEN v_payment.direction = 'IN' THEN 'SALES_INVOICE'
                                          ELSE 'SUPPLIER_INVOICE_RECOGNITION' END
              AND dp.posting_status = 'POSTED')
        THEN
            RETURN jsonb_build_object('success', false, 'error',
                CASE WHEN v_payment.direction = 'IN'
                     THEN 'The sales invoice for this order has already applied this advance. Reverse the sales invoice journal first.'
                     ELSE 'The supplier invoice for this order has already applied this advance. Reverse the supplier invoice journal first.' END);
        END IF;
    ELSIF v_posting.id IS NOT NULL THEN
        v_doc_type := v_posting.document_type;
        v_doc_id   := v_posting.document_id;
        SELECT order_id INTO v_order_id FROM public.documents WHERE id = v_doc_id;

        -- A supplier invoice with payments made against it (Dr AP): reverse those payments first.
        IF v_doc_type = 'SUPPLIER_INVOICE_RECOGNITION' AND v_order_id IS NOT NULL THEN
            PERFORM 1 FROM public.orders WHERE id = v_order_id FOR UPDATE;
            SELECT string_agg(DISTINCT j.journal_number, ', ') INTO v_blockers
            FROM (
                SELECT fp.journal_id FROM public.fin_payments fp
                WHERE fp.order_id = v_order_id AND fp.direction = 'OUT'
                  AND fp.stage = 'SETTLEMENT' AND fp.status = 'POSTED'
                UNION
                SELECT dp.journal_id FROM public.gl_document_postings dp
                JOIN public.documents d ON d.id = dp.document_id
                WHERE d.order_id = v_order_id
                  AND dp.document_type = 'SUPPLIER_BALANCE_PAYMENT'
                  AND dp.posting_status = 'POSTED'
                  AND NOT EXISTS (SELECT 1 FROM public.fin_payments x WHERE x.document_id = dp.document_id)
            ) s
            JOIN public.gl_journals j ON j.id = s.journal_id;

            IF v_blockers IS NOT NULL THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Payments were made against this supplier invoice. Reverse these payment journals first: ' || v_blockers);
            END IF;
        END IF;

        -- A sales invoice with receipts posted against it (Cr AR): reverse those receipts first.
        IF v_doc_type = 'SALES_INVOICE' THEN
            v_order_id := COALESCE(v_order_id, v_doc_id);
            PERFORM 1 FROM public.orders WHERE id = v_order_id FOR UPDATE;
            SELECT string_agg(DISTINCT j.journal_number, ', ') INTO v_blockers
            FROM public.fin_payments fp
            JOIN public.gl_journals j ON j.id = fp.journal_id
            WHERE fp.order_id = v_order_id AND fp.direction = 'IN'
              AND fp.stage = 'SETTLEMENT' AND fp.status = 'POSTED';

            IF v_blockers IS NOT NULL THEN
                RETURN jsonb_build_object('success', false, 'error',
                    'Receipts were posted against this sales invoice. Reverse these receipt journals first: ' || v_blockers);
            END IF;
        END IF;
    END IF;

    -- Reversal journal: same lines, debit and credit swapped, on the reversal date.
    v_rev_number := public.generate_journal_number(v_company_id, 'REVERSAL');

    INSERT INTO public.gl_journals (
        id, company_id, journal_number, journal_date, posting_date, description, reference, journal_type,
        status, is_reversal, reversed_journal_id, reversal_reason, total_debit, total_credit,
        created_by, posted_by, posted_at
    ) VALUES (
        v_rev_id, v_company_id, v_rev_number, p_reversal_date, p_reversal_date,
        'Reversal of ' || v_journal.journal_number || ': ' || v_reason,
        v_journal.reference, 'REVERSAL', 'POSTED', true, p_journal_id, v_reason,
        v_journal.total_credit, v_journal.total_debit, auth.uid(), auth.uid(), now()
    );

    INSERT INTO public.gl_journal_lines (journal_id, account_id, line_number, description,
        debit_amount, credit_amount, entity_type, entity_id, created_by)
    SELECT v_rev_id, l.account_id, l.line_number,
           'Reversal: ' || COALESCE(l.description, v_journal.description),
           l.credit_amount, l.debit_amount, l.entity_type, l.entity_id, auth.uid()
    FROM public.gl_journal_lines l
    WHERE l.journal_id = p_journal_id;

    UPDATE public.gl_journals
    SET status = 'REVERSED', reversal_journal_id = v_rev_id, reversal_reason = v_reason
    WHERE id = p_journal_id;

    -- Finance effects.
    IF v_payment.id IS NOT NULL THEN
        UPDATE public.fin_payments SET status = 'REVERSED' WHERE journal_id = p_journal_id;

        -- Reopen this document, and documents auto-closed because the order was fully paid.
        FOR v_doc IN
            SELECT c.document_id, c.company_id FROM public.fin_document_closures c
            WHERE c.document_id = v_doc_id
            UNION
            SELECT c.document_id, c.company_id FROM public.fin_document_closures c
            JOIN public.documents d ON d.id = c.document_id
            WHERE d.order_id = v_order_id AND c.kind = 'AUTO'
        LOOP
            DELETE FROM public.fin_document_closures WHERE document_id = v_doc.document_id;
            INSERT INTO public.fin_document_closure_events (document_id, company_id, action, kind, reason, actor_id)
            VALUES (v_doc.document_id, v_doc.company_id, 'REOPENED', NULL,
                    'Payment journal ' || v_journal.journal_number || ' reversed: ' || v_reason, auth.uid());
        END LOOP;

        DELETE FROM public.gl_document_postings dp
        USING public.documents d
        WHERE d.id = dp.document_id
          AND dp.company_id = v_company_id
          AND dp.document_type IN ('SUPPLIER_DEPOSIT_PAYMENT', 'SUPPLIER_BALANCE_PAYMENT', 'RECEIPT')
          AND EXISTS (SELECT 1 FROM public.fin_payments fp WHERE fp.document_id = dp.document_id)
          AND NOT EXISTS (SELECT 1 FROM public.fin_document_closures c WHERE c.document_id = dp.document_id)
          AND d.order_id = v_order_id;
    ELSIF v_posting.id IS NOT NULL THEN
        -- The document returns to Pending Postings; the reversal record keeps the link.
        DELETE FROM public.gl_document_postings WHERE id = v_posting.id;
    END IF;

    INSERT INTO public.fin_journal_reversals (
        company_id, journal_id, reversal_journal_id, document_type, document_id,
        reason, reversal_date, actor_id
    ) VALUES (
        v_company_id, p_journal_id, v_rev_id, v_doc_type, v_doc_id, v_reason, p_reversal_date, auth.uid()
    );

    RETURN jsonb_build_object(
        'success', true,
        'journal_id', p_journal_id,
        'reversal_journal_id', v_rev_id,
        'reversal_number', v_rev_number,
        'document_type', v_doc_type,
        'document_id', v_doc_id,
        'document_reopened', v_doc_id IS NOT NULL
    );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 10. Pending Postings view
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
    GREATEST(round(COALESCE(( SELECT sum(order_items.line_total) AS sum
           FROM order_items
          WHERE order_items.order_id = o.id), 0::numeric) * COALESCE((o.payment_terms ->> 'deposit_pct'::text)::numeric, 0.3), 2)
        - COALESCE(( SELECT sum(fp.amount) FROM fin_payments fp WHERE fp.document_id = d.id AND fp.status = 'POSTED'::text), 0::numeric), 0::numeric) AS amount,
    seller_org.org_name AS supplier_name,
    buyer_org.org_name AS buyer_name,
    COALESCE(( SELECT sum(fp.amount) FROM fin_payments fp WHERE fp.document_id = d.id AND fp.status = 'POSTED'::text), 0::numeric) AS paid_amount
   FROM documents d
     JOIN orders o ON o.id = d.order_id
     LEFT JOIN organizations seller_org ON seller_org.id = o.seller_org_id
     LEFT JOIN organizations buyer_org ON buyer_org.id = o.buyer_org_id
  WHERE d.doc_type = 'PAYMENT'::document_type AND o.order_type = 'H2M'::order_type AND d.doc_no !~~ '%-BAL%'::text AND NOT d.payload ? 'source_request_id'::text
    AND NOT (EXISTS ( SELECT 1 FROM fin_document_closures c WHERE c.document_id = d.id))
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
  WHERE d.doc_type = 'PAYMENT_REQUEST'::document_type
    -- finance-require-acknowledged-request
    AND d.status::text = ANY (ARRAY['acknowledged'::text, 'completed'::text])
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
    GREATEST(round(COALESCE(( SELECT sum(order_items.line_total) AS sum
           FROM order_items
          WHERE order_items.order_id = o.id), 0::numeric) * COALESCE((o.payment_terms ->> 'balance_pct'::text)::numeric, 0.7), 2)
        - COALESCE(( SELECT sum(fp.amount) FROM fin_payments fp WHERE fp.document_id = d.id AND fp.status = 'POSTED'::text), 0::numeric), 0::numeric) AS amount,
    seller_org.org_name AS supplier_name,
    buyer_org.org_name AS buyer_name,
    COALESCE(( SELECT sum(fp.amount) FROM fin_payments fp WHERE fp.document_id = d.id AND fp.status = 'POSTED'::text), 0::numeric) AS paid_amount
   FROM documents d
     JOIN orders o ON o.id = d.order_id
     LEFT JOIN organizations seller_org ON seller_org.id = o.seller_org_id
     LEFT JOIN organizations buyer_org ON buyer_org.id = o.buyer_org_id
  WHERE d.doc_type = 'PAYMENT'::document_type AND o.order_type = 'H2M'::order_type AND (d.doc_no ~~ '%-BAL%'::text OR d.payload ? 'source_request_id'::text)
    AND NOT (EXISTS ( SELECT 1 FROM fin_document_closures c WHERE c.document_id = d.id))
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
    'SALES_INVOICE'::text AS gl_doc_type,
    'Sales Invoice'::text AS posting_label,
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
  WHERE d.doc_type = 'INVOICE'::document_type AND o.order_type = 'D2H'::order_type AND NOT (EXISTS ( SELECT 1
           FROM gl_document_postings dp
          WHERE dp.document_id = d.id AND dp.company_id = d.company_id AND dp.posting_status = 'POSTED'::text))
    AND NOT (EXISTS ( SELECT 1 FROM gl_document_postings dpo
          WHERE dpo.document_id = o.id AND dpo.document_type = 'SALES_INVOICE'::text AND dpo.posting_status = 'POSTED'::text))
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
    GREATEST(COALESCE(( SELECT sum(order_items.line_total) AS sum
           FROM order_items
          WHERE order_items.order_id = o.id), 0::numeric)
        - COALESCE(( SELECT sum(fp.amount) FROM fin_payments fp
          WHERE fp.order_id = o.id AND fp.direction = 'IN'::text AND fp.status = 'POSTED'::text), 0::numeric), 0::numeric) AS amount,
    seller_org.org_name AS supplier_name,
    buyer_org.org_name AS buyer_name,
    COALESCE(( SELECT sum(fp.amount) FROM fin_payments fp WHERE fp.document_id = d.id AND fp.status = 'POSTED'::text), 0::numeric) AS paid_amount
   FROM documents d
     JOIN orders o ON o.id = d.order_id
     LEFT JOIN organizations seller_org ON seller_org.id = o.seller_org_id
     LEFT JOIN organizations buyer_org ON buyer_org.id = o.buyer_org_id
  WHERE d.doc_type = 'RECEIPT'::document_type AND o.order_type = 'D2H'::order_type
    AND NOT (EXISTS ( SELECT 1 FROM fin_document_closures c WHERE c.document_id = d.id))
    AND NOT (EXISTS ( SELECT 1
           FROM gl_document_postings dp
          WHERE dp.document_id = d.id AND dp.company_id = d.company_id AND dp.posting_status = 'POSTED'::text));

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

-- Verification (read only)
SELECT a.code AS customer_deposit_account FROM public.gl_settings s LEFT JOIN public.gl_accounts a ON a.id = s.customer_deposit_account_id;
SELECT gl_doc_type, count(*) AS docs, sum(amount) AS amount FROM public.v_pending_gl_postings GROUP BY gl_doc_type ORDER BY gl_doc_type;
