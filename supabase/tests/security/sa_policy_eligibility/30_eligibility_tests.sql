-- After 20261030100000 (applied twice). Numbers refer to the required test scenarios.

-- 12. Existing grants are untouched by the migration (valid and incompatible alike).
select saf.expect((select count(*) from saf.assignments_before b join public.sa_role_assignments a using (id)
  where (a.user_id, a.role_id, a.membership_id, a.status, a.source, a.effective_from, a.effective_until, a.assignment_reason)
     is not distinct from (b.user_id, b.role_id, b.membership_id, b.status, b.source, b.effective_from, b.effective_until, b.assignment_reason))
  = (select count(*) from saf.assignments_before) and (select count(*) from public.sa_role_assignments) = (select count(*) from saf.assignments_before),
  'migration changed no assignment');
select saf.expect(saf.active(12, 'order-approver') = 1 and saf.active(33, 'saf-custom-partner') = 1, 'pre-existing grants stay active');

-- Classification: explicit, fail closed for unknown / consumer types; standard lists filled only where empty.
select saf.expect((select array_agg(org_type_code order by org_type_code) from public.sa_org_type_eligibility where eligibility_class <> 'not_assignable')
  = array['DIST','HQ','MFG','SHOP','WH'], 'assignable organization types');
select saf.expect(public.sa_policy_org_type_ineligibility(saf.role('order-creator'), 'END_USER') = 'org_type_not_assignable'
  and public.sa_policy_org_type_ineligibility(saf.role('order-creator'), 'INDEP') = 'org_type_not_assignable'
  and public.sa_policy_org_type_ineligibility(saf.role('order-creator'), 'MARS') = 'org_type_not_assignable'
  and public.sa_policy_org_type_ineligibility(saf.role('order-creator'), null) = 'org_type_not_assignable', 'consumer, independent, unknown and missing types are never eligible');
select saf.expect((select applicable_org_types from public.sa_business_roles where role_key = 'order-creator') = array['HQ','DIST','SHOP']
  and (select applicable_org_types from public.sa_business_roles where role_key = 'qr-batch-operator') = array['HQ','MFG']
  and (select applicable_org_types from public.sa_business_roles where role_key = 'saf-mfg-ops') = array['MFG'], 'explicit lists are never overwritten');
select saf.expect((select applicable_org_types from public.sa_business_roles where role_key = 'finance-viewer') = array['HQ']
  and (select applicable_org_types from public.sa_business_roles where role_key = 'warehouse-manager') = array['HQ','WH']
  and (select applicable_org_types from public.sa_business_roles where role_key = 'employee-self-service') = array['HQ'], 'standard lists filled');
select saf.expect((select applicable_org_types from public.sa_business_roles where role_key = 'saf-custom-any') = '{}', 'custom policies are never expanded');
select saf.expect((select count(*) from public.sa_access_change_log where action = 'access_profile.eligibility_changed' and actor_id is null and actor_kind = 'system')
  >= (select count(*) from public.sa_business_roles where source = 'template' and role_key in ('finance-viewer', 'warehouse-manager', 'order-approver')),
  'the classification is audited as a system change');

-- 1. HQ membership: HQ policies.
select saf.expect(saf.grant_ok(23, 6, 'finance-viewer', 1, 1) = 'OK', '1: HQ policy to an HQ member');
select saf.expect(saf.grant_ok(23, 4, 'warehouse-operator', 2, 2) = 'OK', '1: warehouse policy to a WH member (WH listed explicitly)');
select saf.expect(saf.grant_ok(23, 4, 'finance-viewer', 2, 2) like 'sa_profile_not_applicable%', '1: WH is never implied by HQ');
-- 2. Manufacturer: manufacturer policies only.
select saf.expect(saf.grant_ok(23, 8, 'saf-mfg-ops', 4, 4) = 'OK', '2: manufacturer policy to a Manufacturer');
select saf.expect(saf.grant_ok(23, 8, 'order-approver', 4, 4) like 'sa_profile_not_applicable%', '2: HQ policy refused for a Manufacturer');
select saf.expect(public.sa_policy_org_type_ineligibility(saf.role('qr-batch-operator'), 'MFG') = 'permission_incompatible:qr.batch.manage'
  and saf.grant_ok(23, 8, 'qr-batch-operator', 4, 4) like 'sa_profile_not_applicable%', '2: declared MFG but not Manufacturing-only: refused (open decision)');
