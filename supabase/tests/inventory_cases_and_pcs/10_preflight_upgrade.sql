-- ============================================================================
-- Phase 10 — PRE-MIGRATION state assertions + exact reproduction of the staging
-- failure, using the real pre-migration definitions loaded by build_harness.py.
-- ----------------------------------------------------------------------------
-- This file runs BEFORE 20261220100000_inventory_cases_and_pcs.sql.
--
-- It exists because the earlier harness built only tables and created every
-- function fresh, so `CREATE OR REPLACE FUNCTION _stock_transfer_totals` was in
-- fact a plain CREATE and could never hit the staging error. Staging already had
--   _stock_transfer_totals(jsonb) RETURNS TABLE(total_items integer, total_value numeric)
-- and appending an OUT column is not a replaceable change:
--   ERROR 42P13: cannot change return type of existing function
--   DETAIL: Row type defined by OUT parameters is different.
--
-- Read-only: everything below runs inside a DO block and the DDL probe is rolled
-- back by its own subtransaction. The harness database is thrown away by run.sh.
-- ============================================================================

\set ON_ERROR_STOP 1

DO $do$
DECLARE
  v_result text;
  v_nargs integer;
  v_lang text;
  v_secdef boolean;
  v_cfg text[];
  v_cnt integer;
BEGIN
  ----------------------------------------------------------------------------
  -- 0.1 The pre-migration contract we are replacing, verbatim.
  ----------------------------------------------------------------------------
  SELECT pg_get_function_result(p.oid), p.pronargs, l.lanname, p.prosecdef, p.proconfig
    INTO v_result, v_nargs, v_lang, v_secdef, v_cfg
    FROM pg_proc p
    JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = 'public._stock_transfer_totals(jsonb)'::regprocedure;

  IF v_result IS DISTINCT FROM 'TABLE(total_items integer, total_value numeric)' THEN
    RAISE EXCEPTION 'PRECONDITION FAIL _stock_transfer_totals result: %', v_result;
  END IF;
  IF v_nargs <> 1 OR v_lang <> 'sql' OR v_secdef THEN
    RAISE EXCEPTION 'PRECONDITION FAIL _stock_transfer_totals shape: nargs=% lang=% secdef=%',
      v_nargs, v_lang, v_secdef;
  END IF;
  IF v_cfg IS NULL OR NOT (v_cfg @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'PRECONDITION FAIL _stock_transfer_totals search_path: %', v_cfg;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public._stock_transfer_totals(jsonb)'::regprocedure
       AND (p.proacl IS NULL OR EXISTS (
         SELECT 1 FROM aclexplode(p.proacl) a
          WHERE a.privilege_type = 'EXECUTE' AND a.grantee = 0))
  ) OR has_function_privilege('anon', 'public._stock_transfer_totals(jsonb)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'PRECONDITION FAIL totals fixture must match the captured staging no-PUBLIC/no-anon ACL';
  END IF;
  RAISE NOTICE 'PASS 0.1 pre-migration totals contract and denied PUBLIC/anon ACL: % (sql, invoker, search_path pinned)', v_result;

  ----------------------------------------------------------------------------
  -- 0.2 record_stock_movement must be the 16-argument version, so the migration
  --     really has to drop it before adding the piece-aware 17-argument one.
  ----------------------------------------------------------------------------
  SELECT count(*) INTO v_cnt
    FROM pg_proc
   WHERE proname = 'record_stock_movement'
     AND pronamespace = 'public'::regnamespace;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'PRECONDITION FAIL record_stock_movement overloads: %', v_cnt;
  END IF;
  SELECT p.pronargs INTO v_nargs
    FROM pg_proc p
   WHERE p.oid = 'public.record_stock_movement(text, uuid, uuid, integer, numeric, uuid, text, text, text, text, uuid, text, uuid, uuid, text[], uuid)'::regprocedure;
  IF v_nargs <> 16 THEN
    RAISE EXCEPTION 'PRECONDITION FAIL record_stock_movement arg count: %', v_nargs;
  END IF;
  RAISE NOTICE 'PASS 0.2 pre-migration record_stock_movement: single 16-argument overload';

  ----------------------------------------------------------------------------
  -- 0.3 The pre-migration read models exist, so CREATE OR REPLACE VIEW is a real
  --     replacement (column lists are append-only, which Postgres allows).
  ----------------------------------------------------------------------------
  SELECT count(*) INTO v_cnt
    FROM information_schema.views
   WHERE table_schema = 'public'
     AND table_name IN ('vw_inventory_on_hand', 'vw_stock_movements_ordered');
  IF v_cnt <> 2 THEN
    RAISE EXCEPTION 'PRECONDITION FAIL legacy views present: % of 2', v_cnt;
  END IF;
  SELECT count(*) INTO v_cnt
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'vw_inventory_on_hand';
  IF v_cnt <> 33 THEN
    RAISE EXCEPTION 'PRECONDITION FAIL vw_inventory_on_hand pre-image columns: % (expected 33)', v_cnt;
  END IF;
  RAISE NOTICE 'PASS 0.3 pre-migration views present (vw_inventory_on_hand = 33 columns)';
END $do$;

-- ---------------------------------------------------------------------------
-- 0.4 Reproduce the staging error exactly: the statement the first version of
--     the migration used (CREATE OR REPLACE with an extra OUT column).
-- 0.5 Prove the failed replace leaves the original contract intact.
-- 0.6 Prove DROP + CREATE inside a subtransaction reaches the 3-column contract.
-- 0.7 Prove rolling that subtransaction back restores the old function exactly
--     (no missing function, no changed signature) — the migration's own
--     BEGIN/COMMIT gives the same guarantee for the whole file.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_result text;
BEGIN
  IF pg_get_function_result('public._stock_transfer_totals(jsonb)'::regprocedure)
     IS DISTINCT FROM 'TABLE(total_items integer, total_value numeric)' THEN
    RAISE EXCEPTION 'PRECONDITION FAIL totals changed before the reproduction';
  END IF;

  BEGIN
    EXECUTE $ddl$
      CREATE OR REPLACE FUNCTION public._stock_transfer_totals(p_items jsonb)
      RETURNS TABLE(total_items integer, total_pcs integer, total_value numeric)
      LANGUAGE sql
      STABLE
      SET search_path = public, pg_temp
      AS $sql$
        SELECT 0::integer, 0::integer, 0::numeric
      $sql$;
    $ddl$;
    RAISE EXCEPTION 'REPRODUCTION FAIL: staging error 42P13 did not reproduce';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE <> '42P13' THEN
        RAISE EXCEPTION 'REPRODUCTION FAIL: expected 42P13, got %: %', SQLSTATE, SQLERRM;
      END IF;
      RAISE NOTICE 'PASS 0.4 reproduced staging failure exactly: 42P13 -> %', SQLERRM;
  END;

  IF pg_get_function_result('public._stock_transfer_totals(jsonb)'::regprocedure)
     IS DISTINCT FROM 'TABLE(total_items integer, total_value numeric)' THEN
    RAISE EXCEPTION 'FAIL failing replace mutated the function';
  END IF;
  RAISE NOTICE 'PASS 0.5 failing replace left the original contract intact';

  BEGIN
    EXECUTE 'DROP FUNCTION public._stock_transfer_totals(jsonb)';
    EXECUTE $ddl$
      CREATE OR REPLACE FUNCTION public._stock_transfer_totals(p_items jsonb)
      RETURNS TABLE(total_items integer, total_pcs integer, total_value numeric)
      LANGUAGE sql
      STABLE
      SET search_path = public, pg_temp
      AS $sql$
        SELECT 1::integer, 2::integer, 3::numeric
      $sql$;
    $ddl$;
    IF pg_get_function_result('public._stock_transfer_totals(jsonb)'::regprocedure)
       IS DISTINCT FROM 'TABLE(total_items integer, total_pcs integer, total_value numeric)' THEN
      RAISE EXCEPTION 'FAIL drop+create did not install the 3-column contract';
    END IF;
    RAISE NOTICE 'PASS 0.6 DROP+CREATE reached the 3-column contract inside the transaction';
    RAISE EXCEPTION 'ROLLBACK_PROBE';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM <> 'ROLLBACK_PROBE' THEN
        RAISE;
      END IF;
  END;

  SELECT pg_get_function_result('public._stock_transfer_totals(jsonb)'::regprocedure)
    INTO v_result;
  IF v_result IS DISTINCT FROM 'TABLE(total_items integer, total_value numeric)' THEN
    RAISE EXCEPTION 'FAIL subtransaction did not roll the replacement back: %', v_result;
  END IF;
  RAISE NOTICE 'PASS 0.7 rollback restored the pre-migration function exactly';
END $do$;
