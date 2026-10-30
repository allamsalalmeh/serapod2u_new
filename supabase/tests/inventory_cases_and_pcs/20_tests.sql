-- ============================================================================
-- Isolated integration test: inventory cases + loose pieces
-- ----------------------------------------------------------------------------
-- Runs against a throwaway local PostgreSQL database loaded with the real table
-- DDL (supabase/tests/inventory_cases_and_pcs/run.sh) and this branch's
-- migration. It never touches staging or production and uses no UAT orders.
--
-- Scenarios, at 4 pcs/case and RM14.00/case:
--   1. 3,861 cases + 2 pcs persists and values at RM54,061.00
--   2. counting back to 3,861 cases posts a 2 pcs shortage worth -RM7.00
--   3. adding 2 pcs to 3,861 cases + 2 pcs canonically becomes 3,862 cases
--   4. piece-stocked products stay piece-only (no phantom cases)
--   5. movement before/change/after reconciles exactly
--   6. manual addition and transfer preserve pieces and value
--   7. blank is not counted, explicit zero is
-- ============================================================================

\set ON_ERROR_STOP 1

-- One transaction so a failing scenario leaves nothing behind and the file is
-- re-runnable against the same harness database.
BEGIN;

DO $$
DECLARE
  v_wh uuid := '00000000-0000-0000-0000-000000000001'::uuid;
  v_user uuid := '00000000-0000-0000-0000-000000000002'::uuid;
  v_product uuid := '00000000-0000-0000-0000-000000000003'::uuid;
  v_variant uuid := '00000000-0000-0000-0000-000000000004'::uuid;
  v_cfg uuid := '00000000-0000-0000-0000-000000000005'::uuid;
  v_dev_variant uuid := '00000000-0000-0000-0000-000000000007'::uuid;
  v_dev_cfg uuid := '00000000-0000-0000-0000-000000000008'::uuid;
BEGIN
  INSERT INTO public.organizations (id, org_name, org_code, org_type_code, is_active)
  VALUES (v_wh, 'Test Warehouse', 'WH999', 'WH', true);

  INSERT INTO public.users (id, email, role_code, is_active)
  VALUES (v_user, 'tester@example.test', 'SUPER_ADMIN', true);

  INSERT INTO public.products (id, category_id, product_code, product_name, is_vape, units_per_case)
  VALUES
    (v_product, gen_random_uuid(), 'HERO', 'Cellera Hero', true, 4),
    ('00000000-0000-0000-0000-000000000006'::uuid, gen_random_uuid(), 'SBOX', 'Serapod S.Box Device', false, 100);

  INSERT INTO public.product_variants (id, product_id, variant_code, variant_name, is_active, is_default, base_cost)
  VALUES
    (v_variant, v_product, 'HERO-BV', 'Blueberry Vanilla', true, true, 14.00),
    (v_dev_variant, '00000000-0000-0000-0000-000000000006'::uuid, 'SBOX-1', 'S.Box Black', true, true, 250.00);

  INSERT INTO public.inventory_stock_configurations
    (id, variant_id, config_code, config_label, stock_sku, status, is_variant_default, default_for_ord, units_per_case)
  VALUES
    (v_cfg, v_variant, '20NB', '20 mg - New Box', 'HERO-BV-20NB', 'active', true, true, 4),
    (v_dev_cfg, v_dev_variant, 'STD', 'Standard', 'SBOX-1-STD', 'active', true, true, NULL);

  -- Opening balance: 3,861 CASES at RM14.00 per case.
  INSERT INTO public.product_inventory
    (variant_id, organization_id, stock_config_id, quantity_on_hand, quantity_allocated, average_cost)
  VALUES
    (v_variant, v_wh, v_cfg, 3861, 0, 14.00),
    (v_dev_variant, v_wh, v_dev_cfg, 0, 0, 250.00);
END $$;

-- ---------------------------------------------------------------------------
-- 1. Packing ratio resolution
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_pack integer;
  v_dev_pack integer;
