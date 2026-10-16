-- Before 20261020100000: sa_assign_role still requires text (what the application's one retry handles).
select saf.expect(saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], now(), null, null)$q$, saf.u(1), saf.u(6), saf.role('supply-chain-full-access'), saf.o(1), saf.s(1))) = 'sa_reason_required', 'before: a grant without a reason is refused');
select saf.expect((select count(*) from public.sa_role_assignments where user_id = saf.u(6)) = 0, 'before: and nothing was written');
