-- ============================================================================
-- Security & Access — Access Profiles (standard / custom, draft → review →
-- publish) and multi-profile provisioning
-- ----------------------------------------------------------------------------
-- An Access Profile IS a business role (sa_business_roles) — no second
-- authorization engine. Evaluation, assignments, scopes, SoD and the audit log
-- are unchanged; this migration adds the management lifecycle around roles:
--
--   * Standard profiles  = non-legacy roles with source 'template'. Protected:
--     never edited in place, only copied. Compatibility ('legacy') roles are
--     not profiles at all and are never editable or copyable.
--   * Custom profiles    = source 'new'. Created or copied as status 'draft'
--     (not assignable), edited ONLY through a draft row; the live permission
--     set changes only when a reviewed draft is published.
--   * Draft isolation    : sa_access_profile_drafts holds the proposed name,
--     description, applicability and EXPLICIT permission keys. Nothing in a
--     draft affects authorization (evaluation reads sa_business_role_permissions
--     only). Permissions are always listed one by one — never inherited from a
--     module, so permissions added to the catalogue later are never granted.
--   * Publishing        : sa_profile_publish_preview shows added/removed
--     permissions, every current holder (user, organization, scopes) and any
--     NEW separation-of-duties conflicts; sa_publish_profile_draft requires the
--     matching impact hash (stale → rejected), a reason when holders exist, no
--     blocking SoD conflict for any holder, and a reviewer other than the
--     submitter when holders exist (setting access_profile.allow_self_publish
--     lifts that). Every holder gets its own audit row.
--   * Retirement        : an assigned profile cannot be retired or deleted;
--     revoke or replace the assignments first.
--   * Applicability     : a profile may be limited to account types
--     (internal / partner) and organization types; sa_assign_role refuses a
--     target organization outside it. Partner-applicable profiles may not hold
--     HR, security administration, user administration or destructive data
--     permissions.
--   * Provisioning      : sa_assign_initial_profiles assigns several profiles,
--     each with its own explicit scope, inside the identity_provision
--     transaction (all or nothing). Sensitive administrative/reset profiles are
--     never assigned at provisioning.
--
-- No migration mode is changed, no role content is overwritten, no legacy
-- level or compatibility grant is touched, HR reset rules are untouched.
--
-- Rollback guidance: drop the functions/trigger/table added here and the added
-- columns; restore sa_assign_role, sa_save_business_role (20260928100000 /
-- 20260927140000) and identity_provision (20260929140000); re-add the two-value
-- status check.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------
alter table public.sa_business_roles drop constraint if exists sa_business_roles_status_check;
alter table public.sa_business_roles add constraint sa_business_roles_status_check check (status in ('draft','active','deprecated'));
alter table public.sa_business_roles add column if not exists applicable_account_types text[] not null default '{}';
alter table public.sa_business_roles add column if not exists applicable_org_types text[] not null default '{}';
alter table public.sa_business_roles add column if not exists copied_from_role_id uuid references public.sa_business_roles(id) on delete set null;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'sa_business_roles_account_types_valid') then
    alter table public.sa_business_roles add constraint sa_business_roles_account_types_valid check (applicable_account_types <@ array['internal','partner']);
  end if;
end $c$;

create table if not exists public.sa_access_profile_drafts (
  id uuid primary key default gen_random_uuid(),
  role_id uuid not null references public.sa_business_roles(id) on delete cascade,
  base_version integer not null,
  name text not null,
  description text,
  applicable_account_types text[] not null default '{}' check (applicable_account_types <@ array['internal','partner']),
  applicable_org_types text[] not null default '{}',
  permission_keys text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft','in_review','published','discarded')),
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_by uuid references public.users(id),
  updated_at timestamptz not null default now(),
  submitted_by uuid references public.users(id),
  submitted_at timestamptz,
  decided_by uuid references public.users(id),
  decided_at timestamptz,
  decision_reason text
);
create unique index if not exists sa_access_profile_one_open_draft on public.sa_access_profile_drafts(role_id) where status in ('draft','in_review');
alter table public.sa_access_profile_drafts enable row level security;
alter table public.sa_access_profile_drafts force row level security;
revoke all on table public.sa_access_profile_drafts from public, anon, authenticated, service_role;
grant select on table public.sa_access_profile_drafts to service_role;
comment on table public.sa_access_profile_drafts is
  'Proposed changes to a custom Access Profile. Never read by authorization: live access changes only when a draft is published.';

insert into public.sa_settings(setting_key, setting_value, description)
values ('access_profile.allow_self_publish', 'false'::jsonb,
        'When true, the person who submitted a profile change may also publish it even if it affects existing holders. Default false (maker-checker).')
