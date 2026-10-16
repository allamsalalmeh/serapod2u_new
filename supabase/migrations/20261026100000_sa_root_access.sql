-- ============================================================================
-- Security & Access — Root Access (Full System Administrator)
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database,
-- so nothing in this file has been run against a real database (throwaway PostgreSQL 17 with the REAL S&A
-- migrations: supabase/tests/security/sa_root_access/run.sh).
--
-- What Root Access is
--   An explicitly assigned, independently revocable, system-level privilege held by a person (not a Group Policy,
--   not a role, not a permission key). While a person holds an ACTIVE, UNEXPIRED Root Access grant and their account
--   is active, the canonical evaluator (sa_evaluate_permission → sa_evaluate_permission_core) ALLOWs every permission
--   that exists in the catalogue with status 'active', for every organization (HQ, branches, warehouses,
--   distributors, manufacturers, shops), with reason ALLOWED_BY_ROOT_ACCESS. Permissions added to sa_permissions
--   later are covered automatically; no Root Access row ever lists permissions.
--
-- Where it takes effect (mode-aware, unchanged contract)
--   * The evaluator is authoritative only for permissions in NEW_ENFORCED / LEGACY_RETIRED. In LEGACY_ENFORCED /
--     SHADOW the legacy rule keeps deciding exactly as before; the Root decision is only recorded as the shadow
--     comparison. Root Access therefore never widens a legacy-mode decision (no privilege escalation through modes)
--     and starts applying automatically when a permission moves to New Access Active.
--   * Every enforcement path that already goes through the evaluator honours it with no further change: API routes
--     (authorize/requireAuthorization), navigation (explainMany), RLS gates (sa_rls_gate / sa_rls_gate_owned /
--     sa_cached_actor_allows), RPC backstops (sa_require_operation), governance assertions
--     (sa_assert_actor_permission) and the grant-authority ceiling (sa_actor_holds_permission).
--   * Side paths that read assignments directly are taught Root Access here: sa_readable_organizations (list
--     scope), sa_authorized_organizations (S&A directory scope), sa_actor_holds_permission without an organization
--     (custom-policy ceiling), sa_assignment_scope_guard (organization-independent scopes), sa_actor_dominates
--     (target protection).
--   * NOT bypassed: extra verification built into specific operations — confirmation phrases, OTP, preview tokens,
--     go-live state, approval amount policies, MFA step-up for emergency access, SoD checks at grant time, and the
--     HR data reset rule that additionally requires a legacy Super Admin (hr_reset_authorize). Legacy-only checks in
--     application code that never call the evaluator do not see Root Access (reported, not bypassed).
--
-- Who can grant / revoke
--   * Only an active Root Administrator (sa_actor_is_root). Legacy level 1 / Super Admin, compatibility profiles,
--     Security & Access Full Access, delegation and emergency access are NOT authority to grant Root Access.
--   * No self-grant; no self-revoke; the last active Root Administrator cannot be revoked.
--   * Target: active account with an active membership in an HQ organization (internal staff only).
--   * Reason 10–500 characters; optional expiry at least 15 minutes ahead.
--   * All Root Access changes are serialized by one advisory lock, so two administrators can never revoke each
--     other concurrently and leave nobody.
--   * Refused attempts are written to the access change log ('root_access.grant_denied' / 'root_access.revoke_denied')
--     — the functions return {ok:false, code} instead of raising, so the audit row is kept.
--
-- Bootstrap (first Root Administrator)
--   sa_bootstrap_root_access(target, reason): database owner only (no API role, including service_role, can execute
--   it; it also refuses any PostgREST request). Works only while there is NO active Root Administrator, so it is
--   also the recovery path if the last Root Administrator's account is deactivated or their grant expires.
--   Example (run by hand in the SQL editor as the database owner, after review):
--     select public.sa_bootstrap_root_access('<user uuid>', 'Initial Root Administrator approved by <who>, ticket <ref>');
--   Existing level 1 / legacy Super Admin accounts are NOT converted.
--
-- Data model: public.sa_root_access_grants is history. No API role can write it (service_role may read it for the
--   People & Access screen); rows are never deleted, identity columns are immutable and status only moves
--   active → revoked | expired. sa_governance_maintenance marks elapsed grants 'expired' and logs
--   'root_access.expired' (the evaluator already ignores them at the moment they elapse).
--
-- Depends on (must already be applied): 20260928100000 (tables/evaluator), 20260930100000 (sa_readable_organizations,
--   sa_actor_dominates), 20261005100000 (directory), 20261009100000 (sa_authorized_organizations,
--   sa_assignment_scope_guard, sa_actor_holds_permission), 20261024100000 (sa_evaluate_permission_core,
--   sa_governance_maintenance with emergency expiry). Run as the database owner (supabase_admin).
-- Idempotent: yes. Autocommit-safe: no session temp tables or settings.
--
-- Rollback (revoke every active Root Access grant first, through sa_revoke_root_access or by the owner):
--   re-run the definitions of sa_evaluate_permission_core, sa_actor_holds_permission and sa_governance_maintenance
--   from 20261024100000; sa_readable_organizations and sa_actor_dominates from 20260930100000;
--   sa_authorized_organizations and sa_assignment_scope_guard from 20261009100000; then
--   drop function public.sa_grant_root_access(uuid,uuid,text,timestamptz,uuid), public.sa_revoke_root_access(uuid,uuid,text),
--     public.sa_bootstrap_root_access(uuid,text), public.sa_actor_is_root(uuid), public.sa_active_root_count(uuid),
--     public.sa_root_target_refusal(uuid), public.sa_root_log(uuid,text,uuid,text,jsonb,text,text);
--   (the table may stay as history; drop it only after exporting it).
-- ============================================================================