-- 3. Distributor / 4. Shop.
select saf.expect(saf.grant_ok(23, 22, 'order-creator', 11, 11) = 'OK', '3: Order Creator to a Distributor');
select saf.expect(saf.grant_ok(23, 22, 'warehouse-manager', 11, 11) like 'sa_profile_not_applicable%', '3: HQ Warehouse Manager refused for a Distributor');
select saf.expect(saf.grant_ok(23, 12, 'order-creator', 6, 7) = 'OK', '4: Order Creator to a Shop');
select saf.expect(saf.grant_ok(23, 12, 'finance-viewer', 6, 7) like 'sa_profile_not_applicable%', '4: Finance refused for a Shop');
select saf.expect(saf.grant_ok(23, 30, 'order-creator', 30, 30) like 'sa_profile_not_applicable%'
  and saf.grant_ok(23, 31, 'order-creator', 31, 31) like 'sa_profile_not_applicable%', 'End User / Independent memberships receive nothing');

-- 5. The administration catalogue shows partner policies with where they apply (visibility is not eligibility).
select saf.expect((select eligible_org_types from public.sa_policy_eligibility_catalogue() where role_key = 'saf-mfg-ops') = array['MFG']
  and (select eligible_org_types from public.sa_policy_eligibility_catalogue() where role_key = 'order-creator') = array['DIST','HQ','SHOP']
  and (select eligible_org_types from public.sa_policy_eligibility_catalogue() where role_key = 'saf-custom-any') = '{}'
  and (select ineligible->>'HQ' from public.sa_policy_eligibility_catalogue() where role_key = 'saf-custom-any') = 'policy_unclassified', '5: catalogue');
-- 6. A partner-only policy is never granted to an HQ membership — by a Super Admin, a delegated admin or a Root Administrator.
select saf.expect(saf.grant_ok(1, 6, 'saf-mfg-ops', 1, 1) like 'sa_profile_not_applicable%', '6: Super Admin cannot give a Manufacturer policy to HQ');
select saf.expect(saf.grant_ok(23, 6, 'saf-mfg-ops', 1, 1) like 'sa_profile_not_applicable%', '6/14: Root Administrator cannot either');
select saf.expect(saf.grant_ok(2, 3, 'saf-mfg-ops', 1, 1) like 'sa_profile_not_applicable%', '6: delegated admin cannot either');
-- 7. Custom policies follow the same rule; no metadata = nowhere.
select saf.expect(saf.grant_ok(23, 6, 'saf-custom-any', 1, 1) like 'sa_profile_not_applicable%'
  and saf.grant_ok(23, 8, 'saf-custom-any', 4, 4) like 'sa_profile_not_applicable%', '7: unclassified custom policy is grantable nowhere');
select saf.expect(saf.grant_ok(23, 6, 'saf-custom-hq', 1, 1) = 'OK' and saf.grant_ok(23, 12, 'saf-custom-hq', 6, 7) like 'sa_profile_not_applicable%', '7: custom HQ policy');
select saf.expect(saf.grant_ok(23, 22, 'saf-custom-partner', 11, 11) = 'OK' and saf.grant_ok(23, 32, 'saf-custom-partner', 1, 1) like 'sa_profile_not_applicable%', '7: custom partner policy');

-- 8. Paths that bypass sa_assign_role: access-request approval, the internal helper, a direct row write.
select saf.expect(saf.approve(23, saf.request(12, 'supply-chain-full-access', 6, 7)) like 'sa_profile_not_applicable%', '8: access-request approval refuses an ineligible policy');
select saf.expect(saf.active(12, 'supply-chain-full-access') = 0, '8: nothing granted');
select saf.expect(saf.approve(23, saf.request(33, 'order-creator', 6, 7)) = 'OK', '8: access-request approval of an eligible policy works');
select saf.expect(saf.active(33, 'order-creator') = 1, '8: granted');
select saf.expect(saf.try(format($q$select public.sa_create_assignment_internal(%L, %L, %L, %L, array[%L]::uuid[], null, null, 'direct', 'manual')$q$,
  saf.u(23), saf.u(12), saf.role('finance-viewer'), saf.o(6), saf.s(7))) like 'sa_profile_not_applicable%', '8: internal helper refuses');
