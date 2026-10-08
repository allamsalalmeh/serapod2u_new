select saf.expect(not public.sa_actor_is_root(saf.u(6)) and public.sa_actor_is_root(saf.u(10)), 'after the race: u10 still Root, u6 revoked');
select saf.expect((select count(*) from public.sa_access_change_log where action = 'root_access.revoke_denied'
                   and details->>'code' = 'root_authority_required' and actor_id = saf.u(6) and target_user_id = saf.u(10)) = 1,
                  'losing session recorded as an unauthorized revoke attempt');
select saf.expect(public.sa_active_root_count(null) >= 1, 'never zero Root Administrators after a race');

-- Account deactivation ends Root Access at once; with no active Root Administrator left, the owner-only bootstrap is
-- the recovery path. Reactivating the account restores the (never revoked) grant.
select saf.expect((saf.root_revoke(saf.u(10), saf.u(2))->>'ok')::boolean, 'u10 revokes u2 (u10 remains)');
select saf.expect(public.sa_active_root_count(null) = 1, 'one Root Administrator left');
update public.users set is_active = false where id = saf.u(10);
select saf.expect(not public.sa_actor_is_root(saf.u(10)) and public.sa_active_root_count(null) = 0, 'deactivated account is not Root');
select saf.expect((saf.decide(saf.u(10), 'finance.payment.approve', saf.o(4))->>'reason_code') = 'ACCOUNT_INACTIVE', 'evaluator denies the deactivated Root Administrator');
select saf.expect(not public.sa_actor_dominates(saf.u(1), saf.u(10)), 'a deactivated Root Administrator stays protected from non-root administrators');
select saf.expect(public.sa_bootstrap_root_access(saf.u(3), 'Recovery: previous Root Administrator left the company (SEC-101)') is not null, 'recovery bootstrap');
select saf.expect(saf.audit('root_access.bootstrapped') = 2, 'recovery audited');
update public.users set is_active = true where id = saf.u(10);
select saf.expect(public.sa_active_root_count(null) = 2, 'reactivated account holds its grant again');
