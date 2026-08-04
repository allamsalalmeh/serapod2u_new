-- =============================================================================
-- 09_operational_smoke_checks_read_only.sql  [READ-ONLY / VERIFICATION ONLY]
-- =============================================================================
-- PURPOSE      : Confirm the system is ready for controlled UI testing.
-- PREREQUISITES: 08_post_deployment_verification.sql returned OVERALL_STATUS=PASS.
-- MUTATES      : NOTHING.
--                * creates no test record          * requests no OTP
--                * posts / cancels no Opening Balance
--                * reserves or releases no stock   * changes no order
-- EXPECTED     : no BLOCKER rows. ATTENTION rows are informational.
-- VERIFY       : read every ATTENTION row before you start clicking in the UI.
-- -----------------------------------------------------------------------------
-- These are OBSERVATIONS of existing state, not exercises of the workflow. The
-- real end-to-end test is a human running a cut-off in the UI afterwards.
-- Runs inside a READ ONLY transaction; the engine rejects accidental writes.
-- =============================================================================

SET default_transaction_read_only = on;
BEGIN READ ONLY;

WITH
-- 1. Can the workflow even be started? ---------------------------------------
prereq AS (
  SELECT '1. PREREQUISITES' AS section, 'active warehouses available' AS check_name,
         count(*)::text AS value,
         CASE WHEN count(*) > 0 THEN 'OK' ELSE 'BLOCKER' END AS verdict,
         'Opening Balance requires at least one active WH organization.' AS note
  FROM public.organizations WHERE org_type_code = 'WH' AND is_active = true
  UNION ALL
  SELECT '1. PREREQUISITES', 'product categories available', count(*)::text,
         CASE WHEN count(*) > 0 THEN 'OK' ELSE 'BLOCKER' END,
         'A cut-off is scoped to one product category.'
  FROM public.product_categories
  UNION ALL
  SELECT '1. PREREQUISITES', 'active stock configurations', count(*)::text,
         CASE WHEN count(*) > 0 THEN 'OK' ELSE 'ATTENTION' END,
         'Nothing to count if there are no active configurations.'
  FROM public.inventory_stock_configurations WHERE status = 'active'
),
-- 2. Is anything mid-flight that a test would collide with? ------------------
inflight AS (
  SELECT '2. IN-FLIGHT WORK' AS section, 'cut-offs currently counting' AS check_name,
         count(*)::text,
         CASE WHEN count(*) = 0 THEN 'OK' ELSE 'ATTENTION' END,
         'A counting cut-off FREEZES its warehouse. Finish or cancel it in the UI '
         'before testing elsewhere in that warehouse.'
  FROM public.inventory_opening_cutoffs WHERE status = 'counting'
  UNION ALL
  SELECT '2. IN-FLIGHT WORK', 'open Opening Balance draft sessions', count(*)::text,
         CASE WHEN count(*) = 0 THEN 'OK' ELSE 'ATTENTION' END,
         'Only ONE active Opening Balance draft is allowed per warehouse+category. '
         'An existing draft forces Continue Existing Draft.'
  FROM public.stock_count_sessions
  WHERE status = 'draft' AND count_type = 'opening_balance_cutoff'
  UNION ALL
  SELECT '2. IN-FLIGHT WORK', 'unconsumed verification (OTP) requests', count(*)::text,
         CASE WHEN count(*) = 0 THEN 'OK' ELSE 'ATTENTION' END,
         'Observation only - this script never requests or consumes an OTP.'
  FROM public.stock_count_verification_requests WHERE status = 'active'
),
-- 3. Known-bad states this release exists to fix -----------------------------
consistency AS (
  -- The exact class of defect 20260731220000 fixed.
  SELECT '3. DATA CONSISTENCY' AS section,
         'draft sessions stuck behind a CANCELLED cut-off' AS check_name,
         count(*)::text,
         CASE WHEN count(*) = 0 THEN 'OK' ELSE 'ATTENTION' END,
         'Should be 0 after 06_data_reconciliation.sql. Non-zero means 06 was skipped.'
  FROM public.stock_count_sessions s
  WHERE s.status = 'draft' AND s.count_type = 'opening_balance_cutoff'
    AND EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c
                WHERE c.stock_count_session_id = s.id AND c.status = 'cancelled')
  UNION ALL
  -- The exact class of defect 20260730_archive_variant... fixed.
  SELECT '3. DATA CONSISTENCY', 'active configurations owned by ARCHIVED variants',
         count(*)::text,
         CASE WHEN count(*) = 0 THEN 'OK' ELSE 'ATTENTION' END,
         'Should be 0 after 06. Non-zero means archived variants can still surface.'
  FROM public.inventory_stock_configurations isc
  JOIN public.product_variants pv ON pv.id = isc.variant_id
  WHERE pv.is_active = false AND isc.status IN ('active','phase_out')
  UNION ALL
  -- The exact residue that caused the "5th Initial" incident.
  SELECT '3. DATA CONSISTENCY', 'allocations owned by CANCELLED/CLOSED orders',
         count(*)::text,
         CASE WHEN count(*) = 0 THEN 'OK' ELSE 'ATTENTION' END,
         'Orphan reservations surface as allocation-reconciliation blockers. Resolve '
         'them in the UI via the allocation resolver - never by direct SQL.'
  FROM public.stock_movements sm
  JOIN public.orders o ON o.id = sm.reference_id
  WHERE sm.movement_type = 'allocation' AND sm.reference_type = 'order'
    AND o.status IN ('cancelled','closed')
    AND NOT EXISTS (SELECT 1 FROM public.stock_movements d
                    WHERE d.reference_id = sm.reference_id AND d.movement_type = 'deallocation')
  UNION ALL
  SELECT '3. DATA CONSISTENCY', 'negative product_inventory balances', count(*)::text,
         CASE WHEN count(*) = 0 THEN 'OK' ELSE 'BLOCKER' END,
         'Negative on-hand or allocated indicates pre-existing corruption. Investigate '
         'BEFORE running an Opening Balance.'
  FROM public.product_inventory
  WHERE quantity_on_hand < 0 OR quantity_allocated < 0
),
-- 4. Contract reachability ---------------------------------------------------
reach AS (
  SELECT '4. RPC REACHABILITY' AS section, v.n AS check_name,
         CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
              WHERE ns.nspname='public' AND p.proname=v.n
                AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
              THEN 'reachable' ELSE 'NOT REACHABLE' END,
         CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
              WHERE ns.nspname='public' AND p.proname=v.n
                AND has_function_privilege('authenticated', p.oid, 'EXECUTE'))
              THEN 'OK' ELSE 'BLOCKER' END,
         'The UI calls this RPC as the authenticated role.'
  -- The full application entry-point set, matching v_entry_points in
  -- 07_final_contract_fixes.sql. archive_stock_count_draft is deliberately
  -- ABSENT: it is internal, reached only via discard_stock_count_drafts.
  FROM (VALUES ('inventory_cutoff_preview'),('start_inventory_opening_cutoff'),
               ('cancel_inventory_opening_cutoff'),('set_inventory_cutoff_decision'),
               ('bind_inventory_cutoff_verification_snapshot'),
               ('verify_and_post_inventory_opening_cutoff'),
               ('release_allocation_for_order'),
               ('resolve_inventory_cutoff_allocation'),
               ('resolve_inventory_cutoff_d2h_carry_forward'),
               ('resolve_inventory_cutoff_h2m_incoming'),
               ('inventory_cutoff_d2h_policy_preflight'),
               ('inventory_cutoff_h2m_policy_preflight'),
               ('inventory_cutoff_transactions_policy_preflight'),
               ('inventory_cutoff_h2m_bulk_preflight'),
               ('apply_inventory_cutoff_d2h_policy'),('apply_inventory_cutoff_h2m_policy'),
               ('apply_inventory_cutoff_transactions_policy'),
               ('apply_inventory_cutoff_h2m_bulk'),
               ('prepare_stock_count_verification'),('discard_stock_count_drafts'),
               ('finalize_stock_count_verification_delivery'),
               ('archive_product_variant')) v(n)
),
-- 4b. anonymous surface -------------------------------------------------------
anonsurface AS (
  SELECT '4b. ANONYMOUS SURFACE' AS section,
         'Stock Count V2 functions callable without authentication' AS check_name,
         count(*)::text AS value,
         CASE WHEN count(*) = 0 THEN 'OK' ELSE 'BLOCKER' END AS verdict,
         'Must be 0 after 07. Any non-zero value means an unauthenticated caller '
         'can reach the Opening Balance surface.' AS note
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND ( p.proname ~ ('(inventory_cutoff|opening_cutoff|archive_stock_count_draft'
                      '|archive_product_variant|release_allocation_for_order'
                      '|enforce_stock_count_reference|stock_count_discard_posting'
                      '|assert_h2m_receipt_allowed_after_cutoff'
                      '|trg_warehouse_receipt_h2m_excluded_guard)')
       OR p.proname IN ('prepare_stock_count_verification','discard_stock_count_drafts',
                        'finalize_stock_count_verification_delivery') )
    AND ( has_function_privilege('anon', p.oid, 'EXECUTE')
       OR has_function_privilege('public', p.oid, 'EXECUTE') )
),
-- 5. PostgREST schema cache --------------------------------------------------
cache AS (
  SELECT '5. API CACHE' AS section, 'PostgREST schema reload' AS check_name,
         'manual step' AS value, 'ATTENTION' AS verdict,
         'The pack issues NOTIFY pgrst. If a new RPC 404s from the app, restart the '
         'PostgREST/Kong container once. This is not a SQL failure.' AS note
),
all_checks AS (
  SELECT * FROM prereq UNION ALL SELECT * FROM inflight UNION ALL SELECT * FROM consistency
  UNION ALL SELECT * FROM reach UNION ALL SELECT * FROM anonsurface UNION ALL SELECT * FROM cache
)
SELECT section, check_name, value, verdict, note FROM all_checks
UNION ALL SELECT 'Z. OVERALL','BLOCKER_COUNT',count(*)::text,'',''
  FROM all_checks WHERE verdict='BLOCKER'
UNION ALL SELECT 'Z. OVERALL','ATTENTION_COUNT',count(*)::text,'',''
  FROM all_checks WHERE verdict='ATTENTION'
UNION ALL SELECT 'Z. OVERALL','READY_FOR_UI_TESTING',
  CASE WHEN EXISTS (SELECT 1 FROM all_checks WHERE verdict='BLOCKER') THEN 'NO' ELSE 'YES' END,
  '',
  CASE WHEN EXISTS (SELECT 1 FROM all_checks WHERE verdict='BLOCKER')
       THEN 'Resolve every BLOCKER first.'
       ELSE 'Proceed to controlled UI testing on STAGING only.' END
ORDER BY 1, 2;

COMMIT;