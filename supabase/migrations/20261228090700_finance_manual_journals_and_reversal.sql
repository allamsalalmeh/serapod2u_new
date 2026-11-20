-- Manual journal entries and journal reversal
--
--   * Manual journals (type ADJUSTMENT, is_manual): saved as a balanced DRAFT with a
--     temporary number, numbered JV-AJ-YY-nnnnnn when posted. Drafts can be edited
--     or deleted; posted journals cannot be changed, only reversed.
--   * fin_reverse_journal reverses any posted journal (manual or from a document)
--     with a required reason and date, and undoes its finance effects:
--       - supplier payment: the payment no longer counts as paid and its document
--         (and documents auto-closed because the order was fully paid) reopen;
--       - document posting (e.g. supplier invoice): the document returns to
--         Pending Postings so it can be posted again.
--     Order of reversal is enforced so balances stay correct:
--       payments after the invoice -> supplier invoice -> advance payments.
--     Payroll and expense journals are reversed from the HR module.
--   * reverse_gl_journal (used by payroll) is not changed.
--
-- Permissions: create/edit/post/delete manual journals = finance.journal.post;
--              reverse = finance.payment.approve.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Columns and audit table
-- ---------------------------------------------------------------------------
ALTER TABLE public.gl_journals ADD COLUMN IF NOT EXISTS is_manual boolean NOT NULL DEFAULT false;
ALTER TABLE public.gl_journals ADD COLUMN IF NOT EXISTS reference text;

