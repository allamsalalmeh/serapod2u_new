BEGIN;

-- ============================================================================
-- Outdoor shop warehouse + online stock allocation
-- ----------------------------------------------------------------------------
-- 1. The Outdoor shop may sell from its own warehouse.
--    organizations.outdoor_warehouse_org_id (HQ only):
--      * NULL -> Outdoor orders use the website warehouse
--                (storefront_warehouse_org_id, else default_warehouse_org_id),
--                i.e. unchanged behaviour.
--      * set  -> Outdoor orders sell against and ship from that warehouse;
--                /store orders keep the website warehouse.
--    Same integrity rules as the website warehouse: an active warehouse
--    directly under the HQ, and it cannot be deactivated while in use.
--
-- 2. Online stock allocation per variant.
--    product_variants.online_stock_allocation:
--      * NULL -> the website may sell everything free in its warehouse
--                (unchanged behaviour).
--      * N    -> the website may sell at most N more. It goes down when a
--                website order ships and back up when one is returned or a
--                shipment is undone. Warehouse stock is never touched by it.
--
-- storefront_variant_stock gains p_channel; old two-argument calls resolve
-- to the website warehouse exactly as before. Additive and rerunnable.
-- Requires 20260928210000 and 20260929200000.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Outdoor shop warehouse setting + integrity guard
-- ---------------------------------------------------------------------------
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS outdoor_warehouse_org_id uuid
    REFERENCES public.organizations(id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.organizations.outdoor_warehouse_org_id IS
  'HQ only. Warehouse the Outdoor shop sells against and ships from. NULL = same warehouse as the other website orders.';

CREATE OR REPLACE FUNCTION public.organizations_protect_storefront_warehouse()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_hq_name text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.is_active IS TRUE
     AND NEW.is_active IS DISTINCT FROM TRUE THEN
    SELECT org_name INTO v_hq_name
      FROM public.organizations
     WHERE org_type_code = 'HQ'
       AND storefront_warehouse_org_id = OLD.id
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION
        'Cannot deactivate the online shop warehouse for %. Choose another online shop warehouse first.',
        COALESCE(v_hq_name, 'the parent HQ');
    END IF;
    SELECT org_name INTO v_hq_name
      FROM public.organizations
     WHERE org_type_code = 'HQ'
       AND outdoor_warehouse_org_id = OLD.id
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION
        'Cannot deactivate the Outdoor shop warehouse for %. Choose another Outdoor shop warehouse first.',
        COALESCE(v_hq_name, 'the parent HQ');
    END IF;
  END IF;

  IF NEW.storefront_warehouse_org_id IS NOT NULL
     AND (
       TG_OP = 'INSERT'
       OR NEW.storefront_warehouse_org_id IS DISTINCT FROM OLD.storefront_warehouse_org_id
     ) THEN
    IF NEW.org_type_code IS DISTINCT FROM 'HQ' THEN
      RAISE EXCEPTION 'Only an HQ can have an online shop warehouse';
    END IF;
    IF NOT public.is_active_hq_fulfillment_warehouse(NEW.id, NEW.storefront_warehouse_org_id) THEN
      RAISE EXCEPTION 'Online shop warehouse must be an active warehouse directly under this HQ';
    END IF;
  END IF;

  IF NEW.outdoor_warehouse_org_id IS NOT NULL
     AND (
       TG_OP = 'INSERT'
       OR NEW.outdoor_warehouse_org_id IS DISTINCT FROM OLD.outdoor_warehouse_org_id
     ) THEN
    IF NEW.org_type_code IS DISTINCT FROM 'HQ' THEN
      RAISE EXCEPTION 'Only an HQ can have an Outdoor shop warehouse';
    END IF;
    IF NOT public.is_active_hq_fulfillment_warehouse(NEW.id, NEW.outdoor_warehouse_org_id) THEN
      RAISE EXCEPTION 'Outdoor shop warehouse must be an active warehouse directly under this HQ';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_organizations_protect_storefront_warehouse ON public.organizations;
CREATE TRIGGER trg_organizations_protect_storefront_warehouse
  BEFORE INSERT OR UPDATE OF is_active, storefront_warehouse_org_id, outdoor_warehouse_org_id, org_type_code
  ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.organizations_protect_storefront_warehouse();

-- ---------------------------------------------------------------------------
-- 2. Warehouse for a website channel
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.storefront_channel_warehouse(
  p_organization_id uuid DEFAULT NULL,
  p_channel text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_wh uuid := public.storefront_fulfilment_warehouse(p_organization_id);
  v_hq uuid;
  v_outdoor uuid;
BEGIN
  IF lower(COALESCE(p_channel, '')) <> 'outdoor' THEN
    RETURN v_wh;
  END IF;

  IF p_organization_id IS NOT NULL THEN
    v_hq := public.resolve_seller_hq_organization(p_organization_id);
  ELSE
    SELECT parent_org_id INTO v_hq FROM public.organizations WHERE id = v_wh;
  END IF;

  SELECT outdoor_warehouse_org_id INTO v_outdoor FROM public.organizations WHERE id = v_hq;
  IF v_outdoor IS NULL THEN
    RETURN v_wh;
  END IF;
  IF NOT public.is_active_hq_fulfillment_warehouse(v_hq, v_outdoor) THEN
    RAISE EXCEPTION 'storefront_no_fulfilment_warehouse: the Outdoor shop warehouse is no longer an active warehouse under the HQ.';
  END IF;
  RETURN v_outdoor;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Online stock allocation
-- ---------------------------------------------------------------------------
ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS online_stock_allocation integer;

ALTER TABLE public.product_variants
  DROP CONSTRAINT IF EXISTS product_variants_online_stock_allocation_check;
ALTER TABLE public.product_variants
  ADD CONSTRAINT product_variants_online_stock_allocation_check
  CHECK (online_stock_allocation IS NULL OR online_stock_allocation >= 0);

COMMENT ON COLUMN public.product_variants.online_stock_allocation IS
  'Units the website may still sell. Decreases when a website order ships, increases when one is returned or its shipment is undone. NULL = sell everything free in the shop warehouse. Never changes warehouse stock.';

-- ---------------------------------------------------------------------------
-- 4. What the website may still sell
-- ---------------------------------------------------------------------------
-- available = min(warehouse free - unshipped orders from that warehouse,
--                 allocation - every unshipped website order of the variant)
DROP FUNCTION IF EXISTS public.storefront_variant_stock(uuid[], uuid);

CREATE OR REPLACE FUNCTION public.storefront_variant_stock(
  p_variant_ids uuid[],
  p_organization_id uuid DEFAULT NULL,
  p_channel text DEFAULT NULL
)
RETURNS TABLE (variant_id uuid, on_hand integer, reserved integer, available integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_is_outdoor boolean := lower(COALESCE(p_channel, '')) = 'outdoor';
  v_store_wh uuid := public.storefront_fulfilment_warehouse(p_organization_id);
  v_outdoor_wh uuid;
  v_wh uuid;
  v_split boolean;
BEGIN
  IF v_is_outdoor THEN
    v_outdoor_wh := public.storefront_channel_warehouse(p_organization_id, 'outdoor');
  ELSE
    -- A broken Outdoor setting must not stop the other website.
    BEGIN
      v_outdoor_wh := public.storefront_channel_warehouse(p_organization_id, 'outdoor');
    EXCEPTION WHEN OTHERS THEN
      v_outdoor_wh := NULL;
    END;
  END IF;
  v_wh := CASE WHEN v_is_outdoor THEN v_outdoor_wh ELSE v_store_wh END;
  v_split := v_outdoor_wh IS NOT NULL AND v_outdoor_wh IS DISTINCT FROM v_store_wh;

  RETURN QUERY
  WITH wanted AS (
    SELECT DISTINCT unnest(p_variant_ids) AS variant_id
  ),
  stock AS (
    SELECT w.variant_id,
           COALESCE(pi.quantity_on_hand, 0)::integer AS on_hand,
           COALESCE(pi.quantity_on_hand - COALESCE(pi.quantity_allocated, 0), 0)::integer AS free,
           pv.online_stock_allocation AS allocation
      FROM wanted w
      LEFT JOIN public.product_variants pv
        ON pv.id = w.variant_id
      LEFT JOIN public.v_canonical_stock_config c
        ON c.variant_id = w.variant_id AND c.candidate_count = 1
      LEFT JOIN public.product_inventory pi
        ON pi.variant_id = w.variant_id
       AND pi.organization_id = v_wh
       AND pi.stock_config_id = c.stock_config_id
       AND pi.is_active = true
  ),
  held AS (
    SELECT i.variant_id,
           sum(i.quantity) FILTER (
             WHERE NOT v_split
                OR (lower(COALESCE(o.sales_channel, 'store')) = 'outdoor') = v_is_outdoor
           )::integer AS same_warehouse,
           sum(i.quantity)::integer AS every_channel
      FROM public.storefront_order_items i
      JOIN public.storefront_orders o ON o.id = i.order_id
     WHERE i.variant_id = ANY (p_variant_ids)
       AND o.status::text IN ('paid', 'processing')
       AND o.stock_out_at IS NULL
     GROUP BY i.variant_id
  )
  SELECT s.variant_id,
         s.on_hand,
         COALESCE(h.same_warehouse, 0),
         GREATEST(
           0,
           LEAST(
             s.free - COALESCE(h.same_warehouse, 0),
             COALESCE(s.allocation - COALESCE(h.every_channel, 0), s.free - COALESCE(h.same_warehouse, 0))
           )
         )
    FROM stock s
    LEFT JOIN held h ON h.variant_id = s.variant_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Ship: take stock from the channel's warehouse, use up the allocation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.storefront_order_stock_out(p_order_id uuid, p_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.storefront_orders%ROWTYPE;
  v_wh uuid;
  v_line record;
  v_on_hand integer;
  v_units integer := 0;
BEGIN
  SELECT * INTO v_order FROM public.storefront_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'storefront_order_not_found';
  END IF;
  IF v_order.stock_out_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already', 'warehouse_id', v_order.stock_warehouse_id);
  END IF;

  v_wh := public.storefront_channel_warehouse(v_order.organization_id, v_order.sales_channel);

  FOR v_line IN
    SELECT i.variant_id,
           sum(i.quantity)::integer AS qty,
           min(i.product_name) AS product_name,
           min(i.variant_name) AS variant_name
      FROM public.storefront_order_items i
     WHERE i.order_id = p_order_id AND i.variant_id IS NOT NULL
     GROUP BY i.variant_id
  LOOP
    SELECT pi.quantity_on_hand INTO v_on_hand
      FROM public.product_inventory pi
     WHERE pi.variant_id = v_line.variant_id
       AND pi.organization_id = v_wh
       AND pi.stock_config_id = public.resolve_operational_stock_config(v_line.variant_id)
       AND pi.is_active = true;
    IF COALESCE(v_on_hand, 0) < v_line.qty THEN
      RAISE EXCEPTION 'storefront_stock_short: % (%) has % in the warehouse, this order needs %.',
        v_line.product_name, v_line.variant_name, COALESCE(v_on_hand, 0), v_line.qty;
    END IF;

    PERFORM public.record_stock_movement(
      p_movement_type   => 'manual_out',
      p_variant_id      => v_line.variant_id,
      p_organization_id => v_wh,
      p_quantity_change => -v_line.qty,
      p_reason          => 'Website sale',
      p_notes           => format('%s order %s shipped', initcap(COALESCE(v_order.sales_channel, 'store')), v_order.order_ref),
      p_reference_type  => 'storefront_order',
      p_reference_id    => v_order.id,
      p_reference_no    => v_order.order_ref,
      p_created_by      => p_actor
    );

    UPDATE public.product_variants
       SET online_stock_allocation = GREATEST(0, online_stock_allocation - v_line.qty)
     WHERE id = v_line.variant_id
       AND online_stock_allocation IS NOT NULL;

    v_units := v_units + v_line.qty;
  END LOOP;

  UPDATE public.storefront_orders
     SET stock_warehouse_id = v_wh,
         stock_out_at = now()
   WHERE id = p_order_id;

  RETURN jsonb_build_object('status', 'taken', 'warehouse_id', v_wh, 'units', v_units);
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Return: stock back to the warehouse it left, allocation back
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.storefront_order_stock_return(p_order_id uuid, p_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.storefront_orders%ROWTYPE;
  v_line record;
  v_units integer := 0;
BEGIN
  SELECT * INTO v_order FROM public.storefront_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'storefront_order_not_found';
  END IF;
  IF v_order.stock_out_at IS NULL THEN
    RETURN jsonb_build_object('status', 'not_taken');
  END IF;
  IF v_order.stock_returned_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already', 'warehouse_id', v_order.stock_warehouse_id);
  END IF;

  FOR v_line IN
    SELECT i.variant_id, sum(i.quantity)::integer AS qty
      FROM public.storefront_order_items i
     WHERE i.order_id = p_order_id AND i.variant_id IS NOT NULL
     GROUP BY i.variant_id
  LOOP
    PERFORM public.record_stock_movement(
      p_movement_type   => 'manual_in',
      p_variant_id      => v_line.variant_id,
      p_organization_id => v_order.stock_warehouse_id,
      p_quantity_change => v_line.qty,
      p_reason          => 'Website order returned',
      p_notes           => format('%s order %s came back', initcap(COALESCE(v_order.sales_channel, 'store')), v_order.order_ref),
      p_reference_type  => 'storefront_order',
      p_reference_id    => v_order.id,
      p_reference_no    => v_order.order_ref,
      p_created_by      => p_actor
    );

    UPDATE public.product_variants
       SET online_stock_allocation = online_stock_allocation + v_line.qty
     WHERE id = v_line.variant_id
       AND online_stock_allocation IS NOT NULL;

    v_units := v_units + v_line.qty;
  END LOOP;

  UPDATE public.storefront_orders SET stock_returned_at = now() WHERE id = p_order_id;

  RETURN jsonb_build_object('status', 'returned', 'warehouse_id', v_order.stock_warehouse_id, 'units', v_units);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Undo a stock-out whose shipment never got saved
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.storefront_order_stock_undo(p_order_id uuid, p_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.storefront_orders%ROWTYPE;
  v_line record;
  v_units integer := 0;
BEGIN
  SELECT * INTO v_order FROM public.storefront_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'storefront_order_not_found';
  END IF;
  IF v_order.stock_out_at IS NULL OR v_order.stock_returned_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'not_taken');
  END IF;

  FOR v_line IN
    SELECT i.variant_id, sum(i.quantity)::integer AS qty
      FROM public.storefront_order_items i
     WHERE i.order_id = p_order_id AND i.variant_id IS NOT NULL
     GROUP BY i.variant_id
  LOOP
    PERFORM public.record_stock_movement(
      p_movement_type   => 'manual_in',
      p_variant_id      => v_line.variant_id,
      p_organization_id => v_order.stock_warehouse_id,
      p_quantity_change => v_line.qty,
      p_reason          => 'Website shipment not completed',
      p_notes           => format('Order %s was not marked shipped; stock restored', v_order.order_ref),
      p_reference_type  => 'storefront_order',
      p_reference_id    => v_order.id,
      p_reference_no    => v_order.order_ref,
      p_created_by      => p_actor
    );

    UPDATE public.product_variants
       SET online_stock_allocation = online_stock_allocation + v_line.qty
     WHERE id = v_line.variant_id
       AND online_stock_allocation IS NOT NULL;

    v_units := v_units + v_line.qty;
  END LOOP;

  UPDATE public.storefront_orders
     SET stock_out_at = NULL,
         stock_warehouse_id = NULL
   WHERE id = p_order_id;

  RETURN jsonb_build_object('status', 'returned', 'units', v_units);
END;
$$;

REVOKE ALL ON FUNCTION public.storefront_channel_warehouse(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.storefront_variant_stock(uuid[], uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.storefront_order_stock_out(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.storefront_order_stock_return(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.storefront_order_stock_undo(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.storefront_channel_warehouse(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.storefront_variant_stock(uuid[], uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.storefront_order_stock_out(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.storefront_order_stock_return(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.storefront_order_stock_undo(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
