-- ============================================================================
-- Security & Access — People & Access directory across authorized organizations
-- ----------------------------------------------------------------------------
-- Root cause fixed: the overview read model loaded people with
-- .eq('organization_id', <administrator's organization>).limit(500), so
-- manufacturer / partner users (their own organization) never appeared, and
-- anything beyond the first 500 was silently dropped.
--
-- This migration adds READ-ONLY, service-role-only functions that decide which
-- organizations an administrator may see/administer using the EXISTING S&A
-- semantics (no new privilege model):
--
--   * permission still on a legacy mode (LEGACY_ENFORCED/SHADOW): the central
--     Super Admin (legacy role level 1, sa_legacy_is_super_admin) is
--     authorized for every organization; nobody else is.
--   * permission NEW_ENFORCED/LEGACY_RETIRED: the actor's own active
--     memberships define the starting organizations, and only those
--     organizations (and descendants) where sa_actor_has_permission() ALLOWs
--     in that organization context are authorized. HQ membership alone covers
--     only HQ's own descendants through an organization-scoped assignment.
--
-- Viewing never authorizes granting: grantable organizations are computed from
-- security.role.assign separately, and sa_assign_role / sa_create_assignment_
-- internal still independently require the target membership in the target
-- organization, scopes inside it, SoD and no self-assignment (unchanged).
--
-- Nothing here writes: no user, membership or assignment is created or changed.
--
-- Objects: sa_authorized_organizations, sa_directory_organizations,
--          sa_directory_page, sa_directory_visible_memberships.
-- Rollback: drop the four functions.
-- ============================================================================

create or replace function public.sa_authorized_organizations(p_actor uuid, p_permission text)
returns table(organization_id uuid)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  if p_permission is null or p_permission not in ('security.access.view', 'security.role.assign') then
    raise exception 'sa_directory_permission_invalid';
  end if;
  if p_actor is null or not exists (select 1 from public.users u where u.id = p_actor and u.is_active is true) then return; end if;

  if not public.sa_is_new_authoritative(p_permission) then
    if public.sa_legacy_is_super_admin(p_actor) then
      return query select o.id from public.organizations o;
    end if;
    return;
  end if;

  return query
  with recursive base(id) as (
    select m.organization_id from public.sa_organization_memberships m
    where m.user_id = p_actor and m.status = 'active'
      and (m.effective_from is null or m.effective_from <= now()) and (m.effective_until is null or m.effective_until > now())
  ), down(id, depth) as (
    select id, 0 from base
    union
    select o.id, d.depth + 1 from public.organizations o join down d on o.parent_org_id = d.id where d.depth < 10
  )
  select distinct d.id from down d
  where public.sa_actor_has_permission(p_actor, p_permission, jsonb_build_object('organization_id', d.id));
end $$;
revoke all on function public.sa_authorized_organizations(uuid,text) from public, anon, authenticated;
grant execute on function public.sa_authorized_organizations(uuid,text) to service_role;

-- Organizations (with people) the actor may filter by.
create or replace function public.sa_directory_organizations(p_actor uuid)
returns table(organization_id uuid, org_name text, org_type_code text, parent_org_id uuid, people_count bigint)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  with auth as (select a.organization_id from public.sa_authorized_organizations(p_actor, 'security.access.view') a),
  members as (
    select u.organization_id as org_id, u.id as user_id from public.users u where u.organization_id is not null
    union
    select m.organization_id, m.user_id from public.sa_organization_memberships m
  )
  select o.id, o.org_name, o.org_type_code, o.parent_org_id, count(distinct mm.user_id)
  from auth a join public.organizations o on o.id = a.organization_id
  join members mm on mm.org_id = o.id
  group by o.id, o.org_name, o.org_type_code, o.parent_org_id
  order by o.org_name
$$;
revoke all on function public.sa_directory_organizations(uuid) from public, anon, authenticated;
grant execute on function public.sa_directory_organizations(uuid) to service_role;

-- One page of people in the actor's authorized scope (optionally one
-- organization), with counts for the whole scope. Search and pagination are
-- server-side; nothing is truncated silently.
create or replace function public.sa_directory_page(
  p_actor uuid, p_org uuid, p_search text, p_filter text, p_limit integer, p_offset integer)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_scope uuid[];
  v_all uuid[];
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
  v_pattern text;
  v_result jsonb;
