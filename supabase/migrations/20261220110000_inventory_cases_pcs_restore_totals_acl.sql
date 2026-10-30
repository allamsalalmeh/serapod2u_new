-- ============================================================================
-- Restore the captured staging ACL on _stock_transfer_totals after Cases + Pcs
-- ============================================================================
-- Scope: public._stock_transfer_totals(jsonb) only.
--
-- Operator-supplied staging evidence:
--   * pre-migration permissions.public_execute = 0;
--   * post-migration permissions.public_execute = 1, naming this function;
--   * the latest catalog checks otherwise match the post-migration contract.
--
-- Therefore the corrective action is limited to removing PUBLIC and explicit
-- anon EXECUTE. Other explicit grantees are deliberately left alone. This file
-- does not rerun the Cases + Pcs migration, replace the function, change its
-- owner, or read/write any inventory or UAT rows.
--
-- Target review requirement: use this only where the captured pre-migration ACL
-- denied PUBLIC/anon, as reported for staging. Do not infer another
-- environment's historical ACL from its current catalog.
-- NOT APPLIED by the coding agent. Apply only after review and authorization.
-- ============================================================================

BEGIN;

-- Fail closed if this is not the replaced, piece-aware function. In particular,
-- do not change the ACL of a pre-migration or otherwise unexpected function.
DO $guard$
DECLARE
  v_oid oid;
  v_result text;
BEGIN
  v_oid := to_regprocedure('public._stock_transfer_totals(jsonb)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'ACL correction requires public._stock_transfer_totals(jsonb); function not found';
  END IF;

  SELECT pg_get_function_result(v_oid) INTO v_result;
  IF v_result IS DISTINCT FROM
     'TABLE(total_items integer, total_pcs integer, total_value numeric)' THEN
    RAISE EXCEPTION 'ACL correction requires the migrated 3-column totals function; found %', v_result;
  END IF;

  IF to_regrole('anon') IS NULL THEN
    RAISE EXCEPTION 'ACL correction requires the anon role to be visible for verification';
  END IF;
END
$guard$;

-- PUBLIC includes implicit access inherited by anon. Revoke both the pseudo-role
-- and any explicit anon grant so the result matches the captured zero-access
-- baseline. No GRANT is issued here: all other explicit grantees remain as-is.
REVOKE EXECUTE ON FUNCTION public._stock_transfer_totals(jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._stock_transfer_totals(jsonb) FROM anon;

-- Verify the effective ACL, including the PostgreSQL NULL-ACL default. A failed
-- verification aborts the transaction instead of returning a false success.
DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_proc AS p
     WHERE p.oid = 'public._stock_transfer_totals(jsonb)'::regprocedure
       AND (p.proacl IS NULL OR EXISTS (
             SELECT 1
               FROM aclexplode(p.proacl) AS a
              WHERE a.privilege_type = 'EXECUTE'
                AND a.grantee = 0
           ))
  ) THEN
    RAISE EXCEPTION 'ACL correction verification failed: PUBLIC can execute _stock_transfer_totals';
  END IF;

  IF has_function_privilege(
       'anon',
       'public._stock_transfer_totals(jsonb)'::regprocedure,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'ACL correction verification failed: anon can execute _stock_transfer_totals';
  END IF;
END
$verify$;

COMMIT;
