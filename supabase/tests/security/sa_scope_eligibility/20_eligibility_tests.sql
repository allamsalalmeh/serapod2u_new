-- 1. Eligibility rule (public.sa_scope_eligible_for_membership), the SQL twin of scope-eligibility.ts.
do $t$
declare e boolean;
begin
  -- HQ recipient: the HQ and its own warehouses only.
  perform sse.expect(public.sa_scope_eligible_for_membership(sse.o(1), sse.s(1)), 'HQ recipient may receive the HQ scope');
  perform sse.expect(public.sa_scope_eligible_for_membership(sse.o(1), sse.s(2)), 'HQ recipient may receive Balakong (warehouse scope)');
  perform sse.expect(public.sa_scope_eligible_for_membership(sse.o(1), sse.s(3)), 'HQ recipient may receive Alma');
  perform sse.expect(public.sa_scope_eligible_for_membership(sse.o(1), sse.s(12)), 'the legacy organization duplicate of a warehouse stays valid (never rewritten)');
  perform sse.expect(not public.sa_scope_eligible_for_membership(sse.o(1), sse.s(4)), 'HQ recipient never receives a Distributor scope');
  perform sse.expect(not public.sa_scope_eligible_for_membership(sse.o(1), sse.s(5)), 'HQ recipient never receives a Shop scope');
  perform sse.expect(not public.sa_scope_eligible_for_membership(sse.o(1), sse.s(6)), 'HQ recipient never receives a Manufacturer scope');
  perform sse.expect(not public.sa_scope_eligible_for_membership(sse.o(1), sse.s(7)), 'HQ recipient never receives another HQ');
  perform sse.expect(not public.sa_scope_eligible_for_membership(sse.o(1), sse.s(8)), 'HQ recipient never receives another HQ''s warehouse');
  perform sse.expect(not public.sa_scope_eligible_for_membership(sse.o(1), sse.s(9)), 'a warehouse not attached to this HQ is not offered');
  perform sse.expect(public.sa_scope_eligible_for_membership(sse.o(1), sse.s(10)), 'non-structural typed scopes keep their own rules');
  perform sse.expect(not public.sa_scope_eligible_for_membership(sse.o(1), gen_random_uuid()), 'unknown scope is not eligible');
  -- Warehouse recipient: itself only.
  perform sse.expect(public.sa_scope_eligible_for_membership(sse.o(2), sse.s(2)), 'warehouse recipient: its own warehouse');
  perform sse.expect(not public.sa_scope_eligible_for_membership(sse.o(2), sse.s(3)), 'warehouse recipient: not another warehouse');
  perform sse.expect(not public.sa_scope_eligible_for_membership(sse.o(2), sse.s(1)), 'warehouse recipient: not the HQ');
  -- Partner recipient: its own organization and beneath it, nothing above or beside.
  perform sse.expect(public.sa_scope_eligible_for_membership(sse.o(4), sse.s(4)), 'distributor: own organization');
  perform sse.expect(public.sa_scope_eligible_for_membership(sse.o(4), sse.s(5)), 'distributor: shop beneath it (existing hierarchy, no new rule)');
  perform sse.expect(not public.sa_scope_eligible_for_membership(sse.o(4), sse.s(1)), 'distributor: not the HQ');
  perform sse.expect(not public.sa_scope_eligible_for_membership(sse.o(4), sse.s(6)), 'distributor: not a sibling manufacturer');
end $t$;

-- 2. The grant-time trigger (real sa_create_assignment_internal path, source manual).
do $t$
declare r text;
begin
  r := sse.try(format('select public.sa_create_assignment_internal(%L,%L,%L,%L,array[%L]::uuid[],null,null,%L,%L)', sse.u(1), sse.u(2), sse.r(1), sse.o(1), sse.s(4), 'x', 'manual'));
  perform sse.expect(r like '%sa_scope_not_eligible%', 'manual grant of a Distributor scope to an HQ person is refused: ' || r);
  r := sse.try(format('select public.sa_create_assignment_internal(%L,%L,%L,%L,array[%L]::uuid[],null,null,%L,%L)', sse.u(1), sse.u(2), sse.r(1), sse.o(1), sse.s(7), 'x', 'access_request'));
  perform sse.expect(r like '%sa_scope_outside_membership%', 'another HQ is already outside the membership subtree (existing rule): ' || r);
  r := sse.try(format('select public.sa_create_assignment_internal(%L,%L,%L,%L,array[%L]::uuid[],null,null,%L,%L)', sse.u(1), sse.u(2), sse.r(1), sse.o(1), sse.s(6), 'x', 'access_request'));
  perform sse.expect(r like '%sa_scope_not_eligible%', 'access-request grant of a Manufacturer scope to an HQ person is refused: ' || r);
  perform sse.expect((select count(*) from public.sa_assignment_scopes where assignment_id <> sse.r(100)) = 0, 'a refused grant leaves nothing behind');
  r := sse.try(format('select public.sa_create_assignment_internal(%L,%L,%L,%L,array[%L, %L]::uuid[],null,null,%L,%L)', sse.u(1), sse.u(2), sse.r(1), sse.o(1), sse.s(1), sse.s(3), 'x', 'manual'));
  perform sse.expect(r = 'OK', 'HQ scope together with Alma is accepted: ' || r);
  -- Automatic access is not an administrator grant: the trigger does not judge it.
  insert into public.sa_role_assignments(id, user_id, role_id, membership_id, status, source)
    select sse.r(101), sse.u(4), sse.r(1), m.id, 'active', 'derived' from public.sa_organization_memberships m where m.user_id = sse.u(4);
  r := sse.try(format('insert into public.sa_assignment_scopes(assignment_id, scope_id) values (%L, %L)', sse.r(101), sse.s(1)));
  perform sse.expect(r = 'OK', 'derived (automatic) access is untouched by the guard: ' || r);
end $t$;

-- 3. Existing grants are unchanged and merely reported.
do $t$
begin
  perform sse.expect((select count(*) from public.sa_role_assignments where id = sse.r(100)) = 1, 'the pre-existing assignment is still there');
  perform sse.expect((select count(*) from public.sa_assignment_scopes where assignment_id = sse.r(100) and scope_id = sse.s(4)) = 1, 'the pre-existing Distributor scope link is still there');
  perform sse.expect((select count(*) from public.sa_scope_definitions) = (select defs from sse.before_counts), 'no scope definition was created or deleted');
  perform sse.expect(exists (select 1 from public.sa_scope_eligibility_report() where assignment_id = sse.r(100) and scope_org_type = 'DIST'), 'the report lists the HQ-person / Distributor-scope grant');
  perform sse.expect(not exists (select 1 from public.sa_scope_eligibility_report() where scope_org = sse.o(3)), 'eligible grants (HQ + Alma) are not reported');
end $t$;
