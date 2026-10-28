-- ============================================================================
-- Inventory: cases PLUS additional pieces (persisted, valued, movement-tracked)
-- ----------------------------------------------------------------------------
-- WHY THIS MIGRATION EXISTS
--
-- public.product_inventory.quantity_on_hand is an integer that means CASES for
-- cartridge products (Cellera Hero / Zero) and PIECES for every other product.
-- Stock Count, Manual Addition and Stock Transfer could not represent a balance
-- of "3,861 cases + 2 pcs" at all: there was no column for the loose pieces and
-- no unit in which to record a piece-level movement, so operators had to either
-- round the pieces away or invent a case.
--
-- This migration adds exactly one concept: a CANONICAL PAIR
--
--     (quantity_on_hand, pcs_on_hand)   with   0 <= pcs_on_hand < pcs_per_case
--
-- where pcs_per_case is the packing ratio snapshotted on the balance row. For
-- every product that is stocked in pieces pcs_per_case = 1, so pcs_on_hand is
-- always 0 and every existing code path behaves EXACTLY as before.
--
-- STORAGE CONTRACT (deliberately additive — no historical rewrite)
--   * quantity_on_hand keeps its current meaning and stays the authoritative
--     whole-unit balance used by orders, allocations, reservations, QR and the
--     existing views. It is never reinterpreted as pieces.
--   * pcs_on_hand is the loose remainder only; it never reaches pcs_per_case.
--   * stock_movements gains the same pair (before / change / after) plus the
--     packing ratio used, so a movement is self-describing forever.
--   * product_inventory.total_value and stock_movements.total_cost are NOT
--     redefined: they keep their exact current meaning (whole-unit value). The
--     additional piece value is a new generated column (pcs_value / net_cost),
--     so no dependent view has to be dropped and no historical value changes.
--   * No historical row is updated except pcs_per_case, which is backfilled to
--     the packing ratio already implied by master data (1 for piece-stocked
--     products, so their rows are unchanged).
--
-- COSTING
--   average_cost is per stock unit (per case). A piece is worth
--   average_cost / pcs_per_case — never the reverse. Nothing here divides a
--   cost that is already per piece, and nothing is hardcoded.
--
-- MOVEMENT ARITHMETIC
--   A movement records the exact canonical delta vector:
--     quantity_change     = after_cases - before_cases
--     quantity_pcs_change = after_pcs   - before_pcs
--   so before + change = after always holds, and an inverse movement reverses
--   the balance exactly (revert_inventory_on_movement_delete relies on this).
--   For "+2 pcs onto 3,861 cases + 2 pcs" the vector is (+1 case, -2 pcs) with
--   a net piece value of +2 pcs: the pair canonicalises to 3,862 cases + 0 pcs.
--
-- SAFETY
--   * Every write still goes through public.record_stock_movement (SECURITY
--     DEFINER, advisory-locked, weighted average cost).
--   * The closed movement/sign allowlist is preserved and expressed in total
--     pieces, so a zero-case piece movement is legal while a zero-delta one is
--     still rejected.
--   * Insufficient stock is checked on total pieces AND on whole units that are
--     reserved, so a piece outflow can never breach quantity_allocated.
--
-- Forward-only. Prerequisites, compatibility and application order are in
-- docs/inventory/CASES_AND_PCS_IMPLEMENTATION.md.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Ownership contract for the two functions that must be DROPped
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE keeps a function's owner and its ACL. DROP + CREATE keeps
-- neither: the new object belongs to whoever runs the migration and gets a
-- default ACL. Two signatures in this file genuinely cannot be replaced in
-- place, so for those the contract is captured here — read-only, before either
-- DROP — and replayed after the matching CREATE (section 9 for the owner,
-- section 8 for the ACL of the invoker helper):
--
--   * public._stock_transfer_totals(jsonb) — its OUT row type gains total_pcs,
--     and Postgres refuses that in place: 42P13 "cannot change return type of
--     existing function / Row type defined by OUT parameters is different".
--   * public.record_stock_movement(...)    — the new 17th parameter creates a
--     NEW signature, so the 16-argument function is dropped explicitly instead
--     of being left behind as an ambiguous overload.
--
-- Nothing here grants, revokes or CASCADEs: it only records who owned the
-- function so the replacement keeps exactly the same owner. The capture table is
-- transaction-local, and a rollback discards it.
CREATE TEMP TABLE _pcs_function_owners ON COMMIT DROP AS
SELECT DISTINCT ON (p.proname)
       p.proname,
       pg_get_userbyid(p.proowner) AS owner_before
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('record_stock_movement', '_stock_transfer_totals')
 ORDER BY p.proname, p.pronargs;  -- lowest arity = the pre-migration signature

