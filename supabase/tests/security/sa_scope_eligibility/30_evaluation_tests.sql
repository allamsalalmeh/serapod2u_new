-- Evaluation under the REAL evaluator (public.sa_evaluate_permission), unchanged by the migration.
create function sse.verdict(p_user uuid, p_ctx jsonb) returns text language sql stable as $$
  select (public.sa_evaluate_permission(p_user, 'inventory.stock_count.verify', p_ctx, false))->>'decision' $$;
create function sse.reason(p_user uuid, p_ctx jsonb) returns text language sql stable as $$
  select (public.sa_evaluate_permission(p_user, 'inventory.stock_count.verify', p_ctx, false))->>'reason_code' $$;
create function sse.wh(p_id uuid) returns jsonb language sql immutable as $$ select jsonb_build_object('organization_id', p_id, 'warehouse_id', p_id) $$;

do $t$
declare links_before bigint;
begin
  -- The HQ person now holds the stock policy at the HQ scope (+ Alma) from the grant test; make the HQ scope the only link.
  perform sse.expect(sse.verdict(sse.u(2), sse.wh(sse.o(2))) = 'ALLOW', 'HQ scope covers Balakong');
  perform sse.expect(sse.verdict(sse.u(2), sse.wh(sse.o(3))) = 'ALLOW', 'HQ scope covers Alma');
  perform sse.expect(sse.verdict(sse.u(2), jsonb_build_object('organization_id', sse.o(1))) = 'ALLOW', 'HQ scope covers HQ data');
  perform sse.expect(sse.verdict(sse.u(2), sse.wh(sse.o(8))) = 'DENY', 'HQ scope does not cover another HQ''s warehouse (Zeta)');

  -- A warehouse attached LATER is covered with no new grant (dynamic via the parent relationship).
  links_before := (select count(*) from public.sa_assignment_scopes);
  perform sse.expect(sse.verdict(sse.u(2), sse.wh(sse.o(9))) = 'DENY', 'an unattached warehouse is not covered');
  update public.organizations set parent_org_id = sse.o(1) where id = sse.o(9);
  perform sse.expect(sse.verdict(sse.u(2), sse.wh(sse.o(9))) = 'ALLOW', 'Newco is covered the moment it is attached to the HQ');
  perform sse.expect((select count(*) from public.sa_assignment_scopes) = links_before, 'no grant was copied to the new warehouse');
  -- Moved to another HQ: coverage follows the relationship.
  update public.organizations set parent_org_id = sse.o(7) where id = sse.o(9);
  perform sse.expect(sse.verdict(sse.u(2), sse.wh(sse.o(9))) = 'DENY', 'a warehouse moved to another HQ is no longer covered');
  update public.organizations set parent_org_id = null where id = sse.o(9);
end $t$;

-- Balakong-only (warehouse scope) assignment: a second HQ-membership person.
do $t$
declare mem uuid;
begin
  insert into auth.users(id, email) values (sse.u(6), 'u6@dev.com');
  insert into public.users(id, email, full_name, role_code, organization_id, is_active) values (sse.u(6),'u6@dev.com','Balakong Only','HQ_MGR',sse.o(1),true);
  insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status) values (sse.u(6), sse.o(1), 'employee', true, 'active') returning id into mem;
  perform public.sa_create_assignment_internal(sse.u(1), sse.u(6), sse.r(1), sse.o(1), array[sse.s(2)], null, null, 'balakong only', 'manual');
  perform sse.expect(sse.verdict(sse.u(6), sse.wh(sse.o(2))) = 'ALLOW', 'Balakong-only reaches Balakong');
  perform sse.expect(sse.verdict(sse.u(6), sse.wh(sse.o(3))) = 'DENY', 'Balakong-only cannot reach Alma');
  perform sse.expect(sse.verdict(sse.u(6), jsonb_build_object('organization_id', sse.o(1), 'warehouse_id', sse.o(3))) = 'DENY', 'Balakong-only cannot reach Alma even with an HQ organization context');
  perform sse.expect(sse.verdict(sse.u(6), jsonb_build_object('organization_id', sse.o(1))) = 'DENY' and sse.reason(sse.u(6), jsonb_build_object('organization_id', sse.o(1))) = 'MISSING_CONTEXT',
    'a warehouse scope never authorizes an organization-wide operation (no warehouse in the resource → missing context, deny)');
  perform sse.expect(sse.verdict(sse.u(6), jsonb_build_object('organization_id', sse.o(2))) = 'DENY', 'warehouse organization without a warehouse id is still not a warehouse-scoped match');
end $t$;

-- Cross-party order workflow context (documented current behavior, unchanged):
--  * an HQ-owned order is evaluated in the HQ organization context: the HQ-scope holder is allowed;
--  * the distributor's own scope never reaches the HQ;
--  * an HQ-scope holder is allowed when a route supplies the DISTRIBUTOR as the resource organization (descendant rule of the
--    evaluator, mirrors can_access_org). Narrowing this is a business decision, not made here.
do $t$
begin
  perform sse.expect(sse.verdict(sse.u(2), jsonb_build_object('organization_id', sse.o(1))) = 'ALLOW', 'HQ-owned order context: HQ-scope holder allowed');
  perform sse.expect(sse.verdict(sse.u(4), jsonb_build_object('organization_id', sse.o(1))) = 'DENY', 'a distributor-scoped person does not reach HQ-owned data');
  perform sse.expect(sse.verdict(sse.u(2), jsonb_build_object('organization_id', sse.o(4))) = 'ALLOW', 'CURRENT behavior: HQ scope reaches a descendant partner when the route supplies that partner as the resource organization');
end $t$;
