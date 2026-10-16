-- After the parity migration. Actors: u1 legacy Super Admin | u2 delegated S&A admin (Security & Access Full Access, HQ) after bootstrap
-- u5 narrow admin (assign-only, Balakong) | u3, u6 recipients | u8 manufacturer user.
select public.sa_assign_role(saf.u(1), saf.u(2), saf.role('security-access-full-access'), saf.o(1), array[saf.s(1)], now(), null, 'Bootstrap delegated security administrator');
select public.sa_assign_role(saf.u(1), saf.u(5), '00000000-0000-0000-0005-000000000001', saf.o(2), array[saf.s(2)], now(), null, 'Balakong-only access administrator');
update public.sa_settings set setting_value = 'true'::jsonb where setting_key = 'security_access.delegated_administration';
create function saf.init(actor int, target int, role_key text, org int, scope int) returns text language sql as $$
  select saf.try(format($q$select public.sa_assign_initial_profiles(%L, %L, %L, jsonb_build_array(jsonb_build_object('role_id', %L, 'scope_ids', jsonb_build_array(%L))), false)$q$, saf.u(actor), saf.u(target), saf.o(org), saf.role(role_key), saf.s(scope))) $$;
create function saf.may(actor int, role_key text, org int) returns boolean language sql as $$ select public.sa_actor_may_assign_profile(saf.u(actor), saf.role(role_key), saf.o(org)) $$;
create function saf.assign(actor int, target int, role_key text, org int, scope int) returns text language sql as $$
  select saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], now(), null, 'parity test grant')$q$, saf.u(actor), saf.u(target), saf.role(role_key), saf.o(org), saf.s(scope))) $$;

-- 1. The predicate mirrors the grant guard
select saf.expect(saf.may(1, 'finance-full-access', 1), 'legacy Super Admin (the existing rule) may assign every policy');
select saf.expect(saf.may(2, 'security-access-full-access', 1), 'delegated admin who HOLDS the sensitive permissions may assign Security & Access Full Access');
select saf.expect(not saf.may(2, 'finance-full-access', 1) and not saf.may(2, 'hr-payroll-full-access', 1), 'delegated admin without finance/hr reset is not allowed those policies');
select saf.expect(saf.may(2, 'supply-chain-full-access', 1) and saf.may(5, 'supply-chain-full-access', 2) and saf.may(2, 'customer-growth-full-access', 1), 'non-sensitive policies need no extra authority');
select saf.expect(not saf.may(5, 'security-access-full-access', 2), 'narrow admin holds security.role.assign / view but not the rest of Security & Access Full Access');
select saf.expect(not saf.may(6, 'security-access-full-access', 1) and not public.sa_actor_may_assign_profile(null, saf.role('finance-full-access'), saf.o(1)) and not public.sa_actor_may_assign_profile(saf.u(1), null, saf.o(1)), 'a plain member, a null actor and a null policy are never allowed');

-- 2. Add User (initial profiles) now behaves exactly like Grant Policy for the same actor / policy / organization
select saf.expect(saf.init(1, 6, 'finance-full-access', 1, 1) = 'OK', 'Super Admin: initial Finance Full Access works (same as Grant Policy)');
select saf.expect(saf.init(2, 3, 'security-access-full-access', 1, 1) = 'OK', 'delegated holder: initial Security & Access Full Access works');
select saf.expect(saf.init(2, 7, 'finance-full-access', 1, 1) like 'sa_grant_beyond_authority%', 'delegated admin without the permissions: refused at provisioning with the grant-authority error');
select saf.expect(saf.assign(2, 7, 'finance-full-access', 1, 1) like 'sa_grant_beyond_authority%', 'and Grant Policy refuses the same combination');
select saf.expect(saf.init(2, 7, 'hr-payroll-full-access', 1, 1) like 'sa_grant_beyond_authority%' and saf.assign(2, 7, 'hr-payroll-full-access', 1, 1) like 'sa_grant_beyond_authority%', 'HR Full Access: both flows refuse the same actor');
select saf.expect((select count(*) from public.sa_role_assignments where user_id = saf.u(7)) = 0, 'a refused sensitive policy leaves no assignment behind');
select saf.expect(saf.init(2, 7, 'supply-chain-full-access', 1, 1) = 'OK' and saf.init(2, 8, 'customer-growth-full-access', 1, 1) like 'sa_%', 'Supply Chain Full Access works at provisioning (customer policy to a manufacturer user is refused by membership/scope rules)');
select saf.expect(saf.init(2, 4, 'customer-growth-full-access', 2, 2) = 'OK', 'Customer & Growth Full Access works for a warehouse recipient with its own scope');
select saf.expect(saf.init(2, 2, 'supply-chain-full-access', 1, 1) = 'sa_self_assignment_prohibited', 'self-assignment stays prohibited during provisioning');
select saf.expect(saf.init(5, 6, 'supply-chain-full-access', 1, 1) = 'sa_authorization_required', 'an actor without authority in the organization is refused (organization authority unchanged)');
select saf.expect(saf.try(format($q$select public.sa_assign_initial_profiles(%L, %L, %L, jsonb_build_array(jsonb_build_object('role_id', %L), jsonb_build_object('role_id', %L)), false)$q$, saf.u(1), saf.u(3), saf.o(1), saf.role('finance-full-access'), saf.role('finance-full-access'))) = 'sa_scope_required', 'scope is still required per policy');
select saf.expect(saf.try(format($q$select public.sa_assign_initial_profiles(%L, %L, %L, jsonb_build_array(jsonb_build_object('role_id', %L, 'scope_ids', jsonb_build_array(%L)), jsonb_build_object('role_id', %L, 'scope_ids', jsonb_build_array(%L))), false)$q$, saf.u(1), saf.u(3), saf.o(1), saf.role('supply-chain-full-access'), saf.s(1), saf.role('supply-chain-full-access'), saf.s(1))) = 'sa_initial_access_duplicate', 'a duplicate policy in one request is still refused');