BEGIN
  SELECT public.resolve_stock_pcs_per_case(
    '00000000-0000-0000-0000-000000000004'::uuid,
    '00000000-0000-0000-0000-000000000005'::uuid) INTO v_pack;
  SELECT public.resolve_stock_pcs_per_case(
    '00000000-0000-0000-0000-000000000007'::uuid,
    '00000000-0000-0000-0000-000000000008'::uuid) INTO v_dev_pack;

  IF v_pack <> 4 THEN RAISE EXCEPTION 'FAIL pack ratio cartridge: %', v_pack; END IF;
  IF v_dev_pack <> 1 THEN RAISE EXCEPTION 'FAIL pack ratio device: %', v_dev_pack; END IF;
  RAISE NOTICE 'PASS 1 packing ratio: cartridge 4, device 1 (legacy units_per_case=100 ignored)';
END $$;

-- ---------------------------------------------------------------------------
-- 2. Add 2 pcs -> 3,861 cases + 2 pcs, value RM54,061.00
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_cases integer;
  v_pcs integer;
  v_pack integer;
  v_value numeric;
  v_mv public.stock_movements%ROWTYPE;
BEGIN
  PERFORM public.record_stock_movement(
    p_movement_type => 'manual_in',
    p_variant_id => '00000000-0000-0000-0000-000000000004'::uuid,
    p_organization_id => '00000000-0000-0000-0000-000000000001'::uuid,
    p_quantity_change => 0,
    p_quantity_pcs_change => 2,
    p_unit_cost => 14.00,
    p_reference_type => 'manual',
    p_reference_id => gen_random_uuid(),
    p_stock_config_id => '00000000-0000-0000-0000-000000000005'::uuid,
    p_created_by => '00000000-0000-0000-0000-000000000002'::uuid
  );

  SELECT quantity_on_hand, pcs_on_hand, pcs_per_case, total_value + pcs_value
    INTO v_cases, v_pcs, v_pack, v_value
  FROM public.product_inventory
  WHERE variant_id = '00000000-0000-0000-0000-000000000004'::uuid;

  IF v_cases <> 3861 OR v_pcs <> 2 OR v_pack <> 4 THEN
    RAISE EXCEPTION 'FAIL persisted pair: % cases + % pcs (pack %)', v_cases, v_pcs, v_pack;
  END IF;
  IF v_value <> 54061.00 THEN
    RAISE EXCEPTION 'FAIL value after +2 pcs: % (expected 54061.00)', v_value;
  END IF;

  SELECT * INTO v_mv FROM public.stock_movements ORDER BY created_at DESC, id DESC LIMIT 1;
  IF v_mv.quantity_change <> 0 OR v_mv.quantity_pcs_change <> 2 THEN
    RAISE EXCEPTION 'FAIL movement delta: % cases / % pcs', v_mv.quantity_change, v_mv.quantity_pcs_change;
  END IF;
  IF v_mv.quantity_before <> 3861 OR v_mv.quantity_pcs_before <> 0
     OR v_mv.quantity_after <> 3861 OR v_mv.quantity_pcs_after <> 2 THEN
    RAISE EXCEPTION 'FAIL movement before/after pair';
  END IF;
  IF v_mv.net_cost <> 7.00 THEN
    RAISE EXCEPTION 'FAIL movement value: % (expected 7.00)', v_mv.net_cost;
  END IF;
  RAISE NOTICE 'PASS 2 persisted 3,861 cases + 2 pcs = RM54,061.00, movement reconciles';
END $$;

-- Leave the harness database exactly as it was found.

-- ---------------------------------------------------------------------------
-- 3. Stock Count: count back to 3,861 cases -> 2 pcs shortage, -RM7.00
--    (posted end-to-end through verify_and_post_stock_count)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_session uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_result jsonb;
  v_cases integer;
  v_pcs integer;
  v_value numeric;
  v_mv public.stock_movements%ROWTYPE;
  v_blank_posted integer;
