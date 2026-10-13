-- After 20261023100000 (applied twice). Real mode-change functions, real identity_set_account_status, real guards.
-- Readiness registered; the migration changed no mode.
select saf.expect((select route_wiring and database_backstop = 'governance_function' and intentional_tightening like '%Super Admin%' from public.sa_enforcement_readiness where permission_key = 'platform.identity.delete'), 'readiness registered with governance-function backstop and documented tightening');
select saf.expect((select count(*) from public.sa_enforcement_readiness where permission_key = 'platform.identity.delete') = 1, 'one readiness row (idempotent)');
select saf.expect(not exists (select 1 from public.sa_migration_modes m join saf.modes_before_identity b using (permission_key) where m.mode <> b.mode), 'no migration mode changed by the migration');

-- SHADOW: the database lifecycle function keeps its own legacy rule (Super Admin only), which is why the application keeps
-- the historical direct archive (HQ Admin / Super Admin, decided by the route) until the permission is enforced.
select saf.expect(saf.try(format($q$select public.identity_set_account_status(%L, %L, 'ARCHIVED', 'shadow legacy check')$q$, saf.u(2), saf.u(14))) like 'sa_authorization_required%', 'SHADOW: a level-10 administrator is refused by the database legacy rule');
select saf.expect((select account_status = 'ACTIVE' from public.users where id = saf.u(14)), 'SHADOW refusal leaves the account untouched');

-- Preview and execution agree: both now report "change"; the group change succeeds.
select saf.expect((select status = 'change' and cardinality(blockers) = 0 from public.sa_bulk_mode_evaluate(array['platform.identity.delete'], 'NEW_ENFORCED')), 'evaluate: change');
select saf.expect((select status = 'change' from public.sa_preview_bulk_migration_mode(saf.u(1), array['platform.identity.delete'], 'NEW_ENFORCED')), 'preview: change');
select saf.expect(saf.try(format($q$select public.sa_bulk_set_migration_mode(%L, array['platform.identity.delete'], jsonb_build_object('platform.identity.delete', 'SHADOW'), 'NEW_ENFORCED', null, 'platform', 'all', gen_random_uuid())$q$, saf.u(1))) = 'OK', 'group change to New Access Active succeeds (execution agrees with preview)');
select saf.expect((select mode = 'NEW_ENFORCED' from public.sa_migration_modes where permission_key = 'platform.identity.delete'), 'now NEW_ENFORCED (in this throwaway database only)');
-- Submission rechecks authority: an administrator without security.permission.manage cannot change it back.
select saf.expect(saf.try(format($q$select public.sa_set_migration_mode(%L, 'platform.identity.delete', 'SHADOW', 'not my authority here')$q$, saf.u(3))) like 'sa_authorization_required%', 'mode change by a non-administrator refused at submission');

-- NEW_ENFORCED: Balakong-scoped archive administrator (u5).
select public.sa_assign_role(saf.u(1), saf.u(5), '00000000-0000-0000-0005-000000000020', saf.o(2), array[saf.s(2)], now(), null, 'Balakong archive administrator');
select saf.expect((public.sa_evaluate_permission(saf.u(5), 'platform.identity.delete', jsonb_build_object('organization_id', saf.o(2)))->>'decision') = 'ALLOW', 'archive administrator allowed in Balakong');
select saf.expect((public.sa_evaluate_permission(saf.u(5), 'platform.identity.delete', jsonb_build_object('organization_id', saf.o(3)))->>'decision') = 'DENY', 'archive administrator denied in Alma (out of scope)');
select saf.expect((public.sa_evaluate_permission(saf.u(2), 'platform.identity.delete', jsonb_build_object('organization_id', saf.o(2)))->>'decision') = 'DENY', 'an HQ level-10 administrator without the grant is denied once enforced (intentional tightening)');

create table saf.alma_before as select * from public.users where id = saf.u(11);
create table saf.mem_before as select * from public.sa_organization_memberships where user_id in (saf.u(10), saf.u(11));

-- Authorized archive (soft): ARCHIVED, history-safe, identifiers kept, audited.
select saf.expect(saf.try(format($q$select public.identity_set_account_status(%L, %L, 'ARCHIVED', 'Archived by administrator (history retained; identifiers reserved)')$q$, saf.u(5), saf.u(10))) = 'OK', 'authorized archive succeeds');
select saf.expect((select account_status = 'ARCHIVED' and email = 'u10@dev.com' from public.users where id = saf.u(10)), 'target archived; email kept (soft archive, nothing deleted)');
select saf.expect(exists (select 1 from public.users where id = saf.u(10)), 'identity row still exists');
select saf.expect((select count(*) from public.sa_access_change_log where action = 'identity.status_changed' and target_user_id = saf.u(10)) = 1, 'archive audited in sa_access_change_log');
select saf.expect(not exists (select 1 from public.sa_organization_memberships m join saf.mem_before b using (id) where m.user_id = saf.u(10) and m.status is distinct from b.status), 'archive does not rewrite memberships (unchanged semantics)');
select saf.expect(saf.try(format($q$select public.identity_set_account_status(%L, %L, 'DISABLED', 'archived stays terminal')$q$, saf.u(5), saf.u(10))) like 'identity_archived_is_terminal%', 'ARCHIVED stays terminal');

