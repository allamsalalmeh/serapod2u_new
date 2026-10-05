-- Directory filters: classification (principal_type, as User Management), combined filters, scope safety, read-only.
insert into public.organizations(id, org_name, org_type_code) values (saf.o(7), 'Corner Shop', 'SHOP');
insert into auth.users(id, email) values (saf.u(13), 'shopguest@dev.com'), (saf.u(14), 'consumer@dev.com'), (saf.u(15), 'unknown@dev.com');
-- A shop account carrying the GUEST role code (portal scope => SHOP_STAFF), a real consumer (store scope => CONSUMER) with
-- the same GUEST role code, and a user whose classification is unknown.
insert into public.users(id, email, full_name, role_code, organization_id, is_active, principal_type) values
  (saf.u(13), 'shopguest@dev.com', 'Shop Guest', 'GUEST', saf.o(7), true, 'SHOP_STAFF'),
  (saf.u(14), 'consumer@dev.com', 'Consumer Person', 'GUEST', saf.o(7), true, 'CONSUMER'),
  (saf.u(15), 'unknown@dev.com', 'Unknown Class', 'GUEST', saf.o(1), true, null);
create function saf.f(p_actor uuid, p_org uuid, p_cat text, p_type text, p_status text, p_mem text, p_search text default null, p_chip text default 'all', p_limit int default 100, p_off int default 0)
returns jsonb language sql stable as $$ select public.sa_directory_page_v2(p_actor, p_org, p_search, p_chip, p_limit, p_off, p_cat, p_type, p_status, p_mem) $$;
create function saf.ids(j jsonb) returns uuid[] language sql immutable as $$ select coalesce(array_agg(x::uuid order by x), '{}') from jsonb_array_elements_text(j->'ids') x $$;

do $t$ declare snap text := saf.snapshot(); r jsonb; v1 jsonb; begin
  -- "All" == the v1 directory for the same actor (all users in the authorized scope, nothing added or removed)
  r := saf.f(saf.u(1), null, null, null, 'all', 'all');
  v1 := public.sa_directory_page(saf.u(1), null, null, 'all', 100, 0);
  perform saf.expect(r->'total' = v1->'total' and r->'counts' = v1->'counts' and r->'ids' = v1->'ids', '"All" equals the unfiltered directory');
  -- classification comes from principal_type, never from the role code or membership
  perform saf.expect(saf.ids(saf.f(saf.u(1), null, 'SHOP_STAFF', null, 'all', 'all')) = array[saf.u(13)], 'shop GUEST is SHOP_STAFF');
  perform saf.expect(saf.ids(saf.f(saf.u(1), null, 'CONSUMER', null, 'all', 'all')) = array[saf.u(14)], 'consumer is only the CONSUMER principal (GUEST is not assumed consumer)');
  perform saf.expect(saf.ids(saf.f(saf.u(1), null, 'UNCLASSIFIED', null, 'all', 'all')) = array[saf.u(15)], 'unknown classification is reported as unclassified, not guessed');
  perform saf.expect((saf.f(saf.u(1), null, 'MANUFACTURER_USER', null, 'all', 'all')->>'total')::int = 4, 'manufacturer category includes users with no membership (u5 stays MANUFACTURER_USER)');
  perform saf.expect(saf.ids(saf.f(saf.u(1), null, null, 'DIST', 'all', 'all')) = array[saf.u(12)], 'organization type DIST');
  perform saf.expect((saf.f(saf.u(1), null, null, 'MFG', 'all', 'all')->>'total')::int = 4, 'organization type MFG');
  perform saf.expect(saf.ids(saf.f(saf.u(1), null, null, 'SHOP', 'all', 'all')) = array[saf.u(13), saf.u(14)] or saf.ids(saf.f(saf.u(1), null, null, 'SHOP', 'all', 'all')) = array[saf.u(14), saf.u(13)], 'organization type SHOP');
  -- combined filters and incompatible combinations (predictably empty, not an error)
  perform saf.expect((saf.f(saf.u(1), null, 'CONSUMER', 'MFG', 'all', 'all')->>'total')::int = 0 and (saf.f(saf.u(1), saf.o(4), null, 'DIST', 'all', 'all')->>'total')::int = 0, 'incompatible category/type/organization selections give an empty result');
  perform saf.expect((saf.f(saf.u(1), saf.o(4), 'MANUFACTURER_USER', 'MFG', 'active', 'has')->>'total')::int = 2, 'combined: manufacturer org + category + type + active + has membership (u4,u10)');
  perform saf.expect(saf.ids(saf.f(saf.u(1), saf.o(4), null, null, 'all', 'none')) = array[saf.u(5)], 'no active membership inside the manufacturer organization');
  -- account status and membership
  perform saf.expect(saf.ids(saf.f(saf.u(1), null, null, null, 'inactive', 'all')) = array[saf.u(6)], 'inactive accounts');
  perform saf.expect(not (saf.u(6) = any(saf.ids(saf.f(saf.u(1), null, null, null, 'active', 'all')))), 'active excludes inactive accounts');
  perform saf.expect(saf.ids(saf.f(saf.u(1), null, 'SHOP_STAFF', null, 'all', 'none')) = array[saf.u(13)] and (saf.f(saf.u(1), null, 'SHOP_STAFF', null, 'all', 'has')->>'total')::int = 0, 'a shop user without membership is simply listed as such');
  -- an expired or inactive membership is not an active membership
  update public.sa_organization_memberships set status = 'inactive' where user_id = saf.u(8);
  perform saf.expect(saf.u(8) = any(saf.ids(saf.f(saf.u(1), saf.o(1), null, null, 'all', 'none'))), 'inactive membership counts as no ACTIVE membership');
  update public.sa_organization_memberships set status = 'active' where user_id = saf.u(8);
  -- search applies with the filters, before pagination; counts follow the filter scope
  r := saf.f(saf.u(1), null, 'INTERNAL_EMPLOYEE', 'HQ', 'all', 'has', 'Bulk Person 0700');
  perform saf.expect((r->>'total')::int = 1 and (r->'counts'->>'all')::int > 600, 'search + filters; counts ignore search but follow the filters');
  r := saf.f(saf.u(1), saf.o(4), 'MANUFACTURER_USER', null, 'all', 'all');
  perform saf.expect((r->'counts'->>'all')::int = (r->>'total')::int, 'counts consistent with the filter scope');
  -- pagination after filters, stable and without overlap
  perform saf.expect(saf.ids(saf.f(saf.u(1), null, 'INTERNAL_EMPLOYEE', null, 'all', 'has', null, 'all', 5, 0)) && saf.ids(saf.f(saf.u(1), null, 'INTERNAL_EMPLOYEE', null, 'all', 'has', null, 'all', 5, 5)) = false, 'pages do not overlap');
  perform saf.expect((saf.f(saf.u(1), null, 'INTERNAL_EMPLOYEE', null, 'all', 'all', null, 'all', 5, 700)->>'total')::int = (saf.f(saf.u(1), null, 'INTERNAL_EMPLOYEE', null, 'all', 'all', null, 'all', 5, 0)->>'total')::int, 'total is independent of the page');
  -- invalid input
  perform saf.expect(saf.try(format($f$select public.sa_directory_page_v2(%L, null, null, 'all', 25, 0, 'ROOT', null, 'all', 'all')$f$, saf.u(1))) like 'sa_directory_filter_invalid%', 'unknown category rejected');
  perform saf.expect(saf.try(format($f$select public.sa_directory_page_v2(%L, null, null, 'all', 25, 0, null, 'XXX', 'all', 'all')$f$, saf.u(1))) like 'sa_directory_filter_invalid%', 'unknown organization type rejected');
  perform saf.expect(saf.try(format($f$select public.sa_directory_page_v2(%L, null, null, 'all', 25, 0, null, null, 'online', 'all')$f$, saf.u(1))) like 'sa_directory_filter_invalid%', 'unknown status rejected');
  perform saf.expect(saf.try(format($f$select public.sa_directory_page_v2(%L, null, null, 'all', 25, 0, null, null, 'all', 'maybe')$f$, saf.u(1))) like 'sa_directory_filter_invalid%', 'unknown membership filter rejected');
  -- read-only
  perform saf.expect(saf.snapshot() = snap, 'filtering mutated nothing');