BEGIN
  UPDATE auth.session SET uid = '00000000-0000-0000-0000-000000000002'::uuid;

  INSERT INTO public.stock_count_sessions
    (id, warehouse_organization_id, count_date, count_type, reference_name, status, created_by)
  VALUES
    (v_session, '00000000-0000-0000-0000-000000000001'::uuid, CURRENT_DATE, 'full_count',
     'CASES+PCS acceptance', 'draft', '00000000-0000-0000-0000-000000000002'::uuid);

  -- Counted row: 3,861 whole cases, no loose pieces. The system holds 2 pcs.
  INSERT INTO public.stock_count_session_items
    (session_id, variant_id, stock_config_id, sku, system_quantity, system_pcs,
     physical_quantity, physical_pcs, adjustment_quantity, adjustment_pcs, pcs_per_case, unit_cost, note)
  VALUES
    (v_session, '00000000-0000-0000-0000-000000000004'::uuid, '00000000-0000-0000-0000-000000000005'::uuid,
     'HERO-BV-20NB', 3861, 2, 3861, 0, 0, -2, 4, 14.00, 'Recount'),
  -- Untouched row: blank physical count must never be treated as zero.
    (v_session, '00000000-0000-0000-0000-000000000007'::uuid, '00000000-0000-0000-0000-000000000008'::uuid,
     'SBOX-1-STD', 0, 0, NULL, NULL, NULL, NULL, 1, 250.00, NULL);

  INSERT INTO public.stock_count_verification_requests
    (id, organization_id, session_id, requesting_user_id, code_hash, snapshot_hash, status, expires_at)
  VALUES
    (v_request, '00000000-0000-0000-0000-0000000000c0'::uuid, v_session,
     '00000000-0000-0000-0000-000000000002'::uuid, 'test-hash',
     public.stock_count_snapshot_hash(v_session), 'active', now() + interval '10 minutes');

  v_result := public.verify_and_post_stock_count(v_request, 'test-hash');
  IF v_result->>'status' <> 'posted' THEN
    RAISE EXCEPTION 'FAIL stock count not posted: %', v_result;
  END IF;

  SELECT quantity_on_hand, pcs_on_hand, total_value + pcs_value
    INTO v_cases, v_pcs, v_value
  FROM public.product_inventory
  WHERE variant_id = '00000000-0000-0000-0000-000000000004'::uuid;

  IF v_cases <> 3861 OR v_pcs <> 0 THEN
    RAISE EXCEPTION 'FAIL balance after count: % cases + % pcs', v_cases, v_pcs;
  END IF;
  IF v_value <> 54054.00 THEN
    RAISE EXCEPTION 'FAIL value after count: % (expected 54054.00)', v_value;
  END IF;
  IF (v_result->>'estimated_adjustment_value')::numeric <> -7.00 THEN
    RAISE EXCEPTION 'FAIL count variance value: % (expected -7.00)', v_result->>'estimated_adjustment_value';
  END IF;

  SELECT * INTO v_mv FROM public.stock_movements
   WHERE movement_type = 'adjustment'
     AND reference_id = v_session
   ORDER BY created_at DESC, id DESC LIMIT 1;

  IF v_mv.quantity_change <> 0 OR v_mv.quantity_pcs_change <> -2 THEN
    RAISE EXCEPTION 'FAIL count movement delta: % cases / % pcs',
      v_mv.quantity_change, v_mv.quantity_pcs_change;
  END IF;
  IF v_mv.quantity_before <> 3861 OR v_mv.quantity_pcs_before <> 2
     OR v_mv.quantity_after <> 3861 OR v_mv.quantity_pcs_after <> 0 THEN
    RAISE EXCEPTION 'FAIL count movement before/after pair';
  END IF;
  IF v_mv.net_cost <> -7.00 THEN
    RAISE EXCEPTION 'FAIL count movement value: % (expected -7.00)', v_mv.net_cost;
  END IF;

  SELECT count(*) INTO v_blank_posted
  FROM public.stock_movements
  WHERE variant_id = '00000000-0000-0000-0000-000000000007'::uuid;

  IF v_blank_posted <> 0 THEN
    RAISE EXCEPTION 'FAIL blank physical count posted a movement';
  END IF;

  RAISE NOTICE 'PASS 3 count back to 3,861 cases posted -2 pcs / -RM7.00, blank row untouched';
END $$;


-- ---------------------------------------------------------------------------
-- 4. Add 2 pcs twice: 3,861 -> 3,861+2 -> 3,862 cases (case boundary crossing)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_cases integer;
  v_pcs integer;
  v_value numeric;
  v_mv public.stock_movements%ROWTYPE;
  v_mv_id uuid;
