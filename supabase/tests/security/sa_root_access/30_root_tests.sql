-- After 20261026100000 (applied twice). State flows top to bottom.
-- ── Privileges: nothing but the governance functions writes Root Access ─────────────────────────────────────────
select saf.expect(not has_table_privilege(r, 'public.sa_root_access_grants', p), format('%s has no %s on Root Access', r, p))
  from unnest(array['anon','authenticated']) r, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p;
select saf.expect(has_table_privilege('service_role', 'public.sa_root_access_grants', 'SELECT'), 'server may read Root Access status');
select saf.expect(not has_table_privilege('service_role', 'public.sa_root_access_grants', p), format('service_role has no %s', p))
  from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p;
select saf.expect(not has_function_privilege(r, f, 'EXECUTE'), format('%s cannot execute %s', r, f))
  from unnest(array['anon','authenticated']) r,
       unnest(array['public.sa_grant_root_access(uuid,uuid,text,timestamptz,uuid)', 'public.sa_revoke_root_access(uuid,uuid,text)',
                    'public.sa_bootstrap_root_access(uuid,text)', 'public.sa_actor_is_root(uuid)']) f;
select saf.expect(not has_function_privilege('service_role', 'public.sa_bootstrap_root_access(uuid,text)', 'EXECUTE'), 'service_role cannot bootstrap');
set role authenticated;
select saf.expect(saf.try(format($q$insert into public.sa_root_access_grants(user_id, grant_method, reason) values (%L, 'grant', 'self-made root through the API')$q$, saf.u(3))) like 'permission denied%', 'authenticated cannot insert Root Access');
select saf.expect(saf.try(format($q$select public.sa_grant_root_access(%L, %L, 'direct rpc bypass attempt', null, null)$q$, saf.u(1), saf.u(3))) like 'permission denied%', 'authenticated cannot call the grant function');
reset role;
set role service_role;
select saf.expect(saf.try(format($q$insert into public.sa_root_access_grants(user_id, grant_method, reason) values (%L, 'grant', 'service role direct insert attempt')$q$, saf.u(3))) like 'permission denied%', 'service_role cannot insert directly');
select saf.expect(saf.try(format($q$select public.sa_bootstrap_root_access(%L, 'bootstrap through the server key')$q$, saf.u(3))) like 'permission denied%', 'service_role cannot bootstrap');
reset role;

-- ── No automatic conversion; nothing else changed ───────────────────────────────────────────────────────────────
select saf.expect(not exists (select 1 from public.sa_root_access_grants), 'the migration grants Root Access to nobody');
select saf.expect(not public.sa_actor_is_root(saf.u(1)), 'legacy Super Admin (level 1) is not Root');
select saf.expect(not exists (select * from saf.baseline except select * from saf.grid())
              and not exists (select * from saf.grid() except select * from saf.baseline), 'every decision, ceiling and dominance unchanged without Root Access');

-- ── Bootstrap ───────────────────────────────────────────────────────────────────────────────────────────────────
select saf.expect((saf.root_grant(saf.u(1), saf.u(6))->>'code') = 'root_authority_required', 'legacy Super Admin cannot grant Root Access');
select saf.expect((select count(*) from public.sa_access_change_log where action = 'root_access.grant_denied' and actor_id = saf.u(1)
                   and (details->>'actor_is_legacy_super_admin')::boolean and details->>'scope' = 'global') = 1, 'refusal logged (actor, target, legacy flag, scope)');
