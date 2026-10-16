-- Two active Root Administrators (u6, u10) for the mutual-revocation race.
select saf.expect((saf.root_grant(saf.u(2), saf.u(6), 'Concurrency fixture: u6 Root Access again')->>'ok')::boolean, 'u6 root for the race');
select saf.expect(public.sa_actor_is_root(saf.u(6)) and public.sa_actor_is_root(saf.u(10)), 'two roots before the race');
