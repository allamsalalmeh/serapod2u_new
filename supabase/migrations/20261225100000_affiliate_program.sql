-- ============================================================================
-- Affiliate program (Store + Outdoor), on top of outdoor_affiliates.
-- ----------------------------------------------------------------------------
-- * Additive only. Existing affiliates (live hosts) keep working unchanged:
--   new columns default to source 'staff', status 'approved', own rate.
-- * The program starts switched off (enabled = false, no rate): nobody can
--   join and Store checkout attributes nothing until staff turn it on.
-- * The rate and the eligible goods value are saved on the order at checkout,
--   so later setting changes never rewrite earned commission.
-- * Commission: pending when paid, confirmed confirm_after_days after delivery
--   (held while a return / problem request is open), cancelled when the order
--   is cancelled or refunded, paid when staff record the bank transfer.
-- * New tables are server-only: RLS on, no policies, no anon/authenticated
--   privileges. The app reads and writes them through API routes.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.affiliate_program_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled boolean NOT NULL DEFAULT false,
  join_mode text NOT NULL DEFAULT 'open' CHECK (join_mode IN ('open', 'approval')),
  commission_percent numeric(5,2)
    CHECK (commission_percent IS NULL OR (commission_percent >= 0 AND commission_percent <= 100)),
  attribution_days integer NOT NULL DEFAULT 30 CHECK (attribution_days BETWEEN 1 AND 365),
  confirm_after_days integer NOT NULL DEFAULT 7 CHECK (confirm_after_days BETWEEN 0 AND 180),
  min_payout_amount numeric(10,2) NOT NULL DEFAULT 0 CHECK (min_payout_amount >= 0),
  exclude_vape boolean NOT NULL DEFAULT true,
  excluded_category_ids uuid[] NOT NULL DEFAULT '{}',
  excluded_product_ids uuid[] NOT NULL DEFAULT '{}',
  terms text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

INSERT INTO public.affiliate_program_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.affiliate_program_settings IS
  'One row. Affiliate program switches: who may join, the commission rate, attribution and confirmation windows, excluded products.';

ALTER TABLE public.outdoor_affiliates
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'staff',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS commission_mode text NOT NULL DEFAULT 'custom',
  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS contact_phone text,
  ADD COLUMN IF NOT EXISTS bank_name text,
  ADD COLUMN IF NOT EXISTS bank_account_no text,
  ADD COLUMN IF NOT EXISTS bank_account_name text,
  ADD COLUMN IF NOT EXISTS applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid,
  ADD COLUMN IF NOT EXISTS review_note text;

ALTER TABLE public.outdoor_affiliates DROP CONSTRAINT IF EXISTS outdoor_affiliates_source_check;
ALTER TABLE public.outdoor_affiliates
  ADD CONSTRAINT outdoor_affiliates_source_check CHECK (source IN ('staff', 'self'));
ALTER TABLE public.outdoor_affiliates DROP CONSTRAINT IF EXISTS outdoor_affiliates_status_check;
ALTER TABLE public.outdoor_affiliates
  ADD CONSTRAINT outdoor_affiliates_status_check CHECK (status IN ('pending', 'approved', 'rejected', 'suspended'));
ALTER TABLE public.outdoor_affiliates DROP CONSTRAINT IF EXISTS outdoor_affiliates_commission_mode_check;
ALTER TABLE public.outdoor_affiliates
  ADD CONSTRAINT outdoor_affiliates_commission_mode_check CHECK (commission_mode IN ('custom', 'program'));

CREATE UNIQUE INDEX IF NOT EXISTS outdoor_affiliates_user_uidx
  ON public.outdoor_affiliates (user_id) WHERE user_id IS NOT NULL;

COMMENT ON COLUMN public.outdoor_affiliates.source IS
  'staff = added by staff (live hosts); self = joined from the shopper account.';
COMMENT ON COLUMN public.outdoor_affiliates.status IS
  'Program status. is_active stays the attribution switch and is true only while approved.';
COMMENT ON COLUMN public.outdoor_affiliates.commission_mode IS
  'custom = commission_percent of this row; program = affiliate_program_settings.commission_percent.';

