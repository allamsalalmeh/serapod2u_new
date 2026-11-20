-- ============================================================================
-- Phase 30 — POST-MIGRATION upgrade assertions
-- ----------------------------------------------------------------------------
-- Runs after 20261220100000_inventory_cases_and_pcs.sql has been applied ON TOP
-- of the pre-migration harness. It proves the upgrade preserved every contract
-- the replacement could have broken: the changed OUT row type, the positional
-- caller, ownership/security, grants, read-model column order and the totals
-- math for rows written before the change.
--
-- Everything happens inside one transaction that is rolled back, so it can run
-- before the business scenarios in 20_tests.sql on the same database.
-- ============================================================================

\set ON_ERROR_STOP 1

BEGIN;

DO $do$
DECLARE
  v_result text;
  v_cnt integer;
  v_nargs integer;
  v_lang text;
  v_secdef boolean;
  v_cfg text[];
  v_acl aclitem[];
BEGIN
  ---------------------------------------------------------------------------
  -- 1. _stock_transfer_totals is replaced, not duplicated.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO v_cnt
    FROM pg_proc
   WHERE proname = '_stock_transfer_totals'
     AND pronamespace = 'public'::regnamespace;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'FAIL totals overloads after upgrade: % (expected exactly 1)', v_cnt;
  END IF;

  SELECT pg_get_function_result(p.oid), p.pronargs, l.lanname, p.prosecdef, p.proconfig, p.proacl
    INTO v_result, v_nargs, v_lang, v_secdef, v_cfg, v_acl
    FROM pg_proc p
    JOIN pg_language l ON l.oid = p.prolang
   WHERE p.oid = 'public._stock_transfer_totals(jsonb)'::regprocedure;

  IF v_result IS DISTINCT FROM
     'TABLE(total_items integer, total_pcs integer, total_value numeric)' THEN
    RAISE EXCEPTION 'FAIL totals result after upgrade: %', v_result;
  END IF;
  IF v_lang <> 'sql' OR v_secdef THEN
    RAISE EXCEPTION 'FAIL totals lost its security shape: lang=% secdef=%', v_lang, v_secdef;
  END IF;
  IF v_cfg IS NULL OR NOT (v_cfg @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'FAIL totals lost search_path pinning: %', v_cfg;
  END IF;
  IF v_acl IS NULL THEN
    RAISE EXCEPTION 'FAIL totals ACL became the default (PUBLIC execute) instead of preserving the captured denied baseline';
  END IF;
  IF EXISTS (SELECT 1 FROM aclexplode(v_acl) a
              WHERE a.privilege_type = 'EXECUTE' AND a.grantee = 0)
     OR has_function_privilege('anon', 'public._stock_transfer_totals(jsonb)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL totals preserved neither the PUBLIC nor anon deny posture: %', v_acl;
  END IF;
  IF NOT has_function_privilege('authenticated', 'public._stock_transfer_totals(jsonb)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL totals live ACL capture/replay lost the authenticated canary grant: %', v_acl;
  END IF;
  RAISE NOTICE 'PASS 1.1 totals replaced in place: single function, 3 OUT columns, sql/invoker, search_path pinned, no PUBLIC/anon access, authenticated canary preserved';

  ---------------------------------------------------------------------------
  -- 2. record_stock_movement: the 16-argument overload must be gone, and the
  --    replacement must keep SECURITY DEFINER and its default ACL.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO v_cnt
    FROM pg_proc
   WHERE proname = 'record_stock_movement'
     AND pronamespace = 'public'::regnamespace;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'FAIL record_stock_movement overloads after upgrade: % (stale pre-migration body still callable)', v_cnt;
  END IF;

  SELECT p.pronargs, p.prosecdef, p.proacl
    INTO v_nargs, v_secdef, v_acl
    FROM pg_proc p
   WHERE p.oid = 'public.record_stock_movement(text, uuid, uuid, integer, numeric, uuid, text, text, text, text, uuid, text, uuid, uuid, text[], uuid, integer)'::regprocedure;
  IF v_nargs <> 17 THEN
    RAISE EXCEPTION 'FAIL record_stock_movement arg count after upgrade: %', v_nargs;
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'FAIL record_stock_movement lost SECURITY DEFINER';
  END IF;
  IF v_acl IS NULL THEN
    RAISE EXCEPTION 'FAIL record_stock_movement ACL became the default (PUBLIC execute) - privilege widening';
  END IF;
  IF EXISTS (SELECT 1 FROM aclexplode(v_acl) a WHERE a.grantee = 0) THEN
    RAISE EXCEPTION 'FAIL record_stock_movement grants EXECUTE to PUBLIC';
  END IF;
  IF has_function_privilege('anon',
       'public.record_stock_movement(text, uuid, uuid, integer, numeric, uuid, text, text, text, text, uuid, text, uuid, uuid, text[], uuid, integer)'::regprocedure,
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL anon kept EXECUTE on record_stock_movement';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.record_stock_movement(text, uuid, uuid, integer, numeric, uuid, text, text, text, text, uuid, text, uuid, uuid, text[], uuid, integer)'::regprocedure,
       'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.record_stock_movement(text, uuid, uuid, integer, numeric, uuid, text, text, text, text, uuid, text, uuid, uuid, text[], uuid, integer)'::regprocedure,
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL authenticated/service_role lost EXECUTE on record_stock_movement';
  END IF;

  -- A 16-argument call must now resolve to the 17-argument function through the
  -- default, not to a left-over legacy body.
  IF to_regprocedure('public.record_stock_movement(text, uuid, uuid, integer, numeric, uuid, text, text, text, text, uuid, text, uuid, uuid, text[], uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL legacy 16-argument record_stock_movement still exists';
  END IF;
  RAISE NOTICE 'PASS 1.2 record_stock_movement: single 17-argument function, SECURITY DEFINER kept, EXECUTE still denied to PUBLIC/anon and granted to authenticated/service_role, legacy overload removed';
END $do$;

-- ---------------------------------------------------------------------------
-- 2. Totals math is backward compatible for pre-migration payloads (no 'pcs'
--    key) and correct for piece-aware payloads.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_items integer;
  v_pcs integer;
  v_value numeric;
BEGIN
  -- Exactly the shape the legacy function was written for: quantity + cost only.
  SELECT t.total_items, t.total_pcs, t.total_value
    INTO v_items, v_pcs, v_value
    FROM public._stock_transfer_totals(
      '[{"quantity":3,"cost":14},{"quantity":2,"cost":5}]'::jsonb) t;

  IF v_items <> 5 OR v_pcs <> 0 OR v_value <> 52.00 THEN
    RAISE EXCEPTION 'FAIL legacy totals payload changed: items=% pcs=% value=% (expected 5 / 0 / 52.00)',
      v_items, v_pcs, v_value;
  END IF;
  RAISE NOTICE 'PASS 2.1 legacy payload totals unchanged: 5 items, 0 pcs, RM52.00';

  -- Mixed vector: +1 case / -2 pcs at RM14.00 per case, 4 pcs per case = RM7.00.
  SELECT t.total_items, t.total_pcs, t.total_value
    INTO v_items, v_pcs, v_value
    FROM public._stock_transfer_totals(
      '[{"quantity":1,"pcs":-2,"pcs_per_case":4,"cost":14}]'::jsonb) t;
  IF v_items <> 1 OR v_pcs <> -2 OR v_value <> 7.00 THEN
    RAISE EXCEPTION 'FAIL mixed totals: items=% pcs=% value=% (expected 1 / -2 / 7.00)',
      v_items, v_pcs, v_value;
  END IF;
  RAISE NOTICE 'PASS 2.2 mixed vector values at 1 case - 2 pcs = RM7.00';
END $do$;

-- ---------------------------------------------------------------------------
-- 3. The untouched positional caller still works against the new OUT row:
--    public.save_stock_transfer_draft does
--      SELECT * INTO v_totals FROM public._stock_transfer_totals(v_items)
--    and reads v_totals.total_items / v_totals.total_value. It was NOT modified
--    by this migration, so it is the real compatibility test.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_from uuid := '00000000-0000-0000-0000-0000000000f1'::uuid;
  v_to uuid := '00000000-0000-0000-0000-0000000000f2'::uuid;
  v_user uuid := '00000000-0000-0000-0000-0000000000f3'::uuid;
  v_product uuid := '00000000-0000-0000-0000-0000000000f4'::uuid;
  v_variant uuid := '00000000-0000-0000-0000-0000000000f5'::uuid;
  v_cfg uuid := '00000000-0000-0000-0000-0000000000f6'::uuid;
  v_transfer public.stock_transfers;
BEGIN
  INSERT INTO public.organizations (id, org_name, org_code, org_type_code, is_active)
  VALUES (v_from, 'Upgrade Source', 'UPG1', 'WH', true),
         (v_to, 'Upgrade Destination', 'UPG2', 'WH', true);
  INSERT INTO public.users (id, email, role_code, is_active)
  VALUES (v_user, 'upgrade@example.test', 'SUPER_ADMIN', true);
  INSERT INTO public.products (id, category_id, product_code, product_name, is_vape, units_per_case)
  VALUES (v_product, gen_random_uuid(), 'UPG', 'Upgrade Cartridge', true, 4);
  INSERT INTO public.product_variants (id, product_id, variant_code, variant_name, is_active, is_default, base_cost)
  VALUES (v_variant, v_product, 'UPG-BV', 'Upgrade Variant', true, true, 14.00);
  INSERT INTO public.inventory_stock_configurations
    (id, variant_id, config_code, config_label, stock_sku, status, is_variant_default, default_for_ord, units_per_case)
  VALUES (v_cfg, v_variant, '20NB', '20 mg - New Box', 'UPG-BV-20NB', 'active', true, true, 4);

  SELECT * INTO v_transfer
    FROM public.save_stock_transfer_draft(
      public.get_company_id(v_from), v_from, v_to,
      jsonb_build_array(jsonb_build_object(
        'variant_id', v_variant,
        'stock_config_id', v_cfg,
        'quantity', 2,
        'pcs', 2,
        'cost', 14.00)),
      NULL, NULL, NULL, v_user);

  IF v_transfer.total_items <> 2 THEN
    RAISE EXCEPTION 'FAIL save_stock_transfer_draft total_items: % (expected 2 cases)',
      v_transfer.total_items;
  END IF;
  IF v_transfer.total_value <> 35.00 THEN
    RAISE EXCEPTION 'FAIL save_stock_transfer_draft total_value: % (expected 35.00 = 2 cases + 2 pcs)',
      v_transfer.total_value;
  END IF;
  RAISE NOTICE 'PASS 3.1 unmodified save_stock_transfer_draft read the 3-column totals correctly (% cases / RM%)',
    v_transfer.total_items, v_transfer.total_value;
END $do$;

-- ---------------------------------------------------------------------------
-- 4. Read models: CREATE OR REPLACE VIEW is only legal when the new column list
--    starts with the old one. Assert the old positions are untouched and the new
--    columns are appended.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_cnt integer;
  v_col text;
BEGIN
  SELECT count(*) INTO v_cnt
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'vw_inventory_on_hand';
  IF v_cnt <> 36 THEN
    RAISE EXCEPTION 'FAIL vw_inventory_on_hand columns after upgrade: % (expected 36)', v_cnt;
  END IF;

  SELECT column_name INTO v_col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'vw_inventory_on_hand'
     AND ordinal_position = 1;
  IF v_col <> 'id' THEN
    RAISE EXCEPTION 'FAIL vw_inventory_on_hand column 1 moved: %', v_col;
  END IF;

  SELECT column_name INTO v_col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'vw_inventory_on_hand'
     AND ordinal_position = 13;
  IF v_col <> 'total_value' THEN
    RAISE EXCEPTION 'FAIL vw_inventory_on_hand column 13 moved: % (total_value meaning must not shift)', v_col;
  END IF;

  IF (SELECT array_agg(column_name::text ORDER BY ordinal_position)
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'vw_inventory_on_hand'
         AND ordinal_position BETWEEN 34 AND 36)
     IS DISTINCT FROM ARRAY['pcs_on_hand','pcs_per_case','pcs_value'] THEN
    RAISE EXCEPTION 'FAIL vw_inventory_on_hand appended columns are not (pcs_on_hand, pcs_per_case, pcs_value)';
  END IF;
  RAISE NOTICE 'PASS 4.1 vw_inventory_on_hand: 33 legacy columns kept in place, 3 appended';

  SELECT count(*) INTO v_cnt
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'vw_stock_movements_ordered';
  IF v_cnt <> 39 THEN
    RAISE EXCEPTION 'FAIL vw_stock_movements_ordered columns after upgrade: % (expected 39 = 34 legacy + 5 piece columns)', v_cnt;
  END IF;

  SELECT column_name INTO v_col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'vw_stock_movements_ordered'
     AND ordinal_position = 5;
  IF v_col <> 'reference_no' THEN
    RAISE EXCEPTION 'FAIL vw_stock_movements_ordered column 5 moved: %', v_col;
  END IF;

  SELECT column_name INTO v_col
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'vw_stock_movements_ordered'
     AND ordinal_position = 39;
  IF v_col <> 'net_cost' THEN
    RAISE EXCEPTION 'FAIL vw_stock_movements_ordered last column: % (expected net_cost)', v_col;
  END IF;
  RAISE NOTICE 'PASS 4.2 vw_stock_movements_ordered: 34 legacy columns kept in place, 5 appended';
END $do$;

ROLLBACK;
