-- ============================================================================
-- Security & Access — Emergency Access grant flow with MFA step-up (AAL2)
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database,
-- so nothing in this file has been run against a real database (throwaway PostgreSQL 17 with the REAL S&A
-- migrations: supabase/tests/security/sa_emergency_access/run.sh).
--
-- Why: security.emergency_access.grant was "not enforcement-ready" because nothing could grant emergency access
-- (sa_request_emergency_access was a refusing stub), the evaluator never consulted sa_emergency_access_grants, and
-- no MFA step-up existed. This migration adds the missing pieces; it does NOT switch emergency access on
-- (emergency_access.enabled stays false — see 20261024110000_sa_emergency_access_enable.sql) and changes no
-- migration mode, grant or assignment.
--
-- 1. sa_grant_emergency_access(actor, target, org, permission_keys, scope, reason, minutes, step_up_session, request_key)
--    service_role only; the application server calls it after its own S&A decision. Re-verifies in the database:
--      * emergency access enabled + MFA step-up prerequisite registered (sa_settings);
--      * actor active, holds security.emergency_access.grant for the organization AND the scope's organization
--        (mode-aware: legacy Super Admin rule while Monitoring, S&A decision once enforced — sa_assert_actor_permission);
--      * fresh MFA step-up of the ACTOR, read from GoTrue's own tables, never from a client value: the session
--        (auth.sessions) belongs to the actor, is aal2, not expired, is bound to a still-verified TOTP factor
--        (auth.mfa_factors), and its TOTP AMR claim (auth.mfa_amr_claims.updated_at, rewritten by GoTrue on every
--        successful verify) is at most emergency_access.step_up_max_age_seconds old (default 300);
--      * no self-grant; a Super Admin account receives emergency access only from a Super Admin;
--      * target active with an active membership in the organization;
--      * 1–10 explicit, active, existing permissions; never security.* (break-glass never grants access
--        administration, so it cannot be chained or used to raise grant authority); each permission must already be
--        New Access Active / Legacy Retired (in Monitoring the legacy rule decides, so a grant would do nothing);
--      * grant ceiling: the actor holds each permission directly in that organization (legacy Super Admin excepted,
--        as for every other grant); emergency access never counts toward anyone's grant authority;
--      * exactly one organization/warehouse scope eligible for the target's membership (sa_scope_eligible_for_membership);
--      * segregation of duties (permission conflicts with what the target already holds; enforce rules refuse,
--        monitor rules are recorded in sa_sod_violations);
--      * mandatory justification (20–500 characters) and a bounded duration
--        (emergency_access.min_minutes .. emergency_access.max_minutes; defaults 5 .. 240);
--      * at most one active emergency grant per person and organization; a retried submission with the same
--        request key returns the original grant (no duplicate).
--    Audited in sa_access_change_log ('emergency_access.granted'); no MFA secret, code or token is stored anywhere.
-- 2. sa_revoke_emergency_access(actor, grant, reason): holder of security.emergency_access.grant for the organization;
--    no step-up needed (it only removes access). Audited ('emergency_access.revoked').
-- 3. Evaluator: sa_evaluate_permission now ALLOWs through an active, unexpired emergency grant for its permissions
--    and scope only (reason ALLOWED_BY_EMERGENCY_ACCESS). Expiry/revocation is checked at every decision, so access
--    ends immediately even for an open session. Emergency access is never delegable (delegators are evaluated
--    without it) and never counts as grant authority (sa_actor_holds_permission) or as target dominance
--    (sa_actor_dominates evaluates without delegation, hence without emergency access).
-- 4. sa_governance_maintenance also marks elapsed grants 'expired' (cosmetic: the evaluator already ignores them).
-- 5. Grant rows are history: no delete, identity columns immutable, status moves only forward.
-- 6. sa_request_emergency_access (stub that was EXECUTE-able by authenticated) now refuses and is service-role only.
-- 7. Readiness: security.emergency_access.grant registered in sa_enforcement_readiness (governance_function backstop).
--    Its mode stays Monitoring; management moves it Monitoring → New Access Active → Legacy Retired.
-- 8. sa_settings: emergency_access.mfa_step_up_available = true (prerequisite met by this migration + the application
--    release), new emergency_access.step_up_max_age_seconds = 300 and emergency_access.min_minutes = 5.
--
-- Depends on (must already be applied): 20260928100000 (tables/evaluator), 20260928130000 (readiness table),
--   20260930100000 (sa_actor_dominates), 20261009100000 (sa_actor_holds_permission, sa_assert_actor_permission with
--   org context), 20261011100000 (sa_scope_eligible_for_membership). Independent of the other unapplied 202610xx files.
-- Run as the database owner (supabase_admin): the SECURITY DEFINER functions read auth.sessions / auth.mfa_factors /
--   auth.mfa_amr_claims.
-- Idempotent: yes.
-- Supabase grants EXECUTE on every new public function to anon, authenticated AND service_role (default privileges), so
--   internal-only functions revoke service_role explicitly (the step-up check, the trigger guard, the closed stub).
--
-- Rollback (only while security.emergency_access.grant is not NEW_ENFORCED / LEGACY_RETIRED, and after revoking any
-- active emergency grant):
--   delete from public.sa_enforcement_readiness where permission_key = 'security.emergency_access.grant';
--   update public.sa_settings set setting_value = 'false' where setting_key = 'emergency_access.enabled';
--   update public.sa_settings set setting_value = 'false' where setting_key = 'emergency_access.mfa_step_up_available';
--   re-run the sa_evaluate_permission / sa_request_emergency_access / sa_governance_maintenance definitions of
--   20260928100000 and sa_actor_holds_permission of 20261009100000; then
--   drop function public.sa_evaluate_permission_core(uuid,text,jsonb,boolean,boolean),
--     public.sa_grant_emergency_access(uuid,uuid,uuid,text[],uuid,text,integer,uuid,uuid),
--     public.sa_revoke_emergency_access(uuid,uuid,text), public.sa_assert_fresh_step_up(uuid,uuid),
--     public.sa_emergency_grant_guard();
--   (new columns on sa_emergency_access_grants may stay; they are nullable.)
-- ============================================================================

