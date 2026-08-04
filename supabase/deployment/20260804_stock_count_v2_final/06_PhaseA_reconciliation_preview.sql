-- =============================================================================
-- FILE      : 06_PhaseA_reconciliation_preview.sql   [READ-ONLY]
-- PURPOSE   : Show exactly what 06_PhaseB would change, and whether it is safe.
-- RUN       : As-is. Nothing to edit. Works in psql, Supabase Studio, DBeaver,
--             pgAdmin - there are no psql meta-commands anywhere in this file.
-- PREREQ    : 02-05 completed.
-- SAFETY    : One BEGIN READ ONLY transaction. The engine rejects any write.
-- NEXT      : Read section P4. Only if it says SAFE_TO_APPLY do you run
--             06_PhaseB_reconciliation_apply.sql.
--
-- Replaces the psql "\if :reconcile_approved" gate in the old
-- 06_data_reconciliation.sql, which silently stopped protecting the two UPDATEs
-- in any client that does not understand backslash meta-commands.
--
-- The two changes (unchanged in intent from the original file):
--   CHANGE 1  inventory_stock_configurations.status 'active'/'phase_out'
--             -> 'inactive' where the owning product_variant is already
--             archived (is_active = false).
--   CHANGE 2  stock_count_sessions.status 'draft' -> 'archived' for opening
--             balance sessions whose only cut-off is already 'cancelled'.
--
-- Neither touches inventory quantities, stock movements, orders, QR records or
-- posted Opening Balances.
--
-- Column names verified against supabase/schemas/current_schema.sql
-- (production dump, 2026-08-01).
-- =============================================================================

SET default_transaction_read_only = on;
BEGIN READ ONLY;

-- -----------------------------------------------------------------------------
-- P1. ROW COUNTS. These now match the PhaseB UPDATE predicates EXACTLY.
--     (The old file's CHANGE 2 preview omitted the NOT EXISTS guard that the
--     UPDATE actually applies, so it could overcount.)
-- -----------------------------------------------------------------------------
SELECT
  'P1. WHAT WILL CHANGE'          AS section,
  'CHANGE 1 configs_to_deactivate' AS change,
  count(*)                         AS rows_affected
FROM public.inventory_stock_configurations isc
JOIN public.product_variants pv ON pv.id = isc.variant_id
WHERE pv.is_active = false
  AND isc.status IN ('active', 'phase_out')
UNION ALL
SELECT
  'P1. WHAT WILL CHANGE',
  'CHANGE 2 stuck_draft_sessions_to_archive',
  count(*)
FROM public.stock_count_sessions s
WHERE s.status = 'draft'
  AND s.count_type = 'opening_balance_cutoff'
  AND EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
              WHERE c.stock_count_session_id = s.id AND c.status = 'cancelled')
  AND NOT EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
                  WHERE c.stock_count_session_id = s.id
                    AND c.status IN ('counting', 'posted'))
UNION ALL
-- Sessions that look eligible but are deliberately skipped by the UPDATE guard.
SELECT
  'P1. WHAT WILL CHANGE',
  'CHANGE 2 skipped_by_guard (has counting/posted cut-off)',
  count(*)
FROM public.stock_count_sessions s
WHERE s.status = 'draft'
  AND s.count_type = 'opening_balance_cutoff'
  AND EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
              WHERE c.stock_count_session_id = s.id AND c.status = 'cancelled')
  AND EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
              WHERE c.stock_count_session_id = s.id
                AND c.status IN ('counting', 'posted'));

-- -----------------------------------------------------------------------------
-- P2. THE ACTUAL ROWS. Eyeball these, not just the counts.
-- -----------------------------------------------------------------------------
SELECT
  'P2. CHANGE 1 ROWS' AS section,
  isc.id              AS stock_config_id,
  isc.variant_id,
  isc.status          AS current_status,
  'inactive'          AS new_status,
  pv.is_active        AS variant_is_active
