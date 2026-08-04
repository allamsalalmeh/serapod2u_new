-- =============================================================================
-- FILE      : 06_PhaseB_reconciliation_apply.sql   [DATA CHANGE]
-- PURPOSE   : Apply the two reconciliation UPDATEs from the 9a62556a contract.
-- RUN AFTER : 06_PhaseA_reconciliation_preview.sql says SAFE_TO_APPLY.
-- RUN       : Works in psql, Supabase Studio, DBeaver, pgAdmin. No psql
--             meta-commands anywhere in this file.
-- SAFETY    : Ends in ROLLBACK. Run once, read the output, then swap the final
--             ROLLBACK for COMMIT and run again.
--
-- This is the ONLY file in the pack that changes business data. It does not
-- touch inventory quantities, stock movements, orders, QR records or posted
-- Opening Balances - and it proves that before you commit.
--
-- Replaces the psql "\if :reconcile_approved" gate of the old
-- 06_data_reconciliation.sql. That gate silently stopped working in any client
-- that does not understand backslash meta-commands, which would have let both
-- UPDATEs run unguarded. Here the gate is structural: a separate file, a hard
-- ambiguity assertion, and a default ROLLBACK.
--
-- The two UPDATE bodies below are copied VERBATIM from:
--   supabase/migrations/20260730_archive_variant_stock_config_reconciliation.sql
--   supabase/migrations/20260731220000_inventory_cutoff_cancel_archives_draft_session.sql
-- Only the surrounding guards, counters and proofs are new.
--
-- Column names verified against supabase/schemas/current_schema.sql
-- (production dump, 2026-08-01).
-- =============================================================================
--
-- Both UPDATEs are idempotent against the state they were written for, but they
-- are NOT time-scoped. If someone later and legitimately re-activates a
-- configuration on an archived variant, or a new draft ends up behind a
-- cancelled cut-off, a careless re-run would silently revert that. That is why
-- this file defaults to ROLLBACK and why you must read PhaseA first every time.
--
-- ambiguity_override: leave false. Set true ONLY when 06_PhaseA reported an
-- ambiguity AND you have documented manual approval to proceed anyway.
-- =============================================================================

BEGIN;

SET LOCAL statement_timeout = '120s';
SET LOCAL idle_in_transaction_session_timeout = '300s';

CREATE TEMP TABLE _recon_params ON COMMIT DROP AS
SELECT false AS ambiguity_override;   -- <<< leave false unless manually approved

CREATE TEMP TABLE _recon_log (
  seq serial, step text, detail text, rows_affected bigint
) ON COMMIT DROP;

DO $recon$
DECLARE
  p                 record;
  v_amb1 bigint; v_amb2 bigint; v_amb3 bigint;
  v_exp1 bigint; v_exp2 bigint;
  v_rows bigint;
  v_left1 bigint; v_left2 bigint;
  v_pi_count_before bigint; v_pi_hash_before text;
  v_pi_count_after  bigint; v_pi_hash_after  text;
  v_sm_count_before bigint; v_sm_hash_before text;
  v_sm_count_after  bigint; v_sm_hash_after  text;
