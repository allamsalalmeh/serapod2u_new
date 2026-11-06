-- Actual supplier payments (H2M)
--
-- Finance now posts the amount actually paid, not total x deposit/balance percentage.
--   * fin_payments: one row per real payment (amount, date, bank account, reference, journal).
--   * fin_post_supplier_payment: posts one payment. A payment document can be paid in
--     several parts; it leaves Pending Postings once Finance marks a payment as the last one.
--   * Before the supplier invoice is posted a payment is an advance (Dr 1400 Supplier
--     Deposits); after it, the payment settles payables (Dr 2100 Accounts Payable).
--   * Total payments on an order can never exceed the order total.
--   * The supplier invoice needs the balance request to be acknowledged, and credits 1400
--     with the advances actually paid (zero or more) and 2100 with the rest.
--   * Payments posted before this change (gl_document_postings without fin_payments rows)
--     are counted at their posted amount.
-- Payment terms (deposit_pct / balance_pct) remain only the requested amount and the default.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Payments table (server-only; written through the SECURITY DEFINER RPC)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fin_payments (
    id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id                    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    direction                     text NOT NULL CHECK (direction IN ('OUT', 'IN')),
    document_id                   uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
    document_type                 text NOT NULL CHECK (document_type IN ('SUPPLIER_DEPOSIT_PAYMENT', 'SUPPLIER_BALANCE_PAYMENT', 'RECEIPT')),
    order_id                      uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
    party_org_id                  uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
    stage                         text NOT NULL CHECK (stage IN ('ADVANCE', 'SETTLEMENT')),
    amount                        numeric(18,2) NOT NULL CHECK (amount > 0),
    payment_date                  date NOT NULL,
    bank_account_id               uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE RESTRICT,
    reference                     text,
    bank_statement_transaction_id uuid REFERENCES public.bank_statement_transactions(id) ON DELETE RESTRICT,
    journal_id                    uuid NOT NULL REFERENCES public.gl_journals(id) ON DELETE RESTRICT,
    closes_document               boolean NOT NULL DEFAULT false,
    status                        text NOT NULL DEFAULT 'POSTED' CHECK (status IN ('POSTED', 'REVERSED')),
    created_by                    uuid,
    created_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fin_payments_order_idx    ON public.fin_payments (company_id, order_id);
CREATE INDEX IF NOT EXISTS fin_payments_document_idx ON public.fin_payments (document_id);

ALTER TABLE public.fin_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fin_payments FROM public, anon, authenticated;
GRANT SELECT ON TABLE public.fin_payments TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Payment context: requested, paid and remaining amounts for a supplier
--    payment document, and whether its order's invoice is already posted.
-- ---------------------------------------------------------------------------
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

    RETURN v_details || jsonb_build_object(
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
REVOKE ALL ON FUNCTION public.fin_supplier_payment_context(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_supplier_payment_context(uuid) TO service_role;

-- Advances actually paid on an order (Dr 1400), new and legacy.
CREATE OR REPLACE FUNCTION public.fin_order_supplier_advances(p_order_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT COALESCE((
        SELECT SUM(fp.amount) FROM public.fin_payments fp
        WHERE fp.order_id = p_order_id AND fp.direction = 'OUT'
          AND fp.stage = 'ADVANCE' AND fp.status = 'POSTED'
    ), 0) + COALESCE((
        SELECT SUM(dp.posted_amount)
        FROM public.gl_document_postings dp
        JOIN public.documents d ON d.id = dp.document_id
        WHERE d.order_id = p_order_id
          AND dp.document_type = 'SUPPLIER_DEPOSIT_PAYMENT'
          AND dp.posting_status = 'POSTED'
          AND NOT EXISTS (SELECT 1 FROM public.fin_payments fp WHERE fp.document_id = dp.document_id)
    ), 0);
$function$;
REVOKE ALL ON FUNCTION public.fin_order_supplier_advances(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_order_supplier_advances(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Post one actual supplier payment
-- ---------------------------------------------------------------------------
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

    IF public.is_document_posted(v_gl_doc_type, p_document_id) THEN
        RETURN jsonb_build_object('success', false, 'error', 'This payment document is already fully posted');
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

    -- The last payment closes the document: it leaves Pending Postings.
    IF COALESCE(p_closes_document, true) THEN
        INSERT INTO public.gl_document_postings (
            company_id, document_type, document_id, document_number,
            journal_id, posted_amount, posting_status, created_by
        ) VALUES (
            v_company_id, v_gl_doc_type, p_document_id, v_doc_number,
            v_journal_id, v_doc_paid, 'POSTED', auth.uid()
        );
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
        'document_closed', COALESCE(p_closes_document, true),
        'posting_date', p_payment_date
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_post_supplier_payment(uuid,numeric,date,uuid,text,boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fin_post_supplier_payment(uuid,numeric,date,uuid,text,boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Supplier invoice: acknowledged request; apply the advances actually paid
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
    v_deposit_amount numeric(18,2);
    v_balance_amount numeric(18,2);
    v_supplier_org_id uuid;
    v_supplier_name text;
    v_description text;
BEGIN
    v_company_id := public.get_user_company_id();

    SELECT * INTO v_request
    FROM public.documents d
    WHERE d.id = p_request_id
    AND d.doc_type = 'PAYMENT_REQUEST'
    AND d.company_id = v_company_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'PAYMENT_REQUEST document not found or not in your company');
    END IF;

    /* finance-require-acknowledged-request */
    IF v_request.status::text NOT IN ('acknowledged', 'completed') THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'Balance request ' || COALESCE(v_request.display_doc_no, v_request.doc_no)
                     || ' has not been acknowledged yet. It can be posted after HQ acknowledges it.'
        );
    END IF;

    SELECT * INTO v_order FROM public.orders o WHERE o.id = v_request.order_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Order not found for this payment request');
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

-- ---------------------------------------------------------------------------
-- 5. Preview: payments show the remaining requested amount and the account
--    for their stage; the invoice leaves out zero lines.
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

        -- Supplier invoice: Dr Purchases 100%, Cr Supplier Deposits (advances actually
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

            IF v_cogs_account.id IS NULL THEN
                RETURN jsonb_build_object('success', false, 'error', 'COGS/Purchases account not configured. Please set it in Default Accounts.');
            END IF;
            IF v_deposit_amount > 0 AND v_deposit_account.id IS NULL THEN
                RETURN jsonb_build_object('success', false, 'error', 'Supplier Deposits account not configured');
            END IF;
            IF v_balance_amount > 0 AND v_ap_account.id IS NULL THEN
                RETURN jsonb_build_object('success', false, 'error', 'Accounts Payable account not configured');
            END IF;

            v_total := v_order_total;

            v_lines := jsonb_build_array(
                jsonb_build_object('account_id', v_cogs_account.id, 'account_name', v_cogs_account.name,
                    'account_code', v_cogs_account.code, 'debit', v_order_total, 'credit', 0,
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

-- ---------------------------------------------------------------------------
-- 6. post_document_to_gl: supplier payments go through fin_post_supplier_payment
--    (batch posting = the remaining requested amount, default bank, closes the document).
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
        v_total_debit, 'POSTED', auth.uid()
    );

    RETURN jsonb_build_object(
        'success', true,
        'journal_id', v_journal_id,
        'journal_number', v_journal_number,
        'document_type', p_document_type,
        'document_id', p_document_id,
        'document_number', v_doc_number,
        'posted_amount', v_total_debit,
        'posting_date', p_posting_date,
        'lines_created', v_line_number
    );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Pending Postings view
--    * supplier payments: amount = what remains requested on the document;
--      a partly paid document stays until a payment closes it;
--    * supplier invoice: only the acknowledged request (deposit no longer required);
--    * new column paid_amount (added at the end).
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
    buyer_org.org_name AS buyer_name,
    0::numeric AS paid_amount
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
    buyer_org.org_name AS buyer_name,
    0::numeric AS paid_amount
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
    buyer_org.org_name AS buyer_name,
    0::numeric AS paid_amount
   FROM documents d
     JOIN orders o ON o.id = d.order_id
     LEFT JOIN organizations seller_org ON seller_org.id = o.seller_org_id
     LEFT JOIN organizations buyer_org ON buyer_org.id = o.buyer_org_id
  WHERE d.doc_type = 'RECEIPT'::document_type AND o.order_type = 'D2H'::order_type AND NOT (EXISTS ( SELECT 1
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

-- ---------------------------------------------------------------------------
-- Verification (read only)
-- ---------------------------------------------------------------------------
SELECT gl_doc_type, count(*) AS docs, sum(amount) AS amount
FROM public.v_pending_gl_postings
GROUP BY gl_doc_type ORDER BY gl_doc_type;

SELECT count(*) AS fin_payments_rows FROM public.fin_payments;