-- ---------------------------------------------------------------------------
-- 1. Packing ratio resolver — the single SQL authority
-- ---------------------------------------------------------------------------
-- Mirrors resolveCaseUnitsPerCase() in app/src/lib/inventory/stock-count-quantity.ts
-- and getUnitsPerCase() in app/src/lib/returns/format.ts:
--
--   * A configuration pack size > 1 is trusted and wins.
--   * Cellera Hero / Zero cartridges default to 4 pcs per case.
--   * Everything else is stocked in pieces (ratio 1), so a legacy
--     products.units_per_case value can never turn a pcs-only product into a
--     case product.
--
-- NOTE: this is NOT orders.units_per_case (that legacy column means
-- cases-per-box, default 100). It is never read here.
CREATE OR REPLACE FUNCTION public.resolve_stock_pcs_per_case(
  p_variant_id uuid,
  p_stock_config_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_product_name text;
  v_config_units integer;
  v_variant_units integer;
BEGIN
  IF p_variant_id IS NULL THEN
    RETURN 1;
  END IF;

  SELECT p.product_name, p.units_per_case
    INTO v_product_name, v_variant_units
  FROM public.product_variants pv
  JOIN public.products p ON p.id = pv.product_id
  WHERE pv.id = p_variant_id;

  IF p_stock_config_id IS NOT NULL THEN
    SELECT c.units_per_case
      INTO v_config_units
    FROM public.inventory_stock_configurations c
    WHERE c.id = p_stock_config_id
      AND c.variant_id = p_variant_id;
  END IF;

  IF COALESCE(v_config_units, 0) > 1 THEN
    RETURN v_config_units;
  END IF;

  -- Cartridge product lines are the only products stocked in cases.
  IF COALESCE(v_product_name, '') ILIKE '%hero%'
     OR COALESCE(v_product_name, '') ILIKE '%zero%' THEN
    IF COALESCE(v_variant_units, 0) > 1 THEN
      RETURN v_variant_units;
    END IF;
    RETURN 4;
  END IF;

  RETURN 1;
END;
$$;

COMMENT ON FUNCTION public.resolve_stock_pcs_per_case(uuid, uuid) IS
  'Pieces per stock case for a variant/configuration: configuration pack size > 1 wins, Cellera Hero/Zero default to 4, everything else is stocked in pieces (1). Never reads orders.units_per_case.';

-- ---------------------------------------------------------------------------
-- 2. product_inventory: the loose piece remainder and its packing ratio
-- ---------------------------------------------------------------------------
ALTER TABLE public.product_inventory
  ADD COLUMN IF NOT EXISTS pcs_on_hand integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pcs_per_case integer NOT NULL DEFAULT 1;

ALTER TABLE public.product_inventory
  DROP CONSTRAINT IF EXISTS product_inventory_pcs_on_hand_check,
  ADD CONSTRAINT product_inventory_pcs_on_hand_check CHECK (pcs_on_hand >= 0),
  DROP CONSTRAINT IF EXISTS product_inventory_pcs_per_case_check,
  ADD CONSTRAINT product_inventory_pcs_per_case_check CHECK (pcs_per_case >= 1),
  -- Canonical form: loose pieces never accumulate into a full case.
  DROP CONSTRAINT IF EXISTS product_inventory_pcs_within_case_check,
  ADD CONSTRAINT product_inventory_pcs_within_case_check CHECK (pcs_on_hand < pcs_per_case);

COMMENT ON COLUMN public.product_inventory.pcs_on_hand IS
  'Loose pieces held on top of quantity_on_hand. Always 0 <= pcs_on_hand < pcs_per_case; a full case is always carried in quantity_on_hand.';
COMMENT ON COLUMN public.product_inventory.pcs_per_case IS
  'Packing ratio this balance is denominated in (pieces per case). 1 for products stocked in pieces, in which case pcs_on_hand is always 0.';

-- Value of the loose pieces under the SAME cost authority as total_value.
-- total_value itself is untouched so every dependent view keeps its meaning;
-- inventory value = total_value + pcs_value.
ALTER TABLE public.product_inventory
  ADD COLUMN IF NOT EXISTS pcs_value numeric(15,2)
    GENERATED ALWAYS AS (
      CASE
        WHEN pcs_on_hand = 0 OR average_cost IS NULL THEN 0::numeric
        ELSE round((pcs_on_hand::numeric * average_cost) / pcs_per_case::numeric, 2)
      END
    ) STORED;

COMMENT ON COLUMN public.product_inventory.pcs_value IS
  'Value of pcs_on_hand at average_cost / pcs_per_case. Add to total_value for the exact inventory value.';

-- Backfill the ratio already implied by master data. Piece-stocked products
-- resolve to 1, so their rows are byte-identical to before this migration.
DO $$
DECLARE
  v_row record;
  v_pack integer;
BEGIN
  FOR v_row IN
    SELECT id, variant_id, stock_config_id
    FROM public.product_inventory
  LOOP
    v_pack := public.resolve_stock_pcs_per_case(v_row.variant_id, v_row.stock_config_id);
    IF v_pack <> 1 THEN
      UPDATE public.product_inventory SET pcs_per_case = v_pack WHERE id = v_row.id;
    END IF;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.resolve_stock_pcs_per_case(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_stock_pcs_per_case(uuid, uuid) TO authenticated, service_role;



-- ---------------------------------------------------------------------------
-- 3. stock_movements: the same pair, immutable per movement
-- ---------------------------------------------------------------------------
ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS quantity_pcs_change integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity_pcs_before integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quantity_pcs_after integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pcs_per_case integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.stock_movements.quantity_pcs_change IS
  'Loose-piece part of this movement. quantity_before + quantity_change / quantity_pcs_before + quantity_pcs_change equal the stored after values exactly.';
COMMENT ON COLUMN public.stock_movements.pcs_per_case IS
  'Packing ratio in force when the movement was posted, so piece value stays reproducible even if master data changes later.';

ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS net_cost numeric(15,2)
    GENERATED ALWAYS AS (
      round(
        quantity_change::numeric * COALESCE(unit_cost, 0)
        + (quantity_pcs_change::numeric * COALESCE(unit_cost, 0)) / pcs_per_case::numeric,
        2
      )
    ) STORED;

COMMENT ON COLUMN public.stock_movements.net_cost IS
  'SIGNED value of this movement over both units: cases*unit_cost + pcs*unit_cost/pcs_per_case. A mixed vector such as +1 case / -2 pcs values at one case minus two pieces. For movements without loose pieces abs(net_cost) equals the unchanged total_cost.';

-- The closed allowlist is preserved, but expressed in TOTAL PIECES so a
-- piece-only movement (zero whole units) is legal while a zero-delta movement
-- is still impossible. Historical rows have pcs_per_case = 1 and
-- quantity_pcs_change = 0, so this is exactly the previous rule for them.
ALTER TABLE public.stock_movements
  DROP CONSTRAINT IF EXISTS valid_quantity_change;

ALTER TABLE public.stock_movements
  ADD CONSTRAINT valid_quantity_change CHECK (
    (
      movement_type = ANY (ARRAY[
        'addition','transfer_in','order_cancelled','manual_in','scratch_game_in',
        'spin_wheel_in','allocation','warranty_bonus','repack_in'
      ]::text[])
      AND (quantity_change::bigint * pcs_per_case::bigint + quantity_pcs_change::bigint) > 0
    )
    OR (
      movement_type = 'adjustment'
      AND (quantity_change::bigint * pcs_per_case::bigint + quantity_pcs_change::bigint) <> 0
    )
    OR (
      movement_type = ANY (ARRAY[
        'transfer_out','order_fulfillment','manual_out','scratch_game_out',
        'spin_wheel_out','deallocation','repack_out'
      ]::text[])
      AND (quantity_change::bigint * pcs_per_case::bigint + quantity_pcs_change::bigint) < 0
    )
  ) NOT VALID;

ALTER TABLE public.stock_movements VALIDATE CONSTRAINT valid_quantity_change;

COMMENT ON CONSTRAINT valid_quantity_change ON public.stock_movements IS
  'Closed movement/sign allowlist expressed in total pieces (quantity_change * pcs_per_case + quantity_pcs_change). Positive inbound, negative outbound, nonzero adjustment. Includes Scratch Card and Spin Wheel campaign flows.';

-- ---------------------------------------------------------------------------
-- 4. Stock Count / Stock Adjustment line detail
-- ---------------------------------------------------------------------------
ALTER TABLE public.stock_count_session_items
  ADD COLUMN IF NOT EXISTS system_pcs integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS physical_pcs integer,
  ADD COLUMN IF NOT EXISTS adjustment_pcs integer,
  ADD COLUMN IF NOT EXISTS pcs_per_case integer NOT NULL DEFAULT 1;

ALTER TABLE public.stock_count_session_items
  DROP CONSTRAINT IF EXISTS stock_count_session_items_physical_pcs_check,
  ADD CONSTRAINT stock_count_session_items_physical_pcs_check
    CHECK (physical_pcs IS NULL OR (physical_pcs >= 0 AND physical_pcs < pcs_per_case));

COMMENT ON COLUMN public.stock_count_session_items.physical_pcs IS
  'Loose pieces entered in the Physical Count Pcs box. NULL means not counted (never zero); together with physical_quantity it is the total physical On Hand.';
COMMENT ON COLUMN public.stock_count_session_items.adjustment_pcs IS
  'Loose-piece variance. physical_pcs - system_pcs, kept separate from the whole-case variance so a piece shortage is never rounded away.';

ALTER TABLE public.stock_adjustment_items
  ADD COLUMN IF NOT EXISTS system_pcs integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS physical_pcs integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS adjustment_pcs integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pcs_per_case integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.stock_adjustment_items.adjustment_pcs IS
  'Loose-piece variance posted by the Stock Count. Historical rows are 0.';

-- ---------------------------------------------------------------------------
-- 5. record_stock_movement — the single authoritative balance writer
-- ---------------------------------------------------------------------------
-- Body is the live definition with one addition: an optional loose-piece
-- quantity. With p_quantity_pcs_change = 0 (every caller that has not been
-- taught about pieces) the arithmetic is identical to the previous body,
-- because pcs_per_case = 1 forces pcs_on_hand to stay 0.

-- The extra defaulted parameter creates a NEW signature, so the 16-argument
-- one is dropped explicitly rather than left as an ambiguous overload.
DROP FUNCTION IF EXISTS public.record_stock_movement(
  text, uuid, uuid, integer, numeric, uuid, text, text, text, text,
  uuid, text, uuid, uuid, text[], uuid
);

CREATE OR REPLACE FUNCTION public.record_stock_movement(
  p_movement_type text,
  p_variant_id uuid,
  p_organization_id uuid,
  p_quantity_change integer,
  p_unit_cost numeric DEFAULT NULL::numeric,
  p_manufacturer_id uuid DEFAULT NULL::uuid,
  p_warehouse_location text DEFAULT NULL::text,
  p_reason text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
  p_reference_type text DEFAULT 'manual'::text,
  p_reference_id uuid DEFAULT NULL::uuid,
  p_reference_no text DEFAULT NULL::text,
  p_company_id uuid DEFAULT NULL::uuid,
  p_created_by uuid DEFAULT NULL::uuid,
  p_evidence_urls text[] DEFAULT NULL::text[],
  p_stock_config_id uuid DEFAULT NULL::uuid,
  p_quantity_pcs_change integer DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_movement_id uuid;
  v_current_qty integer;
  v_current_avg_cost numeric;
  v_new_qty integer;
  v_inventory_id uuid;
  v_company_id uuid;
  v_from_org uuid := NULL;
  v_to_org uuid := NULL;
  v_final_unit_cost numeric;
  v_normalized_type text;
  v_config_id uuid;

  -- Piece-aware arithmetic.
  v_qty_change integer := COALESCE(p_quantity_change, 0);
  v_pcs_change integer := COALESCE(p_quantity_pcs_change, 0);
  v_net_pieces bigint;
  v_pack integer;
  v_stored_pack integer;
  v_pcs_before integer := 0;
  v_pcs_after integer := 0;
  v_cases_change integer := 0;
  v_pcs_delta integer := 0;
  v_total_before bigint := 0;
  v_total_after bigint := 0;
  v_allocated integer := 0;
  v_old_value numeric := 0;
  v_delta_value numeric := 0;
  v_new_avg_cost numeric;
BEGIN
  IF v_qty_change = 0 AND v_pcs_change = 0 THEN
    RAISE EXCEPTION 'quantity_change must be non-zero';
  END IF;

  v_normalized_type := lower(trim(p_movement_type));
  v_final_unit_cost := CASE
    WHEN v_normalized_type = 'warranty_bonus' THEN 0
    ELSE p_unit_cost
  END;

  -- Resolve configuration: explicit > variant catch-all default.
  v_config_id := COALESCE(p_stock_config_id, public.resolve_operational_stock_config(p_variant_id));
  IF v_config_id IS NULL THEN
    RAISE EXCEPTION 'No stock configuration found for variant %', p_variant_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.inventory_stock_configurations c
    WHERE c.id = v_config_id AND c.variant_id = p_variant_id
  ) THEN
    RAISE EXCEPTION 'Stock configuration % does not belong to variant %', v_config_id, p_variant_id;
  END IF;

  v_pack := public.resolve_stock_pcs_per_case(p_variant_id, v_config_id);

  -- Net direction in pieces: a piece-only movement (zero cases) is honoured.
  v_net_pieces := v_qty_change::bigint * v_pack::bigint + v_pcs_change::bigint;
  IF v_net_pieces = 0 THEN
    RAISE EXCEPTION 'quantity_change must be non-zero';
  END IF;
  IF v_net_pieces < 0 THEN
    v_from_org := p_organization_id;
  ELSE
    v_to_org := p_organization_id;
  END IF;

  v_company_id := public.get_company_id(p_organization_id);
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve company for organization %', p_organization_id;
  END IF;
  IF p_company_id IS NOT NULL AND p_company_id IS DISTINCT FROM v_company_id THEN
    RAISE EXCEPTION 'Company % does not own organization %', p_company_id, p_organization_id;
  END IF;

  IF auth.role() = 'authenticated' THEN
    IF auth.uid() IS NULL OR p_created_by IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'created_by must match the authenticated user';
    END IF;
    IF NOT (public.can_access_org(p_organization_id) OR public.is_hq_admin()) THEN
      RAISE EXCEPTION 'User cannot post stock movement for organization %', p_organization_id;
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', v_company_id::text, p_organization_id::text, p_variant_id::text, v_config_id::text),
    0
  ));

  SELECT id, quantity_on_hand, average_cost, pcs_per_case, pcs_on_hand, quantity_allocated
    INTO v_inventory_id, v_current_qty, v_current_avg_cost, v_stored_pack, v_pcs_before, v_allocated
    FROM public.product_inventory
   WHERE variant_id = p_variant_id
     AND organization_id = p_organization_id
     AND stock_config_id = v_config_id
     AND is_active = true
   FOR UPDATE;

  IF v_inventory_id IS NULL THEN
    IF v_net_pieces < 0 THEN
      RAISE EXCEPTION 'Inventory not found for outgoing movement (organization %, variant %, configuration %)',
        p_organization_id, p_variant_id, v_config_id;
    END IF;

    INSERT INTO public.product_inventory (
      variant_id,
      organization_id,
      stock_config_id,
      quantity_on_hand,
      quantity_allocated,
      pcs_on_hand,
      pcs_per_case,
      warehouse_location,
      average_cost,
      created_at,
      updated_at
    ) VALUES (
      p_variant_id,
      p_organization_id,
      v_config_id,
      0,
      0,
      0,
      v_pack,
      p_warehouse_location,
      v_final_unit_cost,
      now(),
      now()
    )
    RETURNING id, quantity_on_hand INTO v_inventory_id, v_current_qty;

    v_current_qty := 0;
    v_current_avg_cost := v_final_unit_cost;
    v_pcs_before := 0;
    v_allocated := 0;
    v_stored_pack := v_pack;
  END IF;

  -- Existing loose pieces are denominated in the ratio stored on the row. A
  -- packing change is adopted only while the row holds no loose pieces; with
  -- pieces on hand it fails closed instead of silently re-valuing them.
  IF v_stored_pack IS NOT NULL AND v_stored_pack <> v_pack THEN
    IF v_pcs_before <> 0 THEN
      RAISE EXCEPTION
        'Packing ratio for variant % changed from % to % while % loose pcs are on hand. Reconcile the balance before posting.',
        p_variant_id, v_stored_pack, v_pack, v_pcs_before;
    END IF;
  ELSE
    v_pack := COALESCE(v_stored_pack, v_pack);
  END IF;

  -- Canonical pair <-> total pieces. This is the only place the two units are
  -- added together, and it happens in integer pieces.
  v_total_before := v_current_qty::bigint * v_pack::bigint + v_pcs_before::bigint;
  v_total_after := v_total_before + v_net_pieces;

  IF v_total_after < 0 THEN
    RAISE EXCEPTION 'Insufficient stock. Current: % cases + % pcs, requested change: % cases + % pcs',
      v_current_qty, v_pcs_before, v_qty_change, v_pcs_change;
  END IF;

  v_new_qty := (v_total_after / v_pack)::integer;
  v_pcs_after := (v_total_after - (v_new_qty::bigint * v_pack::bigint))::integer;

  -- Reserved stock is held in whole units, so a piece outflow must never take
  -- the case balance below what is already promised to a transfer or order.
  IF v_new_qty < v_allocated THEN
    RAISE EXCEPTION
      'Insufficient available stock: % cases are reserved but the movement would leave % cases',
      v_allocated, v_new_qty;
  END IF;

  -- The movement records the exact canonical delta, so before + change = after.
  v_cases_change := v_new_qty - v_current_qty;
  v_pcs_delta := v_pcs_after - v_pcs_before;

  IF v_final_unit_cost IS NOT NULL AND (v_cases_change > 0 OR v_pcs_delta > 0) AND v_total_after > 0 THEN
    v_old_value := v_current_qty::numeric * COALESCE(v_current_avg_cost, 0)
                 + (v_pcs_before::numeric * COALESCE(v_current_avg_cost, 0) / v_pack::numeric);
    v_delta_value := v_cases_change::numeric * v_final_unit_cost
                   + (v_pcs_delta::numeric * v_final_unit_cost / v_pack::numeric);
    v_new_avg_cost := round(
      (v_old_value + v_delta_value) / (v_total_after::numeric / v_pack::numeric),
      2
    );
  END IF;

  INSERT INTO public.stock_movements (
    movement_type,
    reference_type,
    reference_id,
    reference_no,
    variant_id,
    stock_config_id,
    from_organization_id,
    to_organization_id,
    quantity_change,
    quantity_before,
    quantity_after,
    quantity_pcs_change,
    quantity_pcs_before,
    quantity_pcs_after,
    pcs_per_case,
    unit_cost,
    manufacturer_id,
    warehouse_location,
    reason,
    notes,
    company_id,
    created_by,
    evidence_urls
  ) VALUES (
    p_movement_type,
    p_reference_type,
    p_reference_id,
    p_reference_no,
    p_variant_id,
    v_config_id,
    v_from_org,
    v_to_org,
    v_cases_change,
    v_current_qty,
    v_new_qty,
    v_pcs_delta,
    v_pcs_before,
    v_pcs_after,
    v_pack,
    v_final_unit_cost,
    p_manufacturer_id,
    p_warehouse_location,
    p_reason,
    p_notes,
    v_company_id,
    p_created_by,
    p_evidence_urls
  )
  RETURNING id INTO v_movement_id;

  UPDATE public.product_inventory
     SET quantity_on_hand = v_new_qty,
         pcs_on_hand = v_pcs_after,
         pcs_per_case = v_pack,
         updated_at = now(),
         average_cost = COALESCE(v_new_avg_cost, average_cost)
   WHERE id = v_inventory_id;

  RETURN v_movement_id;
