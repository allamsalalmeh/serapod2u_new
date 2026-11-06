-- Purchases to Inventory, and an admin setting for posting supplier payments
--
--   * The supplier invoice now debits the Inventory account (gl_settings.inventory_account_id,
--     1300) instead of COGS. Cost of goods sold is recognised when goods are sold.
--     If no inventory account is set, the company's 1300 account is used when it exists.
--   * gl_settings.require_supplier_ack_for_payment_posting (default false = current
--     behaviour): when true, a supplier payment can be posted only after the supplier
--     has acknowledged the payment document.

BEGIN;

ALTER TABLE public.gl_settings
    ADD COLUMN IF NOT EXISTS require_supplier_ack_for_payment_posting boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.gl_settings.require_supplier_ack_for_payment_posting IS
    'When true, supplier payments are posted to the GL only after the supplier acknowledges the payment document.';

UPDATE public.gl_settings s
SET inventory_account_id = a.id, updated_at = now()
FROM public.gl_accounts a
WHERE s.inventory_account_id IS NULL
  AND a.company_id = s.company_id
  AND a.code = '1300'
  AND a.is_active;

CREATE OR REPLACE FUNCTION public.fin_supplier_payment_context(p_document_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_details        jsonb;
    v_order_id       uuid;
    v_requested      numeric(18,2);
    v_order_total    numeric(18,2);
    v_doc_paid       numeric(18,2);
    v_order_paid     numeric(18,2);
    v_invoice_posted boolean;
    v_doc_status     text;
    v_ack_required   boolean;
BEGIN
    -- Validates the document (PAYMENT, caller's company) and gives the requested amount.
    v_details := public.get_payment_posting_details(p_document_id);
    IF NOT COALESCE((v_details->>'success')::boolean, false) THEN
        RETURN v_details;
    END IF;

    v_order_id    := (v_details->>'order_id')::uuid;
    v_requested   := (v_details->>'payment_amount')::numeric;
    v_order_total := (v_details->>'order_total')::numeric;

    -- Paid on this document: new payments, or the legacy single posting.
    SELECT COALESCE(SUM(fp.amount), 0) INTO v_doc_paid
    FROM public.fin_payments fp
    WHERE fp.document_id = p_document_id AND fp.status = 'POSTED';

    IF v_doc_paid = 0 THEN
        SELECT COALESCE(SUM(dp.posted_amount), 0) INTO v_doc_paid
        FROM public.gl_document_postings dp
        WHERE dp.document_id = p_document_id
          AND dp.document_type IN ('SUPPLIER_DEPOSIT_PAYMENT', 'SUPPLIER_BALANCE_PAYMENT')
          AND dp.posting_status = 'POSTED';
    END IF;

    -- Paid on the whole order (outgoing).
    SELECT COALESCE(SUM(fp.amount), 0) INTO v_order_paid
    FROM public.fin_payments fp
    WHERE fp.order_id = v_order_id AND fp.direction = 'OUT' AND fp.status = 'POSTED';

    v_order_paid := v_order_paid + COALESCE((
        SELECT SUM(dp.posted_amount)
        FROM public.gl_document_postings dp
        JOIN public.documents d ON d.id = dp.document_id
        WHERE d.order_id = v_order_id
          AND dp.document_type IN ('SUPPLIER_DEPOSIT_PAYMENT', 'SUPPLIER_BALANCE_PAYMENT')
          AND dp.posting_status = 'POSTED'
          AND NOT EXISTS (SELECT 1 FROM public.fin_payments fp WHERE fp.document_id = dp.document_id)
    ), 0);

    v_invoice_posted := EXISTS (
        SELECT 1
        FROM public.gl_document_postings dp
        JOIN public.documents r ON r.id = dp.document_id
        WHERE r.order_id = v_order_id
          AND dp.document_type = 'SUPPLIER_INVOICE_RECOGNITION'
          AND dp.posting_status = 'POSTED'
    );

    SELECT d.status::text INTO v_doc_status FROM public.documents d WHERE d.id = p_document_id;
    SELECT COALESCE(s.require_supplier_ack_for_payment_posting, false) INTO v_ack_required
    FROM public.gl_settings s WHERE s.company_id = (v_details->>'company_id')::uuid;

    RETURN v_details || jsonb_build_object(
        'document_status',     v_doc_status,
        'supplier_ack_required', COALESCE(v_ack_required, false),
        'blocked_by_ack',      COALESCE(v_ack_required, false) AND v_doc_status NOT IN ('acknowledged', 'completed'),
        'closed',              public.fin_payment_document_closed(p_document_id),
        'requested_amount',    v_requested,
        'paid_on_document',    v_doc_paid,
        'remaining_requested', GREATEST(v_requested - v_doc_paid, 0),
        'order_paid_total',    v_order_paid,
        'order_unpaid',        GREATEST(v_order_total - v_order_paid, 0),
        'invoice_posted',      v_invoice_posted,
        'stage',               CASE WHEN v_invoice_posted THEN 'SETTLEMENT' ELSE 'ADVANCE' END
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fin_post_supplier_payment(
    p_document_id     uuid,
    p_amount          numeric,
    p_payment_date    date,
    p_bank_account_id uuid    DEFAULT NULL,
    p_reference       text    DEFAULT NULL,
    p_closes_document boolean DEFAULT true
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
    v_gl_doc_type  text;
    v_settings     record;
    v_debit_acct   uuid;
    v_bank         record;
    v_doc_number   text;
    v_journal_id   uuid;
    v_journal_no   text;
    v_description  text;
    v_supplier_id  uuid;
    v_today        date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
    v_doc_paid     numeric(18,2);
    v_requested    numeric(18,2);
    v_close        boolean;
    v_close_kind   text;
    v_other        record;
BEGIN
  /* sa-guard:finance.journal.post */
  PERFORM public.sa_require_operation('finance.journal.post', jsonb_build_object('organization_id', public.get_user_company_id()), 'SUPPLIER_PAYMENT', p_document_id::text);
    IF public.sa_legacy_guard_unless_new('finance.journal.post') AND NOT public.is_hq_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only HQ Admins can post to GL');
    END IF;

    v_company_id := public.get_user_company_id();

    -- One payment at a time per document and per order.
    PERFORM 1 FROM public.documents WHERE id = p_document_id AND company_id = v_company_id FOR UPDATE;
    PERFORM 1 FROM public.orders o
      WHERE o.id = (SELECT order_id FROM public.documents WHERE id = p_document_id) FOR UPDATE;

    v_ctx := public.fin_supplier_payment_context(p_document_id);
    IF NOT COALESCE((v_ctx->>'success')::boolean, false) THEN
        RETURN v_ctx;
    END IF;

    v_gl_doc_type := v_ctx->>'gl_doc_type';
    v_order_id    := (v_ctx->>'order_id')::uuid;
    v_order_total := (v_ctx->>'order_total')::numeric;
    v_order_paid  := (v_ctx->>'order_paid_total')::numeric;
    v_stage       := v_ctx->>'stage';
    v_supplier_id := (v_ctx->>'supplier_org_id')::uuid;

    IF COALESCE((v_ctx->>'closed')::boolean, false) THEN
        RETURN jsonb_build_object('success', false, 'error',
            'This payment document is closed. Reopen it to post another payment on it.');
    END IF;

    /* finance-supplier-ack-setting */
    IF COALESCE((v_ctx->>'blocked_by_ack')::boolean, false) THEN
        RETURN jsonb_build_object('success', false, 'error', 'The supplier has not acknowledged this payment yet. Finance settings require the supplier''s acknowledgment before a payment can be posted.');
    END IF;

    v_amount := ROUND(COALESCE(p_amount, 0), 2);
    IF v_amount <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Enter the amount actually paid (more than zero)');
    END IF;

    IF p_payment_date IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Enter the payment date');
    END IF;
    IF p_payment_date > v_today THEN
        RETURN jsonb_build_object('success', false, 'error', 'The payment date cannot be in the future');
    END IF;

    -- Never pay more than the order total.
    IF v_order_paid + v_amount > v_order_total THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Total payments for this order would be RM ' || to_char(v_order_paid + v_amount, 'FM999,999,999,990.00')
                     || ', more than the order total of RM ' || to_char(v_order_total, 'FM999,999,999,990.00')
                     || '. At most RM ' || to_char(GREATEST(v_order_total - v_order_paid, 0), 'FM999,999,999,990.00') || ' can be paid.'
        );
    END IF;

    -- Bank account: the one chosen, else the default active account.
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
    v_debit_acct := CASE WHEN v_stage = 'ADVANCE' THEN v_settings.supplier_deposit_account_id
                         ELSE v_settings.ap_control_account_id END;
    IF v_debit_acct IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error',
            CASE WHEN v_stage = 'ADVANCE' THEN 'Supplier Deposits account not configured'
                 ELSE 'Accounts Payable account not configured' END);
    END IF;

    SELECT COALESCE(display_doc_no, doc_no) INTO v_doc_number FROM public.documents WHERE id = p_document_id;

    v_description := CASE WHEN v_stage = 'ADVANCE' THEN 'Supplier Advance Payment: ' ELSE 'Supplier Payment: ' END
                     || v_doc_number
                     || COALESCE(' Ref ' || NULLIF(btrim(p_reference), ''), '');

    v_journal_no := public.generate_journal_number(v_company_id,
                       CASE WHEN v_stage = 'ADVANCE' THEN 'SUPPLIER_DEPOSIT' ELSE 'SUPPLIER_PAYMENT' END);

    INSERT INTO public.gl_journals (
        company_id, journal_number, journal_date, posting_date, description, journal_type,
        status, total_debit, total_credit, created_by, posted_by, posted_at
    ) VALUES (
        v_company_id, v_journal_no, p_payment_date, p_payment_date, v_description,
        CASE WHEN v_stage = 'ADVANCE' THEN 'SUPPLIER_DEPOSIT' ELSE 'SUPPLIER_PAYMENT' END,
        'POSTED', v_amount, v_amount, auth.uid(), auth.uid(), now()
    ) RETURNING id INTO v_journal_id;

    INSERT INTO public.gl_journal_lines (journal_id, account_id, line_number, description,
        debit_amount, credit_amount, entity_type, entity_id, created_by)
    VALUES
        (v_journal_id, v_debit_acct, 1, v_description, v_amount, 0, 'SUPPLIER', v_supplier_id, auth.uid()),
        (v_journal_id, v_bank.gl_account_id, 2, v_description, 0, v_amount, NULL, NULL, auth.uid());

    INSERT INTO public.fin_payments (
        company_id, direction, document_id, document_type, order_id, party_org_id, stage,
        amount, payment_date, bank_account_id, reference, journal_id, closes_document, created_by
    ) VALUES (
        v_company_id, 'OUT', p_document_id, v_gl_doc_type, v_order_id, v_supplier_id, v_stage,
        v_amount, p_payment_date, v_bank.id, NULLIF(btrim(p_reference), ''), v_journal_id,
        COALESCE(p_closes_document, true), auth.uid()
    );

    SELECT COALESCE(SUM(amount), 0) INTO v_doc_paid
    FROM public.fin_payments WHERE document_id = p_document_id AND status = 'POSTED';
    v_requested := (v_ctx->>'requested_amount')::numeric;

    /* finance-auto-close */
    -- Closed when Finance marks the last payment, when the document's requested
    -- amount is fully paid, or when the whole order is paid.
    v_close := COALESCE(p_closes_document, true)
               OR v_doc_paid >= v_requested
               OR v_order_paid + v_amount >= v_order_total;
    v_close_kind := CASE WHEN COALESCE(p_closes_document, true) THEN 'LAST_PAYMENT' ELSE 'AUTO' END;

    IF v_close THEN
        PERFORM public.fin_close_payment_document_internal(
            p_document_id, v_close_kind,
            CASE WHEN v_close_kind = 'LAST_PAYMENT' THEN 'Marked as the last payment'
                 WHEN v_doc_paid >= v_requested THEN 'Requested amount fully paid'
                 ELSE 'Order fully paid' END);
    END IF;

    -- Order fully paid: nothing more can be paid on its other open payment documents.
    IF v_order_paid + v_amount >= v_order_total THEN
        FOR v_other IN
            SELECT d.id
            FROM public.documents d
            WHERE d.order_id = v_order_id
              AND d.company_id = v_company_id
              AND d.doc_type = 'PAYMENT'
              AND d.id <> p_document_id
              AND NOT public.fin_payment_document_closed(d.id)
        LOOP
            PERFORM public.fin_close_payment_document_internal(v_other.id, 'AUTO', 'Order fully paid');
        END LOOP;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'journal_id', v_journal_id,
        'journal_number', v_journal_no,
        'document_type', v_gl_doc_type,
        'document_id', p_document_id,
        'document_number', v_doc_number,
        'stage', v_stage,
        'posted_amount', v_amount,
        'paid_on_document', v_doc_paid,
        'document_closed', v_close,
        'posting_date', p_payment_date
    );
END;
$function$;

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

        -- Sales invoice (unchanged)
        WHEN 'SALES_INVOICE' THEN
            SELECT
                COALESCE((SELECT SUM(oi.line_total) FROM public.order_items oi WHERE oi.order_id = o.id), 0),
                'Sales Invoice: ' || o.order_no,
                o.buyer_org_id,
                org.org_name
            INTO v_total, v_description, v_entity_id, v_entity_name
            FROM public.orders o
            LEFT JOIN public.organizations org ON org.id = o.buyer_org_id
            WHERE o.id = p_document_id AND o.company_id = v_company_id;

            IF v_total IS NULL OR v_total = 0 THEN
                RETURN jsonb_build_object('success', false, 'error', 'Invoice not found or has zero total');
            END IF;

            v_lines := jsonb_build_array(
                jsonb_build_object('account_id', v_ar_account.id, 'account_name', v_ar_account.name,
                    'account_code', v_ar_account.code, 'debit', v_total, 'credit', 0,
                    'entity_type', 'CUSTOMER', 'entity_id', v_entity_id, 'entity_name', v_entity_name),
                jsonb_build_object('account_id', v_sales_account.id, 'account_name', v_sales_account.name,
                    'account_code', v_sales_account.code, 'debit', 0, 'credit', v_total,
                    'entity_type', NULL, 'entity_id', NULL, 'entity_name', NULL)
            );

        ELSE
            RETURN jsonb_build_object('success', false, 'error', 'Unknown document type: ' || p_document_type || '. Supported: SUPPLIER_DEPOSIT_PAYMENT, SUPPLIER_INVOICE_RECOGNITION, SUPPLIER_BALANCE_PAYMENT, SALES_INVOICE');
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

COMMIT;

-- Verification (read only)
SELECT a.code AS inventory_account, s.require_supplier_ack_for_payment_posting, s.posting_mode
FROM public.gl_settings s LEFT JOIN public.gl_accounts a ON a.id = s.inventory_account_id;
