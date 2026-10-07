-- ============================================================================
-- Atomic order save: public.save_order_with_items()
-- ----------------------------------------------------------------------------
-- Purpose
--   CreateOrderView used to save an order as 3-5 separate PostgREST requests
--   (header update -> delete order_items -> insert order_items -> status
--   update, or header insert -> item insert -> status update with a
--   best-effort "delete the header" compensation). Any failure, including an
--   8s `authenticated` statement_timeout on the item delete, left the order
--   with earlier steps committed (header flipped to draft, items already gone).
--   This function performs the whole save in ONE transaction: it either
--   commits header + items + requested status together or changes nothing.
--
-- Security model
--   * SECURITY INVOKER: every statement runs as the caller, so the existing
--     RLS policies (orders_*, order_items_write, S&A gates) and the
--     sa_orders_api_write_guard trigger still decide what is allowed.
--   * Actor identity is auth.uid(); the buyer organisation, order type,
--     company, created_by, H2M warehouse and payment terms are derived on the
--     server. None of them are accepted from the client.
--   * Edits only apply to the caller's own (buyer) orders in draft/submitted,
--     matching the UI rule in OrdersView.canEditOrder.
--
-- Concurrency / retries
--   * Update: the order row is locked FOR UPDATE and the caller must present
--     the updated_at it loaded (p_expected_updated_at). A concurrent save
--     that committed first makes the second fail with SQLSTATE 40001
--     (order_changed_by_another_save) instead of silently overwriting it.
--   * Create: the client supplies the new order id once per form submission.
--     A retry of an already committed create (unknown outcome) returns the
--     existing order (replayed = true) rather than creating a duplicate.
--
-- Diagnostics
--   Failures are re-raised with the original SQLSTATE/message and
--   DETAIL = 'stage=<authorize|lock_order|update_header|delete_items|
--   insert_order|insert_items|set_status>' so the failing step is visible
--   without logging any order content.
--
-- Prerequisites / deployment order
--   1. 20261007100000_order_item_fk_indexes_qr_codes.sql   (index first)
--   2. 20261007100100_order_item_fk_indexes_small.sql
--   3. this file
--   4. deploy the app build that calls the function.
--   Without (1) the delete stage is still a full scan of qr_codes per line.
--
-- Rollback
--   DROP FUNCTION public.save_order_with_items(uuid, text, text, timestamptz,
--   uuid, integer, numeric, integer, boolean, boolean, boolean, boolean, text,
--   jsonb); no data is created by this migration. Roll the app back first.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.save_order_with_items(
  p_order_id            uuid,
  p_mode                text,
  p_requested_status    text,
  p_expected_updated_at timestamptz,
  p_seller_org_id       uuid,
  p_units_per_case      integer,
  p_qr_buffer_percent   numeric,
  p_extra_qr_master     integer,
  p_has_rfid            boolean,
  p_has_points          boolean,
  p_has_lucky_draw      boolean,
  p_has_redeem          boolean,
  p_notes               text,
  p_items               jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
SET lock_timeout = '4s'
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
      SELECT r.role_level INTO v_role_level
      FROM public.users u
      JOIN public.roles r ON r.role_code = u.role_code
      WHERE u.id = v_actor;
      IF v_role_level IS NULL OR v_role_level > 40 THEN
        RAISE EXCEPTION 'h2m_orders_require_hq_access_level_40' USING ERRCODE = '42501';
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
    SELECT pt.deposit_percentage, pt.balance_percentage INTO v_deposit, v_balance
    FROM public.organizations s
    JOIN public.payment_terms pt ON pt.id = s.payment_term_id
    WHERE s.id = p_seller_org_id;
    IF v_deposit IS NOT NULL THEN
      v_payment_terms := jsonb_build_object('deposit_pct', v_deposit / 100,
                                            'balance_pct', v_balance / 100,
                                            'balance_trigger', 'on_first_receive');
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
  integer, boolean, boolean, boolean, boolean, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_order_with_items(uuid, text, text, timestamptz, uuid, integer, numeric,
  integer, boolean, boolean, boolean, boolean, text, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.save_order_with_items(uuid, text, text, timestamptz, uuid, integer, numeric,
  integer, boolean, boolean, boolean, boolean, text, jsonb) IS
  'Atomic create/update of an order header + items + requested status (SECURITY INVOKER, RLS applies). Optimistic lock via p_expected_updated_at; create is idempotent on p_order_id.';
