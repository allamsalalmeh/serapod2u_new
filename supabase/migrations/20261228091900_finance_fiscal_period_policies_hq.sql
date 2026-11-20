-- Fiscal Year & Periods policies: grantable to Headquarters (HQ), like every other Finance policy
--
-- 20261228090200 created the five narrow policies (fiscal-year-creator, accounting-period-opener,
-- accounting-period-closer, accounting-period-reopener, fiscal-year-locker) with an empty
-- applicable_org_types list. Since 20261030100000 an empty list means "unclassified = eligible nowhere",
-- so Security & Access shows them as "Unclassified · not grantable" and nobody can be given them.
--
-- This classifies them HQ only, the same as finance-full-access and the other Finance policies in
-- 20261030100000 (the Finance module is HQ-only). Only rows whose list is still empty are changed; an explicit
-- list is never overwritten. updated_by = null: recorded by sa_business_role_eligibility_guard as a system change
-- in sa_access_change_log. The guard also checks that every permission of each policy is allowed for HQ.
-- No assignment, permission, migration mode or other policy is touched. Idempotent.

BEGIN;

UPDATE public.sa_business_roles
   SET applicable_org_types = ARRAY['HQ']::text[], updated_at = now(), updated_by = NULL
 WHERE role_key IN ('fiscal-year-creator', 'accounting-period-opener', 'accounting-period-closer',
                    'accounting-period-reopener', 'fiscal-year-locker')
   AND source = 'template'
   AND cardinality(applicable_org_types) = 0;

-- All five must now be classified.
DO $check$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.sa_business_roles
   WHERE role_key IN ('fiscal-year-creator', 'accounting-period-opener', 'accounting-period-closer',
                      'accounting-period-reopener', 'fiscal-year-locker')
     AND source = 'template' AND applicable_org_types = ARRAY['HQ']::text[];
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'expected 5 fiscal period policies classified HQ, found %', v_n;
  END IF;
END
$check$;

COMMIT;