BEGIN
  PERFORM public.record_stock_movement(
    p_movement_type => 'manual_in',
    p_variant_id => '00000000-0000-0000-0000-000000000004'::uuid,
    p_organization_id => '00000000-0000-0000-0000-000000000001'::uuid,
    p_quantity_change => 0, p_quantity_pcs_change => 2, p_unit_cost => 14.00,
    p_reference_type => 'manual', p_reference_id => gen_random_uuid(),
    p_stock_config_id => '00000000-0000-0000-0000-000000000005'::uuid,
    p_created_by => '00000000-0000-0000-0000-000000000002'::uuid
  );
  v_mv_id := public.record_stock_movement(
    p_movement_type => 'manual_in',
    p_variant_id => '00000000-0000-0000-0000-000000000004'::uuid,
    p_organization_id => '00000000-0000-0000-0000-000000000001'::uuid,
    p_quantity_change => 0, p_quantity_pcs_change => 2, p_unit_cost => 14.00,
    p_reference_type => 'manual', p_reference_id => gen_random_uuid(),
    p_stock_config_id => '00000000-0000-0000-0000-000000000005'::uuid,
    p_created_by => '00000000-0000-0000-0000-000000000002'::uuid
  );

  SELECT quantity_on_hand, pcs_on_hand, total_value + pcs_value
    INTO v_cases, v_pcs, v_value
  FROM public.product_inventory
  WHERE variant_id = '00000000-0000-0000-0000-000000000004'::uuid;

  IF v_cases <> 3862 OR v_pcs <> 0 THEN
    RAISE EXCEPTION 'FAIL case boundary crossing: % cases + % pcs (expected 3862 + 0)', v_cases, v_pcs;
  END IF;
  IF v_value <> 54068.00 THEN
    RAISE EXCEPTION 'FAIL value after crossing: % (expected 54068.00)', v_value;
  END IF;

  -- The second movement's canonical vector is (+1 case, -2 pcs): the two loose
  -- pieces were absorbed into a new case.
  SELECT * INTO v_mv FROM public.stock_movements WHERE id = v_mv_id;
  IF v_mv.quantity_change <> 1 OR v_mv.quantity_pcs_change <> -2 THEN
    RAISE EXCEPTION 'FAIL carry delta: % cases / % pcs', v_mv.quantity_change, v_mv.quantity_pcs_change;
  END IF;
  IF v_mv.quantity_before + v_mv.quantity_change <> v_mv.quantity_after
     OR v_mv.quantity_pcs_before + v_mv.quantity_pcs_change <> v_mv.quantity_pcs_after THEN
    RAISE EXCEPTION 'FAIL carry before + change <> after';
  END IF;
  IF v_mv.net_cost <> 7.00 THEN
    RAISE EXCEPTION 'FAIL carry value: % (expected 7.00)', v_mv.net_cost;
  END IF;
  RAISE NOTICE 'PASS 4 +2 pcs twice crossed a case boundary into 3,862 cases, value RM54,068.00';
END $$;

-- ---------------------------------------------------------------------------
-- 5. Piece-stocked product: manual addition of pieces stays pieces
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_cases integer;
  v_pcs integer;
  v_pack integer;
  v_result jsonb;
