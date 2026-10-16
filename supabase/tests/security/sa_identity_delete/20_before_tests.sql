-- Before 20261023100000: Archive Identities is blocked identically in preview and in execution (single and group).
select saf.expect(not exists (select 1 from public.sa_enforcement_readiness where permission_key = 'platform.identity.delete'), 'not registered before the migration');
select saf.expect((select status = 'blocked' and blockers = array['sa_not_enforcement_ready'] from public.sa_bulk_mode_evaluate(array['platform.identity.delete'], 'NEW_ENFORCED')), 'evaluate: blocked, not enforcement-ready');
select saf.expect((select status = 'blocked' and blockers = array['sa_not_enforcement_ready'] from public.sa_preview_bulk_migration_mode(saf.u(1), array['platform.identity.delete'], 'NEW_ENFORCED')), 'preview: blocked');
select saf.expect(saf.try(format($q$select public.sa_set_migration_mode(%L, 'platform.identity.delete', 'NEW_ENFORCED', null)$q$, saf.u(1))) like 'sa_not_enforcement_ready%', 'single change refused');
select saf.expect(saf.try(format($q$select public.sa_bulk_set_migration_mode(%L, array['platform.identity.delete'], jsonb_build_object('platform.identity.delete', 'SHADOW'), 'NEW_ENFORCED', null, 'platform', 'all', gen_random_uuid())$q$, saf.u(1))) <> 'OK', 'group change refused');
select saf.expect((select mode = 'SHADOW' from public.sa_migration_modes where permission_key = 'platform.identity.delete'), 'still SHADOW');
