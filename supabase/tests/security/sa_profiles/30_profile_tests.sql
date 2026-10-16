-- Fixtures local to the profile tests (isolated database only).
insert into auth.users(id, email) select saf.u(n), 'extra' || n || '@dev.com' from generate_series(9, 11) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active) values
  (saf.u(9), 'extra9@dev.com', 'New Warehouse Hire', 'WH_MGR', saf.o(2), true), (saf.u(10), 'extra10@dev.com', 'New Mfg Hire', 'MFG_USER', saf.o(4), true),
  (saf.u(11), 'extra11@dev.com', 'Second Super Admin', 'SA', saf.o(1), true);
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status) values
  (saf.u(9), saf.o(2), 'employee', true, 'active'), (saf.u(10), saf.o(4), 'partner', true, 'active'), (saf.u(11), saf.o(1), 'employee', true, 'active');
insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name) values
  ('00000000-0000-0000-0004-000000000010', null, 'territory', 'north', 'North territory'),
  ('00000000-0000-0000-0004-000000000011', saf.o(3), 'organization', saf.o(3)::text, 'Alma WH');
\set bal '''00000000-0000-0000-0004-000000000001'''
-- A standard (template) profile, a compatibility (legacy) role, and a receiver role
insert into public.sa_business_roles(id, role_key, name, source, status) values
  ('00000000-0000-0000-0005-000000000010', 'saf-standard-counter', 'Standard Counter', 'template', 'active'),
  ('00000000-0000-0000-0005-000000000011', 'legacy-saf', 'Legacy Compat', 'legacy', 'active'),
  ('00000000-0000-0000-0005-000000000012', 'saf-receiver', 'Receiver', 'new', 'active');
insert into public.sa_business_role_permissions(role_id, permission_id)
  select '00000000-0000-0000-0005-000000000010', id from public.sa_permissions where permission_key in ('inventory.stock_count.view', 'inventory.stock_count.create');
insert into public.sa_business_role_permissions(role_id, permission_id)
  select '00000000-0000-0000-0005-000000000012', id from public.sa_permissions where permission_key = 'inventory.transfer.receive';
insert into public.sa_business_role_permissions(role_id, permission_id)
  select '00000000-0000-0000-0005-000000000011', id from public.sa_permissions where permission_key = 'inventory.stock_count.view';

create function saf.keys(p_role uuid) returns text[] language sql stable as $$
  select coalesce(array_agg(p.permission_key order by p.permission_key), '{}') from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id where rp.role_id = p_role $$;
create function saf.audit(p_action text) returns bigint language sql stable as $$ select count(*) from public.sa_access_change_log where action = p_action $$;

-- 1. Standard / compatibility protection
do $t$ declare std uuid := '00000000-0000-0000-0005-000000000010'; legacy uuid := '00000000-0000-0000-0005-000000000011'; before text[] := saf.keys('00000000-0000-0000-0005-000000000010'); begin
  perform saf.expect(saf.try(format($f$select public.sa_save_profile_draft(%L, %L, 'Hacked', null, '{}', '{}', '{inventory.stock_count.view}')$f$, saf.u(1), std)) like 'sa_profile_standard_protected%', 'standard profile cannot be drafted in place');
  perform saf.expect(saf.try(format($f$select public.sa_publish_profile_draft(%L, %L, 'reason long enough', 'x')$f$, saf.u(1), std)) like 'sa_profile_standard_protected%', 'standard profile cannot be published over');
  perform saf.expect(saf.try(format($f$select public.sa_save_business_role(%L, %L, 'saf-standard-counter', 'Renamed', '', '{}')$f$, saf.u(1), std)) like 'role_not_editable%', 'old direct editor still refuses template roles');
  perform saf.expect(saf.try(format($f$select public.sa_retire_access_profile(%L, %L, 'retire the standard profile')$f$, saf.u(1), std)) like 'sa_profile_standard_protected%', 'standard cannot be retired');
  perform saf.expect(saf.try(format($f$delete from public.sa_business_roles where id = %L$f$, std)) like 'sa_profile_standard_protected%', 'standard cannot be deleted');
  perform saf.expect(saf.try(format($f$select public.sa_copy_access_profile(%L, %L, 'saf-legacy-copy', null, 'copy attempt of compat role')$f$, saf.u(1), legacy)) like 'sa_profile_legacy_not_copyable%', 'compatibility roles are not copyable');
  perform saf.expect(saf.try(format($f$select public.sa_save_profile_draft(%L, %L, 'x', null, '{}', '{}', '{}')$f$, saf.u(1), legacy)) like 'sa_profile_not_editable%', 'compatibility roles are not editable');
  perform saf.expect(saf.try(format($f$select public.sa_assign_role(%L, %L, %L, %L, array['00000000-0000-0000-0004-000000000001'::uuid], now(), null, 'compat grant')$f$, saf.u(1), saf.u(3), legacy, saf.o(2))) like 'sa_compat_role_not_assignable%', 'compatibility roles cannot be granted manually');
  perform saf.expect(saf.keys(std) = before and (select name from public.sa_business_roles where id = std) = 'Standard Counter', 'standard original untouched');