select saf.expect(not exists (select 1 from public.sa_root_access_grants), 'refusal wrote no grant');
select saf.as_api_user(saf.u(1));
select saf.expect(saf.try(format($q$select public.sa_bootstrap_root_access(%L, 'bootstrap during an API request')$q$, saf.u(2))) like 'root_bootstrap_owner_only%', 'bootstrap refuses API requests');
select saf.as_owner();
select saf.expect(saf.try(format($q$select public.sa_bootstrap_root_access(%L, 'Initial Root Administrator (inactive)')$q$, saf.u(11))) like 'root_target_inactive%', 'bootstrap: inactive target');
select saf.expect(saf.try(format($q$select public.sa_bootstrap_root_access(%L, 'Initial Root Administrator (manufacturer)')$q$, saf.u(8))) like 'root_target_not_internal%', 'bootstrap: manufacturer target');
select saf.expect(saf.try(format($q$select public.sa_bootstrap_root_access(%L, 'short')$q$, saf.u(2))) like 'root_reason_required%', 'bootstrap: reason required');
select saf.expect(public.sa_bootstrap_root_access(saf.u(2), 'Initial Root Administrator approved by the CTO, ticket SEC-100') is not null, 'owner bootstraps the first Root Administrator');
select saf.expect(public.sa_actor_is_root(saf.u(2)), 'u2 is Root');
select saf.expect((select actor_kind = 'system' and actor_id is null and target_user_id = saf.u(2) and details->>'grant_method' = 'bootstrap'
                   from public.sa_access_change_log where action = 'root_access.bootstrapped'), 'bootstrap audited');
select saf.expect(saf.try(format($q$select public.sa_bootstrap_root_access(%L, 'Second bootstrap while a root exists')$q$, saf.u(10))) like 'root_bootstrap_not_allowed%', 'bootstrap refused while a Root Administrator exists');

-- ── Grant: refusals (each logged) ───────────────────────────────────────────────────────────────────────────────
select saf.expect((saf.root_grant(saf.u(2), saf.u(2))->>'code') = 'root_self_grant_prohibited', 'no self-grant');
select saf.expect((saf.root_grant(saf.u(3), saf.u(6))->>'code') = 'root_authority_required', 'non-root administrator refused');
select saf.expect((saf.root_grant(saf.u(9), saf.u(6))->>'code') = 'root_authority_required', 'delegated S&A administrator refused');
select saf.expect((saf.root_grant(saf.u(2), saf.u(8))->>'code') = 'root_target_not_internal', 'manufacturer user refused');
select saf.expect((saf.root_grant(saf.u(2), saf.u(12))->>'code') = 'root_target_not_internal', 'shop staff refused');
select saf.expect((saf.root_grant(saf.u(2), saf.u(11))->>'code') = 'root_target_inactive', 'inactive account refused');
select saf.expect((saf.root_grant(saf.u(2), gen_random_uuid())->>'code') = 'root_target_not_found', 'unknown person refused');
select saf.expect((saf.root_grant(saf.u(2), saf.u(6), 'short')->>'code') = 'root_reason_required', 'reason required');
select saf.expect((saf.root_grant(saf.u(2), saf.u(6), p_until => now() + interval '5 minutes')->>'code') = 'root_expiry_invalid', 'expiry too soon');
select saf.expect((saf.root_grant('00000000-0000-0000-00ff-000000000001', saf.u(6))->>'code') = 'root_authority_required', 'forged actor refused');
select saf.expect((select actor_id is null and details->>'claimed_actor_id' = '00000000-0000-0000-00ff-000000000001'
                   from public.sa_access_change_log where action = 'root_access.grant_denied' and details ? 'claimed_actor_id'), 'forged actor logged without breaking the audit write');
select saf.expect(saf.audit('root_access.grant_denied') = 11, 'every refused grant logged');
select saf.expect((select count(*) from public.sa_root_access_grants) = 1, 'refusals wrote nothing');

-- ── Grant: success, idempotency ─────────────────────────────────────────────────────────────────────────────────
select saf.expect((saf.root_grant(saf.u(2), saf.u(6), p_key => '00000000-0000-0000-0009-000000000001')->>'ok')::boolean, 'Root Administrator grants Root Access');
select saf.expect((saf.root_grant(saf.u(2), saf.u(6), p_key => '00000000-0000-0000-0009-000000000001')->>'replayed')::boolean, 'retry with the same request key replays');
select saf.expect((saf.root_grant(saf.u(2), saf.u(10), p_key => '00000000-0000-0000-0009-000000000001')->>'code') = 'root_request_key_conflict', 'request key reused for another person refused');
select saf.expect((saf.root_grant(saf.u(2), saf.u(6))->>'code') = 'root_already_active', 'already Root');
select saf.expect((select count(*) from public.sa_root_access_grants where user_id = saf.u(6)) = 1, 'one grant row');
select saf.expect((select actor_id = saf.u(2) and target_user_id = saf.u(6) and reason like 'Root Access for platform%' and details->>'scope' = 'global'
                   from public.sa_access_change_log where action = 'root_access.granted'), 'grant audited (actor, target, reason, scope)');