do $pre$
begin
  if to_regclass('public.sa_emergency_access_grants') is null or to_regclass('public.sa_enforcement_readiness') is null then
    raise exception 'sa_prerequisite_missing: 20260928100000 / 20260928130000';
  end if;
  if to_regprocedure('public.sa_actor_holds_permission(uuid,text,uuid)') is null
     or to_regprocedure('public.sa_actor_org_context(uuid)') is null then
    raise exception 'sa_prerequisite_missing: apply 20261009100000_sa_group_policies_full_access.sql first';
  end if;
  if to_regprocedure('public.sa_scope_eligible_for_membership(uuid,uuid)') is null then
    raise exception 'sa_prerequisite_missing: apply 20261011100000_sa_scope_eligibility_for_grants.sql first';
  end if;
  if to_regprocedure('public.sa_actor_dominates(uuid,uuid)') is null then
    raise exception 'sa_prerequisite_missing: sa_actor_dominates (20260930100000)';
  end if;
  if to_regclass('auth.sessions') is null or to_regclass('auth.mfa_factors') is null or to_regclass('auth.mfa_amr_claims') is null then
    raise exception 'sa_prerequisite_missing: Supabase Auth MFA tables (auth.sessions, auth.mfa_factors, auth.mfa_amr_claims)';
  end if;
  if not exists (select 1 from public.sa_permissions where permission_key = 'security.emergency_access.grant') then
    raise exception 'sa_prerequisite_missing: security.emergency_access.grant permission';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Grant table: scope, step-up evidence, idempotency, revocation
-- ---------------------------------------------------------------------------
alter table public.sa_emergency_access_grants
  add column if not exists scope_id uuid references public.sa_scope_definitions(id),
  add column if not exists duration_minutes integer,
  add column if not exists step_up_session_id uuid,
  add column if not exists step_up_verified_at timestamptz,
  add column if not exists request_key uuid,
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by uuid references public.users(id),
  add column if not exists revoke_reason text;

