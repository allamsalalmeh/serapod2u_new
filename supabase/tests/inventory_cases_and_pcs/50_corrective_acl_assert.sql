\set ON_ERROR_STOP 1

-- Local regression assertion for 20261220110000_inventory_cases_pcs_restore_totals_acl.sql.
-- The authenticated grant is a canary: the correction must preserve it while
-- removing both PUBLIC and explicit anon access.
DO $assert$
BEGIN
  IF pg_get_function_result('public._stock_transfer_totals(jsonb)'::regprocedure)
     IS DISTINCT FROM 'TABLE(total_items integer, total_pcs integer, total_value numeric)' THEN
    RAISE EXCEPTION 'FAIL corrective migration changed the totals function shape';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public._stock_transfer_totals(jsonb)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL corrective migration removed the unrelated authenticated canary grant';
  END IF;

  IF has_function_privilege('anon', 'public._stock_transfer_totals(jsonb)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL corrective migration left anon EXECUTE';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public._stock_transfer_totals(jsonb)'::regprocedure
       AND (p.proacl IS NULL OR EXISTS (
         SELECT 1 FROM aclexplode(p.proacl) a
          WHERE a.privilege_type = 'EXECUTE' AND a.grantee = 0))
  ) THEN
    RAISE EXCEPTION 'FAIL corrective migration left PUBLIC EXECUTE or the NULL default ACL';
  END IF;

  RAISE NOTICE 'PASS corrective migration preserved authenticated and denied PUBLIC/anon without changing the function shape';
END
$assert$;
