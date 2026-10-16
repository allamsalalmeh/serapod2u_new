-- Delegated (non-level-1) Security & Access administration versus unauthorized access, grant authority, self-grant, SoD,
-- lockout, and unchanged legacy administrator behaviour.
-- Bootstrap (done once by the level-1 administrator through the existing flow): u2 gets Security & Access Full Access.
select public.sa_assign_role(saf.u(1), saf.u(2), saf.role('security-access-full-access'), saf.o(1), array[saf.s(1)], now(), null, 'Bootstrap delegated security administrator');
select public.sa_assign_role(saf.u(1), saf.u(9), saf.role('supply-chain-full-access'), saf.o(1), array[saf.s(1)], now(), null, 'Supply chain lead');
select public.sa_assign_role(saf.u(1), saf.u(5), '00000000-0000-0000-0005-000000000001', saf.o(2), array[saf.s(2)], now(), null, 'Balakong-only access administrator');
select public.sa_assign_role(saf.u(1), saf.u(7), '00000000-0000-0000-0005-000000000002', saf.o(1), array[saf.s(1)], now(), null, 'Payment approver');
create function saf.assign(actor int, target int, role_key text, org int, scope int) returns text language sql as $$
  select saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], now(), null, 'delegated administration test')$q$, saf.u(actor), saf.u(target), saf.role(role_key), saf.o(org), saf.s(scope))) $$;
create function saf.orgs(actor int, perm text) returns text language sql stable as $$
  select coalesce(string_agg(o.org_name, ',' order by o.org_name), '') from public.sa_authorized_organizations(saf.u(actor), perm) a join public.organizations o on o.id = a.organization_id $$;

-- A. Default (flag false): nothing changes — the legacy rule decides and a non-level-1 holder is refused.
select saf.expect(not public.sa_delegated_administration_enabled(), 'delegated administration is off by default');
select saf.expect(saf.assign(2, 6, 'supply-chain-full-access', 1, 1) = 'sa_authorization_required', 'flag off: explicit holder is refused (legacy level 1 decides)');
select saf.expect(saf.orgs(2, 'security.access.view') = '', 'flag off: directory scope empty for a non-level-1 admin');
select saf.expect(saf.orgs(1, 'security.access.view') = 'Alma WH,Balakong WH,HQ,Manu Manufacturing', 'legacy level 1 sees every organization');
select saf.expect(saf.try(format($q$select public.sa_create_access_profile(%L, 'saf-x1', 'X', null, '{}', '{}', '{inventory.stock_count.view}')$q$, saf.u(2))) = 'sa_authorization_required', 'flag off: policy management refused for non-level-1');
select saf.expect(saf.assign(1, 3, 'customer-growth-full-access', 1, 1) = 'OK', 'legacy level 1 administrator works exactly as before (flag off)');

-- B. Flag on (the controlled rollout step): explicit, in-scope authority works; everything else stays refused.
update public.sa_settings set setting_value = 'true'::jsonb where setting_key = 'security_access.delegated_administration';
select saf.expect(public.sa_delegated_administration_enabled(), 'flag on');
select saf.expect(saf.orgs(2, 'security.access.view') = 'Alma WH,Balakong WH,HQ', 'delegated admin sees HQ and its descendants only (not the manufacturer)');
select saf.expect(saf.orgs(3, 'security.access.view') = '' and saf.orgs(9, 'security.access.view') = '' and saf.orgs(8, 'security.access.view') = '', 'members without S&A authority see nothing');
select saf.expect(saf.orgs(5, 'security.access.view') = 'Balakong WH', 'narrow admin sees only its own organization');
select saf.expect(saf.orgs(1, 'security.access.view') = 'Alma WH,Balakong WH,HQ,Manu Manufacturing', 'legacy level 1 unchanged with the flag on');
select saf.expect(saf.assign(2, 6, 'supply-chain-full-access', 1, 1) = 'OK', 'delegated admin grants a non-sensitive Full Access policy in scope (real actor recorded)');
select saf.expect((select updated_by = saf.u(2) from public.sa_role_assignments a where a.user_id = saf.u(6) and a.role_id = saf.role('supply-chain-full-access')) and
  (select actor_id = saf.u(2) from public.sa_access_change_log where action = 'assignment.granted' and target_user_id = saf.u(6) order by occurred_at desc limit 1), 'the real actor is on the assignment and in the audit log');
