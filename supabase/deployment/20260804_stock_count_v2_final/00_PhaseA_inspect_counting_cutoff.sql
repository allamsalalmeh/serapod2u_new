-- =============================================================================
-- FILE      : 00_PhaseA_inspect_counting_cutoff.sql
-- PURPOSE   : READ-ONLY inspection of every Opening Balance cut-off still stuck
--             in status 'counting'. Decides whether it is safe to cancel.
-- RUN       : As-is. Nothing to edit. Safe to run any time, including production.
-- SAFETY    : Whole file is one BEGIN READ ONLY transaction - the engine itself
--             rejects any write. Touches no data.
-- NEXT      : Read section A7. Only if it says SAFE_TO_CANCEL_OR_CLEAN do you go
--             on to 00_PhaseB_cancel_counting_cutoff.sql.
--
-- Column names verified against supabase/schemas/current_schema.sql
-- (production dump, 2026-08-01). Note organizations uses org_name, not
-- organization_name.
--
-- Tables that may or may not exist yet are probed with to_regclass(), so this
-- file runs on the current production schema and after 02 alike.
-- =============================================================================

SET default_transaction_read_only = on;
BEGIN READ ONLY;

-- -----------------------------------------------------------------------------
-- A1. The cut-off(s), with the parent Stock Count session.
-- -----------------------------------------------------------------------------
SELECT
  'A1. IN-PROGRESS CUT-OFFS'        AS section,
  c.id                              AS cutoff_id,
  c.status                          AS cutoff_status,
  c.stock_count_session_id          AS session_id,
  c.warehouse_organization_id,
  wh.org_name                       AS warehouse_name,
  c.company_id,
  co.org_name                       AS company_name,
  c.product_category_id             AS cutoff_product_category_id,
  c.proposed_cutoff_at,
  c.started_at,
  c.started_by,
  su.full_name                      AS started_by_name,
  c.posted_at,
  c.posted_by,
  c.cancelled_at,
  c.cancelled_by,
  c.created_at,
  c.updated_at,
  (s.id IS NOT NULL)                AS parent_session_exists,
  s.status                          AS session_status,
  s.count_type                      AS session_count_type,
  s.reference_name                  AS session_reference,
  s.count_date                      AS session_count_date,
  s.product_category_id             AS session_product_category_id,
  s.posted_at                       AS session_posted_at,
  s.archived_at                     AS session_archived_at,
  s.archived_by                     AS session_archived_by,
  s.created_by                      AS session_created_by,
  s.updated_by                      AS session_updated_by
FROM public.inventory_opening_cutoffs c
LEFT JOIN public.stock_count_sessions s ON s.id = c.stock_count_session_id
LEFT JOIN public.organizations wh       ON wh.id = c.warehouse_organization_id
LEFT JOIN public.organizations co       ON co.id = c.company_id
LEFT JOIN public.users su               ON su.id = c.started_by
WHERE c.status = 'counting'
ORDER BY c.started_at;

-- -----------------------------------------------------------------------------
-- A2. Dependent row counts (tables guaranteed present since the 20260726 pack).
-- -----------------------------------------------------------------------------
SELECT
  'A2. DEPENDENTS (CORE)'  AS section,
  c.id                     AS cutoff_id,
  (SELECT count(*) FROM public.inventory_cutoff_decisions       d  WHERE d.cutoff_id  = c.id) AS decisions,
  (SELECT count(*) FROM public.inventory_cutoff_reports         r  WHERE r.cutoff_id  = c.id) AS reports,
  (SELECT count(*) FROM public.inventory_cutoff_audit_events    a  WHERE a.cutoff_id  = c.id) AS audit_events,
  (SELECT count(*) FROM public.inventory_cutoff_posting_context p  WHERE p.cutoff_id  = c.id) AS posting_context,
  (SELECT count(*) FROM public.stock_count_session_items        i  WHERE i.session_id = c.stock_count_session_id) AS session_items,
  (SELECT count(*) FROM public.stock_count_session_scope        sc WHERE sc.session_id = c.stock_count_session_id) AS session_scope,
  (SELECT count(*) FROM public.stock_count_verification_requests v WHERE v.session_id = c.stock_count_session_id) AS otp_requests_total,
  (SELECT count(*) FROM public.stock_count_verification_requests v
     WHERE v.session_id = c.stock_count_session_id
       AND v.status IN ('pending_delivery','active','verified','posted'))                     AS otp_requests_blocking,
  (SELECT count(*) FROM public.stock_movements m WHERE m.reference_id = c.stock_count_session_id) AS movements_on_session
