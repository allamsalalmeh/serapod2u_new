-- =============================================================================
-- FILE      : 00_PhaseB_cancel_counting_cutoff.sql
-- PURPOSE   : Cancel ONE stranded Opening Balance cut-off, releasing the
--             warehouse freeze. Cancels; never physically deletes.
-- RUN AFTER : 00_PhaseA_inspect_counting_cutoff.sql says SAFE_TO_CANCEL_OR_CLEAN.
-- SAFETY    : Ends in ROLLBACK. Run once, read the output, then swap the final
--             ROLLBACK for COMMIT and run again.
-- NEVER     : writes product_inventory, deletes stock_movements, or touches
--             orders, QR data, posted Opening Balances, or other sessions.
--
-- Column names verified against supabase/schemas/current_schema.sql
-- (production dump, 2026-08-01).
-- =============================================================================
--
--                >>>>>  EDIT THE TWO UUIDs BELOW, NOTHING ELSE  <<<<<
--
--   target_cutoff_id    the cutoff_id from PHASE A section A7
--                       (column: paste_this_into_phase_b)
--
--   acting_hq_admin_id  public.users.id of a real HQ admin. Recorded as the
--                       person who cancelled. Must satisfy
--                       public.inventory_cutoff_is_hq_admin():
--                         organizations.org_type_code = 'HQ'
--                         AND roles.role_level <= 10
--
--                       Find one with:
--                         SELECT u.id, u.full_name, u.email
--                         FROM public.users u
--                         JOIN public.roles r ON r.role_code = u.role_code
--                         JOIN public.organizations o ON o.id = u.organization_id
--                         WHERE o.org_type_code = 'HQ' AND r.role_level <= 10
--                           AND u.is_active
--                         ORDER BY r.role_level, u.full_name;
--
-- The script refuses to do anything while these are still the all-zero UUID.
-- =============================================================================

BEGIN;

SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '120s';

CREATE TEMP TABLE _cleanup_params ON COMMIT DROP AS
SELECT
  '00000000-0000-0000-0000-000000000000'::uuid AS target_cutoff_id,     -- <<< PASTE
  '00000000-0000-0000-0000-000000000000'::uuid AS acting_hq_admin_id,   -- <<< PASTE
  'counting'::text                             AS expected_status,
  'Production cleanup: stranded pre-OTP Opening Balance cut-off; no posting evidence (see 00_PhaseA_inspect_counting_cutoff.sql).'::text
                                               AS cancellation_reason;

CREATE TEMP TABLE _cleanup_log (
  seq serial, step text, detail text, rows_affected bigint
) ON COMMIT DROP;

DO $phase_b$
DECLARE
  p                   record;
  v_cutoff            public.inventory_opening_cutoffs%ROWTYPE;
  v_session           public.stock_count_sessions%ROWTYPE;
  v_match_count       integer;
  v_bad               integer;
  v_rows              bigint;
  v_impersonation_ok  boolean := false;
  v_hq_ok             boolean := false;
  v_used_official_rpc boolean := false;
  v_pi_count_before bigint; v_pi_hash_before text;
  v_pi_count_after  bigint; v_pi_hash_after  text;
  v_sm_count_before bigint; v_sm_hash_before text;
  v_sm_count_after  bigint; v_sm_hash_after  text;
