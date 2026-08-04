-- =============================================================================
-- 01_preflight_read_only.sql  [READ-ONLY]
-- =============================================================================
-- PURPOSE      : Decide whether this database is safe to deploy the pack into.
-- PREREQUISITES: none. This is always the first file you run.
-- MUTATES      : NOTHING. No DDL, no DML. Safe on production at any time.
-- EXPECTED     : a single result set ending in an OVERALL row.
-- VERIFY       : OVERALL must be PASS or REVIEW_REQUIRED. If FAIL -> STOP.
-- -----------------------------------------------------------------------------
-- Authoritative application commit: 9a62556aae6f64af3bc98f159196179669311b3f
--
-- This file never prints passwords, connection strings, tokens or row contents.
-- It reports only catalog metadata and aggregate counts.
--
-- The whole script runs inside a READ ONLY transaction, so the database engine
-- itself rejects any accidental write.
-- =============================================================================

\pset pager off
SET default_transaction_read_only = on;
BEGIN READ ONLY;

WITH
-- ---------------------------------------------------------------- identity
identity AS (
  SELECT 'A. IDENTITY' AS section, 'database' AS check_name,
         current_database() AS detail, 'INFO' AS status
  UNION ALL SELECT 'A. IDENTITY', 'server_version', version(), 'INFO'
  UNION ALL SELECT 'A. IDENTITY', 'current_user', current_user, 'INFO'
  UNION ALL SELECT 'A. IDENTITY', 'public_table_count',
         (SELECT count(*)::text FROM information_schema.tables WHERE table_schema='public'), 'INFO'
  -- Fingerprint so staging and production cannot be confused. Record this value
  -- and compare it against the environment you *believe* you are connected to.
  UNION ALL SELECT 'A. IDENTITY', 'schema_fingerprint',
         substr(md5(string_agg(t, ',' ORDER BY t)), 1, 16), 'INFO'
  FROM (SELECT table_name AS t FROM information_schema.tables WHERE table_schema='public') x
),
-- -------------------------------------------------------------- extensions
ext AS (
  SELECT 'B. EXTENSIONS' AS section, e.name AS check_name,
         COALESCE('installed: '||x.extversion, 'NOT INSTALLED') AS detail,
         CASE WHEN x.extname IS NOT NULL THEN 'PASS'
              WHEN e.name = 'pgcrypto' THEN 'FAIL'
              ELSE 'REVIEW_REQUIRED' END AS status
  FROM (VALUES ('pgcrypto'), ('uuid-ossp')) e(name)
  LEFT JOIN pg_extension x ON x.extname = e.name
),
-- ------------------------------------------------- mandatory base objects
base AS (
  SELECT 'C. BASE TABLES (mandatory)' AS section, b.name AS check_name,
         CASE WHEN to_regclass('public.'||b.name) IS NOT NULL
              THEN 'present' ELSE 'MISSING - this pack cannot be deployed' END AS detail,
         CASE WHEN to_regclass('public.'||b.name) IS NOT NULL THEN 'PASS' ELSE 'FAIL' END AS status
  FROM (VALUES
    ('inventory_opening_cutoffs'), ('inventory_cutoff_decisions'),
    ('inventory_cutoff_reports'), ('inventory_cutoff_audit_events'),
    ('inventory_cutoff_posting_context'), ('stock_count_sessions'),
    ('stock_count_session_items'), ('stock_count_session_scope'),
    ('stock_count_verification_requests'), ('inventory_stock_configurations'),
    ('product_inventory'), ('stock_movements'), ('orders'), ('order_items'),
    ('product_variants'), ('stock_adjustments'), ('warehouse_receipts')
  ) b(name)
),
-- --------------------------------------------- tables this pack will create
newtab AS (
  SELECT 'D. TABLES THIS PACK CREATES' AS section, t.name AS check_name,
         CASE WHEN to_regclass('public.'||t.name) IS NOT NULL
              THEN 'already present - 02 will be a no-op for it'
              ELSE 'absent - 02 will create it' END AS detail,
         'INFO' AS status
  FROM (VALUES
    ('inventory_cutoff_d2h_policies'), ('inventory_cutoff_d2h_policy_requests'),
    ('inventory_cutoff_h2m_policies'), ('inventory_cutoff_h2m_policy_requests'),
    ('inventory_cutoff_h2m_bulk_requests'),
    ('inventory_cutoff_transactions_policies'),
    ('inventory_cutoff_transactions_policy_requests'),
    ('inventory_cutoff_excluded_transactions'),
    ('inventory_cutoff_allocation_requests')
  ) t(name)
),
-- ---------------------------------------------------- incompatible shapes
-- A table that exists with the WRONG columns is far more dangerous than one
-- that is missing, because CREATE TABLE IF NOT EXISTS will silently accept it.
shape AS (
  SELECT 'E. SHAPE COMPATIBILITY' AS section, s.tbl||'.'||s.col AS check_name,
         CASE WHEN to_regclass('public.'||s.tbl) IS NULL THEN 'table absent (fine - will be created)'
              WHEN EXISTS (SELECT 1 FROM information_schema.columns c
                           WHERE c.table_schema='public' AND c.table_name=s.tbl AND c.column_name=s.col)
                   THEN 'column present'
              ELSE 'TABLE EXISTS BUT COLUMN MISSING - incompatible pre-existing table' END AS detail,
         CASE WHEN to_regclass('public.'||s.tbl) IS NULL THEN 'PASS'
              WHEN EXISTS (SELECT 1 FROM information_schema.columns c
                           WHERE c.table_schema='public' AND c.table_name=s.tbl AND c.column_name=s.col)
                   THEN 'PASS'
              ELSE 'FAIL' END AS status
  FROM (VALUES
    ('inventory_cutoff_d2h_policies','cutoff_id'),
    ('inventory_cutoff_h2m_policies','cutoff_id'),
    ('inventory_cutoff_transactions_policies','cutoff_id'),
    ('inventory_cutoff_excluded_transactions','cutoff_id'),
    ('inventory_cutoff_allocation_requests','cutoff_id')
  ) s(tbl, col)
),
-- ------------------------------------------------------ check constraints
chk AS (
  SELECT 'F. CHECK ALLOWLISTS' AS section,
         'stock_movements.reference_type accepts opening_balance_cutoff' AS check_name,
         CASE WHEN NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_movements_reference_type_check')
                THEN 'constraint absent - REVIEW: 03 will add it'
              WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname='stock_movements_reference_type_check'
                           AND pg_get_constraintdef(oid) ~ 'opening_balance_cutoff')
                THEN 'already widened - 03 re-asserts it'
              ELSE 'NOT widened - 03 will widen it (ACCESS EXCLUSIVE lock)' END AS detail,
         'INFO' AS status
  UNION ALL
  SELECT 'F. CHECK ALLOWLISTS',
         'inventory_cutoff_decisions.decision accepts do_not_carry_forward',
         CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inventory_cutoff_decisions_decision_check'
                           AND pg_get_constraintdef(oid) ~ 'do_not_carry_forward')
                THEN 'already widened - 03 re-asserts it'
              ELSE 'NOT widened - 03 will widen it' END,
         'INFO'
),
-- ------------------------------------------- data that would block step 03
blockers AS (
  -- Rows that the new non-partial unique index could not tolerate.
  SELECT 'G. DATA BLOCKERS' AS section,
         'duplicate (session_id, stock_config_id) in stock_count_session_items' AS check_name,
         'duplicate groups: '||count(*)::text AS detail,
         CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status
  FROM (SELECT session_id, stock_config_id FROM public.stock_count_session_items
        WHERE stock_config_id IS NOT NULL
        GROUP BY 1,2 HAVING count(*) > 1) d
  UNION ALL
  -- Rows that the widened stock_movements CHECK would reject.
  SELECT 'G. DATA BLOCKERS',
         'stock_movements.reference_type values outside the new allowlist',
         'offending rows: '||count(*)::text,
         CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END
  FROM public.stock_movements
  WHERE reference_type IS NOT NULL AND reference_type <> ALL (ARRAY[
    'manual','order','transfer','adjustment','purchase_order','return','campaign',
    'repack','order_config_change','order_cancel_reversal','stock_classification',
    'opening_balance_cutoff'])
  UNION ALL
  -- Decisions that the widened decision CHECK would reject.
  -- This array MUST stay identical to the allowlist installed by
  -- 03_constraints_and_indexes.sql, or this check produces false alarms.
  -- (It previously listed two invented values, 'expected_incoming' and
  -- 'not_incoming', and omitted the two real ones below -- which reported 387
  -- perfectly valid staging rows as REVIEW_REQUIRED.)
  SELECT 'G. DATA BLOCKERS',
         'inventory_cutoff_decisions.decision values outside the new allowlist',
         'offending rows: '||count(*)::text,
         CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'REVIEW_REQUIRED' END
  FROM public.inventory_cutoff_decisions
  WHERE decision IS NOT NULL AND decision <> ALL (ARRAY[
    'carry_forward','cancel_release','carry_forward_incoming','history_only',
    'do_not_carry_forward'])
),
-- -------------------------------------- partial historical application
partial AS (
  -- The rename-based versioning used by the historical migrations leaves
  -- *_pre_* functions behind. Their presence proves the old migrations ran and
  -- is harmless, but it is worth knowing about before and after deployment.
  SELECT 'H. HISTORICAL RESIDUE' AS section,
         'legacy *_pre_* / *_legacy function copies' AS check_name,
         'count: '||count(*)::text||COALESCE(' -> '||string_agg(p.proname, ', ' ORDER BY p.proname), '') AS detail,
         'INFO' AS status
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname ~ '(_pre_|_unscoped_legacy)'
  UNION ALL
  -- Ambiguous overloads break PostgREST RPC resolution.
  SELECT 'H. HISTORICAL RESIDUE', 'ambiguous overloads on contract functions',
         COALESCE(string_agg(z.proname||' ('||z.n||')', ', '), 'none'),
         CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END
  FROM (SELECT p.proname, count(*) AS n FROM pg_proc p JOIN pg_namespace n2 ON n2.oid=p.pronamespace
        WHERE n2.nspname='public' AND p.proname ~ '(inventory_cutoff|opening_cutoff)'
        GROUP BY 1 HAVING count(*) > 1) z
  UNION ALL
  -- A cut-off mid-flight means someone is using the feature right now, and it
  -- FREEZES that warehouse (inventory_cutoff_product_inventory_guard /
  -- inventory_cutoff_stock_movement_guard).
  --
  -- Blocker strength is deliberately UNCHANGED: any cut-off in 'counting' is
  -- still REVIEW_REQUIRED. The detail now says *which kind* it is, because the
  -- remedy differs:
  --   session draft    -> a real count may be in progress; talk to the counter.
  --   session archived -> stranded. The draft was discarded but the pre-04
  --                       archive_stock_count_draft() never released the cut-off.
  --   session missing  -> impossible via supported paths (NOT NULL + NO ACTION
  --                       FK); indicates manual surgery. Investigate.
  --   OTP requested    -> final posting was started. Never clean this up.
  SELECT 'H. HISTORICAL RESIDUE', 'Opening Balance cut-offs currently in progress',
         'counting: '||count(*) FILTER (WHERE c.status='counting')::text
         ||' [session draft: '||count(*) FILTER (WHERE c.status='counting' AND s.status='draft')::text
         ||', session archived (stranded): '||count(*) FILTER (WHERE c.status='counting' AND s.status='archived')::text
         ||', session missing: '||count(*) FILTER (WHERE c.status='counting' AND s.id IS NULL)::text
         ||', OTP requested: '||count(*) FILTER (
              WHERE c.status='counting' AND EXISTS (
                SELECT 1 FROM public.stock_count_verification_requests v
                WHERE v.session_id = c.stock_count_session_id
                  AND v.status IN ('pending_delivery','active','verified','posted')))::text
         ||']',
         CASE WHEN count(*) FILTER (WHERE c.status='counting') = 0 THEN 'PASS' ELSE 'REVIEW_REQUIRED' END
  FROM public.inventory_opening_cutoffs c
  LEFT JOIN public.stock_count_sessions s ON s.id = c.stock_count_session_id
  UNION ALL
  -- Informational companion to the row above: the actual ids, so the operator can
  -- paste one straight into 00_cleanup_orphan_counting_cutoff.sql PHASE B without
  -- writing an ad-hoc query. INFO never affects FAIL/REVIEW_REQUIRED counts.
  SELECT 'H. HISTORICAL RESIDUE', 'in-progress cut-off ids (for 00_cleanup PHASE A)',
         COALESCE(string_agg(
           c.id::text||' [session '||c.stock_count_session_id::text
           ||' '||COALESCE(s.status,'MISSING')||']', ', ' ORDER BY c.started_at), 'none'),
         'INFO'
  FROM public.inventory_opening_cutoffs c
  LEFT JOIN public.stock_count_sessions s ON s.id = c.stock_count_session_id
  WHERE c.status = 'counting'
),
-- ----------------------------------------------------------------- grants
grants AS (
  SELECT 'H2. GRANTS' AS section, 'contract functions executable by anon' AS check_name,
         'count: '||count(*)::text AS detail,
         'INFO' AS status
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public'
    AND p.proname ~ '(inventory_cutoff|opening_cutoff|archive_stock_count_draft|archive_product_variant|release_allocation_for_order|enforce_stock_count_reference|stock_count_discard_posting)'
    AND has_function_privilege('anon', p.oid, 'EXECUTE')
  UNION ALL
  -- 05 revokes anon EXECUTE. Confirm service_role holds its OWN grant first, so
  -- the revoke cannot collaterally break server-side access.
  SELECT 'H2. GRANTS', 'service_role holds an explicit (not inherited) grant',
         CASE WHEN bool_and(p.proacl::text LIKE '%service_role=X%') THEN 'yes - safe to revoke anon'
              ELSE 'REVIEW: service_role may be relying on the PUBLIC default' END,
         CASE WHEN bool_and(p.proacl::text LIKE '%service_role=X%') THEN 'PASS' ELSE 'REVIEW_REQUIRED' END
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public' AND p.proname='inventory_cutoff_preview'
),
-- ------------------------------------------------------------- migration ledger
ledger AS (
  SELECT 'I. LEDGER' AS section, 'supabase_migrations.schema_migrations' AS check_name,
         CASE WHEN to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
              THEN 'present - but still verify objects, not filenames'
              ELSE 'ABSENT - migrations are applied manually here; object checks are the only truth' END AS detail,
         'INFO' AS status
),
all_checks AS (
  SELECT * FROM identity UNION ALL SELECT * FROM ext UNION ALL SELECT * FROM base
  UNION ALL SELECT * FROM newtab UNION ALL SELECT * FROM shape UNION ALL SELECT * FROM chk
  UNION ALL SELECT * FROM blockers UNION ALL SELECT * FROM partial UNION ALL SELECT * FROM grants UNION ALL SELECT * FROM ledger
)
SELECT section, check_name, status, detail FROM all_checks
UNION ALL SELECT 'Z. OVERALL', 'PASS_COUNT', '', count(*)::text FROM all_checks WHERE status='PASS'
UNION ALL SELECT 'Z. OVERALL', 'FAIL_COUNT', '', count(*)::text FROM all_checks WHERE status='FAIL'
UNION ALL SELECT 'Z. OVERALL', 'REVIEW_REQUIRED_COUNT', '', count(*)::text FROM all_checks WHERE status='REVIEW_REQUIRED'
UNION ALL SELECT 'Z. OVERALL', 'OVERALL_STATUS',
  CASE WHEN EXISTS (SELECT 1 FROM all_checks WHERE status='FAIL') THEN 'FAIL'
       WHEN EXISTS (SELECT 1 FROM all_checks WHERE status='REVIEW_REQUIRED') THEN 'REVIEW_REQUIRED'
       ELSE 'PASS' END,
  CASE WHEN EXISTS (SELECT 1 FROM all_checks WHERE status='FAIL')
         THEN 'STOP. Do not run 02-07. Resolve every FAIL row above first.'
       WHEN EXISTS (SELECT 1 FROM all_checks WHERE status='REVIEW_REQUIRED')
         THEN 'Read every REVIEW_REQUIRED row. Proceed only if each is understood and accepted.'
       ELSE 'Safe to proceed with 02_schema_foundation.sql.' END
ORDER BY 1, 2;

COMMIT;
