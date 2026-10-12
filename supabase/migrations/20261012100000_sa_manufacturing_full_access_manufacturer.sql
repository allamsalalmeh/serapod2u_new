-- ============================================================================
-- Security & Access — standard Group Policy "Manufacturing Full Access — Manufacturer"
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database,
-- so nothing in this file has been run against a real database. The policy exists (and Add User / People & Access
-- can offer it to Manufacturer accounts) ONLY after this migration is applied.
--
-- Finding (2026-10-06): the catalogue holds no published policy that is both designated for Manufacturer accounts and
-- limited to the Manufacturing area. Nothing is mis-filtered: Add User correctly shows an empty state for Manufacturers
-- (adjustment-administrator has no declared audience; supply-chain-full-access is internal-only and mixed; legacy-* are
-- never assignable).
--
-- Policy (a Group Policy IS a business role; same engine, lifecycle, scopes, SoD and audit as every other policy):
--   role_key     manufacturing-full-access-manufacturer
--   source       template  (protected; "Copy & Customize" creates an editable copy, the original is never edited)
--   status       active    (published; assignable by an administrator holding security.role.assign)
--   audience     account types {partner}, organization types {MFG}  → offered to Manufacturer accounts only
--   permissions  an EXPLICIT reviewed list, no wildcard, no inheritance, nothing added later automatically:
--                  manufacturing.adjustment.manage    (the manufacturer's own assigned stock adjustments)
--                  manufacturing.production.manage    (production runs / packing of the manufacturer's own orders)
--                  manufacturing.scan.reverse         (reverse a manufacturing scan recorded by the manufacturer)
--
-- DELIBERATELY NOT INCLUDED: manufacturing.adjustment.administer.
--   Its two operations (POST /api/admin/adjustments/[id]/assign and /status) assign an adjustment to ANY manufacturer
--   and resolve/reject any adjustment. They are cross-manufacturer administration: the route authorizes in the caller's
--   own organization only and passes no target-manufacturer context, and the two RPCs (assign_adjustment_to_manufacturer,
--   admin_update_adjustment_status) are not defined in this repository, so a manufacturer-organization scope cannot be
--   shown to limit them. Putting it in a Manufacturer policy would label it Manufacturer while allowing broader data
--   access. It stays in the HQ-side "adjustment-administrator" policy. It can be added later, explicitly and reviewed,
--   with sa_extend_standard_policy() once those RPCs enforce a manufacturer scope.
--
-- Scope behaviour: a Manufacturer recipient is offered its OWN organization (and organizations beneath it) as the data
-- scope (scope-eligibility.ts); an HQ or warehouse scope is never offered to it. The three operations then filter by the
-- caller's own organization (adjustments: target_manufacturer_org_id = own organization; delete-scan-history: order
-- seller_org_id = own organization) or run under the caller's session (row-level security). It is not granted
-- to anyone here, no migration mode / existing policy / assignment is changed, and no existing policy is repurposed.
--
-- Relation to 20261010100000_sa_manufacturer_manufacturing_policies_draft.sql (also unapplied): that file proposes three
-- narrow DRAFT policies. This single standard policy supersedes the need for it; applying both is harmless (different
-- keys) but redundant. Do not apply the draft file unless you want the three narrow policies as well.
--
-- Repeat-safe: an existing row is never modified, expanded or re-seeded. Fails loudly (raises) instead of silently
-- omitting a permission or when the key is held by a non-standard role.
-- Requires 20261005110000_sa_access_profiles.sql and 20261009100000_sa_group_policies_full_access.sql
-- (sa_standard_policy_coverage, sa_log_access_change).
--
-- Rollback (only while unassigned): delete from public.sa_business_roles where role_key = 'manufacturing-full-access-manufacturer';
--   (permission links and the coverage row cascade). An assigned policy cannot be deleted; revoke its assignments first.
-- ============================================================================

do $seed$
declare
  v_key constant text := 'manufacturing-full-access-manufacturer';
  v_perms constant text[] := array['manufacturing.adjustment.manage','manufacturing.production.manage','manufacturing.scan.reverse'];
  v_role uuid;
  v_missing text[];
  v_existing text;
begin
  select array_agg(k order by k) into v_missing from unnest(v_perms) k
  where not exists (select 1 from public.sa_permissions p where p.permission_key = k and p.status = 'active');
  if v_missing is not null then
    raise exception 'sa_group_policy_permission_missing: % (%)', v_key, array_to_string(v_missing, ', ')
      using hint = 'Apply the migrations that register these permissions first. Nothing is omitted silently.';
  end if;

  select b.source into v_existing from public.sa_business_roles b where b.role_key = v_key;
  if v_existing is not null and v_existing <> 'template' then
    raise exception 'sa_group_policy_key_conflict: % already exists as a non-standard role', v_key;
  end if;

  insert into public.sa_business_roles(role_key, name, description, source, status, applicable_account_types, applicable_org_types)
  values (v_key, 'Manufacturing Full Access — Manufacturer',
    'Manufacturing operations for a manufacturer''s own organization: manage the stock adjustments assigned to it, manage production, and reverse its own manufacturing scans. Limited to the manufacturer''s own organization; it grants nothing in Finance, HR, Employee Self Service, Security & Access or other Supply Chain areas, and cannot assign or resolve adjustments across manufacturers.',
    'template', 'active', array['partner'], array['MFG'])
  on conflict (role_key) do nothing
  returning id into v_role;

  -- Already present: never modified, never expanded, never re-recorded here.
  if v_role is null then return; end if;

  insert into public.sa_business_role_permissions(role_id, permission_id)
  select v_role, p.id from public.sa_permissions p where p.permission_key = any(v_perms) and p.status = 'active';

  insert into public.sa_standard_policy_coverage(role_id, role_key, module_id, module_prefixes, permission_keys)
  values (v_role, v_key, 'supply_chain', array['manufacturing'], (select array_agg(k order by k) from unnest(v_perms) k));

  perform public.sa_log_access_change(null, 'access_profile.standard_seeded', null, 'sa_business_role', v_role::text,
    jsonb_build_object('role_key', v_key, 'module', 'supply_chain', 'permission_count', cardinality(v_perms)),
    'Standard Manufacturing Full Access (Manufacturer) group policy seeded (not assigned to anyone)', 'system');
end $seed$;
