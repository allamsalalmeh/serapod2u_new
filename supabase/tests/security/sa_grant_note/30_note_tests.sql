-- After 20261020100000. Actors: u1 legacy Super Admin | u2 delegated S&A admin (Security & Access Full Access, HQ) after bootstrap
-- u3 plain HQ member (no authority) | u5 narrow admin (assign-only, Balakong) | u6, u9 recipients | u7 payment approver.
select public.sa_assign_role(saf.u(1), saf.u(2), saf.role('security-access-full-access'), saf.o(1), array[saf.s(1)], now(), null, 'Bootstrap delegated security administrator');
select public.sa_assign_role(saf.u(1), saf.u(5), '00000000-0000-0000-0005-000000000001', saf.o(2), array[saf.s(2)], now(), null, 'Balakong-only access administrator');
select public.sa_assign_role(saf.u(1), saf.u(7), '00000000-0000-0000-0005-000000000002', saf.o(1), array[saf.s(1)], now(), null, null);
update public.sa_settings set setting_value = 'true'::jsonb where setting_key = 'security_access.delegated_administration';

create function saf.grant(actor int, target int, role_key text, org int, scope int, note text) returns text language sql as $$
  select saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], now(), null, %L)$q$, saf.u(actor), saf.u(target), saf.role(role_key), saf.o(org), saf.s(scope), note)) $$;
create function saf.last_grant(target int, role_key text) returns public.sa_access_change_log language sql stable as $$
  select l.* from public.sa_access_change_log l where l.action = 'assignment.granted' and l.target_user_id = saf.u(target)
    and l.details->>'role_id' = saf.role(role_key)::text order by l.occurred_at desc, l.id desc limit 1 $$;
create function saf.n_assign(target int) returns bigint language sql stable as $$ select count(*) from public.sa_role_assignments where user_id = saf.u(target) $$;

-- 1. Authorized grant to another person WITHOUT a note
select saf.expect(saf.grant(1, 6, 'supply-chain-full-access', 1, 1, null) = 'OK', 'Super Admin grants an eligible policy to another person without a note');
do $t$ declare l public.sa_access_change_log := saf.last_grant(6, 'supply-chain-full-access'); v_name text := (select name from public.sa_business_roles where role_key = 'supply-chain-full-access'); begin
  perform saf.expect(l.reason = format('Group Policy "%s" granted to u6@dev.com in HQ (scope: HQ; no end date). No note provided.', v_name), 'audit text is an accurate generated description: ' || coalesce(l.reason, '<null>'));
  perform saf.expect(l.details->'note' = 'null'::jsonb and (l.details->>'reason_generated')::boolean, 'details say no note was given (reason_generated)');
  perform saf.expect(l.actor_id = saf.u(1) and l.actor_kind = 'user' and l.target_user_id = saf.u(6) and l.occurred_at is not null, 'actor, target and time recorded');
  perform saf.expect(l.details->>'organization_id' = saf.o(1)::text and l.details->'scope_ids' = jsonb_build_array(saf.s(1)) and l.details ? 'effective_until' and l.details->>'source' = 'manual', 'organization, policy, scope, validity and source recorded');
  perform saf.expect((select assignment_reason from public.sa_role_assignments where user_id = saf.u(6) and role_id = saf.role('supply-chain-full-access')) = l.reason, 'the assignment carries the same text');
end $t$;
select saf.expect(saf.grant(1, 6, 'customer-growth-full-access', 1, 1, '   ') = 'OK', 'grant with a blank note');
select saf.expect((saf.last_grant(6, 'customer-growth-full-access')).details->>'reason_generated' = 'true', 'a blank note is no note');

-- 2. An optional note is recorded as the administrator's note
select saf.expect(saf.grant(1, 9, 'supply-chain-full-access', 1, 1, '  Ticket SA-42  ') = 'OK', 'grant with a note');
select saf.expect((saf.last_grant(9, 'supply-chain-full-access')).reason = 'Ticket SA-42'
  and (saf.last_grant(9, 'supply-chain-full-access')).details->>'note' = 'Ticket SA-42'
  and (saf.last_grant(9, 'supply-chain-full-access')).details->>'reason_generated' = 'false', 'note trimmed, recorded and flagged as a user note');