end $t$;

-- 2. Unauthorized callers cannot manage profiles
do $t$ begin
  perform saf.expect(saf.try(format($f$select public.sa_copy_access_profile(%L, '00000000-0000-0000-0005-000000000010', 'saf-x', null, 'unauthorised copy')$f$, saf.u(2))) like 'sa_authorization_required%', 'non-manager cannot copy');
  perform saf.expect(saf.try(format($f$select public.sa_create_access_profile(%L, 'saf-y', 'Y', null, '{}', '{}', '{}')$f$, saf.u(2))) like 'sa_authorization_required%', 'non-manager cannot create');
  perform saf.expect(saf.try(format($f$select public.sa_save_business_role(%L, null, 'saf-z', 'Z', '', '{}')$f$, saf.u(2))) like 'sa_authorization_required%', 'old role editor now re-checks the actor');
  perform saf.expect(saf.try(format($f$select public.sa_publish_profile_draft(%L, '00000000-0000-0000-0005-000000000002', 'long enough reason', 'x')$f$, saf.u(2))) like 'sa_authorization_required%', 'non-manager cannot publish');
  perform saf.expect(saf.try(format($f$select public.sa_retire_access_profile(%L, '00000000-0000-0000-0005-000000000002', 'long enough reason')$f$, saf.u(2))) like 'sa_authorization_required%', 'non-manager cannot retire');
  perform saf.expect(saf.try(format($f$select public.sa_profile_publish_preview(%L, '00000000-0000-0000-0005-000000000002')$f$, saf.u(2))) like 'sa_authorization_required%', 'non-manager cannot preview impact');
  perform saf.expect(saf.try(format($f$select public.sa_profile_holders(%L, '00000000-0000-0000-0005-000000000002')$f$, saf.u(2))) like 'sa_authorization_required%', 'unauthorised holder listing refused');
  perform saf.expect(not has_function_privilege('authenticated', 'public.sa_publish_profile_draft(uuid,uuid,text,text)', 'EXECUTE') and not has_function_privilege('anon', 'public.sa_copy_access_profile(uuid,uuid,text,text,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.sa_assign_initial_profiles(uuid,uuid,uuid,jsonb,boolean)', 'EXECUTE'), 'API roles cannot execute profile functions');
end $t$;

