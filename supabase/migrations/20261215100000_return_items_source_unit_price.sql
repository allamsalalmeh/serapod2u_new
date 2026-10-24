BEGIN;

-- ============================================================================
-- Return Product: value returns at the source's price, not the factory cost.
-- ----------------------------------------------------------------------------
-- return_case_items.unit_cost is the cost of one stock unit (product_variants
-- .base_cost). It stays: post_return_case_inventory values the stock it adds
-- at cost. But the return note's value (screen, PDF sent to the distributor,
-- reports, notifications) also used it, so it showed the factory cost.
--
-- unit_price is the price of one stock unit to whoever returned it, set by the
-- server when the line is saved: distributor returns use distributor_price,
-- shop returns use retailer_price. Lines saved before this have NULL and keep
-- their existing value until corrected separately. Additive; no data changed.
-- ============================================================================

ALTER TABLE public.return_case_items
  ADD COLUMN IF NOT EXISTS unit_price numeric(12,2);

ALTER TABLE public.return_case_items
  DROP CONSTRAINT IF EXISTS return_case_items_unit_price_check;
ALTER TABLE public.return_case_items
  ADD CONSTRAINT return_case_items_unit_price_check
  CHECK (unit_price IS NULL OR unit_price >= 0);

COMMENT ON COLUMN public.return_case_items.unit_price IS
  'Price of one stock unit to the return source (distributor_price for distributor returns, retailer_price for shop returns), set when the line is saved. Values the return. NULL on lines saved before it existed. unit_cost stays the stock cost.';

NOTIFY pgrst, 'reload schema';

COMMIT;
