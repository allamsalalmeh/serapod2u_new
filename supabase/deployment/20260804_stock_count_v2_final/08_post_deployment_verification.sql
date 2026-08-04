-- =============================================================================
-- 08_post_deployment_verification.sql  [READ-ONLY / VERIFICATION ONLY]
-- =============================================================================
-- PURPOSE      : Prove the database now matches the 9a62556a contract.
-- PREREQUISITES: 02-07 executed.
-- MUTATES      : NOTHING. No DDL, no DML.
-- EXPECTED     : OVERALL_STATUS = PASS, FAIL_COUNT = 0.
-- VERIFY       : any FAIL row carries its own reason in the detail column.
-- -----------------------------------------------------------------------------
-- Authoritative application commit: 9a62556aae6f64af3bc98f159196179669311b3f
-- Runs inside a READ ONLY transaction; the engine rejects accidental writes.
-- =============================================================================

SET default_transaction_read_only = on;
BEGIN READ ONLY;

WITH
-- Shared definitions used by the grant checks below. Kept in sync with the
-- surface regex and v_entry_points array in 07_final_contract_fixes.sql.
surface AS (
  SELECT p.oid, p.proname,
         p.prorettype = 'pg_catalog.trigger'::regtype AS is_trigger
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND ( p.proname ~ ('(inventory_cutoff|opening_cutoff|archive_stock_count_draft'
                      '|archive_product_variant|release_allocation_for_order'
                      '|enforce_stock_count_reference|stock_count_discard_posting'
                      '|assert_h2m_receipt_allowed_after_cutoff'
                      '|trg_warehouse_receipt_h2m_excluded_guard)')
       OR p.proname IN ('prepare_stock_count_verification',
                        'discard_stock_count_drafts',
                        'finalize_stock_count_verification_delivery') )
),
entry_points AS (
  SELECT unnest(ARRAY[
    'inventory_cutoff_preview','start_inventory_opening_cutoff',
    'cancel_inventory_opening_cutoff','set_inventory_cutoff_decision',
    'bind_inventory_cutoff_verification_snapshot',
    'verify_and_post_inventory_opening_cutoff','release_allocation_for_order',
    'resolve_inventory_cutoff_allocation','resolve_inventory_cutoff_d2h_carry_forward',
    'resolve_inventory_cutoff_h2m_incoming',
    'inventory_cutoff_d2h_policy_preflight','inventory_cutoff_h2m_policy_preflight',
    'inventory_cutoff_transactions_policy_preflight','inventory_cutoff_h2m_bulk_preflight',
    'apply_inventory_cutoff_d2h_policy','apply_inventory_cutoff_h2m_policy',
    'apply_inventory_cutoff_transactions_policy','apply_inventory_cutoff_h2m_bulk',
    'prepare_stock_count_verification','discard_stock_count_drafts',
    'finalize_stock_count_verification_delivery','archive_product_variant']) AS n
),
-- T. required tables ---------------------------------------------------------
t_tables AS (
  SELECT 'T. TABLES' AS section, n AS check_name,
         CASE WHEN to_regclass('public.'||n) IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS status,
         CASE WHEN to_regclass('public.'||n) IS NOT NULL THEN 'present'
              ELSE 'MISSING - 02_schema_foundation.sql did not complete' END AS detail
  FROM (VALUES
    ('inventory_opening_cutoffs'),('inventory_cutoff_decisions'),('inventory_cutoff_reports'),
    ('inventory_cutoff_audit_events'),('inventory_cutoff_posting_context'),
    ('inventory_cutoff_d2h_policies'),('inventory_cutoff_d2h_policy_requests'),
    ('inventory_cutoff_h2m_policies'),('inventory_cutoff_h2m_policy_requests'),
    ('inventory_cutoff_h2m_bulk_requests'),('inventory_cutoff_transactions_policies'),
    ('inventory_cutoff_transactions_policy_requests'),('inventory_cutoff_excluded_transactions'),
    ('inventory_cutoff_allocation_requests')) v(n)
),
-- C. constraints -------------------------------------------------------------
t_checks AS (
  SELECT 'C. CONSTRAINTS', 'stock_movements_reference_type_check :: opening_balance_cutoff',
         CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_movements_reference_type_check'
              AND pg_get_constraintdef(oid) ~ 'opening_balance_cutoff') THEN 'PASS' ELSE 'FAIL' END,
         'Opening Balance allocation release writes stock_movements with this reference_type; '
         'without it the whole resolver transaction rolls back.'
  UNION ALL
  SELECT 'C. CONSTRAINTS', 'inventory_cutoff_decisions_decision_check :: do_not_carry_forward',
         CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_cutoff_decisions_decision_check'
              AND pg_get_constraintdef(oid) ~ 'do_not_carry_forward') THEN 'PASS' ELSE 'FAIL' END,
         'Start Fresh / exclude-all saves this decision value.'
),
-- I. indexes -----------------------------------------------------------------
t_idx AS (
  SELECT 'I. INDEXES', 'stock_count_session_items non-partial unique (session_id, stock_config_id)',
         CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
              AND tablename='stock_count_session_items' AND indexdef ~ 'UNIQUE'
              AND indexdef ~ 'session_id' AND indexdef ~ 'stock_config_id' AND indexdef !~ 'WHERE')
              THEN 'PASS' ELSE 'FAIL' END,
         'Save Draft upserts with ON CONFLICT (session_id, stock_config_id); PostgreSQL '
         'cannot infer a PARTIAL unique index for ON CONFLICT.'
  UNION ALL
  SELECT 'I. INDEXES', 'inventory_cutoff_excluded_transactions_lookup',
         CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
              AND indexname='inventory_cutoff_excluded_transactions_lookup') THEN 'PASS' ELSE 'FAIL' END,
         'Lookup index for the historical-excluded transaction guard.'
),
-- F. exact function signatures ----------------------------------------------
-- The application calls these by name through PostgREST. A wrong signature is a
-- runtime 404/400, so the argument list is compared literally.
t_fn AS (
  SELECT 'F. FUNCTION SIGNATURES', f.sig,
         CASE WHEN EXISTS (
           SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public'
             AND p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' = f.sig
         ) THEN 'PASS' ELSE 'FAIL' END,
         'Called by the application; exact identity signature must match.'
  FROM (VALUES
    ('inventory_cutoff_preview(p_cutoff_id uuid)'),
    ('verify_and_post_inventory_opening_cutoff(p_request_id uuid, p_code_hash text)'),
    ('verify_and_post_inventory_opening_cutoff_scoped_legacy(p_request_id uuid, p_code_hash text)'),
    ('bind_inventory_cutoff_verification_snapshot(p_request_id uuid, p_cutoff_id uuid)'),
    ('cancel_inventory_opening_cutoff(p_cutoff_id uuid, p_reason text)'),
    ('set_inventory_cutoff_decision(p_cutoff_id uuid, p_order_item_id uuid, p_decision text)'),
    ('archive_stock_count_draft(p_session_id uuid)'),
    ('archive_product_variant(p_variant_id uuid)'),
    ('release_allocation_for_order(p_order_id uuid)'),
    ('resolve_inventory_cutoff_d2h_carry_forward(p_cutoff_id uuid, p_order_item_ids uuid[])'),
    ('resolve_inventory_cutoff_h2m_incoming(p_cutoff_id uuid, p_order_item_ids uuid[])'),
    ('inventory_cutoff_d2h_policy_preflight(p_cutoff_id uuid, p_policy text, p_selected_order_ids uuid[])'),
    ('inventory_cutoff_h2m_policy_preflight(p_cutoff_id uuid, p_policy text, p_selected_order_ids uuid[])'),
    ('inventory_cutoff_transactions_policy_preflight(p_cutoff_id uuid, p_policy text, p_carried_refs jsonb)'),
    ('inventory_cutoff_h2m_bulk_preflight(p_cutoff_id uuid, p_action text, p_order_ids uuid[])'),
    ('apply_inventory_cutoff_d2h_policy(p_cutoff_id uuid, p_policy text, p_selected_order_ids uuid[], p_expected_fingerprint text, p_idempotency_key uuid)'),
    ('apply_inventory_cutoff_h2m_policy(p_cutoff_id uuid, p_policy text, p_selected_order_ids uuid[], p_expected_fingerprint text, p_idempotency_key uuid)'),
    ('apply_inventory_cutoff_transactions_policy(p_cutoff_id uuid, p_policy text, p_carried_refs jsonb, p_expected_fingerprint text, p_idempotency_key uuid)'),
    ('apply_inventory_cutoff_h2m_bulk(p_cutoff_id uuid, p_action text, p_order_ids uuid[], p_expected_fingerprint text, p_idempotency_key uuid)'),
    ('resolve_inventory_cutoff_allocation(p_cutoff_id uuid, p_product_variant_id uuid, p_stock_config_id uuid, p_action text, p_related_order_id uuid, p_expected_allocated integer, p_expected_selected integer, p_reason text, p_idempotency_key uuid)')
  ) f(sig)
),
-- X. critical behavioural contracts -----------------------------------------
-- These assert on the installed function SOURCE, so a stale copy of the right
-- shape cannot pass.
t_contract AS (
  SELECT 'X. BEHAVIOUR CONTRACT' AS section, c.nm AS check_name,
         CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                           WHERE n.nspname='public' AND p.proname=c.fname
                             AND pg_get_functiondef(p.oid) ~ c.pat) THEN 'PASS' ELSE 'FAIL' END AS status,
         c.why AS detail
  FROM (VALUES
    ('Opening Balance preview emits structured blocker_details[]',
     'inventory_cutoff_preview', 'blocker_details',
     'Step 4 and Step 5 must read the SAME blocker collection, else Step 4 shows '
     '"All resolved" while Step 5 reports a blocker.'),
    ('preview delegates to the blocker_details layer',
     'inventory_cutoff_preview', 'inventory_cutoff_preview_pre_blocker_details',
     'The final preview is a THIN WRAPPER. If it stops delegating, the D2H, H2M '
     'and Transactions contracts silently disappear from the payload.'),
    ('posting is blocked ONLY by real blockers, never by advisory review items',
     'verify_and_post_inventory_opening_cutoff_scoped_legacy', 'readiness''=''Blocked',
     'Review Required with zero blockers must still be postable (20260801240000).'),
    ('do_not_carry_forward survives later cancellation of its own order',
     'verify_and_post_inventory_opening_cutoff_scoped_legacy',
     'cancel_release''\) and o\.status',
     'Staleness must apply only to decisions that MUTATE the order '
     '(20260801250000). Without this the final post raises '
     'inventory_cutoff_distributor_decision_stale.'),
    ('posting registers an idempotent posting context',
     'verify_and_post_inventory_opening_cutoff_scoped_legacy', 'inventory_cutoff_posting_context',
     'Atomicity + warehouse-freeze bypass for the posting transaction itself.'),
    ('allocation resolver is freeze-aware',
     'resolve_inventory_cutoff_allocation', 'inventory_cutoff_posting_context',
     'Its release runs while its own cut-off freezes the warehouse '
     '(20260801220000); without this it raises inventory_cutoff_warehouse_frozen.'),
    ('allocation resolver refuses release while a genuine owner exists',
     'resolve_inventory_cutoff_allocation', 'active_owner|inventory_cutoff_allocation_active_owner',
     'Releasing an allocation owned by a live submitted order would corrupt it.'),
    ('allocation resolver writes an audited opening_balance_cutoff movement',
     'resolve_inventory_cutoff_allocation', 'opening_balance_cutoff',
     'Movement history / audit trail for the release.'),
    ('D2H cancellation releases legacy NULL stock_config allocations',
     'release_allocation_for_order', 'stock_config_id IS NULL',
     'Legacy order items and legacy allocation movements both carry NULL '
     'stock_config_id (20260801200000 + 20260801210000).'),
    ('draft discard also clears the Transactions policy children',
     'archive_stock_count_draft', 'inventory_cutoff_transactions_polic',
     'Those children are ON DELETE RESTRICT; without this, discard fails '
     '(20260801170000).'),
    ('cancel releases the active draft slot',
     'cancel_inventory_opening_cutoff', 'archived',
     'Otherwise Continue Existing Draft reopens a cancelled cut-off '
     '(20260731220000).'),
    ('pre-OTP drafts remain discardable',
     'stock_count_discard_posting_started_guard', 'verification|request',
     'status=counting alone must not mean "posting started" (20260801120000).')
  ) c(nm, fname, pat, why)
),
-- TR. triggers ---------------------------------------------------------------
t_trg AS (
  SELECT 'TR. TRIGGERS', g.nm,
         CASE WHEN EXISTS (SELECT 1 FROM pg_trigger tg JOIN pg_class c ON c.oid=tg.tgrelid
              WHERE NOT tg.tgisinternal AND tg.tgname=g.nm AND c.relname=g.tbl)
              THEN 'PASS' ELSE 'FAIL' END,
         'on public.'||g.tbl
  FROM (VALUES
    ('stock_count_reference_required','stock_count_sessions'),
    ('stock_count_discard_posting_started_guard','stock_count_sessions'),
    ('inventory_cutoff_product_inventory_guard','product_inventory'),
    ('inventory_cutoff_stock_movement_guard','stock_movements'),
    ('inventory_cutoff_excluded_transaction_guard','stock_movements'),
    ('warehouse_receipt_h2m_excluded_guard','warehouse_receipts')
  ) g(nm, tbl)
),
-- R. RLS ---------------------------------------------------------------------
t_rls AS (
  SELECT 'R. RLS ENABLED', v.n,
         CASE WHEN EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
              WHERE ns.nspname='public' AND c.relname=v.n AND c.relrowsecurity)
              THEN 'PASS' ELSE 'FAIL' END,
         'RLS must be ON. Tables with zero policies are deny-all by design and are '
         'reached only through SECURITY DEFINER functions.'
  FROM (VALUES
    ('inventory_cutoff_d2h_policies'),('inventory_cutoff_d2h_policy_requests'),
    ('inventory_cutoff_h2m_policies'),('inventory_cutoff_h2m_policy_requests'),
    ('inventory_cutoff_h2m_bulk_requests'),('inventory_cutoff_transactions_policies'),
    ('inventory_cutoff_transactions_policy_requests'),('inventory_cutoff_excluded_transactions'),
    ('inventory_cutoff_allocation_requests')) v(n)
),
-- G. grants ------------------------------------------------------------------
t_grants AS (
  -- Spot-check a few high-traffic entry points by name. The exhaustive
  -- entry-point/internal checks are the set-based ones below; this block just
  -- makes the most important ones obvious in the output.
  -- NOTE: verify_and_post_..._scoped_legacy and archive_stock_count_draft are
  -- deliberately NOT listed. They are INTERNAL (reached only from inside another
  -- SECURITY DEFINER function), so after 07 they correctly have no client grant.
  SELECT 'G. GRANTS', 'authenticated can EXECUTE '||v.n,
         CASE WHEN has_function_privilege('authenticated', p.oid, 'EXECUTE') THEN 'PASS' ELSE 'FAIL' END,
         'PostgREST calls this RPC as the authenticated role.'
  FROM (VALUES ('inventory_cutoff_preview'),('verify_and_post_inventory_opening_cutoff'),
               ('start_inventory_opening_cutoff'),
               ('bind_inventory_cutoff_verification_snapshot'),
               ('resolve_inventory_cutoff_allocation'),
               ('prepare_stock_count_verification'),
               ('discard_stock_count_drafts')) v(n)
  JOIN pg_proc p ON p.proname = v.n
  JOIN pg_namespace ns ON ns.oid = p.pronamespace AND ns.nspname='public'
  UNION ALL
  -- 07_final_contract_fixes.sql enforces the final client-role grants.
  -- Scope = the whole Stock Count V2 / Opening Balance surface, including the
  -- verification / discard boundary.
  SELECT 'G. GRANTS', 'no surface function is executable by PUBLIC',
         CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
         CASE WHEN count(*) = 0 THEN 'PUBLIC has EXECUTE on 0 surface functions'
              ELSE 'PUBLIC can still execute: '||string_agg(z.proname, ', ')||
                   ' -- re-run 07_final_contract_fixes.sql as supabase_admin' END
  FROM (SELECT s2.proname FROM surface s2
        WHERE has_function_privilege('public', s2.oid, 'EXECUTE')) z
  UNION ALL
  SELECT 'G. GRANTS', 'no surface function is executable by anon',
         CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
         CASE WHEN count(*) = 0 THEN 'anon has EXECUTE on 0 surface functions'
              ELSE 'anon can still execute: '||string_agg(z.proname, ', ')||
                   ' -- re-run 07_final_contract_fixes.sql as supabase_admin' END
  FROM (SELECT s2.proname FROM surface s2
        WHERE has_function_privilege('anon', s2.oid, 'EXECUTE')) z
  UNION ALL
  -- Internal delegation layers, helpers and guards must NOT be directly callable.
  SELECT 'G. GRANTS', 'internal/*_pre_*/trigger functions have no client EXECUTE',
         CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
         CASE WHEN count(*) = 0 THEN 'no non-entry-point is client-executable'
              ELSE 'still client-executable: '||string_agg(z.proname, ', ') END
  FROM (SELECT s2.proname FROM surface s2
        WHERE s2.proname NOT IN (SELECT n FROM entry_points)
          AND (has_function_privilege('authenticated', s2.oid, 'EXECUTE')
            OR has_function_privilege('service_role', s2.oid, 'EXECUTE'))) z
  UNION ALL
  -- The application must not lose access to anything it genuinely calls.
  SELECT 'G. GRANTS', 'every application entry point is executable by authenticated',
         CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
         CASE WHEN count(*) = 0 THEN 'all entry points reachable by authenticated'
              ELSE 'BROKEN - authenticated cannot execute: '||string_agg(z.proname, ', ') END
  FROM (SELECT s2.proname FROM surface s2
        WHERE s2.proname IN (SELECT n FROM entry_points)
          AND NOT has_function_privilege('authenticated', s2.oid, 'EXECUTE')) z
  UNION ALL
  SELECT 'G. GRANTS', 'every application entry point is executable by service_role',
         CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
         CASE WHEN count(*) = 0 THEN 'all entry points reachable by service_role'
              ELSE 'BROKEN - service_role cannot execute: '||string_agg(z.proname, ', ') END
  FROM (SELECT s2.proname FROM surface s2
        WHERE s2.proname IN (SELECT n FROM entry_points)
          AND NOT has_function_privilege('service_role', s2.oid, 'EXECUTE')) z
),
-- CH. preview delegation chain ----------------------------------------------
-- inventory_cutoff_preview is an eight-layer stack. Every layer must exist or
-- the first preview call fails at RUNTIME with "function does not exist" -- a
-- failure that no amount of compile-time checking would have caught.
t_chain AS (
  SELECT 'CH. PREVIEW CHAIN', v.n,
         CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
              WHERE ns.nspname='public' AND p.proname=v.n) THEN 'PASS' ELSE 'FAIL' END,
         'Load-bearing delegation layer. MISSING = preview fails at runtime.'
  FROM (VALUES
    ('inventory_cutoff_preview_h2m_unscoped_legacy'),
    ('inventory_cutoff_preview_pre_stock_adjustment_eligibility'),
    ('inventory_cutoff_preview_pre_stock_adjustment_detail'),
    ('inventory_cutoff_preview_pre_d2h_policy'),
    ('inventory_cutoff_preview_pre_h2m_policy'),
    ('inventory_cutoff_preview_pre_transactions_policy'),
    ('inventory_cutoff_preview_pre_blocker_details'),
    -- truncated at 63 chars by PostgreSQL's identifier limit; this spelling is correct
    ('verify_and_post_inventory_opening_cutoff_pre_transactions_polic')) v(n)
),
-- O. no ambiguous overloads --------------------------------------------------
t_over AS (
  SELECT 'O. OVERLOADS', 'no ambiguous overloads on contract functions',
         CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END,
         CASE WHEN count(*) = 0 THEN 'exactly one definition per contract function'
              ELSE 'AMBIGUOUS: '||string_agg(z.proname, ', ')||
                   ' - PostgREST cannot resolve the RPC; drop the stale overload' END
  FROM (SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname ~ '(inventory_cutoff|opening_cutoff)'
        GROUP BY 1 HAVING count(*) > 1) z
),
all_checks AS (
  SELECT * FROM t_tables UNION ALL SELECT * FROM t_checks UNION ALL SELECT * FROM t_idx
  UNION ALL SELECT * FROM t_chain
  UNION ALL SELECT * FROM t_fn UNION ALL SELECT * FROM t_contract UNION ALL SELECT * FROM t_trg
  UNION ALL SELECT * FROM t_rls UNION ALL SELECT * FROM t_grants UNION ALL SELECT * FROM t_over
)
SELECT section, check_name, status, detail FROM all_checks WHERE status <> 'PASS'
UNION ALL
SELECT section, check_name, status, '' FROM all_checks WHERE status = 'PASS'
UNION ALL SELECT 'Z. OVERALL', 'PASS_COUNT', '', count(*)::text FROM all_checks WHERE status='PASS'
UNION ALL SELECT 'Z. OVERALL', 'FAIL_COUNT', '', count(*)::text FROM all_checks WHERE status='FAIL'
UNION ALL SELECT 'Z. OVERALL', 'REVIEW_REQUIRED_COUNT', '', count(*)::text FROM all_checks WHERE status='REVIEW_REQUIRED'
UNION ALL SELECT 'Z. OVERALL', 'OVERALL_STATUS',
  CASE WHEN EXISTS (SELECT 1 FROM all_checks WHERE status='FAIL') THEN 'FAIL'
       WHEN EXISTS (SELECT 1 FROM all_checks WHERE status='REVIEW_REQUIRED') THEN 'REVIEW_REQUIRED'
       ELSE 'PASS' END,
  CASE WHEN EXISTS (SELECT 1 FROM all_checks WHERE status='FAIL')
       THEN 'Deployment INCOMPLETE. Do not begin UI testing. See the FAIL rows above.'
       ELSE 'Database matches the 9a62556a contract. Proceed to 09.' END
ORDER BY 1, 2;

COMMIT;