FROM public.inventory_stock_configurations isc
JOIN public.product_variants pv ON pv.id = isc.variant_id
WHERE pv.is_active = false
  AND isc.status IN ('active', 'phase_out')
ORDER BY isc.id
LIMIT 200;

SELECT
  'P3. CHANGE 2 ROWS' AS section,
  s.id                AS session_id,
  s.reference_name,
  s.count_date,
  s.warehouse_organization_id,
  wh.org_name         AS warehouse_name,
  s.status            AS current_status,
  'archived'          AS new_status,
  (SELECT c.status FROM public.inventory_opening_cutoffs c
    WHERE c.stock_count_session_id = s.id) AS cutoff_status
FROM public.stock_count_sessions s
LEFT JOIN public.organizations wh ON wh.id = s.warehouse_organization_id
WHERE s.status = 'draft'
  AND s.count_type = 'opening_balance_cutoff'
  AND EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
              WHERE c.stock_count_session_id = s.id AND c.status = 'cancelled')
  AND NOT EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
                  WHERE c.stock_count_session_id = s.id
                    AND c.status IN ('counting', 'posted'))
ORDER BY s.count_date
LIMIT 200;

-- -----------------------------------------------------------------------------
-- P4. AMBIGUITY CHECKS + DECISION.
--     In the original file these were advisory - a human had to notice them.
--     06_PhaseB now REFUSES to run while any of them is non-zero, unless you
--     deliberately set ambiguity_override there.
-- -----------------------------------------------------------------------------
WITH amb AS (
  SELECT
    (SELECT count(*) FROM public.inventory_stock_configurations isc
       JOIN public.product_variants pv ON pv.id = isc.variant_id
      WHERE pv.is_active = false AND isc.status IN ('active','phase_out')
        AND EXISTS (SELECT 1 FROM public.stock_movements m
                    WHERE m.stock_config_id = isc.id))            AS config_has_movements,
    (SELECT count(*) FROM public.inventory_stock_configurations isc
       JOIN public.product_variants pv ON pv.id = isc.variant_id
       JOIN public.product_inventory pi ON pi.stock_config_id = isc.id
      WHERE pv.is_active = false AND isc.status IN ('active','phase_out')
        AND (pi.quantity_on_hand <> 0 OR pi.quantity_allocated <> 0)) AS config_holds_stock,
    (SELECT count(*) FROM (
       SELECT s.id FROM public.stock_count_sessions s
         JOIN public.inventory_opening_cutoffs c ON c.stock_count_session_id = s.id
        WHERE s.status = 'draft' AND s.count_type = 'opening_balance_cutoff'
        GROUP BY s.id
       HAVING count(*) FILTER (WHERE c.status = 'cancelled') > 0
          AND count(*) FILTER (WHERE c.status <> 'cancelled') > 0) z) AS session_mixed_cutoffs,
    (SELECT count(*) FROM public.inventory_stock_configurations isc
       JOIN public.product_variants pv ON pv.id = isc.variant_id
      WHERE pv.is_active = false AND isc.status IN ('active','phase_out'))  AS change1_rows,
    (SELECT count(*) FROM public.stock_count_sessions s
      WHERE s.status = 'draft' AND s.count_type = 'opening_balance_cutoff'
        AND EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
                    WHERE c.stock_count_session_id = s.id AND c.status = 'cancelled')
        AND NOT EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
                        WHERE c.stock_count_session_id = s.id
                          AND c.status IN ('counting','posted')))          AS change2_rows
)
SELECT
  'P4. DECISION'            AS section,
  amb.change1_rows,
  amb.change2_rows,
  amb.config_has_movements  AS ambiguity_config_has_movements,
  amb.config_holds_stock    AS ambiguity_config_holds_stock,
  amb.session_mixed_cutoffs AS ambiguity_session_mixed_cutoffs,
  CASE
    WHEN amb.config_has_movements > 0
      OR amb.config_holds_stock  > 0
      OR amb.session_mixed_cutoffs > 0            THEN 'NOT_SAFE'
    WHEN amb.change1_rows = 0 AND amb.change2_rows = 0 THEN 'NOTHING_TO_DO'
    ELSE 'SAFE_TO_APPLY'
  END                       AS decision,
  CASE
    WHEN amb.config_has_movements > 0
      THEN 'A configuration due for deactivation has stock_movement history. Get manual approval before applying.'
    WHEN amb.config_holds_stock > 0
      THEN 'A configuration due for deactivation still holds non-zero inventory. Get manual approval before applying.'
    WHEN amb.session_mixed_cutoffs > 0
      THEN 'A draft session has both a cancelled and a non-cancelled cut-off. Investigate before applying.'
    WHEN amb.change1_rows = 0 AND amb.change2_rows = 0
      THEN 'Zero qualifying rows. 06_PhaseB would be a no-op - you may skip it.'
    ELSE 'No ambiguities. 06_PhaseB will change exactly the rows counted above.'
  END                       AS reason
