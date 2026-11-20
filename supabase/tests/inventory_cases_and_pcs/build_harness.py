#!/usr/bin/env python3
"""Build the isolated integration harness for the cases+pcs migration.

The harness is the REAL table DDL for the inventory tables, extracted verbatim
from supabase/schemas/current_schema.sql (a dump of the live schema), plus the
smallest deterministic stand-ins for the auth/authorization helpers the
migration calls. It is only ever loaded into a throwaway local database by
run.sh -- never into staging or production.

    python3 build_harness.py --dump <current_schema.sql> --out /tmp/harness.sql
"""
import argparse

TABLES = [
    'products',
    'product_variants',
    'inventory_stock_configurations',
    'product_inventory',
    'stock_movements',
    'stock_count_sessions',
    'stock_count_session_items',
    'stock_count_classification_allocation_resolutions',
    'stock_count_session_scope',
    'stock_count_verification_requests',
    'stock_adjustments',
    'stock_adjustment_items',
    'stock_transfers',
]

HEADER = """
-- Isolated local harness: real table DDL from supabase/schemas/current_schema.sql
-- plus the smallest stubs for the auth/authorization helpers the migration calls.
-- Never applied to staging or production.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

-- Supabase roles referenced by grants in the migration.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE TABLE auth.session (uid uuid, role text);
INSERT INTO auth.session VALUES (NULL, 'service_role');

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT uid FROM auth.session LIMIT 1
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT role FROM auth.session LIMIT 1
$$;

-- Minimum master data the stock arithmetic needs.
CREATE TABLE public.roles (role_code text PRIMARY KEY, role_level integer);
CREATE TABLE public.departments (id uuid PRIMARY KEY, permission_overrides jsonb);
CREATE TABLE public.stock_adjustment_reasons (
  id uuid PRIMARY KEY, created_at timestamptz, reason_name text, is_active boolean DEFAULT true
);
CREATE TABLE public.organizations (
  id uuid PRIMARY KEY, org_name text, org_code text, org_type_code text, is_active boolean DEFAULT true
);
CREATE TABLE public.users (
  id uuid PRIMARY KEY, email text, role_code text, department_id uuid, is_active boolean DEFAULT true
);
"""

STUBS = """
-- Deterministic stand-ins for the production helpers (single company/HQ).
CREATE OR REPLACE FUNCTION public.get_company_id(p_org uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-0000-0000-0000000000c0'::uuid $$;
CREATE OR REPLACE FUNCTION public.can_access_org(p_org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE OR REPLACE FUNCTION public.is_hq_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE OR REPLACE FUNCTION public.resolve_operational_stock_config(p_variant uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT c.id FROM public.inventory_stock_configurations c
   WHERE c.variant_id = p_variant AND c.status = 'active' AND c.default_for_ord
   ORDER BY c.id LIMIT 1
$$;
CREATE OR REPLACE FUNCTION public.stock_count_user_can_post(p_user uuid, p_org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE OR REPLACE FUNCTION public.generate_display_doc_number(p_company uuid, p_prefix text) RETURNS text
LANGUAGE sql VOLATILE AS $$ SELECT p_prefix || '26000001' $$;
CREATE OR REPLACE FUNCTION public.generate_transfer_number() RETURNS text
LANGUAGE sql VOLATILE AS $$ SELECT 'TR26000001' $$;
CREATE OR REPLACE FUNCTION public.sa_inventory_stock_scope() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION public.sa_inventory_caller_is_hq_side() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE OR REPLACE FUNCTION public.sa_inventory_stock_row_visible(p_org uuid, p_scope uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE OR REPLACE FUNCTION public.sa_stock_movement_scope() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION public.sa_stock_movement_balance_visible(p_from uuid, p_to uuid, p_scope uuid, p_hq boolean) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE OR REPLACE FUNCTION public.sa_stock_movement_row_visible(p_from uuid, p_to uuid, p_scope uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE OR REPLACE FUNCTION public.sa_require_operation(p_operation text, p_resource jsonb, p_resource_type text, p_resource_id text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
CREATE OR REPLACE FUNCTION public.manual_stock_addition_user_can_post(p_user uuid, p_org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE OR REPLACE FUNCTION public.sa_legacy_guard_unless_new(p_key text) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT true $$;
"""

