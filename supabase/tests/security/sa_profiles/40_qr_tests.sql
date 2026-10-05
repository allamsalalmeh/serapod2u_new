-- QR Batch Operator: discoverability, applicability, held access, manufacturer party scope, HQ regression.
create function saf.as_user(p_uid uuid, p_sql text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', p_uid)::text, true);
  perform set_config('role', 'authenticated', true);
  begin execute p_sql; perform set_config('role', 'none', true); perform set_config('request.jwt.claims', '', true); return 'OK';
  exception when others then perform set_config('role', 'none', true); perform set_config('request.jwt.claims', '', true); return sqlerrm; end;
end $$;
create function saf.count_as(p_uid uuid, p_sql text) returns bigint language plpgsql as $$
declare v bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', p_uid)::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into v;
  perform set_config('role', 'none', true); perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

-- people: internal staff, manufacturers (two), a distributor
insert into public.organizations(id, org_name, org_type_code) values (saf.o(6), 'North Distributor', 'DIST');
insert into auth.users(id, email) values (saf.u(12), 'dist@dev.com');
insert into public.users(id, email, full_name, role_code, organization_id, is_active) values (saf.u(12), 'dist@dev.com', 'Dist User', 'MFG_USER', saf.o(6), true);
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status) values (saf.u(12), saf.o(6), 'partner', true, 'active');
update public.users set principal_type = case when id in (saf.u(4), saf.u(5), saf.u(7), saf.u(10)) then 'MANUFACTURER_USER' when id = saf.u(12) then 'DISTRIBUTOR_USER' else 'INTERNAL_EMPLOYEE' end;

-- 1. The profile exists, is standard, narrow and applicable to HQ + manufacturer only
do $t$ declare r record; begin
  select * into r from public.sa_business_roles where role_key = 'qr-batch-operator';
  perform saf.expect(r.source = 'template' and r.status = 'active' and r.name = 'QR Batch Operator', 'standard profile present and active');
  perform saf.expect((select array_agg(p.permission_key) from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id where rp.role_id = r.id) = array['qr.batch.manage'], 'contains ONLY qr.batch.manage (no warehouse, order approval or security rights)');
  perform saf.expect(r.applicable_org_types = array['HQ','MFG'], 'applies to HQ and manufacturer organizations');
  perform saf.expect((select count(*) from public.sa_business_roles where role_key = 'qr-batch-operator') = 1 and (select count(*) from public.sa_business_role_permissions where role_id = r.id) = 1, 'migration is idempotent');
  perform saf.expect(not public.sa_profile_sensitive(r.id) and (select count(*) from public.sa_profile_active_holders(r.id)) = 0, 'not administrative, not assigned by the migration');
  perform saf.expect(saf.try(format($f$select public.sa_save_profile_draft(%L, %L, 'x', null, '{}', '{}', '{qr.batch.manage}')$f$, saf.u(1), r.id)) like 'sa_profile_standard_protected%', 'standard original is protected');
end $t$;

