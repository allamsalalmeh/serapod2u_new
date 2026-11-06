-- Affiliate program production hardening.
-- Apply after 20261225100000_affiliate_program.sql.
--
-- Financial invariants:
-- * commission cannot become payable before the 7-day storefront refund window closes;
-- * an open return/problem request moves a confirmed commission back to pending;
-- * payout sync, eligibility, amount and bank snapshot are checked atomically;
-- * API totals come from a database aggregate, never a truncated history page.

BEGIN;

ALTER TABLE public.affiliate_program_settings
  ADD COLUMN IF NOT EXISTS terms_version integer NOT NULL DEFAULT 1;
ALTER TABLE public.affiliate_program_settings
  DROP CONSTRAINT IF EXISTS affiliate_program_settings_terms_version_check;
ALTER TABLE public.affiliate_program_settings
  ADD CONSTRAINT affiliate_program_settings_terms_version_check CHECK (terms_version >= 1);

ALTER TABLE public.outdoor_affiliates
  ADD COLUMN IF NOT EXISTS terms_version_accepted integer,
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
ALTER TABLE public.outdoor_affiliates
  DROP CONSTRAINT IF EXISTS outdoor_affiliates_terms_version_accepted_check;
ALTER TABLE public.outdoor_affiliates
  ADD CONSTRAINT outdoor_affiliates_terms_version_accepted_check
  CHECK (terms_version_accepted IS NULL OR terms_version_accepted >= 1);

-- Version changes must be serialized with the terms write. An API read-then-write
-- can assign the same version to two concurrent edits and invalidate acceptance evidence.
CREATE OR REPLACE FUNCTION public.affiliate_version_program_terms()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.terms_version := greatest(coalesce(NEW.terms_version, 1), 1);
  ELSIF NEW.terms IS DISTINCT FROM OLD.terms THEN
    NEW.terms_version := OLD.terms_version + 1;
  ELSE
    NEW.terms_version := OLD.terms_version;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS affiliate_program_settings_version_terms
  ON public.affiliate_program_settings;
CREATE TRIGGER affiliate_program_settings_version_terms
BEFORE INSERT OR UPDATE OF terms, terms_version ON public.affiliate_program_settings
FOR EACH ROW EXECUTE FUNCTION public.affiliate_version_program_terms();

REVOKE ALL ON FUNCTION public.affiliate_version_program_terms() FROM public, anon, authenticated;

UPDATE public.affiliate_program_settings
SET confirm_after_days = 7,
    updated_at = now()
WHERE confirm_after_days < 7;

ALTER TABLE public.affiliate_program_settings
  DROP CONSTRAINT IF EXISTS affiliate_program_settings_confirm_after_days_check;
ALTER TABLE public.affiliate_program_settings
  ADD CONSTRAINT affiliate_program_settings_confirm_after_days_check
  CHECK (confirm_after_days BETWEEN 7 AND 180);

ALTER TABLE public.storefront_orders
  DROP CONSTRAINT IF EXISTS storefront_orders_affiliate_commission_percent_check;
ALTER TABLE public.storefront_orders
  ADD CONSTRAINT storefront_orders_affiliate_commission_percent_check
  CHECK (
    affiliate_commission_percent IS NULL
    OR affiliate_commission_percent BETWEEN 0 AND 100
  );

ALTER TABLE public.storefront_orders
  DROP CONSTRAINT IF EXISTS storefront_orders_affiliate_eligible_amount_check;
ALTER TABLE public.storefront_orders
  ADD CONSTRAINT storefront_orders_affiliate_eligible_amount_check
  CHECK (affiliate_eligible_amount IS NULL OR affiliate_eligible_amount >= 0);

ALTER TABLE public.affiliate_commissions
  DROP CONSTRAINT IF EXISTS affiliate_commissions_eligible_amount_check;
ALTER TABLE public.affiliate_commissions
  ADD CONSTRAINT affiliate_commissions_eligible_amount_check CHECK (eligible_amount >= 0);

ALTER TABLE public.affiliate_commissions
  DROP CONSTRAINT IF EXISTS affiliate_commissions_commission_percent_check;
ALTER TABLE public.affiliate_commissions
  ADD CONSTRAINT affiliate_commissions_commission_percent_check
  CHECK (commission_percent BETWEEN 0 AND 100);

ALTER TABLE public.affiliate_commissions
  DROP CONSTRAINT IF EXISTS affiliate_commissions_commission_amount_check;
ALTER TABLE public.affiliate_commissions
  ADD CONSTRAINT affiliate_commissions_commission_amount_check CHECK (commission_amount >= 0);

-- Financial ledger rows must survive; an order with a commission cannot be hard-deleted.
ALTER TABLE public.affiliate_commissions
  DROP CONSTRAINT IF EXISTS affiliate_commissions_order_id_fkey;