select saf.expect(saf.assign(2, 3, 'security-access-full-access', 1, 1) = 'OK', 'an administrator who holds the sensitive policy may grant it onward');
select saf.expect(saf.assign(2, 6, 'finance-full-access', 1, 1) like 'sa_grant_beyond_authority: finance.%', 'cannot grant a sensitive policy the administrator does not hold');
select saf.expect(saf.assign(2, 6, 'hr-payroll-full-access', 1, 1) like 'sa_grant_beyond_authority: hr.data.reset%', 'cannot grant HR reset through HR Full Access');
select saf.expect(saf.assign(2, 2, 'supply-chain-full-access', 1, 1) = 'sa_self_assignment_prohibited', 'self-grant stays prohibited');
select saf.expect(saf.assign(2, 8, 'customer-growth-full-access', 4, 4) = 'sa_authorization_required', 'no authority in an organization outside the administrator''s scope');
select saf.expect(saf.assign(2, 4, 'saf-assign-only', 2, 2) = 'OK', 'authority covers descendant organizations (Balakong) with a scope inside it');
select saf.expect(saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], now(), null, 'org independent scope')$q$, saf.u(2), saf.u(3), saf.role('supply-chain-full-access'), saf.o(1), saf.s(5))) = 'sa_grant_scope_beyond_authority', 'non-level-1 granting a territory scope is refused');
select saf.expect(saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], now(), null, 'level 1 may')$q$, saf.u(1), saf.u(3), saf.role('supply-chain-full-access'), saf.o(1), saf.s(5))) = 'OK', 'level 1 can still grant an organization-independent scope');
-- narrow administrator: view + assign inside Balakong only
select saf.expect(saf.assign(5, 4, 'saf-payer', 2, 2) = 'OK', 'narrow admin grants inside its organization');
select saf.expect(saf.assign(5, 6, 'saf-payer', 1, 1) = 'sa_authorization_required', 'narrow admin cannot grant in HQ');
select saf.expect(saf.try(format($q$select public.sa_create_access_profile(%L, 'saf-x2', 'X', null, '{}', '{}', '{inventory.stock_count.view}')$q$, saf.u(5))) = 'sa_authorization_required', 'narrow admin has no policy-management authority');
select saf.expect(saf.assign(9, 6, 'saf-payer', 1, 1) = 'sa_authorization_required' and saf.assign(6, 3, 'saf-payer', 1, 1) = 'sa_authorization_required' and saf.assign(8, 6, 'saf-payer', 1, 1) = 'sa_authorization_required', 'Supply Chain Full Access, a plain member and a partner user cannot administer access');
-- SoD still enforced for a delegated administrator's grants
update public.sa_sod_rules set enforcement = 'enforce' where rule_key = 'security-admin-vs-payment-approval';
select saf.expect(saf.assign(2, 7, 'saf-assign-only', 1, 1) like 'sod_violation%', 'enforce-level SoD blocks the delegated grant');
update public.sa_sod_rules set enforcement = 'monitor' where rule_key = 'security-admin-vs-payment-approval';
-- Policy management by the delegated administrator is bounded by what it holds
select saf.expect(saf.try(format($q$select public.sa_copy_access_profile(%L, %L, 'saf-hr-copy', 'HR copy', 'copy attempt beyond authority')$q$, saf.u(2), saf.role('hr-payroll-full-access'))) like 'sa_profile_beyond_authority: hr.data.reset%', 'cannot copy a policy containing a sensitive permission it does not hold');
select saf.expect(saf.try(format($q$select public.sa_copy_access_profile(%L, %L, 'saf-sc-copy', 'SC copy', 'copy within authority')$q$, saf.u(2), saf.role('supply-chain-full-access'))) = 'OK', 'can copy a Full Access policy it may grant (Copy & Customize)');
select saf.expect(saf.try(format($q$select public.sa_create_access_profile(%L, 'saf-sec-copy', 'Sec copy', null, array['internal'], '{}', array['security.access.view','security.audit.view'])$q$, saf.u(2))) = 'OK', 'can create a custom policy from sensitive permissions it holds');
select saf.expect(saf.try(format($q$select public.sa_create_access_profile(%L, 'saf-reset', 'Reset', null, array['internal'], '{}', array['finance.data.reset'])$q$, saf.u(2))) like 'sa_profile_beyond_authority: finance.data.reset%', 'cannot put a sensitive permission it does not hold into a custom policy');
-- Access-request approval path is guarded the same way
select public.sa_submit_access_request(saf.u(3), saf.u(6), saf.role('finance-full-access'), saf.o(1), array[saf.s(1)], now(), null, 'Request for the Finance Full Access policy');
select public.sa_submit_access_request(saf.u(3), saf.u(4), saf.role('customer-growth-full-access'), saf.o(2), array[saf.s(2)], now(), null, 'Request for the Customer and Growth policy');
select saf.expect(saf.try(format($q$select public.sa_decide_access_request(%L, %L, true, 'approving')$q$, saf.u(2), (select id from public.sa_access_requests where role_id = saf.role('finance-full-access') and status = 'requested'))) like 'sa_grant_beyond_authority: finance.%', 'approving a request cannot grant a sensitive policy beyond the approver''s authority');
select saf.expect(saf.try(format($q$select public.sa_decide_access_request(%L, %L, true, 'approving')$q$, saf.u(2), (select id from public.sa_access_requests where role_id = saf.role('customer-growth-full-access') and status = 'requested'))) = 'OK', 'approving a non-sensitive request in scope works for the delegated administrator');
select saf.expect(saf.try(format($q$select public.sa_decide_access_request(%L, %L, true, 'approving')$q$, saf.u(3), (select id from public.sa_access_requests where role_id = saf.role('finance-full-access') and status = 'requested'))) = 'sa_self_approval_prohibited', 'the requester still cannot approve their own request');