do $pre$
begin
  if to_regprocedure('public.sa_evaluate_permission_core(uuid,text,jsonb,boolean,boolean)') is null then
    raise exception 'sa_prerequisite_missing: apply 20261024100000_sa_emergency_access_grant_flow.sql first';
  end if;
  if to_regprocedure('public.sa_actor_holds_permission(uuid,text,uuid)') is null
     or to_regprocedure('public.sa_authorized_organizations(uuid,text)') is null
     or to_regprocedure('public.sa_assignment_scope_guard()') is null then
    raise exception 'sa_prerequisite_missing: apply 20261009100000_sa_group_policies_full_access.sql first';
  end if;
  if to_regprocedure('public.sa_readable_organizations(uuid,text,boolean)') is null
     or to_regprocedure('public.sa_actor_dominates(uuid,uuid)') is null then
    raise exception 'sa_prerequisite_missing: sa_readable_organizations / sa_actor_dominates (20260930100000)';
  end if;
  if to_regprocedure('public.sa_log_access_change(uuid,text,uuid,text,text,jsonb,text,text)') is null then
    raise exception 'sa_prerequisite_missing: sa_log_access_change (20260928100000)';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Grant table (history)
-- ---------------------------------------------------------------------------
create table if not exists public.sa_root_access_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null constraint sa_root_access_grants_user_id_fkey references public.users(id),
  status text not null default 'active' check (status in ('active', 'revoked', 'expired')),
  grant_method text not null check (grant_method in ('grant', 'bootstrap')),
  reason text not null check (char_length(btrim(reason)) between 10 and 500),
  granted_by uuid constraint sa_root_access_grants_granted_by_fkey references public.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  effective_until timestamptz,
  request_key uuid,
  revoked_at timestamptz,
  revoked_by uuid constraint sa_root_access_grants_revoked_by_fkey references public.users(id) on delete set null,
  revoke_reason text check (revoke_reason is null or char_length(btrim(revoke_reason)) between 10 and 500),
  expired_at timestamptz,
  constraint sa_root_access_until_after_grant check (effective_until is null or effective_until > granted_at),
  constraint sa_root_access_revocation_complete check (status <> 'revoked' or (revoked_at is not null and revoke_reason is not null)),
  constraint sa_root_access_expiry_complete check (status <> 'expired' or expired_at is not null)
);
comment on table public.sa_root_access_grants is
  'Root Access (Full System Administrator) grants. A row is active only while status = active, effective_until is null or in the future and the account is active. Written only by sa_grant_root_access / sa_revoke_root_access / sa_bootstrap_root_access / sa_governance_maintenance. History: never deleted.';
comment on column public.sa_root_access_grants.granted_by is 'Root Administrator who granted it; null for the database-owner bootstrap.';

create unique index if not exists sa_root_access_one_active_uq on public.sa_root_access_grants(user_id) where status = 'active';
create unique index if not exists sa_root_access_request_key_uq on public.sa_root_access_grants(request_key) where request_key is not null;
create index if not exists sa_root_access_status_until_idx on public.sa_root_access_grants(status, effective_until);
create index if not exists sa_root_access_user_time_idx on public.sa_root_access_grants(user_id, granted_at desc);

alter table public.sa_root_access_grants enable row level security;
revoke all on table public.sa_root_access_grants from public, anon, authenticated, service_role;
-- The server reads status for People & Access; it can never write (governance functions only).
grant select on table public.sa_root_access_grants to service_role;

create or replace function public.sa_root_grant_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'sa_root_access_history_immutable' using errcode = '42501';
  end if;
  if (new.id, new.user_id, new.grant_method, new.reason, new.granted_by, new.granted_at, new.effective_until, new.request_key)
     is distinct from
     (old.id, old.user_id, old.grant_method, old.reason, old.granted_by, old.granted_at, old.effective_until, old.request_key) then
    raise exception 'sa_root_access_history_immutable' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (old.status = 'active' and new.status in ('revoked', 'expired')) then
    raise exception 'sa_root_access_status_transition_invalid' using errcode = '42501';
  end if;
  if new.status = old.status and (new.revoked_at, new.revoked_by, new.revoke_reason, new.expired_at)
     is distinct from (old.revoked_at, old.revoked_by, old.revoke_reason, old.expired_at) then
    raise exception 'sa_root_access_history_immutable' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.sa_root_grant_guard() from public, anon, authenticated, service_role;
drop trigger if exists sa_root_grant_guard on public.sa_root_access_grants;
create trigger sa_root_grant_guard before update or delete on public.sa_root_access_grants
  for each row execute function public.sa_root_grant_guard();
drop trigger if exists sa_root_grant_truncate_guard on public.sa_root_access_grants;
create trigger sa_root_grant_truncate_guard before truncate on public.sa_root_access_grants
  for each statement execute function public.sa_root_grant_guard();

