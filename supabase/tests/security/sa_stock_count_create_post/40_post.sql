-- ============================================================================
-- inventory.stock_count.post — after 20261019100000. Real prepare → deliver → verify-and-post chain as an
-- authenticated client, plus the code-consumption backstop on its own.
-- ============================================================================
\set ON_ERROR_STOP on
CREATE TEMP TABLE p (name text PRIMARY KEY, id uuid);
GRANT ALL ON p TO PUBLIC;
CREATE FUNCTION pg_temp.pid(n text) RETURNS uuid LANGUAGE sql AS $$ SELECT id FROM p WHERE name = n $$;
-- Sessions snapshot the on-hand quantity, so each one is created right before it is used.
CREATE FUNCTION pg_temp.fresh(n text, wh text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v uuid := sar_test.new_session_in(wh);
BEGIN INSERT INTO p VALUES (n, v); RETURN v; END $$;
-- Full user path; returns 'posted|1|1' or the first error.
CREATE FUNCTION pg_temp.post_as(p_sub uuid, p_session uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  -- The route passes the requester's own organization (users.organization_id).
  v := sar_test.try_as('authenticated', p_sub, format($f$SELECT public.prepare_stock_count_verification(%L::uuid, %L::uuid, %L, '[]'::jsonb, '{}'::jsonb)$f$,
    p_session, (SELECT organization_id FROM public.users WHERE id = p_sub), repeat('a', 64)));
  IF v <> 'OK' THEN RETURN v; END IF;
  v := sar_test.try_as('authenticated', p_sub, sar_test.finalize_sql(p_session)); IF v <> 'OK' THEN RETURN v; END IF;
  v := sar_test.try_as('authenticated', p_sub, sar_test.post_sql(p_session)); IF v <> 'OK' THEN RETURN v; END IF;
  RETURN sar_test.fp(p_session);
END $$;

-- ---------------------------------------------------------------- SHADOW: unchanged (legacy key decides)
SELECT sar_test.expect_eq('post starts SHADOW', (SELECT mode FROM public.sa_migration_modes WHERE permission_key = 'inventory.stock_count.post'), 'SHADOW');
SELECT sar_test.expect_eq('shadow: legacy poster without S&A grant posts (unchanged)', pg_temp.post_as(sar_test.uid('hq_a'), pg_temp.fresh('s1', 'wh_a1')), 'posted|1|1');
SELECT sar_test.expect_eq('shadow: S&A-only poster is still refused by the legacy rule', pg_temp.post_as(sar_test.uid2('sa_only'), pg_temp.fresh('s2', 'wh_a1')), 'ERR:P0001:permission_lost');

-- ---------------------------------------------------------------- NEW_ENFORCED
SELECT sar_test.set_mode('inventory.stock_count.post', 'NEW_ENFORCED');
SELECT sar_test.expect_eq('enforced: legacy poster without S&A grant is refused', pg_temp.post_as(sar_test.uid('hq_a'), pg_temp.fresh('n_legacy', 'wh_a1')), 'ERR:P0001:permission_lost');
SELECT sar_test.expect_eq('enforced: … nothing was issued or posted', sar_test.fp(pg_temp.pid('n_legacy')), 'draft|0|0');
SELECT sar_test.expect_eq('enforced: S&A-authorized poster without the legacy key posts', pg_temp.post_as(sar_test.uid2('sa_only'), pg_temp.fresh('n_sa', 'wh_a1')), 'posted|1|1');
SELECT sar_test.expect_eq('enforced: WH A1-scoped member posts in WH A1', pg_temp.post_as(sar_test.uid2('wh_scoped'), pg_temp.fresh('n_scoped_a1', 'wh_a1')), 'posted|1|1');
SELECT sar_test.expect_eq('enforced: … but not in WH A2 (warehouse boundary)', pg_temp.post_as(sar_test.uid2('wh_scoped'), pg_temp.fresh('n_scoped_a2', 'wh_a2')), 'ERR:P0001:permission_lost');
-- Warehouse-organization staff: the posting arithmetic itself rejects a warehouse as the requesting company
-- (pre-existing rule, unrelated to S&A), so the authority check is asserted directly.
CREATE FUNCTION pg_temp.can_post(p_sub uuid, p_wh text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v boolean;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', p_sub)::text, true);
  v := public.stock_count_user_can_post(p_sub, sar_test.org(p_wh));
  PERFORM set_config('request.jwt.claims', '', true);
  RETURN v;
END $$;
SELECT sar_test.expect_eq('enforced: WH A1 staff (warehouse grant) may post in WH A1', pg_temp.can_post(sar_test.uid2('wh_staff'), 'wh_a1'), true);
SELECT sar_test.expect_eq('enforced: … not in WH A2', pg_temp.can_post(sar_test.uid2('wh_staff'), 'wh_a2'), false);
SELECT sar_test.expect_eq('enforced: legacy HQ admin without grant may not post', pg_temp.can_post(sar_test.uid('hq_a'), 'wh_a1'), false);
SELECT sar_test.expect_eq('enforced: other-tenant HQ admin is refused (organization boundary)', pg_temp.post_as(sar_test.uid('hq_b'), pg_temp.fresh('n_other', 'wh_a1')), 'ERR:P0001:permission_lost');
SELECT sar_test.expect_eq('enforced: drafter without the post grant is refused', pg_temp.post_as(sar_test.uid('user'), pg_temp.fresh('n_drafter', 'wh_a1')), 'ERR:P0001:permission_lost');
SELECT sar_test.expect_eq('enforced: inactive account is refused', pg_temp.post_as(sar_test.uid('inactive'), pg_temp.pid('n_drafter')), 'ERR:P0001:permission_lost');
SELECT sar_test.expect_eq('enforced: refused attempts left no request and no movement',
  sar_test.fp(pg_temp.pid('n_scoped_a2')) || ',' || sar_test.fp(pg_temp.pid('n_other')) || ',' || sar_test.fp(pg_temp.pid('n_drafter')), 'draft|0|0,draft|0|0,draft|0|0');

-- Backstop on its own: a code issued while SHADOW cannot be consumed after the switch by someone S&A refuses,
-- whichever SECURITY DEFINER function performs the consumption (simulated by a direct owner update with the
-- caller's claims, i.e. a path that skipped stock_count_user_can_post).
SELECT sar_test.set_mode('inventory.stock_count.post', 'SHADOW');
SELECT pg_temp.fresh('cut', 'wh_a1');
SELECT sar_test.expect_ok('cutover: code issued for the legacy poster while SHADOW', 'authenticated', sar_test.uid('hq_a'), sar_test.prepare_sql(pg_temp.pid('cut')));
SELECT sar_test.expect_ok('cutover: … delivered', 'authenticated', sar_test.uid('hq_a'), sar_test.finalize_sql(pg_temp.pid('cut')));
SELECT sar_test.set_mode('inventory.stock_count.post', 'NEW_ENFORCED');
SELECT sar_test.expect_err('cutover: verify-and-post by the legacy-only poster is refused', 'authenticated', sar_test.uid('hq_a'), sar_test.post_sql(pg_temp.pid('cut')), 'permission_lost');
SELECT set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', sar_test.uid('hq_a'))::text, false);
DO $$ BEGIN
  UPDATE public.stock_count_verification_requests SET status = 'posted', verified_by = sar_test.uid('hq_a'), verified_at = now(), consumed_at = now()
  WHERE id = sar_test.request_of((SELECT id FROM p WHERE name = 'cut'));
  RAISE EXCEPTION 'FAIL [backstop: direct consumption by a refused actor]: not blocked';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS [backstop: consumption by an S&A-refused actor is blocked in the database] (%)', SQLERRM;
END $$;
DO $$ BEGIN
  INSERT INTO public.stock_count_verification_requests (organization_id, session_id, requesting_user_id, code_hash, snapshot_hash, expires_at)
  VALUES (sar_test.org('hq_a'), (SELECT id FROM p WHERE name = 'n_legacy'), sar_test.uid('hq_a'), repeat('b', 64), 'x', now() + interval '10 minutes');
  RAISE EXCEPTION 'FAIL [backstop: code issue for a refused actor]: not blocked';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS [backstop: issuing a code to an S&A-refused actor is blocked in the database] (%)', SQLERRM;
END $$;
SELECT set_config('request.jwt.claims', '', false);
SELECT sar_test.expect_eq('cutover: nothing posted; the code is still active',
  sar_test.fp(pg_temp.pid('cut')) || ',' || (SELECT status FROM public.stock_count_verification_requests WHERE id = sar_test.request_of(pg_temp.pid('cut'))), 'draft|1|0,active');
SELECT sar_test.expect_ok('backstop: expiry/invalidation stay unrestricted', 'service_role', NULL,
  format($f$UPDATE public.stock_count_verification_requests SET status = 'invalidated', invalidated_at = now() WHERE id = %L$f$, sar_test.request_of(pg_temp.pid('cut'))));

-- With verify ALSO enforced (staging today): both decisions are needed.
SELECT sar_test.set_mode('inventory.stock_count.verify', 'NEW_ENFORCED');
SELECT pg_temp.fresh('vv_sa', 'wh_a1');
SELECT sar_test.verify_allow(sar_test.uid2('sa_only'), pg_temp.pid('vv_sa'));
SELECT sar_test.expect_eq('verify+post enforced: S&A poster with a verify ALLOW posts', pg_temp.post_as(sar_test.uid2('sa_only'), pg_temp.pid('vv_sa')), 'posted|1|1');
SELECT pg_temp.fresh('vv_legacy', 'wh_a1');
SELECT sar_test.verify_allow(sar_test.uid('hq_a'), pg_temp.pid('vv_legacy'));
SELECT sar_test.expect_eq('verify+post enforced: a verify ALLOW does not replace the post decision', pg_temp.post_as(sar_test.uid('hq_a'), pg_temp.pid('vv_legacy')), 'ERR:P0001:permission_lost');
SELECT sar_test.set_mode('inventory.stock_count.verify', 'SHADOW');

-- ---------------------------------------------------------------- LEGACY_RETIRED and LEGACY_ENFORCED
SELECT sar_test.set_mode('inventory.stock_count.post', 'LEGACY_RETIRED');
SELECT sar_test.expect_eq('retired: S&A poster posts', pg_temp.post_as(sar_test.uid2('sa_only'), pg_temp.fresh('r_sa', 'wh_a1')), 'posted|1|1');
SELECT sar_test.expect_eq('retired: legacy-only poster is refused', pg_temp.post_as(sar_test.uid('hq_a'), pg_temp.fresh('r_legacy', 'wh_a1')), 'ERR:P0001:permission_lost');
SELECT sar_test.set_mode('inventory.stock_count.post', 'LEGACY_ENFORCED');
SELECT sar_test.expect_eq('legacy-enforced: legacy poster posts (unchanged)', pg_temp.post_as(sar_test.uid('hq_a'), pg_temp.pid('r_legacy')), 'posted|1|1');

SELECT sar_test.set_mode('inventory.stock_count.post', 'SHADOW');
SELECT 'stock count post suite passed' AS status;