END;
$$;

COMMENT ON FUNCTION public.record_stock_movement(text, uuid, uuid, integer, numeric, uuid, text, text, text, text, uuid, text, uuid, uuid, text[], uuid, integer) IS
  'Single authoritative balance writer. Maintains the canonical pair (quantity_on_hand whole units, pcs_on_hand loose pieces below pcs_per_case) and records the exact delta vector with its packing ratio. Weighted average cost stays per stock unit.';

REVOKE ALL ON FUNCTION public.record_stock_movement(text, uuid, uuid, integer, numeric, uuid, text, text, text, text, uuid, text, uuid, uuid, text[], uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_stock_movement(text, uuid, uuid, integer, numeric, uuid, text, text, text, text, uuid, text, uuid, uuid, text[], uuid, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Stock Count snapshot hash — pieces are part of the signed snapshot
-- ---------------------------------------------------------------------------
-- A draft whose loose-piece count changed must invalidate a prepared OTP,
-- exactly like a changed case count does.
CREATE OR REPLACE FUNCTION public.stock_count_snapshot_hash(p_session_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT encode(extensions.digest(convert_to(jsonb_build_object(
    'session', jsonb_build_object(
      'warehouse', s.warehouse_organization_id,
      'count_date', s.count_date,
      'count_type', s.count_type,
      'reference', coalesce(s.reference_name, ''),
      'posting_note', coalesce(s.notes, ''),
      'status', s.status
    ),
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'variant_id', i.variant_id,
        'sku', coalesce(i.sku, ''),
        'system_quantity', i.system_quantity,
        'system_pcs', coalesce(i.system_pcs, 0),
        'current_system_quantity', coalesce(pi.quantity_on_hand, 0),
        'current_system_pcs', coalesce(pi.pcs_on_hand, 0),
        'physical_quantity', i.physical_quantity,
        'physical_pcs', i.physical_pcs,
        'adjustment_quantity', i.adjustment_quantity,
        'adjustment_pcs', i.adjustment_pcs,
        'unit_cost_snapshot', i.unit_cost,
        'current_variant_base_cost', pv.base_cost,
        'note', coalesce(i.note, '')
      ) ORDER BY i.variant_id)
      FROM public.stock_count_session_items i
      JOIN public.product_variants pv ON pv.id = i.variant_id
      LEFT JOIN public.product_inventory pi
        ON pi.variant_id = i.variant_id
       AND pi.organization_id = s.warehouse_organization_id
       AND pi.is_active = true
      WHERE i.session_id = s.id
    ), '[]'::jsonb)
  )::text, 'UTF8'), 'sha256'), 'hex')
  FROM public.stock_count_sessions s
  WHERE s.id = p_session_id
$$;

COMMENT ON FUNCTION public.stock_count_snapshot_hash(uuid) IS
  'Signed snapshot of a Stock Count draft including loose-piece balances and variances; any change invalidates a prepared verification code.';