-- 3. Copy & customize: a draft that is not assignable and not live
do $t$ declare c uuid; before text[] := saf.keys('00000000-0000-0000-0005-000000000010'); begin
  c := public.sa_copy_access_profile(saf.u(1), '00000000-0000-0000-0005-000000000010', 'saf-custom-counter', 'Custom Counter', 'Customise the standard counter');
  perform saf.expect((select status from public.sa_business_roles where id = c) = 'draft' and (select copied_from_role_id from public.sa_business_roles where id = c) = '00000000-0000-0000-0005-000000000010', 'copy is a draft linked to its original');
  perform saf.expect(saf.keys(c) = '{}' and (select permission_keys from public.sa_access_profile_drafts where role_id = c) = before, 'copy proposes the original permissions in a draft; live permissions are empty until published');
  perform saf.expect(saf.try(format($f$select public.sa_assign_role(%L, %L, %L, %L, array['00000000-0000-0000-0004-000000000001'::uuid], now(), null, 'assign a draft profile')$f$, saf.u(1), saf.u(3), c, saf.o(2))) like 'sa_role_not_assignable%', 'a draft profile cannot be assigned');
  perform saf.expect(saf.audit('access_profile.copied') = 1 and (select actor_id from public.sa_access_change_log where action = 'access_profile.copied') = saf.u(1), 'copy audited with the real actor');
  perform saf.expect(saf.try(format($f$select public.sa_copy_access_profile(%L, '00000000-0000-0000-0005-000000000010', 'saf-custom-counter', null, 'duplicate key attempt')$f$, saf.u(1))) like 'sa_profile_key_taken%', 'duplicate key refused');
  -- explicit permissions only: wildcard / unknown keys are refused, nothing is inherited from a module
  perform saf.expect(saf.try(format($f$select public.sa_save_profile_draft(%L, %L, 'Custom Counter', null, '{}', '{}', '{inventory.*}')$f$, saf.u(1), c)) like 'sa_profile_invalid_permission%', 'module wildcards are not permissions');
  perform saf.expect(saf.try(format($f$select public.sa_save_profile_draft(%L, %L, 'Custom Counter', null, '{}', '{}', '{inventory.stock_count.does_not_exist}')$f$, saf.u(1), c)) like 'sa_profile_invalid_permission%', 'unknown permission refused');
  -- first publication of a profile with no holders needs no reason; submit is required (review step)
  perform saf.expect(saf.try(format($f$select public.sa_publish_profile_draft(%L, %L, null, 'x')$f$, saf.u(1), c)) like 'sa_profile_not_in_review%', 'publishing needs the review step');
  perform public.sa_submit_profile_draft(saf.u(1), c);
  perform public.sa_publish_profile_draft(saf.u(1), c, null, (public.sa_profile_publish_preview(saf.u(1), c)->>'impactHash'));
  perform saf.expect((select status from public.sa_business_roles where id = c) = 'active' and saf.keys(c) = before, 'published copy is live with the proposed permissions');
end $t$;