ALTER TABLE public.storefront_orders
  ADD COLUMN IF NOT EXISTS affiliate_sub_id text,
  ADD COLUMN IF NOT EXISTS affiliate_commission_percent numeric(5,2),
  ADD COLUMN IF NOT EXISTS affiliate_eligible_amount numeric(12,2);

COMMENT ON COLUMN public.storefront_orders.affiliate_commission_percent IS
  'Affiliate program rate saved at checkout. NULL = no program commission (live hosts, no affiliate).';
COMMENT ON COLUMN public.storefront_orders.affiliate_eligible_amount IS
  'Goods value of the lines that earn commission (excluded products and delivery left out), saved at checkout.';

CREATE TABLE IF NOT EXISTS public.affiliate_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id uuid NOT NULL REFERENCES public.outdoor_affiliates(id) ON DELETE RESTRICT,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  commission_count integer NOT NULL CHECK (commission_count > 0),
  bank_name text,
  bank_account_no text,
  bank_account_name text,
  transfer_reference text NOT NULL CHECK (length(btrim(transfer_reference)) BETWEEN 1 AND 120),
  notes text,
  paid_at timestamptz NOT NULL DEFAULT now(),
  paid_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS affiliate_payouts_affiliate_idx ON public.affiliate_payouts (affiliate_id, paid_at DESC);

CREATE TABLE IF NOT EXISTS public.affiliate_commissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES public.storefront_orders(id) ON DELETE CASCADE,
  affiliate_id uuid NOT NULL REFERENCES public.outdoor_affiliates(id) ON DELETE RESTRICT,
  order_ref text NOT NULL,
  sales_channel text,
  sub_id text,
  eligible_amount numeric(12,2) NOT NULL DEFAULT 0,
  commission_percent numeric(5,2) NOT NULL,
  commission_amount numeric(12,2) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'paid')),
  ordered_at timestamptz NOT NULL,
  delivered_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  payout_id uuid REFERENCES public.affiliate_payouts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS affiliate_commissions_affiliate_idx ON public.affiliate_commissions (affiliate_id, status);

COMMENT ON TABLE public.affiliate_commissions IS
  'One row per attributed program order (affiliate_sync_commissions). Rate and goods value come from the order.';

-- Brings the commission ledger up to date with the orders. Idempotent.
CREATE OR REPLACE FUNCTION public.affiliate_sync_commissions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_confirm integer;
  v_inserted integer;
  v_cancelled integer;
  v_confirmed integer;
