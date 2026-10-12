-- ============================================================================
-- Security & Access — Manufacturer Group Policies (PROPOSAL, UNAPPLIED, FOR REVIEW)
-- ----------------------------------------------------------------------------
-- Do NOT apply to staging or production until the policy definitions below are
-- reviewed. Requires 20261005110000_sa_access_profiles.sql (audience columns,
-- 'draft' status).
--
-- Finding (2026-10-06): the live catalogue has no published policy that is both
-- designated for Manufacturer accounts and limited to the Manufacturing area.
-- Manufacturing permissions (confirmed in sa_permissions):
--   manufacturing.production.manage      manufacturing.scan.reverse
--   manufacturing.adjustment.manage      manufacturing.adjustment.administer
-- Existing policies holding them:
--   adjustment-administrator     only adjustment.administer; no declared audience;
--                                HQ-oriented ("across manufacturers"), so NOT proposed for Manufacturers
--   supply-chain-full-access     internal-only and mixed with Inventory/Warehouse/QR/Product
--   legacy-*                     compatibility, never assignable
-- Add User therefore (correctly) shows an empty state for Manufacturers.
--
-- Proposal: three narrow policies, audience = Manufacturer organizations only,
-- inserted as DRAFT. Nothing is assignable until a Security & Access
-- administrator reviews and publishes each one (Roles & Policies). Draft rows
-- are never offered by Add User or People & Access, and this migration grants
-- nothing and changes no migration mode.
-- Rollback: delete the three rows (no assignments can exist while they are drafts).
-- ============================================================================

insert into public.sa_business_roles(role_key, name, description, source, status, applicable_account_types, applicable_org_types)
values
  ('manufacturing-production-operator', 'Manufacturing Production Operator',
   'Records and manages production runs for the manufacturer''s own orders. Grants nothing outside Manufacturing.',
   'template', 'draft', array['partner'], array['MFG']),
  ('manufacturing-adjustment-handler', 'Manufacturing Stock Adjustment Handler',
   'Works the stock adjustments assigned to the manufacturer. Cannot assign or resolve adjustments across manufacturers.',
   'template', 'draft', array['partner'], array['MFG']),
  ('manufacturing-scan-reversal', 'Manufacturing Scan Reversal',
   'Reverses a manufacturing scan recorded in error. Grants nothing else.',
   'template', 'draft', array['partner'], array['MFG'])
on conflict (role_key) do nothing;

insert into public.sa_business_role_permissions(role_id, permission_id)
select br.id, p.id
from (values
  ('manufacturing-production-operator', 'manufacturing.production.manage'),
  ('manufacturing-adjustment-handler',  'manufacturing.adjustment.manage'),
  ('manufacturing-scan-reversal',       'manufacturing.scan.reverse')
) as t(role_key, permission_key)
join public.sa_business_roles br on br.role_key = t.role_key and br.status = 'draft'
join public.sa_permissions p on p.permission_key = t.permission_key
on conflict do nothing;