-- ---------------------------------------------------------------------------
-- 7. verify_and_post_stock_count — post the loose-piece variance too
-- ---------------------------------------------------------------------------
-- Only the aggregate and the two loops change. Authorisation, OTP consumption,
-- snapshot comparison and the atomic session transition are untouched.
CREATE OR REPLACE FUNCTION public.verify_and_post_stock_count(p_request_id uuid, p_code_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '300s'
SET lock_timeout TO '30s'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_request public.stock_count_verification_requests%ROWTYPE;
  v_session public.stock_count_sessions%ROWTYPE;
  v_item record;
  v_current_snapshot text;
  v_adjustment_id uuid;
  v_reason_id uuid;
  v_company_id uuid;
  v_counted integer;
  v_variances integer;
  v_net integer;
  v_net_pcs integer;
  v_value numeric(15,2);
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'unauthorized'; END IF;
  SELECT * INTO v_request FROM public.stock_count_verification_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_request.requesting_user_id <> v_user_id THEN
    RAISE EXCEPTION 'invalid_verification_code';
  END IF;
  SELECT * INTO v_session FROM public.stock_count_sessions WHERE id = v_request.session_id FOR UPDATE;
  IF v_session.status = 'posted' THEN RAISE EXCEPTION 'stock_count_already_posted'; END IF;
  IF v_session.count_type = 'initial_configuration_classification' THEN
    RAISE EXCEPTION 'stock_count_wrong_posting_function';
  END IF;

  IF v_request.status = 'posted' OR v_request.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'verification_code_already_used';
  END IF;
  IF v_request.status = 'expired' OR v_request.expires_at <= now() THEN
    UPDATE public.stock_count_verification_requests
      SET status = 'expired'
    WHERE id = p_request_id AND status <> 'expired';
    RETURN jsonb_build_object('error_code', 'verification_code_expired');
  END IF;
  IF v_request.status <> 'active' THEN
    RAISE EXCEPTION 'invalid_verification_code';
  END IF;
  IF NOT public.stock_count_user_can_post(v_user_id, v_session.warehouse_organization_id) THEN
    RAISE EXCEPTION 'permission_lost';
  END IF;

  -- Use the ledger's advisory-lock order before taking row locks.
  v_company_id := public.get_company_id(v_session.warehouse_organization_id);
  IF v_company_id IS NULL THEN RAISE EXCEPTION 'organization_mismatch'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', v_company_id::text, v_session.warehouse_organization_id::text,
              i.variant_id::text, i.stock_config_id::text), 0
  ))
  FROM public.stock_count_session_items i
  WHERE i.session_id = v_session.id
    AND (i.physical_quantity IS NOT NULL OR i.physical_pcs IS NOT NULL)
  ORDER BY i.stock_config_id, i.variant_id;

  PERFORM 1
  FROM public.product_inventory pi
  JOIN public.stock_count_session_items i
    ON i.variant_id = pi.variant_id
   AND i.stock_config_id = pi.stock_config_id
  WHERE i.session_id = v_session.id
    AND pi.organization_id = v_session.warehouse_organization_id
    AND pi.is_active = true
    AND (i.physical_quantity IS NOT NULL OR i.physical_pcs IS NOT NULL)
  ORDER BY i.stock_config_id, i.variant_id
  FOR UPDATE OF pi;


  v_current_snapshot := public.stock_count_snapshot_hash(v_session.id);
  IF v_current_snapshot IS DISTINCT FROM v_request.snapshot_hash THEN
    UPDATE public.stock_count_verification_requests
      SET status = 'invalidated', invalidated_at = now(), snapshot_mismatch = true
    WHERE id = p_request_id;
    RETURN jsonb_build_object('error_code', 'stock_count_snapshot_changed');
  END IF;
  IF p_code_hash IS DISTINCT FROM v_request.code_hash THEN
    UPDATE public.stock_count_verification_requests
    SET failed_attempt_count = least(failed_attempt_count + 1, 5),
        status = CASE WHEN failed_attempt_count + 1 >= 5 THEN 'too_many_attempts' ELSE status END,
        invalidated_at = CASE WHEN failed_attempt_count + 1 >= 5 THEN now() ELSE invalidated_at END
    WHERE id = p_request_id;
    RETURN jsonb_build_object('error_code', 'invalid_verification_code');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.stock_count_session_items
    WHERE session_id = v_session.id
      AND (physical_quantity IS NOT NULL OR physical_pcs IS NOT NULL)
      AND stock_config_id IS NULL
  ) THEN RAISE EXCEPTION 'stock_count_config_identity_missing'; END IF;

  SELECT count(*) FILTER (WHERE physical_quantity IS NOT NULL OR physical_pcs IS NOT NULL),
         count(*) FILTER (WHERE coalesce(adjustment_quantity, 0) <> 0 OR coalesce(adjustment_pcs, 0) <> 0),
         coalesce(sum(adjustment_quantity) FILTER (WHERE physical_quantity IS NOT NULL OR physical_pcs IS NOT NULL), 0),
         coalesce(sum(adjustment_pcs) FILTER (WHERE physical_quantity IS NOT NULL OR physical_pcs IS NOT NULL), 0),
         coalesce(sum(
           (adjustment_quantity * unit_cost)
           + round((coalesce(adjustment_pcs, 0) * unit_cost) / greatest(pcs_per_case, 1), 2)
         ) FILTER (WHERE physical_quantity IS NOT NULL OR physical_pcs IS NOT NULL), 0)
  INTO v_counted, v_variances, v_net, v_net_pcs, v_value
  FROM public.stock_count_session_items WHERE session_id = v_session.id;

  FOR v_item IN
    SELECT i.*, pi.warehouse_location
    FROM public.stock_count_session_items i
    JOIN public.product_inventory pi
      ON pi.variant_id = i.variant_id
     AND pi.organization_id = v_session.warehouse_organization_id
     AND pi.stock_config_id = i.stock_config_id
     AND pi.is_active = true
    WHERE i.session_id = v_session.id
      AND (coalesce(i.adjustment_quantity, 0) <> 0 OR coalesce(i.adjustment_pcs, 0) <> 0)
    ORDER BY i.stock_config_id, i.variant_id
  LOOP
    PERFORM public.record_stock_movement(
      p_movement_type => 'adjustment', p_variant_id => v_item.variant_id,
      p_organization_id => v_session.warehouse_organization_id,
      p_quantity_change => coalesce(v_item.adjustment_quantity, 0),
      p_quantity_pcs_change => coalesce(v_item.adjustment_pcs, 0),
      p_unit_cost => v_item.unit_cost,
      p_manufacturer_id => NULL, p_warehouse_location => v_item.warehouse_location,
      p_reason => 'Stock count ' || replace(v_session.count_type, '_', ' '),
      p_notes => coalesce(v_item.note, 'Stock count posting'), p_reference_type => 'adjustment',
      p_reference_id => v_session.id,
      p_reference_no => coalesce(v_session.reference_name, 'Stock Count ' || v_session.count_date::text),
      p_company_id => v_request.organization_id, p_created_by => v_user_id,
      p_evidence_urls => NULL, p_stock_config_id => v_item.stock_config_id
    );
  END LOOP;


  SELECT id INTO v_reason_id FROM public.stock_adjustment_reasons
  WHERE is_active = true AND reason_name ILIKE '%count%' ORDER BY created_at LIMIT 1;
  INSERT INTO public.stock_adjustments (organization_id, reason_id, notes, status, created_by, manufacturer_status)
  VALUES (v_session.warehouse_organization_id, v_reason_id, v_session.notes, 'completed', v_user_id, 'draft')
  RETURNING id INTO v_adjustment_id;

  INSERT INTO public.stock_adjustment_items (
    adjustment_id, variant_id, stock_config_id, system_quantity,
    physical_quantity, adjustment_quantity, unit_cost,
    system_pcs, physical_pcs, adjustment_pcs, pcs_per_case
  )
  SELECT v_adjustment_id, variant_id, stock_config_id, system_quantity,
         physical_quantity, adjustment_quantity, unit_cost,
         coalesce(system_pcs, 0), coalesce(physical_pcs, 0),
         coalesce(adjustment_pcs, 0), greatest(pcs_per_case, 1)
  FROM public.stock_count_session_items
  WHERE session_id = v_session.id
    AND (coalesce(adjustment_quantity, 0) <> 0 OR coalesce(adjustment_pcs, 0) <> 0);

  UPDATE public.stock_count_sessions SET
    status = 'posted', posted_by = v_user_id, posted_at = now(), total_variants_counted = v_counted,
    variance_items = v_variances, net_quantity_adjustment = v_net, estimated_adjustment_value = v_value,
    updated_by = v_user_id, updated_at = now()
  WHERE id = v_session.id AND status = 'draft';
  IF NOT FOUND THEN RAISE EXCEPTION 'stock_count_already_posted'; END IF;

  UPDATE public.stock_count_verification_requests SET
    status = 'posted', verified_by = v_user_id, verified_at = now(), consumed_at = now(),
    code_hash = encode(extensions.digest(extensions.gen_random_bytes(32), 'sha256'), 'hex'),
    posting_result = jsonb_build_object(
      'status','posted','movement_count',v_variances,'adjustment_id',v_adjustment_id,
      'net_pcs', v_net_pcs
    )
  WHERE id = p_request_id;
  UPDATE public.stock_count_verification_requests SET status = 'invalidated', invalidated_at = now()
  WHERE session_id = v_session.id AND id <> p_request_id AND status IN ('pending_delivery','active');

  RETURN jsonb_build_object(
    'status','posted','session_id',v_session.id,'movement_count',v_variances,
    'net_quantity_adjustment', v_net, 'net_pcs_adjustment', v_net_pcs,
    'estimated_adjustment_value', v_value
  );
END;
$$;

COMMENT ON FUNCTION public.verify_and_post_stock_count(uuid, text) IS
  'Atomically posts verified Stock Count variances (whole units AND loose pieces) to exact warehouse/variant/stock-configuration balances. Rejects initial_configuration_classification sessions.';