select saf.expect(saf.try(format($q$insert into public.sa_role_assignments(user_id, role_id, membership_id, status, source, created_by, updated_by)
  select %L, %L, m.id, 'active', 'manual', %L, %L from public.sa_organization_memberships m where m.user_id = %L$q$,
  saf.u(12), saf.role('finance-viewer'), saf.u(23), saf.u(23), saf.u(12))) like 'sa_profile_not_applicable%', '8: direct row insert refuses');
-- Lifecycle sources are not administrator grants and are not judged here (ESS sync, backfill).
select saf.expect(saf.try(format($q$select public.sa_create_assignment_internal(null, %L, %L, %L, array[%L]::uuid[], null, null, 'lifecycle', 'derived')$q$,
  saf.u(31), saf.role('order-approver'), saf.o(31), saf.s(31))) = 'OK', 'lifecycle (derived) writes are unchanged');

-- 11. Re-granting a revoked policy only while eligible.
select saf.expect(saf.try(format($q$select public.sa_revoke_assignment(%L, (select id from public.sa_role_assignments where user_id = %L and role_id = %L), 'no longer needed here')$q$,
  saf.u(23), saf.u(12), saf.role('order-creator'))) = 'OK', '11: revoke');
select saf.expect(saf.grant_ok(23, 12, 'order-creator', 6, 7) = 'OK', '11: eligible policy re-granted');
select saf.expect(saf.try(format($q$select public.sa_revoke_assignment(%L, (select id from public.sa_role_assignments where user_id = %L and role_id = %L), 'moving to distributors only')$q$,
  saf.u(23), saf.u(33), saf.role('saf-custom-partner'))) = 'OK', '11: revoke the custom shop grant');
-- 15 (policy side). Narrowing a custom policy with an active holder in an excluded type is refused; without one it is allowed.
select saf.expect(saf.try($q$update public.sa_business_roles set applicable_org_types = array['SHOP'], updated_by = '00000000-0000-0000-0001-000000000001' where role_key = 'saf-custom-partner'$q$)
  like 'sa_profile_eligibility_has_holders: 1', '15: narrowing away from an active Distributor grant is refused');
select saf.expect(saf.try($q$update public.sa_business_roles set applicable_org_types = array['DIST'], updated_by = '00000000-0000-0000-0001-000000000001' where role_key = 'saf-custom-partner'$q$) = 'OK',
  'narrowing that leaves every active holder eligible works (the revoked Shop grant does not count)');
select saf.expect((select details->'org_types_after' from public.sa_access_change_log where action = 'access_profile.eligibility_changed'
  and entity_id = saf.role('saf-custom-partner')::text order by occurred_at desc, id desc limit 1) = '["DIST"]'::jsonb, 'eligibility change audited with before/after');
select saf.expect(saf.grant_ok(23, 33, 'saf-custom-partner', 6, 7) like 'sa_profile_not_applicable%', '11: re-grant after narrowing refused');
select saf.expect(saf.try(format($q$update public.sa_role_assignments set status = 'active' where user_id = %L and role_id = %L$q$, saf.u(33), saf.role('saf-custom-partner')))
  like 'sa_profile_not_applicable%', '11: re-activating the revoked row directly is refused');
-- Broadening HQ-only permissions to partners is refused (standard and custom).
select saf.expect(saf.try($q$update public.sa_business_roles set applicable_org_types = array['HQ','SHOP'] where role_key = 'finance-viewer'$q$)
  like 'sa_profile_org_type_incompatible: finance.%', 'finance cannot be broadened to shops');
select saf.expect(saf.try($q$update public.sa_business_roles set applicable_org_types = array['MFG'] where role_key = 'saf-custom-hq'$q$)
  like 'sa_profile_org_type_incompatible: inventory.stock_count.view for MFG', 'a Manufacturer list needs Manufacturing-only permissions');
