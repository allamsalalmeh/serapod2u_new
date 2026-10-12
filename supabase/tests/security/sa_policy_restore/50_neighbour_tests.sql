-- The one-live-row model does not change neighbouring flows.
-- Automatic access an administrator revoked keeps its own path and is not offered here.
do $t$ declare a uuid; begin
  insert into public.sa_role_assignments(user_id, role_id, membership_id, status, source, assignment_reason)
  select saf.u(32), saf.role('finance-viewer'), m.id, 'active', 'derived', 'lifecycle (fixture)'
  from public.sa_organization_memberships m where m.user_id = saf.u(32) and m.organization_id = saf.o(1)
  on conflict do nothing returning id into a;
  if a is null then return; end if;
  insert into public.sa_assignment_scopes(assignment_id, scope_id) values (a, saf.s(1));
  perform saf.expect(saf.revoke(23, a) = 'OK', 'revoke automatic access');
  perform saf.expect(public.sa_policy_restore_blocker(a) = 'sa_restore_automatic', 'automatic access is restored by its own path');
  perform saf.expect(a in (select assignment_id from public.sa_restorable_assignments()), 'still offered as automatic access');
end $t$;
-- Lifecycle: with a revoked history row and a live row, the live row is the one maintained.
do $t$ declare r uuid; l uuid; got uuid; m uuid; begin
  select id into m from public.sa_organization_memberships where user_id = saf.u(6) and organization_id = saf.o(1);
  r := saf.grant_id(23, 6, 'employee-self-service', 1, 1);
  perform saf.expect(saf.revoke(23, r) = 'OK', 'revoke ESS');
  insert into public.sa_role_assignments(user_id, role_id, membership_id, status, source, assignment_reason, created_at)
  values (saf.u(6), saf.role('employee-self-service'), m, 'active', 'derived', 'lifecycle (fixture)', now() + interval '1 second') returning id into l;
  got := public.sa_ensure_derived_assignment(saf.u(6), saf.role('employee-self-service'), m, saf.s(1), null, 'Lifecycle: employee self-service baseline');
  perform saf.expect(got = l, 'lifecycle maintains the live row, not the revoked history row');
  perform saf.expect((select status from public.sa_role_assignments where id = r) = 'revoked', 'the revoked row is never resurrected');
end $t$;
-- An administrator-revoked row with no live row: the lifecycle still never resurrects it.
do $t$ declare r uuid; m uuid; got uuid; begin
  select id into m from public.sa_organization_memberships where user_id = saf.u(6) and organization_id = saf.o(1);
  r := saf.grant_id(23, 6, 'warehouse-operator', 1, 1);
  perform saf.expect(saf.revoke(23, r) = 'OK', 'revoke');
  got := public.sa_ensure_derived_assignment(saf.u(6), saf.role('warehouse-operator'), m, saf.s(1), null, 'lifecycle');
  perform saf.expect(got = r and (select status from public.sa_role_assignments where id = r) = 'revoked', 'administrator revoke stays final');
end $t$;
-- Ordinary grant duplicate rule unchanged.
select saf.expect(saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], null, null, null)$q$, saf.u(23), saf.u(6), saf.role('sapr-custom'), saf.o(1), saf.s(1))) like 'sa_role_already_held%', 'ordinary duplicate grant still refused');
