-- Bank reconciliation: one bank transaction <-> one accounting entry; approval re-checks coverage
--
-- Review requests (before merging the finance module):
--  1. Matching pairs one bank statement line with one ledger line. A match never holds
--     two bank transactions. Book-only groups stay allowed (a journal and its reversal,
--     netting to zero). Automatic matching was already one-to-one.
--       - fin_recon_match: refuses more than one bank line, and a bank line with more or
--         fewer than one ledger line (patched in place).
--       - unique index: at most one bank line per match group, whatever writes the row.
--  2. Final approval re-checks that the approved bank statements still cover the period
--     end, not only at submission (fin_recon_approve, patched in place).
--
-- Stops without changing anything if an existing match already holds two bank lines.

BEGIN;

-- Existing data must already be one bank line per group.
DO $check$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM (
    SELECT match_group FROM public.bank_recon_matches
     WHERE statement_transaction_id IS NOT NULL
     GROUP BY match_group HAVING count(*) > 1
  ) g;
  IF v_n > 0 THEN
    RAISE EXCEPTION 'bank_recon_matches: % match group(s) hold more than one bank line. Unmatch them first.', v_n;
  END IF;
END
$check$;

CREATE UNIQUE INDEX IF NOT EXISTS bank_recon_matches_one_bank_line_per_group
    ON public.bank_recon_matches (match_group) WHERE statement_transaction_id IS NOT NULL;

-- 1. fin_recon_match ---------------------------------------------------------
DO $patch$
DECLARE
  v_def text;
  v_old text;
BEGIN
  SELECT replace(pg_get_functiondef(p.oid), E'\r', '') INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fin_recon_match';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fin_recon_match not found';
  END IF;
  IF position('Match one bank line with one ledger line' IN v_def) > 0 THEN
    RETURN;  -- already applied
  END IF;

  v_old := $o$    IF cardinality(v_bank_ids) + cardinality(v_book_ids) < 2 THEN
        RETURN jsonb_build_object('success', false, 'error', 'Select at least two lines to match');
    END IF;
$o$;
  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'fin_recon_match: anchor not found';
  END IF;
  v_def := replace(v_def, v_old, v_old || $n$    -- One bank transaction with one accounting entry. Without a bank line, ledger
    -- lines may be grouped when they net to zero (a journal and its reversal).
    IF cardinality(v_bank_ids) > 1 THEN
        RETURN jsonb_build_object('success', false, 'error',
            'Match one bank line with one ledger line. Select a single bank line.');
    END IF;
    IF cardinality(v_bank_ids) = 1 AND cardinality(v_book_ids) <> 1 THEN
        RETURN jsonb_build_object('success', false, 'error',
            'Match one bank line with one ledger line. Select a single ledger line.');
    END IF;
$n$);

  EXECUTE v_def;
END
$patch$;

-- 2. fin_recon_approve -------------------------------------------------------
DO $patch$
DECLARE
  v_def text;
  v_old text;
BEGIN
  SELECT replace(pg_get_functiondef(p.oid), E'\r', '') INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fin_recon_approve';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fin_recon_approve not found';
  END IF;
  IF position('no longer cover the period end' IN v_def) > 0 THEN
    RETURN;  -- already applied
  END IF;

  v_old := $o$    v_sum := public.fin_recon_summary(p_recon_id);
    IF (v_sum->>'bank_unmatched')::integer > 0 OR (v_sum->>'difference')::numeric <> 0 THEN$o$;
  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'fin_recon_approve: anchor not found';
  END IF;
  v_def := replace(v_def, v_old, $n$    v_sum := public.fin_recon_summary(p_recon_id);
    -- Coverage again: a statement may have been un-approved or removed after submission.
    IF NOT COALESCE((v_sum->>'statement_covers_period')::boolean, false) THEN
        RETURN jsonb_build_object('success', false, 'error',
            'The approved bank statements no longer cover the period end. Return it to the preparer.');
    END IF;
    IF (v_sum->>'bank_unmatched')::integer > 0 OR (v_sum->>'difference')::numeric <> 0 THEN$n$);

  EXECUTE v_def;
END
$patch$;

NOTIFY pgrst, 'reload schema';

COMMIT;
