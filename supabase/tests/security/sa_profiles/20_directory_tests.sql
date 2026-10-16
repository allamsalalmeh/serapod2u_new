-- Legacy modes (the seeded default): the central Super Admin (role level 1) is authorized for every organization.
do $t$ declare snap text := saf.snapshot(); r jsonb; begin
  perform saf.expect((select mode from public.sa_migration_modes where permission_key = 'security.access.view') in ('SHADOW','LEGACY_ENFORCED'), 'access.view starts on a legacy mode');
  -- 1. central admin finds the manufacturer user in another organization, beyond 700 filler rows
  r := public.sa_directory_page(saf.u(1), null, 'manu@dev', 'all', 25, 0);
  perform saf.expect((r->>'total')::int = 1 and r->'ids'->>0 = saf.u(4)::text, 'search finds manu@dev.com across organizations: ' || r::text);
  r := public.sa_directory_page(saf.u(1), null, 'Bulk Person 0700', 'all', 25, 0);
  perform saf.expect((r->>'total')::int = 1, 'finds a user beyond the first page / 500');
  -- 4. pagination: no silent truncation, stable ordering
  r := public.sa_directory_page(saf.u(1), null, null, 'all', 100, 0);
  perform saf.expect(jsonb_array_length(r->'ids') = 100 and (r->>'total')::int = 708 and (r->'counts'->>'all')::int = 708, 'total counts everyone (708), page size capped at 100: ' || (r->>'total'));
  perform saf.expect((public.sa_directory_page(saf.u(1), null, null, 'all', 100, 700)->'ids') is not null and jsonb_array_length(public.sa_directory_page(saf.u(1), null, null, 'all', 100, 700)->'ids') = 8, 'last page has the remaining 8');
  -- organization filter + consistent counts
  r := public.sa_directory_page(saf.u(1), saf.o(4), null, 'all', 25, 0);
  perform saf.expect((r->>'total')::int = 2 and (r->'counts'->>'all')::int = 2 and (r->'counts'->>'none')::int = 1, 'manufacturer org: manu + no-membership user, one with no membership');
  perform saf.expect((public.sa_directory_page(saf.u(1), saf.o(4), null, 'none', 25, 0)->'ids'->>0) = saf.u(5)::text, 'no-membership filter');
  perform saf.expect((public.sa_directory_page(saf.u(1), saf.o(1), null, 'inactive', 25, 0)->>'total')::int = 1, 'inactive filter inside HQ');
  perform saf.expect((public.sa_directory_page(saf.u(1), saf.o(4), 'MANU', 'all', 25, 0)->>'total')::int = 2 and (public.sa_directory_page(saf.u(1), null, 'no_such%', 'all', 25, 0)->>'total')::int = 0, 'search is case-insensitive and wildcard-safe');
  -- 2. a non-super-admin (legacy mode) is not authorized at all
  perform saf.expect(saf.try($$select public.sa_directory_page(saf.u(2), null, null, 'all', 25, 0)$$) like 'sa_authorization_required%', 'legacy-mode org admin denied');
  perform saf.expect(saf.try($$select public.sa_directory_page(saf.u(6), null, null, 'all', 25, 0)$$) like 'sa_authorization_required%', 'inactive actor denied');
  perform saf.expect(saf.try($$select public.sa_directory_page(null, null, null, 'all', 25, 0)$$) like 'sa_authorization_required%', 'no actor denied');
  perform saf.expect(saf.try($$select public.sa_directory_page(saf.u(1), null, null, 'bogus', 25, 0)$$) like 'sa_directory_filter_invalid%', 'invalid filter rejected');
  -- 6. nothing was mutated by viewing/searching
  perform saf.expect(saf.snapshot() = snap, 'directory calls mutated nothing');
end $t$;

-- Organization list: org + type, counts
do $t$ declare n int; begin
  perform saf.expect((select org_type_code from public.sa_directory_organizations(saf.u(1)) where organization_id = saf.o(4)) = 'MFG', 'manufacturer org listed with its type');
  perform saf.expect((select count(*) from public.sa_directory_organizations(saf.u(2))) = 0, 'unauthorized actor sees no organizations');