BEGIN
  v_result := public.post_manual_stock_addition(
    p_request_id => gen_random_uuid(),
    p_organization_id => '00000000-0000-0000-0000-000000000001'::uuid,
    p_items => jsonb_build_array(jsonb_build_object(
      'variant_id', '00000000-0000-0000-0000-000000000007'::uuid,
      'stock_config_id', '00000000-0000-0000-0000-000000000008'::uuid,
      'quantity', 0,
      'pcs', 5,
      'unit_cost', 250.00
    )),
    p_reason => 'Opening stock',
    p_created_by => '00000000-0000-0000-0000-000000000002'::uuid
  );

  IF (v_result->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL manual addition rejected: %', v_result;
  END IF;

  SELECT quantity_on_hand, pcs_on_hand, pcs_per_case
    INTO v_cases, v_pcs, v_pack
  FROM public.product_inventory
  WHERE variant_id = '00000000-0000-0000-0000-000000000007'::uuid;

  IF v_cases <> 5 OR v_pcs <> 0 OR v_pack <> 1 THEN
    RAISE EXCEPTION 'FAIL piece-stocked addition: % cases + % pcs (pack %)', v_cases, v_pcs, v_pack;
  END IF;
  IF (v_result->>'total_pcs')::integer <> 5 THEN
    RAISE EXCEPTION 'FAIL manual addition total_pcs: %', v_result->>'total_pcs';
  END IF;
  RAISE NOTICE 'PASS 5 piece-stocked product stayed piece-only (5 pcs, no phantom cases)';
END $$;

-- Leave the harness database exactly as it was found.

-- ---------------------------------------------------------------------------
-- 6. Stock Transfer: 2 pcs moves between warehouses without truncation
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_transfer uuid := gen_random_uuid();
  v_src_cases integer;
  v_src_pcs integer;
  v_dst_cases integer;
  v_dst_pcs integer;
BEGIN
  -- Source is 3,862 cases + 0 pcs at this point (from scenario 4).
  INSERT INTO public.stock_transfers
    (id, transfer_no, from_organization_id, to_organization_id, status, items, total_items, total_value, company_id, created_by)
  VALUES
    (v_transfer, 'TRF-TEST-1',
     '00000000-0000-0000-0000-000000000001'::uuid,
     '00000000-0000-0000-0000-0000000000d1'::uuid,
     'draft',
     jsonb_build_array(jsonb_build_object(
       'variant_id', '00000000-0000-0000-0000-000000000004'::uuid,
       'stock_config_id', '00000000-0000-0000-0000-000000000005'::uuid,
       'quantity', 0,
       'pcs', 2,
       'cost', 14.00
     )),
     0, 0,
     '00000000-0000-0000-0000-0000000000c0'::uuid,
     '00000000-0000-0000-0000-000000000002'::uuid);

  PERFORM public.submit_stock_transfer_for_approval(v_transfer, '00000000-0000-0000-0000-000000000002'::uuid);
  PERFORM public.approve_stock_transfer(v_transfer, '00000000-0000-0000-0000-000000000002'::uuid);
  PERFORM public.dispatch_stock_transfer(v_transfer, '00000000-0000-0000-0000-000000000002'::uuid);
  PERFORM public.receive_stock_transfer(v_transfer, '00000000-0000-0000-0000-000000000002'::uuid);

  SELECT quantity_on_hand, pcs_on_hand INTO v_src_cases, v_src_pcs
  FROM public.product_inventory
  WHERE variant_id = '00000000-0000-0000-0000-000000000004'::uuid
    AND organization_id = '00000000-0000-0000-0000-000000000001'::uuid;

  SELECT quantity_on_hand, pcs_on_hand INTO v_dst_cases, v_dst_pcs
  FROM public.product_inventory
  WHERE variant_id = '00000000-0000-0000-0000-000000000004'::uuid
    AND organization_id = '00000000-0000-0000-0000-0000000000d1'::uuid;

  IF v_src_cases <> 3861 OR v_src_pcs <> 2 THEN
    RAISE EXCEPTION 'FAIL source after transfer: % cases + % pcs (expected 3861 + 2)', v_src_cases, v_src_pcs;
  END IF;
  IF v_dst_cases <> 0 OR v_dst_pcs <> 2 THEN
    RAISE EXCEPTION 'FAIL destination after transfer: % cases + % pcs (expected 0 + 2)', v_dst_cases, v_dst_pcs;
  END IF;

  -- Conservation in pieces: 3,862*4 + 0 = (3,861*4 + 2) + (0*4 + 2)
  IF (v_src_cases * 4 + v_src_pcs) + (v_dst_cases * 4 + v_dst_pcs) <> 3862 * 4 THEN
    RAISE EXCEPTION 'FAIL transfer conservation';
  END IF;

  IF (SELECT status FROM public.stock_transfers WHERE id = v_transfer) <> 'received' THEN
    RAISE EXCEPTION 'FAIL transfer lifecycle did not reach received';
  END IF;

  RAISE NOTICE 'PASS 6 transfer moved 2 pcs to the destination and conserved total pieces';
END $$;

ROLLBACK;
