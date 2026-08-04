-- =============================================================================
-- FILE      : 00_PhaseC_verify_counting_cutoff.sql
-- PURPOSE   : READ-ONLY confirmation that the cleanup landed correctly and that
--             nothing else moved.
-- RUN       : As-is, after 00_PhaseB_cancel_counting_cutoff.sql was COMMITTED.
-- SAFETY    : One BEGIN READ ONLY transaction. Cannot write.
--
-- Column names verified against supabase/schemas/current_schema.sql
-- (production dump, 2026-08-01).
-- =============================================================================

SET default_transaction_read_only = on;
BEGIN READ ONLY;

-- C1. Non-posted cut-offs and their sessions.
SELECT
  'C1. CUT-OFF STATE' AS section,
  c.id AS cutoff_id, c.status, c.cancelled_at, c.cancelled_by, c.posted_at,
  wh.org_name AS warehouse_name,
  s.id AS session_id, s.status AS session_status, s.archived_at,
  CASE
    WHEN c.status = 'cancelled' AND c.cancelled_at IS NOT NULL AND c.posted_at IS NULL
      THEN 'PASS - cancelled cleanly, no posted marker'
    WHEN c.status = 'counting'
      THEN 'FAIL - still counting, warehouse still frozen'
    ELSE 'REVIEW - unexpected state'
  END AS verdict
FROM public.inventory_opening_cutoffs c
LEFT JOIN public.stock_count_sessions s ON s.id = c.stock_count_session_id
LEFT JOIN public.organizations wh       ON wh.id = c.warehouse_organization_id
WHERE c.status <> 'posted'
ORDER BY c.updated_at DESC;

-- C2. No warehouse may remain frozen.
SELECT
  'C2. NO ACTIVE CUT-OFFS' AS section,
  count(*) FILTER (WHERE status = 'counting')  AS counting,
  count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
  count(*) FILTER (WHERE status = 'posted')    AS posted,
  CASE WHEN count(*) FILTER (WHERE status = 'counting') = 0
       THEN 'PASS - no warehouse is frozen'
       ELSE 'FAIL - a cut-off is still counting' END AS verdict
FROM public.inventory_opening_cutoffs;

-- C3. Orphan sweep. All FKs are RESTRICT/CASCADE, so these must be zero.
SELECT
  'C3. ORPHANED CHILDREN' AS section,
  (SELECT count(*) FROM public.inventory_cutoff_decisions d
     WHERE NOT EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c WHERE c.id = d.cutoff_id))     AS orphan_decisions,
  (SELECT count(*) FROM public.inventory_cutoff_reports r
     WHERE NOT EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c WHERE c.id = r.cutoff_id))     AS orphan_reports,
  (SELECT count(*) FROM public.inventory_cutoff_audit_events a
     WHERE NOT EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c WHERE c.id = a.cutoff_id))     AS orphan_audit_events,
  (SELECT count(*) FROM public.inventory_cutoff_posting_context p
     WHERE NOT EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c WHERE c.id = p.cutoff_id))     AS orphan_posting_context,
  (SELECT count(*) FROM public.inventory_opening_cutoffs c
     WHERE NOT EXISTS (SELECT 1 FROM public.stock_count_sessions s WHERE s.id = c.stock_count_session_id)) AS cutoffs_without_session;

-- C4. Posted history must be exactly as before the cleanup.
SELECT
  'C4. POSTED HISTORY INTACT' AS section,
  (SELECT count(*) FROM public.inventory_opening_cutoffs WHERE status = 'posted')                 AS posted_cutoffs,
  (SELECT count(*) FROM public.inventory_cutoff_reports WHERE report_kind = 'posted')             AS posted_reports,
  (SELECT count(*) FROM public.stock_count_sessions WHERE status = 'posted')                      AS posted_sessions,
  (SELECT count(*) FROM public.stock_movements WHERE reason = 'inventory_opening_balance_cutoff') AS opening_balance_movements,
  'Compare against the values recorded before PHASE B.' AS note;

DO $phase_c_end$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.inventory_opening_cutoffs WHERE status = 'counting';
  RAISE NOTICE '=========================================================';
  IF v_n = 0 THEN
    RAISE NOTICE 'PASS - no cut-off is counting. Warehouse freeze released.';
    RAISE NOTICE 'Now rerun 01_preflight_read_only.sql. Expect:';
    RAISE NOTICE '  FAIL_COUNT = 0, REVIEW_REQUIRED_COUNT = 0, OVERALL_STATUS = PASS';
    RAISE NOTICE 'Then proceed with 02 -> 03 -> 04 -> 05 -> 06 -> 07.';
  ELSE
    RAISE NOTICE 'FAIL - % cut-off(s) still counting. Do NOT run 02-07 yet.', v_n;
  END IF;
  RAISE NOTICE '=========================================================';
END
$phase_c_end$;

COMMIT;
SET default_transaction_read_only = off;
