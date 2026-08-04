-- =============================================================================
-- FILE         : 00_cleanup_orphan_counting_cutoff.sql
-- PURPOSE      : Inspect and — only when proven safe — release ONE stranded
--                Opening Balance cut-off that is still status = 'counting'.
-- WHEN TO RUN  : Before 02-07, when 01_preflight_read_only.sql reports
--                  FAIL_COUNT = 0
--                  REVIEW_REQUIRED_COUNT = 1
--                  H. HISTORICAL RESIDUE -> "counting: 1"
-- SCHEMA REQ   : Runs against the CURRENT production schema. Requires ONLY the
--                20260726 cut-off foundation (already installed in production).
--                It does NOT require 02-07. Tables introduced by 02 are probed
--                with to_regclass() and skipped when absent.
-- SAFETY       : PHASE A and PHASE C are READ ONLY transactions - the engine
--                itself rejects writes. PHASE B ends in ROLLBACK by default and
--                refuses to act until you paste a real cut-off UUID.
-- NEVER TOUCHES: product_inventory, genuine stock_movements, orders, order_items,
--                warehouse receipts, QR data, posted Opening Balances, or any
--                other stock count session.
-- =============================================================================
--
-- -----------------------------------------------------------------------------
-- WHY THIS FILE EXISTS  (root cause, verified from the repository)
-- -----------------------------------------------------------------------------
-- The cut-off is almost certainly NOT orphaned. Verified from the schema:
--
--   inventory_opening_cutoffs.stock_count_session_id
--     uuid NOT NULL UNIQUE REFERENCES stock_count_sessions(id)
--     -- 20260726_inventory_opening_balance_cutoff/01_cutoff_foundation.sql:19
--
-- There is NO "ON DELETE" clause, so the foreign key is NO ACTION. PostgreSQL
-- therefore REFUSES to delete a stock_count_sessions row while a cut-off still
-- points at it, and the column is NOT NULL so it can never be nulled out. A
-- cut-off whose parent session row has genuinely vanished is not reachable
-- through any supported path. PHASE A verifies this rather than assuming it.
--
-- What the production "delete draft" button actually does:
--
--   UI  StockAdjustmentView.discardDrafts()
--    -> RPC discard_stock_count_drafts(uuid[])
--    -> RPC archive_stock_count_draft(uuid)
--        (20260719_stock_config_17_discard_stock_count_drafts.sql)
--
-- That production function soft-archives the session (status draft -> archived)
-- and invalidates its verification codes. It NEVER references
-- inventory_opening_cutoffs. The cut-off is left exactly as it was.
--
-- On top of that, production still carries the ORIGINAL discard guard:
--
--   stock_count_discard_posting_started_guard
--     (20260726_inventory_opening_balance_cutoff/04_unified_opening_balance_flow.sql:235)
--
-- which RAISEs 'stock_count_not_discardable_posting_started' when a linked
-- cut-off is in ('counting','posted'). discard_stock_count_drafts() traps that
-- per-id exception and returns it inside "failed": [...] instead of aborting,
-- so the caller receives status='partial' and the row is never archived.
--
-- => Two production states are possible, and only PHASE A can tell them apart:
--
--    STATE 1  session still exists with status = 'draft'
--             The discard was BLOCKED by the guard and reported in "failed".
--             "Manage Drafts" lists sessions filtered by
--             warehouse_organization_id AND status='draft', so the row is
--             invisible whenever a different warehouse is selected.
--
--    STATE 2  session exists with status = 'archived'
--             The session was archived before the cut-off reached 'counting',
--             or through a path that did not fire the guard.
--
--    STATE 3  session row genuinely missing  -> schema says impossible.
--             PHASE A still checks, and refuses to act if it ever happens.
--
-- In STATE 1 and STATE 2 the parent row exists, therefore the OFFICIAL
-- cancellation RPC can operate and PHASE B uses it.
--
-- -----------------------------------------------------------------------------
-- WHY THIS MATTERS RIGHT NOW
-- -----------------------------------------------------------------------------
-- A 'counting' cut-off FREEZES the warehouse. These production triggers make
-- every product_inventory write and every stock_movements insert for that
-- warehouse fail closed while the cut-off is active:
--
--   inventory_cutoff_product_inventory_guard  ON public.product_inventory
--   inventory_cutoff_stock_movement_guard     ON public.stock_movements
--     -> public.inventory_cutoff_assert_not_frozen(warehouse_organization_id)
--        (01_cutoff_foundation.sql:268 comment: "allocation, dispatch,
--         receiving, transfer, repack, returns and manual adjustments fail
--         closed during an active opening count")
--
-- So this is not cosmetic preflight noise: that warehouse is frozen until the
-- cut-off leaves 'counting'.
--
-- -----------------------------------------------------------------------------
-- CANCEL vs DELETE  (recommendation: CANCEL)
-- -----------------------------------------------------------------------------
-- CANCEL is recommended and is what PHASE B does:
--   * public.cancel_inventory_opening_cutoff(uuid, text) already EXISTS in
--     production (01_cutoff_foundation.sql:239). It is the official lifecycle.
--   * The table CHECK explicitly allows the cancelled shape:
--       (status='cancelled' AND cancelled_at IS NOT NULL AND posted_at IS NULL)
--   * The partial unique index inventory_opening_cutoffs_one_active_warehouse
--     only covers "WHERE status='counting'", so cancelling frees the warehouse
--     slot for a clean retry.
--   * It writes an inventory_cutoff_audit_events row -> full audit trail kept.
--   * 01_preflight_read_only.sql counts ONLY status='counting', so the
--     REVIEW_REQUIRED clears.
--
-- DELETE is what the FIXED application code does, and is deliberately NOT used
-- here. archive_stock_count_draft() v2
-- (20260801120000_inventory_cutoff_pre_otp_draft_discard.sql, shipped inside
-- 04_functions_and_triggers.sql) physically deletes a pre-OTP counting cut-off
-- and its draft-owned dependents. That is correct as a forward code path, but
-- for a one-off production repair, cancellation is strictly safer: it is
-- non-destructive, leaves evidence, and satisfies every existing constraint.
--
-- =============================================================================


-- #############################################################################
-- ## PHASE A - READ-ONLY INSPECTION                                          ##
-- ## Run this ALONE first. Review every result set before touching PHASE B.  ##
-- #############################################################################

SET default_transaction_read_only = on;
BEGIN READ ONLY;

-- -----------------------------------------------------------------------------
-- A1. Every Opening Balance cut-off not in a terminal state, with its parent.
-- -----------------------------------------------------------------------------
SELECT
  'A1. IN-PROGRESS CUT-OFFS'                      AS section,
  c.id                                            AS cutoff_id,
  c.status                                        AS cutoff_status,
  c.stock_count_session_id                        AS session_id,
  c.warehouse_organization_id,
  wh.organization_name                            AS warehouse_name,
  c.company_id,
  c.proposed_cutoff_at,
  c.started_at,
  c.started_by,
  su.full_name                                    AS started_by_name,
  c.posted_at,
  c.posted_by,
  c.cancelled_at,
  c.cancelled_by,
  c.created_at,
  c.updated_at,
  (s.id IS NOT NULL)                              AS parent_session_exists,
  s.status                                        AS session_status,
  s.count_type                                    AS session_count_type,
  s.reference_name                                AS session_reference,
  s.count_date                                    AS session_count_date,
  s.product_category_id                           AS session_product_category_id,
  s.posted_at                                     AS session_posted_at,
  s.archived_at                                   AS session_archived_at,
  s.archived_by                                   AS session_archived_by,
  s.created_by                                    AS session_created_by,
  s.updated_by                                    AS session_updated_by
FROM public.inventory_opening_cutoffs c
LEFT JOIN public.stock_count_sessions s ON s.id = c.stock_count_session_id
LEFT JOIN public.organizations wh       ON wh.id = c.warehouse_organization_id
LEFT JOIN public.users su               ON su.id = c.started_by
WHERE c.status = 'counting'
ORDER BY c.started_at;

-- -----------------------------------------------------------------------------
-- A2. Dependent row counts, per in-progress cut-off. Tables guaranteed present
--     in production (installed by the 20260726 foundation).
-- -----------------------------------------------------------------------------
SELECT
  'A2. DEPENDENTS (CORE)'                                       AS section,
  c.id                                                          AS cutoff_id,
  (SELECT count(*) FROM public.inventory_cutoff_decisions      d WHERE d.cutoff_id = c.id) AS decisions,
  (SELECT count(*) FROM public.inventory_cutoff_reports        r WHERE r.cutoff_id = c.id) AS reports,
  (SELECT count(*) FROM public.inventory_cutoff_audit_events   a WHERE a.cutoff_id = c.id) AS audit_events,
  (SELECT count(*) FROM public.inventory_cutoff_posting_context p WHERE p.cutoff_id = c.id) AS posting_context,
  (SELECT count(*) FROM public.stock_count_session_items       i WHERE i.session_id = c.stock_count_session_id) AS session_items,
  (SELECT count(*) FROM public.stock_count_session_scope       sc WHERE sc.session_id = c.stock_count_session_id) AS session_scope,
  (SELECT count(*) FROM public.stock_count_verification_requests v WHERE v.session_id = c.stock_count_session_id) AS verification_requests_total,
  (SELECT count(*) FROM public.stock_count_verification_requests v
     WHERE v.session_id = c.stock_count_session_id
       AND v.status IN ('pending_delivery','active','verified','posted'))                   AS verification_requests_blocking,
  (SELECT count(*) FROM public.stock_movements m WHERE m.reference_id = c.stock_count_session_id) AS movements_referencing_session
FROM public.inventory_opening_cutoffs c
WHERE c.status = 'counting'
ORDER BY c.started_at;

-- -----------------------------------------------------------------------------
-- A3. Audit-event trail and decision detail for the in-progress cut-offs.
-- -----------------------------------------------------------------------------
SELECT
  'A3. AUDIT EVENTS'   AS section,
  a.cutoff_id,
  a.id                 AS audit_event_id,
  a.event_type,
  a.actor_id,
  a.order_id,
  a.order_item_id,
  a.details,
  a.created_at
FROM public.inventory_cutoff_audit_events a
JOIN public.inventory_opening_cutoffs c ON c.id = a.cutoff_id
WHERE c.status = 'counting'
ORDER BY a.cutoff_id, a.created_at;

SELECT
  'A4. DECISIONS'      AS section,
  d.cutoff_id,
  d.id                 AS decision_id,
  d.transaction_kind,
  d.decision,
  d.order_id,
  d.order_item_id,
  d.stock_config_id,
  d.quantity,
  d.decided_by,
  d.decided_at
FROM public.inventory_cutoff_decisions d
JOIN public.inventory_opening_cutoffs c ON c.id = d.cutoff_id
WHERE c.status = 'counting'
ORDER BY d.cutoff_id, d.decided_at;

-- -----------------------------------------------------------------------------
-- A5. Dependent tables introduced by 02_schema_foundation.sql. These do NOT
--     exist on production yet. Probed dynamically so this file never fails on a
--     pre-02 database. Output arrives as NOTICE lines.
-- -----------------------------------------------------------------------------
DO $phase_a5$
DECLARE
  v_tbl   text;
  v_count bigint;
  v_found boolean := false;
BEGIN
  RAISE NOTICE '--- A5. DEPENDENTS INTRODUCED BY 02 (skipped when absent) ---';
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
      RAISE NOTICE '  % : ABSENT (expected before 02 runs)', rpad(v_tbl, 46);
    ELSE
      v_found := true;
      EXECUTE format(
        'SELECT count(*) FROM public.%I t
          WHERE t.cutoff_id IN (SELECT id FROM public.inventory_opening_cutoffs WHERE status = %L)',
        v_tbl, 'counting'
      ) INTO v_count;
      RAISE NOTICE '  % : % row(s) linked to a counting cut-off', rpad(v_tbl, 46), v_count;
    END IF;
  END LOOP;
  IF NOT v_found THEN
    RAISE NOTICE '  => none of the 02 tables exist yet; nothing extra to clean up.';
  END IF;
END
$phase_a5$;

-- -----------------------------------------------------------------------------
-- A6. POSTING EVIDENCE. Every way a genuinely posted Opening Balance leaves a
--     trace, derived from 03_cutoff_atomic_posting.sql:
--       * cutoff.status='posted' + posted_at/posted_by            (line 305-306)
--       * inventory_cutoff_reports.report_kind='posted'           (line 302)
--       * session.status='posted' + posted_at                     (line 290)
--       * stock_movements reference_type='adjustment',
--         reference_id=session_id, reason='inventory_opening_balance_cutoff'
--                                                                 (line 181-193)
--       * stock_movements reference_type='order_config_change',
--         reason='inventory_opening_balance_cutoff'               (line 227-238)
--       * stock_count_verification_requests.status='posted'
--     NOTE: stock_adjustments has NO foreign key to a session (verified: the
--     Opening Balance posting path never inserts one; only the classic count
--     path at 20260715_stock_count_verification_02.sql:241 does). It is reported
--     here for information only, scoped to the warehouse and the cut-off window.
-- -----------------------------------------------------------------------------
SELECT
  'A6. POSTING EVIDENCE'                          AS section,
  c.id                                            AS cutoff_id,
  (c.posted_at IS NOT NULL)                       AS cutoff_has_posted_at,
  (c.posted_by IS NOT NULL)                       AS cutoff_has_posted_by,
  (c.status = 'posted')                           AS cutoff_status_posted,
  (SELECT count(*) FROM public.inventory_cutoff_reports r
     WHERE r.cutoff_id = c.id AND r.report_kind = 'posted')                 AS posted_reports,
  (SELECT count(*) FROM public.stock_count_sessions s
     WHERE s.id = c.stock_count_session_id
       AND (s.status = 'posted' OR s.posted_at IS NOT NULL))                AS posted_sessions,
  (SELECT count(*) FROM public.stock_movements m
     WHERE m.reference_id = c.stock_count_session_id
       AND m.reference_type IN ('adjustment','stock_classification'))       AS movements_from_session,
  (SELECT count(*) FROM public.stock_movements m
     WHERE m.reason = 'inventory_opening_balance_cutoff'
       AND m.created_at >= c.started_at
       AND (m.from_organization_id = c.warehouse_organization_id
            OR m.to_organization_id = c.warehouse_organization_id))         AS movements_tagged_opening_balance,
  (SELECT count(*) FROM public.stock_count_verification_requests v
     WHERE v.session_id = c.stock_count_session_id
       AND v.status IN ('pending_delivery','active','verified','posted'))   AS blocking_verification_requests,
  (SELECT count(*) FROM public.inventory_cutoff_posting_context p
     WHERE p.cutoff_id = c.id)                                              AS posting_context_rows,
  (SELECT count(*) FROM public.stock_adjustments sa
     WHERE sa.organization_id = c.warehouse_organization_id
       AND sa.created_at >= c.started_at)                                   AS warehouse_adjustments_since_start_info_only
FROM public.inventory_opening_cutoffs c
WHERE c.status = 'counting'
ORDER BY c.started_at;

-- -----------------------------------------------------------------------------
-- A7. THE DECISION. One row per in-progress cut-off.
--     SAFE_TO_CANCEL_OR_CLEAN - no posting evidence anywhere, parent row present
--     NOT_SAFE                - real posting evidence exists; do NOT touch it
--     REVIEW_REQUIRED         - ambiguous; a human must look before acting
-- -----------------------------------------------------------------------------
WITH ev AS (
  SELECT
    c.id                                AS cutoff_id,
    c.stock_count_session_id            AS session_id,
    c.warehouse_organization_id,
    c.started_at,
    (s.id IS NOT NULL)                  AS session_exists,
    s.status                            AS session_status,
    s.count_type                        AS session_count_type,
    (c.posted_at IS NOT NULL
      OR c.posted_by IS NOT NULL
      OR c.status = 'posted')           AS cutoff_posted_marker,
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
  'A7. DECISION'          AS section,
  ev.cutoff_id,
  ev.session_id,
  ev.warehouse_organization_id,
  ev.session_exists,
  ev.session_status,
  ev.session_count_type,
  CASE
    WHEN ev.cutoff_posted_marker
      OR ev.posted_reports  > 0
      OR ev.posted_sessions > 0
      OR ev.session_movements > 0
      OR ev.ob_movements    > 0
      OR ev.blocking_otp    > 0
      OR ev.posting_ctx     > 0
      THEN 'NOT_SAFE'
    WHEN NOT ev.session_exists
      THEN 'REVIEW_REQUIRED'
    WHEN ev.session_count_type IS DISTINCT FROM 'opening_balance_cutoff'
      THEN 'REVIEW_REQUIRED'
    WHEN ev.session_status NOT IN ('draft','archived')
      THEN 'REVIEW_REQUIRED'
    ELSE 'SAFE_TO_CANCEL_OR_CLEAN'
  END                     AS decision,
  CASE
    WHEN ev.cutoff_posted_marker  THEN 'Cut-off carries a posted marker (status/posted_at/posted_by). STOP.'
    WHEN ev.posted_reports  > 0   THEN 'A posted inventory_cutoff_reports row exists. STOP.'
    WHEN ev.posted_sessions > 0   THEN 'Parent session is posted. STOP.'
    WHEN ev.session_movements > 0 THEN 'stock_movements reference this session. STOP.'
    WHEN ev.ob_movements    > 0   THEN 'Opening-balance-tagged stock_movements exist for this warehouse since started_at. STOP.'
    WHEN ev.blocking_otp    > 0   THEN 'Final verification (OTP) was requested or posted. STOP.'
    WHEN ev.posting_ctx     > 0   THEN 'A posting context row exists - posting may be in flight. STOP.'
    WHEN NOT ev.session_exists    THEN 'Parent session row missing. Schema says impossible (NOT NULL + NO ACTION FK). Investigate before acting.'
    WHEN ev.session_count_type IS DISTINCT FROM 'opening_balance_cutoff'
                                  THEN 'Parent session count_type is not opening_balance_cutoff. Investigate.'
    WHEN ev.session_status NOT IN ('draft','archived')
                                  THEN 'Parent session is in an unexpected status. Investigate.'
    ELSE 'No posting evidence anywhere; parent session present and discardable. Safe to cancel.'
  END                     AS reason,
  ev.started_at
FROM ev
ORDER BY ev.started_at;

COMMIT;
SET default_transaction_read_only = off;


-- #############################################################################
-- ## PHASE B - SAFE ACTION  (does NOT run on its own)                        ##
-- #############################################################################
--
-- STOP. Do not run PHASE B until ALL of these hold in the PHASE A output:
--
--   [ ] A7 decision                       = SAFE_TO_CANCEL_OR_CLEAN
--   [ ] A7 session_exists                 = true
--   [ ] A7 session_count_type             = opening_balance_cutoff
--   [ ] A6 cutoff_has_posted_at           = false
--   [ ] A6 posted_reports                 = 0
--   [ ] A6 posted_sessions                = 0
--   [ ] A6 movements_from_session         = 0
--   [ ] A6 movements_tagged_opening_balance = 0
--   [ ] A6 blocking_verification_requests = 0
--   [ ] A6 posting_context_rows           = 0
--   [ ] A1 returned EXACTLY ONE row
--
-- Then edit the two placeholders below. PHASE B refuses to act while they are
-- still the all-zero UUID, so running this file end to end changes nothing.
--
--   TARGET_CUTOFF_ID      -> A1.cutoff_id  (paste the exact UUID)
--   ACTING_HQ_ADMIN_ID    -> public.users.id of a real HQ admin, used as the
--                            cancelling actor so the audit trail names a person.
--                            Must satisfy public.inventory_cutoff_is_hq_admin():
--                              organizations.org_type_code = 'HQ'
--                              AND roles.role_level <= 10
--
-- Broad matching is deliberately impossible here: the UPDATE is keyed on the
-- exact primary key AND the exact expected status. There is no
-- "WHERE status = 'counting'" write anywhere in this file.
--
-- The transaction ends with ROLLBACK. Run it once, read the proof output, and
-- only then swap the final ROLLBACK for the COMMIT on the line below it.

BEGIN;

SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '120s';

CREATE TEMP TABLE _cleanup_params ON COMMIT DROP AS
SELECT
  -- >>> PASTE THE CUT-OFF UUID FROM PHASE A / A1 HERE <<<
  '00000000-0000-0000-0000-000000000000'::uuid AS target_cutoff_id,
  -- >>> PASTE THE ACTING HQ ADMIN users.id HERE <<<
  '00000000-0000-0000-0000-000000000000'::uuid AS acting_hq_admin_id,
  -- The only status this script will ever act on.
  'counting'::text                             AS expected_status,
  'Production cleanup: stranded pre-OTP testing Opening Balance cut-off; no posting evidence found (see 00_cleanup_orphan_counting_cutoff.sql PHASE A).'::text
                                               AS cancellation_reason;

CREATE TEMP TABLE _cleanup_log (
  seq         serial,
  step        text,
  detail      text,
  rows_affected bigint
) ON COMMIT DROP;

DO $phase_b$
DECLARE
  p                    record;
  v_cutoff             public.inventory_opening_cutoffs%ROWTYPE;
  v_session            public.stock_count_sessions%ROWTYPE;
  v_match_count        integer;
  v_bad                integer;
  v_rows               bigint;
  v_used_official_rpc  boolean := false;
  -- untouched-proof fingerprints
  v_pi_count_before    bigint; v_pi_hash_before text;
  v_pi_count_after     bigint; v_pi_hash_after  text;
  v_sm_count_before    bigint; v_sm_hash_before text;
  v_sm_count_after     bigint; v_sm_hash_after  text;
BEGIN
  SELECT * INTO p FROM _cleanup_params;

  -- ---------------------------------------------------------------------------
  -- GUARD 0. Placeholders must have been replaced.
  -- ---------------------------------------------------------------------------
  IF p.target_cutoff_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION
      'PHASE B not armed: paste the real cut-off UUID from PHASE A into _cleanup_params.target_cutoff_id first.';
  END IF;
  IF p.acting_hq_admin_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION
      'PHASE B not armed: paste a real HQ admin users.id into _cleanup_params.acting_hq_admin_id first.';
  END IF;

  -- ---------------------------------------------------------------------------
  -- GUARD 1. Exactly one target, matched by primary key AND expected status.
  --          Fail closed on 0 or >1.
  -- ---------------------------------------------------------------------------
  SELECT count(*) INTO v_match_count
  FROM public.inventory_opening_cutoffs
  WHERE id = p.target_cutoff_id
    AND status = p.expected_status;

  IF v_match_count <> 1 THEN
    RAISE EXCEPTION
      'Refusing to act: expected exactly 1 cut-off with id=% and status=%, found %.',
      p.target_cutoff_id, p.expected_status, v_match_count;
  END IF;

  -- Lock the exact row for the rest of the transaction.
  SELECT * INTO v_cutoff
  FROM public.inventory_opening_cutoffs
  WHERE id = p.target_cutoff_id
    AND status = p.expected_status
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Refusing to act: target cut-off vanished between check and lock.';
  END IF;

  -- ---------------------------------------------------------------------------
  -- GUARD 2. The cut-off must carry no completion marker.
  -- ---------------------------------------------------------------------------
  IF v_cutoff.posted_at IS NOT NULL OR v_cutoff.posted_by IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to act: cut-off % carries a posted marker (posted_at=%, posted_by=%).',
      v_cutoff.id, v_cutoff.posted_at, v_cutoff.posted_by;
  END IF;
  IF v_cutoff.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to act: cut-off % is already cancelled at %.',
      v_cutoff.id, v_cutoff.cancelled_at;
  END IF;

  -- ---------------------------------------------------------------------------
  -- GUARD 3. Parent session must exist, be an Opening Balance session, and be
  --          unposted. Lock it too, since we may archive it.
  -- ---------------------------------------------------------------------------
  SELECT * INTO v_session
  FROM public.stock_count_sessions
  WHERE id = v_cutoff.stock_count_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Refusing to act: parent session % is missing. The NOT NULL + NO ACTION foreign key makes this impossible through supported paths - investigate manually.',
      v_cutoff.stock_count_session_id;
  END IF;
  IF v_session.count_type IS DISTINCT FROM 'opening_balance_cutoff' THEN
    RAISE EXCEPTION 'Refusing to act: parent session % has count_type=%, expected opening_balance_cutoff.',
      v_session.id, v_session.count_type;
  END IF;
  IF v_session.status = 'posted' OR v_session.posted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to act: parent session % is posted.', v_session.id;
  END IF;
  IF v_session.status NOT IN ('draft','archived') THEN
    RAISE EXCEPTION 'Refusing to act: parent session % has unexpected status %.',
      v_session.id, v_session.status;
  END IF;
  IF v_session.warehouse_organization_id IS DISTINCT FROM v_cutoff.warehouse_organization_id THEN
    RAISE EXCEPTION
      'Refusing to act: warehouse mismatch. cut-off warehouse=%, session warehouse=%.',
      v_cutoff.warehouse_organization_id, v_session.warehouse_organization_id;
  END IF;

  -- ---------------------------------------------------------------------------
  -- GUARD 4. No posting evidence of any kind.
  -- ---------------------------------------------------------------------------
  SELECT count(*) INTO v_bad FROM public.inventory_cutoff_reports
   WHERE cutoff_id = v_cutoff.id;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Refusing to act: % inventory_cutoff_reports row(s) exist for this cut-off.', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM public.inventory_cutoff_posting_context
   WHERE cutoff_id = v_cutoff.id;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Refusing to act: % posting-context row(s) exist - a posting may be in flight.', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM public.stock_count_verification_requests
   WHERE session_id = v_session.id
     AND status IN ('pending_delivery','active','verified','posted');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Refusing to act: % verification request(s) show final posting was started.', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM public.stock_movements
   WHERE reference_id = v_session.id;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Refusing to act: % stock_movements reference this session.', v_bad;
  END IF;

  SELECT count(*) INTO v_bad FROM public.stock_movements
   WHERE reason = 'inventory_opening_balance_cutoff'
     AND created_at >= v_cutoff.started_at
     AND (from_organization_id = v_cutoff.warehouse_organization_id
          OR to_organization_id = v_cutoff.warehouse_organization_id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'Refusing to act: % opening-balance-tagged stock_movements exist for this warehouse since started_at.', v_bad;
  END IF;

  -- ---------------------------------------------------------------------------
  -- GUARD 5. The acting user must really be an HQ admin. Mirrors
  --          public.inventory_cutoff_is_hq_admin() exactly.
  -- ---------------------------------------------------------------------------
  SELECT count(*) INTO v_bad
  FROM public.users u
  JOIN public.roles r         ON r.role_code = u.role_code
  JOIN public.organizations o ON o.id = u.organization_id
  WHERE u.id = p.acting_hq_admin_id
    AND o.org_type_code = 'HQ'
    AND r.role_level <= 10;
  IF v_bad <> 1 THEN
    RAISE EXCEPTION
      'Refusing to act: acting_hq_admin_id % is not a valid HQ admin (org_type_code=HQ AND role_level<=10).',
      p.acting_hq_admin_id;
  END IF;

  -- ---------------------------------------------------------------------------
  -- Fingerprint inventory + movements BEFORE, so we can prove they are untouched.
  -- ---------------------------------------------------------------------------
  SELECT count(*), md5(coalesce(string_agg(sig, '|' ORDER BY sig), ''))
    INTO v_pi_count_before, v_pi_hash_before
  FROM (
    SELECT pi.id::text || ':' || coalesce(pi.quantity_on_hand, -1)::text
             || ':' || coalesce(pi.quantity_allocated, -1)::text
             || ':' || coalesce(pi.updated_at::text, '') AS sig
    FROM public.product_inventory pi
    WHERE pi.organization_id = v_cutoff.warehouse_organization_id
  ) q;

  SELECT count(*), md5(coalesce(string_agg(sig, '|' ORDER BY sig), ''))
    INTO v_sm_count_before, v_sm_hash_before
  FROM (
    SELECT m.id::text AS sig
    FROM public.stock_movements m
    WHERE m.from_organization_id = v_cutoff.warehouse_organization_id
       OR m.to_organization_id   = v_cutoff.warehouse_organization_id
  ) q;

  INSERT INTO _cleanup_log(step, detail, rows_affected) VALUES
    ('00 target', format('cutoff=%s session=%s warehouse=%s session_status=%s',
                         v_cutoff.id, v_session.id,
                         v_cutoff.warehouse_organization_id, v_session.status), 1);

  -- ---------------------------------------------------------------------------
  -- ACTION. Preferred: the official production RPC. It sets status/cancelled_by/
  -- cancelled_at and writes the official audit event. It needs auth.uid(), so we
  -- supply the acting HQ admin through the standard PostgREST claims GUC, scoped
  -- to this transaction only (set_config(..., is_local => true)).
  -- ---------------------------------------------------------------------------
  IF to_regprocedure('public.cancel_inventory_opening_cutoff(uuid, text)') IS NOT NULL THEN
    PERFORM set_config(
      'request.jwt.claims',
      json_build_object('sub', p.acting_hq_admin_id::text, 'role', 'authenticated')::text,
      true
    );

    PERFORM public.cancel_inventory_opening_cutoff(p.target_cutoff_id, p.cancellation_reason);
    v_used_official_rpc := true;

    INSERT INTO _cleanup_log(step, detail, rows_affected) VALUES
      ('10 cancel', 'official RPC public.cancel_inventory_opening_cutoff(uuid,text)', 1);
  ELSE
    -- Fallback only if the official function is absent. Reproduces its exact
    -- effect: same columns, same audit event. Keyed on the exact id AND status.
    UPDATE public.inventory_opening_cutoffs
       SET status       = 'cancelled',
           cancelled_by = p.acting_hq_admin_id,
           cancelled_at = now(),
           updated_at   = now()
     WHERE id = p.target_cutoff_id
       AND status = p.expected_status;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Refusing to continue: cancel UPDATE affected % row(s), expected exactly 1.', v_rows;
    END IF;

    INSERT INTO public.inventory_cutoff_audit_events(cutoff_id, event_type, actor_id, details)
    VALUES (
      p.target_cutoff_id,
      'warehouse_freeze_cancelled',
      p.acting_hq_admin_id,
      jsonb_build_object(
        'reason', p.cancellation_reason,
        'stock_count_session_id', v_session.id,
        'source', '00_cleanup_orphan_counting_cutoff.sql fallback path'
      )
    );

    INSERT INTO _cleanup_log(step, detail, rows_affected) VALUES
      ('10 cancel', 'fallback UPDATE + audit event (official RPC not installed)', v_rows);
  END IF;

  -- Verify the cancel really landed, whichever path ran.
  SELECT count(*) INTO v_bad
  FROM public.inventory_opening_cutoffs
  WHERE id = p.target_cutoff_id
    AND status = 'cancelled'
    AND cancelled_at IS NOT NULL
    AND posted_at IS NULL;
  IF v_bad <> 1 THEN
    RAISE EXCEPTION 'Refusing to continue: cut-off % is not in the expected cancelled shape.', p.target_cutoff_id;
  END IF;

  -- ---------------------------------------------------------------------------
  -- Release the draft slot. Production's cancel RPC predates
  -- 20260731220000_inventory_cutoff_cancel_archives_draft_session.sql, so it
  -- leaves a 'draft' session behind. Without this, "Continue Existing Draft"
  -- reopens the cancelled cut-off and the one-active-draft index stays occupied.
  -- Ordering matters: the cut-off is already 'cancelled', so
  -- stock_count_discard_posting_started_guard (which blocks only
  -- 'counting'/'posted') now permits draft -> archived.
  -- ---------------------------------------------------------------------------
  IF v_session.status = 'draft' THEN
    UPDATE public.stock_count_sessions
       SET status      = 'archived',
           archived_by = p.acting_hq_admin_id,
           archived_at = now(),
           updated_by  = p.acting_hq_admin_id,
           updated_at  = now()
     WHERE id = v_session.id
       AND status = 'draft'
       AND posted_at IS NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Refusing to continue: session archive affected % row(s), expected exactly 1.', v_rows;
    END IF;
    INSERT INTO _cleanup_log(step, detail, rows_affected) VALUES
      ('20 session', 'stock_count_sessions draft -> archived', v_rows);

    UPDATE public.stock_count_verification_requests
       SET status = 'invalidated', invalidated_at = now()
     WHERE session_id = v_session.id
       AND status IN ('pending_delivery','active');
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    INSERT INTO _cleanup_log(step, detail, rows_affected) VALUES
      ('21 otp', 'open verification requests invalidated', v_rows);
  ELSE
    INSERT INTO _cleanup_log(step, detail, rows_affected) VALUES
      ('20 session', format('session already %s - left untouched', v_session.status), 0);
  END IF;

  -- ---------------------------------------------------------------------------
  -- Prove inventory and movements were not touched.
  -- ---------------------------------------------------------------------------
  SELECT count(*), md5(coalesce(string_agg(sig, '|' ORDER BY sig), ''))
    INTO v_pi_count_after, v_pi_hash_after
  FROM (
    SELECT pi.id::text || ':' || coalesce(pi.quantity_on_hand, -1)::text
             || ':' || coalesce(pi.quantity_allocated, -1)::text
             || ':' || coalesce(pi.updated_at::text, '') AS sig
    FROM public.product_inventory pi
    WHERE pi.organization_id = v_cutoff.warehouse_organization_id
  ) q;

  SELECT count(*), md5(coalesce(string_agg(sig, '|' ORDER BY sig), ''))
    INTO v_sm_count_after, v_sm_hash_after
  FROM (
    SELECT m.id::text AS sig
    FROM public.stock_movements m
    WHERE m.from_organization_id = v_cutoff.warehouse_organization_id
       OR m.to_organization_id   = v_cutoff.warehouse_organization_id
  ) q;

  IF v_pi_count_before <> v_pi_count_after OR v_pi_hash_before IS DISTINCT FROM v_pi_hash_after THEN
    RAISE EXCEPTION 'ABORT: product_inventory changed (% -> % rows, hash % -> %). Rolling back.',
      v_pi_count_before, v_pi_count_after, v_pi_hash_before, v_pi_hash_after;
  END IF;
  IF v_sm_count_before <> v_sm_count_after OR v_sm_hash_before IS DISTINCT FROM v_sm_hash_after THEN
    RAISE EXCEPTION 'ABORT: stock_movements changed (% -> % rows, hash % -> %). Rolling back.',
      v_sm_count_before, v_sm_count_after, v_sm_hash_before, v_sm_hash_after;
  END IF;

  INSERT INTO _cleanup_log(step, detail, rows_affected) VALUES
    ('90 proof', format('product_inventory UNCHANGED (%s rows, md5 %s)', v_pi_count_after, v_pi_hash_after), 0),
    ('91 proof', format('stock_movements UNCHANGED (%s rows, md5 %s)', v_sm_count_after, v_sm_hash_after), 0),
    ('99 path',  format('official_rpc_used=%s', v_used_official_rpc), 0);

  RAISE NOTICE 'PHASE B completed inside the transaction. Review the output, then COMMIT or ROLLBACK.';
END
$phase_b$;

-- ---- PRE-COMMIT PROOF --------------------------------------------------------

SELECT 'B1. ACTION LOG' AS section, seq, step, detail, rows_affected
FROM _cleanup_log ORDER BY seq;

SELECT
  'B2. TARGET ROW AFTER' AS section,
  c.id AS cutoff_id, c.status, c.posted_at, c.cancelled_at, c.cancelled_by, c.updated_at,
  s.id AS session_id, s.status AS session_status, s.archived_at, s.archived_by
FROM public.inventory_opening_cutoffs c
LEFT JOIN public.stock_count_sessions s ON s.id = c.stock_count_session_id
WHERE c.id = (SELECT target_cutoff_id FROM _cleanup_params);

SELECT
  'B3. AUDIT TRAIL' AS section,
  a.id, a.event_type, a.actor_id, a.details, a.created_at
FROM public.inventory_cutoff_audit_events a
WHERE a.cutoff_id = (SELECT target_cutoff_id FROM _cleanup_params)
ORDER BY a.created_at;

SELECT
  'B4. REMAINING COUNTING CUT-OFFS' AS section,
  count(*) AS still_counting
FROM public.inventory_opening_cutoffs
WHERE status = 'counting';

-- ---- FIRST RUN ENDS HERE, DELIBERATELY -------------------------------------
-- Read B1-B4 above. When they are exactly what you expect, comment out this
-- ROLLBACK and uncomment the COMMIT on the following line, then run PHASE B again.

ROLLBACK;
-- COMMIT;


-- #############################################################################
-- ## PHASE C - POST-CLEANUP VERIFICATION (read-only)                         ##
-- ## Run this only AFTER PHASE B has been committed.                         ##
-- #############################################################################

SET default_transaction_read_only = on;
BEGIN READ ONLY;

SELECT
  'C1. TARGET STATE' AS section,
  c.id AS cutoff_id,
  c.status,
  c.cancelled_at,
  c.cancelled_by,
  c.posted_at,
  s.id AS session_id,
  s.status AS session_status,
  s.archived_at,
  CASE
    WHEN c.status = 'cancelled' AND c.cancelled_at IS NOT NULL AND c.posted_at IS NULL
      THEN 'PASS - cancelled cleanly, no posted marker'
    ELSE 'FAIL - unexpected state'
  END AS verdict
FROM public.inventory_opening_cutoffs c
LEFT JOIN public.stock_count_sessions s ON s.id = c.stock_count_session_id
WHERE c.status <> 'posted'
ORDER BY c.updated_at DESC;

SELECT
  'C2. NO ACTIVE CUT-OFFS' AS section,
  count(*) FILTER (WHERE status = 'counting')  AS counting,
  count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
  count(*) FILTER (WHERE status = 'posted')    AS posted,
  CASE WHEN count(*) FILTER (WHERE status = 'counting') = 0
       THEN 'PASS - no warehouse is frozen'
       ELSE 'FAIL - a cut-off is still counting' END AS verdict
FROM public.inventory_opening_cutoffs;

-- Orphan sweep: any dependent row pointing at a cut-off that no longer exists.
-- All FKs are RESTRICT/CASCADE, so this must be zero.
SELECT
  'C3. ORPHANED CHILDREN' AS section,
  (SELECT count(*) FROM public.inventory_cutoff_decisions d
     WHERE NOT EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c WHERE c.id = d.cutoff_id))    AS orphan_decisions,
  (SELECT count(*) FROM public.inventory_cutoff_reports r
     WHERE NOT EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c WHERE c.id = r.cutoff_id))    AS orphan_reports,
  (SELECT count(*) FROM public.inventory_cutoff_audit_events a
     WHERE NOT EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c WHERE c.id = a.cutoff_id))    AS orphan_audit_events,
  (SELECT count(*) FROM public.inventory_cutoff_posting_context p
     WHERE NOT EXISTS (SELECT 1 FROM public.inventory_opening_cutoffs c WHERE c.id = p.cutoff_id))    AS orphan_posting_context,
  (SELECT count(*) FROM public.inventory_opening_cutoffs c
     WHERE NOT EXISTS (SELECT 1 FROM public.stock_count_sessions s WHERE s.id = c.stock_count_session_id)) AS cutoffs_without_session;

SELECT
  'C4. POSTED HISTORY INTACT' AS section,
  (SELECT count(*) FROM public.inventory_opening_cutoffs WHERE status = 'posted')                     AS posted_cutoffs,
  (SELECT count(*) FROM public.inventory_cutoff_reports WHERE report_kind = 'posted')                 AS posted_reports,
  (SELECT count(*) FROM public.stock_count_sessions WHERE status = 'posted')                          AS posted_sessions,
  (SELECT count(*) FROM public.stock_movements WHERE reason = 'inventory_opening_balance_cutoff')     AS opening_balance_movements,
  'These must match the values you recorded before PHASE B.' AS note;

COMMIT;
SET default_transaction_read_only = off;

-- =============================================================================
-- FINALLY: rerun 01_preflight_read_only.sql
--
--   Expected:
--     FAIL_COUNT            = 0
--     REVIEW_REQUIRED_COUNT = 0
--     OVERALL_STATUS        = PASS
--
-- Only then proceed with 02 -> 03 -> 04 -> 05 -> 06 -> 07.
-- =============================================================================
