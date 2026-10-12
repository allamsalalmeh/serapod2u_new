-- 10 (continued). Validity and "explicitly revoked".
create table saf.t40 as select saf.grant_id(23, 32, 'employee-self-service', 1, 1, now() + interval '2 seconds') as expiring;
select pg_sleep(2.5);
-- A temporary grant whose original end has passed: never restored (Grant Policy instead).
select saf.expect(public.sa_policy_restore_blocker((select id from saf.t10)) = 'sa_restore_validity_expired'
  and saf.restore(1, (select id from saf.t10)) like 'sa_restore_validity_expired%', '10: an expired temporary grant is not restored');
-- Expired by maintenance (status revoked, no administrator revoke): not "explicitly revoked".
select public.sa_governance_maintenance();
select saf.expect((select status from public.sa_role_assignments where id = (select expiring from saf.t40)) = 'revoked', 'maintenance ended the expired grant');
select saf.expect(public.sa_policy_restore_blocker((select expiring from saf.t40)) = 'sa_restore_not_explicit_revoke'
  and saf.restore(1, (select expiring from saf.t40)) like 'sa_restore_not_explicit_revoke%', '10: an expired (not revoked) grant is not restored');

-- A revoke recorded BEFORE this migration (no previous_effective_until): the grant's own audit row decides.
do $t$ declare a uuid; b uuid; v_until timestamptz := date_trunc('second', now() + interval '5 days'); n public.sa_role_assignments; begin
  a := saf.grant_id(23, 6, 'warehouse-manager', 1, 1, v_until);
  perform saf.expect(saf.revoke(23, a) = 'OK', 'revoke');
  alter table public.sa_access_change_log disable trigger sa_access_change_log_append_only;
  update public.sa_access_change_log set details = details - 'previous_effective_until' - 'previous_effective_from'
  where entity_id = a::text and action = 'assignment.revoked';
  alter table public.sa_access_change_log enable trigger sa_access_change_log_append_only;
  perform saf.expect((select known and effective_until = v_until from public.sa_policy_restore_validity(a)), 'legacy revoke: validity from the grant audit row');
  perform saf.expect(saf.restore(1, a) = 'OK', 'legacy revoke restored');
  select * into n from public.sa_role_assignments where restored_from_assignment_id = a;
  perform saf.expect(n.effective_until = v_until, 'legacy revoke: original end date kept');
  -- No audit row for the grant at all: validity unknown, never guessed.
  b := saf.grant_id(23, 6, 'finance-viewer', 1, 1);
  perform saf.expect(saf.revoke(23, b) = 'OK', 'revoke');
  alter table public.sa_access_change_log disable trigger sa_access_change_log_append_only;
  update public.sa_access_change_log set details = details - 'previous_effective_until' - 'previous_effective_from' where entity_id = b::text and action = 'assignment.revoked';
  delete from public.sa_access_change_log where entity_id = b::text and action = 'assignment.granted';
  alter table public.sa_access_change_log enable trigger sa_access_change_log_append_only;
  perform saf.expect(public.sa_policy_restore_blocker(b) = 'sa_restore_validity_unknown', 'unknown validity is refused');
end $t$;

-- Status for the screen.
select saf.expect((select count(*) from public.sa_policy_restore_status(array[(select id from saf.t10), (select expiring from saf.t40), (select original from saf.t1)])) = 3
  and (select blocker from public.sa_policy_restore_status(array[(select id from saf.t10)])) = 'sa_restore_validity_expired', 'batch status for the screen');
select saf.expect(not has_function_privilege('authenticated', 'public.sa_restore_policy_grant(uuid,uuid)', 'execute')
  and not has_function_privilege('anon', 'public.sa_policy_restore_status(uuid[])', 'execute')
  and not has_function_privilege('authenticated', 'public.sa_assign_role_audited(uuid,uuid,uuid,uuid,uuid[],timestamptz,timestamptz,text,text,jsonb)', 'execute'),
  'restore functions are service_role only');