-- Out-of-scope archive refused in the database; nothing changes.
select saf.expect(saf.try(format($q$select public.identity_set_account_status(%L, %L, 'ARCHIVED', 'out of scope attempt')$q$, saf.u(5), saf.u(11))) like 'sa_authorization_required%', 'out-of-scope archive refused');
select saf.expect((select row(u.*)::text from public.users u where id = saf.u(11)) = (select row(b.*)::text from saf.alma_before b), 'refused archive leaves the account unchanged');
select saf.expect(not exists (select 1 from public.sa_organization_memberships m join saf.mem_before b using (id) where m.user_id = saf.u(11) and row(m.*)::text <> row(b.*)::text), 'refused archive leaves memberships unchanged');
-- Unauthorized administrator (no grant) refused.
select saf.expect(saf.try(format($q$select public.identity_set_account_status(%L, %L, 'ARCHIVED', 'no authority attempt')$q$, saf.u(3), saf.u(14))) like 'sa_authorization_required%', 'administrator without the permission refused');
-- Self archive refused.
select saf.expect(saf.try(format($q$select public.identity_set_account_status(%L, %L, 'ARCHIVED', 'self archive attempt')$q$, saf.u(5), saf.u(5))) like 'identity_self_status_change_prohibited%', 'self archive refused');

-- Target protection (sa_actor_dominates): a target holding an HQ-wide grant is more privileged than a Balakong administrator.
select public.sa_assign_role(saf.u(1), saf.u(13), '00000000-0000-0000-0005-000000000002', saf.o(1), array[saf.s(1)], now(), null, 'HQ payer');
select saf.expect(public.sa_actor_dominates(saf.u(5), saf.u(13)) is false, 'Balakong administrator does not dominate an HQ-granted target');
select saf.expect(public.sa_actor_dominates(saf.u(5), saf.u(14)) is true, 'Balakong administrator dominates a plain Balakong employee');

-- Direct API-role paths cannot bypass: neither archive nor delete through PostgREST roles.
set role authenticated;
select saf.expect(saf.try(format($q$update public.users set account_status = 'ARCHIVED' where id = %L$q$, saf.u(14))) like 'identity_protected_field%', 'API role cannot archive by direct update');
select saf.expect(saf.try(format($q$delete from public.users where id = %L$q$, saf.u(14))) like 'identity_delete_requires_lifecycle%', 'API role cannot delete an identity');
reset role;
select saf.expect((select account_status = 'ACTIVE' from public.users where id = saf.u(14)), 'direct attempts left the account untouched');
-- The lifecycle function is not callable by API roles.
select saf.expect(not has_function_privilege('authenticated', 'public.identity_set_account_status(uuid,uuid,text,text)', 'EXECUTE') and not has_function_privilege('anon', 'public.identity_set_account_status(uuid,uuid,text,text)', 'EXECUTE'), 'identity_set_account_status is service-role only');
-- History blocks a hard delete by the server; the identity must be archived.
set role service_role;
select saf.expect(saf.try(format($q$delete from public.users where id = %L$q$, saf.u(12))) like 'identity_has_history%', 'hard delete of an identity with history refused');
reset role;
select saf.expect(exists (select 1 from public.users where id = saf.u(12)), 'identity with history still present');

-- Submission rechecks readiness, not only the preview: readiness withdrawn after a preview (e.g. the rollback statement)
-- refuses the next change in both the single and the group path, and the mode is unchanged.
begin;
delete from public.sa_enforcement_readiness where permission_key = 'platform.identity.delete';
select saf.expect(saf.try(format($q$select public.sa_set_migration_mode(%L, 'platform.identity.delete', 'LEGACY_RETIRED', null)$q$, saf.u(1))) like 'sa_not_enforcement_ready%', 'single change re-checks readiness at submission');
select saf.expect(saf.try(format($q$select public.sa_bulk_set_migration_mode(%L, array['platform.identity.delete'], jsonb_build_object('platform.identity.delete', 'NEW_ENFORCED'), 'LEGACY_RETIRED', null, 'platform', 'all', gen_random_uuid())$q$, saf.u(1))) <> 'OK', 'group change re-checks readiness at submission');
select saf.expect((select mode = 'NEW_ENFORCED' from public.sa_migration_modes where permission_key = 'platform.identity.delete'), 'mode unchanged after refused submissions');
rollback;