end $t$;

-- Grant eligibility is computed separately from visibility
do $t$ begin
  perform saf.expect((select grantable from public.sa_directory_visible_memberships(saf.u(1), array[saf.u(4)])), 'central admin may grant to the manufacturer membership');
  perform saf.expect(not (select grantable from public.sa_directory_visible_memberships(saf.u(1), array[saf.u(1)])) and (select blocked_reason from public.sa_directory_visible_memberships(saf.u(1), array[saf.u(1)])) = 'self', 'self is never grantable');
  perform saf.expect((select count(*) from public.sa_directory_visible_memberships(saf.u(1), array[saf.u(5)])) = 0, 'no-membership user has nothing to grant on');
  perform saf.expect((select count(*) from public.sa_directory_visible_memberships(saf.u(2), array[saf.u(4)])) = 0, 'unauthorized actor sees no memberships');
end $t$;

-- NEW_ENFORCED semantics: the legacy super-admin flag no longer implies reach; only S&A assignments + scope do.
do $t$ declare r jsonb; a uuid; begin
  update public.sa_migration_modes set mode = 'NEW_ENFORCED' where permission_key in ('security.access.view', 'security.role.assign');
  perform saf.expect((select count(*) from public.sa_authorized_organizations(saf.u(1), 'security.access.view')) = 0, 'HQ membership / legacy level alone imply nothing once NEW_ENFORCED');
  -- orgadmin: People Admin on the Balakong warehouse organization scope only
  a := public.sa_create_assignment_internal(saf.u(1), saf.u(2), '00000000-0000-0000-0005-000000000001', saf.o(2), array['00000000-0000-0000-0004-000000000001'::uuid], now(), null, 'fixture', 'manual');
  perform saf.expect((select array_agg(organization_id order by organization_id) from public.sa_authorized_organizations(saf.u(2), 'security.access.view')) = array[saf.o(2)], 'org-scoped admin authorized only for their organization');
  r := public.sa_directory_page(saf.u(2), null, null, 'all', 25, 0);
  perform saf.expect((r->>'total')::int = 2, 'org admin sees Balakong people only (admin, warehouse user): ' || r::text);
  perform saf.expect((public.sa_directory_page(saf.u(2), null, 'manu', 'all', 25, 0)->>'total')::int = 0, '2. cannot search unauthorized manufacturer user');
  perform saf.expect((public.sa_directory_page(saf.u(2), null, 'bulk', 'all', 25, 0)->>'total')::int = 0, 'cannot search HQ users');
  -- 3. forged organization ids are rejected
  perform saf.expect(saf.try(format($f$select public.sa_directory_page(%L, %L, null, 'all', 25, 0)$f$, saf.u(2), saf.o(4))) like 'sa_directory_org_forbidden%', 'forged manufacturer org rejected');
  perform saf.expect(saf.try(format($f$select public.sa_directory_page(%L, %L, null, 'all', 25, 0)$f$, saf.u(2), saf.o(1))) like 'sa_directory_org_forbidden%', 'HQ org not implied');
  perform saf.expect(saf.try(format($f$select public.sa_directory_page(%L, %L, null, 'all', 25, 0)$f$, saf.u(2), gen_random_uuid())) like 'sa_directory_org_forbidden%', 'random org id rejected');
  perform saf.expect(saf.try(format($f$select public.sa_directory_page(%L, null, null, 'all', 25, 0)$f$, saf.u(8))) like 'sa_authorization_required%', 'HQ-only member (no assignment) gets nothing');
  -- an HQ-scoped assignment covers HQ descendants (Balakong, Alma) but not the independent manufacturer
  perform public.sa_create_assignment_internal(saf.u(1), saf.u(8), '00000000-0000-0000-0005-000000000001', saf.o(1), array['00000000-0000-0000-0004-000000000003'::uuid], now(), null, 'fixture', 'manual');
  perform saf.expect((select array_agg(organization_id order by organization_id) from public.sa_authorized_organizations(saf.u(8), 'security.access.view')) = array[saf.o(1), saf.o(2), saf.o(3)], 'HQ scope covers its own subtree only');
  perform saf.expect((public.sa_directory_page(saf.u(8), null, 'manu@dev', 'all', 25, 0)->>'total')::int = 0, 'HQ administrator cannot see an unrelated manufacturer');
