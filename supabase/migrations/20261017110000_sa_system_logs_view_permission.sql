-- ============================================================================
-- Security & Access — View System Logs (platform.system_logs.view)
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database,
-- so nothing in this file has been run against a real database (throwaway PostgreSQL 17 only:
-- supabase/tests/security/system_logs/run.sh).
--
-- Audit (2026-10-07). No permission covered application diagnostics. The nearest keys were rejected:
--   security.audit.view               S&A decision/change audit (authorization evidence), sensitive security.*.
--   platform.notification_monitor.view delivery monitors (message status), a different audience.
--   platform.settings.manage / platform.user.manage  open Settings / User Management; must NOT imply log access.
-- So the key is new. No existing Group Policy is a "diagnostic reviewer" for application logs: notification-monitor-
-- viewer and access-reviewer serve other audiences and are not extended.
--
-- What this adds
--   1. Permission   platform.system_logs.view   "View System Logs"   (Platform & Settings → System)
--                   audit_sensitivity security_sensitive (every decision is recorded). Not grant-sensitive.
--   2. Compatibility rule: role level <= 1 (central Super Admin only). Settings (<= 40) and User Management
--      administrators do not get it.
--   3. Migration mode SHADOW. While SHADOW the route's legacy evaluator decides, and that evaluator is the same
--      audience: an active central Super Admin (role level 1). To let holders of the System Log Viewer policy in,
--      management moves the key to NEW_ENFORCED (Security & Access → Migration Modes) after assigning it; the
--      compatibility role keeps Super Admins in, so enforcing cannot lock everyone out.
--   4. Readiness: GET /api/system-logs, /api/system-logs/[id] and the System Logs page decide through this permission
--      on the viewer's organization, and list only organizations S&A answers for (sa_readable_organizations in a
--      new-model mode; every organization for the legacy Super Admin). The log tables are service-role only.
--   5. Standard Group Policy "System Log Viewer" (role_key system-log-viewer): exactly this one permission, internal
--      accounts, published, assigned to NO ONE. Platform & Settings Full Access is deliberately NOT extended
--      (sa_standard_policy_drift() will list the key for that policy; that is intended: platform administrators do
--      not automatically read other users' diagnostics).
--
-- Not changed: no mode is enforced, no assignment is created, no existing policy is modified, no existing migration
-- is edited, sa_permission_is_sensitive() is not redefined.
--
-- Order: requires 20261005110000_sa_access_profiles.sql and 20261009100000_sa_group_policies_full_access.sql (and the
-- foundations before them). Apply after 20261016100000_sa_user_password_reset_permission.sql and
-- 20261017100000_system_logs_foundation.sql. Mirrors app/src/lib/security-access/system-logs-catalog.ts
-- (lock-step test system-logs-catalog.test.ts).
--
-- Repeat-safe. Rollback (only while unused: mode not enforced, policy unassigned):
--   delete from public.sa_business_roles where role_key = 'system-log-viewer';
--   delete from public.sa_migration_modes where permission_key = 'platform.system_logs.view';
--   delete from public.sa_enforcement_readiness where permission_key = 'platform.system_logs.view';
--   delete from public.sa_legacy_compat_rules where permission_key = 'platform.system_logs.view';
--   delete from public.sa_business_role_permissions where permission_id in (select id from public.sa_permissions where permission_key = 'platform.system_logs.view');
--   delete from public.sa_permissions where permission_key = 'platform.system_logs.view';
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
 ('platform.system_logs.view','platform','system_logs','view','View System Logs: diagnostic errors and recorded user activity for organizations in scope','new','security_sensitive')
on conflict (permission_key) do nothing;

insert into public.sa_legacy_compat_rules(permission_key, max_role_level, role_codes, legacy_permissions, employee_baseline, notes) values
 ('platform.system_logs.view', 1, '{}', '{}', false,
  'Central Super Admin only. Settings and User Management administrators do not get System Logs (system-logs-catalog.ts).')
on conflict (permission_key) do update set max_role_level = excluded.max_role_level, role_codes = excluded.role_codes,
  legacy_permissions = excluded.legacy_permissions, employee_baseline = excluded.employee_baseline,
  notes = excluded.notes, updated_at = now();

insert into public.sa_migration_modes(permission_key, mode, legacy_permission_key, notes) values
 ('platform.system_logs.view', 'SHADOW', null,
  'System Logs: the route''s legacy rule (active central Super Admin) decides while the new model is evaluated; enforce to let System Log Viewer holders in.')
on conflict (permission_key) do nothing;

insert into public.sa_enforcement_readiness(permission_key, route_wiring, database_backstop, intentional_tightening, notes) values
 ('platform.system_logs.view', true, 'read_only', null,
  'GET /api/system-logs and /api/system-logs/[id] and the System Logs page decide through S&A on the viewer''s organization and list only readable organizations. Log tables and functions are service-role only.')
on conflict (permission_key) do update set route_wiring = excluded.route_wiring, database_backstop = excluded.database_backstop,
  intentional_tightening = excluded.intentional_tightening, notes = excluded.notes;

-- ---------------------------------------------------------------------------
-- 2. Standard Group Policy "System Log Viewer" (not assigned to anyone)
-- ---------------------------------------------------------------------------
do $seed$
declare
  v_key constant text := 'system-log-viewer';
  v_perms constant text[] := array['platform.system_logs.view'];
  v_role uuid;
  v_existing text;
begin
  select b.source into v_existing from public.sa_business_roles b where b.role_key = v_key;
  if v_existing is not null and v_existing <> 'template' then
    raise exception 'sa_group_policy_key_conflict: % already exists as a non-standard role', v_key;
  end if;

  insert into public.sa_business_roles(role_key, name, description, source, status, applicable_account_types, applicable_org_types)
  values (v_key, 'System Log Viewer',
    'Read System Logs (diagnostic errors and recorded user activity) for the organizations in scope, and copy sanitized diagnostic reports. Nothing else: it does not open other Settings, change data or manage users.',
    'template', 'active', array['internal'], '{}')
  on conflict (role_key) do nothing
  returning id into v_role;

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
    'Standard System Log Viewer group policy seeded (not assigned to anyone)', 'system');