-- 2. Applicability and grant authority
do $t$ declare p uuid := (select id from public.sa_business_roles where role_key = 'qr-batch-operator'); scope_manu uuid[] := array['00000000-0000-0000-0004-000000000002'::uuid]; begin
  update public.sa_migration_modes set mode = 'SHADOW' where permission_key in ('security.access.view','security.role.assign','security.role.manage');
  perform saf.expect(saf.try(format($f$select public.sa_assign_role(%L, %L, %L, %L, %L, now(), null, 'qr operator to a warehouse user')$f$, saf.u(1), saf.u(3), p, saf.o(2), array['00000000-0000-0000-0004-000000000001'::uuid])) like 'sa_profile_not_applicable%', 'not applicable to a warehouse organization');
  insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name) values ('00000000-0000-0000-0004-000000000013', saf.o(6), 'organization', saf.o(6)::text, 'North Distributor');
  perform saf.expect(saf.try(format($f$select public.sa_assign_role(%L, %L, %L, %L, %L, now(), null, 'qr operator to a distributor')$f$, saf.u(1), saf.u(12), p, saf.o(6), array['00000000-0000-0000-0004-000000000013'::uuid])) like 'sa_profile_not_applicable%', 'not applicable to a distributor');
  perform saf.expect(saf.try(format($f$select public.sa_assign_role(%L, %L, %L, %L, %L, now(), null, 'self grant attempt')$f$, saf.u(4), saf.u(4), p, saf.o(4), scope_manu)) like 'sa_self_assignment_prohibited%', 'a manufacturer cannot self-grant');
  perform saf.expect(saf.try(format($f$select public.sa_assign_role(%L, %L, %L, %L, %L, now(), null, 'unauthorised admin attempt')$f$, saf.u(2), saf.u(4), p, saf.o(4), scope_manu)) like 'sa_authorization_required%', 'a non-administrator cannot grant');
  perform saf.expect(saf.try(format($f$select public.sa_assign_role(%L, %L, %L, %L, %L, now(), null, 'other org membership')$f$, saf.u(1), saf.u(4), p, saf.o(5), scope_manu)) like 'sa_membership_required%', 'cannot grant on a membership the person does not have');
  perform public.sa_assign_role(saf.u(1), saf.u(4), p, saf.o(4), scope_manu, now(), null, 'QR batch work for the manufacturer');
  insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name) values ('00000000-0000-0000-0004-000000000014', saf.o(5), 'organization', saf.o(5)::text, 'Other Manufacturer');
  perform public.sa_assign_role(saf.u(1), saf.u(7), p, saf.o(5), array['00000000-0000-0000-0004-000000000014'::uuid], now(), null, 'other manufacturer operator');
  perform saf.expect((select count(*) from public.sa_role_assignments a where a.role_id = p and a.user_id in (saf.u(4), saf.u(7)) and a.status = 'active') = 2, 'manufacturer memberships received the profile');
  perform saf.expect((select organization_id from public.users where id = saf.u(4)) = saf.o(4) and (select role_code from public.users where id = saf.u(4)) = 'MFG_USER', 'manu@dev.com identity, organization and level untouched');
end $t$;

-- 3. Ownership: H2M orders are owned by HQ and placed WITH a manufacturer (seller_org_id)
insert into public.orders(id, order_type, status, seller_org_id, buyer_org_id, company_id) values
  ('00000000-0000-0000-0006-000000000001', 'H2M', 'approved', saf.o(4), saf.o(1), saf.o(1)),   -- Manu's order
  ('00000000-0000-0000-0006-000000000002', 'H2M', 'approved', saf.o(5), saf.o(1), saf.o(1));   -- other manufacturer's order
insert into public.qr_batches(id, order_id, company_id, status) values
  ('00000000-0000-0000-0007-000000000001', '00000000-0000-0000-0006-000000000001', saf.o(1), 'generated'),
  ('00000000-0000-0000-0007-000000000002', '00000000-0000-0000-0006-000000000002', saf.o(1), 'generated');

