-- =============================================================================
-- PROPOSAL ONLY — NOT A MIGRATION. NOT APPLIED ANYWHERE. REVIEW BEFORE USE.
-- Kept outside supabase/migrations so no migration runner picks it up.
-- =============================================================================
--
-- Problem (verified 2026-10-16 against a read-only staging schema dump):
--   POST /api/admin/adjustments/[id]/assign  calls assign_adjustment_to_manufacturer(p_adjustment_id, p_manufacturer_org_id)
--   POST /api/admin/adjustments/[id]/status  calls admin_update_adjustment_status(p_adjustment_id, p_status, p_notes)
--   Neither function exists on staging or in any migration, so both endpoints always return 500.
--   Caller: src/components/manufacturer/QualityIssuesView.tsx (status). No UI caller found for assign.
--
-- Contracts this proposal follows (all existing, verified):
--   * stock_adjustments.manufacturer_status CHECK: draft | pending | pending_manufacturer | acknowledged | resolved | rejected
--   * POST /api/manufacturer/adjustments/[id]/send: draft -> pending_manufacturer, sets manufacturer_assigned_at,
--     audit row in stock_adjustment_manufacturer_actions (action_type 'sent_to_manufacturer')
--   * manufacturer_acknowledge_adjustment(): sa_require_operation guard, FOR UPDATE lock, status precondition,
--     audit row, SECURITY DEFINER, search_path pinned, EXECUTE for authenticated
--   * S&A: manufacturing.adjustment.administer is cross-manufacturer administration and deliberately HQ-side
--     (see 20261012100000_sa_manufacturing_full_access_manufacturer.sql). Both routes already require it.
--   * Manufacturer organizations: organizations.org_type_code = 'MFG'
--
-- OPEN QUESTIONS (need an owner decision before this becomes a migration):
--   Q1. Resolve/reject: should it set stock_adjustments.status as well as manufacturer_status?
--       quality-issues.ts treats status = 'resolved' as resolved, but stock_adjustments.status defaults to 'completed'
--       (the adjustment's inventory posting state). This proposal changes manufacturer_status ONLY, so inventory
--       semantics are untouched. If status must change too, confirm it has no inventory/posting meaning first.
--   Q2. From which states may an administrator resolve/reject? Proposed: pending_manufacturer or acknowledged.
--   Q3. May assign re-target an adjustment already sent (pending_manufacturer)? Proposed: draft or pending only,
--       mirroring /send; re-targeting a sent issue would notify nobody.
--   Q4. Should assign also notify the manufacturer (the /send route sends WhatsApp)? Proposed: no — assignment only;
--       notification stays in /send (and messaging is on hold).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.assign_adjustment_to_manufacturer(p_adjustment_id uuid, p_manufacturer_org_id uuid)
RETURNS public.stock_adjustments
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  v_now timestamptz := now();
  v_adj public.stock_adjustments%ROWTYPE;
BEGIN
  /* sa-guard:manufacturing.adjustment.administer */
  PERFORM public.sa_require_operation('manufacturing.adjustment.administer',
    jsonb_build_object('organization_id', public.sa_actor_org_id()), 'manufacturer_adjustment', p_adjustment_id::text);

  IF p_manufacturer_org_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE o.id = p_manufacturer_org_id AND o.org_type_code = 'MFG' AND COALESCE(o.is_active, true)
  ) THEN
    RAISE EXCEPTION 'Target organization is not an active manufacturer';
  END IF;

  SELECT * INTO v_adj FROM public.stock_adjustments WHERE id = p_adjustment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Adjustment not found: %', p_adjustment_id; END IF;

  -- Q3: only before the issue has been sent.
  IF v_adj.manufacturer_status NOT IN ('draft', 'pending') THEN
    RAISE EXCEPTION 'Only draft or pending adjustments can be assigned (current: %)', v_adj.manufacturer_status;
  END IF;

  UPDATE public.stock_adjustments
     SET target_manufacturer_org_id = p_manufacturer_org_id
   WHERE id = p_adjustment_id
  RETURNING * INTO v_adj;

  INSERT INTO public.stock_adjustment_manufacturer_actions (adjustment_id, manufacturer_org_id, action_type, notes, created_by, created_at)
  VALUES (p_adjustment_id, p_manufacturer_org_id, 'assigned_by_admin', NULL, auth.uid(), v_now);

  RETURN v_adj;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_adjustment_status(p_adjustment_id uuid, p_status text, p_notes text DEFAULT NULL)
RETURNS public.stock_adjustments
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  v_now timestamptz := now();
  v_adj public.stock_adjustments%ROWTYPE;
BEGIN
  /* sa-guard:manufacturing.adjustment.administer */
  PERFORM public.sa_require_operation('manufacturing.adjustment.administer',
    jsonb_build_object('organization_id', public.sa_actor_org_id()), 'manufacturer_adjustment', p_adjustment_id::text);

  IF p_status NOT IN ('resolved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid status: %', p_status;
  END IF;

  SELECT * INTO v_adj FROM public.stock_adjustments WHERE id = p_adjustment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Adjustment not found: %', p_adjustment_id; END IF;

  -- Q2: only once the manufacturer has the issue.
  IF v_adj.manufacturer_status NOT IN ('pending_manufacturer', 'acknowledged') THEN
    RAISE EXCEPTION 'Adjustment is not with the manufacturer (current: %)', v_adj.manufacturer_status;
  END IF;

  -- Q1: manufacturer_status only; stock_adjustments.status (posting state) is untouched.
  UPDATE public.stock_adjustments
     SET manufacturer_status = p_status,
         manufacturer_notes = COALESCE(p_notes, manufacturer_notes)
   WHERE id = p_adjustment_id
  RETURNING * INTO v_adj;

  INSERT INTO public.stock_adjustment_manufacturer_actions (adjustment_id, manufacturer_org_id, action_type, notes, created_by, created_at)
  VALUES (p_adjustment_id, v_adj.target_manufacturer_org_id, 'admin_' || p_status, p_notes, auth.uid(), v_now);

  RETURN v_adj;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_adjustment_to_manufacturer(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_update_adjustment_status(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_adjustment_to_manufacturer(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_adjustment_status(uuid, text, text) TO authenticated, service_role;

-- Validation plan before turning this into a migration (per the local PG17 replica recipe):
--   1. Restore a read-only staging schema dump into a throwaway PG17; apply this file there only.
--   2. Assert: non-administrator -> sa_require_operation denies; non-MFG target -> error; wrong state -> error;
--      happy paths update only manufacturer columns and write one audit row; stock_adjustments.status unchanged.
--   3. Confirm stock_adjustment_manufacturer_actions has no CHECK on action_type that rejects the new values.