CREATE TABLE IF NOT EXISTS public.fin_journal_reversals (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
    journal_id          uuid NOT NULL UNIQUE REFERENCES public.gl_journals(id) ON DELETE CASCADE,
    reversal_journal_id uuid NOT NULL REFERENCES public.gl_journals(id) ON DELETE CASCADE,
    document_type       text,
    document_id         uuid,
    reason              text NOT NULL,
    reversal_date       date NOT NULL,
    actor_id            uuid,
    created_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.fin_journal_reversals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fin_journal_reversals FROM public, anon, authenticated;
GRANT SELECT ON TABLE public.fin_journal_reversals TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Internal: validate and write manual journal lines
--    p_lines: [{"account_id": uuid, "description": text, "debit": n, "credit": n}, ...]
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_write_manual_journal_lines(p_journal_id uuid, p_company_id uuid, p_lines jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_line    jsonb;
    v_n       integer := 0;
    v_debit   numeric(18,2);
    v_credit  numeric(18,2);
    v_acct    uuid;
    v_tdebit  numeric(18,2) := 0;
    v_tcredit numeric(18,2) := 0;
BEGIN
    IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) < 2 THEN
        RETURN jsonb_build_object('success', false, 'error', 'A journal needs at least two lines');
    END IF;

    FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
        v_n := v_n + 1;
        BEGIN
            v_acct   := NULLIF(v_line->>'account_id', '')::uuid;
            v_debit  := ROUND(COALESCE(NULLIF(v_line->>'debit', '')::numeric, 0), 2);
            v_credit := ROUND(COALESCE(NULLIF(v_line->>'credit', '')::numeric, 0), 2);
        EXCEPTION WHEN others THEN
            RETURN jsonb_build_object('success', false, 'error', 'Line ' || v_n || ': invalid account or amount');
        END;

        IF v_acct IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'Line ' || v_n || ': choose an account');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.gl_accounts a
                       WHERE a.id = v_acct AND a.company_id = p_company_id AND a.is_active) THEN
            RETURN jsonb_build_object('success', false, 'error', 'Line ' || v_n || ': account not found or inactive');
        END IF;
        IF v_debit < 0 OR v_credit < 0 THEN
            RETURN jsonb_build_object('success', false, 'error', 'Line ' || v_n || ': amounts cannot be negative');
        END IF;
        IF (v_debit > 0) = (v_credit > 0) THEN
            RETURN jsonb_build_object('success', false, 'error', 'Line ' || v_n || ': enter either a debit or a credit amount');
        END IF;

        v_tdebit  := v_tdebit + v_debit;
        v_tcredit := v_tcredit + v_credit;
    END LOOP;

    IF v_tdebit <> v_tcredit THEN
        RETURN jsonb_build_object('success', false, 'error',
            'The journal is not balanced: debit RM ' || to_char(v_tdebit, 'FM999,999,999,990.00')
            || ', credit RM ' || to_char(v_tcredit, 'FM999,999,999,990.00'));
    END IF;

    DELETE FROM public.gl_journal_lines WHERE journal_id = p_journal_id;

    INSERT INTO public.gl_journal_lines (journal_id, account_id, line_number, description,
        debit_amount, credit_amount, entity_type, entity_id, created_by)
    SELECT p_journal_id,
           (l.value->>'account_id')::uuid,
           l.ordinality::integer,
           NULLIF(btrim(COALESCE(l.value->>'description', '')), ''),
           ROUND(COALESCE(NULLIF(l.value->>'debit', '')::numeric, 0), 2),
           ROUND(COALESCE(NULLIF(l.value->>'credit', '')::numeric, 0), 2),
           NULL, NULL, auth.uid()
    FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS l(value, ordinality);

    UPDATE public.gl_journals
    SET total_debit = v_tdebit, total_credit = v_tcredit, updated_at = now()
    WHERE id = p_journal_id;

    RETURN jsonb_build_object('success', true, 'total', v_tdebit);
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_write_manual_journal_lines(uuid,uuid,jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_write_manual_journal_lines(uuid,uuid,jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Save (create or update) a manual journal draft
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_save_manual_journal(
    p_journal_id   uuid,
    p_journal_date date,
    p_description  text,
    p_reference    text,
    p_lines        jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id uuid := public.get_user_company_id();
    v_today      date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
    v_id         uuid;
    v_journal    record;
    v_result     jsonb;
BEGIN
  /* sa-guard:finance.journal.post */
  PERFORM public.sa_require_operation('finance.journal.post', jsonb_build_object('organization_id', v_company_id), 'MANUAL_JOURNAL', COALESCE(p_journal_id::text, 'new'));
    IF public.sa_legacy_guard_unless_new('finance.journal.post') AND NOT public.is_hq_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only HQ Admins can create manual journals');
    END IF;

    IF v_company_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Company not found');
    END IF;
    IF p_journal_date IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Enter the journal date');
    END IF;
    IF p_journal_date > v_today THEN
        RETURN jsonb_build_object('success', false, 'error', 'The journal date cannot be in the future');
    END IF;
    IF NULLIF(btrim(COALESCE(p_description, '')), '') IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Enter a description');
    END IF;

    IF p_journal_id IS NULL THEN
        v_id := gen_random_uuid();
        INSERT INTO public.gl_journals (
            id, company_id, journal_number, journal_date, posting_date, description, reference,
            journal_type, status, is_manual, total_debit, total_credit, created_by
        ) VALUES (
            v_id, v_company_id, 'DRAFT-' || upper(left(replace(v_id::text, '-', ''), 10)),
            p_journal_date, p_journal_date, btrim(p_description), NULLIF(btrim(COALESCE(p_reference, '')), ''),
            'ADJUSTMENT', 'DRAFT', true, 0, 0, auth.uid()
        );
    ELSE
        SELECT * INTO v_journal FROM public.gl_journals
        WHERE id = p_journal_id AND company_id = v_company_id FOR UPDATE;
        IF v_journal.id IS NULL OR NOT v_journal.is_manual THEN
            RETURN jsonb_build_object('success', false, 'error', 'Manual journal not found');
        END IF;
        IF v_journal.status <> 'DRAFT' THEN
            RETURN jsonb_build_object('success', false, 'error', 'Only draft journals can be edited. Reverse a posted journal instead.');
        END IF;
        v_id := p_journal_id;
        UPDATE public.gl_journals
        SET journal_date = p_journal_date, posting_date = p_journal_date,
            description = btrim(p_description), reference = NULLIF(btrim(COALESCE(p_reference, '')), '')
        WHERE id = v_id;
    END IF;

    v_result := public.fin_write_manual_journal_lines(v_id, v_company_id, p_lines);
    IF NOT COALESCE((v_result->>'success')::boolean, false) THEN
        RAISE EXCEPTION USING errcode = 'P0001', message = v_result->>'error';
    END IF;

    RETURN jsonb_build_object('success', true, 'journal_id', v_id, 'status', 'DRAFT', 'total', v_result->'total');
EXCEPTION WHEN raise_exception THEN
    -- Validation failure: nothing is saved (the insert/update above is rolled back).
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_save_manual_journal(uuid,date,text,text,jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fin_save_manual_journal(uuid,date,text,text,jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Post a manual journal draft
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_post_manual_journal(p_journal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id uuid := public.get_user_company_id();
    v_today      date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
    v_journal    record;
    v_lines      integer;
    v_bad        integer;
    v_number     text;
BEGIN
  /* sa-guard:finance.journal.post */
  PERFORM public.sa_require_operation('finance.journal.post', jsonb_build_object('organization_id', v_company_id), 'MANUAL_JOURNAL', p_journal_id::text);
    IF public.sa_legacy_guard_unless_new('finance.journal.post') AND NOT public.is_hq_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only HQ Admins can post manual journals');
    END IF;

    SELECT * INTO v_journal FROM public.gl_journals
    WHERE id = p_journal_id AND company_id = v_company_id FOR UPDATE;
    IF v_journal.id IS NULL OR NOT v_journal.is_manual THEN
        RETURN jsonb_build_object('success', false, 'error', 'Manual journal not found');
    END IF;
    IF v_journal.status <> 'DRAFT' THEN
        RETURN jsonb_build_object('success', false, 'error', 'This journal is already posted');
    END IF;
    IF v_journal.journal_date > v_today THEN
        RETURN jsonb_build_object('success', false, 'error', 'The journal date cannot be in the future');
    END IF;

    SELECT count(*) INTO v_lines FROM public.gl_journal_lines WHERE journal_id = p_journal_id;
    IF v_lines < 2 OR v_journal.total_debit <= 0 OR v_journal.total_debit <> v_journal.total_credit THEN
        RETURN jsonb_build_object('success', false, 'error', 'The journal must have at least two lines and be balanced');
    END IF;

    SELECT count(*) INTO v_bad
    FROM public.gl_journal_lines l
    LEFT JOIN public.gl_accounts a ON a.id = l.account_id AND a.company_id = v_company_id AND a.is_active
    WHERE l.journal_id = p_journal_id AND a.id IS NULL;
    IF v_bad > 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'The journal uses an inactive account. Edit the draft first.');
    END IF;

    IF EXISTS (SELECT 1 FROM public.fiscal_periods fp WHERE fp.company_id = v_company_id)
       AND NOT public.is_posting_date_allowed(v_journal.journal_date, v_company_id) THEN
        RETURN jsonb_build_object('success', false, 'error',
            'Journal date ' || to_char(v_journal.journal_date, 'DD/MM/YYYY') || ' is not in an open accounting period');
    END IF;

    v_number := public.generate_journal_number(v_company_id, 'ADJUSTMENT');

    UPDATE public.gl_journals
    SET journal_number = v_number, status = 'POSTED', posting_date = journal_date,
        posted_by = auth.uid(), posted_at = now()
    WHERE id = p_journal_id;

    RETURN jsonb_build_object('success', true, 'journal_id', p_journal_id, 'journal_number', v_number,
                              'total', v_journal.total_debit);
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_post_manual_journal(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fin_post_manual_journal(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Delete a manual journal draft
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_delete_manual_journal(p_journal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id uuid := public.get_user_company_id();
    v_journal    record;
BEGIN
  /* sa-guard:finance.journal.post */
  PERFORM public.sa_require_operation('finance.journal.post', jsonb_build_object('organization_id', v_company_id), 'MANUAL_JOURNAL', p_journal_id::text);
    IF public.sa_legacy_guard_unless_new('finance.journal.post') AND NOT public.is_hq_admin() THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only HQ Admins can delete manual journals');
    END IF;

    SELECT * INTO v_journal FROM public.gl_journals
    WHERE id = p_journal_id AND company_id = v_company_id FOR UPDATE;
    IF v_journal.id IS NULL OR NOT v_journal.is_manual THEN
        RETURN jsonb_build_object('success', false, 'error', 'Manual journal not found');
    END IF;
    IF v_journal.status <> 'DRAFT' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Posted journals cannot be deleted. Reverse it instead.');
    END IF;

    DELETE FROM public.gl_journals WHERE id = p_journal_id;
    RETURN jsonb_build_object('success', true, 'journal_id', p_journal_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_delete_manual_journal(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fin_delete_manual_journal(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Reverse a posted journal
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

        -- An advance already applied by a posted supplier invoice: reverse the invoice first.
        IF v_payment.stage = 'ADVANCE' AND EXISTS (
            SELECT 1 FROM public.gl_document_postings dp
            JOIN public.documents r ON r.id = dp.document_id
            WHERE r.order_id = v_order_id
              AND dp.document_type = 'SUPPLIER_INVOICE_RECOGNITION'
              AND dp.posting_status = 'POSTED')
        THEN
            RETURN jsonb_build_object('success', false, 'error',
                'The supplier invoice for this order has already applied this advance. Reverse the supplier invoice journal first.');
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
          AND dp.document_type IN ('SUPPLIER_DEPOSIT_PAYMENT', 'SUPPLIER_BALANCE_PAYMENT')
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
REVOKE ALL ON FUNCTION public.fin_reverse_journal(uuid,text,date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fin_reverse_journal(uuid,text,date) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Development reset also clears reversal records
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_reset_journal_reversals()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
BEGIN
  /* sa-guard:finance.data.reset */
  PERFORM public.sa_require_operation('finance.data.reset', jsonb_build_object('organization_id', public.get_user_company_id()), 'FINANCE_RESET', NULL);
    IF public.sa_legacy_guard_unless_new('finance.data.reset') AND NOT public.is_hq_admin() THEN
        RETURN;
    END IF;
    DELETE FROM public.fin_journal_reversals WHERE company_id = public.get_user_company_id();
    -- Break the self-references so journals can be deleted in any order.
    UPDATE public.gl_journals SET reversal_journal_id = NULL, reversed_journal_id = NULL
    WHERE company_id = public.get_user_company_id()
      AND (reversal_journal_id IS NOT NULL OR reversed_journal_id IS NOT NULL);
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_reset_journal_reversals() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fin_reset_journal_reversals() TO authenticated, service_role;

COMMIT;