create unique index if not exists sa_emergency_request_key_uq on public.sa_emergency_access_grants(request_key) where request_key is not null;
-- One active emergency grant per person and organization (a retry or double click cannot create a second one).
create unique index if not exists sa_emergency_one_active_uq on public.sa_emergency_access_grants(user_id, organization_id) where status = 'active';
create index if not exists sa_emergency_active_user_idx on public.sa_emergency_access_grants(user_id, status, effective_until);

comment on column public.sa_emergency_access_grants.step_up_session_id is
  'GoTrue session id (auth.sessions.id) whose fresh TOTP verification authorized the grant. An identifier, never a token.';
comment on column public.sa_emergency_access_grants.authentication_assurance is
  'Assurance verified in the database at grant time (aal2:totp). Never taken from the client.';

-- Grant rows are audit history: never deleted, identity columns immutable, status only moves forward.
create or replace function public.sa_emergency_grant_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'sa_emergency_history_immutable' using errcode = '42501';
  end if;
  if (new.id, new.user_id, new.organization_id, new.permission_keys, new.reason, new.requested_at, new.granted_by,
      new.scope_id, new.duration_minutes, new.step_up_session_id, new.step_up_verified_at, new.request_key,
      new.authentication_assurance, new.activated_at, new.effective_until)
     is distinct from
     (old.id, old.user_id, old.organization_id, old.permission_keys, old.reason, old.requested_at, old.granted_by,
      old.scope_id, old.duration_minutes, old.step_up_session_id, old.step_up_verified_at, old.request_key,
      old.authentication_assurance, old.activated_at, old.effective_until) then
    raise exception 'sa_emergency_history_immutable' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'requested' and new.status in ('rejected', 'revoked', 'active'))
    or (old.status = 'active' and new.status in ('revoked', 'expired'))) then
    raise exception 'sa_emergency_status_transition_invalid' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.sa_emergency_grant_guard() from public, anon, authenticated, service_role;
drop trigger if exists sa_emergency_grant_guard on public.sa_emergency_access_grants;
create trigger sa_emergency_grant_guard before update or delete on public.sa_emergency_access_grants
  for each row execute function public.sa_emergency_grant_guard();

-- ---------------------------------------------------------------------------
-- 2. Settings
-- ---------------------------------------------------------------------------
insert into public.sa_settings(setting_key, setting_value, description) values
 ('emergency_access.step_up_max_age_seconds', '300'::jsonb, 'A grant needs a TOTP verification of the granting administrator''s current session at most this many seconds old.'),
 ('emergency_access.min_minutes', '5'::jsonb, 'Minimum emergency access window.')
on conflict (setting_key) do nothing;
-- The prerequisite is met by this migration (database step-up check) together with the application release that
-- performs TOTP enrollment and step-up. Enabling the feature itself is a separate, explicit decision (20261024110000).
update public.sa_settings set setting_value = 'true'::jsonb, updated_at = now(),
  description = 'MFA step-up (TOTP, AAL2) is verified by sa_assert_fresh_step_up against auth.sessions / auth.mfa_factors / auth.mfa_amr_claims (20261024100000).'
where setting_key = 'emergency_access.mfa_step_up_available';

-- ---------------------------------------------------------------------------
-- 3. Evaluator: emergency grants are consumed by the canonical decision
-- ---------------------------------------------------------------------------
-- Body identical to 20260928100000 sa_evaluate_permission except: the emergency-grant branch, and the recursive
-- delegator evaluation that now excludes emergency access as well as delegation.
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

-- Same signature and grants as before. Emergency access counts exactly when delegation does: in ordinary decisions
-- (the application, RLS and RPC gates), never in "does the actor hold it directly" checks (include_delegation=false:
-- delegator evaluation, sa_actor_dominates, sa_create_delegation).
create or replace function public.sa_evaluate_permission(
  p_actor uuid, p_permission text, p_context jsonb default '{}'::jsonb, p_include_delegation boolean default true)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select public.sa_evaluate_permission_core(p_actor, p_permission, p_context, p_include_delegation, p_include_delegation)
