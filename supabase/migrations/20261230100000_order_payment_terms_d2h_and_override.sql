-- ============================================================================
-- Payment terms follow the master data for H2M and D2H, and HQ Admin can
-- override them per order from Order Documents (with a reason, logged).
--
-- Master data is READ ONLY here: public.payment_terms and organizations are
-- not changed. Existing orders are not changed.
--
-- 1. order_default_payment_terms(order_type, buyer, seller): the term copied
--    into a new order. H2M -> manufacturer (seller) term; D2H -> distributor
--    (buyer) term; S2D -> seller term (unchanged). No term on the partner ->
--    the default active term in payment_terms -> 50/50 as before.
-- 2. save_order_with_items: always uses (1) on create and ignores
--    p_payment_term_id (the create page now shows the term read only);
--    an update no longer changes the term. Changes go through (4).
-- 3. submit_and_allocate_d2h_order: stores (1) on the new D2H order
--    (it used to keep the column default 50/50).
-- 4. order_change_payment_term(order, term, reason): HQ Admin of the order's
--    company only (can_change_order_payment_terms - one place to extend to
--    Finance later), reason required, locked once the PO is acknowledged or
--    any invoice / payment document exists, or the order is closed/cancelled.
--    Every change is kept in order_payment_term_changes.
-- 5. order_payment_term_change_status(order): what the Order Documents card
--    needs to show or hide the Change button (same rules as 4).
--
-- Rollback: re-run 20261229100000 (save_order_with_items), restore
-- submit_and_allocate_d2h_order from payterm_defs.txt, drop the functions
-- and table created here.
-- ============================================================================

BEGIN;

-- 1 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.order_default_payment_terms(
  p_order_type public.order_type, p_buyer_org_id uuid, p_seller_org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid := CASE WHEN p_order_type = 'D2H' THEN p_buyer_org_id ELSE p_seller_org_id END;
  v_terms   jsonb;
BEGIN
  SELECT public.order_payment_terms_snapshot(o.payment_term_id, false)
    INTO v_terms
    FROM public.organizations o
   WHERE o.id = v_partner AND o.payment_term_id IS NOT NULL;
  IF v_terms IS NOT NULL THEN
    RETURN v_terms || jsonb_build_object('source', 'partner');
  END IF;

  SELECT public.order_payment_terms_snapshot(pt.id, true)
    INTO v_terms
    FROM public.payment_terms pt
   WHERE COALESCE(pt.is_default, false) AND COALESCE(pt.is_active, false)
   ORDER BY pt.sort_order NULLS LAST
   LIMIT 1;
  IF v_terms IS NOT NULL THEN
    RETURN v_terms || jsonb_build_object('source', 'default');
  END IF;

  RETURN jsonb_build_object('deposit_pct', 0.5, 'balance_pct', 0.5,
                            'balance_trigger', 'on_first_receive', 'source', 'default');
END;
$function$;

REVOKE ALL ON FUNCTION public.order_default_payment_terms(public.order_type, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.order_default_payment_terms(public.order_type, uuid, uuid) TO authenticated, service_role;

-- 2 + 3: patch the live definitions in place --------------------------------
DO $patch$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  -- save_order_with_items (15 args, from 20261229100000)
  SELECT replace(pg_get_functiondef(p.oid), E'\r', '') INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'save_order_with_items' AND p.pronargs = 15;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'save_order_with_items(15 args) not found - apply 20261229100000 first';
  END IF;

  IF position('order_default_payment_terms' IN v_def) = 0 THEN
    v_old := $o$    v_payment_terms := jsonb_build_object('deposit_pct', 0.5, 'balance_pct', 0.5,
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
    END IF;$o$;
    v_new := $n$    -- Payment term from the master data (H2M: manufacturer, D2H: distributor).
    -- p_payment_term_id is ignored; overrides go through order_change_payment_term.
    v_payment_terms := public.order_default_payment_terms(v_order_type, v_actor_org, p_seller_org_id);$n$;
    IF position(v_old IN v_def) = 0 THEN
      RAISE EXCEPTION 'save_order_with_items: create anchor not found';
    END IF;
    v_def := replace(v_def, v_old, v_new);

    v_old := $o$    IF v_order.order_type = 'H2M' AND p_payment_term_id IS NOT NULL THEN
      v_term_terms := public.order_payment_terms_snapshot(p_payment_term_id, true);
      IF v_term_terms IS NULL THEN
        RAISE EXCEPTION 'invalid_payment_term' USING ERRCODE = '22023';
      END IF;
      UPDATE public.orders SET payment_terms = v_term_terms WHERE id = p_order_id;
    END IF;$o$;
    v_new := $n$    -- The payment term is not changed by an order edit (see order_change_payment_term).$n$;
    IF position(v_old IN v_def) = 0 THEN
      RAISE EXCEPTION 'save_order_with_items: update anchor not found';
    END IF;
    v_def := replace(v_def, v_old, v_new);
    EXECUTE v_def;
  END IF;

  -- submit_and_allocate_d2h_order
  SELECT replace(pg_get_functiondef(p.oid), E'\r', '') INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'submit_and_allocate_d2h_order';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'submit_and_allocate_d2h_order not found';
  END IF;

  IF position('order_default_payment_terms' IN v_def) = 0 THEN
    v_old := $o$    has_redeem, notes, created_by, order_date
  ) VALUES (
    'D2H', p_company_id, p_buyer_org_id, p_seller_org_id,
    p_fulfillment_warehouse_id, 'draft', false, true, true,
    true, p_notes, v_actor, v_order_date
  )$o$;
    v_new := $n$    has_redeem, notes, created_by, order_date, payment_terms
  ) VALUES (
    'D2H', p_company_id, p_buyer_org_id, p_seller_org_id,
    p_fulfillment_warehouse_id, 'draft', false, true, true,
    true, p_notes, v_actor, v_order_date,
    public.order_default_payment_terms('D2H', p_buyer_org_id, p_seller_org_id)
  )$n$;
    IF position(v_old IN v_def) = 0 THEN
      RAISE EXCEPTION 'submit_and_allocate_d2h_order: insert anchor not found';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END IF;
END
$patch$;

-- 4 + 5 ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.order_payment_term_changes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  company_id      uuid,
  old_terms       jsonb,
  new_terms       jsonb NOT NULL,
  reason          text NOT NULL,
  changed_by      uuid,
  changed_by_name text,
  changed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_payment_term_changes_order_idx
  ON public.order_payment_term_changes (order_id, changed_at DESC);

ALTER TABLE public.order_payment_term_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_payment_term_changes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.order_payment_term_changes TO authenticated;
GRANT ALL ON public.order_payment_term_changes TO service_role;
DROP POLICY IF EXISTS order_payment_term_changes_select ON public.order_payment_term_changes;
-- Visible to whoever can see the order (orders RLS applies inside the subquery).
CREATE POLICY order_payment_term_changes_select ON public.order_payment_term_changes
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id));