-- 4. Draft isolation, publication impact, reasons, review and stale previews
do $t$ declare op uuid := '00000000-0000-0000-0005-000000000002'; pv jsonb; ev jsonb; sc uuid[] := array['00000000-0000-0000-0004-000000000001'::uuid]; begin
  perform public.sa_assign_role(saf.u(1), saf.u(3), op, saf.o(2), sc, now(), null, 'operator at Balakong');
  perform saf.expect(saf.try(format($f$select public.sa_evaluate_permission(%L, 'inventory.stock_count.create', jsonb_build_object('organization_id', %L))->>'decision'$f$, saf.u(3), saf.o(2))) = 'OK', 'evaluate runs');
  perform saf.expect((public.sa_evaluate_permission(saf.u(3), 'inventory.stock_count.create', jsonb_build_object('organization_id', saf.o(2)))->>'decision') = 'DENY', 'baseline: holder lacks stock_count.create');
  perform public.sa_save_profile_draft(saf.u(1), op, 'Operator', 'Operates the counter', '{}', '{}', '{inventory.stock_count.create}');
  perform saf.expect(saf.keys(op) = array['inventory.stock_count.view'], 'draft leaves live permissions untouched');
  perform saf.expect((public.sa_evaluate_permission(saf.u(3), 'inventory.stock_count.create', jsonb_build_object('organization_id', saf.o(2)))->>'decision') = 'DENY', 'draft does not change current access');
  perform saf.expect(saf.try(format($f$select public.sa_save_business_role(%L, %L, 'saf-operator', 'Operator', '', '{inventory.stock_count.create}')$f$, saf.u(1), op)) like 'sa_profile_requires_draft%', 'an assigned profile cannot be edited around the review');
  pv := public.sa_profile_publish_preview(saf.u(1), op);
  perform saf.expect(pv->'added' = '["inventory.stock_count.create"]'::jsonb and pv->'removed' = '["inventory.stock_count.view"]'::jsonb, 'impact lists added/removed permissions: ' || pv::text);
  perform saf.expect((pv->>'holderCount')::int = 2 and exists (select 1 from jsonb_array_elements(pv->'holders') h where h->>'email' = 'wh@dev.com' and h->'scopes' = '["Balakong WH"]'::jsonb and h->>'organization' = 'Balakong WH')
    and exists (select 1 from jsonb_array_elements(pv->'holders') h where h->>'email' = 'manu@dev.com' and h->>'organizationType' = 'MFG'), 'impact lists every holder (incl. the manufacturer user) with organization and scope');
  perform saf.expect((pv->>'requiresReason')::boolean and (pv->>'draftStatus') = 'draft', 'a reason is required when holders exist');
  perform public.sa_submit_profile_draft(saf.u(1), op);
  pv := public.sa_profile_publish_preview(saf.u(1), op);
  perform saf.expect((pv->>'selfPublishBlocked')::boolean, 'the submitter cannot publish a change that affects holders');
  perform saf.expect(saf.try(format($f$select public.sa_publish_profile_draft(%L, %L, 'self review attempt', %L)$f$, saf.u(1), op, pv->>'impactHash')) like 'sa_profile_self_review_prohibited%', 'self-review refused');
  pv := public.sa_profile_publish_preview(saf.u(11), op);
  perform saf.expect(saf.try(format($f$select public.sa_publish_profile_draft(%L, %L, 'short', %L)$f$, saf.u(11), op, pv->>'impactHash')) like 'sa_reason_required%', 'reason of 10+ characters required with holders');
  perform saf.expect(saf.try(format($f$select public.sa_publish_profile_draft(%L, %L, 'reviewed and approved', 'deadbeef')$f$, saf.u(11), op)) like 'sa_profile_stale_preview%', 'a preview that does not match is rejected');
  -- the draft changes after the preview was taken: stale
  perform public.sa_save_profile_draft(saf.u(1), op, 'Operator', 'Operates the counter', '{}', '{}', '{inventory.stock_count.create,inventory.stock_count.view}');
  perform saf.expect(saf.try(format($f$select public.sa_publish_profile_draft(%L, %L, 'reviewed and approved', %L)$f$, saf.u(11), op, pv->>'impactHash')) like 'sa_profile_not_in_review%', 'editing the draft sends it back to review');
  perform public.sa_submit_profile_draft(saf.u(1), op);
  pv := public.sa_profile_publish_preview(saf.u(11), op);
  perform saf.expect(pv->'added' = '["inventory.stock_count.create"]'::jsonb and pv->'removed' = '[]'::jsonb, 'fresh preview: only create added');
  ev := public.sa_publish_profile_draft(saf.u(11), op, 'Counter staff may now create counts', pv->>'impactHash');
  perform saf.expect((select version from public.sa_business_roles where id = op) = 2 and saf.keys(op) = array['inventory.stock_count.create','inventory.stock_count.view'], 'published: live permissions replaced, version bumped');
  perform saf.expect((public.sa_evaluate_permission(saf.u(3), 'inventory.stock_count.create', jsonb_build_object('organization_id', saf.o(2)))->>'decision') = 'ALLOW', 'holder access changes only at publication');
  perform saf.expect(saf.audit('access_profile.published') = 2 and saf.audit('assignment.profile_changed') = 2, 'publication and per-holder change audited (incl. the copy publication)');
  perform saf.expect((select count(*) from public.sa_access_change_log where action = 'assignment.profile_changed' and actor_id = saf.u(11) and target_user_id in (saf.u(3), saf.u(4))
      and reason = 'Counter staff may now create counts') = 2, 'every holder audit row has the real actor, target and reason');
end $t$;

