select saf.expect(public.sa_active_root_count(null) = 1, 'mutual deactivation: exactly one Root Administrator remains');
select saf.expect(public.sa_actor_is_root(saf.u(3)) and not public.sa_actor_is_root(saf.u(10)), 'session A (u3) won');