ALTER TABLE public.affiliate_commissions
  ADD CONSTRAINT affiliate_commissions_order_id_fkey
  FOREIGN KEY (order_id) REFERENCES public.storefront_orders(id) ON DELETE RESTRICT;

-- Full totals for one affiliate or every affiliate. History endpoints may paginate,
-- but money cards and payout previews must never be calculated from those pages.
CREATE OR REPLACE FUNCTION public.affiliate_commission_totals(p_affiliate_id uuid DEFAULT NULL)
RETURNS TABLE (
  affiliate_id uuid,
  pending numeric,
  confirmed numeric,
  paid numeric,
  cancelled numeric,
  orders bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    c.affiliate_id,
    coalesce(sum(c.commission_amount) FILTER (WHERE c.status = 'pending'), 0)::numeric,
    coalesce(sum(c.commission_amount) FILTER (WHERE c.status = 'confirmed'), 0)::numeric,
    coalesce(sum(c.commission_amount) FILTER (WHERE c.status = 'paid'), 0)::numeric,
    coalesce(sum(c.commission_amount) FILTER (WHERE c.status = 'cancelled'), 0)::numeric,
    count(*) FILTER (WHERE c.status <> 'cancelled')
  FROM public.affiliate_commissions c
  WHERE p_affiliate_id IS NULL OR c.affiliate_id = p_affiliate_id
  GROUP BY c.affiliate_id;
$$;

CREATE OR REPLACE FUNCTION public.affiliate_sync_commissions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_confirm integer;
  v_inserted integer;
  v_cancelled integer;
  v_held integer;
  v_confirmed integer;
BEGIN
  SELECT confirm_after_days INTO v_confirm
  FROM public.affiliate_program_settings
  WHERE id = 1;
  v_confirm := greatest(coalesce(v_confirm, 7), 7);

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
  SET status = 'cancelled', cancelled_at = now(), confirmed_at = NULL, updated_at = now()
  FROM public.storefront_orders o
  WHERE o.id = c.order_id
    AND c.status IN ('pending', 'confirmed')
    AND o.status IN ('cancelled', 'refunded', 'payment_failed');
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  -- A request can be opened after confirmation. Put it back on hold before any payout.
  UPDATE public.affiliate_commissions c
  SET status = 'pending', confirmed_at = NULL, updated_at = now()
  WHERE c.status = 'confirmed'
    AND c.payout_id IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.storefront_order_requests r
      WHERE r.order_id = c.order_id
        AND r.status IN ('new', 'reviewing', 'approved')
    );
  GET DIAGNOSTICS v_held = ROW_COUNT;

  UPDATE public.affiliate_commissions c
  SET delivered_at = coalesce(
        (SELECT max(e.created_at)
         FROM public.storefront_order_events e
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
    -- Strictly after the refund window; at the exact boundary refunds remain open.
    AND c.delivered_at + make_interval(days => v_confirm) < now()
    AND NOT EXISTS (
      SELECT 1
      FROM public.storefront_order_requests r
      WHERE r.order_id = c.order_id
        AND r.status IN ('new', 'reviewing', 'approved')
    );
  GET DIAGNOSTICS v_confirmed = ROW_COUNT;

  RETURN jsonb_build_object(
    'inserted', v_inserted,
    'cancelled', v_cancelled,
    'held', v_held,
    'confirmed', v_confirmed
  );
END;
$$;

-- Replace the original four-argument function; leaving it in place would keep
-- an unsafe PostgREST overload that has no expected amount/bank snapshot.
DROP FUNCTION IF EXISTS public.affiliate_record_payout(uuid, text, text, uuid);

CREATE OR REPLACE FUNCTION public.affiliate_record_payout(
  p_affiliate_id uuid,
  p_reference text,
  p_notes text,
  p_actor uuid,
  p_expected_amount numeric,
  p_expected_bank_name text,
  p_expected_bank_account_no text,
  p_expected_bank_account_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_affiliate public.outdoor_affiliates%ROWTYPE;
  v_commission_ids uuid[];
  v_order_ids uuid[];
  v_amount numeric(12,2);
  v_min_payout numeric(10,2);
  v_count integer;
  v_updated integer;
  v_payout uuid;
BEGIN
  IF coalesce(btrim(p_reference), '') = '' THEN
    RAISE EXCEPTION 'affiliate_payout_reference_required';
  END IF;

  -- This exception aborts the payout transaction if ledger reconciliation fails.
  PERFORM public.affiliate_sync_commissions();

  SELECT * INTO v_affiliate
  FROM public.outdoor_affiliates
  WHERE id = p_affiliate_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'affiliate_not_found';
  END IF;

  IF coalesce(btrim(v_affiliate.bank_name), '') = ''
     OR coalesce(btrim(v_affiliate.bank_account_no), '') = ''
     OR coalesce(btrim(v_affiliate.bank_account_name), '') = ''
  THEN
    RAISE EXCEPTION 'affiliate_payout_bank_required';
  END IF;

  IF coalesce(btrim(p_expected_bank_name), '') IS DISTINCT FROM coalesce(btrim(v_affiliate.bank_name), '')
     OR coalesce(btrim(p_expected_bank_account_no), '') IS DISTINCT FROM coalesce(btrim(v_affiliate.bank_account_no), '')
     OR coalesce(btrim(p_expected_bank_account_name), '') IS DISTINCT FROM coalesce(btrim(v_affiliate.bank_account_name), '')
  THEN
    RAISE EXCEPTION 'affiliate_payout_snapshot_changed';
  END IF;

  WITH locked AS MATERIALIZED (
    SELECT c.id, c.order_id, c.commission_amount
    FROM public.affiliate_commissions c
    JOIN public.storefront_orders o ON o.id = c.order_id
    WHERE c.affiliate_id = p_affiliate_id
      AND c.status = 'confirmed'
      AND c.payout_id IS NULL
      AND o.status = 'delivered'
      AND NOT EXISTS (
        SELECT 1
        FROM public.storefront_order_requests r
        WHERE r.order_id = c.order_id
          AND r.status IN ('new', 'reviewing', 'approved')
      )
    ORDER BY c.id
    -- Serialize eligibility with concurrent refund/status transitions as well as ledger writes.
    FOR UPDATE OF c, o
  )
  SELECT
    coalesce(array_agg(id), ARRAY[]::uuid[]),
    coalesce(array_agg(order_id), ARRAY[]::uuid[]),
    coalesce(sum(commission_amount), 0)::numeric(12,2),
    count(*)::integer
  INTO v_commission_ids, v_order_ids, v_amount, v_count
  FROM locked;

  -- This is a new READ COMMITTED snapshot after the order locks. A request that
  -- started first finishes before those locks are acquired; one that starts now
  -- waits on the order FK key-share lock until this payout transaction ends.
  IF EXISTS (
    SELECT 1
    FROM public.storefront_order_requests r
    WHERE r.order_id = ANY(v_order_ids)
      AND r.status IN ('new', 'reviewing', 'approved')
  ) THEN
    RAISE EXCEPTION 'affiliate_payout_snapshot_changed';
  END IF;

  IF v_count = 0 OR v_amount <= 0 THEN
    RAISE EXCEPTION 'affiliate_payout_nothing_to_pay';
  END IF;

  IF p_expected_amount IS NULL OR round(p_expected_amount, 2) <> v_amount THEN
    RAISE EXCEPTION 'affiliate_payout_snapshot_changed';
  END IF;

  SELECT coalesce(min_payout_amount, 0)
  INTO v_min_payout
  FROM public.affiliate_program_settings
  WHERE id = 1;
  v_min_payout := coalesce(v_min_payout, 0);
  IF v_amount < v_min_payout THEN
    RAISE EXCEPTION 'affiliate_payout_below_minimum';
  END IF;

  INSERT INTO public.affiliate_payouts (
    affiliate_id, amount, commission_count, bank_name, bank_account_no, bank_account_name,
    transfer_reference, notes, paid_by
  ) VALUES (
    p_affiliate_id, v_amount, v_count,
    v_affiliate.bank_name, v_affiliate.bank_account_no, v_affiliate.bank_account_name,
    left(btrim(p_reference), 120),
    nullif(left(btrim(coalesce(p_notes, '')), 500), ''),
    p_actor
  )
  RETURNING id INTO v_payout;

  UPDATE public.affiliate_commissions
  SET status = 'paid', payout_id = v_payout, updated_at = now()
  WHERE id = ANY(v_commission_ids)
    AND status = 'confirmed'
    AND payout_id IS NULL;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> v_count THEN
    RAISE EXCEPTION 'affiliate_payout_snapshot_changed';
  END IF;

  RETURN jsonb_build_object('payout_id', v_payout, 'amount', v_amount, 'count', v_count);
END;
$$;

REVOKE ALL ON FUNCTION public.affiliate_commission_totals(uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.affiliate_sync_commissions() FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.affiliate_record_payout(uuid, text, text, uuid, numeric, text, text, text)
  FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.affiliate_commission_totals(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.affiliate_sync_commissions() TO service_role;
GRANT EXECUTE ON FUNCTION public.affiliate_record_payout(uuid, text, text, uuid, numeric, text, text, text)
  TO service_role;

COMMENT ON FUNCTION public.affiliate_commission_totals(uuid) IS
  'Complete affiliate totals independent of paginated commission history.';
COMMENT ON FUNCTION public.affiliate_record_payout(uuid, text, text, uuid, numeric, text, text, text) IS
  'Atomically syncs and pays the exact confirmed commission/bank snapshot shown to an authorized approver.';

COMMIT;
