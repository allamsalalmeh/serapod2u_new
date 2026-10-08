-- ============================================================================
-- Security & Access — materialize platform.user.password_reset on its compatibility roles
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database.
--
-- Incident (2026-10-08, staging). User Management → Edit User no longer showed "Reset password", and
-- POST /api/users/reset-password answered 403 for every administrator.
--
-- Root cause (read-only evidence from the staging database):
--   * 20261016100000 created platform.user.password_reset with the compatibility rule "role level <= 10"
--     (central Super Admin level 1 + HQ Admin level 10) and stated that the compatibility roles keep that audience.
--   * Its section 5 refreshes the compatibility roles ONLY while legacy authorization is writable. Staging has
--     legacy_authorization.read_only = true, so legacy-sa / legacy-hq never received the key.
--   * The key was then moved SHADOW → New Access Active → Legacy Retired (2026-10-08 01:59 UTC, together with
--     platform.user.manage). From then on S&A alone decides, and nobody holds the key:
--       - legacy-sa / legacy-hq: missing (above);
--       - Platform & Settings Full Access and User Password Administrator: hold it, assigned to 0 people.
--     sa_evaluate_permission(..., 'platform.user.password_reset') = DENY / MISSING_PERMISSION for all 19 active
--     users of role level <= 10, while platform.user.manage = ALLOW for them.
--   * The Edit User reset section hides itself on an enforced DENY, so the action disappeared.
--
-- What this does (smallest change that restores the designed audience):
--   Adds platform.user.password_reset to the EXISTING compatibility roles that its own compatibility rule already
--   selects (the same predicate as sa_refresh_compat_role, for this one key only): role level 1, role level <= the
--   rule's max_role_level (10), or a role code listed in the rule. On staging/production that is legacy-sa and
--   legacy-hq. Their organizational reach is unchanged (it comes from their existing assignments), so the reset
--   reach equals the platform.user.manage reach those administrators already had before the split.
--
-- Not changed: no migration mode (Legacy Retired stays Legacy Retired; the Shadow permission stays Shadow), no
-- assignment created/removed, no other permission, no other role, no Group Policy, no roles.* legacy store.
-- legacy-manager / legacy-power-user (levels 30 / 20, which hold platform.user.manage) intentionally do NOT gain
-- reset: 20261016100000 made reset narrower than profile administration.
--
-- Note for reviewers: the same read-only skip left other compatibility-rule keys unmaterialized on staging
-- (platform.identity.*, platform.identity_access.manage, platform.system_logs.view). They are out of scope here.
--
-- Requires 20261016100000_sa_user_password_reset_permission.sql. Repeat-safe.
-- Rollback (restores the broken state; only if intended):
--   delete from public.sa_business_role_permissions rp using public.sa_business_roles b, public.sa_permissions p
--   where rp.role_id = b.id and rp.permission_id = p.id and b.source = 'legacy'
--     and p.permission_key = 'platform.user.password_reset';
-- ============================================================================

do $pre$
begin
  if not exists (select 1 from public.sa_permissions where permission_key = 'platform.user.password_reset' and status = 'active') then
    raise exception 'sa_prerequisite_missing: apply 20261016100000_sa_user_password_reset_permission.sql first';
  end if;
  if not exists (select 1 from public.sa_legacy_compat_rules where permission_key = 'platform.user.password_reset') then
    raise exception 'sa_prerequisite_missing: compatibility rule for platform.user.password_reset';
  end if;
end $pre$;

-- Work tables (not session temp tables) so the post-conditions see the before-state in every run mode.
drop table if exists public.sa_mig_20261025_modes_before;
drop table if exists public.sa_mig_20261025_assign_before;
create table public.sa_mig_20261025_modes_before as
  select permission_key, mode from public.sa_migration_modes;
create table public.sa_mig_20261025_assign_before as
  select count(*)::bigint as n, coalesce(sum(hashtext(id::text || status || coalesce(effective_until::text, ''))), 0)::bigint as h
  from public.sa_role_assignments;
