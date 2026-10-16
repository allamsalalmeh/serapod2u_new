-- ============================================================================
-- Tenant-remainder write guards (20261021100000) — fixtures
-- DISPOSABLE DATABASES ONLY (see run.sh). Builds on sa_wave1_readiness/00_harness_and_fixtures.sql
-- (sar_test.try_as / expect_*, HQ A → WH A1, WH A2; HQ B → WH B).
-- Adds HQ A → DIST A → SHOP A, HQ A → MFR A, HQ B → DIST B and one row per guarded table, written by the owner.
-- ============================================================================
\set ON_ERROR_STOP on

INSERT INTO public.organization_types (type_code, type_name, hierarchy_level) VALUES
  ('DIST', 'Distributor', 2), ('MFR', 'Manufacturer', 2), ('SHOP', 'Shop', 3)
ON CONFLICT (type_code) DO NOTHING;

INSERT INTO public.organizations (id, org_code, org_name, org_type_code, parent_org_id, is_active) VALUES
  ('00000000-0000-0000-0000-00000000a011', 'T-DIST-A', 'Test DIST A', 'DIST', '00000000-0000-0000-0000-00000000a001', true),
  ('00000000-0000-0000-0000-00000000a012', 'T-MFR-A',  'Test MFR A',  'MFR',  '00000000-0000-0000-0000-00000000a001', true),
  ('00000000-0000-0000-0000-00000000a013', 'T-DIST-B', 'Test DIST B', 'DIST', '00000000-0000-0000-0000-00000000a006', true);
-- SHOP A under DIST A (its insert fires sync_shop_distributor_link → shop_distributors row, as the owner).
INSERT INTO public.organizations (id, org_code, org_name, org_type_code, parent_org_id, is_active) VALUES
  ('00000000-0000-0000-0000-00000000a014', 'T-SHOP-A', 'Test SHOP A', 'SHOP', '00000000-0000-0000-0000-00000000a011', true);

INSERT INTO auth.users (id, email)
SELECT ('00000000-0000-0000-0000-0000000000' || n)::uuid, 'fixture' || n || '@sar.test' FROM generate_series(10, 16) AS n;
INSERT INTO public.users (id, email, role_code, organization_id, is_active, full_name, account_scope) VALUES
  ('00000000-0000-0000-0000-000000000010', 'fixture10@sar.test', 'USER', '00000000-0000-0000-0000-00000000a014', true, 'Shop A staff (no grant)', 'portal'),
  ('00000000-0000-0000-0000-000000000011', 'fixture11@sar.test', 'USER', '00000000-0000-0000-0000-00000000a011', true, 'Dist A staff (no grant)', 'portal'),
  ('00000000-0000-0000-0000-000000000012', 'fixture12@sar.test', 'USER', '00000000-0000-0000-0000-00000000a012', true, 'MFR A staff (no grant)', 'portal'),
  ('00000000-0000-0000-0000-000000000013', 'fixture13@sar.test', 'USER', '00000000-0000-0000-0000-00000000a012', true, 'MFR A operator (grant at MFR A)', 'portal'),
  ('00000000-0000-0000-0000-000000000014', 'fixture14@sar.test', 'USER', '00000000-0000-0000-0000-00000000a001', true, 'HQ A manager (grant at HQ A)', 'portal'),
  ('00000000-0000-0000-0000-000000000015', 'fixture15@sar.test', 'USER', '00000000-0000-0000-0000-00000000a013', true, 'Dist B manager (grant at DIST B)', 'portal'),
  -- the identity hard-coded in the referral_claims remainder (an admin role makes the claims readable: the SELECT
  -- policy "Admins can view referral claims" is role-based and not S&A-gated); no S&A grant
  ('00000000-0000-0000-0000-000000000016', 'super@dev.com', 'HQ', '00000000-0000-0000-0000-00000000a001', true, 'Hard-coded email', 'portal');