-- ---------------------------------------------------------------------------
-- 2. Status helpers
-- ---------------------------------------------------------------------------
-- Active Root Administrator: active account + active, unexpired grant. Checked at every decision, so expiry,
-- revocation and account deactivation end Root Access immediately, whatever the caller cached.
create or replace function public.sa_actor_is_root(p_actor uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select p_actor is not null and exists (
    select 1 from public.sa_root_access_grants g
    join public.users u on u.id = g.user_id and u.is_active is true
    where g.user_id = p_actor and g.status = 'active'
      and (g.effective_until is null or g.effective_until > now()))
$$;
revoke all on function public.sa_actor_is_root(uuid) from public, anon, authenticated;
grant execute on function public.sa_actor_is_root(uuid) to service_role;
comment on function public.sa_actor_is_root(uuid) is
  'True while the person holds active, unexpired Root Access and their account is active. Legacy level 1 is never Root Access.';

-- Active Root Administrators, optionally excluding one person.
create or replace function public.sa_active_root_count(p_excluding uuid default null)
returns integer language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select count(distinct g.user_id)::integer from public.sa_root_access_grants g
  join public.users u on u.id = g.user_id and u.is_active is true
  where g.status = 'active' and (g.effective_until is null or g.effective_until > now())
    and (p_excluding is null or g.user_id <> p_excluding)
$$;
revoke all on function public.sa_active_root_count(uuid) from public, anon, authenticated;
grant execute on function public.sa_active_root_count(uuid) to service_role;

-- Why a person cannot receive Root Access (null = eligible): active account and an active HQ membership.
create or replace function public.sa_root_target_refusal(p_target uuid)
returns text language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select case
    when p_target is null or not exists (select 1 from public.users u where u.id = p_target) then 'root_target_not_found'
    when not exists (select 1 from public.users u where u.id = p_target and u.is_active is true) then 'root_target_inactive'
    when not exists (
      select 1 from public.sa_organization_memberships m
      join public.organizations o on o.id = m.organization_id and upper(o.org_type_code) = 'HQ'
      where m.user_id = p_target and m.status = 'active'
        and (m.effective_from is null or m.effective_from <= now())
        and (m.effective_until is null or m.effective_until > now())) then 'root_target_not_internal'
  end
$$;
revoke all on function public.sa_root_target_refusal(uuid) from public, anon, authenticated;
grant execute on function public.sa_root_target_refusal(uuid) to service_role;

-- Access change log entry whose actor/target may not exist (a forged id must not make the audit write fail).
create or replace function public.sa_root_log(
  p_actor uuid, p_action text, p_target uuid, p_entity_id text, p_details jsonb, p_reason text, p_actor_kind text default 'user')
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_actor uuid := case when exists (select 1 from public.users u where u.id = p_actor) then p_actor end;
  v_target uuid := case when exists (select 1 from public.users u where u.id = p_target) then p_target end;
  v_details jsonb := coalesce(p_details, '{}'::jsonb) || jsonb_build_object('scope', 'global');
begin
  if p_actor is not null and v_actor is null then v_details := v_details || jsonb_build_object('claimed_actor_id', p_actor); end if;
  if p_target is not null and v_target is null then v_details := v_details || jsonb_build_object('claimed_target_id', p_target); end if;
  perform public.sa_log_access_change(v_actor, p_action, v_target, 'sa_root_access_grant', p_entity_id, v_details,
    left(nullif(btrim(coalesce(p_reason, '')), ''), 500), coalesce(p_actor_kind, 'user'));
end $$;
revoke all on function public.sa_root_log(uuid,text,uuid,text,jsonb,text,text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Canonical evaluator: Root Access branch
-- ---------------------------------------------------------------------------
-- Body identical to 20261024100000 except the Root Access branch right after the active-account gate. Root Access
-- covers only permissions present and active in the catalogue (an unknown or retired key falls through to the
-- ordinary rules, which deny), and only real organizations (a forged organization id falls through and is denied as
-- before). It applies in every evaluation flavour (with or without delegation/emergency) because it is an explicit,
-- audited assignment, not borrowed or break-glass access: it counts as grant authority and target dominance.
create or replace function public.sa_evaluate_permission_core(
  p_actor uuid, p_permission text, p_context jsonb, p_include_delegation boolean, p_include_emergency boolean)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_now timestamptz := now();
  v_ctx jsonb := coalesce(p_context, '{}'::jsonb);
  v_org uuid;
  v_ancestry uuid[] := array[]::uuid[];
  v_active boolean;
  v_membership_ids uuid[];
  v_has_assignment boolean;
  v_matched jsonb := '[]'::jsonb;
  v_permitted jsonb := '[]'::jsonb;
  v_scopes jsonb := '[]'::jsonb;
  v_missing_context boolean := false;
  v_assignment_matched boolean;
  v_match boolean;
  v_root record;
  r record;
  s record;
  d record;
  e record;
begin
  if p_actor is null or p_permission is null then
    return jsonb_build_object('decision','DENY','reason_code','MISSING_CONTEXT','matched_assignments','[]'::jsonb,'resolved_scopes','[]'::jsonb);
  end if;
  select u.is_active into v_active from public.users u where u.id = p_actor;
  if v_active is not true then
    return jsonb_build_object('decision','DENY','reason_code','ACCOUNT_INACTIVE','matched_assignments','[]'::jsonb,'resolved_scopes','[]'::jsonb);
  end if;

  v_org := nullif(v_ctx->>'organization_id', '')::uuid;

  -- Root Access: every active catalogue permission, every real organization, every scope.
  select g.id, g.effective_until into v_root
  from public.sa_root_access_grants g
  where g.user_id = p_actor and g.status = 'active' and (g.effective_until is null or g.effective_until > v_now)
  limit 1;
  if found
     and exists (select 1 from public.sa_permissions p where p.permission_key = p_permission and p.status = 'active')
     and (v_org is null or exists (select 1 from public.organizations o where o.id = v_org)) then
    return jsonb_build_object('decision','ALLOW','reason_code','ALLOWED_BY_ROOT_ACCESS',
      'matched_assignments', jsonb_build_array(jsonb_build_object('rootAccessGrantId', v_root.id, 'effectiveUntil', v_root.effective_until)),
      'resolved_scopes', jsonb_build_array(jsonb_build_object('rootAccessGrantId', v_root.id, 'scopeType', 'global', 'scopeValue', '*', 'matched', true)));
  end if;

  if v_org is not null then v_ancestry := public.sa_org_ancestry(v_org); end if;

  select coalesce(array_agg(m.id), array[]::uuid[]) into v_membership_ids
  from public.sa_organization_memberships m
  where m.user_id = p_actor and m.status = 'active'
    and (m.effective_from is null or m.effective_from <= v_now)
    and (m.effective_until is null or m.effective_until > v_now)
    and (v_org is null or m.organization_id = any(v_ancestry));
  if coalesce(array_length(v_membership_ids, 1), 0) = 0 then
    return jsonb_build_object('decision','DENY','reason_code','MISSING_MEMBERSHIP','matched_assignments','[]'::jsonb,'resolved_scopes','[]'::jsonb);
  end if;

  select exists (
    select 1 from public.sa_role_assignments a
    where a.user_id = p_actor and a.membership_id = any(v_membership_ids) and a.status = 'active'
      and (a.effective_from is null or a.effective_from <= v_now)
      and (a.effective_until is null or a.effective_until > v_now)
  ) into v_has_assignment;

  for r in
    select a.id as assignment_id, a.membership_id, br.id as role_id, br.role_key, br.name as role_name
    from public.sa_role_assignments a
    join public.sa_business_roles br on br.id = a.role_id and br.status = 'active'
    join public.sa_business_role_permissions rp on rp.role_id = br.id
    join public.sa_permissions p on p.id = rp.permission_id and p.status = 'active' and p.permission_key = p_permission
    where a.user_id = p_actor and a.membership_id = any(v_membership_ids) and a.status = 'active'
      and (a.effective_from is null or a.effective_from <= v_now)
      and (a.effective_until is null or a.effective_until > v_now)
  loop
    v_permitted := v_permitted || jsonb_build_array(jsonb_build_object(
      'assignmentId', r.assignment_id, 'roleId', r.role_id, 'roleKey', r.role_key,
      'roleName', r.role_name, 'membershipId', r.membership_id));
    v_assignment_matched := false;
    for s in
      select sd.scope_type, sd.scope_value from public.sa_assignment_scopes x
      join public.sa_scope_definitions sd on sd.id = x.scope_id and sd.status = 'active'
      where x.assignment_id = r.assignment_id
    loop
      v_match := public.sa_scope_matches(p_actor, s.scope_type, s.scope_value, v_ctx, v_ancestry);
      if v_match is null then v_missing_context := true; end if;
      v_scopes := v_scopes || jsonb_build_array(jsonb_build_object(
        'assignmentId', r.assignment_id, 'scopeType', s.scope_type, 'scopeValue', s.scope_value, 'matched', coalesce(v_match, false)));
      if v_match is true then v_assignment_matched := true; end if;
    end loop;
    -- An assignment without scopes grants nothing (no implicit global access).
    if v_assignment_matched then
      v_matched := v_matched || jsonb_build_array(jsonb_build_object(
        'assignmentId', r.assignment_id, 'roleId', r.role_id, 'roleKey', r.role_key,
        'roleName', r.role_name, 'membershipId', r.membership_id));
    end if;
  end loop;

  if jsonb_array_length(v_matched) > 0 then
    return jsonb_build_object('decision','ALLOW','reason_code','ALLOWED_BY_ASSIGNMENT','matched_assignments',v_matched,'resolved_scopes',v_scopes);
  end if;

  -- Emergency access: an active, unexpired grant for exactly this permission, inside its one scope. Checked at
  -- every decision, so expiry and revocation take effect immediately, whatever the caller cached.
  if p_include_emergency then
    for e in
      select g.id, g.effective_until, sd.scope_type, sd.scope_value
      from public.sa_emergency_access_grants g
      join public.sa_scope_definitions sd on sd.id = g.scope_id and sd.status = 'active'
      where g.user_id = p_actor and g.status = 'active'
        and g.activated_at is not null and g.activated_at <= v_now
        and g.effective_until > v_now
        and p_permission = any(g.permission_keys)
        and (v_org is null or g.organization_id = any(v_ancestry))
    loop
      v_match := public.sa_scope_matches(p_actor, e.scope_type, e.scope_value, v_ctx, v_ancestry);
      if v_match is null then v_missing_context := true; end if;
      if v_match is true then
        return jsonb_build_object('decision','ALLOW','reason_code','ALLOWED_BY_EMERGENCY_ACCESS',
          'matched_assignments', jsonb_build_array(jsonb_build_object('emergencyGrantId', e.id, 'effectiveUntil', e.effective_until)),
          'resolved_scopes', v_scopes || jsonb_build_array(jsonb_build_object(
            'emergencyGrantId', e.id, 'scopeType', e.scope_type, 'scopeValue', e.scope_value, 'matched', true)));
      end if;
    end loop;
  end if;

  -- Scoped, non-transitive delegation. The delegator is evaluated WITHOUT
  -- delegations or emergency access, for this exact resource context, at
  -- decision time: a delegate can never exceed what the delegator holds directly.
  if p_include_delegation then
    for d in
      select dl.id, dl.delegator_id from public.sa_delegations dl
      where dl.delegate_id = p_actor and dl.status = 'active'
        and dl.effective_from <= v_now and dl.effective_until > v_now
        and p_permission = any(dl.permission_keys)
        and (v_org is null or dl.organization_id = any(v_ancestry))
    loop
      if (public.sa_evaluate_permission_core(d.delegator_id, p_permission, v_ctx, false, false)->>'decision') = 'ALLOW' then
        return jsonb_build_object('decision','ALLOW','reason_code','ALLOWED_BY_DELEGATION',
          'matched_assignments', jsonb_build_array(jsonb_build_object('delegationId', d.id, 'delegatorId', d.delegator_id)),
          'resolved_scopes', v_scopes);
      end if;
    end loop;
  end if;

  if not v_has_assignment then
    return jsonb_build_object('decision','DENY','reason_code','MISSING_ASSIGNMENT','matched_assignments','[]'::jsonb,'resolved_scopes','[]'::jsonb);
  end if;
  if jsonb_array_length(v_permitted) = 0 then
    return jsonb_build_object('decision','DENY','reason_code','MISSING_PERMISSION','matched_assignments','[]'::jsonb,'resolved_scopes','[]'::jsonb);
  end if;
  return jsonb_build_object('decision','DENY',
    'reason_code', case when v_missing_context then 'MISSING_CONTEXT' else 'SCOPE_MISMATCH' end,
    'matched_assignments', v_permitted, 'resolved_scopes', v_scopes);
end $$;
revoke all on function public.sa_evaluate_permission_core(uuid,text,jsonb,boolean,boolean) from public, anon, authenticated;
grant execute on function public.sa_evaluate_permission_core(uuid,text,jsonb,boolean,boolean) to service_role;
comment on function public.sa_evaluate_permission(uuid,text,jsonb,boolean) is
  'Canonical S&A new-model decision with explanation (Root Access, assignments, active emergency access, delegation). Service-only; database gates call it internally for auth.uid().';

-- Grant authority. With an organization: the evaluator (Root Access included, emergency access excluded — as in
-- 20261024100000). Without one (custom-policy ceiling): Root Access for an active catalogue permission, or any active
-- explicit assignment of a role that contains it (body otherwise identical to 20261024100000).
create or replace function public.sa_actor_holds_permission(p_actor uuid, p_key text, p_org uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select case when p_org is not null
    then coalesce((public.sa_evaluate_permission_core(p_actor, p_key, jsonb_build_object('organization_id', p_org), true, false)->>'decision') = 'ALLOW', false)
    else (public.sa_actor_is_root(p_actor)
          and exists (select 1 from public.sa_permissions p where p.permission_key = p_key and p.status = 'active'))
      or exists (
      select 1 from public.sa_role_assignments a
      join public.sa_organization_memberships m on m.id = a.membership_id and m.status = 'active'
        and (m.effective_from is null or m.effective_from <= now()) and (m.effective_until is null or m.effective_until > now())
      join public.sa_business_roles br on br.id = a.role_id and br.status = 'active'
      join public.sa_business_role_permissions rp on rp.role_id = br.id
      join public.sa_permissions p on p.id = rp.permission_id and p.status = 'active' and p.permission_key = p_key
      where a.user_id = p_actor and a.status = 'active'
        and (a.effective_from is null or a.effective_from <= now()) and (a.effective_until is null or a.effective_until > now()))
  end
$$;
revoke all on function public.sa_actor_holds_permission(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.sa_actor_holds_permission(uuid,text,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Side paths that read assignments directly
-- ---------------------------------------------------------------------------
-- List scope: Root Access reads every organization (same answer the evaluator gives per organization).
-- Body otherwise identical to 20260930100000.
create or replace function public.sa_readable_organizations(p_actor uuid, p_permission text, p_include_delegation boolean default true)
returns uuid[] language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_now timestamptz := now();
  v_direct uuid[];
  v_delegated uuid[] := array[]::uuid[];
  d record;
begin
  if p_actor is null or p_permission is null then return array[]::uuid[]; end if;
  if not exists (select 1 from public.users u where u.id = p_actor and u.is_active is true) then
    return array[]::uuid[];
  end if;

  if public.sa_actor_is_root(p_actor)
     and exists (select 1 from public.sa_permissions p where p.permission_key = p_permission and p.status = 'active') then
    return coalesce((select array_agg(o.id) from public.organizations o), array[]::uuid[]);
  end if;

  -- (organization, ancestor) closure, same depth limit as sa_org_ancestry.
  with recursive up(id, anc, depth) as (
    select o.id, o.id, 0 from public.organizations o
    union all
    select up.id, o.parent_org_id, up.depth + 1
    from up join public.organizations o on o.id = up.anc
    where o.parent_org_id is not null and up.depth < 10
  ),
  grants as (
    select m.organization_id as m_org, (sd.scope_value)::uuid as s_org
    from public.sa_role_assignments a
    join public.sa_business_roles br on br.id = a.role_id and br.status = 'active'
    join public.sa_business_role_permissions rp on rp.role_id = br.id
    join public.sa_permissions p on p.id = rp.permission_id and p.status = 'active' and p.permission_key = p_permission
    join public.sa_organization_memberships m on m.id = a.membership_id and m.user_id = p_actor and m.status = 'active'
      and (m.effective_from is null or m.effective_from <= v_now)
      and (m.effective_until is null or m.effective_until > v_now)
    join public.sa_assignment_scopes x on x.assignment_id = a.id
    join public.sa_scope_definitions sd on sd.id = x.scope_id and sd.status = 'active' and sd.scope_type = 'organization'
    where a.user_id = p_actor and a.status = 'active'
      and (a.effective_from is null or a.effective_from <= v_now)
      and (a.effective_until is null or a.effective_until > v_now)
      and sd.scope_value ~ '^[0-9a-fA-F-]{36}$'
  )
  select coalesce(array_agg(distinct u1.id), array[]::uuid[]) into v_direct
  from grants g
  join up u1 on u1.anc = g.m_org
  join up u2 on u2.id = u1.id and u2.anc = g.s_org;

  if p_include_delegation then
    for d in
      select dl.delegator_id, dl.organization_id from public.sa_delegations dl
      where dl.delegate_id = p_actor and dl.status = 'active'
        and dl.effective_from <= v_now and dl.effective_until > v_now
        and p_permission = any(dl.permission_keys)
    loop
      -- A delegate reaches X when the delegation's organization is X or an
      -- ancestor of X and the delegator directly reaches X.
      v_delegated := v_delegated || coalesce((
        select array_agg(x) from unnest(public.sa_readable_organizations(d.delegator_id, p_permission, false)) x
        where d.organization_id = any(public.sa_org_ancestry(x))), array[]::uuid[]);
    end loop;
  end if;

  return coalesce((select array_agg(distinct x) from unnest(v_direct || v_delegated) x), array[]::uuid[]);
end
$fn$;
revoke all on function public.sa_readable_organizations(uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.sa_readable_organizations(uuid,text,boolean) to service_role;

-- Target protection: a person holding Root Access can be acted on (password reset, delete, ...) only by another
-- Root Administrator; a Root Administrator dominates everyone. Body otherwise identical to 20260930100000.
create or replace function public.sa_actor_dominates(p_actor uuid, p_target uuid)
returns boolean language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  g record;
  v_ctx jsonb;
begin
  if p_actor is null or p_target is null then return false; end if;
  if p_actor = p_target then return true; end if;
  if not exists (select 1 from public.users u where u.id = p_actor and u.is_active is true) then return false; end if;
  if public.sa_actor_is_root(p_actor) then return true; end if;
  -- Any not-yet-ended Root Access grant protects the target (also while their account is inactive).
  if exists (select 1 from public.sa_root_access_grants r where r.user_id = p_target and r.status = 'active'
             and (r.effective_until is null or r.effective_until > now())) then
    return false;
  end if;

  for g in
    select distinct p.permission_key, sd.scope_type, sd.scope_value, sd.organization_id
    from public.sa_role_assignments a
    join public.sa_business_roles br on br.id = a.role_id
    join public.sa_business_role_permissions rp on rp.role_id = br.id
    join public.sa_permissions p on p.id = rp.permission_id and p.status = 'active'
    join public.sa_assignment_scopes x on x.assignment_id = a.id
    join public.sa_scope_definitions sd on sd.id = x.scope_id
    where a.user_id = p_target and a.status in ('active', 'suspended')
      and (a.effective_until is null or a.effective_until > now())
      and sd.scope_type not in ('own_record', 'direct_reports')
  loop
    v_ctx := case g.scope_type
      when 'organization' then jsonb_build_object('organization_id', g.scope_value)
      when 'warehouse'    then jsonb_build_object('warehouse_id', g.scope_value, 'organization_id', g.organization_id)
      when 'department'   then jsonb_build_object('department_id', g.scope_value, 'organization_id', g.organization_id)
      else jsonb_strip_nulls(jsonb_build_object('organization_id', g.organization_id,
                                                'attributes', jsonb_build_object(g.scope_type, g.scope_value)))
    end;
    if coalesce(public.sa_evaluate_permission(p_actor, g.permission_key, v_ctx, false)->>'decision', 'DENY') <> 'ALLOW' then
      return false;
    end if;
  end loop;
  return true;
end
$fn$;
revoke all on function public.sa_actor_dominates(uuid,uuid) from public, anon, authenticated;
grant execute on function public.sa_actor_dominates(uuid,uuid) to service_role;

-- S&A directory scope: in the new modes a Root Administrator sees every organization (not only those below their
-- own memberships). Legacy modes are unchanged. Body otherwise identical to 20261009100000.
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
      return;
    end if;
    if not public.sa_delegated_administration_enabled() then return; end if;
  elsif public.sa_actor_is_root(p_actor) then
    return query select o.id from public.organizations o;
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

-- Scope guard: organization-independent scopes may be granted by a Root Administrator as well as by a legacy
-- Super Admin. Body otherwise identical to 20261009100000.
create or replace function public.sa_assignment_scope_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_actor uuid := new.created_by; v_source text; v_org uuid;
begin
  if v_actor is null then return new; end if;
  select a.source into v_source from public.sa_role_assignments a where a.id = new.assignment_id;
  if v_source is null or v_source not in ('manual', 'access_request') then return new; end if;
  if public.sa_legacy_is_super_admin(v_actor) or public.sa_actor_is_root(v_actor) then return new; end if;
  select sd.organization_id into v_org from public.sa_scope_definitions sd where sd.id = new.scope_id;
  if v_org is null
     or not (public.sa_actor_has_permission(v_actor, 'security.role.assign', jsonb_build_object('organization_id', v_org))
          or public.sa_actor_has_permission(v_actor, 'security.access_request.approve', jsonb_build_object('organization_id', v_org))) then
    raise exception 'sa_grant_scope_beyond_authority' using errcode = '42501',
      hint = 'A scope can be granted only inside an organization where you hold the grant authority; organization-independent scopes are granted by a central Super Admin.';
  end if;
  return new;
end $$;
revoke all on function public.sa_assignment_scope_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Grant / revoke / bootstrap
-- ---------------------------------------------------------------------------
-- Refusals are RETURNED ({ok:false, code}) after being logged, so the audit row survives (a raised error would roll
-- it back). Success returns {ok:true, grant_id, replayed, effective_until}.
create or replace function public.sa_grant_root_access(
  p_actor uuid, p_target uuid, p_reason text, p_until timestamptz, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_existing public.sa_root_access_grants;
  v_code text;
  v_id uuid;
  v_expired record;
begin
  -- One Root Access change at a time, system-wide.
  perform pg_advisory_xact_lock(hashtextextended('sa_root_access', 0));

  if p_request_key is not null then
    select * into v_existing from public.sa_root_access_grants where request_key = p_request_key;
    if found then
      if v_existing.granted_by is distinct from p_actor or v_existing.user_id is distinct from p_target then
        v_code := 'root_request_key_conflict';
      else
        return jsonb_build_object('ok', true, 'grant_id', v_existing.id, 'replayed', true, 'status', v_existing.status,
                                  'effective_until', v_existing.effective_until);
      end if;
    end if;
  end if;

  -- Elapsed grants no longer count as active (logged once, here or by maintenance).
  for v_expired in
    update public.sa_root_access_grants set status = 'expired', expired_at = now()
    where status = 'active' and effective_until is not null and effective_until <= now()
    returning id, user_id, effective_until
  loop
    perform public.sa_root_log(null, 'root_access.expired', v_expired.user_id, v_expired.id::text,
      jsonb_build_object('effective_until', v_expired.effective_until), null, 'system');
  end loop;

  if v_code is null then
    v_code := case
      when p_actor is null then 'root_actor_required'
      when not public.sa_actor_is_root(p_actor) then 'root_authority_required'
      when p_target is null then 'root_target_not_found'
      when p_actor = p_target then 'root_self_grant_prohibited'
      else public.sa_root_target_refusal(p_target)
    end;
  end if;
  if v_code is null and exists (select 1 from public.sa_root_access_grants where user_id = p_target and status = 'active') then
    v_code := 'root_already_active';
  end if;
  if v_code is null and (length(v_reason) < 10 or length(v_reason) > 500) then v_code := 'root_reason_required'; end if;
  if v_code is null and p_until is not null and p_until < now() + interval '15 minutes' then v_code := 'root_expiry_invalid'; end if;

  if v_code is not null then
    perform public.sa_root_log(p_actor, 'root_access.grant_denied', p_target, null,
      jsonb_build_object('code', v_code, 'effective_until', p_until,
                         'actor_is_legacy_super_admin', coalesce(public.sa_legacy_is_super_admin(p_actor), false)), v_reason);
    return jsonb_build_object('ok', false, 'code', v_code);
  end if;

  insert into public.sa_root_access_grants(user_id, status, grant_method, reason, granted_by, effective_until, request_key)
  values (p_target, 'active', 'grant', v_reason, p_actor, p_until, p_request_key)
  returning id into v_id;
  perform public.sa_root_log(p_actor, 'root_access.granted', p_target, v_id::text,
    jsonb_build_object('effective_until', p_until, 'grant_method', 'grant', 'active_root_administrators', public.sa_active_root_count(null)), v_reason);
  return jsonb_build_object('ok', true, 'grant_id', v_id, 'replayed', false, 'status', 'active', 'effective_until', p_until);
end $$;
revoke all on function public.sa_grant_root_access(uuid,uuid,text,timestamptz,uuid) from public, anon, authenticated;
grant execute on function public.sa_grant_root_access(uuid,uuid,text,timestamptz,uuid) to service_role;
comment on function public.sa_grant_root_access(uuid,uuid,text,timestamptz,uuid) is
  'Grants Root Access. Actor must be an active Root Administrator (legacy level 1 is not enough); no self-grant; HQ staff only; reason required; refusals are logged and returned as {ok:false, code}. Service role only.';

create or replace function public.sa_revoke_root_access(p_actor uuid, p_target uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_grant public.sa_root_access_grants;
  v_code text;
begin
  perform pg_advisory_xact_lock(hashtextextended('sa_root_access', 0));
  select * into v_grant from public.sa_root_access_grants where user_id = p_target and status = 'active' for update;

  v_code := case
    when p_actor is null then 'root_actor_required'
    when not public.sa_actor_is_root(p_actor) then 'root_authority_required'
    when p_target is null then 'root_target_not_found'
    when p_actor = p_target then 'root_self_revoke_prohibited'
    when v_grant.id is null then 'root_not_active'
    when v_grant.effective_until is not null and v_grant.effective_until <= now() then 'root_not_active'
    when length(v_reason) < 10 or length(v_reason) > 500 then 'root_reason_required'
    -- Defence in depth: the actor is itself an active Root Administrator, so this holds whenever the checks above
    -- pass; it stays explicit so a future change cannot remove the last one.
    when public.sa_active_root_count(p_target) < 1 then 'root_last_administrator'
  end;
  if v_code is not null then
    perform public.sa_root_log(p_actor, 'root_access.revoke_denied', p_target, v_grant.id::text,
      jsonb_build_object('code', v_code), v_reason);
    return jsonb_build_object('ok', false, 'code', v_code);
  end if;

  update public.sa_root_access_grants set status = 'revoked', revoked_at = now(), revoked_by = p_actor, revoke_reason = v_reason
  where id = v_grant.id;
  perform public.sa_root_log(p_actor, 'root_access.revoked', p_target, v_grant.id::text,
    jsonb_build_object('granted_at', v_grant.granted_at, 'granted_by', v_grant.granted_by, 'effective_until', v_grant.effective_until,
                       'active_root_administrators', public.sa_active_root_count(null)), v_reason);
  return jsonb_build_object('ok', true, 'grant_id', v_grant.id);
end $$;
revoke all on function public.sa_revoke_root_access(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.sa_revoke_root_access(uuid,uuid,text) to service_role;
comment on function public.sa_revoke_root_access(uuid,uuid,text) is
  'Revokes Root Access only (Group Policies and other access are untouched). Actor must be another active Root Administrator; never the last one; refusals are logged and returned as {ok:false, code}. Service role only.';

-- Initial (or recovery) Root Administrator. Database owner only, and only while nobody holds active Root Access.
create or replace function public.sa_bootstrap_root_access(p_target uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_code text;
  v_id uuid;
begin
  if nullif(current_setting('request.jwt.claims', true), '') is not null then
    raise exception 'root_bootstrap_owner_only' using errcode = '42501',
      hint = 'Run it by hand as the database owner (SQL editor / psql), never through the API.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sa_root_access', 0));
  update public.sa_root_access_grants set status = 'expired', expired_at = now()
  where status = 'active' and effective_until is not null and effective_until <= now();
  if public.sa_active_root_count(null) > 0 then
    raise exception 'root_bootstrap_not_allowed' using errcode = '42501',
      hint = 'An active Root Administrator exists; Root Access is granted by a Root Administrator in People & Access.';
  end if;
  v_code := public.sa_root_target_refusal(p_target);
  if v_code is not null then raise exception '%', v_code using errcode = '22023'; end if;
  if length(v_reason) < 10 or length(v_reason) > 500 then raise exception 'root_reason_required' using errcode = '22023'; end if;
  -- (A deactivated Root Administrator keeps an 'active' row and regains Root Access only if the account is reactivated;
  -- the target itself must be active, so this only catches a duplicate.)
  if exists (select 1 from public.sa_root_access_grants where user_id = p_target and status = 'active') then
    raise exception 'root_already_active' using errcode = '22023';
  end if;

  insert into public.sa_root_access_grants(user_id, status, grant_method, reason, granted_by)
  values (p_target, 'active', 'bootstrap', v_reason, null)
  returning id into v_id;
  perform public.sa_root_log(null, 'root_access.bootstrapped', p_target, v_id::text,
    jsonb_build_object('grant_method', 'bootstrap', 'database_session_user', session_user::text), v_reason, 'system');
  return v_id;
end $$;
revoke all on function public.sa_bootstrap_root_access(uuid,text) from public, anon, authenticated, service_role;
comment on function public.sa_bootstrap_root_access(uuid,text) is
  'Records the first (or recovery) Root Administrator. Database owner only; refused while any active Root Administrator exists. Never callable through the API.';

-- ---------------------------------------------------------------------------
-- 6. Maintenance: also expire elapsed Root Access (body otherwise as in 20261024100000)
-- ---------------------------------------------------------------------------
create or replace function public.sa_governance_maintenance()
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_assignments integer; v_delegations integer; v_requests integer; v_mitigations integer; v_emergency integer;
  v_root integer := 0; v_r record;
begin
  with x as (
    update public.sa_role_assignments set status = 'revoked', ended_reason = coalesce(ended_reason, 'expired'), updated_at = now()
    where status = 'active' and effective_until is not null and effective_until <= now()
      and source not in ('backfill','derived')   -- lifecycle-owned rows are re-derived by the lifecycle sync
    returning id, user_id)
  select count(*) into v_assignments from x;
  with x as (
    update public.sa_delegations set status = 'expired'
    where status = 'active' and effective_until <= now() returning id)
  select count(*) into v_delegations from x;
  with x as (
    update public.sa_access_requests set status = 'expired', updated_at = now()
    where status = 'requested' and (created_at < now() - make_interval(days => public.sa_setting_int('access_request.pending_expiry_days', 30))
                                    or (effective_until is not null and effective_until <= now()))
    returning id)
  select count(*) into v_requests from x;
  with x as (
    update public.sa_sod_mitigations set status = 'revoked' where status = 'active' and effective_until <= now() returning id)
  select count(*) into v_mitigations from x;
  with x as (
    update public.sa_emergency_access_grants set status = 'expired'
    where status = 'active' and effective_until <= now() returning id)
  select count(*) into v_emergency from x;
  perform pg_advisory_xact_lock(hashtextextended('sa_root_access', 0));
  for v_r in
    update public.sa_root_access_grants set status = 'expired', expired_at = now()
    where status = 'active' and effective_until is not null and effective_until <= now()
    returning id, user_id, effective_until
  loop
    v_root := v_root + 1;
    perform public.sa_root_log(null, 'root_access.expired', v_r.user_id, v_r.id::text,
      jsonb_build_object('effective_until', v_r.effective_until), null, 'system');
  end loop;
  if v_assignments + v_delegations + v_requests + v_mitigations + v_emergency + v_root > 0 then
    perform public.sa_log_access_change(null, 'governance.maintenance', null, 'sa_governance', null,
      jsonb_build_object('assignments_expired', v_assignments, 'delegations_expired', v_delegations,
                         'requests_expired', v_requests, 'mitigations_expired', v_mitigations,
                         'emergency_access_expired', v_emergency, 'root_access_expired', v_root), null, 'system');
  end if;
  return jsonb_build_object('assignments_expired', v_assignments, 'delegations_expired', v_delegations,
                            'requests_expired', v_requests, 'mitigations_expired', v_mitigations,
                            'emergency_access_expired', v_emergency, 'root_access_expired', v_root);
end $$;
revoke all on function public.sa_governance_maintenance() from public, anon, authenticated;
grant execute on function public.sa_governance_maintenance() to service_role;

-- ---------------------------------------------------------------------------
-- 7. Post-conditions
-- ---------------------------------------------------------------------------
do $post$
declare v_t text; v_f text;
begin
  foreach v_t in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
    if has_table_privilege('authenticated', 'public.sa_root_access_grants', v_t)
       or has_table_privilege('anon', 'public.sa_root_access_grants', v_t)
       or has_table_privilege('service_role', 'public.sa_root_access_grants', v_t) then
      raise exception 'postcondition: sa_root_access_grants must have no API-role % privilege', v_t;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.sa_root_access_grants', 'SELECT')
     or has_table_privilege('anon', 'public.sa_root_access_grants', 'SELECT') then
    raise exception 'postcondition: sa_root_access_grants is not readable by API users';
  end if;
  foreach v_f in array array['public.sa_grant_root_access(uuid,uuid,text,timestamptz,uuid)', 'public.sa_revoke_root_access(uuid,uuid,text)',
                             'public.sa_bootstrap_root_access(uuid,text)', 'public.sa_actor_is_root(uuid)', 'public.sa_active_root_count(uuid)',
                             'public.sa_root_target_refusal(uuid)', 'public.sa_root_log(uuid,text,uuid,text,jsonb,text,text)',
                             'public.sa_evaluate_permission_core(uuid,text,jsonb,boolean,boolean)'] loop
    if has_function_privilege('authenticated', v_f, 'EXECUTE') or has_function_privilege('anon', v_f, 'EXECUTE') then
      raise exception 'postcondition: % must not be executable by API users', v_f;
    end if;
  end loop;
  if has_function_privilege('service_role', 'public.sa_bootstrap_root_access(uuid,text)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.sa_root_log(uuid,text,uuid,text,jsonb,text,text)', 'EXECUTE') then
    raise exception 'postcondition: bootstrap and the root audit helper are database-owner only';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname like 'sa\_%' and p.prosecdef
               and not exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c where c like 'search_path=%pg_temp%')) then
    raise exception 'postcondition: every SECURITY DEFINER sa_* function must pin search_path ending in pg_temp';
  end if;
end $post$;