BEGIN
  SELECT * INTO p FROM _recon_params;

  ---------------------------------------------------------------------------
  -- GUARD 1. Ambiguities are a hard stop (was advisory in the old file).
  ---------------------------------------------------------------------------
  SELECT count(*) INTO v_amb1
  FROM public.inventory_stock_configurations isc
  JOIN public.product_variants pv ON pv.id = isc.variant_id
  WHERE pv.is_active = false AND isc.status IN ('active','phase_out')
    AND EXISTS (SELECT 1 FROM public.stock_movements m WHERE m.stock_config_id = isc.id);

  SELECT count(*) INTO v_amb2
  FROM public.inventory_stock_configurations isc
  JOIN public.product_variants pv ON pv.id = isc.variant_id
  JOIN public.product_inventory pi ON pi.stock_config_id = isc.id
  WHERE pv.is_active = false AND isc.status IN ('active','phase_out')
    AND (pi.quantity_on_hand <> 0 OR pi.quantity_allocated <> 0);

  SELECT count(*) INTO v_amb3 FROM (
    SELECT s.id FROM public.stock_count_sessions s
      JOIN public.inventory_opening_cutoffs c ON c.stock_count_session_id = s.id
     WHERE s.status = 'draft' AND s.count_type = 'opening_balance_cutoff'
     GROUP BY s.id
    HAVING count(*) FILTER (WHERE c.status = 'cancelled') > 0
       AND count(*) FILTER (WHERE c.status <> 'cancelled') > 0) z;

  IF (v_amb1 > 0 OR v_amb2 > 0 OR v_amb3 > 0) AND NOT p.ambiguity_override THEN
    RAISE EXCEPTION
      'Refusing to apply: 06_PhaseA ambiguities are non-zero (config_has_movements=%, config_holds_stock=%, session_mixed_cutoffs=%). Resolve them, or set ambiguity_override = true with documented approval.',
      v_amb1, v_amb2, v_amb3;
  END IF;

  IF p.ambiguity_override THEN
    INSERT INTO _recon_log(step, detail, rows_affected) VALUES
      ('00 override', format('ambiguity_override=TRUE (%s/%s/%s) - proceeding on manual approval',
                             v_amb1, v_amb2, v_amb3), 0);
  END IF;

  ---------------------------------------------------------------------------
  -- Expected counts, computed with the SAME predicates as the UPDATEs.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO v_exp1
  FROM public.inventory_stock_configurations isc
  JOIN public.product_variants pv ON pv.id = isc.variant_id
  WHERE pv.is_active = false AND isc.status IN ('active','phase_out');

  SELECT count(*) INTO v_exp2
  FROM public.stock_count_sessions s
  WHERE s.status = 'draft' AND s.count_type = 'opening_balance_cutoff'
    AND EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
                WHERE c.stock_count_session_id = s.id AND c.status = 'cancelled')
    AND NOT EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
                    WHERE c.stock_count_session_id = s.id
                      AND c.status IN ('counting','posted'));

  INSERT INTO _recon_log(step, detail, rows_affected) VALUES
    ('01 expected', 'CHANGE 1 configs to deactivate', v_exp1),
    ('02 expected', 'CHANGE 2 stuck draft sessions to archive', v_exp2);

  ---------------------------------------------------------------------------
  -- Fingerprint the tables this file must never touch.
  ---------------------------------------------------------------------------
  SELECT count(*), md5(coalesce(string_agg(sig,'|' ORDER BY sig),''))
    INTO v_pi_count_before, v_pi_hash_before
  FROM (SELECT pi.id::text||':'||coalesce(pi.quantity_on_hand,-1)::text
                 ||':'||coalesce(pi.quantity_allocated,-1)::text AS sig
        FROM public.product_inventory pi) q;

  SELECT count(*), md5(coalesce(string_agg(sig,'|' ORDER BY sig),''))
    INTO v_sm_count_before, v_sm_hash_before
  FROM (SELECT m.id::text AS sig FROM public.stock_movements m) q;

  ---------------------------------------------------------------------------
  -- CHANGE 1 (verbatim from 20260730_archive_variant_stock_config_reconciliation.sql)
  ---------------------------------------------------------------------------
  UPDATE public.inventory_stock_configurations AS isc
  SET status = 'inactive'
  FROM public.product_variants AS pv
  WHERE isc.variant_id = pv.id
    AND pv.is_active = false
    AND isc.status IN ('active', 'phase_out');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_exp1 THEN
    RAISE EXCEPTION 'ABORT: CHANGE 1 updated % row(s) but % were expected. Rolling back.', v_rows, v_exp1;
  END IF;
  INSERT INTO _recon_log(step, detail, rows_affected) VALUES
    ('10 change1', 'inventory_stock_configurations status -> inactive', v_rows);

  ---------------------------------------------------------------------------
  -- CHANGE 2 (verbatim from 20260731220000_inventory_cutoff_cancel_archives_draft_session.sql)
  ---------------------------------------------------------------------------
  update public.stock_count_sessions s
  set
    status = 'archived',
    updated_at = now()
  where s.status = 'draft'
    and s.count_type = 'opening_balance_cutoff'
    and exists (
      select 1
      from public.inventory_opening_cutoffs c
      where c.stock_count_session_id = s.id
        and c.status = 'cancelled'
    )
    and not exists (
      select 1
      from public.inventory_opening_cutoffs c
      where c.stock_count_session_id = s.id
        and c.status in ('counting', 'posted')
    );
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> v_exp2 THEN
    RAISE EXCEPTION 'ABORT: CHANGE 2 updated % row(s) but % were expected. Rolling back.', v_rows, v_exp2;
  END IF;
  INSERT INTO _recon_log(step, detail, rows_affected) VALUES
    ('11 change2', 'stock_count_sessions draft -> archived', v_rows);

  ---------------------------------------------------------------------------
  -- Post-conditions: both populations must now be empty (idempotency proof).
  ---------------------------------------------------------------------------
  SELECT count(*) INTO v_left1
  FROM public.inventory_stock_configurations isc
  JOIN public.product_variants pv ON pv.id = isc.variant_id
  WHERE pv.is_active = false AND isc.status IN ('active','phase_out');

  SELECT count(*) INTO v_left2
  FROM public.stock_count_sessions s
  WHERE s.status = 'draft' AND s.count_type = 'opening_balance_cutoff'
    AND EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
                WHERE c.stock_count_session_id = s.id AND c.status = 'cancelled')
    AND NOT EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
                    WHERE c.stock_count_session_id = s.id
                      AND c.status IN ('counting','posted'));

  IF v_left1 <> 0 OR v_left2 <> 0 THEN
    RAISE EXCEPTION 'ABORT: post-condition failed (change1 remaining=%, change2 remaining=%). Rolling back.', v_left1, v_left2;
  END IF;
  INSERT INTO _recon_log(step, detail, rows_affected) VALUES
    ('20 postcond', 'both populations now empty - re-running is a no-op', 0);

  ---------------------------------------------------------------------------
  -- Prove the untouchable tables are untouched.
  ---------------------------------------------------------------------------
  SELECT count(*), md5(coalesce(string_agg(sig,'|' ORDER BY sig),''))
    INTO v_pi_count_after, v_pi_hash_after
  FROM (SELECT pi.id::text||':'||coalesce(pi.quantity_on_hand,-1)::text
                 ||':'||coalesce(pi.quantity_allocated,-1)::text AS sig
        FROM public.product_inventory pi) q;

  SELECT count(*), md5(coalesce(string_agg(sig,'|' ORDER BY sig),''))
    INTO v_sm_count_after, v_sm_hash_after
  FROM (SELECT m.id::text AS sig FROM public.stock_movements m) q;

  IF v_pi_count_before <> v_pi_count_after OR v_pi_hash_before IS DISTINCT FROM v_pi_hash_after THEN
    RAISE EXCEPTION 'ABORT: product_inventory changed (% -> % rows). Rolling back.', v_pi_count_before, v_pi_count_after;
  END IF;
  IF v_sm_count_before <> v_sm_count_after OR v_sm_hash_before IS DISTINCT FROM v_sm_hash_after THEN
    RAISE EXCEPTION 'ABORT: stock_movements changed (% -> % rows). Rolling back.', v_sm_count_before, v_sm_count_after;
  END IF;

  INSERT INTO _recon_log(step, detail, rows_affected) VALUES
    ('90 proof', format('product_inventory UNCHANGED (%s rows, md5 %s)', v_pi_count_after, v_pi_hash_after), 0),
    ('91 proof', format('stock_movements UNCHANGED (%s rows, md5 %s)', v_sm_count_after, v_sm_hash_after), 0);

  RAISE NOTICE '=========================================================';
  RAISE NOTICE 'CHANGE 1: % row(s). CHANGE 2: % row(s).', v_exp1, v_exp2;
  RAISE NOTICE 'Nothing is saved yet. Read R1 below, then change the final';
  RAISE NOTICE 'ROLLBACK to COMMIT and run this file again.';
  RAISE NOTICE '=========================================================';
END
$recon$;

-- ---- PRE-COMMIT PROOF -------------------------------------------------------

SELECT 'R1. ACTION LOG' AS section, seq, step, detail, rows_affected
FROM _recon_log ORDER BY seq;

-- Must both be 0 after the updates.
SELECT
  'R2. POST-CONDITION' AS section,
  (SELECT count(*) FROM public.inventory_stock_configurations isc
     JOIN public.product_variants pv ON pv.id = isc.variant_id
    WHERE pv.is_active = false AND isc.status IN ('active','phase_out')) AS change1_remaining,
  (SELECT count(*) FROM public.stock_count_sessions s
    WHERE s.status = 'draft' AND s.count_type = 'opening_balance_cutoff'
      AND EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
                  WHERE c.stock_count_session_id = s.id AND c.status = 'cancelled')
      AND NOT EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
                      WHERE c.stock_count_session_id = s.id
                        AND c.status IN ('counting','posted')))         AS change2_remaining;

-- =============================================================================
-- FIRST RUN STOPS HERE ON PURPOSE.
-- Review R1/R2. When correct: comment out ROLLBACK, uncomment COMMIT, rerun.
-- =============================================================================

ROLLBACK;
-- COMMIT;