FROM public.inventory_opening_cutoffs c
WHERE c.status = 'counting'
ORDER BY c.started_at;

-- -----------------------------------------------------------------------------
-- A3. Audit trail.
-- -----------------------------------------------------------------------------
SELECT
  'A3. AUDIT EVENTS' AS section,
  a.cutoff_id, a.id AS audit_event_id, a.event_type, a.actor_id,
  a.order_id, a.order_item_id, a.details, a.created_at
FROM public.inventory_cutoff_audit_events a
JOIN public.inventory_opening_cutoffs c ON c.id = a.cutoff_id
WHERE c.status = 'counting'
ORDER BY a.cutoff_id, a.created_at;

-- -----------------------------------------------------------------------------
-- A4. Saved decisions.
-- -----------------------------------------------------------------------------
SELECT
  'A4. DECISIONS' AS section,
  d.cutoff_id, d.id AS decision_id, d.transaction_kind, d.decision,
  d.order_id, d.order_item_id, d.stock_config_id, d.quantity, d.decided_by, d.decided_at
FROM public.inventory_cutoff_decisions d
JOIN public.inventory_opening_cutoffs c ON c.id = d.cutoff_id
WHERE c.status = 'counting'
ORDER BY d.cutoff_id, d.decided_at;

-- -----------------------------------------------------------------------------
-- A5. Optional dependents. Probed dynamically so a missing table is reported,
--     never an error. Output arrives as NOTICE lines.
-- -----------------------------------------------------------------------------
DO $phase_a5$
DECLARE
  v_tbl text; v_count bigint; v_any boolean := false;
BEGIN
  RAISE NOTICE '--- A5. OPTIONAL DEPENDENTS linked to a counting cut-off ---';
  FOREACH v_tbl IN ARRAY ARRAY[
    'inventory_cutoff_d2h_policies',
    'inventory_cutoff_d2h_policy_requests',
    'inventory_cutoff_h2m_policies',
    'inventory_cutoff_h2m_policy_requests',
    'inventory_cutoff_h2m_bulk_requests',
    'inventory_cutoff_transactions_policies',
    'inventory_cutoff_transactions_policy_requests',
    'inventory_cutoff_excluded_transactions',
    'inventory_cutoff_allocation_requests'
  ] LOOP
    IF to_regclass('public.' || v_tbl) IS NULL THEN
      RAISE NOTICE '  % : table absent on this database', rpad(v_tbl, 46);
    ELSE
      EXECUTE format(
        'SELECT count(*) FROM public.%I t
          WHERE t.cutoff_id IN (SELECT id FROM public.inventory_opening_cutoffs WHERE status = %L)',
        v_tbl, 'counting') INTO v_count;
      RAISE NOTICE '  % : % row(s)', rpad(v_tbl, 46), v_count;
      IF v_count > 0 THEN v_any := true; END IF;
    END IF;
  END LOOP;
  IF v_any THEN
    RAISE NOTICE '  NOTE: rows above are draft-owned policy//preview residue. PHASE B leaves';
    RAISE NOTICE '        them attached to the cancelled cut-off as history (no deletion).';
  END IF;
END
$phase_a5$;

