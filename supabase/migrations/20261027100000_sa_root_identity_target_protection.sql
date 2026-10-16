-- ============================================================================
-- Security & Access — Root Access: identity lifecycle / access target protection
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Requires 20261026100000_sa_root_access.sql
-- (sa_root_access_grants, sa_actor_is_root, sa_active_root_count, the 'sa_root_access' advisory lock).
-- Tested on a throwaway PostgreSQL 17 with the REAL S&A migrations: supabase/tests/security/sa_root_access/run.sh.
--
-- Gap closed
--   identity_set_account_status and identity_admin_update_access asserted the ACTOR's permission only. Anyone holding
--   platform.identity.disable could therefore suspend or disable a Root Administrator — which ends their Root Access in
--   effect (is_active follows account_status), including the LAST one — and anyone holding
--   platform.identity_access.manage could move a Root Administrator's organization. The application guarded the main
--   edit path only (rootTargetGuard); the database did not.
--
-- Rules added (both functions)
--   * A Root target — an account with any not-yet-ended ACTIVE Root Access grant, also while the account is inactive —
--     is changed only by an active Root Administrator (the same rule as sa_actor_dominates / rootTargetGuard).
--     Refused with identity_root_target_protected (42501).
--   * Changes to a Root target are serialized with every Root Access grant/revoke/expiry (advisory lock
--     'sa_root_access'), and a lifecycle change that would leave no active Root Administrator is refused
--     (identity_last_root_administrator). Two Root Administrators can therefore never disable each other
--     concurrently and leave nobody.
--   * identity_admin_update_access: a Root target's organization context is not moved while Root Access is active
--     (revoke Root Access first: Root is held by internal HQ staff only). Refused with identity_root_target_org_locked.
--   * identity_admin_update_access: an active Root Administrator is not limited by the legacy role-grant ceiling
--     (identity_legacy_role_grant_allowed). Root works independently of the legacy role level; the actor permission
--     platform.identity_access.manage is still asserted, the reason/audit row is still written.
--
-- Unchanged: self-change prohibition, reason rules, ARCHIVED terminal rules, the asserted actor permissions and their
-- legacy fallbacks, the access change log rows. A refusal raises (the functions' existing contract); nothing changes.
-- Bodies are otherwise identical to 20260929110000 / 20260929160000 as deployed.
-- ============================================================================

-- Why the actor may not change the target because of Root Access (null = no Root restriction). Takes the Root Access
-- advisory lock whenever the target is (or was until now) a Root target, so the answer cannot race a concurrent
-- Root Access change or another lifecycle change of a Root Administrator.
create or replace function public.identity_root_target_refusal(p_actor uuid, p_target uuid)
returns text language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
begin
  if p_target is null or p_actor = p_target then return null; end if;
  if not exists (select 1 from public.sa_root_access_grants r where r.user_id = p_target and r.status = 'active'
                 and (r.effective_until is null or r.effective_until > now())) then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sa_root_access', 0));
  -- Re-read under the lock: a concurrent revoke may have ended the grant, a concurrent disable the actor's own Root.
  if not exists (select 1 from public.sa_root_access_grants r where r.user_id = p_target and r.status = 'active'
                 and (r.effective_until is null or r.effective_until > now())) then
    return null;
  end if;
  if not public.sa_actor_is_root(p_actor) then return 'identity_root_target_protected'; end if;
  return null;
end $$;
revoke all on function public.identity_root_target_refusal(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.identity_set_account_status(p_actor uuid, p_user uuid, p_status text, p_reason text)
returns text language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_old text; v_org uuid; v_perm text; v_root text;
begin
  if p_status not in ('ACTIVE','SUSPENDED','DISABLED','ARCHIVED') then raise exception 'identity_status_invalid' using errcode = '22023'; end if;
  if p_actor is null or p_user is null then raise exception 'identity_actor_and_user_required' using errcode = '22023'; end if;
  if p_actor = p_user then raise exception 'identity_self_status_change_prohibited' using errcode = '42501'; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then raise exception 'identity_reason_required' using errcode = '22023'; end if;
  -- Root target protection first (takes the Root Access lock before the row lock, like the Root Access functions).
  v_root := public.identity_root_target_refusal(p_actor, p_user);
  if v_root is not null then
    raise exception '%', v_root using errcode = '42501', hint = 'Only another Root Administrator can change a Root Administrator''s account.';
  end if;
  select u.account_status, u.organization_id into v_old, v_org from public.users u where u.id = p_user for update;
  if not found then raise exception 'identity_unknown' using errcode = '22023'; end if;
  -- Archiving and reactivating an archived identity are Super Admin actions.
  v_perm := case when p_status = 'ARCHIVED' or v_old = 'ARCHIVED' then 'platform.identity.delete' else 'platform.identity.disable' end;
  perform public.sa_assert_actor_permission(p_actor, v_perm,
    jsonb_build_object('organization_id', coalesce(v_org, (select u.organization_id from public.users u where u.id = p_actor))),
    case when v_perm = 'platform.identity.delete' then public.sa_legacy_is_super_admin(p_actor) else public.identity_legacy_user_admin(p_actor) end);
  if v_old = p_status then return v_old; end if;
  if v_old = 'ARCHIVED' and p_status <> 'ACTIVE' then
    raise exception 'identity_archived_is_terminal' using errcode = '42501', hint = 'An archived identity can only be reactivated.';
  end if;
  -- Deactivating an active Root Administrator must leave at least one other (held under the Root Access lock above).
  if p_status <> 'ACTIVE' and public.sa_actor_is_root(p_user) and public.sa_active_root_count(p_user) = 0 then
    raise exception 'identity_last_root_administrator' using errcode = '42501',
      hint = 'The last active Root Administrator cannot be deactivated.';
  end if;
  if v_old = 'ARCHIVED' then perform set_config('identity.reactivating', 'on', true); end if;
  update public.users set account_status = p_status, account_status_reason = left(btrim(p_reason), 500) where id = p_user;
  perform set_config('identity.reactivating', 'off', true);
  perform public.sa_log_access_change(p_actor, case when v_old = 'ARCHIVED' then 'identity.reactivated' else 'identity.status_changed' end,
    p_user, 'user', p_user::text, jsonb_build_object('from', v_old, 'to', p_status), p_reason, 'user');
  return p_status;
end $$;

create or replace function public.identity_admin_update_access(p_actor uuid, p_user uuid, p_role_code text, p_organization_id uuid, p_change_org boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare u record; v_new_org uuid; v_new_role text; v_new_scope text; v_legacy boolean; v_root text; v_actor_root boolean;
begin
  if p_actor is null or p_user is null then raise exception 'identity_actor_and_user_required' using errcode = '22023'; end if;
  if p_actor = p_user then raise exception 'identity_self_access_change_prohibited' using errcode = '42501'; end if;
  v_root := public.identity_root_target_refusal(p_actor, p_user);
  if v_root is not null then
    raise exception '%', v_root using errcode = '42501', hint = 'Only another Root Administrator can change a Root Administrator''s account.';
  end if;
  select id, role_code, organization_id, account_scope, account_status into u from public.users where id = p_user for update;
  if not found then raise exception 'identity_unknown' using errcode = '22023'; end if;
  if u.account_status = 'ARCHIVED' then raise exception 'identity_archived_is_terminal' using errcode = '42501'; end if;
  v_new_org := case when coalesce(p_change_org, false) then p_organization_id else u.organization_id end;
  v_new_role := coalesce(nullif(p_role_code, ''), u.role_code);
  if v_new_org is not null and not exists (select 1 from public.organizations o where o.id = v_new_org) then
    raise exception 'identity_organization_unknown' using errcode = '22023';
  end if;
  if v_new_org is distinct from u.organization_id and exists (
       select 1 from public.sa_root_access_grants r where r.user_id = p_user and r.status = 'active'
       and (r.effective_until is null or r.effective_until > now())) then
    raise exception 'identity_root_target_org_locked' using errcode = '42501',
      hint = 'Revoke Root Access before moving this account to another organization.';
  end if;
  v_legacy := public.identity_legacy_access_admin(p_actor);
  -- An active Root Administrator is not bound by the legacy role-grant ceiling (Root is independent of role_level).
  v_actor_root := public.sa_actor_is_root(p_actor);
  if v_new_role is distinct from u.role_code and not v_actor_root then
    if not public.identity_legacy_role_grant_allowed(p_actor, v_new_role) then
      raise exception 'identity_role_grant_not_allowed' using errcode = '42501';
    end if;
    -- Removing a role the actor could not grant is equally privileged.
    if u.role_code is not null and not public.identity_legacy_role_grant_allowed(p_actor, u.role_code) then
      raise exception 'identity_role_change_not_allowed' using errcode = '42501';
    end if;
  end if;
  perform public.sa_assert_actor_permission(p_actor, 'platform.identity_access.manage',
    jsonb_build_object('organization_id', coalesce(u.organization_id, (select a.organization_id from public.users a where a.id = p_actor))), v_legacy);
  if v_new_org is distinct from u.organization_id and v_new_org is not null then
    perform public.sa_assert_actor_permission(p_actor, 'platform.identity_access.manage',
      jsonb_build_object('organization_id', v_new_org), v_legacy);
  end if;
  -- Organization context drives the scope (as updateUserWithAuth did).
  v_new_scope := case when v_new_org is null then 'store'
                      when v_new_role in ('GUEST','CONSUMER') then u.account_scope
                      else 'portal' end;
  update public.users set role_code = v_new_role, organization_id = v_new_org, account_scope = v_new_scope
  where id = p_user;
  perform public.sa_log_access_change(p_actor, 'identity.access_changed', p_user, 'user', p_user::text,
    jsonb_build_object('from', jsonb_build_object('role_code', u.role_code, 'organization_id', u.organization_id, 'account_scope', u.account_scope),
                       'to', jsonb_build_object('role_code', v_new_role, 'organization_id', v_new_org, 'account_scope', v_new_scope),
                       'root_actor', v_actor_root),
    p_reason, 'user');
  return jsonb_build_object('role_code', v_new_role, 'organization_id', v_new_org, 'account_scope', v_new_scope);
end $$;

-- create or replace keeps existing privileges; restated so the file is self-describing.
revoke all on function public.identity_set_account_status(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.identity_set_account_status(uuid, uuid, text, text) to service_role;
revoke all on function public.identity_admin_update_access(uuid, uuid, text, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.identity_admin_update_access(uuid, uuid, text, uuid, boolean, text) to service_role;