end $seed$;

-- ---------------------------------------------------------------------------
-- 3. Compatibility roles gain the key only while legacy authorization is still writable
-- ---------------------------------------------------------------------------
select public.sa_refresh_compat_role(r.role_code, false)
from public.roles r
where not public.sa_setting_bool('legacy_authorization.read_only', false)
  and r.role_level <= 1
  and exists (select 1 from public.sa_business_roles br where br.role_key = public.sa_compat_role_key(r.role_code));

-- ---------------------------------------------------------------------------
-- 4. Post-conditions
-- ---------------------------------------------------------------------------
do $post$
declare v_assigned integer;
begin
  if (select mode from public.sa_migration_modes where permission_key = 'platform.system_logs.view') is distinct from 'SHADOW' then
    raise exception 'postcondition: platform.system_logs.view must be in SHADOW mode (this migration enforces nothing)';
  end if;
  if (select max_role_level from public.sa_legacy_compat_rules where permission_key = 'platform.system_logs.view') is distinct from 1 then
    raise exception 'postcondition: System Logs compatibility audience must be the central Super Admin only';
  end if;
  if exists (select 1 from public.sa_business_roles b where b.role_key = 'system-log-viewer'
             and (select array_agg(p.permission_key order by p.permission_key) from public.sa_business_role_permissions rp
                  join public.sa_permissions p on p.id = rp.permission_id where rp.role_id = b.id) is distinct from array['platform.system_logs.view']) then
    raise exception 'postcondition: system-log-viewer must hold exactly platform.system_logs.view';
  end if;
  if exists (select 1 from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id
             join public.sa_business_roles b on b.id = rp.role_id
             where p.permission_key = 'platform.system_logs.view' and b.role_key <> 'system-log-viewer'
               and b.role_key not like 'legacy-%') then
    raise exception 'postcondition: no other Group Policy may hold platform.system_logs.view';
  end if;
  select count(*) into v_assigned from public.sa_role_assignments a join public.sa_business_roles b on b.id = a.role_id
  where b.role_key = 'system-log-viewer';
  raise notice 'system-log-viewer assignments: % (this migration assigns none)', v_assigned;
end $post$;
