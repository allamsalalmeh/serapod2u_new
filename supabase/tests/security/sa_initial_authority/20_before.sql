-- Negative control: the extra restriction exists today.
select saf.expect(saf.try(format($q$select public.sa_assign_initial_profiles(%L, %L, %L, jsonb_build_array(jsonb_build_object('role_id', %L, 'scope_ids', jsonb_build_array(%L))), false)$q$, saf.u(1), saf.u(6), saf.o(1), saf.role('finance-full-access'), saf.s(1))) like 'sa_profile_sensitive_not_initial%', 'before: sensitive Full Access is refused at provisioning');
select saf.expect(not exists (select 1 from pg_proc where proname = 'sa_actor_may_assign_profile'), 'before: probe function does not exist (the app keeps offering nothing sensitive)');
-- Grant Policy for the same policy, same actor, same organization already works (the inconsistency this migration removes).
select saf.expect(saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], now(), null, 'grant policy control')$q$, saf.u(1), saf.u(3), saf.role('finance-full-access'), saf.o(1), saf.s(1))) = 'OK', 'before: Grant Policy allows the same sensitive policy for the same actor and organization');
-- Rewind the control grant so the parity suite starts from a clean person.
delete from public.sa_assignment_scopes where assignment_id in (select id from public.sa_role_assignments where user_id = saf.u(3));
delete from public.sa_role_assignments where user_id = saf.u(3);
