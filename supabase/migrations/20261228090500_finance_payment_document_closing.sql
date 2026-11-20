-- Closing and reopening supplier payment documents
--
--   * A payment document closes automatically when its requested amount is fully
--     paid or when the whole order is paid (then the order's other open payment
--     documents close too), or when Finance marks a payment as the last one.
--   * "Mark as complete" closes a document with no further payment (a reason is required).
--   * "Reopen" re-opens a document closed by mistake (finance.payment.approve, reason required).
--   * Every close and reopen is kept in fin_document_closure_events.
--   * fin_payments rows go with their journal (ON DELETE CASCADE), and
--     fin_reset_payment_state clears payment state for the development reset.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
ALTER TABLE public.fin_payments DROP CONSTRAINT IF EXISTS fin_payments_journal_id_fkey;
ALTER TABLE public.fin_payments
    ADD CONSTRAINT fin_payments_journal_id_fkey FOREIGN KEY (journal_id)
    REFERENCES public.gl_journals(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS public.fin_document_closures (
    document_id uuid PRIMARY KEY REFERENCES public.documents(id) ON DELETE CASCADE,
    company_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    kind        text NOT NULL CHECK (kind IN ('LAST_PAYMENT', 'AUTO', 'MANUAL')),
    reason      text,
    closed_by   uuid,
    closed_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.fin_document_closure_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
    company_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    action      text NOT NULL CHECK (action IN ('CLOSED', 'REOPENED')),
    kind        text,
    reason      text,
    actor_id    uuid,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fin_document_closure_events_doc_idx ON public.fin_document_closure_events (document_id, created_at);

ALTER TABLE public.fin_document_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_document_closure_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fin_document_closures FROM public, anon, authenticated;
REVOKE ALL ON TABLE public.fin_document_closure_events FROM public, anon, authenticated;
GRANT SELECT ON TABLE public.fin_document_closures TO service_role;
GRANT SELECT ON TABLE public.fin_document_closure_events TO service_role;

-- Documents closed by the previous version (fin_payments + gl_document_postings).
INSERT INTO public.fin_document_closures (document_id, company_id, kind, reason, closed_by, closed_at)
SELECT dp.document_id, dp.company_id, 'LAST_PAYMENT', 'Closed before closing rules', dp.created_by, dp.created_at
FROM public.gl_document_postings dp
WHERE dp.document_type IN ('SUPPLIER_DEPOSIT_PAYMENT', 'SUPPLIER_BALANCE_PAYMENT')
  AND dp.posting_status = 'POSTED'
  AND EXISTS (SELECT 1 FROM public.fin_payments fp WHERE fp.document_id = dp.document_id)
ON CONFLICT (document_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Closed = closed here, or posted the old way (one posting per document)
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
                     AND dp.document_type IN ('SUPPLIER_DEPOSIT_PAYMENT', 'SUPPLIER_BALANCE_PAYMENT')
                     AND dp.posting_status = 'POSTED');
$function$;
REVOKE ALL ON FUNCTION public.fin_payment_document_closed(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_payment_document_closed(uuid) TO service_role;

-- Internal: close one document (no permission check; callers check).
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
    SELECT d.id, d.company_id, COALESCE(d.display_doc_no, d.doc_no) AS doc_number,
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

    -- Keep the one-posting-per-document record the AP pages read, when there were payments.
    v_type := CASE WHEN v_doc.is_balance THEN 'SUPPLIER_BALANCE_PAYMENT' ELSE 'SUPPLIER_DEPOSIT_PAYMENT' END;
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
-- 3. Payment context: adds 'closed'
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

-- ---------------------------------------------------------------------------
-- 4. Post a payment: closes automatically when the document or the order is fully paid
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

-- ---------------------------------------------------------------------------
-- 5. Mark as complete: close with no further payment
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
  PERFORM public.sa_require_operation('finance.journal.post', jsonb_build_object('organization_id', public.get_user_company_id()), 'SUPPLIER_PAYMENT_CLOSE', p_document_id::text);
    IF public.sa_legacy_guard_unless_new('finance.journal.post') AND NOT public.is_hq_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only HQ Admins can close payment documents');
    END IF;

    IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Enter the reason for closing this document');
    END IF;

    PERFORM 1 FROM public.documents WHERE id = p_document_id AND company_id = public.get_user_company_id() FOR UPDATE;

    v_ctx := public.fin_supplier_payment_context(p_document_id);
    IF NOT COALESCE((v_ctx->>'success')::boolean, false) THEN
        RETURN v_ctx;
    END IF;
    IF COALESCE((v_ctx->>'closed')::boolean, false) THEN
        RETURN jsonb_build_object('success', false, 'error', 'This payment document is already closed');
    END IF;

    PERFORM public.fin_close_payment_document_internal(p_document_id, 'MANUAL', btrim(p_reason));

    RETURN jsonb_build_object('success', true, 'document_id', p_document_id, 'closed', true,
        'paid_on_document', (v_ctx->>'paid_on_document')::numeric);
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_close_payment_document(uuid,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fin_close_payment_document(uuid,text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Reopen a document closed by mistake
-- ---------------------------------------------------------------------------
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
  PERFORM public.sa_require_operation('finance.payment.approve', jsonb_build_object('organization_id', public.get_user_company_id()), 'SUPPLIER_PAYMENT_REOPEN', p_document_id::text);
    IF public.sa_legacy_guard_unless_new('finance.payment.approve') AND NOT public.is_hq_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only HQ Admins can reopen payment documents');
    END IF;

    IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Enter the reason for reopening this document');
    END IF;

    v_company_id := public.get_user_company_id();
    PERFORM 1 FROM public.documents WHERE id = p_document_id AND company_id = v_company_id FOR UPDATE;

    v_ctx := public.fin_supplier_payment_context(p_document_id);
    IF NOT COALESCE((v_ctx->>'success')::boolean, false) THEN
        RETURN v_ctx;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.fin_document_closures WHERE document_id = p_document_id) THEN
        RETURN jsonb_build_object('success', false, 'error',
            CASE WHEN COALESCE((v_ctx->>'closed')::boolean, false)
                 THEN 'This document was posted before actual payments were introduced and cannot be reopened'
                 ELSE 'This payment document is not closed' END);
    END IF;

    IF (v_ctx->>'order_unpaid')::numeric <= 0 THEN
        RETURN jsonb_build_object('success', false, 'error',
            'The order is fully paid, so no further payment can be posted on this document');
    END IF;

    DELETE FROM public.fin_document_closures WHERE document_id = p_document_id;
    DELETE FROM public.gl_document_postings
    WHERE document_id = p_document_id
      AND company_id = v_company_id
      AND document_type IN ('SUPPLIER_DEPOSIT_PAYMENT', 'SUPPLIER_BALANCE_PAYMENT');

    INSERT INTO public.fin_document_closure_events (document_id, company_id, action, kind, reason, actor_id)
    VALUES (p_document_id, v_company_id, 'REOPENED', NULL, btrim(p_reason), auth.uid());

    RETURN jsonb_build_object('success', true, 'document_id', p_document_id, 'closed', false);
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_reopen_payment_document(uuid,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fin_reopen_payment_document(uuid,text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Development reset: clear payment state for the caller's company
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_reset_payment_state()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id uuid;
    v_payments integer;
    v_closures integer;
BEGIN
  /* sa-guard:finance.data.reset */
  PERFORM public.sa_require_operation('finance.data.reset', jsonb_build_object('organization_id', public.get_user_company_id()), 'FINANCE_RESET', NULL);
    IF public.sa_legacy_guard_unless_new('finance.data.reset') AND NOT public.is_hq_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only HQ Admins can reset finance data');
    END IF;

    v_company_id := public.get_user_company_id();
    DELETE FROM public.fin_payments WHERE company_id = v_company_id;
    GET DIAGNOSTICS v_payments = ROW_COUNT;
    DELETE FROM public.fin_document_closures WHERE company_id = v_company_id;
    GET DIAGNOSTICS v_closures = ROW_COUNT;
    DELETE FROM public.fin_document_closure_events WHERE company_id = v_company_id;

    RETURN jsonb_build_object('success', true, 'payments', v_payments, 'closures', v_closures);
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_reset_payment_state() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fin_reset_payment_state() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Pending Postings: closed payment documents leave the list
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
  WHERE d.doc_type = 'PAYMENT'::document_type AND d.doc_no !~~ '%-BAL%'::text AND NOT d.payload ? 'source_request_id'::text
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
  WHERE d.doc_type = 'PAYMENT'::document_type AND (d.doc_no ~~ '%-BAL%'::text OR d.payload ? 'source_request_id'::text)
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

-- Verification (read only)
SELECT kind, count(*) FROM public.fin_document_closures GROUP BY kind;
SELECT gl_doc_type, count(*) AS docs, sum(amount) AS amount
FROM public.v_pending_gl_postings GROUP BY gl_doc_type ORDER BY gl_doc_type;