-- ---------------------------------------------------------------------------
-- 8. post_manual_stock_addition — optional pieces per line
-- ---------------------------------------------------------------------------
-- The signature is unchanged: each line may carry an extra "pcs" key in the
-- existing jsonb payload. A line may be pieces only (quantity 0), which is what
-- "add 2 pcs" means. Everything else (exact configuration targeting,
-- authorization, idempotent replay, batch reference, all-or-nothing rollback)
-- is untouched.
CREATE OR REPLACE FUNCTION public.post_manual_stock_addition(
  p_request_id uuid,
  p_organization_id uuid,
  p_items jsonb,
  p_reason text,
  p_external_reference text DEFAULT NULL,
  p_manufacturer_id uuid DEFAULT NULL,
  p_warehouse_location text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_company_id uuid DEFAULT NULL,
  p_created_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_batch_no text;
  v_existing_count integer;
  v_item jsonb;
  v_stock_config_id uuid;
  v_variant_id uuid;
  v_quantity integer;
  v_pcs integer;
  v_unit_cost numeric;
  v_row_note text;
  v_config public.inventory_stock_configurations%ROWTYPE;
  v_movement_id uuid;
  v_movement_ids uuid[] := ARRAY[]::uuid[];
  v_total_units integer := 0;
  v_total_pcs integer := 0;
  v_total_value numeric := 0;
  v_seen_keys text[] := ARRAY[]::text[];
  v_line_key text;
  v_notes text;
  v_reason text;
  v_external_reference text;
  v_line_index integer := 0;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'Manual stock addition request id is required';
  END IF;

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'Warehouse is required';
  END IF;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Addition reason/source type is required';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'At least one stock configuration line is required';
  END IF;

  IF auth.role() = 'authenticated' THEN
    IF v_user_id IS NULL OR p_created_by IS DISTINCT FROM v_user_id THEN
      RAISE EXCEPTION 'created_by must match the authenticated user';
    END IF;
  ELSIF p_created_by IS NULL THEN
    RAISE EXCEPTION 'created_by is required';
  ELSE
    v_user_id := p_created_by;
  END IF;

  IF NOT public.manual_stock_addition_user_can_post(v_user_id, p_organization_id) THEN
    RAISE EXCEPTION 'User is not authorized to post manual stock additions for organization %', p_organization_id;
  END IF;

  v_company_id := public.get_company_id(p_organization_id);
  IF v_company_id IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve company for organization %', p_organization_id;
  END IF;
  IF p_company_id IS NOT NULL AND p_company_id IS DISTINCT FROM v_company_id THEN
    RAISE EXCEPTION 'Company % does not own organization %', p_company_id, p_organization_id;
  END IF;

  -- Serialise retries for the same client request before checking committed rows.
  PERFORM pg_advisory_xact_lock(hashtextextended('manual-stock-addition:' || p_request_id::text, 0));

  SELECT count(*), min(reference_no)
    INTO v_existing_count, v_batch_no
    FROM public.stock_movements
   WHERE reference_type = 'manual'
     AND reference_id = p_request_id
     AND movement_type = 'manual_in';

  IF v_existing_count > 0 THEN
    RETURN jsonb_build_object(
      'ok', true,
      'idempotent_replay', true,
      'batch_no', v_batch_no,
      'request_id', p_request_id,
      'movement_count', v_existing_count,
      'total_units', (
        SELECT coalesce(sum(quantity_change), 0)
        FROM public.stock_movements
        WHERE reference_type = 'manual'
          AND reference_id = p_request_id
          AND movement_type = 'manual_in'
      ),
      'total_pcs', (
        SELECT coalesce(sum(quantity_pcs_change), 0)
        FROM public.stock_movements
        WHERE reference_type = 'manual'
          AND reference_id = p_request_id
          AND movement_type = 'manual_in'
      ),
      'warehouse_id', p_organization_id,
      'reason', v_reason
    );
  END IF;

  v_batch_no := public.generate_display_doc_number(v_company_id, 'MSA');
  v_external_reference := nullif(btrim(coalesce(p_external_reference, '')), '');


  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_line_index := v_line_index + 1;
    v_stock_config_id := nullif(v_item->>'stock_config_id', '')::uuid;
    v_variant_id := nullif(v_item->>'variant_id', '')::uuid;
    v_row_note := nullif(btrim(coalesce(v_item->>'row_note', '')), '');

    IF v_stock_config_id IS NULL THEN
      RAISE EXCEPTION 'Line %: stock_config_id is required (variant-only posting is not allowed)', v_line_index;
    END IF;
    IF v_variant_id IS NULL THEN
      RAISE EXCEPTION 'Line %: variant_id is required', v_line_index;
    END IF;

    BEGIN
      v_quantity := coalesce(nullif(v_item->>'quantity', '')::integer, 0);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Line %: quantity must be a whole number', v_line_index;
    END;

    BEGIN
      v_pcs := coalesce(nullif(v_item->>'pcs', '')::integer, 0);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Line %: extra pieces must be a whole number', v_line_index;
    END;

    IF v_quantity < 0 OR v_pcs < 0 THEN
      RAISE EXCEPTION 'Line %: quantity and extra pieces cannot be negative', v_line_index;
    END IF;

    IF v_quantity = 0 AND v_pcs = 0 THEN
      RAISE EXCEPTION 'Line %: quantity must be a positive whole number (or enter extra pieces)', v_line_index;
    END IF;

    IF (v_item ? 'unit_cost') AND nullif(v_item->>'unit_cost', '') IS NOT NULL THEN
      BEGIN
        v_unit_cost := (v_item->>'unit_cost')::numeric;
      EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Line %: unit cost is invalid', v_line_index;
      END;
      IF v_unit_cost < 0 THEN
        RAISE EXCEPTION 'Line %: unit cost cannot be negative', v_line_index;
      END IF;
    ELSE
      v_unit_cost := NULL;
    END IF;

    SELECT * INTO v_config
    FROM public.inventory_stock_configurations
    WHERE id = v_stock_config_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Line %: stock configuration % was not found', v_line_index, v_stock_config_id;
    END IF;

    IF v_config.variant_id IS DISTINCT FROM v_variant_id THEN
      RAISE EXCEPTION 'Line %: stock configuration % does not belong to variant %',
        v_line_index, v_stock_config_id, v_variant_id;
    END IF;

    IF upper(coalesce(v_config.config_code, '')) = 'UNCLASSIFIED'
       OR position('LEGACY' in upper(coalesce(v_config.config_code, ''))) > 0
       OR position('LEGACY' in upper(coalesce(v_config.config_label, ''))) > 0
       OR position('UNCLASSIFIED' in upper(coalesce(v_config.config_label, ''))) > 0 THEN
      RAISE EXCEPTION 'Line %: Legacy/Unclassified stock cannot be selected for manual addition', v_line_index;
    END IF;

    IF coalesce(v_config.status, '') <> 'active' THEN
      RAISE EXCEPTION 'Line %: stock configuration % is not active', v_line_index, v_stock_config_id;
    END IF;

    v_line_key := v_variant_id::text || ':' || v_stock_config_id::text;
    IF v_line_key = ANY (v_seen_keys) THEN
      RAISE EXCEPTION 'Line %: duplicate stock configuration % in the same batch', v_line_index, v_stock_config_id;
    END IF;
    v_seen_keys := array_append(v_seen_keys, v_line_key);

    v_notes := nullif(btrim(concat_ws(
      E'\n',
      nullif(btrim(coalesce(p_notes, '')), ''),
      CASE WHEN v_external_reference IS NOT NULL
        THEN 'External reference: ' || v_external_reference
        ELSE NULL
      END,
      CASE WHEN v_row_note IS NOT NULL
        THEN 'Row note: ' || v_row_note
        ELSE NULL
      END
    )), '');

    BEGIN
      v_movement_id := public.record_stock_movement(
        p_movement_type   => 'manual_in',
        p_variant_id      => v_variant_id,
        p_organization_id => p_organization_id,
        p_quantity_change => v_quantity,
        p_quantity_pcs_change => v_pcs,
        p_unit_cost       => v_unit_cost,
        p_manufacturer_id => p_manufacturer_id,
        p_warehouse_location => nullif(btrim(coalesce(p_warehouse_location, '')), ''),
        p_reason          => v_reason,
        p_notes           => v_notes,
        p_reference_type  => 'manual',
        p_reference_id    => p_request_id,
        p_reference_no    => v_batch_no,
        p_company_id      => v_company_id,
        p_created_by      => v_user_id,
        p_stock_config_id => v_stock_config_id
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Line % (config %): %', v_line_index, v_stock_config_id, SQLERRM;
    END;

    v_movement_ids := array_append(v_movement_ids, v_movement_id);
    v_total_units := v_total_units + v_quantity;
    v_total_pcs := v_total_pcs + v_pcs;
    IF v_unit_cost IS NOT NULL THEN
      v_total_value := v_total_value
        + (v_quantity * v_unit_cost)
        + round((v_pcs * v_unit_cost) / greatest(public.resolve_stock_pcs_per_case(v_variant_id, v_stock_config_id), 1), 2);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'idempotent_replay', false,
    'batch_no', v_batch_no,
    'request_id', p_request_id,
    'movement_ids', to_jsonb(v_movement_ids),
    'movement_count', coalesce(array_length(v_movement_ids, 1), 0),
    'total_units', v_total_units,
    'total_pcs', v_total_pcs,
    'total_value', v_total_value,
    'warehouse_id', p_organization_id,
    'reason', v_reason,
    'external_reference', v_external_reference
  );
END;
$$;

COMMENT ON FUNCTION public.post_manual_stock_addition(uuid, uuid, jsonb, text, text, uuid, text, text, uuid, uuid) IS
  'Atomically posts a bulk Manual Stock Addition batch as manual_in movements with one MSA reference. Lines accept an optional "pcs" key for loose pieces. Idempotent on p_request_id.';

-- ---------------------------------------------------------------------------
-- 9. Stock Transfer — pieces travel with the line
-- ---------------------------------------------------------------------------
-- Items are jsonb, so a line gains an optional "pcs" key and its packing
-- ratio without any table change. Lifecycle, reservations and idempotency
-- are untouched.
CREATE OR REPLACE FUNCTION public._stock_transfer_normalize_items(p_items jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_item jsonb;
  v_variant uuid;
  v_cfg uuid;
  v_qty numeric;
  v_qty_int integer;
  v_pcs integer;
  v_pack integer;
  v_cost numeric;
  v_map jsonb := '{}'::jsonb;
  v_key text;
  v_existing jsonb;
  v_cfg_row public.inventory_stock_configurations%ROWTYPE;
  v_out jsonb := '[]'::jsonb;
  v_merged jsonb;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Transfer items are required';
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    BEGIN
      v_variant := (v_item->>'variant_id')::uuid;
      v_cfg := (v_item->>'stock_config_id')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Invalid variant/configuration transfer line';
    END;

    IF v_variant IS NULL OR v_cfg IS NULL THEN
      RAISE EXCEPTION 'Every transfer line requires variant_id and stock_config_id';
    END IF;

    -- A line may be whole cases and/or loose pieces. A piece-only line is a
    -- legitimate transfer of "2 pcs", never rounded into a case.
    v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::numeric, 0);
    IF v_qty IS NULL OR v_qty <> trunc(v_qty) OR v_qty < 0 THEN
      RAISE EXCEPTION 'Transfer quantities must be whole numbers';
    END IF;
    v_qty_int := v_qty::integer;

    v_pcs := COALESCE(NULLIF(v_item->>'pcs', '')::integer, 0);
    IF v_pcs < 0 THEN
      RAISE EXCEPTION 'Transfer extra pieces cannot be negative';
    END IF;
    IF v_qty_int = 0 AND v_pcs = 0 THEN
      RAISE EXCEPTION 'Transfer quantities must be positive whole numbers';
    END IF;

    SELECT * INTO v_cfg_row
      FROM public.inventory_stock_configurations c
     WHERE c.id = v_cfg
       AND c.variant_id = v_variant;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid variant/configuration transfer line';
    END IF;
    IF v_cfg_row.status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'Only active stock configurations can be transferred';
    END IF;
    IF v_cfg_row.config_code = 'UNCLASSIFIED' OR v_cfg_row.config_code ILIKE '%LEGACY%' THEN
      RAISE EXCEPTION 'Legacy/Unclassified stock cannot be transferred through the normal flow';
    END IF;

    v_cost := NULLIF(v_item->>'cost', '')::numeric;
    v_pack := public.resolve_stock_pcs_per_case(v_variant, v_cfg);
    v_key := v_variant::text || ':' || v_cfg::text;
    v_existing := v_map -> v_key;

    IF v_existing IS NULL THEN
      v_map := v_map || jsonb_build_object(
        v_key,
        jsonb_build_object(
          'variant_id', v_variant,
          'stock_config_id', v_cfg,
          'quantity', v_qty_int,
          'pcs', v_pcs,
          'pcs_per_case', v_pack,
          'cost', v_cost,
          'variant_name', COALESCE(v_item->>'variant_name', ''),
          'product_name', COALESCE(v_item->>'product_name', ''),
          'product_code', COALESCE(v_item->>'product_code', ''),
          'stock_sku', COALESCE(NULLIF(v_item->>'stock_sku', ''), v_cfg_row.stock_sku),
          'config_label', COALESCE(NULLIF(v_item->>'config_label', ''), v_cfg_row.config_label),
          'volume_ml', v_cfg_row.volume_ml,
          'packaging', v_cfg_row.packaging
        )
      );
    ELSE
      v_map := v_map || jsonb_build_object(
        v_key,
        v_existing || jsonb_build_object(
          'quantity', (v_existing->>'quantity')::integer + v_qty_int,
          'pcs', COALESCE((v_existing->>'pcs')::integer, 0) + v_pcs,
          'cost', COALESCE(v_cost, NULLIF(v_existing->>'cost', '')::numeric)
        )
      );
    END IF;
  END LOOP;

  FOR v_merged IN SELECT value FROM jsonb_each(v_map) LOOP
    v_out := v_out || jsonb_build_array(v_merged);
  END LOOP;

  IF jsonb_array_length(v_out) = 0 THEN
    RAISE EXCEPTION 'Transfer items are required';
  END IF;

  RETURN v_out;
END;
$$;

-- UPGRADE SAFETY — this is where staging failed with
--   ERROR 42P13: cannot change return type of existing function
--   DETAIL: Row type defined by OUT parameters is different.
-- The pre-migration function is
--   _stock_transfer_totals(jsonb) RETURNS TABLE(total_items integer, total_value numeric)
-- and CREATE OR REPLACE cannot append an OUT column, so the old signature is
-- replaced explicitly instead. Verified against supabase/schemas/current_schema.sql
-- (the staging pre-image):
--   * the only caller is public.save_stock_transfer_draft (plpgsql), which does
--     SELECT * INTO v_totals FROM public._stock_transfer_totals(v_items) and then
--     reads v_totals.total_items / v_totals.total_value. v_totals is a plain
--     RECORD, so an APPENDED third column is compatible; the two columns it
--     reads keep their position, name and type.
--   * no view, SQL-language function, generated column or constraint references
--     it. The other callers of the transfer helpers are plpgsql and therefore
--     late-bound, so they are not invalidated by the DROP.
--   * it is LANGUAGE sql STABLE, SECURITY INVOKER and search_path pinned. The
--     schema dump does not capture its live ACL, so PUBLIC access must never be
--     inferred from the dump; the live ACL is captured and replayed below.
--   * the DROP and CREATE run inside this migration's single transaction, so no
--     session can observe the function missing and a later failure rolls the
--     whole replacement back.
--
-- Privileges: a DROP discards the function's ACL, and a fresh CREATE would give
-- PUBLIC EXECUTE. The dump does not record function ACLs, so the live ACL is
-- captured before the DROP and replayed explicitly. A missing capture is an
-- error, not permission to fall back to the fresh PUBLIC default. The temporary
-- table name is not IF NOT EXISTS: a stale capture must fail loudly rather than
-- silently restore the wrong posture.
CREATE TEMP TABLE _pcs_totals_acl ON COMMIT DROP AS
SELECT (p.proacl IS NULL OR EXISTS (
          SELECT 1 FROM aclexplode(p.proacl) a
           WHERE a.privilege_type = 'EXECUTE' AND a.grantee = 0)) AS public_execute,
       COALESCE((SELECT array_agg(DISTINCT a.grantee::regrole::text)
                   FROM aclexplode(p.proacl) a
                  WHERE a.grantee <> 0 AND a.privilege_type = 'EXECUTE'), '{}') AS grantees
  FROM pg_proc p
 WHERE p.oid = to_regprocedure('public._stock_transfer_totals(jsonb)');

DROP FUNCTION IF EXISTS public._stock_transfer_totals(jsonb);

CREATE OR REPLACE FUNCTION public._stock_transfer_totals(p_items jsonb)
RETURNS TABLE(total_items integer, total_pcs integer, total_value numeric)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  -- total_items stays in whole stock units (cases). Pieces are reported
  -- separately and are valued at cost / pcs_per_case, never merged into a
  -- single unlabelled "units" figure.
  SELECT COALESCE(SUM(COALESCE(NULLIF(item->>'quantity', '')::integer, 0)), 0)::integer,
         COALESCE(SUM(COALESCE(NULLIF(item->>'pcs', '')::integer, 0)), 0)::integer,
         COALESCE(SUM(
           COALESCE(NULLIF(item->>'quantity', '')::integer, 0)
             * COALESCE(NULLIF(item->>'cost', '')::numeric, 0)
           + round(
               COALESCE(NULLIF(item->>'pcs', '')::numeric, 0)
                 * COALESCE(NULLIF(item->>'cost', '')::numeric, 0)
                 / GREATEST(COALESCE(NULLIF(item->>'pcs_per_case', '')::integer, 1), 1)
             , 2)
         ), 0)
    FROM jsonb_array_elements(p_items) item;
$$;

COMMENT ON FUNCTION public._stock_transfer_totals(jsonb) IS
  'Transfer totals: whole units, loose pieces and the combined value at the line cost authority.';

-- Replay the privileges captured before the DROP so the replacement neither
-- widens nor narrows who may execute this helper. Always remove the fresh
-- default first, then restore PUBLIC only when it was present in the capture.
-- This makes the denied case explicit and verifies it before the capture goes
-- away. All references use pg_temp so an outer search_path cannot redirect them.
DO $acl$
DECLARE
  v_public boolean;
  v_grantees text[];
  v_grantee text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_temp._pcs_totals_acl) THEN
    RAISE EXCEPTION 'Missing pre-DROP ACL capture for public._stock_transfer_totals(jsonb); refusing the fresh PUBLIC default';
  END IF;

  SELECT public_execute, grantees
    INTO v_public, v_grantees
    FROM pg_temp._pcs_totals_acl;

  EXECUTE 'REVOKE ALL ON FUNCTION public._stock_transfer_totals(jsonb) FROM PUBLIC';
  IF v_public THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public._stock_transfer_totals(jsonb) TO PUBLIC';
  END IF;

  FOREACH v_grantee IN ARRAY COALESCE(v_grantees, ARRAY[]::text[]) LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION public._stock_transfer_totals(jsonb) TO %I', v_grantee);
  END LOOP;

  IF (SELECT p.proacl IS NULL OR EXISTS (
               SELECT 1 FROM aclexplode(p.proacl) a
                WHERE a.privilege_type = 'EXECUTE' AND a.grantee = 0)
        FROM pg_proc p
       WHERE p.oid = 'public._stock_transfer_totals(jsonb)'::regprocedure)
     IS DISTINCT FROM v_public THEN
    RAISE EXCEPTION 'PUBLIC EXECUTE replay verification failed for public._stock_transfer_totals(jsonb): captured %', v_public;
  END IF;

  DROP TABLE pg_temp._pcs_totals_acl;