-- ── Evaluation: every module, every organization, through every enforcement path ────────────────────────────────
select saf.expect((saf.decide(saf.u(6), k, o.id)->>'reason_code') = 'ALLOWED_BY_ROOT_ACCESS', format('Root: %s at %s', k, o.org_name))
  from unnest(array['finance.payment.approve', 'finance.journal.post', 'security.role.assign', 'security.access.view',
                    'security.emergency_access.grant', 'hr.employee.view']) k, public.organizations o;
select saf.expect((public.sa_evaluate_permission(saf.u(6), 'finance.payment.approve', '{}'::jsonb)->>'decision') = 'ALLOW', 'Root without organization context');
select saf.expect((saf.decide(saf.u(6), 'nonexistent.module.use', saf.o(1))->>'decision') = 'DENY', 'unknown permission key is not covered');
select saf.expect((saf.decide(saf.u(6), 'finance.payment.approve', gen_random_uuid())->>'decision') = 'DENY', 'forged organization id is not covered');
-- Future permissions: covered automatically while active; a deprecated key is not.
insert into public.sa_permissions(permission_key, module, resource, action, description, source, audit_sensitivity)
values ('future.module.use', 'future', 'module', 'use', 'A module added after Root Access was granted', 'new', 'ordinary');
select saf.expect((saf.decide(saf.u(6), 'future.module.use', saf.o(5))->>'reason_code') = 'ALLOWED_BY_ROOT_ACCESS', 'future permission covered without touching the grant');
select saf.expect((saf.decide(saf.u(3), 'future.module.use', saf.o(1))->>'decision') = 'DENY', 'future permission not given to anyone else');
update public.sa_permissions set status = 'deprecated' where permission_key = 'future.module.use';
select saf.expect((saf.decide(saf.u(6), 'future.module.use', saf.o(5))->>'decision') = 'DENY', 'deprecated permission not covered');
-- Everyone who is not Root decides exactly as before.
select saf.expect(not exists (select * from saf.baseline where user_id not in (saf.u(2), saf.u(6))
                              except select * from saf.grid() where user_id not in (saf.u(2), saf.u(6)))
              and not exists (select * from saf.grid() where user_id not in (saf.u(2), saf.u(6))
                              except select * from saf.baseline where user_id not in (saf.u(2), saf.u(6))), 'non-root decisions unchanged while Root Access exists');
