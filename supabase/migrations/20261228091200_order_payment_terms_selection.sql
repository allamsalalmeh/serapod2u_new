-- ============================================================================
-- Order payment terms: H2M picks a term from the master data; full prepayment
-- and cash on delivery need no balance payment request.
-- ----------------------------------------------------------------------------
-- Master data is READ ONLY here: public.payment_terms and organizations are
-- not changed. The chosen term is copied into orders.payment_terms (as today).
--
-- 1. order_payment_terms_snapshot(term_id, require_active): the jsonb copied
--    into orders.payment_terms (deposit/balance as fractions + term id, code, name).
-- 2. save_order_with_items gains p_payment_term_id (DEFAULT NULL):
--    * create H2M: the picked term (must be active); otherwise the seller's term
--      as before. D2H / S2D unchanged (phase 2).
--    * update H2M: the term can change while the order is draft/submitted, the
--      only states this function edits, i.e. before the PO is acknowledged.
--    The 14-argument version is replaced (dropped) so PostgREST has one match.
-- 3. fn_create_balance_payment_request: no balance request unless the order is
--    on split terms (0% < deposit < 100%). Full prepayment (100/0) and cash on
--    delivery (0/100) run PO -> Invoice -> Payment -> Receipt.
--
-- Rollback: re-apply 20261028100000_sa_order_creator_policy.sql's version of
-- save_order_with_items (14 args) after dropping the 15-arg one; restore
-- fn_create_balance_payment_request from payterm_defs.txt.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.order_payment_terms_snapshot(p_term_id uuid, p_require_active boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
           'term_id',         pt.id,
           'term_code',       pt.term_code,
           'term_name',       pt.term_name,
           'deposit_pct',     round(pt.deposit_percentage / 100.0, 4),
           'balance_pct',     round(pt.balance_percentage / 100.0, 4),
           'balance_trigger', 'on_first_receive')
  FROM public.payment_terms pt
  WHERE pt.id = p_term_id
    AND (NOT p_require_active OR COALESCE(pt.is_active, false))
$function$;

