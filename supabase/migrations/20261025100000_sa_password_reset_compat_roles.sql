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

-- ONE statement on purpose. The staging runner does not carry state between statements (a work table created by one
-- statement was "does not exist" for the next, 42P01 on 2026-10-08; temp tables failed the same way on 2026-09-27).
-- Everything below, including the before-snapshot used by the post-conditions, lives inside this single DO block,
-- so it is all-or-nothing in any client (SQL editor, psql, autocommit or single transaction). No work tables.
do $migration$
declare
  v_perm uuid;
  v_rule record;
  v_role record;
  v_added integer;
  v_modes_before jsonb;
  v_assign_before text;
  v_bad text;
  v_users integer;
begin
  -- Prerequisites
  select id into v_perm from public.sa_permissions where permission_key = 'platform.user.password_reset' and status = 'active';
  if v_perm is null then
    raise exception 'sa_prerequisite_missing: apply 20261016100000_sa_user_password_reset_permission.sql first';
  end if;
  select * into v_rule from public.sa_legacy_compat_rules where permission_key = 'platform.user.password_reset';
  if not found then
    raise exception 'sa_prerequisite_missing: compatibility rule for platform.user.password_reset';
  end if;

  -- Before-state (in variables)
  select coalesce(jsonb_object_agg(permission_key, mode), '{}'::jsonb) into v_modes_before from public.sa_migration_modes;
  select md5(coalesce(string_agg(id::text || ':' || status || ':' || coalesce(effective_until::text, ''), ',' order by id), ''))
    into v_assign_before from public.sa_role_assignments;

  -- 1. Compatibility roles selected by the key's own rule gain the key (audited per role)
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

  -- 2. Post-conditions (any failure rolls the whole block back)
  if (select coalesce(jsonb_object_agg(permission_key, mode), '{}'::jsonb) from public.sa_migration_modes) is distinct from v_modes_before then
    raise exception 'postcondition: a migration mode changed';
  end if;
  if (select md5(coalesce(string_agg(id::text || ':' || status || ':' || coalesce(effective_until::text, ''), ',' order by id), ''))
      from public.sa_role_assignments) is distinct from v_assign_before then
    raise exception 'postcondition: role assignments changed';
  end if;
  select string_agg(b.role_key, ', ') into v_bad
  from public.sa_business_role_permissions rp
  join public.sa_business_roles b on b.id = rp.role_id and b.source = 'legacy'
  where rp.permission_id = v_perm
    and coalesce((select r.role_level from public.roles r where public.sa_compat_role_key(r.role_code) = b.role_key limit 1), 999) > 10;
  if v_bad is not null then
    raise exception 'postcondition: password reset reached a compatibility role above level 10: %', v_bad;
  end if;
  if not public.sa_permission_is_sensitive('platform.user.password_reset')
     or not public.sa_permission_forbidden_for_partner('platform.user.password_reset') then
    raise exception 'postcondition: platform.user.password_reset classification changed';
  end if;

  select count(distinct a.user_id) into v_users
  from public.sa_role_assignments a
  join public.sa_business_role_permissions rp on rp.role_id = a.role_id and rp.permission_id = v_perm
  where a.status = 'active' and (a.effective_until is null or a.effective_until > now());
  raise notice 'people holding platform.user.password_reset through an active assignment: %', v_users;
end $migration$;