BEGIN
  SELECT * INTO p FROM _cleanup_params;

  ---------------------------------------------------------------------------
  -- GUARD 0. Placeholders replaced?
  ---------------------------------------------------------------------------
  IF p.target_cutoff_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'PHASE B not armed: paste the cut-off UUID from PHASE A into _cleanup_params.target_cutoff_id.';
  END IF;
  IF p.acting_hq_admin_id = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'PHASE B not armed: paste a real HQ admin users.id into _cleanup_params.acting_hq_admin_id.';
  END IF;

  ---------------------------------------------------------------------------
  -- GUARD 1. Exactly one target, matched on primary key AND expected status.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO v_match_count
  FROM public.inventory_opening_cutoffs
  WHERE id = p.target_cutoff_id AND status = p.expected_status;

  IF v_match_count <> 1 THEN
    RAISE EXCEPTION 'Refusing to act: expected exactly 1 cut-off with id=% and status=%, found %.',
      p.target_cutoff_id, p.expected_status, v_match_count;
  END IF;

  SELECT * INTO v_cutoff
  FROM public.inventory_opening_cutoffs
  WHERE id = p.target_cutoff_id AND status = p.expected_status
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Refusing to act: target cut-off vanished between check and lock.';
  END IF;

  ---------------------------------------------------------------------------
  -- GUARD 2. No completion marker on the cut-off.
  ---------------------------------------------------------------------------
  IF v_cutoff.posted_at IS NOT NULL OR v_cutoff.posted_by IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to act: cut-off % carries a posted marker (posted_at=%, posted_by=%).',
      v_cutoff.id, v_cutoff.posted_at, v_cutoff.posted_by;
  END IF;
  IF v_cutoff.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to act: cut-off % is already cancelled at %.', v_cutoff.id, v_cutoff.cancelled_at;
  END IF;

  ---------------------------------------------------------------------------
  -- GUARD 3. Parent session present, Opening Balance, unposted.
  ---------------------------------------------------------------------------
  SELECT * INTO v_session
  FROM public.stock_count_sessions
  WHERE id = v_cutoff.stock_count_session_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Refusing to act: parent session % missing. NOT NULL + NO ACTION FK makes this impossible through supported paths - investigate.',
      v_cutoff.stock_count_session_id;
  END IF;
  IF v_session.count_type IS DISTINCT FROM 'opening_balance_cutoff' THEN
    RAISE EXCEPTION 'Refusing to act: session % count_type=%, expected opening_balance_cutoff.', v_session.id, v_session.count_type;
  END IF;
  IF v_session.status = 'posted' OR v_session.posted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to act: parent session % is posted.', v_session.id;
  END IF;
  IF v_session.status NOT IN ('draft','archived') THEN
    RAISE EXCEPTION 'Refusing to act: parent session % status=% unexpected.', v_session.id, v_session.status;
  END IF;
  IF v_session.warehouse_organization_id IS DISTINCT FROM v_cutoff.warehouse_organization_id THEN
    RAISE EXCEPTION 'Refusing to act: warehouse mismatch (cut-off %, session %).',
      v_cutoff.warehouse_organization_id, v_session.warehouse_organization_id;
  END IF;

  ---------------------------------------------------------------------------
  -- GUARD 4. No posting evidence of any kind.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO v_bad FROM public.inventory_cutoff_reports WHERE cutoff_id = v_cutoff.id;
  IF v_bad > 0 THEN RAISE EXCEPTION 'Refusing to act: % report row(s) exist for this cut-off.', v_bad; END IF;

  SELECT count(*) INTO v_bad FROM public.inventory_cutoff_posting_context WHERE cutoff_id = v_cutoff.id;
  IF v_bad > 0 THEN RAISE EXCEPTION 'Refusing to act: % posting-context row(s) exist - posting may be in flight.', v_bad; END IF;

  SELECT count(*) INTO v_bad FROM public.stock_count_verification_requests
   WHERE session_id = v_session.id AND status IN ('pending_delivery','active','verified','posted');
  IF v_bad > 0 THEN RAISE EXCEPTION 'Refusing to act: % verification request(s) show final posting was started.', v_bad; END IF;

  SELECT count(*) INTO v_bad FROM public.stock_movements WHERE reference_id = v_session.id;
  IF v_bad > 0 THEN RAISE EXCEPTION 'Refusing to act: % stock_movements reference this session.', v_bad; END IF;

  SELECT count(*) INTO v_bad FROM public.stock_movements
   WHERE reason = 'inventory_opening_balance_cutoff'
     AND created_at >= v_cutoff.started_at
     AND (from_organization_id = v_cutoff.warehouse_organization_id
          OR to_organization_id = v_cutoff.warehouse_organization_id);
  IF v_bad > 0 THEN RAISE EXCEPTION 'Refusing to act: % opening-balance-tagged movements exist for this warehouse.', v_bad; END IF;

  ---------------------------------------------------------------------------
  -- GUARD 5. Acting user really is an HQ admin (mirrors inventory_cutoff_is_hq_admin).
  ---------------------------------------------------------------------------
  SELECT count(*) INTO v_bad
  FROM public.users u
  JOIN public.roles r         ON r.role_code = u.role_code
  JOIN public.organizations o ON o.id = u.organization_id
  WHERE u.id = p.acting_hq_admin_id
    AND o.org_type_code = 'HQ'
    AND r.role_level <= 10;
  IF v_bad <> 1 THEN
    RAISE EXCEPTION 'Refusing to act: acting_hq_admin_id % is not a valid HQ admin (org_type_code=HQ AND role_level<=10).',
      p.acting_hq_admin_id;
  END IF;

  ---------------------------------------------------------------------------
  -- Fingerprint inventory + movements BEFORE.
  ---------------------------------------------------------------------------
  SELECT count(*), md5(coalesce(string_agg(sig,'|' ORDER BY sig),''))
    INTO v_pi_count_before, v_pi_hash_before
  FROM (SELECT pi.id::text||':'||coalesce(pi.quantity_on_hand,-1)::text
                 ||':'||coalesce(pi.quantity_allocated,-1)::text
                 ||':'||coalesce(pi.updated_at::text,'') AS sig
        FROM public.product_inventory pi
        WHERE pi.organization_id = v_cutoff.warehouse_organization_id) q;

  SELECT count(*), md5(coalesce(string_agg(sig,'|' ORDER BY sig),''))
    INTO v_sm_count_before, v_sm_hash_before
  FROM (SELECT m.id::text AS sig FROM public.stock_movements m
        WHERE m.from_organization_id = v_cutoff.warehouse_organization_id
           OR m.to_organization_id   = v_cutoff.warehouse_organization_id) q;

  INSERT INTO _cleanup_log(step, detail, rows_affected) VALUES
    ('00 target', format('cutoff=%s session=%s warehouse=%s session_status=%s',
                         v_cutoff.id, v_session.id, v_cutoff.warehouse_organization_id, v_session.status), 1);

  ---------------------------------------------------------------------------
  -- ACTION. Prefer the official RPC. It needs auth.uid(), which we supply via
  -- the standard PostgREST claims GUC (transaction-local). We PROVE the
  -- impersonation works before relying on it; if anything about auth.uid() is
  -- different here, we fall back to an equivalent explicit update instead of
  -- failing. Both paths write the same audit event.
  ---------------------------------------------------------------------------
  IF to_regprocedure('public.cancel_inventory_opening_cutoff(uuid, text)') IS NOT NULL
     AND to_regprocedure('auth.uid()') IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', p.acting_hq_admin_id::text, 'role', 'authenticated')::text, true);
    BEGIN
      SELECT coalesce(auth.uid() = p.acting_hq_admin_id, false) INTO v_impersonation_ok;
    EXCEPTION WHEN OTHERS THEN v_impersonation_ok := false;
    END;
    IF v_impersonation_ok THEN
      BEGIN
        SELECT coalesce(public.inventory_cutoff_is_hq_admin(), false) INTO v_hq_ok;
      EXCEPTION WHEN OTHERS THEN v_hq_ok := false;
      END;
      v_impersonation_ok := v_hq_ok;
    END IF;
  END IF;

  IF v_impersonation_ok THEN
    PERFORM public.cancel_inventory_opening_cutoff(p.target_cutoff_id, p.cancellation_reason);
    v_used_official_rpc := true;
    INSERT INTO _cleanup_log(step, detail, rows_affected) VALUES
      ('10 cancel', 'official RPC public.cancel_inventory_opening_cutoff(uuid,text)', 1);
  ELSE
    UPDATE public.inventory_opening_cutoffs
       SET status = 'cancelled', cancelled_by = p.acting_hq_admin_id,
           cancelled_at = now(), updated_at = now()
     WHERE id = p.target_cutoff_id AND status = p.expected_status;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Refusing to continue: cancel UPDATE affected % row(s), expected 1.', v_rows;
    END IF;

    INSERT INTO public.inventory_cutoff_audit_events(cutoff_id, event_type, actor_id, details)
    VALUES (p.target_cutoff_id, 'warehouse_freeze_cancelled', p.acting_hq_admin_id,
            jsonb_build_object('reason', p.cancellation_reason,
                               'stock_count_session_id', v_session.id,
                               'source', '00_PhaseB_cancel_counting_cutoff.sql fallback path'));

    INSERT INTO _cleanup_log(step, detail, rows_affected) VALUES
      ('10 cancel', 'fallback UPDATE + audit event (official RPC unusable in this session)', v_rows);
  END IF;

  -- Confirm the cancel landed, whichever path ran.
  SELECT count(*) INTO v_bad
  FROM public.inventory_opening_cutoffs
  WHERE id = p.target_cutoff_id AND status = 'cancelled'
    AND cancelled_at IS NOT NULL AND posted_at IS NULL;
  IF v_bad <> 1 THEN
    RAISE EXCEPTION 'Refusing to continue: cut-off % is not in the expected cancelled shape.', p.target_cutoff_id;
  END IF;

  ---------------------------------------------------------------------------
  -- Release the draft slot. Production's cancel RPC predates
  -- 20260731220000, so it leaves a 'draft' session behind; without this,
  -- "Continue Existing Draft" reopens the cancelled cut-off and the
  -- one-active-draft index stays occupied. Order matters: the cut-off is now
  -- 'cancelled', so stock_count_discard_posting_started_guard (which blocks
  -- only counting/posted) permits draft -> archived.
  ---------------------------------------------------------------------------
  IF v_session.status = 'draft' THEN
    UPDATE public.stock_count_sessions
       SET status = 'archived', archived_by = p.acting_hq_admin_id, archived_at = now(),
           updated_by = p.acting_hq_admin_id, updated_at = now()
     WHERE id = v_session.id AND status = 'draft' AND posted_at IS NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'Refusing to continue: session archive affected % row(s), expected 1.', v_rows;
    END IF;
    INSERT INTO _cleanup_log(step, detail, rows_affected) VALUES
      ('20 session', 'stock_count_sessions draft -> archived', v_rows);

    UPDATE public.stock_count_verification_requests
       SET status = 'invalidated', invalidated_at = now()
     WHERE session_id = v_session.id AND status IN ('pending_delivery','active');
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    INSERT INTO _cleanup_log(step, detail, rows_affected) VALUES
      ('21 otp', 'open verification requests invalidated', v_rows);
  ELSE
    INSERT INTO _cleanup_log(step, detail, rows_affected) VALUES
      ('20 session', format('session already %s - left untouched', v_session.status), 0);
  END IF;

  ---------------------------------------------------------------------------
  -- Prove inventory and movements are untouched.
  ---------------------------------------------------------------------------
  SELECT count(*), md5(coalesce(string_agg(sig,'|' ORDER BY sig),''))
    INTO v_pi_count_after, v_pi_hash_after
  FROM (SELECT pi.id::text||':'||coalesce(pi.quantity_on_hand,-1)::text
                 ||':'||coalesce(pi.quantity_allocated,-1)::text
                 ||':'||coalesce(pi.updated_at::text,'') AS sig
        FROM public.product_inventory pi
        WHERE pi.organization_id = v_cutoff.warehouse_organization_id) q;

  SELECT count(*), md5(coalesce(string_agg(sig,'|' ORDER BY sig),''))
    INTO v_sm_count_after, v_sm_hash_after
  FROM (SELECT m.id::text AS sig FROM public.stock_movements m
        WHERE m.from_organization_id = v_cutoff.warehouse_organization_id
           OR m.to_organization_id   = v_cutoff.warehouse_organization_id) q;

  IF v_pi_count_before <> v_pi_count_after OR v_pi_hash_before IS DISTINCT FROM v_pi_hash_after THEN
    RAISE EXCEPTION 'ABORT: product_inventory changed (% -> % rows). Rolling back.', v_pi_count_before, v_pi_count_after;
  END IF;
  IF v_sm_count_before <> v_sm_count_after OR v_sm_hash_before IS DISTINCT FROM v_sm_hash_after THEN
    RAISE EXCEPTION 'ABORT: stock_movements changed (% -> % rows). Rolling back.', v_sm_count_before, v_sm_count_after;
  END IF;

  INSERT INTO _cleanup_log(step, detail, rows_affected) VALUES
    ('90 proof', format('product_inventory UNCHANGED (%s rows, md5 %s)', v_pi_count_after, v_pi_hash_after), 0),
    ('91 proof', format('stock_movements UNCHANGED (%s rows, md5 %s)', v_sm_count_after, v_sm_hash_after), 0),
    ('99 path',  format('official_rpc_used=%s', v_used_official_rpc), 0);

  RAISE NOTICE '=========================================================';
  RAISE NOTICE 'PHASE B done INSIDE the transaction. Nothing is saved yet.';
  RAISE NOTICE 'Read B1-B4 below, then change the final ROLLBACK to COMMIT';
  RAISE NOTICE 'and run this file again.';
  RAISE NOTICE '=========================================================';