select saf.expect(saf.try($q$update public.sa_business_roles set applicable_org_types = array['END_USER'] where role_key = 'saf-custom-any'$q$)
  like 'sa_profile_org_type_invalid: END_USER', 'consumer types cannot be listed');
select saf.expect(saf.try($q$update public.sa_business_roles set applicable_org_types = array['HQ','GALAXY'] where role_key = 'saf-custom-any'$q$)
  like 'sa_profile_org_type_invalid: GALAXY', 'unknown types cannot be listed');

-- Custom drafts: explicit types required to submit; incompatible combinations refused at save.
select saf.expect(saf.try(format($q$select public.sa_create_access_profile(%L, 'saf-draft-1', 'Draft one', null, '{}', '{}', array['inventory.stock_count.view'])$q$, saf.u(1))) = 'OK', 'an incomplete draft can be saved');
select saf.expect(saf.try(format($q$select public.sa_submit_profile_draft(%L, %L)$q$, saf.u(1), saf.role('saf-draft-1'))) = 'sa_profile_org_types_required', 'submit without organization types refused');
select saf.expect(saf.try(format($q$select public.sa_save_profile_draft(%L, %L, 'Draft one', null, '{}', array['SHOP'], array['hr.employee.view'])$q$, saf.u(1), saf.role('saf-draft-1')))
  like 'sa_profile_%', 'HR permissions cannot be drafted for shops');
select saf.expect(saf.try(format($q$select public.sa_save_profile_draft(%L, %L, 'Draft one', null, '{}', array['HQ','WH'], array['inventory.stock_count.view'])$q$, saf.u(1), saf.role('saf-draft-1'))) = 'OK'
  and saf.try(format($q$select public.sa_submit_profile_draft(%L, %L)$q$, saf.u(1), saf.role('saf-draft-1'))) = 'OK', 'explicit types: submit works');

-- 13. The audit reports existing incompatible grants and changes nothing.
select saf.expect(exists (select 1 from public.sa_policy_eligibility_audit() where user_id = saf.u(12) and role_key = 'order-approver' and reason = 'org_type_not_eligible'),
  '13: the Shop member''s HQ approval grant is reported');
select saf.expect(not exists (select 1 from public.sa_policy_eligibility_audit() where user_id = saf.u(6) and role_key = 'finance-viewer'), '13: valid grants are not reported');
select saf.expect(saf.active(12, 'order-approver') = 1, '13: the reported grant is still active (no automatic removal)');

-- 14. Root Access rows untouched; the evaluator-level root is not an eligibility bypass (asserted in 6).
select saf.expect((select count(*) from public.sa_root_access_grants) = (select count(*) from saf.root_before)
  and not exists (select * from public.sa_root_access_grants except select * from saf.root_before), '14: Root Access grants unchanged');

-- 15. Scope cannot bypass eligibility: eligibility is judged on the membership, a scope never changes it.
select saf.expect(saf.grant_ok(23, 6, 'saf-mfg-ops', 1, 4) like 'sa_profile_not_applicable%', '15: an HQ membership with a Manufacturer scope is still HQ');
select saf.expect(saf.grant_ok(23, 8, 'saf-mfg-ops', 1, 1) like 'sa_profile_not_applicable%' or saf.grant_ok(23, 8, 'saf-mfg-ops', 1, 1) like 'sa_membership_required%',
  '15: naming another organization does not borrow its type');

-- Privileges: nothing new reachable by anon / authenticated.
select saf.expect(not has_function_privilege('authenticated', 'public.sa_policy_org_type_ineligibility(uuid,text)', 'execute')
  and not has_function_privilege('anon', 'public.sa_policy_eligibility_audit()', 'execute')
  and not has_function_privilege('authenticated', 'public.sa_policy_eligibility_catalogue()', 'execute')
  and not has_table_privilege('authenticated', 'public.sa_org_type_eligibility', 'select'), 'no new privileges for anon / authenticated');
select saf.expect((select count(*) from public.sa_migration_modes m join saf.elig_modes_before b using (permission_key) where m.mode is distinct from b.mode) = 0, 'no migration mode changed');