-- Who may override. Today: HQ Admin of the same company. To add Finance later,
-- change only this function.
CREATE OR REPLACE FUNCTION public.can_change_order_payment_terms(p_company_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT auth.uid() IS NOT NULL
     AND COALESCE(public.is_hq_admin(), false)
     AND p_company_id IS NOT DISTINCT FROM public.get_user_company_id()
$function$;

-- Why the term can no longer change (NULL = still open).
CREATE OR REPLACE FUNCTION public.order_payment_terms_lock_reason(p_order_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN o.status::text IN ('closed', 'cancelled') THEN 'order_' || o.status::text
    WHEN EXISTS (SELECT 1 FROM public.documents d
                  WHERE d.order_id = o.id AND d.doc_type = 'PO' AND d.status <> 'pending')
      THEN 'po_acknowledged'
    WHEN EXISTS (SELECT 1 FROM public.documents d
                  WHERE d.order_id = o.id
                    AND d.doc_type IN ('INVOICE', 'PAYMENT', 'PAYMENT_REQUEST', 'RECEIPT'))
      THEN 'invoice_issued'
    ELSE NULL
  END
  FROM public.orders o
  WHERE o.id = p_order_id
$function$;

CREATE OR REPLACE FUNCTION public.order_payment_term_change_status(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_company uuid;
  v_lock    text;
  v_may     boolean;
BEGIN
  SELECT o.company_id INTO v_company FROM public.orders o WHERE o.id = p_order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('allowed', false, 'can_manage', false, 'reason', 'order_not_found');
  END IF;
  v_may  := public.can_change_order_payment_terms(v_company);
  v_lock := public.order_payment_terms_lock_reason(p_order_id);
  RETURN jsonb_build_object(
    'allowed',    v_may AND v_lock IS NULL,
    'can_manage', v_may,
    'reason',     CASE WHEN NOT v_may THEN 'not_authorized' ELSE v_lock END);
END;
$function$;

CREATE OR REPLACE FUNCTION public.order_change_payment_term(p_order_id uuid, p_term_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor  uuid := auth.uid();
  v_order  public.orders%ROWTYPE;
  v_lock   text;
  v_terms  jsonb;
  v_name   text;
  v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;
  IF length(v_reason) < 5 THEN
    RAISE EXCEPTION 'reason_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'order_not_found' USING ERRCODE = '22023';
  END IF;
  IF NOT public.can_change_order_payment_terms(v_order.company_id) THEN
    RAISE EXCEPTION 'not_authorized_to_change_payment_terms' USING ERRCODE = '42501';
  END IF;
  v_lock := public.order_payment_terms_lock_reason(p_order_id);
  IF v_lock IS NOT NULL THEN
    RAISE EXCEPTION 'payment_terms_locked' USING ERRCODE = '55000', DETAIL = v_lock;
  END IF;

  v_terms := public.order_payment_terms_snapshot(p_term_id, true);
  IF v_terms IS NULL THEN
    RAISE EXCEPTION 'invalid_payment_term' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(NULLIF(btrim(u.full_name), ''), u.email) INTO v_name
    FROM public.users u WHERE u.id = v_actor;

  v_terms := v_terms || jsonb_build_object(
    'source',          'override',
    'changed_by',      v_actor,
    'changed_by_name', v_name,
    'changed_at',      now(),
    'change_reason',   v_reason);

  UPDATE public.orders
     SET payment_terms = v_terms, updated_by = v_actor, updated_at = now()
   WHERE id = p_order_id;

  INSERT INTO public.order_payment_term_changes
    (order_id, company_id, old_terms, new_terms, reason, changed_by, changed_by_name)
  VALUES
    (p_order_id, v_order.company_id, v_order.payment_terms, v_terms, v_reason, v_actor, v_name);

  RETURN v_terms;
END;
$function$;

REVOKE ALL ON FUNCTION public.can_change_order_payment_terms(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.order_payment_terms_lock_reason(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.order_payment_term_change_status(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.order_change_payment_term(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_change_order_payment_terms(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.order_payment_terms_lock_reason(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.order_payment_term_change_status(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.order_change_payment_term(uuid, uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
