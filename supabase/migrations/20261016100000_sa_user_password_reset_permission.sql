-- ============================================================================
-- Security & Access — dedicated administrative password-reset permission
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database,
-- so nothing in this file has been run against a real database.
--
-- Audit (2026-10-07). POST /api/users/reset-password decided through platform.user.manage — the same permission that
-- opens User Management and edits profiles (catalogue: "Administer user profiles, credentials resets and phone
-- changes"), with the legacy rule "role level exactly 10". Anyone granted profile administration therefore also held
-- password reset. Resetting someone's login is credential control, so it gets its own key. No dedicated reset
-- permission existed (platform.user.profile_edit is profile data only; platform.identity_access.manage is role /
-- organization changes and stays the TARGET-protection rule of the reset route).
--
-- What this adds
--   1. Permission   platform.user.password_reset   "Reset User Password"   (Platform & Settings → User Administration)
--                   security_sensitive. Partner accounts can never hold it (sa_permission_forbidden_for_partner already
--                   covers platform.user.%).
--   2. Compatibility rule: role level <= 10 (the audience of today's route rule; a central Super Admin is level 1).
--      This is deliberately NARROWER than platform.user.manage (<= 30 / edit_users): profile editors do NOT get reset.
--   3. Migration mode SHADOW. While SHADOW the route's legacy evaluator (role level exactly 10, unchanged) decides, so
--      every administrator who can reset today still can. Management moves the key to NEW_ENFORCED after reviewing
--      parity, with sa_set_migration_mode (Security & Access → Migration Modes).
--   4. Readiness: the only path that sets another user's password is the route (service-role Auth Admin API; no API-role
--      path exists), and the route now decides through this permission for the TARGET user's organization.
--   5. sa_permission_is_sensitive() also returns true for the key (mirror: profiles.ts isSensitivePermission). A policy
--      holding it can be granted only by an administrator who holds it in that organization (the rule that already
--      protects security.* and the data-reset permissions), so Grant Policy cannot hand out reset authority the grantor
--      lacks. No existing policy changes classification (Platform & Settings Full Access is already sensitive).
--   6. Standard Group Policy "User Password Administrator" (role_key user-password-administrator): exactly this one
--      permission, internal accounts, published, assigned to NO ONE.
--   7. Platform & Settings Full Access (platform-settings-full-access, "every Platform & Settings permission") is
--      extended with the key through sa_extend_standard_policy (owner only, audited per current holder). Reason: it
--      already contained platform.user.manage, the key reset used before; leaving it out would silently remove reset
--      from its holders once the key is enforced, and make the policy's "every permission" description untrue.
--      Group Policies that are NOT extended: Identity Administrator (identity-administrator) keeps profile/lifecycle
--      work without reset; profile-administrator keeps profile editing only. Nothing else gains reset.
--
-- Not changed: no mode moves to an enforced value, no assignment is created or removed, no existing policy other than
-- Platform & Settings Full Access is touched, no existing migration is edited.
--
-- Lockout check. Today's route decides by role level 10 only. After this migration (SHADOW) that is still the decider.
-- When management later enforces the key, who may reset is: holders of Platform & Settings Full Access, of User
-- Password Administrator, and (while legacy authorization is writable) the compatibility roles of levels <= 10. People
-- who could reset ONLY because they hold platform.user.manage through a Security & Access assignment (and are not level
-- 10) would lose it at that point: section 8 reports how many exist so they can be given User Password Administrator
-- first. It only counts; it changes nothing.
--
-- Order: requires 20261005110000_sa_access_profiles.sql and 20261009100000_sa_group_policies_full_access.sql (and the
-- Identity Foundation / Final Wave migrations before them). Apply after 20261015100000_sa_initial_policy_same_authority_as_grant.sql.
-- Mirrors app/src/lib/security-access/user-admin-catalog.ts (lock-step test user-admin-catalog.test.ts).
--
-- Repeat-safe (on conflict do nothing / do update; an existing role is never modified or re-seeded).
-- Rollback (only while the key is unused, i.e. before enforcing it and while the policy is unassigned):
--   delete from public.sa_business_roles where role_key = 'user-password-administrator';
--   delete from public.sa_migration_modes where permission_key = 'platform.user.password_reset';
--   delete from public.sa_enforcement_readiness where permission_key = 'platform.user.password_reset';
--   delete from public.sa_legacy_compat_rules where permission_key = 'platform.user.password_reset';
--   delete from public.sa_business_role_permissions where permission_id in (select id from public.sa_permissions where permission_key = 'platform.user.password_reset');
--   delete from public.sa_permissions where permission_key = 'platform.user.password_reset';
--   -- and re-create sa_permission_is_sensitive() without the key (definition in 20261005110000).
-- ============================================================================

do $pre$
begin
  if to_regclass('public.sa_standard_policy_coverage') is null then
    raise exception 'sa_prerequisite_missing: apply 20261009100000_sa_group_policies_full_access.sql first';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sa_business_roles' and column_name = 'applicable_account_types') then
    raise exception 'sa_prerequisite_missing: apply 20261005110000_sa_access_profiles.sql first';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Permission, compatibility rule, mode, readiness
-- ---------------------------------------------------------------------------
insert into public.sa_permissions(permission_key, module, resource, action, description, source, audit_sensitivity) values
 ('platform.user.password_reset','platform','user','password_reset','Reset another user''s login password (administrative reset)','new','security_sensitive')
on conflict (permission_key) do nothing;

insert into public.sa_legacy_compat_rules(permission_key, max_role_level, role_codes, legacy_permissions, employee_baseline, notes) values
 ('platform.user.password_reset', 10, '{}', '{}', false,
  'Audience of the legacy reset rule (HQ Admin level 10, plus central Super Admin). Intentionally narrower than platform.user.manage: profile editors do not get reset (user-admin-catalog.ts).')
on conflict (permission_key) do update set max_role_level = excluded.max_role_level, role_codes = excluded.role_codes,
  legacy_permissions = excluded.legacy_permissions, employee_baseline = excluded.employee_baseline,
  notes = excluded.notes, updated_at = now();

insert into public.sa_migration_modes(permission_key, mode, legacy_permission_key, notes) values
 ('platform.user.password_reset', 'SHADOW', null,
  'User Administration: the route''s legacy rule (role level 10) decides while the new model is evaluated and logged; management enforces after parity review.')
on conflict (permission_key) do nothing;

insert into public.sa_enforcement_readiness(permission_key, route_wiring, database_backstop, intentional_tightening, notes) values
 ('platform.user.password_reset', true, 'decision_backstop', null,
  'POST /api/users/reset-password decides through S&A for the target user''s organization (legacy evaluator until enforced). It is the only path that sets another user''s password: the Auth Admin API needs the service role and no API-role path exists.')
on conflict (permission_key) do update set route_wiring = excluded.route_wiring, database_backstop = excluded.database_backstop,
  intentional_tightening = excluded.intentional_tightening, notes = excluded.notes;

-- ---------------------------------------------------------------------------
-- 2. Sensitive: assignable only by someone who holds it (mirror: profiles.ts isSensitivePermission)
-- ---------------------------------------------------------------------------
create or replace function public.sa_permission_is_sensitive(p_key text)
returns boolean language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p_key like 'security.%' or p_key in ('hr.data.reset','platform.data.destructive','finance.data.reset','platform.user.password_reset')
$$;

-- ---------------------------------------------------------------------------
-- 3. Standard Group Policy "User Password Administrator" (not assigned to anyone)
-- ---------------------------------------------------------------------------
do $seed$
declare
  v_key constant text := 'user-password-administrator';
  v_perms constant text[] := array['platform.user.password_reset'];
  v_role uuid;
  v_existing text;
begin
  select b.source into v_existing from public.sa_business_roles b where b.role_key = v_key;
  if v_existing is not null and v_existing <> 'template' then
    raise exception 'sa_group_policy_key_conflict: % already exists as a non-standard role', v_key;
  end if;

  insert into public.sa_business_roles(role_key, name, description, source, status, applicable_account_types, applicable_org_types)
  values (v_key, 'User Password Administrator',
    'Reset another user''s login password. Nothing else: it does not open User Management, edit profiles or change access. Target protection still applies (a higher-privilege account cannot be reset). Granting it requires holding it yourself in that organization.',
    'template', 'active', array['internal'], '{}')
  on conflict (role_key) do nothing
  returning id into v_role;

  -- Already present: never modified, never expanded, never re-recorded here.
  if v_role is null then return; end if;

  insert into public.sa_business_role_permissions(role_id, permission_id)
  select v_role, p.id from public.sa_permissions p where p.permission_key = any(v_perms) and p.status = 'active';
  if (select count(*) from public.sa_business_role_permissions where role_id = v_role) <> cardinality(v_perms) then
    raise exception 'sa_group_policy_permission_missing: % (%)', v_key, array_to_string(v_perms, ', ');
  end if;

  insert into public.sa_standard_policy_coverage(role_id, role_key, module_id, module_prefixes, permission_keys)
  values (v_role, v_key, 'platform_settings', array['platform'], v_perms);

  perform public.sa_log_access_change(null, 'access_profile.standard_seeded', null, 'sa_business_role', v_role::text,
    jsonb_build_object('role_key', v_key, 'module', 'platform_settings', 'permission_count', cardinality(v_perms)),
    'Standard User Password Administrator group policy seeded (not assigned to anyone)', 'system');
end $seed$;

-- ---------------------------------------------------------------------------
-- 4. Platform & Settings Full Access holds "every Platform & Settings permission": extend it (audited per holder)
-- ---------------------------------------------------------------------------
do $extend$
begin
  if exists (select 1 from public.sa_standard_policy_coverage where role_key = 'platform-settings-full-access')
     and not exists (select 1 from public.sa_standard_policy_coverage c
                     where c.role_key = 'platform-settings-full-access' and 'platform.user.password_reset' = any(c.permission_keys)) then
    perform public.sa_extend_standard_policy('platform-settings-full-access', array['platform.user.password_reset'],
      'User Administration: Platform & Settings Full Access holds every Platform & Settings permission and already included platform.user.manage, the key administrative password reset used before this dedicated permission existed.');
  end if;
end $extend$;

-- ---------------------------------------------------------------------------
-- 5. Compatibility roles gain the key only while legacy authorization is still writable (production today)
-- ---------------------------------------------------------------------------
select public.sa_refresh_compat_role(r.role_code, false)
from public.roles r
where not public.sa_setting_bool('legacy_authorization.read_only', false)
  and exists (select 1 from public.sa_business_roles br where br.role_key = public.sa_compat_role_key(r.role_code));

-- ---------------------------------------------------------------------------
-- 6. Post-conditions
-- ---------------------------------------------------------------------------
do $post$
declare v_assigned integer;
begin
  if (select mode from public.sa_migration_modes where permission_key = 'platform.user.password_reset') is distinct from 'SHADOW' then
    raise exception 'postcondition: platform.user.password_reset must be in SHADOW mode (this migration enforces nothing)';
  end if;
  if not public.sa_permission_is_sensitive('platform.user.password_reset')
     or public.sa_permission_is_sensitive('platform.user.manage')
     or public.sa_permission_is_sensitive('platform.user.profile_edit')
     or not public.sa_permission_is_sensitive('security.role.assign')
     or not public.sa_permission_is_sensitive('platform.data.destructive') then
    raise exception 'postcondition: sensitive-permission classification is wrong';
  end if;
  if not public.sa_permission_forbidden_for_partner('platform.user.password_reset') then
    raise exception 'postcondition: password reset must be forbidden for partner policies';
  end if;
  if exists (select 1 from public.sa_business_roles b where b.role_key = 'user-password-administrator'
             and (select array_agg(p.permission_key order by p.permission_key) from public.sa_business_role_permissions rp
                  join public.sa_permissions p on p.id = rp.permission_id where rp.role_id = b.id) is distinct from array['platform.user.password_reset']) then
    raise exception 'postcondition: user-password-administrator must hold exactly platform.user.password_reset';
  end if;
  select count(*) into v_assigned from public.sa_role_assignments a join public.sa_business_roles b on b.id = a.role_id
  where b.role_key = 'user-password-administrator';
  raise notice 'user-password-administrator assignments: % (this migration assigns none)', v_assigned;
end $post$;

-- ---------------------------------------------------------------------------
-- 7. Report only: who could reset today through platform.user.manage alone (and not at legacy level 10)?
-- ---------------------------------------------------------------------------
do $report$
declare v_count integer;
begin
  select count(distinct a.user_id) into v_count
  from public.sa_role_assignments a
  join public.sa_business_role_permissions rp on rp.role_id = a.role_id
  join public.sa_permissions p on p.id = rp.permission_id and p.permission_key = 'platform.user.manage'
  join public.users u on u.id = a.user_id
  left join public.roles r on r.role_code = u.role_code
  where a.status = 'active' and (a.effective_until is null or a.effective_until > now())
    and coalesce(r.role_level, 999) > 10
    and not exists (select 1 from public.sa_role_assignments a2 join public.sa_business_role_permissions rp2 on rp2.role_id = a2.role_id
                    join public.sa_permissions p2 on p2.id = rp2.permission_id and p2.permission_key = 'platform.user.password_reset'
                    where a2.user_id = a.user_id and a2.status = 'active');
  raise notice 'People holding platform.user.manage through a Security & Access assignment (not role level <= 10) and no reset authority: %. Grant User Password Administrator to those who must keep resetting BEFORE enforcing platform.user.password_reset.', v_count;
end $report$;