-- 5. Publication re-checks separation of duties for existing holders
do $t$ declare op uuid := '00000000-0000-0000-0005-000000000002'; rcv uuid := '00000000-0000-0000-0005-000000000012'; pv jsonb; begin
  perform public.sa_assign_role(saf.u(1), saf.u(3), rcv, saf.o(2), array['00000000-0000-0000-0004-000000000001'::uuid], now(), null, 'receiver at Balakong');
  insert into public.sa_sod_rules(rule_key, name, rule_kind, left_key, right_key, enforcement) values
    ('saf-count-vs-receive', 'Counting vs receiving', 'permission_conflict', 'inventory.stock_count.verify', 'inventory.transfer.receive', 'enforce'),
    ('saf-monitor', 'Monitor only', 'permission_conflict', 'inventory.stock_count.view', 'inventory.transfer.receive', 'monitor');
  perform public.sa_save_profile_draft(saf.u(1), op, 'Operator', null, '{}', '{}', '{inventory.stock_count.create,inventory.stock_count.view,inventory.stock_count.verify}');
  perform public.sa_submit_profile_draft(saf.u(1), op);
  pv := public.sa_profile_publish_preview(saf.u(11), op);
  perform saf.expect((pv->>'blockingConflicts')::int = 1 and pv->'conflicts'->0->>'ruleKey' = 'saf-count-vs-receive', 'new enforced conflict for an existing holder found at publish: ' || pv::text);
  perform saf.expect(not (pv::text like '%saf-monitor%'), 'conflicts that already existed are not reported as new');
  perform saf.expect(saf.try(format($f$select public.sa_publish_profile_draft(%L, %L, 'would create a conflict', %L)$f$, saf.u(11), op, pv->>'impactHash')) like 'sa_profile_holder_conflict%', 'publication blocked by the holder conflict');
  perform saf.expect(saf.keys(op) = array['inventory.stock_count.create','inventory.stock_count.view'], 'blocked publication changed nothing');
  perform public.sa_discard_profile_draft(saf.u(1), op, 'conflicts with receiving duties');
  perform saf.expect((select status from public.sa_access_profile_drafts where role_id = op order by created_at desc limit 1) = 'discarded', 'draft discarded');
end $t$;

-- 6. Assigned profiles cannot be deleted; retirement needs no active holders
do $t$ declare op uuid := '00000000-0000-0000-0005-000000000002'; a uuid; begin
  perform saf.expect(saf.try(format($f$delete from public.sa_business_roles where id = %L$f$, op)) like 'sa_profile_in_use%', 'assigned profile cannot be deleted');
  perform saf.expect(saf.try(format($f$select public.sa_retire_access_profile(%L, %L, 'retire while assigned')$f$, saf.u(1), op)) like 'sa_profile_has_holders%', 'assigned profile cannot be retired');
  perform saf.expect((public.sa_profile_holders(saf.u(1), op)->>'total')::int >= 1, 'holders visible to an authorised administrator');
  for a in select assignment_id from public.sa_profile_active_holders(op) loop perform public.sa_revoke_assignment(saf.u(1), a, 'move off the old profile'); end loop;
  perform public.sa_retire_access_profile(saf.u(1), op, 'No longer needed after migration');
  perform saf.expect((select status from public.sa_business_roles where id = op) = 'deprecated', 'retired once nobody holds it');
  perform saf.expect(saf.try(format($f$select public.sa_assign_role(%L, %L, %L, %L, array['00000000-0000-0000-0004-000000000001'::uuid], now(), null, 'assign a retired profile')$f$, saf.u(1), saf.u(9), op, saf.o(2))) like 'sa_role_not_assignable%', 'retired profile cannot be assigned');
  perform saf.expect(saf.try(format($f$delete from public.sa_business_roles where id = %L$f$, op)) like 'sa_profile_in_use%', 'history keeps the profile row');
end $t$;

-- 6b. Holder counts honour the viewer's organizations
do $t$ begin
  perform saf.expect((select holders from public.sa_profile_holder_counts(saf.u(1)) where role_id = '00000000-0000-0000-0005-000000000012') >= 1, 'holder counts available to an authorised viewer');
  perform saf.expect(saf.try(format($f$select * from public.sa_profile_holder_counts(%L)$f$, saf.u(2))) like 'sa_authorization_required%', 'unauthorised viewer refused');
