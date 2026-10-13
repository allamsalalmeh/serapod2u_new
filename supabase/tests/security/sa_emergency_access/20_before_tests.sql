-- Before 20261024100000: no grant flow, permission blocked identically in preview and execution, stub refuses.
select saf.expect(not exists (select 1 from public.sa_enforcement_readiness where permission_key = 'security.emergency_access.grant'), 'not registered before the migration');
select saf.expect((select status = 'blocked' and blockers = array['sa_not_enforcement_ready'] from public.sa_bulk_mode_evaluate(array['security.emergency_access.grant'], 'NEW_ENFORCED')), 'evaluate: blocked');
select saf.expect((select status = 'blocked' from public.sa_preview_bulk_migration_mode(saf.u(1), array['security.emergency_access.grant'], 'NEW_ENFORCED')), 'preview: blocked');
select saf.expect(saf.try(format($q$select public.sa_set_migration_mode(%L, 'security.emergency_access.grant', 'NEW_ENFORCED', null)$q$, saf.u(1))) like 'sa_not_enforcement_ready%', 'single change refused');
select saf.expect(to_regprocedure('public.sa_grant_emergency_access(uuid,uuid,uuid,text[],uuid,text,integer,uuid,uuid)') is null, 'no grant function exists yet');
select saf.expect(has_function_privilege('authenticated', 'public.sa_request_emergency_access(uuid,text[],text,integer)', 'EXECUTE'), 'pre-state: the refusing stub is EXECUTE-able by authenticated');
-- Negative control for the evaluator: an emergency row (written as the owner) is NOT consumed by the old evaluator.
insert into public.sa_emergency_access_grants(user_id, organization_id, permission_keys, reason, status, activated_at, effective_until)
  values (saf.u(6), saf.o(1), array['finance.payment.approve'], 'negative control row, written as owner only', 'active', now(), now() + interval '1 hour');
select saf.expect((saf.decide(saf.u(6), 'finance.payment.approve', saf.o(1))->>'decision') = 'DENY', 'old evaluator ignores emergency grants (root cause)');
delete from public.sa_emergency_access_grants;