# PRE-MIGRATION OBJECTS. These are the live definitions taken verbatim from the
# schema dump, i.e. exactly what staging holds before this migration runs. They
# are loaded BEFORE the migration so the harness tests a real UPGRADE (replace an
# existing function/view) instead of creating objects on an empty schema. That
# difference is what staging caught and the earlier harness did not.
#
# Every function the migration replaces or drops must be in this list, otherwise
# a return-type change would silently succeed here and fail on staging with
# 42P13 (that is precisely how _stock_transfer_totals slipped through).
LEGACY_FUNCTIONS = [
    # --- replaced / dropped by the migration (must exist to be replaced) ------
    'record_stock_movement',              # 16-arg version, dropped by the migration
    'post_manual_stock_addition',
    'stock_count_snapshot_hash',
    'verify_and_post_stock_count',
    '_stock_transfer_normalize_items',
    '_stock_transfer_totals',             # 2-column version: the staging failure
    '_stock_transfer_reserve_items',
    '_stock_transfer_release_reservations',
    'dispatch_stock_transfer',
    'receive_stock_transfer',
    # --- untouched lifecycle helpers -----------------------------------------
    '_stock_transfer_assert_route_access',
    '_stock_transfer_assert_reservation_integrity',
    'submit_stock_transfer_for_approval',
    'approve_stock_transfer',
    # --- the real caller of the changed functions ----------------------------
    # save_stock_transfer_draft does `SELECT * INTO v_totals` on
    # _stock_transfer_totals, so loading it proves the positional caller still
    # works after the OUT row type gains a column.
    'save_stock_transfer_draft',
]

# Views the migration replaces with CREATE OR REPLACE VIEW. Loaded as the
# pre-migration shape so an incompatible column list fails here, not on staging.
LEGACY_VIEWS = [
    'vw_inventory_on_hand',
    'vw_stock_movements_ordered',
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dump', required=True)
    ap.add_argument('--out', default='/tmp/pcs-harness.sql')
    args = ap.parse_args()

    src = open(args.dump).read().split('\n')

    def table_block(name):
        start = None
        for i, line in enumerate(src):
            if line.startswith('CREATE TABLE public.%s (' % name):
                start = i
                break
        if start is None:
            raise SystemExit('table not found: ' + name)
        for j in range(start, len(src)):
            if src[j].startswith(');'):
                return '\n'.join(src[start:j + 1])
        raise SystemExit('unterminated table: ' + name)

    def function_block(name):
        start = None
        for i, line in enumerate(src):
            if line.startswith('CREATE FUNCTION public.%s(' % name) or \
               line.startswith('CREATE OR REPLACE FUNCTION public.%s(' % name):
                start = i
                break
        if start is None:
            raise SystemExit('function not found: ' + name)
        for j in range(start, len(src)):
            if src[j].strip() in ('$$;', '$function$;', '$body$;'):
                return '\n'.join(src[start:j + 1])
        raise SystemExit('unterminated function: ' + name)

    def view_block(name):
        start = None
        for i, line in enumerate(src):
            if line.startswith('CREATE VIEW public.%s ' % name) or \
               line.startswith('CREATE OR REPLACE VIEW public.%s ' % name):
                start = i
                break
        if start is None:
            raise SystemExit('view not found: ' + name)
        for j in range(start, len(src)):
            if src[j].rstrip().endswith(';'):
                return '\n'.join(src[start:j + 1])
        raise SystemExit('unterminated view: ' + name)

    chunks = [HEADER]
    for name in TABLES:
        chunks.append('\n-- ' + name + '\n' + table_block(name))

    # Stubs first: the legacy functions and views below reference these helpers.
    chunks.append(STUBS)

    chunks.append('\n-- ================================================================='
                  '\n-- PRE-MIGRATION STATE (verbatim from the schema dump)'
                  '\n-- =================================================================')
    for name in LEGACY_FUNCTIONS:
        chunks.append('\n-- pre-migration ' + name + '\n' + function_block(name))
    for name in LEGACY_VIEWS:
        chunks.append('\n-- pre-migration ' + name + '\n' + view_block(name))

    # The staging pre-migration readiness report captured zero touched functions
    # executable by PUBLIC or anon. A schema dump does not preserve function ACLs,
    # so apply that security baseline explicitly; otherwise this harness would
    # certify the very PUBLIC-default drift seen after DROP + CREATE.
    acl_names = ', '.join("'%s'" % name for name in LEGACY_FUNCTIONS)
    chunks.append('''
-- Captured staging pre-migration ACL baseline: no PUBLIC/anon EXECUTE.
DO $acl_fixture$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (%s)
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%%I(%%s) FROM PUBLIC, anon',
                   r.proname, r.args);
  END LOOP;
END
$acl_fixture$;
''' % acl_names)

    open(args.out, 'w').write('\n'.join(chunks) + '\n')
    print('harness written to', args.out)
    print('  tables: %d, pre-migration functions: %d, pre-migration views: %d'
          % (len(TABLES), len(LEGACY_FUNCTIONS), len(LEGACY_VIEWS)))


if __name__ == '__main__':
    main()