do $t$ declare r text; b1 text := '00000000-0000-0000-0007-000000000001'; b2 text := '00000000-0000-0000-0007-000000000002'; begin
  -- both batches carry the HQ as company_id: the batch alone does not identify the manufacturer
  perform saf.expect((select count(distinct company_id) from public.qr_batches) = 1 and (select company_id from public.qr_batches limit 1) = saf.o(1), 'qr_batches.company_id is the HQ for both manufacturers');
  perform saf.expect(saf.as_user(saf.u(4), format($f$select public.mark_batch_as_printed(%L)$f$, b2)) like 'sa_authorization_required%', 'manufacturer cannot print-mark another manufacturer batch');
  perform saf.expect((select status from public.qr_batches where id = b2::uuid) = 'generated', 'the other manufacturer batch is unchanged');
  r := saf.as_user(saf.u(4), format($f$select public.mark_batch_as_printed(%L)$f$, b1));
  perform saf.expect(r = 'OK' and (select status from public.qr_batches where id = b1::uuid) = 'printing', 'manufacturer can print-mark its own order batch: ' || r);
  perform saf.expect(saf.as_user(saf.u(7), format($f$select public.mark_batch_as_printed(%L)$f$, b1)) like 'sa_authorization_required%', 'the other manufacturer is denied Manu batch');
  perform saf.expect(saf.as_user(saf.u(7), format($f$select public.mark_batch_as_printed(%L)$f$, b2)) = 'OK', 'the other manufacturer handles its own batch');
  update public.qr_batches set status = 'generated';
  -- HQ regression: internal staff are unchanged (not narrowed to a manufacturer party)
  perform saf.expect(saf.as_user(saf.u(1), format($f$select public.mark_batch_as_printed(%L)$f$, b1)) = 'OK' and saf.as_user(saf.u(1), format($f$select public.mark_batch_as_printed(%L)$f$, b2)) = 'OK', 'HQ staff behaviour unchanged for every batch');
  perform saf.expect((select count(*) from public.sa_function_guard_injections where function_signature like '%mark_batch_as_printed%') = 1 and (select guard_marker from public.sa_function_guard_injections where function_signature like '%mark_batch_as_printed%') = '/* sa-guard:qr.batch.party */', 'party guard recorded');
  perform saf.expect((select count(*) from regexp_matches(pg_get_functiondef('public.mark_batch_as_printed(uuid)'::regprocedure), 'sa_assert_qr_batch_party', 'g')) = 1, 'party guard injected exactly once (idempotent)');
  update public.qr_batches set status = 'generated';
end $t$;

-- 4. Under NEW_ENFORCED the S&A decision applies and the party rule still bounds the batch
do $t$ declare b1 text := '00000000-0000-0000-0007-000000000001'; b2 text := '00000000-0000-0000-0007-000000000002'; begin
  update public.sa_migration_modes set mode = 'NEW_ENFORCED' where permission_key = 'qr.batch.manage';
  perform saf.expect(saf.as_user(saf.u(4), format($f$select public.mark_batch_as_printed(%L)$f$, b1)) = 'OK', 'profile holder passes the S&A decision for its own batch');
  update public.qr_batches set status = 'generated';
  perform saf.expect(saf.as_user(saf.u(4), format($f$select public.mark_batch_as_printed(%L)$f$, b2)) like 'sa_authorization_required%', 'holder still cannot reach another manufacturer batch');
  perform saf.expect(saf.as_user(saf.u(10), format($f$select public.mark_batch_as_printed(%L)$f$, b1)) like 'sa_authorization_required%', 'a manufacturer user WITHOUT the profile is denied by S&A');
  update public.sa_migration_modes set mode = 'SHADOW' where permission_key = 'qr.batch.manage';
end $t$;

-- 5. Read access: a manufacturer reads only its own batches; others unchanged
do $t$ begin
  perform saf.expect(saf.count_as(saf.u(4), 'select count(*) from public.qr_batches') = 1, 'Manu reads only its own batch');
  perform saf.expect(saf.count_as(saf.u(7), $q$select count(*) from public.qr_batches where order_id = '00000000-0000-0000-0006-000000000001'$q$) = 0, 'the other manufacturer cannot read Manu batch');
  perform saf.expect(saf.count_as(saf.u(1), 'select count(*) from public.qr_batches') = 2, 'HQ staff read every batch (unchanged)');
  perform saf.expect(saf.count_as(saf.u(12), 'select count(*) from public.qr_batches') = 2, 'distributor partner read unchanged');
  perform saf.expect(saf.count_as(saf.u(2), 'select count(*) from public.qr_batches') = 2, 'internal staff read unchanged');
end $t$;