-- RLS gate and RPC backstop: Root in enforced permissions only; Monitoring keeps the legacy answer (no escalation).
select saf.as_api_user(saf.u(6));
select saf.expect(public.sa_rls_gate('finance.payment.approve', saf.o(4), false), 'RLS gate: Root at a manufacturer (enforced permission)');
select saf.expect(not public.sa_rls_gate('hr.employee.view', saf.o(4), false), 'RLS gate: Monitoring permission keeps the legacy DENY for Root');
select saf.expect(public.sa_rls_gate('hr.employee.view', saf.o(4), true), 'RLS gate: Monitoring permission keeps the legacy ALLOW');
select saf.expect(saf.try(format($q$select public.sa_require_operation('finance.payment.approve', %L::jsonb, 'payment', 'p1')$q$, jsonb_build_object('organization_id', saf.o(6)))) = 'OK', 'RPC backstop: Root at a shop');
select saf.as_api_user(saf.u(3));
select saf.expect(saf.try(format($q$select public.sa_require_operation('finance.payment.approve', %L::jsonb, 'payment', 'p1')$q$, jsonb_build_object('organization_id', saf.o(6)))) like 'sa_authorization_required%', 'RPC backstop still refuses a non-root user');
select saf.expect(not public.sa_rls_gate('finance.payment.approve', saf.o(4), false), 'RLS gate still refuses a non-root user');
select saf.as_owner();
-- Governance assertion (mode-aware).
select saf.expect(saf.try(format($q$select public.sa_assert_actor_permission(%L, 'security.role.assign', %L::jsonb, false)$q$, saf.u(6), jsonb_build_object('organization_id', saf.o(5)))) = 'OK', 'governance: Root administers a distributor');
select saf.expect(saf.try(format($q$select public.sa_assert_actor_permission(%L, 'hr.employee.view', '{}'::jsonb, false)$q$, saf.u(6))) like 'sa_authorization_required%', 'governance: Monitoring permission follows the legacy answer');
-- Lists, directory, ceilings, target protection.
select saf.expect(cardinality(public.sa_readable_organizations(saf.u(6), 'finance.payment.approve')) = (select count(*) from public.organizations), 'list scope: every organization');
select saf.expect(cardinality(public.sa_readable_organizations(saf.u(6), 'nonexistent.module.use')) = 0, 'list scope: unknown permission none');
select saf.expect((select count(*) from public.sa_authorized_organizations(saf.u(6), 'security.access.view')) = (select count(*) from public.organizations), 'S&A directory: every organization, partners outside the HQ tree included');
select saf.expect(public.sa_actor_holds_permission(saf.u(6), 'finance.payment.approve', null) and public.sa_actor_holds_permission(saf.u(6), 'finance.payment.approve', saf.o(6)), 'grant ceiling counts Root');
select saf.expect(not public.sa_actor_holds_permission(saf.u(3), 'finance.payment.approve', null), 'grant ceiling unchanged for others');
select saf.expect(public.sa_actor_dominates(saf.u(6), saf.u(1)), 'Root may act on the legacy Super Admin');
select saf.expect(not public.sa_actor_dominates(saf.u(1), saf.u(6)) and not public.sa_actor_dominates(saf.u(9), saf.u(6)), 'non-root administrators cannot act on a Root Administrator');
select saf.expect(public.sa_actor_dominates(saf.u(2), saf.u(6)), 'Root Administrators are peers');
-- Root grants ordinary Group Policies in any organization; the same grant by a non-root is refused.
select saf.expect(saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], null, null, 'Root grants a policy at a warehouse')$q$,
  saf.u(6), saf.u(4), saf.role('saf-payer'), saf.o(2), saf.s(2))) = 'OK', 'Root grants a Group Policy at a warehouse');
select saf.expect(saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], null, null, 'Non-root tries the same grant')$q$,
  saf.u(3), saf.u(10), saf.role('saf-payer'), saf.o(1), saf.s(1))) <> 'OK', 'non-root cannot grant it');

-- ── Revocation ──────────────────────────────────────────────────────────────────────────────────────────────────
select saf.expect(saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], null, null, 'Standard policy that must survive revocation')$q$,
  saf.u(2), saf.u(6), saf.role('saf-payer'), saf.o(1), saf.s(1))) = 'OK', 'u6 also holds a standard Group Policy');