select saf.expect(saf.grant(1, 9, 'customer-growth-full-access', 1, 1, repeat('x', 501)) = 'sa_note_too_long' and saf.n_assign(9) = 1, 'a note over 500 characters is refused and writes nothing');
-- temporary access: validity in the description and the details
select public.sa_assign_role(saf.u(1), saf.u(9), saf.role('customer-growth-full-access'), saf.o(1), array[saf.s(1)], now(), timestamptz '2099-03-04 05:06:00+00', null);
select saf.expect((saf.last_grant(9, 'customer-growth-full-access')).reason like '%; until 2099-03-04 05:06 UTC). No note provided.'
  and ((saf.last_grant(9, 'customer-growth-full-access')).details->>'effective_until')::timestamptz = timestamptz '2099-03-04 05:06:00+00', 'temporary access: end date in description and details');

-- 3. Genuine restrictions are unchanged (with or without a note); a refusal writes nothing
create temp table saf_before as select (select count(*) from public.sa_access_change_log where action = 'assignment.granted') n;
select saf.expect(saf.grant(1, 1, 'supply-chain-full-access', 1, 1, null) = 'sa_self_assignment_prohibited', 'self-grant stays prohibited (Super Admin included)');
select saf.expect(saf.grant(2, 2, 'supply-chain-full-access', 1, 1, 'with a note') = 'sa_self_assignment_prohibited', 'self-grant with a note stays prohibited');
select saf.expect(saf.grant(3, 3, 'supply-chain-full-access', 1, 1, null) like 'sa_self_assignment_prohibited%' and saf.grant(3, 6, 'finance-full-access', 1, 1, null) = 'sa_authorization_required', 'an actor without authority is refused');
select saf.expect(saf.grant(5, 6, 'finance-full-access', 1, 1, null) = 'sa_authorization_required', 'cross-organization: a Balakong-only administrator cannot grant in HQ');
select saf.expect(saf.grant(2, 3, 'finance-full-access', 1, 1, null) like 'sa_grant_beyond_authority%', 'privileged policy: the delegated admin cannot grant sensitive permissions it does not hold');
update public.sa_sod_rules set enforcement = 'enforce' where rule_key = 'security-admin-vs-payment-approval';
select saf.expect(saf.grant(2, 7, 'saf-assign-only', 1, 1, null) like 'sod_violation%', 'separation of duties still blocks a note-less grant');
update public.sa_sod_rules set enforcement = 'monitor' where rule_key = 'security-admin-vs-payment-approval';
select saf.expect(saf.grant(1, 6, 'supply-chain-full-access', 1, 1, null) = 'sa_role_already_held', 'duplicate grant refused');
select saf.expect(saf.n_assign(3) = 0 and saf.n_assign(7) = 1 and (select count(*) from public.sa_role_assignments where user_id = saf.u(6)) = 2, 'refused grants left no assignment behind');
select saf.expect((select count(*) from public.sa_access_change_log where action = 'assignment.granted') = (select n from saf_before), 'refused grants left no audit row (the transaction rolled back)');
select saf.expect(saf.grant(2, 3, 'supply-chain-full-access', 1, 1, null) = 'OK', 'the delegated admin grants a non-sensitive policy without a note');

-- 4. Other callers of the assignment helper are unchanged
select public.sa_create_assignment_internal(null, saf.u(4), saf.role('supply-chain-full-access'), saf.o(2), array[saf.s(2)], null, null, 'lifecycle sync', 'derived');
select saf.expect((saf.last_grant(4, 'supply-chain-full-access')).reason = 'lifecycle sync' and not ((saf.last_grant(4, 'supply-chain-full-access')).details ? 'note')
  and (saf.last_grant(4, 'supply-chain-full-access')).actor_kind = 'system', 'lifecycle callers keep their reason and details shape');
select saf.expect(saf.try(format($q$select public.sa_create_assignment_internal(%L, %L, %L, %L, array[%L]::uuid[], null, null, 'x', 'manual')$q$, saf.u(1), saf.u(3), saf.role('customer-growth-full-access'), saf.o(1), saf.s(1))) = 'OK', '9-argument helper still resolves (no ambiguous overload)');
select saf.expect(not has_function_privilege('authenticated', 'public.sa_create_assignment_internal_audited(uuid,uuid,uuid,uuid,uuid[],timestamptz,timestamptz,text,text,jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.sa_grant_description(uuid,uuid,uuid,uuid[],timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.sa_assign_role(uuid,uuid,uuid,uuid,uuid[],timestamptz,timestamptz,text)', 'execute'), 'no new function is reachable by anon / authenticated');
