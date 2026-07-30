-- ============================================================================
-- Stock Count V2 — group-specific configuration model
-- ============================================================================
-- Fixes the production defect where Device products under the Vape category
-- were showing nicotine-strength/flavour configurations (20mg/50mg New Box,
-- Unclassified) that do not apply to devices. Configuration eligibility must be
-- driven by an explicit, Product-Management-owned GROUP rule — not the parent
-- category alone and not hardcoded product names.
--
-- SAFETY / EXECUTION NOTES
--   * Forward-only and idempotent. Safe to run more than once.
--   * Parts A + B (column, backfill, guard) are non-destructive.
--   * Part C deactivates ONLY invalid, ZERO-BALANCE, unreferenced configurations
--     (status change only — never a DELETE). Configurations that carry any
--     balance, stock movement, or order reference are never touched.
--   * Part D (balance transfer) is DOCUMENTED ONLY and intentionally NOT executed
--     here — moving stock must happen through the controlled Opening Balance
--     flow, not a blanket migration.
--   * DO NOT run this against a shared database without review. It is delivered
--     for review as part of branch fix/stock-count-v2-group-configuration-rules.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Part A. Explicit group configuration profile
-- ----------------------------------------------------------------------------
-- 'concentration' — flavour / Cartridge groups: 20NB / 50NB / 50OB + a legacy
--                   Unclassified sink while pre-classification balances remain.
-- 'standard'      — Device groups and every non-flavour group (Speaker, Camping,
--                   Cat Treat, …): exactly one Standard/Device configuration; no
--                   concentration, no flavour classification, no New/Old Box
--                   unless a Standard configuration is explicitly created.
--
-- Default is 'standard' so a newly created group never silently inherits Vape
-- concentration rules; a group must be EXPLICITLY promoted to 'concentration'.

ALTER TABLE public.product_groups
  ADD COLUMN IF NOT EXISTS stock_config_profile text NOT NULL DEFAULT 'standard';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_groups_stock_config_profile_check'
  ) THEN
    ALTER TABLE public.product_groups
      ADD CONSTRAINT product_groups_stock_config_profile_check
      CHECK (stock_config_profile IN ('concentration', 'standard'));
  END IF;
END $$;

COMMENT ON COLUMN public.product_groups.stock_config_profile IS
  'Stock Count configuration profile. concentration = flavour/Cartridge groups (20NB/50NB/50OB + Unclassified); standard = Device and non-flavour groups (single Standard config). Owned by Product Management; drives centralized Stock Count eligibility.';

-- Backfill: promote to 'concentration' only groups that GENUINELY use a
-- concentration configuration — i.e. a concentration config that carries a
-- balance, a stock movement, or an order reference. Phantom concentration
-- configs on Device groups (zero balance, no history) are ignored, so Device
-- groups correctly remain 'standard'. This is data-driven, never name-based.
UPDATE public.product_groups g
SET stock_config_profile = 'concentration'
WHERE g.stock_config_profile <> 'concentration'
  AND EXISTS (
    SELECT 1
    FROM public.inventory_stock_configurations c
    JOIN public.product_variants pv ON pv.id = c.variant_id
    JOIN public.products p ON p.id = pv.product_id
    WHERE p.group_id = g.id
      AND (c.volume_ml IS NOT NULL OR c.packaging IS NOT NULL)  -- concentration config
      AND (
        EXISTS (SELECT 1 FROM public.product_inventory pi
                WHERE pi.stock_config_id = c.id AND pi.quantity_on_hand <> 0)
        OR EXISTS (SELECT 1 FROM public.stock_movements sm
                WHERE sm.stock_config_id = c.id)
        OR EXISTS (SELECT 1 FROM public.order_items oi
                WHERE oi.stock_config_id = c.id)
      )
  );

-- ----------------------------------------------------------------------------
-- Part B. Backend guard — reject concentration configs on standard groups
-- ----------------------------------------------------------------------------
-- Authoritative rejection at the data layer, so an invalid Device 20mg/50mg
-- configuration is refused even from a manipulated request, a direct insert, or
-- an Excel-driven config creation path.

CREATE OR REPLACE FUNCTION public.assert_stock_config_group_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile text;
BEGIN
  -- Only concentration configurations (a nicotine volume or Box packaging) are
  -- restricted; Standard/Unclassified configs are always allowed.
  IF NEW.volume_ml IS NULL AND NEW.packaging IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT g.stock_config_profile
  INTO v_profile
  FROM public.product_variants pv
  JOIN public.products p ON p.id = pv.product_id
  LEFT JOIN public.product_groups g ON g.id = p.group_id
  WHERE pv.id = NEW.variant_id;

  -- A product with no group is treated as standard (no concentration configs).
  IF COALESCE(v_profile, 'standard') <> 'concentration' THEN
    RAISE EXCEPTION
      'Concentration configuration % (%, %) is not valid for a non-flavour product group. Devices and other non-flavour groups use a single Standard configuration.',
      NEW.config_code, NEW.volume_ml, NEW.packaging
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_stock_config_group_eligibility ON public.inventory_stock_configurations;
CREATE TRIGGER trg_stock_config_group_eligibility
  BEFORE INSERT OR UPDATE OF variant_id, volume_ml, packaging, config_code
  ON public.inventory_stock_configurations
  FOR EACH ROW EXECUTE FUNCTION public.assert_stock_config_group_eligibility();