BEGIN
  SELECT confirm_after_days INTO v_confirm FROM public.affiliate_program_settings WHERE id = 1;
  v_confirm := coalesce(v_confirm, 7);

  INSERT INTO public.affiliate_commissions (
    order_id, affiliate_id, order_ref, sales_channel, sub_id,
    eligible_amount, commission_percent, commission_amount, status, ordered_at
  )
  SELECT o.id, o.affiliate_id, o.order_ref, o.sales_channel, o.affiliate_sub_id,
         coalesce(o.affiliate_eligible_amount, 0), o.affiliate_commission_percent,
         round(coalesce(o.affiliate_eligible_amount, 0) * o.affiliate_commission_percent / 100, 2),
         'pending', coalesce(o.paid_at, o.created_at)
  FROM public.storefront_orders o
  WHERE o.affiliate_id IS NOT NULL
    AND o.affiliate_commission_percent IS NOT NULL
    AND o.status IN ('paid', 'processing', 'shipped', 'delivered')
  ON CONFLICT (order_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  UPDATE public.affiliate_commissions c
  SET status = 'cancelled', cancelled_at = now(), updated_at = now()
  FROM public.storefront_orders o
  WHERE o.id = c.order_id
    AND c.status IN ('pending', 'confirmed')
    AND o.status IN ('cancelled', 'refunded', 'payment_failed');
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  UPDATE public.affiliate_commissions c
  SET delivered_at = coalesce(
        (SELECT max(e.created_at) FROM public.storefront_order_events e
         WHERE e.order_id = c.order_id AND e.to_status = 'delivered'),
        o.updated_at),
      updated_at = now()
  FROM public.storefront_orders o
  WHERE o.id = c.order_id
    AND c.status = 'pending'
    AND o.status = 'delivered'
    AND c.delivered_at IS NULL;

  UPDATE public.affiliate_commissions c
  SET status = 'confirmed', confirmed_at = now(), updated_at = now()
  FROM public.storefront_orders o
  WHERE o.id = c.order_id
    AND c.status = 'pending'
    AND o.status = 'delivered'
    AND c.delivered_at IS NOT NULL
    AND c.delivered_at + make_interval(days => v_confirm) <= now()
    AND NOT EXISTS (
      SELECT 1 FROM public.storefront_order_requests r
      WHERE r.order_id = c.order_id AND r.status IN ('new', 'reviewing', 'approved')
    );
  GET DIAGNOSTICS v_confirmed = ROW_COUNT;

  RETURN jsonb_build_object('inserted', v_inserted, 'cancelled', v_cancelled, 'confirmed', v_confirmed);
END;
$$;

-- Records one bank transfer covering every confirmed, unpaid commission of the affiliate.
CREATE OR REPLACE FUNCTION public.affiliate_record_payout(
  p_affiliate_id uuid,
  p_reference text,
  p_notes text,
  p_actor uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_affiliate public.outdoor_affiliates%ROWTYPE;
  v_amount numeric(12,2);
  v_count integer;
  v_payout uuid;
BEGIN
  IF coalesce(btrim(p_reference), '') = '' THEN
    RAISE EXCEPTION 'affiliate_payout_reference_required';
  END IF;

  SELECT * INTO v_affiliate FROM public.outdoor_affiliates WHERE id = p_affiliate_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'affiliate_not_found';
  END IF;

  PERFORM 1 FROM public.affiliate_commissions
  WHERE affiliate_id = p_affiliate_id AND status = 'confirmed' AND payout_id IS NULL
  FOR UPDATE;

  SELECT coalesce(sum(commission_amount), 0), count(*)
  INTO v_amount, v_count
  FROM public.affiliate_commissions
  WHERE affiliate_id = p_affiliate_id AND status = 'confirmed' AND payout_id IS NULL;

  IF v_count = 0 OR v_amount <= 0 THEN
    RAISE EXCEPTION 'affiliate_payout_nothing_to_pay';
  END IF;

  INSERT INTO public.affiliate_payouts (
    affiliate_id, amount, commission_count, bank_name, bank_account_no, bank_account_name,
    transfer_reference, notes, paid_by
  ) VALUES (
    p_affiliate_id, v_amount, v_count, v_affiliate.bank_name, v_affiliate.bank_account_no,
    v_affiliate.bank_account_name, left(btrim(p_reference), 120), nullif(left(btrim(coalesce(p_notes, '')), 500), ''), p_actor
  )
  RETURNING id INTO v_payout;

  UPDATE public.affiliate_commissions
  SET status = 'paid', payout_id = v_payout, updated_at = now()
  WHERE affiliate_id = p_affiliate_id AND status = 'confirmed' AND payout_id IS NULL;

  RETURN jsonb_build_object('payout_id', v_payout, 'amount', v_amount, 'count', v_count);
END;
$$;

ALTER TABLE public.affiliate_program_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_commissions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.affiliate_program_settings FROM public, anon, authenticated;
REVOKE ALL ON TABLE public.affiliate_payouts FROM public, anon, authenticated;
REVOKE ALL ON TABLE public.affiliate_commissions FROM public, anon, authenticated;

GRANT ALL ON TABLE public.affiliate_program_settings TO service_role;
GRANT ALL ON TABLE public.affiliate_payouts TO service_role;
GRANT ALL ON TABLE public.affiliate_commissions TO service_role;

REVOKE ALL ON FUNCTION public.affiliate_sync_commissions() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.affiliate_record_payout(uuid, text, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.affiliate_sync_commissions() TO service_role;
GRANT EXECUTE ON FUNCTION public.affiliate_record_payout(uuid, text, text, uuid) TO service_role;

COMMIT;
