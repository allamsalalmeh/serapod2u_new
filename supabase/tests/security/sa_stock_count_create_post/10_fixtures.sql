-- ============================================================================
-- Stock Count create/post enforcement + Migration Modes note/keep-retired — fixtures
-- DISPOSABLE DATABASES ONLY (see run.sh). Builds on sa_wave1_readiness/00_harness_and_fixtures.sql
-- (sar_test.try_as / expect_*, HQ A → WH A1, WH A2; HQ B → WH B; one counted variant in WH A1).
-- ============================================================================
\set ON_ERROR_STOP on

-- As on staging after the Wave 1 readiness migration: inventory permissions are ordinary-audit.
UPDATE public.sa_permissions SET audit_sensitivity = 'ordinary' WHERE permission_key LIKE 'inventory.%';

-- Staging state of the readiness registry for the keys used here (the dump is schema-only).
INSERT INTO public.sa_enforcement_readiness (permission_key, route_wiring, database_backstop, notes) VALUES
  ('inventory.stock_count.verify', true, 'decision_backstop', 'fixture'),
  ('inventory.stock_count.view', true, 'read_only', 'fixture'),
  ('security.permission.manage', true, 'governance_function', 'fixture')
ON CONFLICT DO NOTHING;

-- Extra people (ids stay inside the harness' fixture range).
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-000000000007', 'fixture7@sar.test'),
  ('00000000-0000-0000-0000-000000000008', 'fixture8@sar.test'),
  ('00000000-0000-0000-0000-000000000009', 'fixture9@sar.test');
INSERT INTO public.users (id, email, role_code, organization_id, is_active, full_name, account_scope) VALUES
  -- warehouse staff of WH A1, legacy key post_stock_count (MANAGER role)
  ('00000000-0000-0000-0000-000000000007', 'fixture7@sar.test', 'MANAGER', '00000000-0000-0000-0000-00000000a002', true, 'WH A1 staff', 'portal'),
  -- HQ A member whose S&A grant is scoped to warehouse WH A1 only
  ('00000000-0000-0000-0000-000000000008', 'fixture8@sar.test', 'USER', '00000000-0000-0000-0000-00000000a001', true, 'WH A1 scoped (HQ member)', 'portal'),
  -- HQ A user WITHOUT the legacy posting key, but with an S&A posting grant
  ('00000000-0000-0000-0000-000000000009', 'fixture9@sar.test', 'USER', '00000000-0000-0000-0000-00000000a001', true, 'S&A-only poster', 'portal');

CREATE OR REPLACE FUNCTION sar_test.uid2(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_name
    WHEN 'wh_staff'  THEN '00000000-0000-0000-0000-000000000007'
    WHEN 'wh_scoped' THEN '00000000-0000-0000-0000-000000000008'
    WHEN 'sa_only'   THEN '00000000-0000-0000-0000-000000000009'
    ELSE sar_test.uid(p_name)::text
  END::uuid $$;

-- Business roles: drafting (create), posting (create+verify+post).
INSERT INTO public.sa_business_roles (id, role_key, name, source) VALUES
  ('00000000-0000-0000-0000-0000000b0001', 'fx-stock-count-drafter', 'FX Stock Count Drafter', 'new'),
  ('00000000-0000-0000-0000-0000000b0002', 'fx-stock-count-poster', 'FX Stock Count Poster', 'new');
INSERT INTO public.sa_business_role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-0000000b0001'::uuid, id FROM public.sa_permissions WHERE permission_key IN ('inventory.stock_count.view', 'inventory.stock_count.create')
UNION ALL
SELECT '00000000-0000-0000-0000-0000000b0002'::uuid, id FROM public.sa_permissions WHERE permission_key IN ('inventory.stock_count.view', 'inventory.stock_count.create', 'inventory.stock_count.verify', 'inventory.stock_count.post');

-- Grants a role with one scope; creates the membership when missing.
CREATE FUNCTION sar_test.grant_role(p_user uuid, p_member_org uuid, p_role uuid, p_scope_type text, p_scope_value uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_m uuid; v_s uuid; v_a uuid := gen_random_uuid();
BEGIN
  SELECT id INTO v_m FROM public.sa_organization_memberships WHERE user_id = p_user AND organization_id = p_member_org AND status = 'active' LIMIT 1;
  IF v_m IS NULL THEN
    INSERT INTO public.sa_organization_memberships (user_id, organization_id, status) VALUES (p_user, p_member_org, 'active') RETURNING id INTO v_m;
  END IF;
  SELECT id INTO v_s FROM public.sa_scope_definitions WHERE scope_type = p_scope_type AND scope_value = p_scope_value::text LIMIT 1;
  IF v_s IS NULL THEN
    INSERT INTO public.sa_scope_definitions (organization_id, scope_type, scope_value, display_name)
    VALUES (p_member_org, p_scope_type, p_scope_value::text, p_scope_type || ' ' || p_scope_value) RETURNING id INTO v_s;
  END IF;
  INSERT INTO public.sa_role_assignments (id, user_id, role_id, membership_id, status) VALUES (v_a, p_user, p_role, v_m, 'active');
  INSERT INTO public.sa_assignment_scopes (assignment_id, scope_id) VALUES (v_a, v_s);
END $$;

-- manager (HQ A, legacy poster): poster for the whole HQ A organization (both warehouses).
SELECT sar_test.grant_role(sar_test.uid('manager'), sar_test.org('hq_a'), '00000000-0000-0000-0000-0000000b0002', 'organization', sar_test.org('hq_a'));
-- WH A1 staff: poster scoped to WH A1, member of WH A1.
SELECT sar_test.grant_role(sar_test.uid2('wh_staff'), sar_test.org('wh_a1'), '00000000-0000-0000-0000-0000000b0002', 'warehouse', sar_test.org('wh_a1'));
-- HQ A member scoped to warehouse WH A1 only (membership covers both warehouses; the scope does not).
SELECT sar_test.grant_role(sar_test.uid2('wh_scoped'), sar_test.org('hq_a'), '00000000-0000-0000-0000-0000000b0002', 'warehouse', sar_test.org('wh_a1'));
-- S&A-only poster: HQ A organization, no legacy key.
SELECT sar_test.grant_role(sar_test.uid2('sa_only'), sar_test.org('hq_a'), '00000000-0000-0000-0000-0000000b0002', 'organization', sar_test.org('hq_a'));
-- user (HQ A, legacy view only): drafter only, no posting.
SELECT sar_test.grant_role(sar_test.uid('user'), sar_test.org('hq_a'), '00000000-0000-0000-0000-0000000b0001', 'organization', sar_test.org('hq_a'));
-- hq_b: poster in ANOTHER tenant (HQ B).
SELECT sar_test.grant_role(sar_test.uid('hq_b'), sar_test.org('hq_b'), '00000000-0000-0000-0000-0000000b0002', 'organization', sar_test.org('hq_b'));
-- hq_a (legacy HQ admin with post_stock_count): NO stock count grant in S&A.

CREATE FUNCTION sar_test.set_mode(p_key text, p_mode text) RETURNS void LANGUAGE sql AS $$
  UPDATE public.sa_migration_modes SET mode = p_mode WHERE permission_key = p_key $$;

-- New draft in a warehouse, written as the database owner (fixture setup, not under test).
CREATE FUNCTION sar_test.owner_draft(p_wh text DEFAULT 'wh_a1') RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.stock_count_sessions (id, warehouse_organization_id, count_type, status, notes, reference_name, created_by)
  VALUES (v_id, sar_test.org(p_wh), 'full_count', 'draft', 'fixture', 'FX-' || left(v_id::text, 8), sar_test.uid('sa'));
  RETURN v_id;
END $$;

-- SQL an API client sends to create a draft (fixed id so the test can follow it).
CREATE FUNCTION sar_test.insert_draft_sql(p_id uuid, p_wh text) RETURNS text LANGUAGE sql AS $$
  SELECT format($f$INSERT INTO public.stock_count_sessions (id, warehouse_organization_id, count_type, status, notes, reference_name)
                  VALUES (%L, %L, 'full_count', 'draft', 'api draft', %L)$f$, p_id, sar_test.org(p_wh), 'API-' || left(p_id::text, 8)) $$;
CREATE FUNCTION sar_test.insert_item_sql(p_session uuid) RETURNS text LANGUAGE sql AS $$
  SELECT format($f$INSERT INTO public.stock_count_session_items (session_id, variant_id, stock_config_id, system_quantity, physical_quantity, adjustment_quantity, unit_cost)
                  VALUES (%L, '00000000-0000-0000-0000-0000000e0001', %L, 10, 9, -1, 10)$f$, p_session, sar_test.config_id()) $$;
CREATE FUNCTION sar_test.insert_scope_sql(p_session uuid) RETURNS text LANGUAGE sql AS $$
  SELECT format($f$INSERT INTO public.stock_count_session_scope (session_id, stock_config_id) VALUES (%L, %L)$f$, p_session, sar_test.config_id()) $$;
CREATE FUNCTION sar_test.discard_sql(p_session uuid) RETURNS text LANGUAGE sql AS $$
  SELECT format($f$SELECT public.discard_stock_count_drafts(ARRAY[%L]::uuid[])$f$, p_session) $$;
-- Discard result for one draft as the actor: 'discarded' | 'failed:<error>' | 'ERR:...'
CREATE FUNCTION sar_test.discard_as(p_sub uuid, p_session uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  v := sar_test.value_as('authenticated', p_sub, format($f$SELECT public.discard_stock_count_drafts(ARRAY[%L]::uuid[])::text$f$, p_session));
  IF v LIKE 'ERR:%' THEN RETURN v; END IF;
  IF (v::jsonb->'discarded_ids') ? p_session::text THEN RETURN 'discarded'; END IF;
  RETURN 'failed:' || coalesce(v::jsonb->'failed'->0->>'error', v);
END $$;

-- A complete user-path posting run (prepare → deliver → verify-and-post) for the actor; returns the footprint.
CREATE FUNCTION sar_test.prepare_sql(p_session uuid, p_org text DEFAULT 'hq_a') RETURNS text LANGUAGE sql AS $$
  SELECT format($f$SELECT public.prepare_stock_count_verification(%L::uuid, %L::uuid, %L, '[]'::jsonb, '{}'::jsonb)$f$,
    p_session, sar_test.org(p_org), repeat('a', 64)) $$;
CREATE FUNCTION sar_test.request_of(p_session uuid) RETURNS uuid LANGUAGE sql AS $$
  SELECT id FROM public.stock_count_verification_requests WHERE session_id = p_session ORDER BY requested_at DESC LIMIT 1 $$;
CREATE FUNCTION sar_test.finalize_sql(p_session uuid) RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT public.finalize_stock_count_verification_delivery(%L::uuid, true)', sar_test.request_of(p_session)) $$;
CREATE FUNCTION sar_test.post_sql(p_session uuid) RETURNS text LANGUAGE sql AS $$
  SELECT format('SELECT public.verify_and_post_stock_count(%L::uuid, %L)', sar_test.request_of(p_session), repeat('a', 64)) $$;

-- Session in WH A2 with a counted item (a second warehouse for boundary tests).
INSERT INTO public.product_inventory (variant_id, organization_id, stock_config_id, quantity_on_hand, quantity_allocated, is_active)
VALUES ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-00000000a003', sar_test.config_id(), 10, 0, true);
CREATE FUNCTION sar_test.new_session_in(p_wh text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_on_hand integer := (SELECT quantity_on_hand FROM public.product_inventory WHERE organization_id = sar_test.org(p_wh) AND stock_config_id = sar_test.config_id());
BEGIN
  INSERT INTO public.stock_count_sessions (id, warehouse_organization_id, count_type, status, notes, reference_name, created_by)
  VALUES (v_id, sar_test.org(p_wh), 'full_count', 'draft', 'FX variance', 'FX-' || left(v_id::text, 8), sar_test.uid('sa'));
  INSERT INTO public.stock_count_session_items (session_id, variant_id, stock_config_id, system_quantity, physical_quantity, adjustment_quantity, unit_cost)
  VALUES (v_id, '00000000-0000-0000-0000-0000000e0001', sar_test.config_id(), v_on_hand, v_on_hand - 1, -1, 10);
  RETURN v_id;
END $$;
CREATE FUNCTION sar_test.fp(p_session uuid) RETURNS text LANGUAGE sql AS $$
  SELECT concat_ws('|',
    (SELECT status FROM public.stock_count_sessions WHERE id = p_session),
    (SELECT count(*) FROM public.stock_count_verification_requests WHERE session_id = p_session),
    (SELECT count(*) FROM public.stock_movements WHERE reference_id = p_session)) $$;

-- Records what the server helper writes for inventory.stock_count.verify (needed while verify is enforced).
CREATE FUNCTION sar_test.verify_allow(p_actor uuid, p_session uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.sa_authorization_decisions (id, occurred_at, actor_id, permission_key, resource_type, resource_id, decision, reason_code,
    migration_mode, legacy_decision, new_decision, comparison, audit_class, policy_version)
  VALUES (gen_random_uuid(), now(), p_actor, 'inventory.stock_count.verify', 'stock_count', p_session::text, 'ALLOW', 'ALLOWED_BY_ASSIGNMENT',
    (SELECT mode FROM public.sa_migration_modes WHERE permission_key = 'inventory.stock_count.verify'), 'ALLOW', 'ALLOW', 'MATCH_ALLOW', 'ENFORCED_DECISION', 'sa-final-v1') $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA sar_test TO PUBLIC;
SELECT 'stock count create/post fixtures ready' AS status;