$$;
revoke all on function public.sa_evaluate_permission(uuid,text,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.sa_evaluate_permission(uuid,text,jsonb,boolean) to service_role;
comment on function public.sa_evaluate_permission(uuid,text,jsonb,boolean) is
  'Canonical S&A new-model decision with explanation (assignments, active emergency access, delegation). Service-only; database gates call it internally for auth.uid().';

-- Grant authority (the ceiling used by every grant guard) never comes from emergency access. Delegated rights keep
-- counting as before. Body otherwise identical to 20261009100000.
create or replace function public.sa_actor_holds_permission(p_actor uuid, p_key text, p_org uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select case when p_org is not null
    then coalesce((public.sa_evaluate_permission_core(p_actor, p_key, jsonb_build_object('organization_id', p_org), true, false)->>'decision') = 'ALLOW', false)
    else exists (
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

-- ---------------------------------------------------------------------------
-- 4. MFA step-up, verified from GoTrue's own records
-- ---------------------------------------------------------------------------
-- Returns the time of the TOTP verification. Never trusts a client value: the application passes only the session id
-- taken from a JWT the auth server verified, and every property is re-read here.
create or replace function public.sa_assert_fresh_step_up(p_actor uuid, p_session uuid)
returns timestamptz language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_verified_at timestamptz;
  v_max_age integer := greatest(30, least(900, public.sa_setting_int('emergency_access.step_up_max_age_seconds', 300)));
begin
  if p_actor is null or p_session is null then
    raise exception 'emergency_access_step_up_required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from auth.sessions s
    join auth.mfa_factors f on f.id = s.factor_id and f.user_id = p_actor
      and f.factor_type::text = 'totp' and f.status::text = 'verified'
    where s.id = p_session and s.user_id = p_actor and s.aal::text = 'aal2'
      and (s.not_after is null or s.not_after > now())) then
    raise exception 'emergency_access_step_up_required' using errcode = '42501',
      hint = 'The session must be verified with a currently enrolled authenticator app (AAL2).';
  end if;
  select c.updated_at into v_verified_at from auth.mfa_amr_claims c
  where c.session_id = p_session and c.authentication_method = 'totp';
  if v_verified_at is null or v_verified_at < now() - make_interval(secs => v_max_age) or v_verified_at > now() + interval '1 minute' then
    raise exception 'emergency_access_step_up_stale' using errcode = '42501',
      hint = 'Verify a new authenticator code, then submit again.';
  end if;
  return v_verified_at;
end $$;
revoke all on function public.sa_assert_fresh_step_up(uuid,uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Grant / revoke
-- ---------------------------------------------------------------------------
create or replace function public.sa_grant_emergency_access(
  p_actor uuid, p_target uuid, p_org uuid, p_permission_keys text[], p_scope uuid, p_reason text,
  p_minutes integer, p_step_up_session uuid, p_request_key uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_existing public.sa_emergency_access_grants;
  v_keys text[];
  v_key text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_scope record;
  v_verified_at timestamptz;
  v_min integer := public.sa_setting_int('emergency_access.min_minutes', 5);
  v_max integer := public.sa_setting_int('emergency_access.max_minutes', 240);
  v_id uuid;
  v_until timestamptz;
  v_rule record;
  v_super_actor boolean;
begin
  if p_actor is null or p_target is null or p_org is null or p_scope is null or p_request_key is null then
    raise exception 'sa_invalid_emergency_grant';
  end if;
  -- Serialize submissions for the same person: concurrent retries cannot both pass the "one active grant" check.
  perform pg_advisory_xact_lock(hashtextextended('sa_emergency:' || p_target::text, 0));

  -- Idempotent replay: the same request key returns the original grant instead of creating another.
  select * into v_existing from public.sa_emergency_access_grants where request_key = p_request_key;
  if found then
    if v_existing.granted_by is distinct from p_actor or v_existing.user_id <> p_target then
      raise exception 'sa_emergency_request_key_conflict';
    end if;
    return jsonb_build_object('grant_id', v_existing.id, 'replayed', true, 'status', v_existing.status,
                              'effective_until', v_existing.effective_until);
  end if;

  if not public.sa_setting_bool('emergency_access.mfa_step_up_available', false)
     or not public.sa_setting_bool('emergency_access.enabled', false) then
    raise exception 'emergency_access_unavailable' using errcode = '42501';
  end if;
  if p_actor = p_target then raise exception 'sa_self_assignment_prohibited' using errcode = '42501'; end if;

  -- Authority for the organization (mode-aware; legacy rule = Super Admin while Monitoring).
  v_super_actor := public.sa_legacy_is_super_admin(p_actor);
  perform public.sa_assert_actor_permission(p_actor, 'security.emergency_access.grant',
    jsonb_build_object('organization_id', p_org), v_super_actor);

  -- MFA is additional verification, checked only after authority (it never authorizes by itself).
  v_verified_at := public.sa_assert_fresh_step_up(p_actor, p_step_up_session);

  -- Target.
  if not exists (select 1 from public.users u where u.id = p_target and u.is_active is true) then
    raise exception 'sa_target_inactive';
  end if;
  if not exists (select 1 from public.sa_organization_memberships m
                 where m.user_id = p_target and m.organization_id = p_org and m.status = 'active'
                   and (m.effective_from is null or m.effective_from <= now())
                   and (m.effective_until is null or m.effective_until > now())) then
    raise exception 'sa_membership_required';
  end if;
  if public.sa_legacy_is_super_admin(p_target) and not v_super_actor then
    raise exception 'sa_emergency_target_protected' using errcode = '42501';
  end if;

  -- Permissions: explicit, few, existing, enforced by the new model, never access administration.
  select coalesce(array_agg(distinct k order by k), '{}') into v_keys
  from unnest(coalesce(p_permission_keys, '{}')) k where nullif(btrim(k), '') is not null;
  if cardinality(v_keys) = 0 or cardinality(v_keys) > 10 or cardinality(v_keys) <> cardinality(p_permission_keys) then
    raise exception 'sa_emergency_permissions_invalid';
  end if;
  foreach v_key in array v_keys loop
    if v_key like 'security.%' then
      raise exception 'sa_emergency_permission_prohibited: %', v_key using errcode = '42501';
    end if;
    if not exists (select 1 from public.sa_permissions p where p.permission_key = v_key and p.status = 'active') then
      raise exception 'sa_emergency_permissions_invalid: %', v_key;
    end if;
    if not public.sa_is_new_authoritative(v_key) then
      raise exception 'sa_emergency_permission_not_enforced: %', v_key;
    end if;
    if not v_super_actor and not public.sa_actor_holds_permission(p_actor, v_key, p_org) then
      raise exception 'sa_grant_beyond_authority: %', v_key using errcode = '42501';
    end if;
  end loop;

  -- Scope: one organization/warehouse scope offerable to the target's membership, inside the actor's authority.
  select sd.id, sd.scope_type, sd.organization_id into v_scope
  from public.sa_scope_definitions sd
  where sd.id = p_scope and sd.status = 'active' and sd.scope_type in ('organization', 'warehouse')
    and sd.organization_id is not null and p_org = any(public.sa_org_ancestry(sd.organization_id));
  if not found or not public.sa_scope_eligible_for_membership(p_org, p_scope) then
    raise exception 'sa_scope_not_eligible';
  end if;
  if v_scope.organization_id <> p_org then
    perform public.sa_assert_actor_permission(p_actor, 'security.emergency_access.grant',
      jsonb_build_object('organization_id', v_scope.organization_id), v_super_actor);
  end if;

  if length(v_reason) < 20 then raise exception 'sa_emergency_reason_required'; end if;
  if length(v_reason) > 500 then raise exception 'sa_note_too_long'; end if;
  if p_minutes is null or p_minutes < v_min or p_minutes > v_max then
    raise exception 'sa_emergency_duration_invalid' using hint = format('Between %s and %s minutes.', v_min, v_max);
  end if;

  -- Elapsed grants no longer count as active.
  update public.sa_emergency_access_grants set status = 'expired'
  where user_id = p_target and status = 'active' and effective_until <= now();
  if exists (select 1 from public.sa_emergency_access_grants
             where user_id = p_target and organization_id = p_org and status = 'active') then
    raise exception 'sa_emergency_already_active';
  end if;

  -- Segregation of duties: the requested permissions together with everything the target already holds.
  for v_rule in
    with held as (
      select distinct p.permission_key from public.sa_role_assignments a
      join public.sa_business_role_permissions rp on rp.role_id = a.role_id
      join public.sa_permissions p on p.id = rp.permission_id
      where a.user_id = p_target and a.status = 'active' and (a.effective_until is null or a.effective_until > now())
      union select unnest(v_keys))
    select r.id, r.rule_key, r.enforcement, public.sa_sod_has_mitigation(r.id, p_target) as mitigated
    from public.sa_sod_rules r
    where public.sa_sod_rule_active(r) and r.rule_kind = 'permission_conflict'
      and (r.left_key = any(v_keys) or r.right_key = any(v_keys))
      and exists (select 1 from held where permission_key = r.left_key)
      and exists (select 1 from held where permission_key = r.right_key)
  loop
    if v_rule.enforcement = 'enforce' and not v_rule.mitigated then
      raise exception 'sod_violation: %', v_rule.rule_key using errcode = '42501';
    end if;
    insert into public.sa_sod_violations(rule_id, user_id, outcome, details)
    values (v_rule.id, p_target, case when v_rule.mitigated then 'allowed_mitigated' else 'allowed_monitor' end,
            jsonb_build_object('context', 'emergency_access', 'permission_keys', v_keys));
  end loop;

  v_until := now() + make_interval(mins => p_minutes);
  insert into public.sa_emergency_access_grants(user_id, organization_id, permission_keys, reason, status,
    authentication_assurance, requested_at, activated_at, effective_until, granted_by, scope_id, duration_minutes,
    step_up_session_id, step_up_verified_at, request_key)
  values (p_target, p_org, v_keys, v_reason, 'active', 'aal2:totp', now(), now(), v_until, p_actor, p_scope, p_minutes,
    p_step_up_session, v_verified_at, p_request_key)
  returning id into v_id;

  perform public.sa_log_access_change(p_actor, 'emergency_access.granted', p_target, 'sa_emergency_access_grant', v_id::text,
    jsonb_build_object('organization_id', p_org, 'permission_keys', v_keys, 'scope_id', p_scope,
                       'duration_minutes', p_minutes, 'effective_until', v_until,
                       'step_up', 'aal2:totp', 'step_up_verified_at', v_verified_at), v_reason);
  return jsonb_build_object('grant_id', v_id, 'replayed', false, 'status', 'active', 'effective_until', v_until);
end $$;
revoke all on function public.sa_grant_emergency_access(uuid,uuid,uuid,text[],uuid,text,integer,uuid,uuid) from public, anon, authenticated;
grant execute on function public.sa_grant_emergency_access(uuid,uuid,uuid,text[],uuid,text,integer,uuid,uuid) to service_role;

create or replace function public.sa_revoke_emergency_access(p_actor uuid, p_grant uuid, p_reason text)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_g public.sa_emergency_access_grants;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  select * into v_g from public.sa_emergency_access_grants where id = p_grant for update;
  if not found then raise exception 'sa_emergency_grant_not_found'; end if;
  perform public.sa_assert_actor_permission(p_actor, 'security.emergency_access.grant',
    jsonb_build_object('organization_id', v_g.organization_id), public.sa_legacy_is_super_admin(p_actor));
  if length(v_reason) < 5 then raise exception 'sa_reason_required'; end if;
  if length(v_reason) > 500 then raise exception 'sa_note_too_long'; end if;
  if v_g.status <> 'active' or v_g.effective_until <= now() then
    raise exception 'sa_emergency_not_active';
  end if;
  update public.sa_emergency_access_grants
     set status = 'revoked', revoked_at = now(), revoked_by = p_actor, revoke_reason = v_reason
   where id = p_grant;
  perform public.sa_log_access_change(p_actor, 'emergency_access.revoked', v_g.user_id, 'sa_emergency_access_grant', p_grant::text,
    jsonb_build_object('organization_id', v_g.organization_id, 'permission_keys', v_g.permission_keys,
                       'effective_until', v_g.effective_until), v_reason);
end $$;
revoke all on function public.sa_revoke_emergency_access(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.sa_revoke_emergency_access(uuid,uuid,text) to service_role;

-- The old self-service entry point stays closed and is no longer reachable by API roles.
create or replace function public.sa_request_emergency_access(
  p_org uuid, p_permission_keys text[], p_reason text, p_minutes integer)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  raise exception 'emergency_access_use_grant_flow' using errcode = '0A000',
    hint = 'Emergency access is granted by an authorized administrator with MFA step-up (sa_grant_emergency_access).';
end $$;
revoke all on function public.sa_request_emergency_access(uuid,text[],text,integer) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Maintenance: mark elapsed emergency grants expired (body otherwise as in 20260928100000)
-- ---------------------------------------------------------------------------
create or replace function public.sa_governance_maintenance()
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_assignments integer; v_delegations integer; v_requests integer; v_mitigations integer; v_emergency integer;
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
  if v_assignments + v_delegations + v_requests + v_mitigations + v_emergency > 0 then
    perform public.sa_log_access_change(null, 'governance.maintenance', null, 'sa_governance', null,
      jsonb_build_object('assignments_expired', v_assignments, 'delegations_expired', v_delegations,
                         'requests_expired', v_requests, 'mitigations_expired', v_mitigations,
                         'emergency_access_expired', v_emergency), null, 'system');
  end if;
  return jsonb_build_object('assignments_expired', v_assignments, 'delegations_expired', v_delegations,
                            'requests_expired', v_requests, 'mitigations_expired', v_mitigations,
                            'emergency_access_expired', v_emergency);
end $$;
revoke all on function public.sa_governance_maintenance() from public, anon, authenticated;
grant execute on function public.sa_governance_maintenance() to service_role;

-- ---------------------------------------------------------------------------
-- 7. Readiness (no mode change)
-- ---------------------------------------------------------------------------
insert into public.sa_enforcement_readiness(permission_key, route_wiring, database_backstop, intentional_tightening, notes) values
 ('security.emergency_access.grant', true, 'governance_function',
  'Once enforced: granting emergency access needs an explicit grant of this permission (e.g. Security & Access Full Access) instead of the legacy Super Admin rule; every grant additionally needs a fresh TOTP step-up of the granting administrator.',
  'POST /api/security-access/emergency-access decides the permission for the target organization (requireSecurityActor + organization re-decision), verifies AAL2/TOTP freshness from the auth-server-verified JWT, then sa_grant_emergency_access() re-asserts authority (mode-aware), the step-up from auth.sessions/mfa_factors/mfa_amr_claims, ceiling, scope, SoD, self/protected target, duration and idempotency. Revoke → sa_revoke_emergency_access(). No API role can write sa_emergency_access_grants; sa_request_emergency_access is closed. The evaluator consumes active grants (ALLOWED_BY_EMERGENCY_ACCESS) and ignores expired/revoked ones at every decision.')
on conflict (permission_key) do update set route_wiring = excluded.route_wiring, database_backstop = excluded.database_backstop,
  intentional_tightening = excluded.intentional_tightening, notes = excluded.notes;

-- ---------------------------------------------------------------------------
-- 8. Post-conditions
-- ---------------------------------------------------------------------------
do $post$
declare v_t text;
begin
  if not exists (select 1 from public.sa_enforcement_readiness where permission_key = 'security.emergency_access.grant' and route_wiring) then
    raise exception 'postcondition: readiness missing';
  end if;
  foreach v_t in array array['INSERT', 'UPDATE', 'DELETE'] loop
    if has_table_privilege('authenticated', 'public.sa_emergency_access_grants', v_t)
       or has_table_privilege('anon', 'public.sa_emergency_access_grants', v_t)
       or has_table_privilege('service_role', 'public.sa_emergency_access_grants', v_t) then
      raise exception 'postcondition: sa_emergency_access_grants must have no API-role % privilege', v_t;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.sa_grant_emergency_access(uuid,uuid,uuid,text[],uuid,text,integer,uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sa_revoke_emergency_access(uuid,uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sa_request_emergency_access(uuid,text[],text,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sa_evaluate_permission_core(uuid,text,jsonb,boolean,boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sa_assert_fresh_step_up(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.sa_assert_fresh_step_up(uuid,uuid)', 'EXECUTE') then
    raise exception 'postcondition: emergency access functions are service-role only (step-up check internal only)';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname like 'sa\_%' and p.prosecdef
               and not exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) c where c like 'search_path=%pg_temp%')) then
    raise exception 'postcondition: every SECURITY DEFINER sa_* function must pin search_path ending in pg_temp';
  end if;
end $post$;