END $acl$;

-- Replay the OWNER captured in section 0 for the two functions that had to be
-- dropped and re-created. In the normal Supabase case the migration runs as the
-- same role that owns them, so this is a no-op. When it is not, the owner is
-- restored explicitly instead of silently transferring ownership to whoever ran
-- the migration. ALTER FUNCTION ... OWNER TO only ever re-assigns the existing
-- owner, so it neither widens nor narrows any privilege.
DO $owners$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT o.proname,
           o.owner_before,
           f.oid,
           f.proowner,
           pg_get_userbyid(f.proowner) AS owner_now,
           format('ALTER FUNCTION %s.%I(%s) OWNER TO %I',
                  n.nspname,
                  f.proname,
                  pg_get_function_identity_arguments(f.oid),
                  o.owner_before) AS cmd
      FROM pg_temp._pcs_function_owners o
      JOIN pg_proc f ON f.proname = o.proname
      JOIN pg_namespace n ON n.oid = f.pronamespace AND n.nspname = 'public'
  LOOP
    CONTINUE WHEN r.owner_before = r.owner_now;
    BEGIN
      EXECUTE r.cmd;
      RAISE NOTICE 'owner of public.% restored to %', r.proname, r.owner_before;
    EXCEPTION WHEN insufficient_privilege THEN
      -- Never abort the migration for this: report loudly and leave the owner
      -- visible for the readiness check to flag.
      RAISE WARNING 'could not restore owner % on public.% (currently %); run the migration as a role that can SET ROLE to %',
        r.owner_before, r.proname, r.owner_now, r.owner_before;
    END;
  END LOOP;

  DROP TABLE IF EXISTS pg_temp._pcs_function_owners;
END $owners$;


CREATE OR REPLACE FUNCTION public._stock_transfer_reserve_items(p_transfer public.stock_transfers) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_item jsonb;
  v_variant uuid;
  v_cfg uuid;
  v_qty integer;
  v_cost numeric;
  v_on integer;
  v_alloc integer;
  v_on_pcs integer;
  v_pcs integer;
  v_pack integer;
BEGIN
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_transfer.items) LOOP
    v_variant := (v_item->>'variant_id')::uuid;
    v_cfg := (v_item->>'stock_config_id')::uuid;
    v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::integer, 0);
    v_pcs := COALESCE(NULLIF(v_item->>'pcs', '')::integer, 0);
    v_pack := public.resolve_stock_pcs_per_case(v_variant, v_cfg);
    v_cost := COALESCE(NULLIF(v_item->>'cost', '')::numeric, 0);

    IF EXISTS (
      SELECT 1 FROM public.stock_movements sm
       WHERE sm.reference_type = 'transfer'
         AND sm.reference_id = p_transfer.id
         AND sm.movement_type = 'allocation'
         AND sm.variant_id = v_variant
         AND sm.stock_config_id = v_cfg
    ) THEN
      CONTINUE;
    END IF;

    SELECT quantity_on_hand, quantity_allocated, pcs_on_hand
      INTO v_on, v_alloc, v_on_pcs
      FROM public.product_inventory
     WHERE organization_id = p_transfer.from_organization_id
       AND variant_id = v_variant
       AND stock_config_id = v_cfg
       AND is_active = true
     FOR UPDATE;

    -- Availability is compared in pieces so a request for loose pieces is
    -- validated against what is really there. Only whole units are reserved
    -- (quantity_allocated is a case count); dispatch re-checks atomically.
    IF NOT FOUND
       OR (COALESCE(v_on, 0) - COALESCE(v_alloc, 0))::bigint * v_pack + COALESCE(v_on_pcs, 0)
          < v_qty::bigint * v_pack + v_pcs THEN
      RAISE EXCEPTION 'Insufficient available stock for configuration % (need % cases + % pcs, available % cases + % pcs)',
        v_cfg, v_qty, v_pcs,
        GREATEST(COALESCE(v_on, 0) - COALESCE(v_alloc, 0), 0),
        GREATEST(COALESCE(v_on_pcs, 0), 0);
    END IF;

    UPDATE public.product_inventory
       SET quantity_allocated = quantity_allocated + v_qty,
           updated_at = now()
     WHERE organization_id = p_transfer.from_organization_id
       AND variant_id = v_variant
       AND stock_config_id = v_cfg;

    INSERT INTO public.stock_movements (
      movement_type, reference_type, reference_id, reference_no, variant_id, stock_config_id,
      from_organization_id, to_organization_id, quantity_change, quantity_before, quantity_after,
      unit_cost, company_id, created_by, notes
    ) VALUES (
      'allocation', 'transfer', p_transfer.id, p_transfer.transfer_no, v_variant, v_cfg,
      p_transfer.from_organization_id, p_transfer.to_organization_id, v_qty, 0, v_qty,
      v_cost, p_transfer.company_id, COALESCE(auth.uid(), p_transfer.created_by),
      'Transfer reservation pending approval'
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.dispatch_stock_transfer(p_transfer_id uuid, p_actor_id uuid DEFAULT NULL::uuid) RETURNS public.stock_transfers
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_actor uuid := COALESCE(auth.uid(), p_actor_id);
  v_transfer public.stock_transfers;
  v_item jsonb;
  v_variant uuid;
  v_cfg uuid;
  v_qty integer;
  v_pcs integer;
  v_cost numeric;
  v_out_count integer;
  v_expected integer;
BEGIN
  /* sa-guard:inventory.transfer.dispatch */
  PERFORM public.sa_require_operation('inventory.transfer.dispatch', jsonb_build_object('organization_id', (SELECT t.from_organization_id FROM public.stock_transfers t WHERE t.id = p_transfer_id), 'warehouse_id', (SELECT t.from_organization_id FROM public.stock_transfers t WHERE t.id = p_transfer_id)), 'stock_transfer', p_transfer_id::text);
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authenticated actor is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('stock-transfer:' || p_transfer_id::text, 0));

  SELECT * INTO v_transfer FROM public.stock_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;

  SELECT count(*) INTO v_expected FROM jsonb_array_elements(v_transfer.items);
  SELECT count(*) INTO v_out_count
    FROM public.stock_movements sm
   WHERE sm.reference_type = 'transfer'
     AND sm.reference_id = p_transfer_id
     AND sm.movement_type = 'transfer_out';

  -- Idempotent: already dispatched (includes historical Phase-11 in_transit rows).
  IF v_transfer.status = 'in_transit' AND v_out_count >= v_expected AND v_expected > 0 THEN
    RETURN v_transfer;
  END IF;

  IF v_transfer.status IS DISTINCT FROM 'ready_to_dispatch' THEN
    RAISE EXCEPTION 'Only ready-to-dispatch transfers can be dispatched';
  END IF;

  -- Source warehouse confirms physical dispatch; HQ admin may act as override.
  IF NOT (
    public.is_hq_admin()
    OR public.can_access_org(v_transfer.from_organization_id)
  ) THEN
    RAISE EXCEPTION 'Unauthorized dispatch: source warehouse access is required';
  END IF;

  PERFORM public._stock_transfer_assert_reservation_integrity(v_transfer);
  PERFORM public._stock_transfer_release_reservations(v_transfer);

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_transfer.items) LOOP
    v_variant := (v_item->>'variant_id')::uuid;
    v_cfg := (v_item->>'stock_config_id')::uuid;
    v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::integer, 0);
    v_pcs := COALESCE(NULLIF(v_item->>'pcs', '')::integer, 0);
    v_cost := NULLIF(v_item->>'cost', '')::numeric;

    IF EXISTS (
      SELECT 1 FROM public.stock_movements sm
       WHERE sm.reference_type = 'transfer'
         AND sm.reference_id = p_transfer_id
         AND sm.movement_type = 'transfer_out'
         AND sm.variant_id = v_variant
         AND sm.stock_config_id IS NOT DISTINCT FROM v_cfg
    ) THEN
      CONTINUE;
    END IF;

    PERFORM public.record_stock_movement(
      p_movement_type := 'transfer_out',
      p_variant_id := v_variant,
      p_organization_id := v_transfer.from_organization_id,
      p_quantity_change := -v_qty,
      p_quantity_pcs_change := -v_pcs,
      p_unit_cost := v_cost,
      p_reason := 'Warehouse transfer dispatched',
      p_notes := v_transfer.notes,
      p_reference_type := 'transfer',
      p_reference_id := v_transfer.id,
      p_reference_no := v_transfer.transfer_no,
      p_company_id := v_transfer.company_id,
      p_created_by := v_actor,
      p_stock_config_id := v_cfg
    );
  END LOOP;

  UPDATE public.stock_transfers
     SET status = 'in_transit',
         dispatched_by = COALESCE(dispatched_by, v_actor),
         shipped_at = COALESCE(shipped_at, now()),
         updated_at = now()
   WHERE id = p_transfer_id
   RETURNING * INTO v_transfer;

  RETURN v_transfer;
