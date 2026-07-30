-- ============================================================================
-- PRODUCTION HOTFIX — restore Cartridge configuration profile + configs
-- Date: 2026-07-27   Env: production (serapod-prd-db, database "supabase")
-- ============================================================================
-- WHY
--   The 20260727_stock_count_group_config_profile migration's data steps
--   mis-ran on production:
--     * Part A backfill left group 'Catridge' (CAT-815102) as 'standard'
--       (its concentration configs had no balance/movement/order at that time),
--       whereas staging correctly became 'concentration'.
--     * Part C cleanup then deactivated ALL 108 Cartridge 20NB/50NB/50OB configs
--       (status=inactive, allow_* = false) as if they were invalid.
--   Result: production Cartridge counting/ordering is broken. Device is fine
--   (its concentration configs are correctly inactive).
--
-- WHAT THIS DOES (targeted + reversible)
--   1. Snapshots the affected rows into _backup_* tables (rollback safety).
--   2. Sets Catridge (CAT-815102) -> 'concentration' (matches staging).
--   3. Restores its 108 concentration configs to staging's exact template:
--        20NB -> active,     allow_ord=t, allow_so=t, default_for_ord=t
--        50NB -> active,     allow_ord=f, allow_so=t, default_for_ord=f
--        50OB -> phase_out,  allow_ord=f, allow_so=f, default_for_ord=f
--   Device (DEV-819958) is intentionally left untouched.
--
-- HOW TO RUN
--   ssh -i ~/.ssh/id_ed25519 deploy@72.62.253.182 \
--     "docker exec -i serapod-prd-db psql -U postgres -d supabase" < THIS_FILE
--   Review the verification output before it COMMITs (it is one transaction;
--   comment out COMMIT and use ROLLBACK for a dry run first if desired).
-- ============================================================================

-- ---- Rollback backups (non-destructive) -----------------------------------
DROP TABLE IF EXISTS _backup_group_profile_fix_20260727;
CREATE TABLE _backup_group_profile_fix_20260727 AS
  SELECT id, group_code, stock_config_profile, now() AS backed_up_at
  FROM public.product_groups WHERE group_code = 'CAT-815102';

DROP TABLE IF EXISTS _backup_stock_config_fix_20260727;
CREATE TABLE _backup_stock_config_fix_20260727 AS
  SELECT c.id, c.config_code, c.status, c.allow_ord, c.allow_so, c.default_for_ord, now() AS backed_up_at
  FROM public.inventory_stock_configurations c
  JOIN public.product_variants pv ON pv.id = c.variant_id
  JOIN public.products p ON p.id = pv.product_id
  JOIN public.product_groups g ON g.id = p.group_id
  WHERE g.group_code = 'CAT-815102'
    AND (c.volume_ml IS NOT NULL OR c.packaging IS NOT NULL);

-- ---- Fix (single transaction) ---------------------------------------------
BEGIN;

UPDATE public.product_groups
SET stock_config_profile = 'concentration'
WHERE group_code = 'CAT-815102';

UPDATE public.inventory_stock_configurations c
SET status         = CASE c.config_code WHEN '50OB' THEN 'phase_out' ELSE 'active' END,
    allow_ord      = (c.config_code = '20NB'),
    allow_so       = (c.config_code IN ('20NB', '50NB')),
    default_for_ord= (c.config_code = '20NB'),
    updated_at     = now()
FROM public.product_variants pv
JOIN public.products p ON p.id = pv.product_id
JOIN public.product_groups g ON g.id = p.group_id
WHERE c.variant_id = pv.id
  AND g.group_code = 'CAT-815102'
  AND (c.volume_ml IS NOT NULL OR c.packaging IS NOT NULL);

-- ---- Verification (should mirror staging) ---------------------------------
-- Expect: stock_config_profile = 'concentration'
SELECT group_code, group_name, stock_config_profile
FROM public.product_groups WHERE group_code = 'CAT-815102';

-- Expect: 20NB active / 50NB active / 50OB phase_out
SELECT c.config_code, c.status, c.allow_ord, c.allow_so, c.default_for_ord, count(*) n
FROM public.inventory_stock_configurations c
JOIN public.product_variants pv ON pv.id = c.variant_id
JOIN public.products p ON p.id = pv.product_id
JOIN public.product_groups g ON g.id = p.group_id
WHERE g.group_code = 'CAT-815102' AND (c.volume_ml IS NOT NULL OR c.packaging IS NOT NULL)
GROUP BY c.config_code, c.status, c.allow_ord, c.allow_so, c.default_for_ord
ORDER BY c.config_code;

COMMIT;

-- ============================================================================
-- ROLLBACK (if ever needed)
-- ============================================================================
-- BEGIN;
-- UPDATE public.product_groups g
--   SET stock_config_profile = b.stock_config_profile
--   FROM _backup_group_profile_fix_20260727 b WHERE g.id = b.id;
-- UPDATE public.inventory_stock_configurations c
--   SET status = b.status, allow_ord = b.allow_ord, allow_so = b.allow_so,
--       default_for_ord = b.default_for_ord, updated_at = now()
--   FROM _backup_stock_config_fix_20260727 b WHERE c.id = b.id;
-- COMMIT;
-- ============================================================================