-- -----------------------------------------------------------------------------
-- A6. POSTING EVIDENCE. Every trace a genuinely posted Opening Balance leaves,
--     taken from 20260726/03_cutoff_atomic_posting.sql:
--       cutoff.status='posted' + posted_at/posted_by      (line 305-306)
--       inventory_cutoff_reports.report_kind='posted'     (line 302)
--       session.status='posted' + posted_at               (line 290)
--       stock_movements reference_id=session_id,
--         reason='inventory_opening_balance_cutoff'       (line 181-193, 227-238)
--       stock_count_verification_requests.status='posted'
--     stock_adjustments has no FK to a session (the Opening Balance path never
--     inserts one), so it is shown for information only.
-- -----------------------------------------------------------------------------
SELECT
  'A6. POSTING EVIDENCE'      AS section,
  c.id                        AS cutoff_id,
  (c.posted_at IS NOT NULL)   AS cutoff_has_posted_at,
  (c.posted_by IS NOT NULL)   AS cutoff_has_posted_by,
  (c.status = 'posted')       AS cutoff_status_posted,
  (SELECT count(*) FROM public.inventory_cutoff_reports r
     WHERE r.cutoff_id = c.id AND r.report_kind = 'posted')               AS posted_reports,
  (SELECT count(*) FROM public.stock_count_sessions s
     WHERE s.id = c.stock_count_session_id
       AND (s.status = 'posted' OR s.posted_at IS NOT NULL))              AS posted_sessions,
  (SELECT count(*) FROM public.stock_movements m
     WHERE m.reference_id = c.stock_count_session_id)                     AS movements_on_session,
  (SELECT count(*) FROM public.stock_movements m
     WHERE m.reason = 'inventory_opening_balance_cutoff'
       AND m.created_at >= c.started_at
       AND (m.from_organization_id = c.warehouse_organization_id
            OR m.to_organization_id = c.warehouse_organization_id))       AS movements_tagged_opening_balance,
  (SELECT count(*) FROM public.stock_count_verification_requests v
     WHERE v.session_id = c.stock_count_session_id
       AND v.status IN ('pending_delivery','active','verified','posted')) AS blocking_otp_requests,
  (SELECT count(*) FROM public.inventory_cutoff_posting_context p
     WHERE p.cutoff_id = c.id)                                            AS posting_context_rows,
  (SELECT count(*) FROM public.stock_adjustments sa
     WHERE sa.organization_id = c.warehouse_organization_id
       AND sa.created_at >= c.started_at)                                 AS warehouse_adjustments_info_only
FROM public.inventory_opening_cutoffs c
WHERE c.status = 'counting'
ORDER BY c.started_at;