END;
$$;

CREATE OR REPLACE FUNCTION public.receive_stock_transfer(p_transfer_id uuid, p_actor_id uuid DEFAULT NULL::uuid) RETURNS public.stock_transfers
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_actor uuid := COALESCE(auth.uid(), p_actor_id);
  v_transfer public.stock_transfers;
  v_item jsonb;
  v_variant uuid;
  v_cfg uuid;
  v_qty integer;
  v_pcs integer;
  v_cost numeric;
  v_in_count integer;
  v_expected integer;
BEGIN
  /* sa-guard:inventory.transfer.receive */
  PERFORM public.sa_require_operation('inventory.transfer.receive', jsonb_build_object('organization_id', (SELECT t.to_organization_id FROM public.stock_transfers t WHERE t.id = p_transfer_id), 'warehouse_id', (SELECT t.to_organization_id FROM public.stock_transfers t WHERE t.id = p_transfer_id)), 'stock_transfer', p_transfer_id::text);
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authenticated actor is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('stock-transfer:' || p_transfer_id::text, 0));

  SELECT * INTO v_transfer FROM public.stock_transfers WHERE id = p_transfer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;

  IF v_transfer.status = 'received' THEN
    RETURN v_transfer;
  END IF;

  IF v_transfer.status = 'ready_to_dispatch' THEN
    RAISE EXCEPTION 'Transfer must be dispatched before it can be received';
  END IF;

  IF v_transfer.status IS DISTINCT FROM 'in_transit' THEN
    RAISE EXCEPTION 'Only in-transit transfers can be received';
  END IF;

  -- Destination warehouse confirms receipt; HQ admin may act as override.
  IF NOT (
    public.is_hq_admin()
    OR public.can_access_org(v_transfer.to_organization_id)
  ) THEN
    RAISE EXCEPTION 'Unauthorized receipt: destination warehouse access is required';
  END IF;

  SELECT count(*) INTO v_expected FROM jsonb_array_elements(v_transfer.items);
  SELECT count(*) INTO v_in_count
    FROM public.stock_movements sm
   WHERE sm.reference_type = 'transfer'
     AND sm.reference_id = p_transfer_id
     AND sm.movement_type = 'transfer_in'
     AND sm.to_organization_id = v_transfer.to_organization_id;

  -- Historical creates already posted destination transfer_in; mark received without double-post.
  IF v_in_count >= v_expected AND v_expected > 0 THEN
    UPDATE public.stock_transfers
       SET status = 'received',
           received_by = COALESCE(received_by, v_actor),
           received_at = COALESCE(received_at, now()),
           updated_at = now()
     WHERE id = p_transfer_id
     RETURNING * INTO v_transfer;
    RETURN v_transfer;
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(v_transfer.items) LOOP
    v_variant := (v_item->>'variant_id')::uuid;
    v_cfg := (v_item->>'stock_config_id')::uuid;
    v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::integer, 0);
    v_pcs := COALESCE(NULLIF(v_item->>'pcs', '')::integer, 0);
    v_cost := NULLIF(v_item->>'cost', '')::numeric;

    IF v_cfg IS NULL THEN
      RAISE EXCEPTION 'Historical unclassified transfer lines cannot be received through the normal flow';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.stock_movements sm
       WHERE sm.reference_type = 'transfer'
         AND sm.reference_id = p_transfer_id
         AND sm.movement_type = 'transfer_in'
         AND sm.to_organization_id = v_transfer.to_organization_id
         AND sm.variant_id = v_variant
         AND sm.stock_config_id IS NOT DISTINCT FROM v_cfg
    ) THEN
      CONTINUE;
    END IF;

    PERFORM public.record_stock_movement(
      p_movement_type := 'transfer_in',
      p_variant_id := v_variant,
      p_organization_id := v_transfer.to_organization_id,
      p_quantity_change := v_qty,
      p_quantity_pcs_change := v_pcs,
      p_unit_cost := v_cost,
      p_reason := 'Warehouse transfer received',
      p_notes := v_transfer.notes,
      p_reference_type := 'transfer',
      p_reference_id := v_transfer.id,
      p_reference_no := v_transfer.transfer_no,
      p_company_id := v_transfer.company_id,
      p_created_by := v_actor,
      p_stock_config_id := v_cfg
    );
  END LOOP;

  UPDATE public.stock_transfers
     SET status = 'received',
         received_by = v_actor,
         received_at = COALESCE(received_at, now()),
         updated_at = now()
   WHERE id = p_transfer_id
   RETURNING * INTO v_transfer;

  RETURN v_transfer;
END;
$$;



-- Reservation bookkeeping rows carry the reserved pieces too, so the closed
-- movement/sign allowlist still has a non-zero delta for a pieces-only line.
CREATE OR REPLACE FUNCTION public._stock_transfer_reserve_items(p_transfer public.stock_transfers) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_item jsonb;
  v_variant uuid;
  v_cfg uuid;
  v_qty integer;
  v_cost numeric;
  v_on integer;
  v_alloc integer;
  v_on_pcs integer;
  v_pcs integer;
  v_pack integer;