end $t$;

-- 7. Target-organization authorization and self-grant are enforced at assignment time, independent of visibility
do $t$ declare scope_manu uuid[] := array['00000000-0000-0000-0004-000000000002'::uuid]; scope_bal uuid[] := array['00000000-0000-0000-0004-000000000001'::uuid]; begin
  perform saf.expect(saf.try(format($f$select public.sa_assign_role(%L, %L, '00000000-0000-0000-0005-000000000002', %L, %L, now(), null, 'cross-org attempt')$f$, saf.u(2), saf.u(4), saf.o(4), scope_manu)) like 'sa_authorization_required%', 'org admin cannot grant in the manufacturer organization');
  perform saf.expect(saf.try(format($f$select public.sa_assign_role(%L, %L, '00000000-0000-0000-0005-000000000002', %L, %L, now(), null, 'self attempt')$f$, saf.u(2), saf.u(2), saf.o(2), scope_bal)) like 'sa_self_assignment_prohibited%', 'self-grant refused');
  perform saf.expect(saf.try(format($f$select public.sa_assign_role(%L, %L, '00000000-0000-0000-0005-000000000002', %L, %L, now(), null, 'scope outside org')$f$, saf.u(2), saf.u(3), saf.o(2), scope_manu)) like 'sa_scope_outside_membership%', 'scope outside the membership organization refused');
  perform saf.expect(saf.try(format($f$select public.sa_assign_role(%L, %L, '00000000-0000-0000-0005-000000000002', %L, %L, now(), null, 'no membership here')$f$, saf.u(2), saf.u(3), saf.o(3), scope_bal)) like 'sa_authorization_required%' , 'Alma org not authorized for the Balakong admin');
  perform public.sa_assign_role(saf.u(2), saf.u(3), '00000000-0000-0000-0005-000000000002', saf.o(2), scope_bal, now(), null, 'legitimate grant in own organization');
  perform saf.expect((select count(*) from public.sa_role_assignments where user_id = saf.u(3) and role_id = '00000000-0000-0000-0005-000000000002') = 1, 'in-scope grant works');
  -- 8. a user with no membership cannot receive a grant even for an authorized, central actor
  update public.sa_migration_modes set mode = 'SHADOW' where permission_key in ('security.access.view', 'security.role.assign');
  perform saf.expect(saf.try(format($f$select public.sa_assign_role(%L, %L, '00000000-0000-0000-0005-000000000002', %L, %L, now(), null, 'no membership')$f$, saf.u(1), saf.u(5), saf.o(4), scope_manu)) like 'sa_membership_required%', 'no-membership user cannot receive grants');
  perform saf.expect(saf.try(format($f$select public.sa_assign_role(%L, %L, '00000000-0000-0000-0005-000000000002', %L, %L, now(), null, 'self')$f$, saf.u(1), saf.u(1), saf.o(1), array['00000000-0000-0000-0004-000000000003'::uuid])) like 'sa_self_assignment_prohibited%', 'central admin cannot self-grant either');
  -- the central admin CAN grant to the manufacturer user in the manufacturer organization (existing semantics)
  perform public.sa_assign_role(saf.u(1), saf.u(4), '00000000-0000-0000-0005-000000000002', saf.o(4), scope_manu, now(), null, 'Manufacturer operator in own organization');
  perform saf.expect((select count(*) from public.sa_role_assignments a join public.sa_organization_memberships m on m.id = a.membership_id where a.user_id = saf.u(4) and m.organization_id = saf.o(4)) = 1, 'manufacturer grant lands on the manufacturer membership');
  perform saf.expect((select organization_id from public.users where id = saf.u(4)) = saf.o(4) and (select role_code from public.users where id = saf.u(4)) = 'MFG_USER', 'manu identity, organization and legacy level untouched');
end $t$;