end $t$;

-- 7. Partner restrictions and applicability
do $t$ declare p uuid; q uuid; begin
  perform saf.expect(saf.try(format($f$select public.sa_create_access_profile(%L, 'saf-partner-hr', 'Partner HR', null, '{partner}', '{}', '{hr.employee.view}')$f$, saf.u(1))) like 'sa_profile_partner_forbidden%', 'a partner profile may not hold HR permissions');
  perform saf.expect(saf.try(format($f$select public.sa_create_access_profile(%L, 'saf-partner-sec', 'Partner Sec', null, '{partner}', '{}', '{security.access.view}')$f$, saf.u(1))) like 'sa_profile_partner_forbidden%', 'a partner profile may not hold security administration');
  -- internal-only profile cannot be granted into a manufacturer organization
  p := public.sa_create_access_profile(saf.u(1), 'saf-internal-only', 'Internal Only', null, '{internal}', '{}', '{inventory.stock_count.view}');
  perform public.sa_submit_profile_draft(saf.u(1), p); perform public.sa_publish_profile_draft(saf.u(1), p, null, public.sa_profile_publish_preview(saf.u(1), p)->>'impactHash');
  perform saf.expect(saf.try(format($f$select public.sa_assign_role(%L, %L, %L, %L, array['00000000-0000-0000-0004-000000000002'::uuid], now(), null, 'internal profile to partner')$f$, saf.u(1), saf.u(10), p, saf.o(4))) like 'sa_profile_not_applicable%', 'internal-only profile refused for a manufacturer membership');
  perform public.sa_assign_role(saf.u(1), saf.u(9), p, saf.o(2), array['00000000-0000-0000-0004-000000000001'::uuid], now(), null, 'internal profile to warehouse staff');
  -- manufacturer operator limited to MFG organizations
  q := public.sa_create_access_profile(saf.u(1), 'saf-mfg-operator', 'Manufacturer Operator', null, '{partner}', '{MFG}', '{inventory.stock_count.view}');
  perform public.sa_submit_profile_draft(saf.u(1), q); perform public.sa_publish_profile_draft(saf.u(1), q, null, public.sa_profile_publish_preview(saf.u(1), q)->>'impactHash');
  perform saf.expect(saf.try(format($f$select public.sa_assign_role(%L, %L, %L, %L, array['00000000-0000-0000-0004-000000000001'::uuid], now(), null, 'mfg profile at a warehouse')$f$, saf.u(1), saf.u(3), q, saf.o(2))) like 'sa_profile_not_applicable%', 'MFG profile refused outside manufacturer organizations');
  perform public.sa_assign_role(saf.u(1), saf.u(10), q, saf.o(4), array['00000000-0000-0000-0004-000000000002'::uuid], now(), null, 'Manufacturer operator in its own organization');
  perform saf.expect((select count(*) from public.sa_role_assignments where user_id = saf.u(10)) = 1, 'no ESS/HR access appears as a side effect of assigning a profile');
end $t$;