select saf.expect((saf.root_revoke(saf.u(6), saf.u(6))->>'code') = 'root_self_revoke_prohibited', 'no self-revoke');
select saf.expect((saf.root_revoke(saf.u(3), saf.u(6))->>'code') = 'root_authority_required', 'non-root cannot revoke');
select saf.expect((saf.root_revoke(saf.u(1), saf.u(6))->>'code') = 'root_authority_required', 'legacy Super Admin cannot revoke');
select saf.expect((saf.root_revoke(saf.u(2), saf.u(6), 'x')->>'code') = 'root_reason_required', 'revoke reason required');
select saf.expect((saf.root_revoke(saf.u(2), saf.u(10))->>'code') = 'root_not_active', 'nothing to revoke');
select saf.expect(saf.audit('root_access.revoke_denied') = 5, 'every refused revoke logged');
select saf.expect((saf.root_revoke(saf.u(2), saf.u(6))->>'ok')::boolean, 'Root Administrator revokes Root Access');
select saf.expect(not public.sa_actor_is_root(saf.u(6)), 'revoked immediately');
select saf.expect((saf.decide(saf.u(6), 'finance.payment.approve', saf.o(4))->>'decision') = 'DENY', 'no Root decision right after revocation');
select saf.expect((saf.decide(saf.u(6), 'finance.payment.approve', saf.o(1))->>'reason_code') = 'ALLOWED_BY_ASSIGNMENT', 'standard Group Policy preserved');
select saf.expect((select status = 'revoked' and revoked_by = saf.u(2) and revoke_reason like 'Root Access no longer%' from public.sa_root_access_grants where user_id = saf.u(6)), 'history row');
select saf.expect(saf.audit('root_access.revoked') = 1, 'revocation audited');
select saf.expect((saf.root_revoke(saf.u(2), saf.u(6))->>'code') = 'root_not_active', 'second revoke: nothing active');
-- Last Root Administrator: u2 is the only one and cannot remove itself.
select saf.expect(public.sa_active_root_count(null) = 1, 'one Root Administrator');
select saf.expect((saf.root_revoke(saf.u(2), saf.u(2))->>'code') = 'root_self_revoke_prohibited', 'the last Root Administrator cannot revoke itself');
select saf.expect(public.sa_actor_is_root(saf.u(2)), 'still Root');

-- ── Expiry ──────────────────────────────────────────────────────────────────────────────────────────────────────
-- Owner fixture for "time has passed": an active grant whose window already ended.
insert into public.sa_root_access_grants(user_id, status, grant_method, reason, granted_by, granted_at, effective_until)
values (saf.u(10), 'active', 'grant', 'Temporary Root Access for the migration window', saf.u(2), now() - interval '2 hours', now() - interval '1 minute');
select saf.expect(not public.sa_actor_is_root(saf.u(10)), 'elapsed Root Access ends at once');
select saf.expect((saf.decide(saf.u(10), 'finance.payment.approve', saf.o(4))->>'decision') = 'DENY', 'expired: falls back to standard permissions');
select saf.expect(public.sa_actor_dominates(saf.u(1), saf.u(10)), 'expired Root Access no longer protects the account');
select saf.expect((public.sa_governance_maintenance()->>'root_access_expired')::int = 1, 'maintenance marks it expired');
select saf.expect((select status = 'expired' and expired_at is not null from public.sa_root_access_grants where user_id = saf.u(10)), 'expired row');
select saf.expect(saf.audit('root_access.expired') = 1, 'expiry audited');
select saf.expect((public.sa_governance_maintenance()->>'root_access_expired')::int = 0, 'maintenance idempotent');
select saf.expect((saf.root_grant(saf.u(2), saf.u(10), p_until => now() + interval '2 hours')->>'ok')::boolean, 'temporary Root Access with an expiry');
select saf.expect(public.sa_actor_is_root(saf.u(10)) and (select effective_until is not null from public.sa_root_access_grants where user_id = saf.u(10) and status = 'active'), 'u10 Root until the expiry');

-- ── History is immutable, even for the owner ────────────────────────────────────────────────────────────────────
select saf.expect(saf.try(format($q$update public.sa_root_access_grants set reason = 'tampered reason text' where user_id = %L$q$, saf.u(2))) like 'sa_root_access_history_immutable%', 'reason immutable');
select saf.expect(saf.try(format($q$update public.sa_root_access_grants set effective_until = now() + interval '10 years' where user_id = %L and status = 'active'$q$, saf.u(10))) like 'sa_root_access_history_immutable%', 'expiry cannot be extended in place');
select saf.expect(saf.try(format($q$update public.sa_root_access_grants set status = 'active' where user_id = %L and status = 'revoked'$q$, saf.u(6))) like 'sa_root_access_status_transition_invalid%', 'revoked cannot be reactivated');
select saf.expect(saf.try(format($q$delete from public.sa_root_access_grants where user_id = %L$q$, saf.u(6))) like 'sa_root_access_history_immutable%', 'no delete');
select saf.expect(saf.try('truncate public.sa_root_access_grants') like 'sa_root_access_history_immutable%', 'no truncate');