revoke all on public.sa_mig_20261025_modes_before, public.sa_mig_20261025_assign_before from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Compatibility roles selected by the key's own rule gain the key (audited per role)
-- ---------------------------------------------------------------------------
do $grant$
declare
  v_perm uuid;
  v_rule record;
  v_role record;
  v_added integer;
begin
  select id into v_perm from public.sa_permissions where permission_key = 'platform.user.password_reset';
  select * into v_rule from public.sa_legacy_compat_rules where permission_key = 'platform.user.password_reset';

  for v_role in
    select b.id, b.role_key, r.role_code, r.role_level
    from public.roles r
    join public.sa_business_roles b on b.role_key = public.sa_compat_role_key(r.role_code) and b.source = 'legacy'
    where upper(r.role_code) <> 'GUEST'
      and not v_rule.employee_baseline
      and (r.role_level = 1
           or (v_rule.max_role_level is not null and r.role_level is not null and r.role_level <= v_rule.max_role_level)
           or upper(r.role_code) = any(v_rule.role_codes))
    order by r.role_level, r.role_code
  loop
    insert into public.sa_business_role_permissions(role_id, permission_id)
    values (v_role.id, v_perm)
    on conflict do nothing;
    get diagnostics v_added = row_count;
    if v_added > 0 then
      perform public.sa_log_access_change(null, 'compat_role.permission_materialized', null, 'sa_business_role', v_role.id::text,
        jsonb_build_object('role_key', v_role.role_key, 'role_code', v_role.role_code, 'role_level', v_role.role_level,
                           'permission_key', 'platform.user.password_reset', 'migration', '20261025100000'),
        'Compatibility rule (role level <= 10) for administrative password reset was not materialized while legacy authorization was read-only',
        'system');
      raise notice 'added platform.user.password_reset to % (level %)', v_role.role_key, v_role.role_level;
    end if;
  end loop;
end $grant$;

-- ---------------------------------------------------------------------------
-- 2. Post-conditions
-- ---------------------------------------------------------------------------
do $post$
declare v_bad text; v_users integer;
begin
  -- No migration mode changed.
  if exists (select 1 from public.sa_migration_modes m full join public.sa_mig_20261025_modes_before b using (permission_key)
             where m.mode is distinct from b.mode) then
    raise exception 'postcondition: a migration mode changed';
  end if;
  -- No assignment created, removed or altered.
  if (select (n, h) from public.sa_mig_20261025_assign_before) is distinct from
     (select (count(*)::bigint, coalesce(sum(hashtext(id::text || status || coalesce(effective_until::text, ''))), 0)::bigint) from public.sa_role_assignments) then
    raise exception 'postcondition: role assignments changed';
  end if;
  -- Only compatibility roles of level <= 10 hold the key among legacy roles (never MANAGER / POWER_USER / USER / SHOP).
  select string_agg(b.role_key, ', ') into v_bad
  from public.sa_business_role_permissions rp
  join public.sa_business_roles b on b.id = rp.role_id and b.source = 'legacy'
  join public.sa_permissions p on p.id = rp.permission_id and p.permission_key = 'platform.user.password_reset'
  left join public.roles r on public.sa_compat_role_key(r.role_code) = b.role_key
  where coalesce(r.role_level, 999) > 10;
  if v_bad is not null then
    raise exception 'postcondition: password reset reached a compatibility role above level 10: %', v_bad;
  end if;
  -- Still sensitive, still partner-forbidden.
  if not public.sa_permission_is_sensitive('platform.user.password_reset')
     or not public.sa_permission_forbidden_for_partner('platform.user.password_reset') then
    raise exception 'postcondition: platform.user.password_reset classification changed';
  end if;

  select count(distinct a.user_id) into v_users
  from public.sa_role_assignments a
  join public.sa_business_role_permissions rp on rp.role_id = a.role_id
  join public.sa_permissions p on p.id = rp.permission_id and p.permission_key = 'platform.user.password_reset'
  where a.status = 'active' and (a.effective_until is null or a.effective_until > now());
  raise notice 'people holding platform.user.password_reset through an active assignment: %', v_users;
end $post$;

drop table public.sa_mig_20261025_modes_before;
drop table public.sa_mig_20261025_assign_before;