FROM amb;

DO $p4$
DECLARE v1 bigint; v2 bigint; a1 bigint; a2 bigint; a3 bigint;
BEGIN
  SELECT count(*) INTO v1 FROM public.inventory_stock_configurations isc
    JOIN public.product_variants pv ON pv.id = isc.variant_id
   WHERE pv.is_active = false AND isc.status IN ('active','phase_out');
  SELECT count(*) INTO v2 FROM public.stock_count_sessions s
   WHERE s.status='draft' AND s.count_type='opening_balance_cutoff'
     AND EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
                 WHERE c.stock_count_session_id=s.id AND c.status='cancelled')
     AND NOT EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
                     WHERE c.stock_count_session_id=s.id AND c.status IN ('counting','posted'));
  SELECT count(*) INTO a1 FROM public.inventory_stock_configurations isc
    JOIN public.product_variants pv ON pv.id = isc.variant_id
   WHERE pv.is_active=false AND isc.status IN ('active','phase_out')
     AND EXISTS (SELECT 1 FROM public.stock_movements m WHERE m.stock_config_id = isc.id);
  SELECT count(*) INTO a2 FROM public.inventory_stock_configurations isc
    JOIN public.product_variants pv ON pv.id = isc.variant_id
    JOIN public.product_inventory pi ON pi.stock_config_id = isc.id
   WHERE pv.is_active=false AND isc.status IN ('active','phase_out')
     AND (pi.quantity_on_hand <> 0 OR pi.quantity_allocated <> 0);
  SELECT count(*) INTO a3 FROM (
    SELECT s.id FROM public.stock_count_sessions s
      JOIN public.inventory_opening_cutoffs c ON c.stock_count_session_id=s.id
     WHERE s.status='draft' AND s.count_type='opening_balance_cutoff'
     GROUP BY s.id
    HAVING count(*) FILTER (WHERE c.status='cancelled') > 0
       AND count(*) FILTER (WHERE c.status<>'cancelled') > 0) z;

  RAISE NOTICE '=========================================================';
  IF a1 > 0 OR a2 > 0 OR a3 > 0 THEN
    RAISE NOTICE 'NOT_SAFE - ambiguities found (% / % / %).', a1, a2, a3;
    RAISE NOTICE 'Do NOT run 06_PhaseB until these are understood.';
  ELSIF v1 = 0 AND v2 = 0 THEN
    RAISE NOTICE 'NOTHING_TO_DO - zero qualifying rows for both changes.';
    RAISE NOTICE '06_PhaseB would be a no-op. Continue to 07.';
  ELSE
    RAISE NOTICE 'SAFE_TO_APPLY - CHANGE 1: % row(s), CHANGE 2: % row(s).', v1, v2;
    RAISE NOTICE 'Review P2/P3 above, then run 06_PhaseB_reconciliation_apply.sql.';
  END IF;
  RAISE NOTICE '=========================================================';
END
$p4$;

COMMIT;
SET default_transaction_read_only = off;
