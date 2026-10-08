-- After 20261027100000 (applied twice). Root Administrators now: u3 (recovery bootstrap) and u10. u2 is NOT Root but holds
-- platform.identity.disable / identity_access.manage / identity.delete for HQ (Legacy Retired: S&A decides).
select saf.expect(public.sa_actor_is_root(saf.u(3)) and public.sa_actor_is_root(saf.u(10)) and not public.sa_actor_is_root(saf.u(2)), 'roots: u3, u10; u2 is not Root');
-- Privileges: the helper is internal; the functions stay server-only.
select saf.expect(not has_function_privilege(r, 'public.identity_root_target_refusal(uuid,uuid)', 'EXECUTE'), format('%s cannot execute the Root target helper', r))
  from unnest(array['anon','authenticated','service_role']) r;
select saf.expect(not has_function_privilege(r, f, 'EXECUTE'), format('%s cannot execute %s', r, f))
  from unnest(array['anon','authenticated']) r,
       unnest(array['public.identity_set_account_status(uuid,uuid,text,text)', 'public.identity_admin_update_access(uuid,uuid,text,uuid,boolean,text)']) f;
select saf.expect(has_function_privilege('service_role', 'public.identity_set_account_status(uuid,uuid,text,text)', 'EXECUTE'), 'server keeps the lifecycle function');

-- ── Non-Root administrator: ordinary targets unchanged, Root targets refused ─────────────────────────────────────
select saf.expect(saf.set_status(saf.u(2), saf.u(6), 'SUSPENDED') = 'OK', 'non-root identity admin suspends an ordinary account');
select saf.expect(saf.set_status(saf.u(2), saf.u(6), 'ACTIVE') = 'OK', 'and reactivates it');
select saf.expect(saf.set_status(saf.u(2), saf.u(10), 'SUSPENDED') = 'identity_root_target_protected', 'non-root cannot suspend a Root Administrator');
select saf.expect(saf.set_status(saf.u(2), saf.u(10), 'DISABLED') = 'identity_root_target_protected', 'non-root cannot disable a Root Administrator');
select saf.expect(saf.set_status(saf.u(2), saf.u(3), 'ARCHIVED') = 'identity_root_target_protected', 'non-root cannot archive a Root Administrator');
select saf.expect(public.sa_actor_is_root(saf.u(10)) and public.sa_actor_is_root(saf.u(3)), 'both Root Administrators untouched');
select saf.expect(saf.set_access(saf.u(2), saf.u(10), 'MFG_USER', null, false) = 'identity_root_target_protected', 'non-root cannot change a Root Administrator''s role');
select saf.expect(saf.set_access(saf.u(2), saf.u(10), null, saf.o(4), true) = 'identity_root_target_protected', 'non-root cannot move a Root Administrator');
select saf.expect(saf.set_access(saf.u(2), saf.u(6), 'WH_MGR', null, false) = 'identity_role_grant_not_allowed', 'non-root stays bound by the legacy role ceiling');
select saf.expect(saf.set_status(saf.u(8), saf.u(6), 'SUSPENDED') = 'sa_authorization_required', 'a person without the permission is refused (unchanged)');
select saf.expect(saf.set_status(saf.u(2), saf.u(2), 'SUSPENDED') = 'identity_self_status_change_prohibited', 'self change still prohibited');

-- ── Root Administrator: independent of the legacy level, still audited ──────────────────────────────────────────
select saf.expect(saf.set_access(saf.u(3), saf.u(6), 'WH_MGR', null, false) = 'OK', 'Root changes a role regardless of the legacy ceiling');
select saf.expect((select role_code from public.users where id = saf.u(6)) = 'WH_MGR', 'role changed');
select saf.expect((select (details->>'root_actor')::boolean from public.sa_access_change_log where action = 'identity.access_changed'
                   and target_user_id = saf.u(6) order by occurred_at desc, id desc limit 1), 'change logged with the Root actor flag');
select saf.expect(saf.set_access(saf.u(3), saf.u(10), null, saf.o(4), true) = 'identity_root_target_org_locked', 'a Root Administrator is not moved out while Root is active');
select saf.expect(saf.set_access(saf.u(3), saf.u(10), 'WH_MGR', null, false) = 'OK', 'another Root may change a Root Administrator''s legacy role');
select saf.expect(public.sa_actor_is_root(saf.u(10)), 'Root Access does not depend on the legacy role');
select saf.expect(saf.set_status(saf.u(3), saf.u(10), 'SUSPENDED') = 'OK', 'Root suspends another Root Administrator (one remains)');
select saf.expect(not public.sa_actor_is_root(saf.u(10)) and public.sa_active_root_count(null) = 1, 'suspension ends Root in effect; u3 remains');
select saf.expect(saf.set_status(saf.u(2), saf.u(3), 'SUSPENDED') = 'identity_root_target_protected', 'the last Root Administrator cannot be suspended by a non-root');
select saf.expect(saf.set_status(saf.u(2), saf.u(10), 'ACTIVE') = 'identity_root_target_protected', 'a suspended Root account stays protected (reactivation is Root-only)');
select saf.expect(saf.set_status(saf.u(3), saf.u(10), 'ACTIVE') = 'OK', 'Root reactivates the other Root Administrator');
select saf.expect(public.sa_active_root_count(null) = 2, 'two Root Administrators again');
-- Revoked Root: an ordinary target again (u6 lost Root in the race).
select saf.expect(not public.sa_actor_is_root(saf.u(6)) and saf.set_status(saf.u(2), saf.u(6), 'SUSPENDED') = 'OK', 'revoked Root account is an ordinary target');
select saf.expect(saf.set_status(saf.u(2), saf.u(6), 'ACTIVE') = 'OK', 'reactivated');
