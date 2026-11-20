-- Finance: bank reconciliation against approved bank statements
--
-- Matches the lines of approved bank statements (bank_statement_transactions) with
-- the ledger lines on the bank's GL account:
--   * automatic matching (same amount and direction within 3 days; reference first;
--     a journal with its reversal), manual matching of several lines at once;
--   * figures computed, never typed: bank balance from the statement, book balance
--     from the ledger, deposits in transit and outstanding payments;
--   * submit only when every bank line is in the books, the statement reaches the
--     period end and the adjusted balances agree; another user approves;
--   * unmatched lines carry forward to the next period; a matched journal cannot be
--     reversed until it is unmatched (or the reconciliation voided).
--
-- Existing tables are extended (no data removed); bank_reconciliation_lines (manual
-- lines of the old screen) is left in place and no longer used.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Reconciliation header: submit / approve workflow, matching start date
-- ---------------------------------------------------------------------------
ALTER TABLE public.bank_reconciliations
    ADD COLUMN IF NOT EXISTS start_date   date,
    ADD COLUMN IF NOT EXISTS submitted_by uuid,
    ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
    ADD COLUMN IF NOT EXISTS summary      jsonb;

COMMENT ON COLUMN public.bank_reconciliations.start_date IS
    'First day covered by matching for this bank account (set on the first reconciliation, carried forward).';
COMMENT ON COLUMN public.bank_reconciliations.summary IS
    'Reconciliation figures frozen at submission / approval.';

ALTER TABLE public.bank_reconciliations DROP CONSTRAINT IF EXISTS bank_reconciliations_status_check;
ALTER TABLE public.bank_reconciliations ADD CONSTRAINT bank_reconciliations_status_check
    CHECK (status = ANY (ARRAY['draft', 'in_progress', 'submitted', 'completed', 'void']));

-- One open reconciliation per bank account at a time.
CREATE UNIQUE INDEX IF NOT EXISTS bank_reconciliations_one_open
    ON public.bank_reconciliations (bank_account_id)
    WHERE status IN ('draft', 'in_progress', 'submitted');