begin
  if p_filter is null or p_filter not in ('all','granted','temporary','inactive','none') then raise exception 'sa_directory_filter_invalid'; end if;
  select coalesce(array_agg(a.organization_id), '{}') into v_all from public.sa_authorized_organizations(p_actor, 'security.access.view') a;
  if cardinality(v_all) = 0 then raise exception 'sa_authorization_required' using errcode = '42501'; end if;
  if p_org is not null and not (p_org = any(v_all)) then raise exception 'sa_directory_org_forbidden' using errcode = '42501'; end if;
  v_scope := case when p_org is null then v_all else array[p_org] end;
  if v_q is not null then v_pattern := '%' || replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'; end if;

  with vis as (
    select u.id, u.full_name, u.email, u.role_code, u.is_active, u.organization_id,
      exists (select 1 from public.sa_organization_memberships m where m.user_id = u.id and m.organization_id = any(v_scope)) as has_membership,
      exists (select 1 from public.sa_role_assignments a
              join public.sa_organization_memberships m on m.id = a.membership_id
              join public.sa_business_roles r on r.id = a.role_id
              where a.user_id = u.id and m.organization_id = any(v_scope) and a.status = 'active'
                and r.source <> 'legacy' and a.source not in ('backfill','derived')) as is_granted,
      exists (select 1 from public.sa_role_assignments a
              join public.sa_organization_memberships m on m.id = a.membership_id
              where a.user_id = u.id and m.organization_id = any(v_scope) and a.status = 'active' and a.effective_until is not null) as is_temporary
    from public.users u
    where u.organization_id = any(v_scope)
       or exists (select 1 from public.sa_organization_memberships m where m.user_id = u.id and m.organization_id = any(v_scope))
  ), counts as (
    select count(*) as c_all, count(*) filter (where is_granted) as c_granted, count(*) filter (where is_temporary) as c_temporary,
           count(*) filter (where not is_active) as c_inactive, count(*) filter (where not has_membership) as c_none from vis
  ), matched as (
    select v.* from vis v left join public.organizations o on o.id = v.organization_id
    where (v_pattern is null or lower(coalesce(v.full_name,'') || ' ' || coalesce(v.email,'') || ' ' || coalesce(v.role_code,'') || ' ' || coalesce(o.org_name,'')) like v_pattern escape '\')
      and case p_filter when 'granted' then v.is_granted when 'temporary' then v.is_temporary when 'inactive' then not v.is_active
                        when 'none' then not v.has_membership else true end
  ), page as (
    select id, lower(coalesce(full_name, email, '')) as sort_key from matched order by sort_key, id limit greatest(least(coalesce(p_limit, 25), 100), 1) offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from matched),
    'counts', (select jsonb_build_object('all', c_all, 'granted', c_granted, 'temporary', c_temporary, 'inactive', c_inactive, 'none', c_none) from counts),
    'ids', coalesce((select jsonb_agg(id order by sort_key, id) from page), '[]'::jsonb))
  into v_result;
  return v_result;
end $$;
revoke all on function public.sa_directory_page(uuid,uuid,text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.sa_directory_page(uuid,uuid,text,text,integer,integer) to service_role;

-- Memberships of the given people that the actor may see, and whether the
-- actor may GRANT access on each (security.role.assign in that organization,
-- active membership, not the actor themself). Memberships in organizations the
-- actor is not authorized for are never returned.
create or replace function public.sa_directory_visible_memberships(p_actor uuid, p_user_ids uuid[])
returns table(membership_id uuid, user_id uuid, organization_id uuid, grantable boolean, blocked_reason text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  with view_orgs as (select a.organization_id from public.sa_authorized_organizations(p_actor, 'security.access.view') a),
       assign_orgs as (select a.organization_id from public.sa_authorized_organizations(p_actor, 'security.role.assign') a)
  select m.id, m.user_id, m.organization_id,
    (m.user_id <> p_actor and m.status = 'active' and (m.effective_until is null or m.effective_until > now())
       and exists (select 1 from assign_orgs x where x.organization_id = m.organization_id)
       and exists (select 1 from public.users u where u.id = m.user_id and u.is_active is true)),
    case when m.user_id = p_actor then 'self'
         when m.status <> 'active' or (m.effective_until is not null and m.effective_until <= now()) then 'membership_not_active'
         when not exists (select 1 from public.users u where u.id = m.user_id and u.is_active is true) then 'account_inactive'
         when not exists (select 1 from assign_orgs x where x.organization_id = m.organization_id) then 'not_authorized'
         else null end
  from public.sa_organization_memberships m
  where m.user_id = any(p_user_ids) and exists (select 1 from view_orgs v where v.organization_id = m.organization_id)
$$;
revoke all on function public.sa_directory_visible_memberships(uuid,uuid[]) from public, anon, authenticated;
grant execute on function public.sa_directory_visible_memberships(uuid,uuid[]) to service_role;