-- 3. An identical active grant is never added again; the existing grant is not replaced
select public.sa_assign_role(saf.u(1), saf.u(9), saf.role('supply-chain-full-access'), saf.o(1), array[saf.s(1)], now(), null, 'HQ wide grant');
select saf.expect(saf.assign(1, 9, 'supply-chain-full-access', 1, 1) = 'sa_role_already_held', 'repeating the identical grant is refused');
select saf.expect(saf.assign(1, 9, 'supply-chain-full-access', 1, 3) = 'sa_role_already_held', 'a narrower scope for a policy already held at HQ is refused (it would not restrict the HQ grant)');
select saf.expect((select array_agg(x.scope_id order by x.scope_id) from public.sa_assignment_scopes x join public.sa_role_assignments a on a.id = x.assignment_id where a.user_id = saf.u(9) and a.role_id = saf.role('supply-chain-full-access')) = array[saf.s(1)], 'the existing HQ grant keeps exactly its original scope');
select saf.expect((select count(*) from public.sa_role_assignments where user_id = saf.u(9) and role_id = saf.role('supply-chain-full-access') and status = 'active') = 1, 'still one active grant, nothing revoked');
-- expired / revoked grants may be granted again (identity = active, not expired)
update public.sa_role_assignments set effective_from = now() - interval '2 days', effective_until = now() - interval '1 day' where user_id = saf.u(9) and role_id = saf.role('supply-chain-full-access');
select saf.expect(saf.assign(1, 9, 'supply-chain-full-access', 1, 1) = 'OK', 'an expired grant can be granted again');
-- other policies / other memberships are unaffected
select saf.expect(saf.assign(1, 9, 'customer-growth-full-access', 1, 1) = 'OK', 'a different policy is not blocked');

-- 4. Warehouse-only grant of Supply Chain Full Access: only the permissions whose enforcement carries the warehouse are granted, nothing org-wide
insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name) values (saf.s(6), saf.o(2), 'warehouse', saf.o(2)::text, 'Balakong WH (warehouse)');
select saf.expect(saf.assign(1, 6, 'supply-chain-full-access', 1, 6) = 'OK', 'Supply Chain Full Access granted for ONE warehouse (Balakong) to an HQ member');
create temp table saf_wh12(k text);
insert into saf_wh12 values ('inventory.adjustment.post'),('inventory.opening_balance.manage'),('inventory.return.manage'),('inventory.transfer.approve'),('inventory.transfer.cancel'),
  ('inventory.transfer.dispatch'),('inventory.transfer.receive'),('inventory.transfer.request'),('inventory.stock_count.verify'),('inventory.stock_count.post'),('warehouse.receipt.post'),('warehouse.shipment.manage');
do $t$ declare pk text; v_all text[] := saf.keys(saf.role('supply-chain-full-access')); n_wh int := 0; n_other int := 0; begin
  perform saf.expect(cardinality(v_all) = 30, 'Supply Chain Full Access has 30 permissions');
  foreach pk in array v_all loop
    if exists (select 1 from saf_wh12 w where w.k = pk) then
      n_wh := n_wh + 1;
      perform saf.expect((public.sa_evaluate_permission(saf.u(6), pk, jsonb_build_object('organization_id', saf.o(2), 'warehouse_id', saf.o(2)))->>'decision') = 'ALLOW', pk || ': allowed for that warehouse');
      perform saf.expect((public.sa_evaluate_permission(saf.u(6), pk, jsonb_build_object('organization_id', saf.o(3), 'warehouse_id', saf.o(3)))->>'decision') = 'DENY', pk || ': denied for another warehouse');
    else
      n_other := n_other + 1;
    end if;
    -- What the organization-level gates send (organization only, no warehouse): never allowed by a warehouse-only grant, for ALL 30.
    perform saf.expect((public.sa_evaluate_permission(saf.u(6), pk, jsonb_build_object('organization_id', saf.o(1)))->>'decision') = 'DENY', pk || ': HQ-level operation is denied');
    perform saf.expect((public.sa_evaluate_permission(saf.u(6), pk, jsonb_build_object('organization_id', saf.o(2)))->>'decision') = 'DENY', pk || ': an operation without a warehouse is denied (missing context, fail closed)');
  end loop;
  perform saf.expect(n_wh = 12 and n_other = 18, format('12 of 30 permissions can be limited by a warehouse (got %s / %s other)', n_wh, n_other));
end $t$;
