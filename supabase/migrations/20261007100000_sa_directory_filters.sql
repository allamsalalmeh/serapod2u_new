-- ============================================================================
-- Security & Access — People & Access directory filters (read-only)
-- ----------------------------------------------------------------------------
-- Requires 20261005100000_sa_directory_visibility.sql and the Identity
-- Foundation (users.principal_type).
--
-- sa_directory_page_v2 = sa_directory_page plus four server-side filters, all
-- applied BEFORE pagination and inside the administrator's authorized
-- organizations (sa_authorized_organizations is unchanged; a filter can only
-- narrow, never widen):
--
--   p_category    User category = users.principal_type, the classification User
--                 Management/identity already use (INTERNAL_EMPLOYEE,
--                 DISTRIBUTOR_USER, MANUFACTURER_USER, SHOP_STAFF, CONSUMER),
--                 or UNCLASSIFIED when principal_type is null. It is never
--                 inferred from membership or role code (a GUEST in a shop is
--                 SHOP_STAFF, not a consumer).
--   p_org_type    Type of the user's organization (HQ, MFG, DIST, WH, SHOP), as
--                 in User Management's "organization type" filter.
--   p_status      all | active | inactive (users.is_active, as User Management).
--   p_membership  all | has | none — an ACTIVE, in-date business membership in
--                 the authorized scope.
--
-- Counts (all/granted/temporary/inactive/none) cover the authorized scope after
-- the organization, category, organization-type, status and membership filters;
-- search and the access chip narrow the list only.
--
-- Nothing here writes. The v1 function is left in place (the app falls back to
-- it when no new filter is used and this migration is not applied).
-- Rollback: drop function public.sa_directory_page_v2.
-- ============================================================================

create or replace function public.sa_directory_page_v2(
  p_actor uuid, p_org uuid, p_search text, p_filter text, p_limit integer, p_offset integer,
  p_category text default null, p_org_type text default null, p_status text default 'all', p_membership text default 'all')
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_scope uuid[];
  v_all uuid[];
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v_pattern text;
  v_result jsonb;
begin
  if p_filter is null or p_filter not in ('all','granted','temporary','inactive','none') then raise exception 'sa_directory_filter_invalid'; end if;
  if p_category is not null and p_category not in ('INTERNAL_EMPLOYEE','DISTRIBUTOR_USER','MANUFACTURER_USER','SHOP_STAFF','CONSUMER','UNCLASSIFIED') then raise exception 'sa_directory_filter_invalid'; end if;
  if p_org_type is not null and p_org_type not in ('HQ','MFG','DIST','WH','SHOP') then raise exception 'sa_directory_filter_invalid'; end if;
  if coalesce(p_status, 'all') not in ('all','active','inactive') or coalesce(p_membership, 'all') not in ('all','has','none') then raise exception 'sa_directory_filter_invalid'; end if;

  select coalesce(array_agg(a.organization_id), '{}') into v_all from public.sa_authorized_organizations(p_actor, 'security.access.view') a;
  if cardinality(v_all) = 0 then raise exception 'sa_authorization_required' using errcode = '42501'; end if;
  if p_org is not null and not (p_org = any(v_all)) then raise exception 'sa_directory_org_forbidden' using errcode = '42501'; end if;
  v_scope := case when p_org is null then v_all else array[p_org] end;
  if v_q is not null then v_pattern := '%' || replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'; end if;

  with base as (
    select u.id, u.full_name, u.email, u.role_code, u.is_active, u.organization_id, u.principal_type,
      upper(ho.org_type_code) as home_type, ho.org_name as home_name,
      exists (select 1 from public.sa_organization_memberships m where m.user_id = u.id and m.organization_id = any(v_scope)) as has_membership,
      exists (select 1 from public.sa_organization_memberships m where m.user_id = u.id and m.organization_id = any(v_scope) and m.status = 'active'
              and (m.effective_from is null or m.effective_from <= now()) and (m.effective_until is null or m.effective_until > now())) as has_active_membership,
      exists (select 1 from public.sa_role_assignments a
              join public.sa_organization_memberships m on m.id = a.membership_id
              join public.sa_business_roles r on r.id = a.role_id
              where a.user_id = u.id and m.organization_id = any(v_scope) and a.status = 'active'
                and r.source <> 'legacy' and a.source not in ('backfill','derived')) as is_granted,
      exists (select 1 from public.sa_role_assignments a
              join public.sa_organization_memberships m on m.id = a.membership_id
              where a.user_id = u.id and m.organization_id = any(v_scope) and a.status = 'active' and a.effective_until is not null) as is_temporary
    from public.users u left join public.organizations ho on ho.id = u.organization_id
    where u.organization_id = any(v_scope)
       or exists (select 1 from public.sa_organization_memberships m where m.user_id = u.id and m.organization_id = any(v_scope))
  ), vis as (
    select * from base b
    where (p_category is null or (p_category = 'UNCLASSIFIED' and b.principal_type is null) or b.principal_type = p_category)
      and (p_org_type is null or b.home_type = p_org_type)
      and (coalesce(p_status, 'all') = 'all' or (p_status = 'active' and b.is_active) or (p_status = 'inactive' and not b.is_active))
      and (coalesce(p_membership, 'all') = 'all' or (p_membership = 'has' and b.has_active_membership) or (p_membership = 'none' and not b.has_active_membership))
  ), counts as (
    select count(*) as c_all, count(*) filter (where is_granted) as c_granted, count(*) filter (where is_temporary) as c_temporary,
           count(*) filter (where not is_active) as c_inactive, count(*) filter (where not has_membership) as c_none from vis
  ), matched as (
    select v.* from vis v
    where (v_pattern is null or lower(coalesce(v.full_name,'') || ' ' || coalesce(v.email,'') || ' ' || coalesce(v.role_code,'') || ' ' || coalesce(v.home_name,'')) like v_pattern escape '\')
      and case p_filter when 'granted' then v.is_granted when 'temporary' then v.is_temporary when 'inactive' then not v.is_active
                        when 'none' then not v.has_membership else true end
  ), page as (
    select id, lower(coalesce(full_name, email, '')) as sort_key from matched order by sort_key, id
    limit greatest(least(coalesce(p_limit, 25), 100), 1) offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from matched),
    'counts', (select jsonb_build_object('all', c_all, 'granted', c_granted, 'temporary', c_temporary, 'inactive', c_inactive, 'none', c_none) from counts),
    'ids', coalesce((select jsonb_agg(id order by sort_key, id) from page), '[]'::jsonb))
  into v_result;
  return v_result;
end $$;
revoke all on function public.sa_directory_page_v2(uuid,uuid,text,text,integer,integer,text,text,text,text) from public, anon, authenticated;
grant execute on function public.sa_directory_page_v2(uuid,uuid,text,text,integer,integer,text,text,text,text) to service_role;