CREATE FUNCTION sar_test.u(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_name
    WHEN 'shop_staff' THEN '00000000-0000-0000-0000-000000000010'
    WHEN 'dist_staff' THEN '00000000-0000-0000-0000-000000000011'
    WHEN 'mfr_staff'  THEN '00000000-0000-0000-0000-000000000012'
    WHEN 'mfr_op'     THEN '00000000-0000-0000-0000-000000000013'
    WHEN 'hq_mgr'     THEN '00000000-0000-0000-0000-000000000014'
    WHEN 'distb_mgr'  THEN '00000000-0000-0000-0000-000000000015'
    WHEN 'super_dev'  THEN '00000000-0000-0000-0000-000000000016'
    ELSE sar_test.uid(p_name)::text
  END::uuid $$;
CREATE FUNCTION sar_test.o(p_name text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_name
    WHEN 'dist_a' THEN '00000000-0000-0000-0000-00000000a011'
    WHEN 'mfr_a'  THEN '00000000-0000-0000-0000-00000000a012'
    WHEN 'dist_b' THEN '00000000-0000-0000-0000-00000000a013'
    WHEN 'shop_a' THEN '00000000-0000-0000-0000-00000000a014'
    ELSE sar_test.org(p_name)::text
  END::uuid $$;

-- Every key under test (registered like on staging; the schema-only dump has no readiness rows).
CREATE TABLE sar_test.keys (k text PRIMARY KEY);
INSERT INTO sar_test.keys VALUES
  ('customer.shop.manage'), ('product.catalog.manage'), ('platform.organization.manage'), ('supply_chain.order.create'),
  ('supply_chain.document.manage'), ('supply_chain.document.acknowledge'), ('manufacturing.scan.reverse'),
  ('manufacturing.production.manage'), ('manufacturing.adjustment.manage'), ('inventory.opening_balance.manage'),
  ('inventory.return.manage');
-- The schema-only dump carries only the Wave 1 catalog seed: add the Final Wave keys used here, in SHADOW.
INSERT INTO public.sa_permissions (permission_key, module, resource, action, audit_sensitivity)
SELECT k, split_part(k, '.', 1), split_part(k, '.', 2), split_part(k, '.', 3), 'ordinary' FROM sar_test.keys
ON CONFLICT (permission_key) DO NOTHING;
INSERT INTO public.sa_migration_modes (permission_key, mode) SELECT k, 'SHADOW' FROM sar_test.keys
ON CONFLICT (permission_key) DO NOTHING;
INSERT INTO public.sa_enforcement_readiness (permission_key, route_wiring, database_backstop, notes)
SELECT k, true, 'rls_gate', 'fixture' FROM sar_test.keys ON CONFLICT DO NOTHING;
UPDATE public.sa_permissions SET audit_sensitivity = 'ordinary' WHERE permission_key IN (SELECT k FROM sar_test.keys);

CREATE FUNCTION sar_test.set_modes(p_mode text) RETURNS void LANGUAGE sql AS $$
  UPDATE public.sa_migration_modes SET mode = p_mode WHERE permission_key IN (SELECT k FROM sar_test.keys) $$;

-- One business role with every key; one manufacturing-only role; one "production only" role.
INSERT INTO public.sa_business_roles (id, role_key, name, source) VALUES
  ('00000000-0000-0000-0000-0000000b0101', 'fx-tenant-all', 'FX all tenant-remainder keys', 'new'),
  ('00000000-0000-0000-0000-0000000b0102', 'fx-mfr-production', 'FX production only', 'new'),
  ('00000000-0000-0000-0000-0000000b0103', 'fx-doc-ack', 'FX document acknowledge only', 'new');
INSERT INTO public.sa_business_role_permissions (role_id, permission_id)
SELECT '00000000-0000-0000-0000-0000000b0101'::uuid, p.id FROM public.sa_permissions p JOIN sar_test.keys k ON k.k = p.permission_key
UNION ALL
SELECT '00000000-0000-0000-0000-0000000b0102'::uuid, id FROM public.sa_permissions WHERE permission_key = 'manufacturing.production.manage'
UNION ALL
SELECT '00000000-0000-0000-0000-0000000b0103'::uuid, id FROM public.sa_permissions WHERE permission_key = 'supply_chain.document.acknowledge';

CREATE FUNCTION sar_test.grant_org(p_user uuid, p_org uuid, p_role uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_m uuid; v_s uuid; v_a uuid := gen_random_uuid();
BEGIN
  -- the lifecycle trigger already created the employee membership for the user's own organization
  SELECT id INTO v_m FROM public.sa_organization_memberships WHERE user_id = p_user AND organization_id = p_org AND status = 'active' LIMIT 1;
  IF v_m IS NULL THEN
    INSERT INTO public.sa_organization_memberships (user_id, organization_id, status) VALUES (p_user, p_org, 'active') RETURNING id INTO v_m;
  END IF;
  SELECT id INTO v_s FROM public.sa_scope_definitions WHERE scope_type = 'organization' AND scope_value = p_org::text LIMIT 1;
  IF v_s IS NULL THEN
    INSERT INTO public.sa_scope_definitions (organization_id, scope_type, scope_value, display_name)
    VALUES (p_org, 'organization', p_org::text, 'org ' || p_org) RETURNING id INTO v_s;
  END IF;
  INSERT INTO public.sa_role_assignments (id, user_id, role_id, membership_id, status) VALUES (v_a, p_user, p_role, v_m, 'active');
  INSERT INTO public.sa_assignment_scopes (assignment_id, scope_id) VALUES (v_a, v_s);
END $$;
SELECT sar_test.grant_org(sar_test.u('hq_mgr'),    sar_test.o('hq_a'),   '00000000-0000-0000-0000-0000000b0101');
SELECT sar_test.grant_org(sar_test.u('mfr_op'),    sar_test.o('mfr_a'),  '00000000-0000-0000-0000-0000000b0102');
SELECT sar_test.grant_org(sar_test.u('distb_mgr'), sar_test.o('dist_b'), '00000000-0000-0000-0000-0000000b0101');
-- Dist A staff may only acknowledge documents addressed to DIST A.
SELECT sar_test.grant_org(sar_test.u('dist_staff'), sar_test.o('dist_a'), '00000000-0000-0000-0000-0000000b0103');

-- Business rows (owner writes; fixture setup is not under test).
INSERT INTO public.distributor_products (id, distributor_id, product_id) VALUES
  ('00000000-0000-0000-0000-0000000f0001', sar_test.o('dist_a'), '00000000-0000-0000-0000-0000000d0001');
INSERT INTO public.product_images (id, product_id, image_url) VALUES
  ('00000000-0000-0000-0000-0000000f0002', '00000000-0000-0000-0000-0000000d0001', 'https://img.test/1.png');
INSERT INTO public.orders (id, order_type, buyer_org_id, seller_org_id, company_id, status, created_by) VALUES
  ('00000000-0000-0000-0000-0000000f0010', 'D2H', sar_test.o('dist_a'), sar_test.o('hq_a'), sar_test.o('hq_a'), 'draft', sar_test.u('hq_mgr'));
INSERT INTO public.order_items (id, order_id, product_id, variant_id, qty, unit_price, company_id) VALUES
  ('00000000-0000-0000-0000-0000000f0011', '00000000-0000-0000-0000-0000000f0010', '00000000-0000-0000-0000-0000000d0001',
   '00000000-0000-0000-0000-0000000e0001', 1, 10, sar_test.o('hq_a'));
INSERT INTO public.documents (id, order_id, doc_type, doc_no, status, issued_by_org_id, issued_to_org_id, company_id, created_by) VALUES
  ('00000000-0000-0000-0000-0000000f0020', '00000000-0000-0000-0000-0000000f0010', 'SO', 'FX-SO-1', 'pending',
   sar_test.o('hq_a'), sar_test.o('dist_a'), sar_test.o('hq_a'), sar_test.u('hq_mgr'));
INSERT INTO public.documents (id, order_id, doc_type, doc_no, status, issued_by_org_id, issued_to_org_id, company_id, created_by) VALUES
  ('00000000-0000-0000-0000-0000000f0022', '00000000-0000-0000-0000-0000000f0010', 'PAYMENT', 'FX-PAY-1', 'pending',
   sar_test.o('hq_a'), sar_test.o('dist_a'), sar_test.o('hq_a'), sar_test.u('hq_mgr'));
INSERT INTO public.document_files (id, document_id, file_url, company_id, uploaded_by) VALUES
  ('00000000-0000-0000-0000-0000000f0021', '00000000-0000-0000-0000-0000000f0020', 'https://f.test/1.pdf', sar_test.o('hq_a'), sar_test.u('hq_mgr'));
INSERT INTO public.qr_batches (id, order_id, company_id) VALUES
  ('00000000-0000-0000-0000-0000000f0030', '00000000-0000-0000-0000-0000000f0010', sar_test.o('hq_a'));
INSERT INTO public.qr_reverse_jobs (id, batch_id, order_id, manufacturer_org_id) VALUES
  ('00000000-0000-0000-0000-0000000f0031', '00000000-0000-0000-0000-0000000f0030', '00000000-0000-0000-0000-0000000f0010', sar_test.o('mfr_a'));
INSERT INTO public.qr_reverse_job_items (id, job_id, spoiled_sequence_no) VALUES
  ('00000000-0000-0000-0000-0000000f0032', '00000000-0000-0000-0000-0000000f0031', 1);
INSERT INTO public.qr_prepared_codes (id, job_id, batch_id, order_id, code) VALUES
  ('00000000-0000-0000-0000-0000000f0033', '00000000-0000-0000-0000-0000000f0031', '00000000-0000-0000-0000-0000000f0030',
   '00000000-0000-0000-0000-0000000f0010', 'FX-CODE-1');
INSERT INTO public.stock_adjustments (id, organization_id, target_manufacturer_org_id, status) VALUES
  ('00000000-0000-0000-0000-0000000f0040', sar_test.o('hq_a'), sar_test.o('mfr_a'), 'pending');
-- A pre-existing classification draft: new ones are refused (stock_count_legacy_initial_read_only), so the row is
-- written with triggers off, as a legacy draft would have been.
SET session_replication_role = replica;
INSERT INTO public.stock_count_sessions (id, warehouse_organization_id, count_type, status, notes, reference_name, created_by) VALUES
  ('00000000-0000-0000-0000-0000000f0050', sar_test.org('wh_a1'), 'initial_configuration_classification', 'draft', 'fx', 'FX-CLS', sar_test.u('hq_mgr'));
SET session_replication_role = origin;
INSERT INTO public.return_cases (id, shop_org_id, return_source_organization_id, status) VALUES
  ('00000000-0000-0000-0000-0000000f0060', sar_test.o('shop_a'), sar_test.o('shop_a'), 'return_draft');

INSERT INTO public.referral_claims (id, org_id, reference_user_id, claim_points, claim_rm, conversion_points, conversion_rm, submitted_by, status) VALUES
  ('00000000-0000-0000-0000-0000000f0070', sar_test.o('hq_a'), sar_test.u('user'), 1, 1, 1, 1, sar_test.u('user'), 'pending');

-- Rows an API statement affected, or 'ERR:<state>:<message>' (RLS-filtered UPDATE/DELETE "succeed" with 0 rows).
CREATE FUNCTION sar_test.n(p_sub uuid, p_sql text) RETURNS text LANGUAGE sql AS $$
  SELECT sar_test.value_as('authenticated', p_sub, 'WITH x AS (' || p_sql || ' RETURNING 1) SELECT count(*)::text FROM x') $$;
CREATE FUNCTION sar_test.expect_n(p_label text, p_sub uuid, p_sql text, p_expected text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v text := sar_test.n(p_sub, p_sql);
BEGIN
  IF v IS DISTINCT FROM p_expected AND NOT (p_expected LIKE 'ERR:%' AND v LIKE p_expected || '%') THEN
    RAISE EXCEPTION 'FAIL [%]: expected %, got %', p_label, p_expected, v;
  END IF;
  RAISE NOTICE 'PASS [%] = %', p_label, left(v, 90);
END $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA sar_test TO PUBLIC;
GRANT SELECT ON ALL TABLES IN SCHEMA sar_test TO PUBLIC;
SELECT sar_test.expect_eq('fixture: SHOP A ↔ DIST A link created by the sync trigger',
  (SELECT count(*)::int FROM public.shop_distributors WHERE shop_id = sar_test.o('shop_a') AND distributor_id = sar_test.o('dist_a')), 1);
