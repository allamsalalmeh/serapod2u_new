-- OWNER REVIEW / MANUAL EXECUTION ONLY. No assignments, modes or role codes change.
-- Dependency: 20261215110000_sa_legacy_compat_cutover_controls.sql (already applied).
-- Fixes false replacement coverage in the installed dry-run report. Exact active
-- scope containment is conservative: hierarchy/delegation-only coverage stays a
-- review gap, never permission to retire. The existing retire function consumes
-- this report and continues refusing losses with p_accept_loss=false.
-- Rollback: restore ONLY sa_legacy_cutover_impact(text) from that dependency;
-- do not rerun the full prior migration. Never use the older preview to approve cutover.
-- Verify: select * from public.sa_legacy_compat_overview();
-- select compat_role_key,count(*) filter(where would_lose) from public.sa_legacy_cutover_impact(null) group by 1;
begin;
do $$ begin
  if to_regprocedure('public.sa_legacy_cutover_impact(text)') is null then
    raise exception 'sa_legacy_cutover_prerequisite_missing';
  end if;
end $$;
create or replace function public.sa_legacy_cutover_impact(p_role_key text default null)
returns table(user_id uuid, email text, role_code text, compat_role_key text, assignment_id uuid, organization_id uuid,
              permission_key text, sensitive boolean, covered_by text[], root_access boolean, would_lose boolean)
language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  with held as (
    select a.id as assignment_id, a.user_id, a.membership_id, m.organization_id, br.role_key, p.id as permission_id,
           p.permission_key, p.audit_sensitivity <> 'ordinary' as sensitive
    from public.sa_role_assignments a
    join public.sa_business_roles br on br.id = a.role_id and br.source = 'legacy' and br.status = 'active'
    join public.sa_organization_memberships m on m.id = a.membership_id and m.status = 'active'
      and (m.effective_from is null or m.effective_from <= now()) and (m.effective_until is null or m.effective_until > now())
    join public.sa_business_role_permissions rp on rp.role_id = br.id
    join public.sa_permissions p on p.id = rp.permission_id and p.status = 'active'
    where a.status = 'active'
      and (a.effective_from is null or a.effective_from <= now()) and (a.effective_until is null or a.effective_until > now())
      and (p_role_key is null or br.role_key = p_role_key)
  )
  select h.user_id, u.email, u.role_code, h.role_key, h.assignment_id, h.organization_id, h.permission_key, h.sensitive,
    cov.keys,
    public.sa_actor_is_root(h.user_id),
    not public.sa_actor_is_root(h.user_id) and cardinality(cov.keys) = 0
  from held h
  join public.users u on u.id = h.user_id and u.is_active is true
  cross join lateral (
    -- Another in-window, active, scoped, non-legacy assignment on the same membership that contains the permission.
    -- Conservative full-coverage proof: every active legacy scope must be present
    -- on this replacement. Hierarchy/delegation coverage is deliberately not inferred.
    select coalesce(array_agg(distinct b2.role_key order by b2.role_key), '{}') as keys
    from public.sa_role_assignments a2
    join public.sa_business_roles b2 on b2.id = a2.role_id and b2.status = 'active' and b2.source <> 'legacy'
    join public.sa_business_role_permissions rp2 on rp2.role_id = b2.id and rp2.permission_id = h.permission_id
    where a2.user_id = h.user_id and a2.membership_id = h.membership_id and a2.status = 'active'
      and (a2.effective_from is null or a2.effective_from <= now()) and (a2.effective_until is null or a2.effective_until > now())
      and exists (select 1 from public.sa_assignment_scopes lx join public.sa_scope_definitions ls on ls.id = lx.scope_id
                  where lx.assignment_id = h.assignment_id and ls.status = 'active')
      and not exists (
        select 1 from public.sa_assignment_scopes lx join public.sa_scope_definitions ls on ls.id = lx.scope_id
        where lx.assignment_id = h.assignment_id and ls.status = 'active'
          and not exists (
            select 1 from public.sa_assignment_scopes rx join public.sa_scope_definitions rs on rs.id = rx.scope_id
            where rx.assignment_id = a2.id and rs.status = 'active'
              and rs.scope_type = ls.scope_type and rs.scope_value = ls.scope_value
          )
      )
      and exists (select 1 from public.sa_assignment_scopes x join public.sa_scope_definitions sd on sd.id = x.scope_id and sd.status = 'active'
                  where x.assignment_id = a2.id)
  ) cov
  order by h.role_key, u.email, h.permission_key
$fn$;
revoke all on function public.sa_legacy_cutover_impact(text) from public, anon, authenticated;
grant execute on function public.sa_legacy_cutover_impact(text) to service_role;
comment on function public.sa_legacy_cutover_impact(text) is 'Conservative legacy cutover preview: active accounts/policies, active membership/window and exact full scope coverage. 20261216100000';
create or replace function public.sa_legacy_preview_version() returns text
language sql stable security definer set search_path = pg_catalog, pg_temp as $$ select '20261216100000'::text $$;
revoke all on function public.sa_legacy_preview_version() from public, anon, authenticated;
grant execute on function public.sa_legacy_preview_version() to service_role;
commit;