on conflict (setting_key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------
create or replace function public.sa_org_account_type(p_org uuid)
returns text language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select case when upper(o.org_type_code) in ('MFG','DIST','SHOP') then 'partner' else 'internal' end
  from public.organizations o where o.id = p_org
$$;
revoke all on function public.sa_org_account_type(uuid) from public, anon, authenticated;

create or replace function public.sa_profile_applicable(p_role uuid, p_org uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce((
    select (cardinality(r.applicable_account_types) = 0 or public.sa_org_account_type(p_org) = any(r.applicable_account_types))
       and (cardinality(r.applicable_org_types) = 0 or upper((select o.org_type_code from public.organizations o where o.id = p_org)) = any(r.applicable_org_types))
    from public.sa_business_roles r where r.id = p_role), false)
$$;
revoke all on function public.sa_profile_applicable(uuid,uuid) from public, anon, authenticated;

-- Administrative / destructive permissions: such profiles are never assigned at provisioning.
create or replace function public.sa_permission_is_sensitive(p_key text)
returns boolean language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p_key like 'security.%' or p_key in ('hr.data.reset','platform.data.destructive','finance.data.reset')
$$;
-- Never allowed in a profile that applies to partner accounts.
create or replace function public.sa_permission_forbidden_for_partner(p_key text)
returns boolean language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p_key like 'hr.%' or p_key like 'security.%' or p_key like 'platform.user.%' or p_key like 'platform.data.%' or p_key like 'finance.data.%'
$$;

create or replace function public.sa_profile_sensitive(p_role uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select exists (select 1 from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id
                 where rp.role_id = p_role and public.sa_permission_is_sensitive(p.permission_key))
$$;
revoke all on function public.sa_profile_sensitive(uuid) from public, anon, authenticated;

create or replace function public.sa_assert_profile_manager(p_actor uuid)
returns void language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform public.sa_assert_actor_permission(p_actor, 'security.role.manage', '{}'::jsonb, public.sa_legacy_is_super_admin(p_actor));
end $$;
revoke all on function public.sa_assert_profile_manager(uuid) from public, anon, authenticated;

create or replace function public.sa_profile_active_holders(p_role uuid)
returns table(assignment_id uuid, user_id uuid, membership_id uuid, organization_id uuid)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select a.id, a.user_id, a.membership_id, m.organization_id
  from public.sa_role_assignments a join public.sa_organization_memberships m on m.id = a.membership_id
  where a.role_id = p_role and a.status = 'active' and (a.effective_until is null or a.effective_until > now())
$$;
revoke all on function public.sa_profile_active_holders(uuid) from public, anon, authenticated;

-- Normalises and validates a proposed permission list (explicit keys only).
create or replace function public.sa_profile_clean_permissions(p_keys text[], p_account_types text[])
returns text[] language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_keys text[]; v_found integer; v_bad text;
begin
  select coalesce(array_agg(distinct k order by k), '{}') into v_keys from unnest(coalesce(p_keys, '{}')) k;
  if cardinality(v_keys) > 300 then raise exception 'sa_profile_too_large'; end if;
  select count(*) into v_found from public.sa_permissions where status = 'active' and permission_key = any(v_keys);
  if v_found <> cardinality(v_keys) then raise exception 'sa_profile_invalid_permission'; end if;
  if 'partner' = any(coalesce(p_account_types, '{}')) then
    select k into v_bad from unnest(v_keys) k where public.sa_permission_forbidden_for_partner(k) limit 1;
    if v_bad is not null then raise exception 'sa_profile_partner_forbidden: %', v_bad; end if;
  end if;
  return v_keys;
end $$;
revoke all on function public.sa_profile_clean_permissions(text[],text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Create / copy / draft / review
-- ---------------------------------------------------------------------------
create or replace function public.sa_create_access_profile(
  p_actor uuid, p_role_key text, p_name text, p_description text, p_account_types text[], p_org_types text[],
  p_permission_keys text[], p_copied_from uuid default null)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_role uuid; v_keys text[]; v_org_types text[];
begin
  perform public.sa_assert_profile_manager(p_actor);
  if p_role_key is null or p_role_key !~ '^[a-z][a-z0-9_-]*$' or length(p_role_key) > 80 or p_name is null or btrim(p_name) = '' then raise exception 'sa_profile_invalid'; end if;
  if exists (select 1 from public.sa_business_roles where role_key = p_role_key) then raise exception 'sa_profile_key_taken'; end if;
  select coalesce(array_agg(distinct upper(btrim(t))), '{}') into v_org_types from unnest(coalesce(p_org_types, '{}')) t where btrim(t) <> '';
  v_keys := public.sa_profile_clean_permissions(p_permission_keys, p_account_types);
  insert into public.sa_business_roles(role_key, name, description, source, status, applicable_account_types, applicable_org_types, copied_from_role_id, created_by, updated_by)
  values (p_role_key, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), 'new', 'draft', coalesce(p_account_types, '{}'), v_org_types, p_copied_from, p_actor, p_actor)
  returning id into v_role;
  insert into public.sa_access_profile_drafts(role_id, base_version, name, description, applicable_account_types, applicable_org_types, permission_keys, created_by, updated_by)
  values (v_role, 1, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), coalesce(p_account_types, '{}'), v_org_types, v_keys, p_actor, p_actor);
  perform public.sa_log_access_change(p_actor, case when p_copied_from is null then 'access_profile.created' else 'access_profile.copied' end, null,
    'sa_business_role', v_role::text, jsonb_build_object('role_key', p_role_key, 'copied_from', p_copied_from, 'permission_count', cardinality(v_keys)), null);
  return v_role;
end $$;
revoke all on function public.sa_create_access_profile(uuid,text,text,text,text[],text[],text[],uuid) from public, anon, authenticated;
grant execute on function public.sa_create_access_profile(uuid,text,text,text,text[],text[],text[],uuid) to service_role;

create or replace function public.sa_copy_access_profile(p_actor uuid, p_source uuid, p_role_key text, p_name text, p_reason text)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_src record; v_keys text[];
begin
  perform public.sa_assert_profile_manager(p_actor);
  if p_reason is null or length(btrim(p_reason)) < 10 then raise exception 'sa_reason_required'; end if;
  select * into v_src from public.sa_business_roles where id = p_source;
  if not found then raise exception 'sa_profile_not_found'; end if;
  if v_src.source = 'legacy' then raise exception 'sa_profile_legacy_not_copyable' using hint = 'Compatibility roles are not Access Profiles.'; end if;
  if v_src.status = 'draft' then raise exception 'sa_profile_not_published'; end if;
  select coalesce(array_agg(p.permission_key order by p.permission_key), '{}') into v_keys
  from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id and p.status = 'active' where rp.role_id = p_source;
  return public.sa_create_access_profile(p_actor, p_role_key, coalesce(nullif(btrim(p_name), ''), 'Copy of ' || v_src.name), v_src.description,
    v_src.applicable_account_types, v_src.applicable_org_types, v_keys, p_source);
end $$;
revoke all on function public.sa_copy_access_profile(uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.sa_copy_access_profile(uuid,uuid,text,text,text) to service_role;

create or replace function public.sa_save_profile_draft(
  p_actor uuid, p_role uuid, p_name text, p_description text, p_account_types text[], p_org_types text[], p_permission_keys text[])
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_role record; v_keys text[]; v_org_types text[]; v_draft uuid;
begin
  perform public.sa_assert_profile_manager(p_actor);
  select * into v_role from public.sa_business_roles where id = p_role for update;
  if not found then raise exception 'sa_profile_not_found'; end if;
  if v_role.source = 'template' then raise exception 'sa_profile_standard_protected' using hint = 'Copy & customize the standard profile instead.'; end if;
  if v_role.source <> 'new' then raise exception 'sa_profile_not_editable'; end if;
  if v_role.status = 'deprecated' then raise exception 'sa_profile_retired'; end if;
  if p_name is null or btrim(p_name) = '' then raise exception 'sa_profile_invalid'; end if;
  if exists (select 1 from unnest(coalesce(p_account_types, '{}')) t where t not in ('internal','partner')) then raise exception 'sa_profile_invalid'; end if;
  select coalesce(array_agg(distinct upper(btrim(t))), '{}') into v_org_types from unnest(coalesce(p_org_types, '{}')) t where btrim(t) <> '';
  v_keys := public.sa_profile_clean_permissions(p_permission_keys, p_account_types);
  update public.sa_access_profile_drafts set name = btrim(p_name), description = nullif(btrim(coalesce(p_description, '')), ''),
      applicable_account_types = coalesce(p_account_types, '{}'), applicable_org_types = v_org_types, permission_keys = v_keys,
      status = 'draft', submitted_by = null, submitted_at = null, updated_by = p_actor, updated_at = now(), base_version = v_role.version
  where role_id = p_role and status in ('draft','in_review') returning id into v_draft;
  if v_draft is null then
    insert into public.sa_access_profile_drafts(role_id, base_version, name, description, applicable_account_types, applicable_org_types, permission_keys, created_by, updated_by)
    values (p_role, v_role.version, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), coalesce(p_account_types, '{}'), v_org_types, v_keys, p_actor, p_actor)
    returning id into v_draft;
  end if;
  perform public.sa_log_access_change(p_actor, 'access_profile.draft_saved', null, 'sa_business_role', p_role::text,
    jsonb_build_object('draft_id', v_draft, 'permission_count', cardinality(v_keys)), null);
  return v_draft;
end $$;
revoke all on function public.sa_save_profile_draft(uuid,uuid,text,text,text[],text[],text[]) from public, anon, authenticated;
grant execute on function public.sa_save_profile_draft(uuid,uuid,text,text,text[],text[],text[]) to service_role;

create or replace function public.sa_submit_profile_draft(p_actor uuid, p_role uuid)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_n integer;
begin
  perform public.sa_assert_profile_manager(p_actor);
  update public.sa_access_profile_drafts set status = 'in_review', submitted_by = p_actor, submitted_at = now()
  where role_id = p_role and status = 'draft';
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'sa_profile_no_draft'; end if;
  perform public.sa_log_access_change(p_actor, 'access_profile.submitted', null, 'sa_business_role', p_role::text, '{}'::jsonb, null);
end $$;
revoke all on function public.sa_submit_profile_draft(uuid,uuid) from public, anon, authenticated;
grant execute on function public.sa_submit_profile_draft(uuid,uuid) to service_role;

create or replace function public.sa_discard_profile_draft(p_actor uuid, p_role uuid, p_reason text)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_n integer; v_status text;
begin
  perform public.sa_assert_profile_manager(p_actor);
  if p_reason is null or length(btrim(p_reason)) < 5 then raise exception 'sa_reason_required'; end if;
  select status into v_status from public.sa_business_roles where id = p_role;
  update public.sa_access_profile_drafts set status = 'discarded', decided_by = p_actor, decided_at = now(), decision_reason = btrim(p_reason)
  where role_id = p_role and status in ('draft','in_review');
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'sa_profile_no_draft'; end if;
  perform public.sa_log_access_change(p_actor, 'access_profile.draft_discarded', null, 'sa_business_role', p_role::text, '{}'::jsonb, p_reason);
end $$;
revoke all on function public.sa_discard_profile_draft(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.sa_discard_profile_draft(uuid,uuid,text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Publication impact and publishing
-- ---------------------------------------------------------------------------
create or replace function public.sa_profile_publish_preview(p_actor uuid, p_role uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_role record; v_draft record;
  v_live text[]; v_new text[]; v_added text[]; v_removed text[];
  v_holders jsonb; v_holder_count integer; v_conflicts jsonb; v_blocking integer; v_hash text;
begin
  perform public.sa_assert_profile_manager(p_actor);
  select * into v_role from public.sa_business_roles where id = p_role;
  if not found then raise exception 'sa_profile_not_found'; end if;
  select * into v_draft from public.sa_access_profile_drafts where role_id = p_role and status in ('draft','in_review');
  if not found then raise exception 'sa_profile_no_draft'; end if;
  select coalesce(array_agg(p.permission_key order by p.permission_key), '{}') into v_live
  from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id where rp.role_id = p_role;
  select coalesce(array_agg(distinct k order by k), '{}') into v_new from unnest(v_draft.permission_keys) k;
  select coalesce(array_agg(k order by k), '{}') into v_added from (select unnest(v_new) k except select unnest(v_live)) q;
  select coalesce(array_agg(k order by k), '{}') into v_removed from (select unnest(v_live) k except select unnest(v_new)) q;

  select count(*), coalesce(jsonb_agg(jsonb_build_object(
      'assignmentId', h.assignment_id, 'userId', h.user_id, 'name', coalesce(u.full_name, u.email), 'email', u.email,
      'organizationId', h.organization_id, 'organization', o.org_name, 'organizationType', o.org_type_code,
      'scopes', coalesce((select jsonb_agg(sd.display_name order by sd.display_name) from public.sa_assignment_scopes x
                          join public.sa_scope_definitions sd on sd.id = x.scope_id where x.assignment_id = h.assignment_id), '[]'::jsonb))
      order by coalesce(u.full_name, u.email)), '[]'::jsonb)
    into v_holder_count, v_holders
  from public.sa_profile_active_holders(p_role) h
  join public.users u on u.id = h.user_id left join public.organizations o on o.id = h.organization_id;

  -- New separation-of-duties conflicts for existing holders (after minus before).
  with holders as (select distinct user_id from public.sa_profile_active_holders(p_role)),
  other as (
    select hh.user_id, p.permission_key
    from holders hh
    join public.sa_role_assignments a on a.user_id = hh.user_id and a.status = 'active' and (a.effective_until is null or a.effective_until > now()) and a.role_id <> p_role
    join public.sa_business_role_permissions rp on rp.role_id = a.role_id
    join public.sa_permissions p on p.id = rp.permission_id
  ),
  after_set as (select user_id, permission_key from other union select hh.user_id, k from holders hh, unnest(v_new) k),
  before_set as (select user_id, permission_key from other union select hh.user_id, k from holders hh, unnest(v_live) k)
  select coalesce(jsonb_agg(jsonb_build_object('ruleKey', x.rule_key, 'enforcement', x.enforcement, 'userId', x.user_id, 'mitigated', x.mitigated)), '[]'::jsonb),
         count(*) filter (where x.enforcement = 'enforce' and not x.mitigated)
    into v_conflicts, v_blocking
  from (
    select r.rule_key, r.enforcement, hh.user_id, public.sa_sod_has_mitigation(r.id, hh.user_id) as mitigated
    from public.sa_sod_rules r cross join holders hh
    where public.sa_sod_rule_active(r) and r.rule_kind = 'permission_conflict'
      and exists (select 1 from after_set s where s.user_id = hh.user_id and s.permission_key = r.left_key)
      and exists (select 1 from after_set s where s.user_id = hh.user_id and s.permission_key = r.right_key)
      and not (exists (select 1 from before_set s where s.user_id = hh.user_id and s.permission_key = r.left_key)
               and exists (select 1 from before_set s where s.user_id = hh.user_id and s.permission_key = r.right_key))
  ) x;

  v_hash := md5(concat_ws('|', p_role::text, v_role.version::text, v_draft.id::text, v_draft.updated_at::text,
                          array_to_string(v_added, ','), array_to_string(v_removed, ','),
                          (select coalesce(string_agg(assignment_id::text, ',' order by assignment_id), '') from public.sa_profile_active_holders(p_role)),
                          v_conflicts::text));
  return jsonb_build_object(
    'roleId', p_role, 'roleKey', v_role.role_key, 'name', v_draft.name, 'version', v_role.version, 'draftId', v_draft.id, 'draftStatus', v_draft.status,
    'submittedBy', v_draft.submitted_by, 'firstPublication', v_role.status = 'draft',
    'added', to_jsonb(v_added), 'removed', to_jsonb(v_removed), 'holderCount', v_holder_count, 'holders', v_holders,
    'conflicts', v_conflicts, 'blockingConflicts', v_blocking, 'requiresReason', v_holder_count > 0,
    'selfPublishBlocked', v_holder_count > 0 and v_draft.submitted_by = p_actor and not public.sa_setting_bool('access_profile.allow_self_publish', false),
    'impactHash', v_hash);
end $$;
revoke all on function public.sa_profile_publish_preview(uuid,uuid) from public, anon, authenticated;
grant execute on function public.sa_profile_publish_preview(uuid,uuid) to service_role;

create or replace function public.sa_publish_profile_draft(p_actor uuid, p_role uuid, p_reason text, p_impact_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_preview jsonb; v_role record; v_draft record; v_holder jsonb;
begin
  perform public.sa_assert_profile_manager(p_actor);
  select * into v_role from public.sa_business_roles where id = p_role for update;
  if not found then raise exception 'sa_profile_not_found'; end if;
  if v_role.source <> 'new' then raise exception 'sa_profile_standard_protected'; end if;
  select * into v_draft from public.sa_access_profile_drafts where role_id = p_role and status in ('draft','in_review') for update;
  if not found then raise exception 'sa_profile_no_draft'; end if;
  if v_draft.status <> 'in_review' then raise exception 'sa_profile_not_in_review'; end if;
  v_preview := public.sa_profile_publish_preview(p_actor, p_role);
  if p_impact_hash is null or p_impact_hash <> v_preview->>'impactHash' then raise exception 'sa_profile_stale_preview'; end if;
  if (v_preview->>'holderCount')::int > 0 and (p_reason is null or length(btrim(p_reason)) < 10) then raise exception 'sa_reason_required'; end if;
  if (v_preview->>'selfPublishBlocked')::boolean then raise exception 'sa_profile_self_review_prohibited' using errcode = '42501'; end if;
  if (v_preview->>'blockingConflicts')::int > 0 then raise exception 'sa_profile_holder_conflict: %', v_preview->>'blockingConflicts' using errcode = '42501'; end if;
  perform public.sa_profile_clean_permissions(v_draft.permission_keys, v_draft.applicable_account_types);

  update public.sa_business_roles set name = v_draft.name, description = v_draft.description,
      applicable_account_types = v_draft.applicable_account_types, applicable_org_types = v_draft.applicable_org_types,
      status = 'active', version = version + 1, updated_at = now(), updated_by = p_actor
  where id = p_role;
  delete from public.sa_business_role_permissions where role_id = p_role;
  insert into public.sa_business_role_permissions(role_id, permission_id, created_by)
    select p_role, id, p_actor from public.sa_permissions where permission_key = any(v_draft.permission_keys) and status = 'active';
  update public.sa_access_profile_drafts set status = 'published', decided_by = p_actor, decided_at = now(), decision_reason = nullif(btrim(coalesce(p_reason, '')), '') where id = v_draft.id;

  perform public.sa_log_access_change(p_actor, 'access_profile.published', null, 'sa_business_role', p_role::text,
    jsonb_build_object('draft_id', v_draft.id, 'version', v_role.version + 1, 'added', v_preview->'added', 'removed', v_preview->'removed',
                       'holder_count', v_preview->'holderCount', 'submitted_by', v_draft.submitted_by), nullif(btrim(coalesce(p_reason, '')), ''));
  -- Each affected holder gets its own record (real actor, reason, what changed).
  for v_holder in select * from jsonb_array_elements(v_preview->'holders') loop
    perform public.sa_log_access_change(p_actor, 'assignment.profile_changed', (v_holder->>'userId')::uuid, 'sa_role_assignment', v_holder->>'assignmentId',
      jsonb_build_object('role_id', p_role, 'version', v_role.version + 1, 'added', v_preview->'added', 'removed', v_preview->'removed',
                         'organization_id', v_holder->>'organizationId'), nullif(btrim(coalesce(p_reason, '')), ''));
  end loop;
  return v_preview || jsonb_build_object('published', true, 'newVersion', v_role.version + 1);
end $$;
revoke all on function public.sa_publish_profile_draft(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.sa_publish_profile_draft(uuid,uuid,text,text) to service_role;

create or replace function public.sa_retire_access_profile(p_actor uuid, p_role uuid, p_reason text)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_role record; v_holders integer;
begin
  perform public.sa_assert_profile_manager(p_actor);
  if p_reason is null or length(btrim(p_reason)) < 10 then raise exception 'sa_reason_required'; end if;
  select * into v_role from public.sa_business_roles where id = p_role for update;
  if not found then raise exception 'sa_profile_not_found'; end if;
  if v_role.source <> 'new' then raise exception 'sa_profile_standard_protected'; end if;
  select count(*) into v_holders from public.sa_profile_active_holders(p_role);
  if v_holders > 0 then raise exception 'sa_profile_has_holders: %', v_holders using hint = 'Revoke or replace the assignments before retiring this profile.'; end if;
  update public.sa_business_roles set status = 'deprecated', updated_at = now(), updated_by = p_actor where id = p_role;
  update public.sa_access_profile_drafts set status = 'discarded', decided_by = p_actor, decided_at = now(), decision_reason = 'Profile retired'
  where role_id = p_role and status in ('draft','in_review');
  perform public.sa_log_access_change(p_actor, 'access_profile.retired', null, 'sa_business_role', p_role::text, jsonb_build_object('role_key', v_role.role_key), btrim(p_reason));
end $$;
revoke all on function public.sa_retire_access_profile(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.sa_retire_access_profile(uuid,uuid,text) to service_role;

-- A profile in use (or a standard/compatibility role) can never be deleted.
create or replace function public.sa_business_role_delete_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if old.source in ('template','legacy') then raise exception 'sa_profile_standard_protected'; end if;
  if exists (select 1 from public.sa_role_assignments a where a.role_id = old.id) then raise exception 'sa_profile_in_use' using hint = 'Retire the profile instead.'; end if;
  return old;
end $$;
revoke all on function public.sa_business_role_delete_guard() from public, anon, authenticated;
drop trigger if exists sa_business_role_delete_guard on public.sa_business_roles;
create trigger sa_business_role_delete_guard before delete on public.sa_business_roles for each row execute function public.sa_business_role_delete_guard();

-- Holders and their scopes, limited to organizations the actor may view.
create or replace function public.sa_profile_holders(p_actor uuid, p_role uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_orgs uuid[]; v_total integer; v_rows jsonb;
begin
  select coalesce(array_agg(a.organization_id), '{}') into v_orgs from public.sa_authorized_organizations(p_actor, 'security.access.view') a;
  if cardinality(v_orgs) = 0 then raise exception 'sa_authorization_required' using errcode = '42501'; end if;
  select count(*) into v_total from public.sa_profile_active_holders(p_role);
  select coalesce(jsonb_agg(jsonb_build_object('assignmentId', h.assignment_id, 'userId', h.user_id, 'name', coalesce(u.full_name, u.email), 'email', u.email,
      'organizationId', h.organization_id, 'organization', o.org_name, 'organizationType', o.org_type_code,
      'scopes', coalesce((select jsonb_agg(sd.display_name order by sd.display_name) from public.sa_assignment_scopes x
                          join public.sa_scope_definitions sd on sd.id = x.scope_id where x.assignment_id = h.assignment_id), '[]'::jsonb))
      order by coalesce(u.full_name, u.email)), '[]'::jsonb) into v_rows
  from public.sa_profile_active_holders(p_role) h join public.users u on u.id = h.user_id left join public.organizations o on o.id = h.organization_id
  where h.organization_id = any(v_orgs);
  return jsonb_build_object('total', v_total, 'visible', jsonb_array_length(v_rows), 'holders', v_rows);
end $$;
revoke all on function public.sa_profile_holders(uuid,uuid) from public, anon, authenticated;
grant execute on function public.sa_profile_holders(uuid,uuid) to service_role;

-- Holder counts per profile: total, and the part inside organizations the actor may view.
create or replace function public.sa_profile_holder_counts(p_actor uuid)
returns table(role_id uuid, holders bigint, visible_holders bigint)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v_orgs uuid[];
begin
  select coalesce(array_agg(a.organization_id), '{}') into v_orgs from public.sa_authorized_organizations(p_actor, 'security.access.view') a;
  if cardinality(v_orgs) = 0 then raise exception 'sa_authorization_required' using errcode = '42501'; end if;
  return query
  select a.role_id, count(*)::bigint, count(*) filter (where m.organization_id = any(v_orgs))::bigint
  from public.sa_role_assignments a join public.sa_organization_memberships m on m.id = a.membership_id
  where a.status = 'active' and (a.effective_until is null or a.effective_until > now())
  group by a.role_id;
end $$;
revoke all on function public.sa_profile_holder_counts(uuid) from public, anon, authenticated;
grant execute on function public.sa_profile_holder_counts(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Existing mutation paths, tightened (same signatures)
-- ---------------------------------------------------------------------------
-- Direct role edits: the actor is now re-checked here, standard/compatibility
-- roles stay uneditable, and a role that people hold can only change through a
-- reviewed draft (sa_publish_profile_draft).
create or replace function public.sa_save_business_role(
  p_actor_id uuid, p_role_id uuid, p_role_key text, p_name text, p_description text, p_permission_keys text[])
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_role_id uuid; v_expected integer; v_found integer;
begin
  perform public.sa_assert_profile_manager(p_actor_id);
  if p_actor_id is null or p_name is null or btrim(p_name) = '' or p_role_key !~ '^[a-z][a-z0-9_-]*$' then raise exception 'invalid_role'; end if;
  select count(*) into v_expected from (select distinct unnest(coalesce(p_permission_keys, array[]::text[]))) q;
  select count(*) into v_found from public.sa_permissions where status = 'active' and permission_key = any(coalesce(p_permission_keys, array[]::text[]));
  if v_expected <> v_found then raise exception 'invalid_permission'; end if;
  if p_role_id is null then
    insert into public.sa_business_roles(role_key, name, description, source, created_by, updated_by)
    values (p_role_key, btrim(p_name), nullif(btrim(p_description), ''), 'new', p_actor_id, p_actor_id) returning id into v_role_id;
  else
    if exists (select 1 from public.sa_profile_active_holders(p_role_id)) then raise exception 'sa_profile_requires_draft' using hint = 'Change an assigned profile through a draft, review and publication.'; end if;
    update public.sa_business_roles set role_key = p_role_key, name = btrim(p_name), description = nullif(btrim(p_description), ''),
      updated_at = now(), updated_by = p_actor_id, version = version + 1
    where id = p_role_id and source = 'new' returning id into v_role_id;
    if v_role_id is null then raise exception 'role_not_editable'; end if;
  end if;
  delete from public.sa_business_role_permissions where role_id = v_role_id;
  insert into public.sa_business_role_permissions(role_id, permission_id, created_by)
    select v_role_id, id, p_actor_id from public.sa_permissions where permission_key = any(coalesce(p_permission_keys, array[]::text[]));
  return v_role_id;
end $$;
revoke all on function public.sa_save_business_role(uuid,uuid,text,text,text,text[]) from public, anon, authenticated;
grant execute on function public.sa_save_business_role(uuid,uuid,text,text,text,text[]) to service_role;

-- Manual grants additionally require the profile to apply to the target organization.
create or replace function public.sa_assign_role(
  p_actor uuid, p_user uuid, p_role uuid, p_org uuid, p_scope_ids uuid[],
  p_from timestamptz, p_until timestamptz, p_reason text)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if p_actor = p_user then raise exception 'sa_self_assignment_prohibited' using errcode = '42501'; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then raise exception 'sa_reason_required'; end if;
  perform public.sa_assert_actor_permission(p_actor, 'security.role.assign',
    jsonb_build_object('organization_id', p_org), public.sa_legacy_is_super_admin(p_actor));
  if not public.sa_profile_applicable(p_role, p_org) then raise exception 'sa_profile_not_applicable'; end if;
  return public.sa_create_assignment_internal(p_actor, p_user, p_role, p_org, p_scope_ids, p_from, p_until, btrim(p_reason), 'manual');
end $$;
revoke all on function public.sa_assign_role(uuid,uuid,uuid,uuid,uuid[],timestamptz,timestamptz,text) from public, anon, authenticated;
grant execute on function public.sa_assign_role(uuid,uuid,uuid,uuid,uuid[],timestamptz,timestamptz,text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Multi-profile initial access (used by identity_provision)
-- ---------------------------------------------------------------------------
create or replace function public.sa_assign_initial_profiles(p_actor uuid, p_user uuid, p_org uuid, p_items jsonb, p_default_org_scope boolean)
returns uuid[] language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_item jsonb; v_role uuid; v_scopes uuid[]; v_seen uuid[] := '{}'; v_ids uuid[] := '{}';
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 10 then raise exception 'sa_initial_access_invalid'; end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_role := nullif(v_item->>'role_id', '')::uuid;
    if v_role is null then raise exception 'sa_initial_access_invalid'; end if;
    if v_role = any(v_seen) then raise exception 'sa_initial_access_duplicate'; end if;
    v_seen := v_seen || v_role;
    select coalesce(array_agg(x::uuid), '{}') into v_scopes from jsonb_array_elements_text(coalesce(v_item->'scope_ids', '[]'::jsonb)) x;
    if cardinality(v_scopes) = 0 and p_default_org_scope then
      select array[d.id] into v_scopes from public.sa_scope_definitions d
      where d.organization_id = p_org and d.scope_value = p_org::text and d.status = 'active' and d.scope_type in ('organization','warehouse') limit 1;
    end if;
    -- Each profile carries its OWN explicit scope; nothing is defaulted to a broad one.
    if coalesce(cardinality(v_scopes), 0) = 0 then raise exception 'sa_scope_required'; end if;
    if public.sa_profile_sensitive(v_role) then raise exception 'sa_profile_sensitive_not_initial' using hint = 'Assign administrative or reset profiles afterwards in People & Access.'; end if;
    v_ids := v_ids || public.sa_assign_role(p_actor, p_user, v_role, p_org, v_scopes, now(), null,
      coalesce(nullif(btrim(v_item->>'reason'), ''), 'Initial access at provisioning'));
  end loop;
  return v_ids;
end $$;
revoke all on function public.sa_assign_initial_profiles(uuid,uuid,uuid,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.sa_assign_initial_profiles(uuid,uuid,uuid,jsonb,boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Provisioning: initial_access = [{role_id, scope_ids[], reason}] (or the
--    previous single initial_role_id). Everything else in the function is
--    unchanged from 20260929140000_identity_stage1_closure.sql.
-- ---------------------------------------------------------------------------
create or replace function public.identity_provision(p_actor uuid, p_user uuid, p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_email text := public.identity_normalize_email(p_payload->>'email');
  v_phone text := public.identity_normalize_phone(nullif(p_payload->>'phone', ''));
  v_org uuid := nullif(p_payload->>'organization_id', '')::uuid;
  v_scope text := coalesce(nullif(p_payload->>'account_scope', ''), case when v_org is null then 'store' else 'portal' end);
  v_perm text := coalesce(nullif(p_payload->>'authorizing_permission', ''), 'platform.user.manage');
  v_created boolean := coalesce((p_payload->>'created_identity')::boolean, false);
  v_source text := coalesce(nullif(p_payload->>'source', ''), 'api');
  v_org_type text;
  v_principal text;
  v_role_code text;
  v_baseline text;
  v_res jsonb;
  v_existing record;
  v_outcome text;
  v_membership uuid;
  v_assignment uuid;
  v_scope_ids uuid[];
  v_items jsonb;
  v_assignments uuid[] := '{}';
  v_legacy boolean;
begin
  if p_actor is null or p_user is null then raise exception 'identity_actor_and_user_required' using errcode = '22023'; end if;
  if p_actor = p_user then raise exception 'identity_self_provisioning_prohibited' using errcode = '42501'; end if;
  if v_email is null then raise exception 'identity_email_invalid' using errcode = '22023'; end if;
  if nullif(p_payload->>'phone', '') is not null and v_phone is null then raise exception 'identity_phone_invalid' using errcode = '22023'; end if;
  if v_scope not in ('portal','store') then raise exception 'identity_account_scope_invalid' using errcode = '22023'; end if;
  if v_scope = 'portal' and v_org is null then raise exception 'identity_organization_required' using errcode = '22023'; end if;
  if v_perm not in ('platform.user.manage','hr.employee.manage') then raise exception 'identity_authorizing_permission_invalid' using errcode = '22023'; end if;
  if v_perm = 'hr.employee.manage' and v_scope <> 'portal' then raise exception 'identity_hr_requires_enterprise' using errcode = '22023'; end if;

  if v_org is not null then
    select o.org_type_code into v_org_type from public.organizations o where o.id = v_org and o.is_active is not false;
    if not found then raise exception 'identity_organization_unknown' using errcode = '22023'; end if;
  end if;
  v_principal := public.identity_derive_principal_type(v_scope, v_org_type);
  if nullif(p_payload->>'expected_principal_type', '') is not null and p_payload->>'expected_principal_type' <> v_principal then
    raise exception 'identity_principal_type_mismatch' using errcode = '22023',
      detail = format('requested %s, organization implies %s', p_payload->>'expected_principal_type', v_principal);
  end if;

  -- Authorization (identity management; organization of the new identity, or
  -- the actor's own organization for a consumer without one).
  v_legacy := case when v_perm = 'hr.employee.manage' then public.identity_legacy_hr_admin(p_actor)
                   else public.identity_legacy_user_admin(p_actor) end;
  perform public.sa_assert_actor_permission(p_actor, v_perm,
    jsonb_build_object('organization_id', coalesce(v_org, (select u.organization_id from public.users u where u.id = p_actor))),
    v_legacy);

  -- Legacy role code: baseline unless explicitly requested; anything above the
  -- baseline is access administration, never implied by identity management.
  -- HR / department onboarding grants no authority by default: the legacy
  -- compatibility code is the no-authority GUEST (never USER, which carries
  -- staff-level compatibility grants); the employee baseline comes from the
  -- lifecycle (employee-self-service). Anything else is access administration.
  v_baseline := case when v_perm = 'hr.employee.manage' and v_principal <> 'CONSUMER' then 'GUEST'
                     else public.identity_baseline_role_code(v_principal) end;
  v_role_code := coalesce(nullif(p_payload->>'legacy_role_code', ''), v_baseline);
  if v_role_code <> v_baseline then
    if not public.identity_legacy_role_grant_allowed(p_actor, v_role_code) then
      raise exception 'identity_role_grant_not_allowed' using errcode = '42501',
        detail = format('role %s is unknown, inactive or above the actor''s own level', v_role_code);
    end if;
    perform public.sa_assert_actor_permission(p_actor, 'platform.identity_access.manage',
      jsonb_build_object('organization_id', coalesce(v_org, (select u.organization_id from public.users u where u.id = p_actor))),
      public.identity_legacy_access_admin(p_actor));
  end if;

  -- Serialize concurrent provisioning of the same identifiers.
  perform pg_advisory_xact_lock(hashtextextended('identity:' || v_email, 0));
  if v_phone is not null then perform pg_advisory_xact_lock(hashtextextended('identity:' || v_phone, 0)); end if;

  v_res := public.identity_resolve(v_email, v_phone);
  if v_res->>'outcome' <> 'MATCH' or (v_res->>'user_id')::uuid is distinct from p_user then
    perform public.identity_record_conflict(
      case when v_res->>'outcome' in ('IDENTITY_CONFLICT','IDENTITY_AMBIGUOUS_EMAIL','IDENTITY_AMBIGUOUS_PHONE',
                                       'IDENTITY_VERIFICATION_REQUIRED','IDENTITY_ARCHIVED')
           then v_res->>'outcome' else 'IDENTITY_CONFLICT' end,
      v_res, v_email, v_phone, v_source, p_actor, jsonb_build_object('stage', 'provision', 'expected_user_id', p_user));
    -- Returned (not raised) so the conflict record commits; the server
    -- compensates (deletes an auth user it created) on any non-success.
    return jsonb_build_object('status', 'blocked', 'code', coalesce(nullif(v_res->>'outcome', 'MATCH'), 'IDENTITY_CONFLICT'),
                              'user_id', null, 'matched_user_ids', v_res->'matched_user_ids');
  end if;

  select u.id, u.account_scope, u.organization_id, u.account_status, u.principal_type
    into v_existing from public.users u where u.id = p_user;

  if not found then
    insert into public.users (id, email, full_name, call_name, phone, role_code, organization_id, account_scope,
                              account_status, is_verified, email_verified_at, phone_verified_at, employment_status,
                              department_id, manager_user_id, position_id, employment_type, join_date)
    values (p_user, v_email, nullif(p_payload->>'full_name', ''), nullif(p_payload->>'call_name', ''), v_phone,
            v_role_code, v_org, v_scope, 'ACTIVE', true, now(),
            case when v_phone is not null and coalesce((p_payload->>'phone_verified')::boolean, false) then now() end,
            'active',
            nullif(p_payload->>'department_id', '')::uuid, nullif(p_payload->>'manager_user_id', '')::uuid,
            nullif(p_payload->>'position_id', '')::uuid, nullif(p_payload->>'employment_type', ''),
            nullif(p_payload->>'join_date', '')::date);
    v_outcome := 'CREATED';
  else
    -- Reuse: identifiers and access of an existing identity are never changed
    -- here (no silent merge, no silent move/upgrade).
    if v_existing.account_status = 'ARCHIVED' then
      perform public.identity_record_conflict('IDENTITY_ARCHIVED', v_res, v_email, v_phone, v_source, p_actor, '{}'::jsonb);
      return jsonb_build_object('status', 'blocked', 'code', 'IDENTITY_ARCHIVED', 'user_id', p_user);
    end if;
    if v_existing.account_status not in ('ACTIVE','INVITED') then
      perform public.identity_record_conflict('IDENTITY_INACTIVE', v_res, v_email, v_phone, v_source, p_actor, '{}'::jsonb);
      return jsonb_build_object('status', 'blocked', 'code', 'IDENTITY_INACTIVE', 'user_id', p_user);
    end if;
    if v_existing.principal_type = 'CONSUMER' and v_principal <> 'CONSUMER' then
      perform public.identity_record_conflict('IDENTITY_PRINCIPAL_UPGRADE_REQUIRED', v_res, v_email, v_phone, v_source, p_actor, '{}'::jsonb);
      return jsonb_build_object('status', 'blocked', 'code', 'IDENTITY_PRINCIPAL_UPGRADE_REQUIRED', 'user_id', p_user);
    end if;
    if v_existing.organization_id is distinct from v_org or v_existing.account_scope <> v_scope then
      perform public.identity_record_conflict('IDENTITY_ORG_MOVE_REQUIRED', v_res, v_email, v_phone, v_source, p_actor, '{}'::jsonb);
      return jsonb_build_object('status', 'blocked', 'code', 'IDENTITY_ORG_MOVE_REQUIRED', 'user_id', p_user);
    end if;
    -- Same identity, same organization: HR facts may be completed, nothing else.
    if v_perm = 'hr.employee.manage' then
      update public.users u set
        department_id = coalesce(nullif(p_payload->>'department_id', '')::uuid, u.department_id),
        manager_user_id = coalesce(nullif(p_payload->>'manager_user_id', '')::uuid, u.manager_user_id),
        position_id = coalesce(nullif(p_payload->>'position_id', '')::uuid, u.position_id),
        employment_type = coalesce(nullif(p_payload->>'employment_type', ''), u.employment_type),
        join_date = coalesce(nullif(p_payload->>'join_date', '')::date, u.join_date)
      where u.id = p_user;
    end if;
    v_outcome := 'REUSED';
  end if;

  -- Organization-owned HR references must belong to the identity's organization.
  if exists (select 1 from public.users u
             where u.id = p_user and (
               (u.department_id is not null and not exists (select 1 from public.departments d where d.id = u.department_id and d.organization_id = u.organization_id))
               or (u.manager_user_id is not null and not exists (select 1 from public.users m where m.id = u.manager_user_id and m.organization_id = u.organization_id))
               or (u.position_id is not null and not exists (select 1 from public.hr_positions p where p.id = u.position_id and p.organization_id = u.organization_id)))) then
    raise exception 'identity_hr_reference_outside_organization' using errcode = '22023';
  end if;

  -- Membership + baseline come from the lifecycle trigger (enterprise only).
  select m.id into v_membership from public.sa_organization_memberships m
  where m.user_id = p_user and m.organization_id = v_org and m.status = 'active' limit 1;
  if v_principal <> 'CONSUMER' and v_membership is null then
    raise exception 'identity_membership_not_established' using errcode = 'P0001';
  end if;
  if v_principal = 'CONSUMER' and exists (select 1 from public.sa_organization_memberships m where m.user_id = p_user and m.status = 'active') then
    raise exception 'identity_consumer_must_not_hold_enterprise_membership' using errcode = 'P0001';
  end if;

  -- Initial Access Profiles (one or many). All-or-nothing: any failing profile
  -- (authority, applicability, scope, SoD, self-assignment) aborts the whole
  -- provisioning transaction, so no partial access is ever left behind.
  v_items := coalesce(p_payload->'initial_access', '[]'::jsonb);
  if jsonb_typeof(v_items) <> 'array' then raise exception 'sa_initial_access_invalid' using errcode = '22023'; end if;
  if jsonb_array_length(v_items) > 0 or nullif(p_payload->>'initial_role_id', '') is not null then
    if v_principal = 'CONSUMER' then raise exception 'identity_consumer_cannot_receive_business_role' using errcode = '42501'; end if;
    if jsonb_array_length(v_items) > 0 then
      v_assignments := public.sa_assign_initial_profiles(p_actor, p_user, v_org, v_items, false);
    else
      -- Compatibility: the single initial role of the previous flow (defaults to the organization scope).
      v_assignments := public.sa_assign_initial_profiles(p_actor, p_user, v_org, jsonb_build_array(jsonb_build_object(
        'role_id', p_payload->>'initial_role_id', 'scope_ids', coalesce(p_payload->'initial_scope_ids', '[]'::jsonb),
        'reason', coalesce(nullif(p_payload->>'initial_reason', ''), 'Initial access at provisioning'))), true);
    end if;
    v_assignment := v_assignments[1];
  end if;

  perform public.sa_log_access_change(p_actor, 'identity.provisioned', p_user, 'user', p_user::text,
    jsonb_build_object('outcome', v_outcome, 'source', v_source, 'principal_type', v_principal,
                       'organization_id', v_org, 'legacy_role_code', case when v_outcome = 'CREATED' then v_role_code end,
                       'created_identity', v_created, 'authorizing_permission', v_perm,
                       'initial_assignment_id', v_assignment, 'initial_assignment_ids', to_jsonb(v_assignments)),
    nullif(p_payload->>'reason', ''), 'user');

  return jsonb_build_object('status', 'ok', 'outcome', v_outcome, 'user_id', p_user, 'principal_type', v_principal,
                            'membership_id', v_membership, 'initial_assignment_id', v_assignment, 'initial_assignment_ids', to_jsonb(v_assignments),
                            'legacy_role_code', (select u.role_code from public.users u where u.id = p_user));
end $$;
revoke all on function public.identity_provision(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.identity_provision(uuid,uuid,jsonb) to service_role;