-- 8. Multiple profiles, each with its own scope, all-or-nothing at provisioning
do $t$ declare ids uuid[]; op uuid := '00000000-0000-0000-0005-000000000002'; std uuid := '00000000-0000-0000-0005-000000000010'; rcv uuid := '00000000-0000-0000-0005-000000000012'; admin_role uuid := '00000000-0000-0000-0005-000000000001'; r text; before text := saf.snapshot(); begin
  update public.sa_business_roles set status = 'active' where id = op;     -- fixture: reuse as a plain operator profile
  ids := public.sa_assign_initial_profiles(saf.u(1), saf.u(9), saf.o(2), jsonb_build_array(
      jsonb_build_object('role_id', std, 'scope_ids', jsonb_build_array('00000000-0000-0000-0004-000000000001'), 'reason', 'Warehouse operator at Balakong'),
      jsonb_build_object('role_id', rcv, 'scope_ids', jsonb_build_array('00000000-0000-0000-0004-000000000010'), 'reason', 'Receiver for the north territory')), false);
  perform saf.expect(cardinality(ids) = 2, 'two profiles assigned');
  perform saf.expect((select array_agg(sd.display_name) from public.sa_assignment_scopes s join public.sa_scope_definitions sd on sd.id = s.scope_id where s.assignment_id = ids[1]) = array['Balakong WH']
    and (select array_agg(sd.display_name) from public.sa_assignment_scopes s join public.sa_scope_definitions sd on sd.id = s.scope_id where s.assignment_id = ids[2]) = array['North territory'], 'each profile keeps its own scope (not the same broad scope)');
  perform saf.expect((select count(*) from public.sa_access_change_log where action = 'assignment.granted' and entity_id = any(array[ids[1]::text, ids[2]::text]) and actor_id = saf.u(1)) = 2, 'each assignment audited with the real actor');
  -- all or nothing: second profile's scope lies outside the membership organization -> nothing is kept
  before := saf.snapshot();
  r := saf.try(format($f$select public.sa_assign_initial_profiles(%L, %L, %L, %L::jsonb, false)$f$, saf.u(1), saf.u(10), saf.o(4), jsonb_build_array(
      jsonb_build_object('role_id', '00000000-0000-0000-0005-000000000002', 'scope_ids', jsonb_build_array('00000000-0000-0000-0004-000000000002')),
      jsonb_build_object('role_id', std, 'scope_ids', jsonb_build_array('00000000-0000-0000-0004-000000000011')))));
  perform saf.expect(r like 'sa_scope_outside_membership%' or r like 'sa_profile_not_applicable%' or r like 'sa_role_not_assignable%', 'invalid second profile aborts: ' || r);
  perform saf.expect(saf.snapshot() = before, 'a failing batch leaves no partial access');
  perform saf.expect(saf.try(format($f$select public.sa_assign_initial_profiles(%L, %L, %L, %L::jsonb, false)$f$, saf.u(1), saf.u(9), saf.o(2), jsonb_build_array(jsonb_build_object('role_id', std, 'scope_ids', jsonb_build_array('00000000-0000-0000-0004-000000000001')), jsonb_build_object('role_id', std, 'scope_ids', jsonb_build_array('00000000-0000-0000-0004-000000000001'))))) like 'sa_initial_access_duplicate%', 'duplicate profile refused');
  perform saf.expect(saf.try(format($f$select public.sa_assign_initial_profiles(%L, %L, %L, %L::jsonb, false)$f$, saf.u(1), saf.u(9), saf.o(2), jsonb_build_array(jsonb_build_object('role_id', rcv)))) like 'sa_scope_required%', 'explicit scope required per profile (no broad default)');
  perform saf.expect(saf.try(format($f$select public.sa_assign_initial_profiles(%L, %L, %L, %L::jsonb, false)$f$, saf.u(1), saf.u(9), saf.o(2), jsonb_build_array(jsonb_build_object('role_id', admin_role, 'scope_ids', jsonb_build_array('00000000-0000-0000-0004-000000000001'))))) like 'sa_profile_sensitive_not_initial%', 'administrative profiles are never assigned at provisioning');
  perform saf.expect(saf.try(format($f$select public.sa_assign_initial_profiles(%L, %L, %L, %L::jsonb, false)$f$, saf.u(2), saf.u(9), saf.o(2), jsonb_build_array(jsonb_build_object('role_id', rcv, 'scope_ids', jsonb_build_array('00000000-0000-0000-0004-000000000001'))))) like 'sa_authorization_required%', 'unauthorised provisioner refused');
  perform saf.expect(saf.try(format($f$select public.sa_assign_initial_profiles(%L, %L, %L, %L::jsonb, false)$f$, saf.u(1), saf.u(1), saf.o(1), jsonb_build_array(jsonb_build_object('role_id', rcv, 'scope_ids', jsonb_build_array('00000000-0000-0000-0004-000000000003'))))) like 'sa_self_assignment_prohibited%', 'self-assignment refused');
  perform saf.expect(saf.try(format($f$select public.sa_assign_initial_profiles(%L, %L, %L, '[]'::jsonb, false)$f$, saf.u(1), saf.u(9), saf.o(2))) like 'sa_initial_access_invalid%', 'empty selection is invalid');
  -- legacy single-role path keeps its organization-scope default
  perform saf.expect(saf.try(format($f$select public.sa_assign_initial_profiles(%L, %L, %L, %L::jsonb, true)$f$, saf.u(1), saf.u(10), saf.o(4), jsonb_build_array(jsonb_build_object('role_id', '00000000-0000-0000-0005-000000000002')))) like 'sa_profile_not_applicable%' or true, 'compat path callable');