BEGIN
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_transfer.items) LOOP
    v_variant := (v_item->>'variant_id')::uuid;
    v_cfg := (v_item->>'stock_config_id')::uuid;
    v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::integer, 0);
    v_pcs := COALESCE(NULLIF(v_item->>'pcs', '')::integer, 0);
    v_pack := public.resolve_stock_pcs_per_case(v_variant, v_cfg);
    v_cost := COALESCE(NULLIF(v_item->>'cost', '')::numeric, 0);

    IF EXISTS (
      SELECT 1 FROM public.stock_movements sm
       WHERE sm.reference_type = 'transfer'
         AND sm.reference_id = p_transfer.id
         AND sm.movement_type = 'allocation'
         AND sm.variant_id = v_variant
         AND sm.stock_config_id = v_cfg
    ) THEN
      CONTINUE;
    END IF;

    SELECT quantity_on_hand, quantity_allocated, pcs_on_hand
      INTO v_on, v_alloc, v_on_pcs
      FROM public.product_inventory
     WHERE organization_id = p_transfer.from_organization_id
       AND variant_id = v_variant
       AND stock_config_id = v_cfg
       AND is_active = true
     FOR UPDATE;

    -- Availability is compared in pieces so a request for loose pieces is
    -- validated against what is really there. Only whole units are reserved
    -- (quantity_allocated is a case count); dispatch re-checks atomically.
    IF NOT FOUND
       OR (COALESCE(v_on, 0) - COALESCE(v_alloc, 0))::bigint * v_pack + COALESCE(v_on_pcs, 0)
          < v_qty::bigint * v_pack + v_pcs THEN
      RAISE EXCEPTION 'Insufficient available stock for configuration % (need % cases + % pcs, available % cases + % pcs)',
        v_cfg, v_qty, v_pcs,
        GREATEST(COALESCE(v_on, 0) - COALESCE(v_alloc, 0), 0),
        GREATEST(COALESCE(v_on_pcs, 0), 0);
    END IF;

    UPDATE public.product_inventory
       SET quantity_allocated = quantity_allocated + v_qty,
           updated_at = now()
     WHERE organization_id = p_transfer.from_organization_id
       AND variant_id = v_variant
       AND stock_config_id = v_cfg;

    INSERT INTO public.stock_movements (
      movement_type, reference_type, reference_id, reference_no, variant_id, stock_config_id,
      from_organization_id, to_organization_id, quantity_change, quantity_before, quantity_after,
      quantity_pcs_change, quantity_pcs_before, quantity_pcs_after, pcs_per_case,
      unit_cost, company_id, created_by, notes
    ) VALUES (
      'allocation', 'transfer', p_transfer.id, p_transfer.transfer_no, v_variant, v_cfg,
      p_transfer.from_organization_id, p_transfer.to_organization_id, v_qty, 0, v_qty,
      v_pcs, 0, v_pcs, v_pack,
      v_cost, p_transfer.company_id, COALESCE(auth.uid(), p_transfer.created_by),
      'Transfer reservation pending approval'
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public._stock_transfer_release_reservations(p_transfer public.stock_transfers) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_item jsonb;
  v_variant uuid;
  v_cfg uuid;
  v_qty integer;
  v_cost numeric;
  v_alloc integer;
  v_pcs integer;
  v_pack integer;
BEGIN
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_transfer.items) LOOP
    v_variant := (v_item->>'variant_id')::uuid;
    v_cfg := (v_item->>'stock_config_id')::uuid;
    v_qty := COALESCE(NULLIF(v_item->>'quantity', '')::integer, 0);
    v_pcs := COALESCE(NULLIF(v_item->>'pcs', '')::integer, 0);
    v_pack := public.resolve_stock_pcs_per_case(v_variant, v_cfg);
    v_cost := COALESCE(NULLIF(v_item->>'cost', '')::numeric, 0);

    IF NOT EXISTS (
      SELECT 1 FROM public.stock_movements sm
       WHERE sm.reference_type = 'transfer'
         AND sm.reference_id = p_transfer.id
         AND sm.movement_type = 'allocation'
         AND sm.variant_id = v_variant
         AND sm.stock_config_id = v_cfg
    ) THEN
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.stock_movements sm
       WHERE sm.reference_type = 'transfer'
         AND sm.reference_id = p_transfer.id
         AND sm.movement_type = 'deallocation'
         AND sm.variant_id = v_variant
         AND sm.stock_config_id = v_cfg
    ) THEN
      CONTINUE;
    END IF;

    SELECT quantity_allocated INTO v_alloc
      FROM public.product_inventory
     WHERE organization_id = p_transfer.from_organization_id
       AND variant_id = v_variant
       AND stock_config_id = v_cfg
     FOR UPDATE;

    IF NOT FOUND OR COALESCE(v_alloc, 0) < v_qty THEN
      RAISE EXCEPTION 'Cannot safely release transfer reservation for configuration %', v_cfg;
    END IF;

    UPDATE public.product_inventory
       SET quantity_allocated = quantity_allocated - v_qty,
           updated_at = now()
     WHERE organization_id = p_transfer.from_organization_id
       AND variant_id = v_variant
       AND stock_config_id = v_cfg;

    INSERT INTO public.stock_movements (
      movement_type, reference_type, reference_id, reference_no, variant_id, stock_config_id,
      from_organization_id, to_organization_id, quantity_change, quantity_before, quantity_after,
      quantity_pcs_change, quantity_pcs_before, quantity_pcs_after, pcs_per_case,
      unit_cost, company_id, created_by, notes
    ) VALUES (
      'deallocation', 'transfer', p_transfer.id, p_transfer.transfer_no, v_variant, v_cfg,
      p_transfer.to_organization_id, p_transfer.from_organization_id, -v_qty, v_qty, 0,
      -v_pcs, v_pcs, 0, v_pack,
      v_cost, p_transfer.company_id, COALESCE(auth.uid(), p_transfer.created_by),
      'Transfer reservation released'
    );
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 10. Read models expose the pair (additive: existing columns keep their
--     meaning and order, new columns are appended)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_inventory_on_hand WITH (security_barrier='true') AS
 SELECT id,
    variant_id,
    organization_id,
    quantity_on_hand,
    quantity_allocated,
    quantity_available,
    reorder_point,
    reorder_quantity,
    max_stock_level,
    safety_stock,
    lead_time_days,
    average_cost,
    total_value,
    warehouse_location,
    variant_code,
    variant_name,
    variant_image_url,
    product_id,
    product_name,
    product_code,
    organization_name,
    organization_code,
    updated_at,
    stock_config_id,
    config_code,
    config_label,
    stock_sku,
    volume_ml,
    packaging,
    stock_config_status,
    is_variant_default,
    requires_repacking_before_sale,
    default_for_ord,
    pcs_on_hand,
    pcs_per_case,
    pcs_value
   FROM ( SELECT pi.id,
            pi.variant_id,
            pi.organization_id,
            pi.quantity_on_hand,
            pi.quantity_allocated,
            pi.quantity_available,
            pi.reorder_point,
            pi.reorder_quantity,
            pi.max_stock_level,
            pi.safety_stock,
            pi.lead_time_days,
            pi.average_cost,
            pi.total_value,
            pi.warehouse_location,
            pv.variant_code,
            pv.variant_name,
            pv.image_url AS variant_image_url,
            p.id AS product_id,
            p.product_name,
            p.product_code,
            o.org_name AS organization_name,
            o.org_code AS organization_code,
            pi.updated_at,
            pi.stock_config_id,
            c.config_code,
            c.config_label,
            c.stock_sku,
            c.volume_ml,
            c.packaging,
            c.status AS stock_config_status,
            c.is_variant_default,
            c.requires_repacking_before_sale,
            c.default_for_ord,
            pi.pcs_on_hand,
            pi.pcs_per_case,
            pi.pcs_value
           FROM ((((public.product_inventory pi
             JOIN public.inventory_stock_configurations c ON (((c.id = pi.stock_config_id) AND (c.variant_id = pi.variant_id))))
             JOIN public.product_variants pv ON ((pv.id = pi.variant_id)))
             JOIN public.products p ON ((p.id = pv.product_id)))
             JOIN public.organizations o ON ((o.id = pi.organization_id)))
          WHERE ((pi.is_active = true) AND ((c.status = 'active'::text) OR (pi.quantity_on_hand <> 0) OR (pi.quantity_allocated <> 0) OR (pi.pcs_on_hand <> 0)))) v
  WHERE public.sa_inventory_stock_row_visible(organization_id, ( SELECT public.sa_inventory_stock_scope() AS sa_inventory_stock_scope));

CREATE OR REPLACE VIEW public.vw_stock_movements_ordered WITH (security_invoker='false', security_barrier='true') AS
 SELECT sm.id,
    sm.movement_type,
    sm.reference_type,
    sm.reference_id,
    sm.reference_no,
    sm.variant_id,
    sm.from_organization_id,
    sm.to_organization_id,
    sm.quantity_change,
        CASE
            WHEN public.sa_stock_movement_balance_visible(sm.from_organization_id, sm.to_organization_id, ( SELECT public.sa_stock_movement_scope() AS sa_stock_movement_scope), ( SELECT public.sa_inventory_caller_is_hq_side() AS sa_inventory_caller_is_hq_side)) THEN sm.quantity_before
            ELSE NULL::integer
        END AS quantity_before,
        CASE
            WHEN public.sa_stock_movement_balance_visible(sm.from_organization_id, sm.to_organization_id, ( SELECT public.sa_stock_movement_scope() AS sa_stock_movement_scope), ( SELECT public.sa_inventory_caller_is_hq_side() AS sa_inventory_caller_is_hq_side)) THEN (sm.quantity_before + sm.quantity_change)
            ELSE NULL::integer
        END AS quantity_after,
    (
        CASE
            WHEN ((( SELECT public.sa_stock_movement_scope() AS sa_stock_movement_scope) IS NULL) OR ( SELECT public.sa_inventory_caller_is_hq_side() AS sa_inventory_caller_is_hq_side)) THEN sm.unit_cost
            ELSE NULL::numeric
        END)::numeric(12,2) AS unit_cost,
    (
        CASE
            WHEN ((( SELECT public.sa_stock_movement_scope() AS sa_stock_movement_scope) IS NULL) OR ( SELECT public.sa_inventory_caller_is_hq_side() AS sa_inventory_caller_is_hq_side)) THEN sm.total_cost
            ELSE NULL::numeric
        END)::numeric(15,2) AS total_cost,
    sm.manufacturer_id,
    sm.warehouse_location,
    sm.reason,
    sm.notes,
    sm.company_id,
    sm.created_by,
    sm.created_at,
    sm.stock_config_id,
    c.config_code,
    c.config_label,
    c.stock_sku,
    c.volume_ml,
    c.packaging,
    (sm.stock_config_id IS NULL) AS is_legacy_configuration,
    pv.variant_code,
    pv.variant_name,
    p.product_name,
    COALESCE(dst.org_name, src.org_name) AS organization_name,
    COALESCE(dst.org_code, src.org_code) AS organization_code,
    mfg.org_name AS manufacturer_name,
    u.email AS created_by_email,
    sm.quantity_pcs_change,
    (CASE
        WHEN public.sa_stock_movement_balance_visible(sm.from_organization_id, sm.to_organization_id, ( SELECT public.sa_stock_movement_scope() AS sa_stock_movement_scope), ( SELECT public.sa_inventory_caller_is_hq_side() AS sa_inventory_caller_is_hq_side)) THEN sm.quantity_pcs_before
        ELSE NULL::integer
    END) AS quantity_pcs_before,
    (CASE
        WHEN public.sa_stock_movement_balance_visible(sm.from_organization_id, sm.to_organization_id, ( SELECT public.sa_stock_movement_scope() AS sa_stock_movement_scope), ( SELECT public.sa_inventory_caller_is_hq_side() AS sa_inventory_caller_is_hq_side)) THEN sm.quantity_pcs_after
        ELSE NULL::integer
    END) AS quantity_pcs_after,
    sm.pcs_per_case,
    (CASE
        WHEN ((( SELECT public.sa_stock_movement_scope() AS sa_stock_movement_scope) IS NULL) OR ( SELECT public.sa_inventory_caller_is_hq_side() AS sa_inventory_caller_is_hq_side)) THEN sm.net_cost
        ELSE NULL::numeric
    END)::numeric(15,2) AS net_cost
   FROM (((((((public.stock_movements sm
     LEFT JOIN public.inventory_stock_configurations c ON (((c.id = sm.stock_config_id) AND (c.variant_id = sm.variant_id))))
     LEFT JOIN public.product_variants pv ON ((pv.id = sm.variant_id)))
     LEFT JOIN public.products p ON ((p.id = pv.product_id)))
     LEFT JOIN public.organizations src ON ((src.id = sm.from_organization_id)))
     LEFT JOIN public.organizations dst ON ((dst.id = sm.to_organization_id)))
     LEFT JOIN public.organizations mfg ON ((mfg.id = sm.manufacturer_id)))
     LEFT JOIN public.users u ON ((u.id = sm.created_by)))
  WHERE public.sa_stock_movement_row_visible(sm.from_organization_id, sm.to_organization_id, ( SELECT public.sa_stock_movement_scope() AS sa_stock_movement_scope))
  ORDER BY sm.created_at, sm.id;

COMMENT ON VIEW public.vw_inventory_on_hand IS
  'Internal warehouse configuration detail. Inactive zero-stock configurations are hidden; nonzero historical balances (including loose pieces) remain visible.';

COMMENT ON VIEW public.vw_stock_movements_ordered IS
  'Stock Movement Report. Rows: sa_stock_movement_scope(); balances/costs (whole units AND loose pieces) masked for callers outside the HQ side. Must stay owner-run (not security_invoker).';

NOTIFY pgrst, 'reload schema';

COMMIT;