REVOKE ALL ON FUNCTION public.order_payment_terms_snapshot(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_payment_terms_snapshot(uuid, boolean) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.save_order_with_items(uuid, text, text, timestamptz, uuid, integer, numeric,
  integer, boolean, boolean, boolean, boolean, text, jsonb);

CREATE OR REPLACE FUNCTION public.save_order_with_items(p_order_id uuid, p_mode text, p_requested_status text, p_expected_updated_at timestamp with time zone, p_seller_org_id uuid, p_units_per_case integer, p_qr_buffer_percent numeric, p_extra_qr_master integer, p_has_rfid boolean, p_has_points boolean, p_has_lucky_draw boolean, p_has_redeem boolean, p_notes text, p_items jsonb, p_payment_term_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '4s'
AS $function$
DECLARE
  v_stage         text := 'authorize';
  v_actor         uuid := auth.uid();
  v_actor_org     uuid;
  v_org_type      text;
  v_role_level    integer;
  v_order_type    public.order_type;
  v_company_id    uuid;
  v_warehouse_id  uuid;
  v_payment_terms jsonb;
  v_order         public.orders%ROWTYPE;
  v_item_count    integer;
  v_replayed      boolean := false;
  v_deposit       numeric;
  v_balance       numeric;
  v_term_terms    jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication_required' USING ERRCODE = '28000';
  END IF;
  IF p_mode NOT IN ('create', 'update') THEN
    RAISE EXCEPTION 'invalid_save_mode' USING ERRCODE = '22023';
  END IF;
  IF p_requested_status NOT IN ('draft', 'submitted') THEN
    RAISE EXCEPTION 'invalid_requested_status' USING ERRCODE = '22023';
  END IF;
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION 'order_id_required' USING ERRCODE = '22023';
  END IF;

  -- ---- item payload validation (no row is touched yet) ---------------------
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 200 THEN
    RAISE EXCEPTION 'invalid_items: between 1 and 200 lines required' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) e
    WHERE jsonb_typeof(e) <> 'object'
       OR (e->>'product_id') IS NULL OR (e->>'variant_id') IS NULL
       OR (e->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (e->>'variant_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR (e->>'qty') IS NULL OR (e->>'qty') !~ '^[0-9]{1,9}$' OR (e->>'qty')::bigint < 1
       OR (e->>'qty')::bigint > 100000000
       OR (e->>'unit_price') IS NULL OR (e->>'unit_price') !~ '^[0-9]{1,10}(\.[0-9]{1,4})?$'
       OR (e->>'units_per_case') IS NOT NULL
          AND ((e->>'units_per_case') !~ '^[0-9]{1,6}$' OR (e->>'units_per_case')::int < 1)
  ) THEN
    RAISE EXCEPTION 'invalid_items: each line needs product_id, variant_id, qty >= 1 and unit_price >= 0'
      USING ERRCODE = '22023';
  END IF;
  IF p_units_per_case IS NULL OR p_units_per_case < 1 OR p_units_per_case > 100000
     OR p_qr_buffer_percent IS NULL OR p_qr_buffer_percent < 0 OR p_qr_buffer_percent > 100 THEN
    RAISE EXCEPTION 'invalid_order_configuration' USING ERRCODE = '22023';
  END IF;

  -- ---- actor context (server-derived, never client-supplied) ---------------
  v_actor_org := public.current_user_org_id();
  IF v_actor_org IS NULL THEN
    RAISE EXCEPTION 'actor_has_no_organization' USING ERRCODE = '42501';
  END IF;
  SELECT o.org_type_code INTO v_org_type FROM public.organizations o WHERE o.id = v_actor_org;

  IF p_mode = 'create' THEN
    v_order_type := CASE v_org_type
      WHEN 'HQ'   THEN 'H2M'::public.order_type
      WHEN 'DIST' THEN 'D2H'::public.order_type
      WHEN 'SHOP' THEN 'S2D'::public.order_type
      ELSE NULL END;
    IF v_order_type IS NULL THEN
      RAISE EXCEPTION 'organization_type_cannot_create_orders' USING ERRCODE = '42501';
    END IF;

    IF v_order_type = 'H2M' THEN
      -- same rule as modules/supply-chain/h2m-access.canCreateH2MOrder
      -- HQ + legacy level 40, or the S&A decision once supply_chain.order.create is authoritative
      IF NOT public.sa_actor_may_create_h2m() THEN
        RAISE EXCEPTION 'h2m_orders_require_order_create_access' USING ERRCODE = '42501';
      END IF;
    END IF;

    IF p_seller_org_id IS NULL OR p_seller_org_id = v_actor_org
       OR NOT EXISTS (SELECT 1 FROM public.organizations s WHERE s.id = p_seller_org_id) THEN
      RAISE EXCEPTION 'invalid_seller_organization' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_items) AS i(product_id uuid, variant_id uuid)
    LEFT JOIN public.product_variants pv ON pv.id = i.variant_id AND pv.product_id = i.product_id
    WHERE pv.id IS NULL
  ) THEN
    RAISE EXCEPTION 'invalid_items: variant does not belong to product' USING ERRCODE = '22023';
  END IF;

  IF p_mode = 'create' THEN
    -- ======================= CREATE (idempotent on p_order_id) ===============
    v_stage := 'insert_order';
    v_company_id := COALESCE(public.get_company_id(v_actor_org), v_actor_org);

    IF v_order_type = 'H2M' THEN
      SELECT o.default_warehouse_org_id INTO v_warehouse_id
      FROM public.organizations o WHERE o.id = v_actor_org;
      IF v_warehouse_id IS NULL THEN
        RAISE EXCEPTION 'hq_default_warehouse_missing' USING ERRCODE = '55000';
      END IF;
    END IF;

    v_payment_terms := jsonb_build_object('deposit_pct', 0.5, 'balance_pct', 0.5,
                                          'balance_trigger', 'on_first_receive');
    IF v_order_type = 'H2M' AND p_payment_term_id IS NOT NULL THEN
      -- H2M: the payment term the user picked from the master data (read only).
      v_term_terms := public.order_payment_terms_snapshot(p_payment_term_id, true);
      IF v_term_terms IS NULL THEN
        RAISE EXCEPTION 'invalid_payment_term' USING ERRCODE = '22023';
      END IF;
      v_payment_terms := v_term_terms;
    ELSE
      -- Default: the seller's payment term from the master data.
      v_term_terms := public.order_payment_terms_snapshot(
        (SELECT s.payment_term_id FROM public.organizations s WHERE s.id = p_seller_org_id), false);
      IF v_term_terms IS NOT NULL THEN
        v_payment_terms := v_term_terms;
      END IF;
    END IF;

    INSERT INTO public.orders AS o (
      id, order_type, company_id, buyer_org_id, seller_org_id, warehouse_org_id, status,
      units_per_case, qr_buffer_percent, extra_qr_master,
      has_rfid, has_points, has_lucky_draw, has_redeem,
      payment_terms, notes, created_by
    ) VALUES (
      p_order_id, v_order_type, v_company_id, v_actor_org, p_seller_org_id, v_warehouse_id, 'draft',
      p_units_per_case, p_qr_buffer_percent, GREATEST(0, LEAST(10, COALESCE(p_extra_qr_master, 0))),
      COALESCE(p_has_rfid, false), COALESCE(p_has_points, true),
      COALESCE(p_has_lucky_draw, false), COALESCE(p_has_redeem, false),
      v_payment_terms, p_notes, v_actor
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING * INTO v_order;

    IF NOT FOUND THEN
      -- A previous attempt with this id already committed: replay, don't duplicate.
      SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
      IF NOT FOUND OR v_order.created_by IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'order_id_conflict' USING ERRCODE = '23505';
      END IF;
      v_replayed := true;
    END IF;

    IF NOT v_replayed THEN
      v_stage := 'insert_items';
      INSERT INTO public.order_items (order_id, product_id, variant_id, qty, unit_price, company_id, units_per_case)
      SELECT p_order_id, i.product_id, i.variant_id, i.qty, i.unit_price, v_company_id, i.units_per_case
      FROM jsonb_to_recordset(p_items)
           AS i(product_id uuid, variant_id uuid, qty integer, unit_price numeric, units_per_case integer);

      IF p_requested_status = 'submitted' THEN
        v_stage := 'set_status';
        UPDATE public.orders SET status = 'submitted' WHERE id = p_order_id
        RETURNING * INTO v_order;
      ELSE
        SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
      END IF;
    END IF;

  ELSE
    -- ======================= UPDATE (optimistic lock) ========================
    IF p_expected_updated_at IS NULL THEN
      RAISE EXCEPTION 'expected_updated_at_required' USING ERRCODE = '22023';
    END IF;

    v_stage := 'lock_order';
    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN
      -- also what a cross-organisation caller sees (RLS hides the row)
      RAISE EXCEPTION 'order_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_order.buyer_org_id IS DISTINCT FROM v_actor_org THEN
      RAISE EXCEPTION 'order_not_editable_by_actor' USING ERRCODE = '42501';
    END IF;
    IF v_order.status::text NOT IN ('draft', 'submitted') THEN
      RAISE EXCEPTION 'order_not_editable: status is %', v_order.status USING ERRCODE = '55000';
    END IF;
    IF v_order.updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'order_changed_by_another_save' USING ERRCODE = '40001';
    END IF;
    IF p_seller_org_id IS NULL OR p_seller_org_id = v_order.buyer_org_id
       OR NOT EXISTS (SELECT 1 FROM public.organizations s WHERE s.id = p_seller_org_id) THEN
      RAISE EXCEPTION 'invalid_seller_organization' USING ERRCODE = '22023';
    END IF;

    v_company_id := v_order.company_id;

    -- order_items_write RLS only permits changes while the order is draft, so
    -- the status is dropped to draft for the replacement and restored below,
    -- exactly like the previous client flow but inside one transaction.
    v_stage := 'update_header';
    UPDATE public.orders SET
      seller_org_id = p_seller_org_id, status = 'draft',
      units_per_case = p_units_per_case, qr_buffer_percent = p_qr_buffer_percent,
      extra_qr_master = GREATEST(0, LEAST(10, COALESCE(p_extra_qr_master, 0))),
      has_rfid = COALESCE(p_has_rfid, false), has_points = COALESCE(p_has_points, true),
      has_lucky_draw = COALESCE(p_has_lucky_draw, false), has_redeem = COALESCE(p_has_redeem, false),
      notes = p_notes, updated_by = v_actor
    WHERE id = p_order_id;

    -- H2M payment term may change while the order is draft/submitted (checked above),
    -- i.e. before the manufacturer acknowledges the PO and any amount is issued.
    IF v_order.order_type = 'H2M' AND p_payment_term_id IS NOT NULL THEN
      v_term_terms := public.order_payment_terms_snapshot(p_payment_term_id, true);
      IF v_term_terms IS NULL THEN
        RAISE EXCEPTION 'invalid_payment_term' USING ERRCODE = '22023';
      END IF;
      UPDATE public.orders SET payment_terms = v_term_terms WHERE id = p_order_id;
    END IF;

    v_stage := 'delete_items';
    DELETE FROM public.order_items WHERE order_id = p_order_id;

    v_stage := 'insert_items';
    INSERT INTO public.order_items (order_id, product_id, variant_id, qty, unit_price, company_id, units_per_case)
    SELECT p_order_id, i.product_id, i.variant_id, i.qty, i.unit_price, v_company_id, i.units_per_case
    FROM jsonb_to_recordset(p_items)
         AS i(product_id uuid, variant_id uuid, qty integer, unit_price numeric, units_per_case integer);

    IF p_requested_status = 'submitted' THEN
      v_stage := 'set_status';
      UPDATE public.orders SET status = 'submitted' WHERE id = p_order_id;
    END IF;

    SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  END IF;

  SELECT count(*) INTO v_item_count FROM public.order_items WHERE order_id = p_order_id;

  RETURN jsonb_build_object(
    'order_id',   v_order.id,
    'order_no',   v_order.order_no,
    'status',     v_order.status,
    'updated_at', v_order.updated_at,
    'item_count', v_item_count,
    'replayed',   v_replayed
  );
EXCEPTION
  -- WHEN OTHERS does not match query_canceled (statement_timeout), so it needs its own
  -- clause for the timeout to carry the failing stage. The transaction still rolls back.
  WHEN query_canceled THEN
    RAISE EXCEPTION '%', SQLERRM USING ERRCODE = '57014', DETAIL = 'stage=' || v_stage;
  WHEN OTHERS THEN
    -- Keep the original SQLSTATE/message; add only the failing stage.
    RAISE EXCEPTION '%', SQLERRM USING ERRCODE = SQLSTATE, DETAIL = 'stage=' || v_stage;
END;
$function$;

REVOKE ALL ON FUNCTION public.save_order_with_items(uuid, text, text, timestamptz, uuid, integer, numeric,
  integer, boolean, boolean, boolean, boolean, text, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_order_with_items(uuid, text, text, timestamptz, uuid, integer, numeric,
  integer, boolean, boolean, boolean, boolean, text, jsonb, uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.save_order_with_items(uuid, text, text, timestamptz, uuid, integer, numeric,
  integer, boolean, boolean, boolean, boolean, text, jsonb, uuid) IS
  'Atomic create/update of an order header + items + requested status (SECURITY INVOKER, RLS applies). H2M may pass p_payment_term_id (editable while draft/submitted).';

-- 3. No balance payment request for non-split terms ---------------------------
DO $do$
DECLARE
  v_def    text;
  v_anchor text := E'  v_order_total := public.fn_calculate_order_total(p_order_id);\n  v_requested_amount';
  v_guard  text := E'  -- Only split terms (0% < deposit < 100%) have a balance payment request.\n'
                || E'  BEGIN\n'
                || E'    v_order_total := COALESCE(NULLIF(v_terms ->> ''deposit_pct'', '''')::numeric, 0.5);\n'
                || E'  EXCEPTION WHEN OTHERS THEN\n'
                || E'    v_order_total := 0.5;\n'
                || E'  END;\n'
                || E'  IF v_order_total > 1 THEN v_order_total := v_order_total / 100; END IF;\n'
                || E'  IF v_order_total <= 0.001 OR v_order_total >= 0.999 OR COALESCE(v_balance_pct, 0) <= 0 THEN\n'
                || E'    RETURN NULL;\n'
                || E'  END IF;\n\n';
BEGIN
  v_def := pg_get_functiondef('public.fn_create_balance_payment_request(uuid)'::regprocedure);
  IF position('Only split terms' IN v_def) > 0 THEN
    RAISE NOTICE 'fn_create_balance_payment_request already guarded';
    RETURN;
  END IF;
  IF position(v_anchor IN v_def) = 0 THEN
    RAISE EXCEPTION 'fn_create_balance_payment_request does not contain the expected anchor; refusing to rewrite it';
  END IF;
  v_def := replace(v_def, v_anchor, v_guard || v_anchor);
  EXECUTE v_def;
END
$do$;

COMMIT;