-- ---------------------------------------------------------------------------
-- 2. Matches: bank statement lines <-> ledger lines on the bank's GL account
-- ---------------------------------------------------------------------------
-- A match group holds one or more statement lines and/or ledger lines whose
-- money in/out nets to the same amount on both sides (a book-only group nets to
-- zero, e.g. a journal and its reversal). Each line is matched at most once.
CREATE TABLE IF NOT EXISTS public.bank_recon_matches (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id               uuid NOT NULL REFERENCES public.organizations(id),
    bank_account_id          uuid NOT NULL REFERENCES public.bank_accounts(id),
    reconciliation_id        uuid NOT NULL REFERENCES public.bank_reconciliations(id) ON DELETE CASCADE,
    match_group              uuid NOT NULL,
    statement_transaction_id uuid REFERENCES public.bank_statement_transactions(id),
    journal_line_id          uuid REFERENCES public.gl_journal_lines(id),
    match_type               text NOT NULL CHECK (match_type IN ('AUTO', 'MANUAL')),
    created_by               uuid,
    created_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bank_recon_matches_one_side CHECK ((statement_transaction_id IS NULL) <> (journal_line_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_recon_matches_statement_once
    ON public.bank_recon_matches (statement_transaction_id) WHERE statement_transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS bank_recon_matches_journal_once
    ON public.bank_recon_matches (journal_line_id) WHERE journal_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bank_recon_matches_recon ON public.bank_recon_matches (reconciliation_id, match_group);

ALTER TABLE public.bank_recon_matches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bank_recon_matches FROM public, anon, authenticated;
GRANT ALL ON TABLE public.bank_recon_matches TO service_role;
COMMENT ON TABLE public.bank_recon_matches IS
    'Bank reconciliation matches (statement lines <-> GL lines). Written only through the fin_recon_* functions.';

-- ---------------------------------------------------------------------------
-- 3. Balances
-- ---------------------------------------------------------------------------
-- Bank balance at a date: running balance of the last statement line on or before it.
CREATE OR REPLACE FUNCTION public.fin_recon_statement_balance(p_bank_account_id uuid, p_date date)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
    SELECT COALESCE(
        (SELECT t.balance FROM public.bank_statement_transactions t
          WHERE t.bank_account_id = p_bank_account_id AND t.transaction_date <= p_date AND t.balance IS NOT NULL
          ORDER BY t.transaction_date DESC, t.day_sequence DESC LIMIT 1),
        (SELECT b.opening_balance FROM public.bank_accounts b WHERE b.id = p_bank_account_id),
        0)::numeric(18,2);
$function$;

-- Book balance at a date: opening balance + every posted (and reversed, with its
-- reversal) journal line on the linked GL account, as the Bank Accounts screen shows it.
CREATE OR REPLACE FUNCTION public.fin_recon_book_balance(p_bank_account_id uuid, p_date date)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
    SELECT (COALESCE(b.opening_balance, 0) + COALESCE((
        SELECT sum(l.debit_amount - l.credit_amount)
        FROM public.gl_journal_lines l
        JOIN public.gl_journals j ON j.id = l.journal_id
        WHERE l.account_id = b.gl_account_id
          AND j.company_id = b.company_id
          AND j.status IN ('POSTED', 'REVERSED')
          AND j.journal_date <= p_date), 0))::numeric(18,2)
    FROM public.bank_accounts b WHERE b.id = p_bank_account_id;
$function$;

REVOKE ALL ON FUNCTION public.fin_recon_statement_balance(uuid, date) FROM public, anon;
REVOKE ALL ON FUNCTION public.fin_recon_book_balance(uuid, date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fin_recon_statement_balance(uuid, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_recon_book_balance(uuid, date) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Lines in scope of a reconciliation (internal)
-- ---------------------------------------------------------------------------
-- Statement and ledger lines from the account's start date to the period end that
-- are not matched by another reconciliation (unmatched lines carry forward).
CREATE OR REPLACE FUNCTION public.fin_recon_scope(p_recon_id uuid)
 RETURNS TABLE (
    side text, line_id uuid, line_date date, seq integer, money_in numeric, money_out numeric,
    description text, reference text, journal_id uuid, journal_number text, journal_type text,
    journal_status text, reversal_journal_id uuid, match_group uuid, match_type text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
    WITH r AS (
        SELECT rc.*, b.gl_account_id FROM public.bank_reconciliations rc
        JOIN public.bank_accounts b ON b.id = rc.bank_account_id WHERE rc.id = p_recon_id
    )
    SELECT 'BANK', t.id, t.transaction_date, t.day_sequence, t.credit_amount, t.debit_amount,
           concat_ws(' · ', NULLIF(t.description, ''), NULLIF(t.counterparty, ''), NULLIF(t.payment_details, '')),
           COALESCE(NULLIF(t.reference, ''), NULLIF(t.cheque_no, '')),
           NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::uuid, m.match_group, m.match_type
    FROM r JOIN public.bank_statement_transactions t ON t.bank_account_id = r.bank_account_id
    LEFT JOIN public.bank_recon_matches m ON m.statement_transaction_id = t.id
    WHERE t.transaction_date BETWEEN r.start_date AND r.period_end
      AND (m.id IS NULL OR m.reconciliation_id = r.id)
    UNION ALL
    SELECT 'BOOK', l.id, j.journal_date, l.line_number, l.debit_amount, l.credit_amount,
           COALESCE(NULLIF(l.description, ''), j.description), j.reference,
           j.id, j.journal_number, j.journal_type, j.status, j.reversal_journal_id, m.match_group, m.match_type
    FROM r JOIN public.gl_journal_lines l ON l.account_id = r.gl_account_id
    JOIN public.gl_journals j ON j.id = l.journal_id AND j.company_id = r.company_id
    LEFT JOIN public.bank_recon_matches m ON m.journal_line_id = l.id
    WHERE j.status IN ('POSTED', 'REVERSED')
      AND j.journal_date BETWEEN r.start_date AND r.period_end
      AND (m.id IS NULL OR m.reconciliation_id = r.id);
$function$;
REVOKE ALL ON FUNCTION public.fin_recon_scope(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_recon_scope(uuid) TO service_role;

-- Load a reconciliation the caller may work on (internal).
CREATE OR REPLACE FUNCTION public.fin_recon_get(p_recon_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id uuid := public.get_user_company_id();
    v_recon record;
BEGIN
    SELECT rc.*, b.account_name, b.bank_name, b.gl_account_id INTO v_recon
    FROM public.bank_reconciliations rc JOIN public.bank_accounts b ON b.id = rc.bank_account_id
    WHERE rc.id = p_recon_id AND rc.company_id = v_company_id;
    IF v_recon.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Reconciliation not found');
    END IF;
    IF v_recon.gl_account_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'The bank account is not linked to a GL account');
    END IF;
    IF v_recon.start_date IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error',
            'This reconciliation was made with the old screen. Void it and start a new one.');
    END IF;
    RETURN jsonb_build_object('success', true, 'recon', to_jsonb(v_recon));
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_recon_get(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_recon_get(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Figures of a reconciliation
-- ---------------------------------------------------------------------------
--   Bank balance + book money in not in bank - book money out not in bank = adjusted bank
--   Book balance + bank money in not in books - bank money out not in books = adjusted book
-- Complete when every bank line is matched (all bank items are in the books), the
-- statement covers the period end and the adjusted balances agree.
CREATE OR REPLACE FUNCTION public.fin_recon_summary(p_recon_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_r          record;
    v_stmt       numeric(18,2);
    v_book       numeric(18,2);
    v_s          record;
    v_covered    date;
    v_adj_bank   numeric(18,2);
    v_adj_book   numeric(18,2);
BEGIN
    SELECT * INTO v_r FROM public.bank_reconciliations WHERE id = p_recon_id;
    v_stmt := public.fin_recon_statement_balance(v_r.bank_account_id, v_r.period_end);
    v_book := public.fin_recon_book_balance(v_r.bank_account_id, v_r.period_end);

    SELECT
        COALESCE(sum(money_in)  FILTER (WHERE side = 'BOOK' AND match_group IS NULL), 0) AS book_in,
        COALESCE(sum(money_out) FILTER (WHERE side = 'BOOK' AND match_group IS NULL), 0) AS book_out,
        COALESCE(sum(money_in)  FILTER (WHERE side = 'BANK' AND match_group IS NULL), 0) AS bank_in,
        COALESCE(sum(money_out) FILTER (WHERE side = 'BANK' AND match_group IS NULL), 0) AS bank_out,
        count(*) FILTER (WHERE side = 'BOOK' AND match_group IS NULL) AS book_open,
        count(*) FILTER (WHERE side = 'BANK' AND match_group IS NULL) AS bank_open,
        count(*) FILTER (WHERE side = 'BOOK') AS book_lines,
        count(*) FILTER (WHERE side = 'BANK') AS bank_lines,
        count(DISTINCT match_group) AS groups
    INTO v_s FROM public.fin_recon_scope(p_recon_id);

    SELECT max(t.transaction_date) INTO v_covered
    FROM public.bank_statement_transactions t WHERE t.bank_account_id = v_r.bank_account_id;
    SELECT GREATEST(v_covered, max(i.period_end)) INTO v_covered
    FROM public.bank_statement_imports i
    WHERE i.bank_account_id = v_r.bank_account_id AND i.status = 'completed';

    v_adj_bank := v_stmt + v_s.book_in - v_s.book_out;
    v_adj_book := v_book + v_s.bank_in - v_s.bank_out;

    RETURN jsonb_build_object(
        'statement_balance', v_stmt,
        'book_balance', v_book,
        'deposits_in_transit', v_s.book_in,
        'outstanding_payments', v_s.book_out,
        'bank_receipts_not_in_books', v_s.bank_in,
        'bank_payments_not_in_books', v_s.bank_out,
        'adjusted_bank_balance', v_adj_bank,
        'adjusted_book_balance', v_adj_book,
        'difference', v_adj_bank - v_adj_book,
        'bank_lines', v_s.bank_lines,
        'book_lines', v_s.book_lines,
        'bank_unmatched', v_s.bank_open,
        'book_unmatched', v_s.book_open,
        'match_groups', v_s.groups,
        'statement_covered_to', v_covered,
        'statement_covers_period', v_covered IS NOT NULL AND v_covered >= v_r.period_end,
        'can_submit', v_s.bank_open = 0 AND (v_adj_bank - v_adj_book) = 0
                      AND v_covered IS NOT NULL AND v_covered >= v_r.period_end
    );
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_recon_summary(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fin_recon_summary(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Start a reconciliation
-- ---------------------------------------------------------------------------
-- The first reconciliation of an account starts on p_start_date (normally the go-live
-- date); later ones continue the day after the last completed one.
CREATE OR REPLACE FUNCTION public.fin_recon_start(p_bank_account_id uuid, p_period_end date, p_start_date date DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id uuid := public.get_user_company_id();
    v_today      date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
    v_bank       record;
    v_prev       record;
    v_start      date;
    v_period_start date;
    v_id         uuid := gen_random_uuid();
BEGIN
  /* sa-guard:finance.reconciliation.perform */
  PERFORM public.sa_require_operation('finance.reconciliation.perform', jsonb_build_object('organization_id', v_company_id), 'BANK_RECONCILIATION', p_bank_account_id::text);

    SELECT * INTO v_bank FROM public.bank_accounts WHERE id = p_bank_account_id AND company_id = v_company_id;
    IF v_bank.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Bank account not found');
    END IF;
    IF v_bank.gl_account_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Link the bank account to a GL account first');
    END IF;
    PERFORM 1 FROM public.bank_accounts WHERE id = p_bank_account_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.bank_reconciliations
               WHERE bank_account_id = p_bank_account_id AND status IN ('draft', 'in_progress', 'submitted')) THEN
        RETURN jsonb_build_object('success', false, 'error',
            'This bank account already has an open reconciliation. Finish or void it first.');
    END IF;

    SELECT * INTO v_prev FROM public.bank_reconciliations
    WHERE bank_account_id = p_bank_account_id AND status = 'completed' AND start_date IS NOT NULL
    ORDER BY period_end DESC LIMIT 1;

    IF v_prev.id IS NOT NULL THEN
        v_start := v_prev.start_date;
        v_period_start := v_prev.period_end + 1;
    ELSE
        IF p_start_date IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error',
                'Enter the date reconciliation starts from (normally the go-live date)');
        END IF;
        v_start := p_start_date;
        v_period_start := p_start_date;
    END IF;

    IF p_period_end IS NULL OR p_period_end < v_period_start THEN
        RETURN jsonb_build_object('success', false, 'error',
            'The period must end on or after ' || to_char(v_period_start, 'DD/MM/YYYY'));
    END IF;
    IF p_period_end > v_today THEN
        RETURN jsonb_build_object('success', false, 'error', 'The period end cannot be in the future');
    END IF;

    INSERT INTO public.bank_reconciliations (
        id, company_id, bank_account_id, period_start, period_end, start_date,
        statement_balance, book_balance, status, created_by)
    VALUES (
        v_id, v_company_id, p_bank_account_id, v_period_start, p_period_end, v_start,
        public.fin_recon_statement_balance(p_bank_account_id, p_period_end),
        public.fin_recon_book_balance(p_bank_account_id, p_period_end),
        'draft', auth.uid());

    RETURN jsonb_build_object('success', true, 'reconciliation_id', v_id,
        'period_start', v_period_start, 'period_end', p_period_end, 'start_date', v_start);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Read a reconciliation: header, figures, bank and book lines
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_recon_data(p_recon_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id uuid := public.get_user_company_id();
    v_get        jsonb;
    v_summary    jsonb;
BEGIN
  /* sa-guard:finance.cash.view */
  PERFORM public.sa_require_operation('finance.cash.view', jsonb_build_object('organization_id', v_company_id), 'BANK_RECONCILIATION', p_recon_id::text);
    v_get := public.fin_recon_get(p_recon_id);
    IF NOT (v_get->>'success')::boolean THEN RETURN v_get; END IF;

    v_summary := public.fin_recon_summary(p_recon_id);
    -- Keep the header figures current while the reconciliation is being prepared.
    UPDATE public.bank_reconciliations
    SET statement_balance = (v_summary->>'statement_balance')::numeric,
        book_balance = (v_summary->>'book_balance')::numeric,
        updated_at = now()
    WHERE id = p_recon_id AND status IN ('draft', 'in_progress')
      AND (statement_balance IS DISTINCT FROM (v_summary->>'statement_balance')::numeric
           OR book_balance IS DISTINCT FROM (v_summary->>'book_balance')::numeric);

    RETURN jsonb_build_object(
        'success', true,
        'reconciliation', v_get->'recon',
        'summary', CASE WHEN v_get->'recon'->>'status' = 'completed' AND v_get->'recon'->'summary' IS NOT NULL
                        THEN v_get->'recon'->'summary' ELSE v_summary END,
        'lines', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'side', s.side, 'id', s.line_id, 'date', s.line_date, 'money_in', s.money_in,
                'money_out', s.money_out, 'description', s.description, 'reference', s.reference,
                'journal_id', s.journal_id, 'journal_number', s.journal_number,
                'journal_type', s.journal_type, 'journal_status', s.journal_status,
                'match_group', s.match_group, 'match_type', s.match_type)
                ORDER BY s.side, s.line_date, s.seq)
            FROM public.fin_recon_scope(p_recon_id) s), '[]'::jsonb)
    );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 8. Automatic matching
-- ---------------------------------------------------------------------------
--   a) a reversed journal with its reversal (book only, nets to zero);
--   b) bank line and book line with the same amount and direction, dated within
--      3 days, where the book reference appears in the bank line;
--   c) the same, where each line has exactly one possible partner.
CREATE OR REPLACE FUNCTION public.fin_recon_auto_match(p_recon_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id uuid := public.get_user_company_id();
    v_get        jsonb;
    v_r          record;
    v_pairs      integer := 0;
    v_rev        integer := 0;
    v_n          integer;
    v_pair       record;
    v_group      uuid;
BEGIN
  /* sa-guard:finance.reconciliation.perform */
  PERFORM public.sa_require_operation('finance.reconciliation.perform', jsonb_build_object('organization_id', v_company_id), 'BANK_RECONCILIATION', p_recon_id::text);
    v_get := public.fin_recon_get(p_recon_id);
    IF NOT (v_get->>'success')::boolean THEN RETURN v_get; END IF;
    SELECT * INTO v_r FROM public.bank_reconciliations WHERE id = p_recon_id FOR UPDATE;
    IF v_r.status NOT IN ('draft', 'in_progress') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only a reconciliation in preparation can be changed');
    END IF;

    -- a) Journal + its reversal.
    FOR v_pair IN
        SELECT o.line_id AS a, rv.line_id AS b
        FROM public.fin_recon_scope(p_recon_id) o
        JOIN public.fin_recon_scope(p_recon_id) rv
          ON rv.side = 'BOOK' AND rv.journal_id = o.reversal_journal_id
         AND rv.money_in = o.money_out AND rv.money_out = o.money_in
        WHERE o.side = 'BOOK' AND o.journal_status = 'REVERSED'
          AND o.match_group IS NULL AND rv.match_group IS NULL
    LOOP
        CONTINUE WHEN EXISTS (SELECT 1 FROM public.bank_recon_matches
                              WHERE journal_line_id IN (v_pair.a, v_pair.b));
        v_group := gen_random_uuid();
        INSERT INTO public.bank_recon_matches (company_id, bank_account_id, reconciliation_id, match_group,
            journal_line_id, match_type, created_by)
        VALUES (v_r.company_id, v_r.bank_account_id, p_recon_id, v_group, v_pair.a, 'AUTO', auth.uid()),
               (v_r.company_id, v_r.bank_account_id, p_recon_id, v_group, v_pair.b, 'AUTO', auth.uid());
        v_rev := v_rev + 1;
    END LOOP;

    -- b) and c): one bank line with one book line.
    FOR v_n IN 1..2 LOOP
        FOR v_pair IN
            WITH s AS (SELECT * FROM public.fin_recon_scope(p_recon_id) WHERE match_group IS NULL),
            cand AS (
                SELECT bk.line_id AS bank_id, bo.line_id AS book_id,
                       abs(bk.line_date - bo.line_date) AS gap,
                       (bo.reference IS NOT NULL AND length(bo.reference) >= 4
                        AND (bk.description ILIKE '%' || bo.reference || '%'
                             OR COALESCE(bk.reference, '') ILIKE '%' || bo.reference || '%')) AS ref_hit
                FROM s bk JOIN s bo
                  ON bk.side = 'BANK' AND bo.side = 'BOOK'
                 AND bk.money_in - bk.money_out = bo.money_in - bo.money_out
                 AND bk.money_in - bk.money_out <> 0
                 AND abs(bk.line_date - bo.line_date) <= 3
            ),
            pick AS (
                SELECT c.*,
                       count(*) OVER (PARTITION BY c.bank_id) AS bank_n,
                       count(*) OVER (PARTITION BY c.book_id) AS book_n
                FROM cand c WHERE (v_n = 1 AND c.ref_hit) OR v_n = 2
            )
            SELECT bank_id, book_id FROM pick WHERE bank_n = 1 AND book_n = 1
        LOOP
            CONTINUE WHEN EXISTS (SELECT 1 FROM public.bank_recon_matches
                                  WHERE statement_transaction_id = v_pair.bank_id OR journal_line_id = v_pair.book_id);
            v_group := gen_random_uuid();
            INSERT INTO public.bank_recon_matches (company_id, bank_account_id, reconciliation_id, match_group,
                statement_transaction_id, journal_line_id, match_type, created_by)
            VALUES (v_r.company_id, v_r.bank_account_id, p_recon_id, v_group, v_pair.bank_id, NULL, 'AUTO', auth.uid()),
                   (v_r.company_id, v_r.bank_account_id, p_recon_id, v_group, NULL, v_pair.book_id, 'AUTO', auth.uid());
            v_pairs := v_pairs + 1;
        END LOOP;
    END LOOP;

    UPDATE public.bank_reconciliations SET status = 'in_progress', updated_at = now()
    WHERE id = p_recon_id AND status = 'draft' AND (v_pairs + v_rev) > 0;

    RETURN jsonb_build_object('success', true, 'matched_pairs', v_pairs, 'matched_reversals', v_rev);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 9. Manual match / unmatch
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_recon_match(p_recon_id uuid, p_statement_ids uuid[], p_journal_line_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id uuid := public.get_user_company_id();
    v_get        jsonb;
    v_r          record;
    v_bank_ids   uuid[] := COALESCE(p_statement_ids, '{}');
    v_book_ids   uuid[] := COALESCE(p_journal_line_ids, '{}');
    v_found      integer;
    v_bank_net   numeric(18,2);
    v_book_net   numeric(18,2);
    v_group      uuid := gen_random_uuid();
BEGIN
  /* sa-guard:finance.reconciliation.perform */
  PERFORM public.sa_require_operation('finance.reconciliation.perform', jsonb_build_object('organization_id', v_company_id), 'BANK_RECONCILIATION', p_recon_id::text);
    v_get := public.fin_recon_get(p_recon_id);
    IF NOT (v_get->>'success')::boolean THEN RETURN v_get; END IF;
    SELECT * INTO v_r FROM public.bank_reconciliations WHERE id = p_recon_id FOR UPDATE;
    IF v_r.status NOT IN ('draft', 'in_progress') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only a reconciliation in preparation can be changed');
    END IF;
    IF cardinality(v_bank_ids) + cardinality(v_book_ids) < 2 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Select at least two lines to match');
    END IF;

    SELECT count(*), COALESCE(sum(money_in - money_out) FILTER (WHERE side = 'BANK'), 0),
           COALESCE(sum(money_in - money_out) FILTER (WHERE side = 'BOOK'), 0)
    INTO v_found, v_bank_net, v_book_net
    FROM public.fin_recon_scope(p_recon_id)
    WHERE match_group IS NULL
      AND ((side = 'BANK' AND line_id = ANY (v_bank_ids)) OR (side = 'BOOK' AND line_id = ANY (v_book_ids)));

    IF v_found <> cardinality(v_bank_ids) + cardinality(v_book_ids) THEN
        RETURN jsonb_build_object('success', false, 'error',
            'Some selected lines are already matched or are outside this reconciliation. Refresh and try again.');
    END IF;
    IF v_bank_net <> v_book_net THEN
        RETURN jsonb_build_object('success', false, 'error',
            'The selected lines do not agree: bank ' || to_char(v_bank_net, 'FM999,999,999,990.00')
            || ', books ' || to_char(v_book_net, 'FM999,999,999,990.00') || '.');
    END IF;

    INSERT INTO public.bank_recon_matches (company_id, bank_account_id, reconciliation_id, match_group,
        statement_transaction_id, journal_line_id, match_type, created_by)
    SELECT v_r.company_id, v_r.bank_account_id, p_recon_id, v_group, x, NULL, 'MANUAL', auth.uid() FROM unnest(v_bank_ids) x
    UNION ALL
    SELECT v_r.company_id, v_r.bank_account_id, p_recon_id, v_group, NULL, x, 'MANUAL', auth.uid() FROM unnest(v_book_ids) x;

    UPDATE public.bank_reconciliations SET status = 'in_progress', updated_at = now()
    WHERE id = p_recon_id AND status = 'draft';

    RETURN jsonb_build_object('success', true, 'match_group', v_group);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fin_recon_unmatch(p_recon_id uuid, p_match_group uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id uuid := public.get_user_company_id();
    v_get        jsonb;
    v_r          record;
    v_n          integer;
BEGIN
  /* sa-guard:finance.reconciliation.perform */
  PERFORM public.sa_require_operation('finance.reconciliation.perform', jsonb_build_object('organization_id', v_company_id), 'BANK_RECONCILIATION', p_recon_id::text);
    v_get := public.fin_recon_get(p_recon_id);
    IF NOT (v_get->>'success')::boolean THEN RETURN v_get; END IF;
    SELECT * INTO v_r FROM public.bank_reconciliations WHERE id = p_recon_id FOR UPDATE;
    IF v_r.status NOT IN ('draft', 'in_progress') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only a reconciliation in preparation can be changed');
    END IF;
    DELETE FROM public.bank_recon_matches WHERE reconciliation_id = p_recon_id AND match_group = p_match_group;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Match not found in this reconciliation');
    END IF;
    RETURN jsonb_build_object('success', true, 'lines_released', v_n);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 10. Submit, approve, return, void
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_recon_submit(p_recon_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id uuid := public.get_user_company_id();
    v_get        jsonb;
    v_r          record;
    v_sum        jsonb;
BEGIN
  /* sa-guard:finance.reconciliation.perform */
  PERFORM public.sa_require_operation('finance.reconciliation.perform', jsonb_build_object('organization_id', v_company_id), 'BANK_RECONCILIATION', p_recon_id::text);
    v_get := public.fin_recon_get(p_recon_id);
    IF NOT (v_get->>'success')::boolean THEN RETURN v_get; END IF;
    SELECT * INTO v_r FROM public.bank_reconciliations WHERE id = p_recon_id FOR UPDATE;
    IF v_r.status NOT IN ('draft', 'in_progress') THEN
        RETURN jsonb_build_object('success', false, 'error', 'This reconciliation has already been submitted');
    END IF;

    v_sum := public.fin_recon_summary(p_recon_id);
    IF NOT (v_sum->>'statement_covers_period')::boolean THEN
        RETURN jsonb_build_object('success', false, 'error',
            'The approved bank statements do not reach the period end. Import and approve the statement first.');
    END IF;
    IF (v_sum->>'bank_unmatched')::integer > 0 THEN
        RETURN jsonb_build_object('success', false, 'error',
            (v_sum->>'bank_unmatched') || ' bank line(s) are not matched. Every bank movement must be in the books: '
            || 'match it, or record it with a journal (bank charges, interest) and match that.');
    END IF;
    IF (v_sum->>'difference')::numeric <> 0 THEN
        RETURN jsonb_build_object('success', false, 'error',
            'The adjusted bank and book balances differ by ' || (v_sum->>'difference')
            || '. Check the opening balance of the bank account against the statement.');
    END IF;

    UPDATE public.bank_reconciliations
    SET status = 'submitted', submitted_by = auth.uid(), submitted_at = now(), summary = v_sum,
        statement_balance = (v_sum->>'statement_balance')::numeric,
        book_balance = (v_sum->>'book_balance')::numeric, updated_at = now()
    WHERE id = p_recon_id;
    RETURN jsonb_build_object('success', true, 'summary', v_sum);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fin_recon_approve(p_recon_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id uuid := public.get_user_company_id();
    v_get        jsonb;
    v_r          record;
    v_sum        jsonb;
BEGIN
  /* sa-guard:finance.reconciliation.perform */
  PERFORM public.sa_require_operation('finance.reconciliation.perform', jsonb_build_object('organization_id', v_company_id), 'BANK_RECONCILIATION', p_recon_id::text);
    v_get := public.fin_recon_get(p_recon_id);
    IF NOT (v_get->>'success')::boolean THEN RETURN v_get; END IF;
    SELECT * INTO v_r FROM public.bank_reconciliations WHERE id = p_recon_id FOR UPDATE;
    IF v_r.status <> 'submitted' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only a submitted reconciliation can be approved');
    END IF;
    IF auth.uid() IS NOT NULL AND (auth.uid() = v_r.submitted_by OR auth.uid() = v_r.created_by) THEN
        RETURN jsonb_build_object('success', false, 'error',
            'You prepared or submitted this reconciliation. Another user must approve it.');
    END IF;

    -- Nothing may have changed since submission (e.g. a matched journal reversed).
    v_sum := public.fin_recon_summary(p_recon_id);
    IF (v_sum->>'bank_unmatched')::integer > 0 OR (v_sum->>'difference')::numeric <> 0 THEN
        RETURN jsonb_build_object('success', false, 'error',
            'The figures changed since submission. Return it to the preparer to review.');
    END IF;

    UPDATE public.bank_reconciliations
    SET status = 'completed', reconciled_by = auth.uid(), reconciled_at = now(), summary = v_sum,
        statement_balance = (v_sum->>'statement_balance')::numeric,
        book_balance = (v_sum->>'book_balance')::numeric, updated_at = now()
    WHERE id = p_recon_id;
    RETURN jsonb_build_object('success', true);
END;
$function$;

-- Submitted -> back to preparation (approver returns it, or the submitter recalls it).
CREATE OR REPLACE FUNCTION public.fin_recon_return(p_recon_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id uuid := public.get_user_company_id();
    v_get        jsonb;
    v_r          record;
    v_reason     text := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  /* sa-guard:finance.reconciliation.perform */
  PERFORM public.sa_require_operation('finance.reconciliation.perform', jsonb_build_object('organization_id', v_company_id), 'BANK_RECONCILIATION', p_recon_id::text);
    v_get := public.fin_recon_get(p_recon_id);
    IF NOT (v_get->>'success')::boolean THEN RETURN v_get; END IF;
    SELECT * INTO v_r FROM public.bank_reconciliations WHERE id = p_recon_id FOR UPDATE;
    IF v_r.status <> 'submitted' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Only a submitted reconciliation can be returned');
    END IF;
    IF v_reason IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Enter the reason');
    END IF;
    UPDATE public.bank_reconciliations
    SET status = 'in_progress', submitted_by = NULL, submitted_at = NULL, summary = NULL,
        notes = concat_ws(E'\n', notes, to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur', 'DD/MM/YYYY HH24:MI') || ' returned: ' || v_reason),
        updated_at = now()
    WHERE id = p_recon_id;
    RETURN jsonb_build_object('success', true);
END;
$function$;

-- Void: releases every match. A completed reconciliation can be voided only if it is
-- the latest one of the account (later periods depend on it).
CREATE OR REPLACE FUNCTION public.fin_recon_void(p_recon_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
    v_company_id uuid := public.get_user_company_id();
    v_r          record;
    v_reason     text := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  /* sa-guard:finance.reconciliation.perform */
  PERFORM public.sa_require_operation('finance.reconciliation.perform', jsonb_build_object('organization_id', v_company_id), 'BANK_RECONCILIATION', p_recon_id::text);
    SELECT * INTO v_r FROM public.bank_reconciliations
    WHERE id = p_recon_id AND company_id = v_company_id FOR UPDATE;
    IF v_r.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Reconciliation not found');
    END IF;
    IF v_r.status = 'void' THEN
        RETURN jsonb_build_object('success', false, 'error', 'This reconciliation is already void');
    END IF;
    IF v_reason IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Enter the reason');
    END IF;
    IF v_r.status = 'completed' AND EXISTS (
        SELECT 1 FROM public.bank_reconciliations
        WHERE bank_account_id = v_r.bank_account_id AND status <> 'void' AND period_end > v_r.period_end) THEN
        RETURN jsonb_build_object('success', false, 'error',
            'A later reconciliation exists for this account. Void the latest one first.');
    END IF;

    DELETE FROM public.bank_recon_matches WHERE reconciliation_id = p_recon_id;
    UPDATE public.bank_reconciliations
    SET status = 'void',
        notes = concat_ws(E'\n', notes, to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur', 'DD/MM/YYYY HH24:MI') || ' voided: ' || v_reason),
        updated_at = now()
    WHERE id = p_recon_id;
    RETURN jsonb_build_object('success', true);
END;
$function$;

DO $grants$
DECLARE f text;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'fin_recon_start(uuid, date, date)', 'fin_recon_data(uuid)', 'fin_recon_auto_match(uuid)',
        'fin_recon_match(uuid, uuid[], uuid[])', 'fin_recon_unmatch(uuid, uuid)', 'fin_recon_submit(uuid)',
        'fin_recon_approve(uuid)', 'fin_recon_return(uuid, text)', 'fin_recon_void(uuid, text)']
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM public, anon', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated, service_role', f);
    END LOOP;
END
$grants$;

-- ---------------------------------------------------------------------------
-- 11. Reversal: blocked while the journal is matched in a reconciliation
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
    -- A journal matched in a bank reconciliation must be unmatched first (or the
    -- reconciliation voided), so a completed reconciliation never changes silently.
    SELECT string_agg(DISTINCT to_char(rc.period_start, 'DD/MM/YYYY') || '–' || to_char(rc.period_end, 'DD/MM/YYYY')
                      || ' (' || rc.status || ')', ', ')
    INTO v_blockers
    FROM public.bank_recon_matches m
    JOIN public.gl_journal_lines l ON l.id = m.journal_line_id
    JOIN public.bank_reconciliations rc ON rc.id = m.reconciliation_id
    WHERE l.journal_id = p_journal_id;
    IF v_blockers IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error',
            'This journal is matched in the bank reconciliation ' || v_blockers
            || '. Unmatch it there (or void that reconciliation) before reversing.');
    END IF;
    v_blockers := NULL;
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

COMMIT;

-- Verification (read only)
SELECT count(*) AS reconciliation_functions FROM pg_proc WHERE proname LIKE 'fin_recon_%';
SELECT b.account_name,
       public.fin_recon_statement_balance(b.id, CURRENT_DATE) AS bank_balance_today,
       public.fin_recon_book_balance(b.id, CURRENT_DATE) AS book_balance_today
FROM public.bank_accounts b WHERE b.is_active ORDER BY b.account_name;