-- C. Mode governance for the delegated administrator, and the lockout safeguard
insert into public.sa_enforcement_readiness(permission_key, route_wiring, database_backstop, notes) values ('security.permission.manage', true, 'governance_function', 'fixture') on conflict (permission_key) do nothing;
update public.sa_migration_modes set mode = 'LEGACY_RETIRED' where permission_key = 'security.permission.manage';
select saf.expect(saf.try(format($q$select public.sa_bulk_set_migration_mode(%L, array['security.permission.manage'], '{"security.permission.manage":"LEGACY_RETIRED"}', 'SHADOW', 'delegated mode change attempt', 'g', 'all', gen_random_uuid())$q$, saf.u(2))) = 'OK', 'flag on: delegated admin keeps authority after the change, so no lockout');
update public.sa_migration_modes set mode = 'LEGACY_RETIRED' where permission_key = 'security.permission.manage';
update public.sa_settings set setting_value = 'false'::jsonb where setting_key = 'security_access.delegated_administration';
select saf.expect(saf.try(format($q$select public.sa_bulk_set_migration_mode(%L, array['security.permission.manage'], '{"security.permission.manage":"LEGACY_RETIRED"}', 'SHADOW', 'delegated mode change attempt', 'g', 'all', gen_random_uuid())$q$, saf.u(2))) = 'sa_bulk_actor_lockout', 'flag off: the existing administrator-lockout guard still rolls the change back');
select saf.expect((select mode from public.sa_migration_modes where permission_key = 'security.permission.manage') = 'LEGACY_RETIRED', 'lockout left the mode unchanged');
update public.sa_migration_modes m set mode = b.mode from saf.modes_before b where m.permission_key = b.permission_key and m.permission_key = 'security.permission.manage';

-- D. No collateral changes
select saf.expect((select mode from public.sa_migration_modes where permission_key = 'security.permission.manage') = (select mode from saf.modes_before where permission_key = 'security.permission.manage'), 'no migration mode left changed');
select saf.expect((select count(*) from public.users) = 9 and (select count(*) from public.sa_organization_memberships) = 9, 'no user or membership was created by any policy assignment');
