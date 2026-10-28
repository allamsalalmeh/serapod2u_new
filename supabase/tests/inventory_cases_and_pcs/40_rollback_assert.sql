-- ============================================================================
-- Phase 40 — ROLLBACK ON FAILURE assertions
-- ----------------------------------------------------------------------------
-- run.sh applies a copy of the migration whose final COMMIT is replaced with
-- SELECT 1/0, so every statement before it runs and the transaction then fails.
-- The migration wraps the whole file in BEGIN … COMMIT, so the connection ends
-- with an aborted transaction and Postgres must roll everything back:
--   * no new columns, functions, constraints or view columns may survive;
--   * the dropped 16-argument record_stock_movement must come back;
--   * the 2-column _stock_transfer_totals must be unchanged.
-- ============================================================================

\set ON_ERROR_STOP 1

DO $do$
DECLARE
  v_cnt integer;
  v_result text;
BEGIN
  -- No additive column survived.
  SELECT count(*) INTO v_cnt
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND ((table_name = 'product_inventory' AND column_name IN ('pcs_on_hand','pcs_per_case','pcs_value'))
       OR (table_name = 'stock_movements' AND column_name IN ('quantity_pcs_change','quantity_pcs_before','quantity_pcs_after','pcs_per_case','net_cost'))
       OR (table_name = 'stock_count_session_items' AND column_name IN ('system_pcs','physical_pcs','adjustment_pcs','pcs_per_case')));
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: % new columns survived a failed migration', v_cnt;
  END IF;

  -- The new resolver must not exist.
  IF to_regprocedure('public.resolve_stock_pcs_per_case(uuid, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: resolve_stock_pcs_per_case survived';
  END IF;

  -- _stock_transfer_totals is still the pre-migration 2-column contract.
  SELECT pg_get_function_result('public._stock_transfer_totals(jsonb)'::regprocedure)
    INTO v_result;
  IF v_result IS DISTINCT FROM 'TABLE(total_items integer, total_value numeric)' THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: totals not restored: %', v_result;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public._stock_transfer_totals(jsonb)'::regprocedure
       AND (p.proacl IS NULL OR EXISTS (
         SELECT 1 FROM aclexplode(p.proacl) a
          WHERE a.privilege_type = 'EXECUTE' AND a.grantee = 0))
  ) OR has_function_privilege('anon', 'public._stock_transfer_totals(jsonb)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: totals did not restore the captured no-PUBLIC/no-anon ACL';
  END IF;

  -- The explicitly dropped legacy balance writer is back, and still the only one.
  SELECT count(*) INTO v_cnt
    FROM pg_proc
   WHERE proname = 'record_stock_movement'
     AND pronamespace = 'public'::regnamespace;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: record_stock_movement overloads after rollback: %', v_cnt;
  END IF;
  IF to_regprocedure('public.record_stock_movement(text, uuid, uuid, integer, numeric, uuid, text, text, text, text, uuid, text, uuid, uuid, text[], uuid)') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: legacy 16-argument record_stock_movement was not restored';
  END IF;

  -- Read models keep their pre-migration shape.
  SELECT count(*) INTO v_cnt
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'vw_inventory_on_hand';
  IF v_cnt <> 33 THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: vw_inventory_on_hand has % columns (expected the 33 pre-migration columns)', v_cnt;
  END IF;
  SELECT count(*) INTO v_cnt
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'vw_stock_movements_ordered';
  IF v_cnt <> 34 THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: vw_stock_movements_ordered has % columns (expected 34)', v_cnt;
  END IF;

  -- The replaced sign/manifest constraint is the pre-migration one.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'valid_quantity_change') LIKE '%pcs_per_case%' THEN
    RAISE EXCEPTION 'ROLLBACK FAIL: piece-aware valid_quantity_change survived';
  END IF;

  RAISE NOTICE 'PASS 9 failed migration rolled back completely: no columns, functions, constraints or view changes survived';
END $do$;