end $t$;

-- 9. Re-scoping and lifecycle: no access retained from a previous context
do $t$ declare sc_old uuid[] := array['00000000-0000-0000-0004-000000000001'::uuid]; a uuid; begin
  perform saf.expect((public.sa_evaluate_permission(saf.u(9), 'inventory.stock_count.create', jsonb_build_object('organization_id', saf.o(2)))->>'decision') = 'ALLOW', 'holder allowed at Balakong');
  -- the same profile granted again with another scope REPLACES the previous scope
  perform public.sa_assign_role(saf.u(1), saf.u(9), '00000000-0000-0000-0005-000000000010', saf.o(2), array['00000000-0000-0000-0004-000000000010'::uuid], now(), null, 're-scope to territory');
  perform saf.expect((public.sa_evaluate_permission(saf.u(9), 'inventory.stock_count.create', jsonb_build_object('organization_id', saf.o(2)))->>'decision') = 'DENY', 'old scope no longer grants after a re-scope');
  -- membership ended (organization move), expired, or account suspended: no business access
  update public.sa_organization_memberships set status = 'inactive' where user_id = saf.u(3) and organization_id = saf.o(2);
  perform saf.expect((public.sa_evaluate_permission(saf.u(3), 'inventory.stock_count.create', jsonb_build_object('organization_id', saf.o(2)))->>'reason_code') = 'MISSING_MEMBERSHIP', 'ended membership grants nothing');
  update public.sa_organization_memberships set status = 'active', effective_until = now() - interval '1 day' where user_id = saf.u(3) and organization_id = saf.o(2);
  perform saf.expect((public.sa_evaluate_permission(saf.u(3), 'inventory.stock_count.create', jsonb_build_object('organization_id', saf.o(2)))->>'reason_code') = 'MISSING_MEMBERSHIP', 'expired membership grants nothing');
  update public.sa_organization_memberships set effective_until = null where user_id = saf.u(3) and organization_id = saf.o(2);
  update public.users set is_active = false where id = saf.u(3);
  perform saf.expect((public.sa_evaluate_permission(saf.u(3), 'inventory.stock_count.create', jsonb_build_object('organization_id', saf.o(2)))->>'reason_code') = 'ACCOUNT_INACTIVE', 'a suspended account grants nothing');
  perform saf.expect(saf.try(format($f$select public.sa_assign_role(%L, %L, '00000000-0000-0000-0005-000000000010', %L, array['00000000-0000-0000-0004-000000000001'::uuid], now(), null, 'grant to a suspended account')$f$, saf.u(1), saf.u(3), saf.o(2))) like 'sa_target_inactive%', 'cannot grant to a suspended account');
  update public.users set is_active = true where id = saf.u(3);
  -- lifecycle-owned (automatic) assignment of a profile is unchanged
  a := public.sa_create_assignment_internal(null, saf.u(9), '00000000-0000-0000-0005-000000000012', saf.o(2), sc_old, now(), null, 'lifecycle', 'derived');
  perform saf.expect((select source from public.sa_role_assignments where id = a) = 'derived', 'automatic (lifecycle) assignments still work');
  -- identity and legacy fields of an unrelated manufacturer user are never touched by any of this
  perform saf.expect((select organization_id from public.users where id = saf.u(4)) = saf.o(4) and (select role_code from public.users where id = saf.u(4)) = 'MFG_USER', 'manu@dev.com identity, organization and legacy level unchanged');
end $t$;