end $t$;

-- Filters never widen visibility (organization-scoped administrator, NEW_ENFORCED semantics)
do $t$ declare r jsonb; begin
  perform saf.expect(saf.try(format($f$select public.sa_directory_page_v2(%L, null, null, 'all', 25, 0, 'MANUFACTURER_USER', null, 'all', 'all')$f$, saf.u(2))) like 'sa_authorization_required%', 'legacy mode: non-super-admin has no scope even with a category filter');
  update public.sa_migration_modes set mode = 'NEW_ENFORCED' where permission_key in ('security.access.view', 'security.role.assign');
  r := saf.f(saf.u(2), null, 'MANUFACTURER_USER', null, 'all', 'all');
  perform saf.expect((r->>'total')::int = 0 and (r->'counts'->>'all')::int = 0 and r->'ids' = '[]'::jsonb, 'category filter exposes no manufacturer user or count outside the authorized organizations');
  perform saf.expect((saf.f(saf.u(2), null, null, 'MFG', 'all', 'none')->>'total')::int = 0, 'organization-type + membership filters expose nothing outside scope');
  perform saf.expect(saf.try(format($f$select public.sa_directory_page_v2(%L, %L, null, 'all', 25, 0, 'MANUFACTURER_USER', 'MFG', 'all', 'all')$f$, saf.u(2), saf.o(4))) like 'sa_directory_org_forbidden%', 'a forged organization with filters is still rejected');
  perform saf.expect((saf.f(saf.u(2), null, 'INTERNAL_EMPLOYEE', null, 'all', 'all')->>'total')::int = 3, 'inside its own scope the filters work (Balakong: admin + two warehouse users)');
  update public.sa_migration_modes set mode = 'SHADOW' where permission_key in ('security.access.view', 'security.role.assign');
end $t$;