END
$phase_b$;

-- ---- PRE-COMMIT PROOF -------------------------------------------------------

SELECT 'B1. ACTION LOG' AS section, seq, step, detail, rows_affected
FROM _cleanup_log ORDER BY seq;

SELECT
  'B2. TARGET ROW AFTER' AS section,
  c.id AS cutoff_id, c.status, c.posted_at, c.cancelled_at, c.cancelled_by, c.updated_at,
  s.id AS session_id, s.status AS session_status, s.archived_at, s.archived_by
FROM public.inventory_opening_cutoffs c
LEFT JOIN public.stock_count_sessions s ON s.id = c.stock_count_session_id
WHERE c.id = (SELECT target_cutoff_id FROM _cleanup_params);

SELECT 'B3. AUDIT TRAIL' AS section, a.id, a.event_type, a.actor_id, a.details, a.created_at
FROM public.inventory_cutoff_audit_events a
WHERE a.cutoff_id = (SELECT target_cutoff_id FROM _cleanup_params)
ORDER BY a.created_at;

SELECT 'B4. REMAINING COUNTING CUT-OFFS' AS section, count(*) AS still_counting
FROM public.inventory_opening_cutoffs WHERE status = 'counting';

-- =============================================================================
-- FIRST RUN STOPS HERE ON PURPOSE.
-- Review B1-B4. When correct: comment out ROLLBACK, uncomment COMMIT, rerun.
-- =============================================================================

ROLLBACK;
-- COMMIT;
