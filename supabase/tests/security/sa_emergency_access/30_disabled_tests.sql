-- After 20261024100000 (applied twice), before the enable migration.
select saf.expect((select route_wiring and database_backstop = 'governance_function' from public.sa_enforcement_readiness where permission_key = 'security.emergency_access.grant'), 'readiness registered');
select saf.expect((select count(*) from public.sa_enforcement_readiness where permission_key = 'security.emergency_access.grant') = 1, 'one readiness row (idempotent)');
select saf.expect(not exists (select 1 from public.sa_migration_modes m join saf.modes_before_emergency b using (permission_key) where m.mode <> b.mode), 'no migration mode changed by the migration');
select saf.expect(public.sa_setting_bool('emergency_access.mfa_step_up_available', false) and not public.sa_setting_bool('emergency_access.enabled', true), 'prerequisite registered; feature still disabled');
select saf.expect(public.sa_setting_int('emergency_access.step_up_max_age_seconds', 0) = 300 and public.sa_setting_int('emergency_access.min_minutes', 0) = 5, 'freshness and minimum duration settings');

-- Disabled: even a Super Admin with a fresh step-up cannot grant.
select saf.expect(saf.grant(saf.u(1), saf.u(6), saf.o(1), array['finance.payment.approve'], saf.s(1), saf.session(saf.u(1))) like 'emergency_access_unavailable%', 'disabled feature refuses every grant');
select saf.expect(not exists (select 1 from public.sa_emergency_access_grants), 'nothing written');

-- The old entry point is closed and unreachable by API roles.
select saf.expect(saf.try($q$select public.sa_request_emergency_access(null, array['finance.payment.approve'], 'x', 30)$q$) like 'emergency_access_use_grant_flow%', 'stub refuses');
select saf.expect(not has_function_privilege('authenticated', 'public.sa_request_emergency_access(uuid,text[],text,integer)', 'EXECUTE'), 'stub no longer EXECUTE-able by authenticated');
-- Direct table / function bypass: API roles cannot read or write grants or call the governance functions.
select saf.expect(not has_table_privilege(r, 'public.sa_emergency_access_grants', p), format('%s has no %s on grants', r, p))
  from unnest(array['anon','authenticated']) r, unnest(array['SELECT','INSERT','UPDATE','DELETE']) p;
select saf.expect(not has_table_privilege('service_role', 'public.sa_emergency_access_grants', p), format('service_role has no %s on grants', p))
  from unnest(array['INSERT','UPDATE','DELETE']) p;
select saf.expect(not has_function_privilege('authenticated', f, 'EXECUTE') and not has_function_privilege('anon', f, 'EXECUTE'), format('%s not callable by API users', f))
  from unnest(array['public.sa_grant_emergency_access(uuid,uuid,uuid,text[],uuid,text,integer,uuid,uuid)', 'public.sa_revoke_emergency_access(uuid,uuid,text)',
                    'public.sa_evaluate_permission_core(uuid,text,jsonb,boolean,boolean)', 'public.sa_assert_fresh_step_up(uuid,uuid)']) f;
select saf.expect(not has_function_privilege('service_role', 'public.sa_assert_fresh_step_up(uuid,uuid)', 'EXECUTE'), 'step-up check is internal only');
set role authenticated;
select saf.expect(saf.try(format($q$insert into public.sa_emergency_access_grants(user_id, organization_id, permission_keys, reason, status, activated_at, effective_until) values (%L, %L, array['finance.payment.approve'], 'direct insert bypass attempt here', 'active', now(), now() + interval '1 hour')$q$, saf.u(6), saf.o(1))) like 'permission denied%', 'authenticated cannot insert a grant');
select saf.expect(saf.try(format($q$select public.sa_grant_emergency_access(%L, %L, %L, array['finance.payment.approve'], %L, 'direct rpc bypass attempt here', 30, gen_random_uuid(), gen_random_uuid())$q$, saf.u(1), saf.u(6), saf.o(1), saf.s(1))) like 'permission denied%', 'authenticated cannot call the grant function');
reset role;
set role service_role;
select saf.expect(saf.try(format($q$insert into public.sa_emergency_access_grants(user_id, organization_id, permission_keys, reason, status, activated_at, effective_until) values (%L, %L, array['finance.payment.approve'], 'service role direct insert attempt', 'active', now(), now() + interval '1 hour')$q$, saf.u(6), saf.o(1))) like 'permission denied%', 'service_role cannot insert directly (governance function only)');
reset role;
