-- ============================================================================
-- Security & Access — controlled cutover of the legacy compatibility policies (legacy-<role_code>)
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database.
-- Applying this file changes NOTHING about anyone's access: it adds read-only reports and two owner-only switches.
--
-- Finding (S&A finalization audit, 2026-10-23; staging read-only):
--   * 133 permissions are LEGACY_RETIRED and 2 SHADOW. LEGACY_RETIRED stops the old role-code checks
--     (checkPermissionForUser / role_level rules) — it does NOT stop the compatibility policies.
--   * The compatibility policies legacy-sa (100 permissions), legacy-hq (77), legacy-power-user (70), legacy-manager (37),
--     legacy-user (30) and legacy-shop (29) are ordinary sa_business_roles (source 'legacy') with 49 active
--     backfill/derived assignments. sa_evaluate_permission_core, sa_readable_organizations and
--     sa_actor_holds_permission honour them exactly like an explicit grant. They are why "Legacy USER" shows ~30
--     permissions (every compatibility rule with max_role_level >= 40 or a matching legacy permission) and "Legacy SA"
--     ~100 (role level 1 matches every non-baseline rule, including all security.* keys).
--   * legacy_authorization.read_only = true on staging: sa_sync_user_lifecycle no longer CREATES compatibility
--     assignments (a role-code change only removes them). The 49 rows are therefore frozen migration grants, not live
--     role mirroring — but they still authorize, including sensitive keys (security.*, platform.data.destructive,
--     finance.data.reset, finance.report.view_sensitive, customer.loyalty.adjust, ...).
--
-- Cutover model (no new privilege for anyone, nothing deleted):
--   Every authorization path already requires sa_business_roles.status = 'active'. Retiring a compatibility policy
--   sets its status to 'deprecated': its assignments stay (history, role-code metadata, People & Access "Legacy
--   Access" shows them as Retired) but they grant nothing. Restoring sets 'active' again — an instant, audited rollback.
--   No Full Access policy is handed out in exchange. People who need access the compatibility policy gave them receive
--   an explicit, reviewed S&A grant through People & Access BEFORE the switch.
--
-- Added:
--   sa_legacy_compat_overview()                 read-only: each compatibility policy, status, permissions, holders.
--   sa_legacy_cutover_impact(role_key|null)     read-only: per holder × permission, whether another active,
--                                               non-legacy assignment on the same membership (or Root Access) still
--                                               provides it; would_lose = true where only the compatibility policy does.
--   sa_retire_legacy_compat_role(key, reason, accept_loss)   owner-only switch (refuses while access would be lost
--                                               unless accept_loss = true; refuses without an active Root
--                                               Administrator; refuses unless legacy_authorization.read_only).
--   sa_restore_legacy_compat_role(key, reason)  owner-only rollback.
--   sa_guard_settings: legacy_authorization.read_only cannot be turned off while a compatibility policy is retired
--                      (the lifecycle would otherwise try to derive assignments of a retired role and fail).
--
-- Not changed: assignments, users.role_code, roles, migration modes, the evaluator, RLS, Root Access.
-- Known conservative behaviour (unchanged, fail-closed): sa_actor_dominates still counts a retired compatibility
-- policy of the TARGET person when deciding whether an administrator may manage them.
--
-- Order: after 20261026100000 (sa_actor_is_root) and 20261005110000 (sa_profile_active_holders). Repeat-safe.
--
-- Rollback:
--   select public.sa_restore_legacy_compat_role(role_key, 'Rollback of the legacy cutover') from public.sa_business_roles
--    where source = 'legacy' and status <> 'active';
--   drop function public.sa_retire_legacy_compat_role(text,text,boolean); drop function public.sa_restore_legacy_compat_role(text,text);
--   drop function public.sa_legacy_cutover_impact(text); drop function public.sa_legacy_compat_overview();
--   restore sa_guard_settings() from 20260928100000 (emergency-access check only).
-- ============================================================================

do $pre$
begin
  if to_regprocedure('public.sa_actor_is_root(uuid)') is null then
    raise exception 'sa_prerequisite_missing: sa_actor_is_root (20261026100000)';
  end if;
  if to_regprocedure('public.sa_profile_active_holders(uuid)') is null then
    raise exception 'sa_prerequisite_missing: sa_profile_active_holders (20261005110000)';
  end if;
  if (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conname = 'sa_business_roles_status_check') not like '%deprecated%' then
    raise exception 'sa_prerequisite_missing: sa_business_roles status ''deprecated'' (20261005110000)';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Read-only reports (service role + owner)
-- ---------------------------------------------------------------------------
create or replace function public.sa_legacy_compat_overview()
returns table(role_key text, name text, status text, permission_count integer, sensitive_permission_count integer,
              active_assignments integer, active_users integer, authorizes boolean)
language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select br.role_key, br.name, br.status,
    (select count(*)::integer from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id
      where rp.role_id = br.id and p.status = 'active'),
    (select count(*)::integer from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id
      where rp.role_id = br.id and p.status = 'active' and p.audit_sensitivity <> 'ordinary'),
    (select count(*)::integer from public.sa_profile_active_holders(br.id)),
    (select count(distinct h.user_id)::integer from public.sa_profile_active_holders(br.id) h),
    br.status = 'active'
  from public.sa_business_roles br
  where br.source = 'legacy'
  order by br.role_key
$fn$;
revoke all on function public.sa_legacy_compat_overview() from public, anon, authenticated;
grant execute on function public.sa_legacy_compat_overview() to service_role;
comment on function public.sa_legacy_compat_overview() is
  'Legacy compatibility policies (legacy-<role_code>): status, permissions, holders, and whether they still authorize (status active). Read-only. 20261215110000.';

create or replace function public.sa_legacy_cutover_impact(p_role_key text default null)
returns table(user_id uuid, email text, role_code text, compat_role_key text, assignment_id uuid, organization_id uuid,
              permission_key text, sensitive boolean, covered_by text[], root_access boolean, would_lose boolean)
language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  with held as (
    select a.id as assignment_id, a.user_id, a.membership_id, m.organization_id, br.role_key, p.id as permission_id,
           p.permission_key, p.audit_sensitivity <> 'ordinary' as sensitive
    from public.sa_role_assignments a
    join public.sa_business_roles br on br.id = a.role_id and br.source = 'legacy'
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
  join public.users u on u.id = h.user_id
  cross join lateral (
    -- Another in-window, active, scoped, non-legacy assignment on the same membership that contains the permission.
    -- Scope breadth is not compared (both are usually the membership organization); review sensitive rows by hand.
    select coalesce(array_agg(distinct b2.role_key order by b2.role_key), '{}') as keys
    from public.sa_role_assignments a2
    join public.sa_business_roles b2 on b2.id = a2.role_id and b2.status = 'active' and b2.source <> 'legacy'
    join public.sa_business_role_permissions rp2 on rp2.role_id = b2.id and rp2.permission_id = h.permission_id
    where a2.user_id = h.user_id and a2.membership_id = h.membership_id and a2.status = 'active'
      and (a2.effective_from is null or a2.effective_from <= now()) and (a2.effective_until is null or a2.effective_until > now())
      and exists (select 1 from public.sa_assignment_scopes x join public.sa_scope_definitions sd on sd.id = x.scope_id and sd.status = 'active'
                  where x.assignment_id = a2.id)
  ) cov
  order by h.role_key, u.email, h.permission_key
$fn$;
revoke all on function public.sa_legacy_cutover_impact(text) from public, anon, authenticated;
grant execute on function public.sa_legacy_cutover_impact(text) to service_role;
comment on function public.sa_legacy_cutover_impact(text) is
  'Per holder and permission of an active legacy compatibility policy: other non-legacy policies on the same membership that also grant it, Root Access, and would_lose (only the compatibility policy grants it). Read-only. 20261215110000.';

-- ---------------------------------------------------------------------------
-- 2. Owner-only switches (database owner session; not callable by the API roles)
-- ---------------------------------------------------------------------------
create or replace function public.sa_retire_legacy_compat_role(p_role_key text, p_reason text, p_accept_loss boolean default false)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_role public.sa_business_roles;
  v_lost integer;
  v_lost_people integer;
  v_removed text[];
  v_holder record;
begin
  if p_reason is null or length(btrim(p_reason)) < 10 then raise exception 'sa_reason_required'; end if;
  select * into v_role from public.sa_business_roles where role_key = p_role_key for update;
  if not found then raise exception 'sa_profile_not_found: %', p_role_key; end if;
  if v_role.source <> 'legacy' then raise exception 'sa_not_compat_role: %', p_role_key; end if;
  if v_role.status <> 'active' then
    return jsonb_build_object('role_key', p_role_key, 'status', v_role.status, 'unchanged', true);
  end if;
  if not public.sa_setting_bool('legacy_authorization.read_only', false) then
    raise exception 'sa_legacy_store_writable'
      using hint = 'Set legacy_authorization.read_only = true first: the lifecycle must no longer derive compatibility assignments.';
  end if;
  -- Root continuity: Root Access never depends on a compatibility policy, but never retire one without a working Root Administrator.
  if not exists (select 1 from public.sa_root_access_grants g join public.users u on u.id = g.user_id and u.is_active is true
                 where g.status = 'active' and (g.effective_until is null or g.effective_until > now())) then
    raise exception 'sa_root_continuity: no active Root Administrator';
  end if;

  select count(*), count(distinct i.user_id) into v_lost, v_lost_people
  from public.sa_legacy_cutover_impact(p_role_key) i where i.would_lose;
  if v_lost > 0 and not coalesce(p_accept_loss, false) then
    raise exception 'sa_legacy_cutover_would_remove_access: % permission(s) for % person(s) come only from %', v_lost, v_lost_people, p_role_key
      using hint = 'Review select * from public.sa_legacy_cutover_impact(''' || p_role_key || ''') where would_lose; grant the access people still need through People & Access, or pass p_accept_loss => true.';
  end if;

  select coalesce(array_agg(p.permission_key order by p.permission_key), '{}') into v_removed
  from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id
  where rp.role_id = v_role.id and p.status = 'active';

  update public.sa_business_roles set status = 'deprecated', version = version + 1, updated_at = now(), updated_by = null
  where id = v_role.id;
  perform public.sa_log_access_change(null, 'access_profile.legacy_retired', null, 'sa_business_role', v_role.id::text,
    jsonb_build_object('role_key', p_role_key, 'permissions', to_jsonb(v_removed), 'accepted_loss', v_lost, 'accepted_loss_people', v_lost_people),
    btrim(p_reason), 'system');
  for v_holder in select * from public.sa_profile_active_holders(v_role.id) loop
    perform public.sa_log_access_change(null, 'assignment.profile_changed', v_holder.user_id, 'sa_role_assignment', v_holder.assignment_id::text,
      jsonb_build_object('role_id', v_role.id, 'role_key', p_role_key, 'added', '[]'::jsonb, 'removed', to_jsonb(v_removed),
                         'organization_id', v_holder.organization_id, 'legacy_retired', true),
      btrim(p_reason), 'system');
  end loop;
  return jsonb_build_object('role_key', p_role_key, 'status', 'deprecated', 'permissions', cardinality(v_removed),
                            'accepted_loss', v_lost, 'accepted_loss_people', v_lost_people);
end $fn$;
revoke all on function public.sa_retire_legacy_compat_role(text,text,boolean) from public, anon, authenticated, service_role;
comment on function public.sa_retire_legacy_compat_role(text,text,boolean) is
  'Owner-only: a legacy compatibility policy stops authorizing (status deprecated). Assignments stay as metadata. Refuses while access would be lost unless p_accept_loss. Rollback: sa_restore_legacy_compat_role. 20261215110000.';

create or replace function public.sa_restore_legacy_compat_role(p_role_key text, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_role public.sa_business_roles;
begin
  if p_reason is null or length(btrim(p_reason)) < 10 then raise exception 'sa_reason_required'; end if;
  select * into v_role from public.sa_business_roles where role_key = p_role_key for update;
  if not found then raise exception 'sa_profile_not_found: %', p_role_key; end if;
  if v_role.source <> 'legacy' then raise exception 'sa_not_compat_role: %', p_role_key; end if;
  if v_role.status = 'active' then return jsonb_build_object('role_key', p_role_key, 'status', 'active', 'unchanged', true); end if;
  update public.sa_business_roles set status = 'active', version = version + 1, updated_at = now(), updated_by = null where id = v_role.id;
  perform public.sa_log_access_change(null, 'access_profile.legacy_restored', null, 'sa_business_role', v_role.id::text,
    jsonb_build_object('role_key', p_role_key, 'from', v_role.status), btrim(p_reason), 'system');
  return jsonb_build_object('role_key', p_role_key, 'status', 'active');
end $fn$;
revoke all on function public.sa_restore_legacy_compat_role(text,text) from public, anon, authenticated, service_role;
comment on function public.sa_restore_legacy_compat_role(text,text) is
  'Owner-only rollback of sa_retire_legacy_compat_role: the compatibility policy authorizes again. 20261215110000.';

-- ---------------------------------------------------------------------------
-- 3. Settings guard (20260928100000 body + one rule)
-- ---------------------------------------------------------------------------
create or replace function public.sa_guard_settings()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if new.setting_key = 'emergency_access.enabled' and (new.setting_value #>> '{}')::boolean
     and not public.sa_setting_bool('emergency_access.mfa_step_up_available', false) then
    raise exception 'emergency_access_prerequisite_unmet';
  end if;
  -- 20261215110000: with a retired compatibility policy, the lifecycle must not derive compatibility assignments again.
  if new.setting_key = 'legacy_authorization.read_only' and not coalesce((new.setting_value #>> '{}')::boolean, false)
     and exists (select 1 from public.sa_business_roles where source = 'legacy' and status <> 'active') then
    raise exception 'sa_legacy_compat_retired'
      using hint = 'Restore the retired compatibility policies (sa_restore_legacy_compat_role) before making the legacy store writable.';
  end if;
  return new;
end $$;
revoke all on function public.sa_guard_settings() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Post-conditions: the switches are owner-only; nothing was retired by this migration
-- ---------------------------------------------------------------------------
do $post$
declare r text;
begin
  foreach r in array array['authenticated', 'service_role', 'anon'] loop
    if has_function_privilege(r, 'public.sa_retire_legacy_compat_role(text,text,boolean)', 'execute')
       or has_function_privilege(r, 'public.sa_restore_legacy_compat_role(text,text)', 'execute') then
      raise exception 'postcondition: % may execute a legacy cutover switch', r;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.sa_legacy_cutover_impact(text)', 'execute') then
    raise exception 'postcondition: authenticated may read the cutover impact report';
  end if;
  if exists (select 1 from public.sa_access_change_log where action = 'access_profile.legacy_retired'
             and occurred_at >= transaction_timestamp()) then
    raise exception 'postcondition: this migration must not retire a compatibility policy';
  end if;
end $post$;
