-- ============================================================================
-- Actor-org gates (20261022100000) — fixtures
-- DISPOSABLE DATABASES ONLY (see run.sh). Builds on sa_wave1_readiness/00 and sa_tenant_remainder/10 (HQ A → DIST A
-- → SHOP A, HQ A → MFR A, HQ B → DIST B; sar_test.u / o / set_modes / expect_n; hq_mgr granted at HQ A,
-- distb_mgr granted at DIST B).
-- ============================================================================
\set ON_ERROR_STOP on

INSERT INTO sar_test.keys VALUES ('customer.support.manage'), ('roadtour.campaign.manage'), ('platform.settings.manage'), ('customer.reward.manage')
ON CONFLICT DO NOTHING;
INSERT INTO public.sa_permissions (permission_key, module, resource, action, audit_sensitivity)
SELECT k, split_part(k, '.', 1), split_part(k, '.', 2), split_part(k, '.', 3), 'ordinary' FROM sar_test.keys
ON CONFLICT (permission_key) DO NOTHING;
INSERT INTO public.sa_migration_modes (permission_key, mode) SELECT k, 'SHADOW' FROM sar_test.keys ON CONFLICT (permission_key) DO NOTHING;
INSERT INTO public.sa_enforcement_readiness (permission_key, route_wiring, database_backstop, notes)
SELECT k, true, 'rls_gate', 'fixture' FROM sar_test.keys ON CONFLICT DO NOTHING;
UPDATE public.sa_permissions SET audit_sensitivity = 'ordinary' WHERE permission_key IN (SELECT k FROM sar_test.keys);

CREATE OR REPLACE FUNCTION sar_test.u(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_name
    WHEN 'shop_staff' THEN '00000000-0000-0000-0000-000000000010'
    WHEN 'dist_staff' THEN '00000000-0000-0000-0000-000000000011'
    WHEN 'mfr_staff'  THEN '00000000-0000-0000-0000-000000000012'
    WHEN 'mfr_op'     THEN '00000000-0000-0000-0000-000000000013'
    WHEN 'hq_mgr'     THEN '00000000-0000-0000-0000-000000000014'
    WHEN 'distb_mgr'  THEN '00000000-0000-0000-0000-000000000015'
    WHEN 'super_dev'  THEN '00000000-0000-0000-0000-000000000016'
    WHEN 'shop_mgr2'  THEN '00000000-0000-0000-0000-000000000017'
    ELSE sar_test.uid(p_name)::text
  END::uuid $$;

-- A partner account: shop staff granted the "company" policy at its OWN shop (scope-eligibility allows this).
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-000000000017', 'fixture17@sar.test');
INSERT INTO public.users (id, email, role_code, organization_id, is_active, full_name, account_scope) VALUES
  ('00000000-0000-0000-0000-000000000017', 'fixture17@sar.test', 'USER', '00000000-0000-0000-0000-00000000a014', true, 'Shop A manager (grant at SHOP A)', 'portal');

INSERT INTO public.sa_business_roles (id, role_key, name, source) VALUES
  ('00000000-0000-0000-0000-0000000b0201', 'fx-company-config', 'FX support / roadtour / settings / rewards', 'new');
INSERT INTO public.sa_business_role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-0000000b0201'::uuid, id FROM public.sa_permissions
WHERE permission_key IN ('customer.support.manage', 'roadtour.campaign.manage', 'platform.settings.manage', 'customer.reward.manage');
SELECT sar_test.grant_org(sar_test.u('hq_mgr'),    sar_test.o('hq_a'),   '00000000-0000-0000-0000-0000000b0201');
SELECT sar_test.grant_org(sar_test.u('distb_mgr'), sar_test.o('dist_b'), '00000000-0000-0000-0000-0000000b0201');
SELECT sar_test.grant_org('00000000-0000-0000-0000-000000000017', sar_test.o('shop_a'), '00000000-0000-0000-0000-0000000b0201');

-- HQ A's configuration rows (owner writes).
INSERT INTO public.tenant_features (id, tenant_id, feature_key) VALUES ('00000000-0000-0000-0000-0000000f0102', sar_test.o('hq_a'), 'fx_feature');
INSERT INTO public.roadtour_runs (id, org_id, name, start_date, end_date) VALUES
  ('00000000-0000-0000-0000-0000000f0103', sar_test.o('hq_a'), 'FX run', current_date, current_date + 30);
INSERT INTO public.roadtour_campaigns (id, org_id, name, start_date, end_date, roadtour_run_id) VALUES
  ('00000000-0000-0000-0000-0000000f0104', sar_test.o('hq_a'), 'FX campaign', current_date, current_date + 30, '00000000-0000-0000-0000-0000000f0103');

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA sar_test TO PUBLIC;
GRANT SELECT ON ALL TABLES IN SCHEMA sar_test TO PUBLIC;

-- Statements under test (as functions so the negative control and the suite send identical SQL).
-- (whatsapp_bot_* are not used: their policies call is_org_admin_or_super(), which reads users.is_super_admin — a
--  column that does not exist on staging, so every evaluation errors 42703.)
CREATE FUNCTION sar_test.sql_bonus_insert(p_org text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $f$SELECT format($q$INSERT INTO public.user_registration_bonus_settings (org_id) VALUES (%L)$q$, sar_test.o(p_org))$f$;
CREATE FUNCTION sar_test.sql_feature_insert(p_org text, p_key text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $f$SELECT format($q$INSERT INTO public.tenant_features (tenant_id, feature_key) VALUES (%L, %L)$q$, sar_test.o(p_org), p_key)$f$;
CREATE FUNCTION sar_test.sql_qr_insert(p_token text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $f$SELECT format($q$INSERT INTO public.roadtour_qr_codes (campaign_id, account_manager_user_id, token) VALUES ('00000000-0000-0000-0000-0000000f0104', '00000000-0000-0000-0000-000000000014', %L)$q$, p_token)$f$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA sar_test TO PUBLIC;
