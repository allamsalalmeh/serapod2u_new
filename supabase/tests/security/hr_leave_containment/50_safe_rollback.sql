-- Rollback posture (owner default 8): the SAFE rollback documented in the migration header relaxes only the authority
-- source (legacy compatibility counts again); self-approval, on-behalf submission and organization-wide reads stay closed.
-- Re-applying the migration restores the strict rule. Runs in a transaction that is rolled back.
begin;
create or replace function public.hr_leave_actor_has_explicit(p_permission text, p_context jsonb)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $f$
  select auth.uid() is not null
     and exists (select 1 from public.users u where u.id = auth.uid() and u.is_active is true
                 and coalesce(u.account_status, 'ACTIVE') <> 'ARCHIVED')
     and (public.sa_evaluate_permission_core(auth.uid(), p_permission, p_context, false, false)->>'decision') = 'ALLOW'
$f$;
do $t$
declare r text;
begin
  r := hlc.run_as(1, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(1)));
  perform hlc.expect(r like '%hr_leave_self_approval%', 'B1 safe rollback: self-approval still refused (' || r || ')');
  r := hlc.run_as(1, format($q$insert into public.hr_leave_requests(organization_id, employee_id, leave_type_id, start_date, end_date, status)
                               values (%L, %L, %L, current_date, current_date, 'pending')$q$, hlc.o(1), hlc.u(2), hlc.x(401)));
  perform hlc.expect(r like '%hr_leave_on_behalf_refused%', 'B2 safe rollback: on-behalf submission still refused (' || r || ')');
  perform hlc.expect(hlc.val_as(1, format('select count(*) from public.hr_leave_requests where employee_id <> %L', hlc.u(1)))::int = 0,
                     'B3 safe rollback: employees still see only their own leave');
  perform hlc.expect(hlc.val_as(11, format('select count(*) from public.hr_leave_requests where organization_id = %L', hlc.o(1)))::int = 0,
                     'B4 safe rollback: no cross-company visibility');
  r := hlc.run_as(8, format($q$update public.hr_leave_requests set status = 'approved' where id = %L$q$, hlc.x(2)));
  perform hlc.expect(r = 'OK:1', 'B5 safe rollback: legacy-compatibility holder can approve again (the only relaxation) (' || r || ')');
end $t$;
rollback;