COMMENT ON FUNCTION public.assert_stock_config_group_eligibility() IS
  'Rejects concentration (20mg/50mg / Box) stock configurations on product groups whose stock_config_profile is not concentration. Centralized Stock Count eligibility backstop.';

-- ----------------------------------------------------------------------------
-- Part C. Deactivate invalid phantoms — DOCUMENTED ONLY, DO NOT AUTO-RUN
-- ----------------------------------------------------------------------------
-- IMPORTANT (incident 2026-07-27): This step must NEVER run automatically inside
-- the migration. It depends on stock_config_profile being CORRECT, but the
-- Part A backfill is a heuristic and is environment-sensitive: on an environment
-- where a genuine flavour/Cartridge group's concentration configs happened to
-- have no balance/movement/order at migration time, the group is left 'standard'
-- and this cleanup then wrongly deactivates every one of that group's valid
-- 20NB/50NB/50OB configurations (this is exactly what broke production Cartridge
-- while staging — which had history — was unaffected).
--
-- It is NOT needed for correct display: the application already hides zero-
-- balance ineligible configurations at runtime (isStockCountCatalogRowVisible)
-- purely from the profile, WITHOUT any destructive status change. Deactivation
-- is therefore optional hygiene, run manually ONLY AFTER every group's
-- stock_config_profile has been reviewed and confirmed:
--
--   -- 1. Confirm profiles first:
--   --    SELECT group_code, group_name, stock_config_profile FROM public.product_groups ORDER BY group_name;
--   -- 2. Only then, per confirmed-standard group, deactivate provably-unused
--   --    (zero balance, no movement, no order reference) concentration configs:
--   -- UPDATE public.inventory_stock_configurations c
--   -- SET status = 'inactive', allow_ord = false, allow_so = false,
--   --     default_for_ord = false, updated_at = now()
--   -- FROM public.product_variants pv
--   -- JOIN public.products p ON p.id = pv.product_id
--   -- JOIN public.product_groups g ON g.id = p.group_id
--   -- WHERE c.variant_id = pv.id
--   --   AND (c.volume_ml IS NOT NULL OR c.packaging IS NOT NULL)
--   --   AND g.stock_config_profile = 'standard'
--   --   AND g.group_code = ANY ('{...confirmed standard group codes...}')  -- explicit allowlist
--   --   AND c.status <> 'inactive'
--   --   AND NOT EXISTS (SELECT 1 FROM public.product_inventory pi WHERE pi.stock_config_id = c.id AND pi.quantity_on_hand <> 0)
--   --   AND NOT EXISTS (SELECT 1 FROM public.stock_movements sm WHERE sm.stock_config_id = c.id)
--   --   AND NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.stock_config_id = c.id);

-- ----------------------------------------------------------------------------
-- Part D. Device Unclassified -> Standard balance transfer (DOCUMENTED ONLY)
-- ----------------------------------------------------------------------------
-- Some Device variants carry a real balance on their Unclassified (pending stock
-- take) configuration (e.g. Arctic 1,072; Sage Green 427). That balance must be
-- moved into the single valid Standard/Device configuration WITHOUT duplicating
-- stock. This is intentionally NOT performed by this migration because it moves
-- inventory and must be auditable through the controlled Opening Balance flow.
--
-- Recommended approach (run per warehouse under the Opening Balance workflow, or
-- via a dedicated reviewed data-fix script, one atomic transaction per config):
--   1. Resolve the variant's Standard configuration
--        (is_variant_default = true, volume_ml IS NULL, packaging IS NULL).
--   2. For each (warehouse, Unclassified config) with quantity_on_hand > 0:
--        a. Insert/So-update the Standard config's product_inventory row,
--           adding the Unclassified quantity_on_hand and quantity_allocated.
--        b. Zero the Unclassified product_inventory row.
--        c. Write two balancing stock_movements (OUT of Unclassified, IN to
--           Standard) with a reason of 'device_unclassified_to_standard' so the
--           net inventory change is exactly zero (no duplication).
--   3. Only after every balance is transferred, deactivate the now-zero
--        Unclassified config (Part C already handles zero-balance concentration
--        phantoms; the Unclassified sink is handled here once emptied).
--
-- Because it changes inventory, this step is deliberately left for a reviewed,
-- environment-specific execution and is NOT included in this migration body.

COMMIT;