-- -----------------------------------------------------------------------------
-- A7. THE DECISION. Read this one.
-- -----------------------------------------------------------------------------
WITH ev AS (
  SELECT
    c.id AS cutoff_id, c.stock_count_session_id AS session_id,
    c.warehouse_organization_id, c.started_at,
    (s.id IS NOT NULL) AS session_exists, s.status AS session_status,
    s.count_type AS session_count_type,
    (c.posted_at IS NOT NULL OR c.posted_by IS NOT NULL OR c.status = 'posted') AS cutoff_posted_marker,
    (SELECT count(*) FROM public.inventory_cutoff_reports r
       WHERE r.cutoff_id = c.id AND r.report_kind = 'posted')       AS posted_reports,
    (SELECT count(*) FROM public.stock_count_sessions s2
       WHERE s2.id = c.stock_count_session_id
         AND (s2.status = 'posted' OR s2.posted_at IS NOT NULL))    AS posted_sessions,
    (SELECT count(*) FROM public.stock_movements m
       WHERE m.reference_id = c.stock_count_session_id)             AS session_movements,
    (SELECT count(*) FROM public.stock_movements m
       WHERE m.reason = 'inventory_opening_balance_cutoff'
         AND m.created_at >= c.started_at
         AND (m.from_organization_id = c.warehouse_organization_id
              OR m.to_organization_id = c.warehouse_organization_id)) AS ob_movements,
    (SELECT count(*) FROM public.stock_count_verification_requests v
       WHERE v.session_id = c.stock_count_session_id
         AND v.status IN ('pending_delivery','active','verified','posted')) AS blocking_otp,
    (SELECT count(*) FROM public.inventory_cutoff_posting_context p
       WHERE p.cutoff_id = c.id)                                    AS posting_ctx
  FROM public.inventory_opening_cutoffs c
  LEFT JOIN public.stock_count_sessions s ON s.id = c.stock_count_session_id
  WHERE c.status = 'counting'
)
SELECT
  'A7. DECISION'   AS section,
  ev.cutoff_id     AS paste_this_into_phase_b,
  ev.session_id,
  ev.warehouse_organization_id,
  ev.session_exists,
  ev.session_status,
  ev.session_count_type,
  CASE
    WHEN ev.cutoff_posted_marker OR ev.posted_reports > 0 OR ev.posted_sessions > 0
      OR ev.session_movements > 0 OR ev.ob_movements > 0
      OR ev.blocking_otp > 0 OR ev.posting_ctx > 0            THEN 'NOT_SAFE'
    WHEN NOT ev.session_exists                                THEN 'REVIEW_REQUIRED'
    WHEN ev.session_count_type IS DISTINCT FROM 'opening_balance_cutoff' THEN 'REVIEW_REQUIRED'
    WHEN ev.session_status NOT IN ('draft','archived')        THEN 'REVIEW_REQUIRED'
    ELSE 'SAFE_TO_CANCEL_OR_CLEAN'
  END              AS decision,
  CASE
    WHEN ev.cutoff_posted_marker  THEN 'Cut-off carries a posted marker. STOP.'
    WHEN ev.posted_reports  > 0   THEN 'A posted report row exists. STOP.'
    WHEN ev.posted_sessions > 0   THEN 'Parent session is posted. STOP.'
    WHEN ev.session_movements > 0 THEN 'stock_movements reference this session. STOP.'
    WHEN ev.ob_movements    > 0   THEN 'Opening-balance-tagged movements exist for this warehouse. STOP.'
    WHEN ev.blocking_otp    > 0   THEN 'Final verification (OTP) was requested or posted. STOP.'
    WHEN ev.posting_ctx     > 0   THEN 'A posting context row exists - posting may be in flight. STOP.'
    WHEN NOT ev.session_exists    THEN 'Parent session row missing. Schema says impossible. Investigate.'
    WHEN ev.session_count_type IS DISTINCT FROM 'opening_balance_cutoff'
                                  THEN 'Parent session is not an Opening Balance session. Investigate.'
    WHEN ev.session_status NOT IN ('draft','archived')
                                  THEN 'Parent session status unexpected. Investigate.'
    ELSE 'No posting evidence anywhere; parent session present. Safe to cancel.'
  END              AS reason,
  ev.started_at
FROM ev
ORDER BY ev.started_at;

DO $phase_a_end$
DECLARE v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.inventory_opening_cutoffs WHERE status = 'counting';
  RAISE NOTICE '=========================================================';
  IF v_n = 0 THEN
    RAISE NOTICE 'No cut-off is in status counting. Nothing to clean up.';
    RAISE NOTICE 'Rerun 01_preflight_read_only.sql - it should now be PASS.';
  ELSE
    RAISE NOTICE '% cut-off(s) still counting. Read section A7 above.', v_n;
    RAISE NOTICE 'If A7 says SAFE_TO_CANCEL_OR_CLEAN, copy the cutoff_id from';
    RAISE NOTICE 'the paste_this_into_phase_b column into';
    RAISE NOTICE '00_PhaseB_cancel_counting_cutoff.sql.';
  END IF;
  RAISE NOTICE '=========================================================';
END
$phase_a_end$;

COMMIT;
SET default_transaction_read_only = off;
