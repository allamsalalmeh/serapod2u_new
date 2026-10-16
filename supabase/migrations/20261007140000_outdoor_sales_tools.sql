-- ============================================================================
-- Outdoor sales tools: combos, checkout offer (order bump), shipping subsidy,
-- affiliate / live-host links.
-- ----------------------------------------------------------------------------
-- * Combos are sold as one cart line but saved on the order as one line per
--   real variant, so the existing stock functions deduct each SKU unchanged.
-- * Settings start switched off (customer pays 100% of delivery, no offer), so
--   checkout behaves exactly as before until staff turn them on.
-- * New tables are server-only: RLS on, no policies, no anon/authenticated
--   privileges. The app reads and writes them through API routes.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.outdoor_checkout_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  shipping_customer_share_percent numeric(5,2) NOT NULL DEFAULT 100
    CHECK (shipping_customer_share_percent >= 0 AND shipping_customer_share_percent <= 100),
  order_bump_enabled boolean NOT NULL DEFAULT false,
  order_bump_variant_id uuid REFERENCES public.product_variants(id) ON DELETE SET NULL,
  order_bump_price numeric(10,2) CHECK (order_bump_price IS NULL OR order_bump_price >= 0),
  order_bump_compare_price numeric(10,2) CHECK (order_bump_compare_price IS NULL OR order_bump_compare_price >= 0),
  order_bump_text text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

INSERT INTO public.outdoor_checkout_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.outdoor_checkout_settings IS
  'One row. Outdoor checkout offer (order bump) and the share of the delivery price the customer pays.';
COMMENT ON COLUMN public.outdoor_checkout_settings.shipping_customer_share_percent IS
  'Customer pays this percent of the product delivery price; the company covers the rest. 100 = no subsidy.';

CREATE TABLE IF NOT EXISTS public.outdoor_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text,
  price numeric(10,2) NOT NULL CHECK (price > 0),
  image_url text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.outdoor_bundle_items (
  bundle_id uuid NOT NULL REFERENCES public.outdoor_bundles(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES public.product_variants(id) ON DELETE RESTRICT,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 99),
  PRIMARY KEY (bundle_id, variant_id)
);

COMMENT ON TABLE public.outdoor_bundles IS
  'Outdoor combo deals. Sold at one price; saved on orders as one line per real variant (storefront_order_items.bundle_id).';

CREATE TABLE IF NOT EXISTS public.outdoor_affiliates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{3,32}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  kind text NOT NULL DEFAULT 'host' CHECK (kind IN ('host', 'affiliate')),
  commission_percent numeric(5,2) NOT NULL DEFAULT 0
    CHECK (commission_percent >= 0 AND commission_percent <= 100),
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.outdoor_affiliates IS
  'Live hosts and affiliates. Each has a link /outdoor?ref=CODE; orders placed within 30 days of the click are attributed.';

ALTER TABLE public.storefront_orders
  ADD COLUMN IF NOT EXISTS affiliate_id uuid REFERENCES public.outdoor_affiliates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS affiliate_code text,
  ADD COLUMN IF NOT EXISTS shipping_actual_cost numeric(10,2),
  ADD COLUMN IF NOT EXISTS shipping_subsidy_amount numeric(10,2);

CREATE INDEX IF NOT EXISTS storefront_orders_affiliate_created_idx
  ON public.storefront_orders (affiliate_id, created_at)
  WHERE affiliate_id IS NOT NULL;

COMMENT ON COLUMN public.storefront_orders.shipping_actual_cost IS
  'Delivery price before the company subsidy. shipping_amount is what the customer paid.';
COMMENT ON COLUMN public.storefront_orders.shipping_subsidy_amount IS
  'Part of shipping_actual_cost the company covered.';

ALTER TABLE public.storefront_order_items
  ADD COLUMN IF NOT EXISTS line_kind text,
  ADD COLUMN IF NOT EXISTS bundle_id uuid REFERENCES public.outdoor_bundles(id) ON DELETE SET NULL;

ALTER TABLE public.storefront_order_items
  DROP CONSTRAINT IF EXISTS storefront_order_items_line_kind_check;
ALTER TABLE public.storefront_order_items
  ADD CONSTRAINT storefront_order_items_line_kind_check
  CHECK (line_kind IS NULL OR line_kind IN ('bundle', 'order_bump'));

ALTER TABLE public.outdoor_checkout_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outdoor_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outdoor_bundle_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outdoor_affiliates ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.outdoor_checkout_settings FROM public, anon, authenticated;
REVOKE ALL ON TABLE public.outdoor_bundles FROM public, anon, authenticated;
REVOKE ALL ON TABLE public.outdoor_bundle_items FROM public, anon, authenticated;
REVOKE ALL ON TABLE public.outdoor_affiliates FROM public, anon, authenticated;

GRANT ALL ON TABLE public.outdoor_checkout_settings TO service_role;
GRANT ALL ON TABLE public.outdoor_bundles TO service_role;
GRANT ALL ON TABLE public.outdoor_bundle_items TO service_role;
GRANT ALL ON TABLE public.outdoor_affiliates TO service_role;

COMMIT;
