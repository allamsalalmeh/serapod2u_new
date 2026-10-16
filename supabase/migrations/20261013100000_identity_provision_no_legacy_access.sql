-- Identity provisioning: create an account WITHOUT a legacy role/level (UNAPPLIED — review, then apply deliberately).
--
-- Why: Add New User no longer asks for a legacy role/level. users.role_code is NOT NULL, and when the payload omits it
-- identity_provision falls back to identity_baseline_role_code() = 'USER' for non-consumers. USER is a staff-level
-- compatibility classification (sa_refresh_compat_role generates compatibility grants for it while
-- legacy_authorization.read_only = false), so "omit the field" would silently create privileged access.
--
-- Change (narrow, backward compatible):
--   1. identity_provision accepts payload.no_legacy_access = true. The account then gets the existing no-authority
--      classification GUEST (already used for HR onboarding; sa_refresh_compat_role never creates a compatibility role for
--      it). It is rejected together with an explicit legacy_role_code, and when no active GUEST role exists. Every other
--      behaviour (authorization, identity resolution, HR facts, lifecycle membership, initial Group Policies, audit) is
--      unchanged from 20261005110000_sa_access_profiles.sql; callers that do not send the flag are unaffected.
--   2. identity_provision_capabilities() lets the server confirm the support exists BEFORE it creates a login, so an
--      environment without this migration fails closed instead of creating a USER account.
--
-- Not changed: existing users and their role_code, grants, access modes, organization hierarchy. Nothing is backfilled.
-- Known side effect (unchanged by this migration): the lifecycle still gives every membership the employee-self-service
-- baseline, and reporting views that count GUEST users inside a SHOP organization as shop consumers will list such accounts.
--
-- Rollback: re-run the identity_provision definition from 20261005110000_sa_access_profiles.sql and
--           drop function if exists public.identity_provision_capabilities();
-- Requires 20261005110000_sa_access_profiles.sql. No session temp tables.

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
  v_no_legacy boolean := coalesce((p_payload->>'no_legacy_access')::boolean, false);
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
  -- no_legacy_access (ordinary Add User): the no-authority GUEST classification for every principal type, never the
  -- staff-level USER baseline. It cannot be combined with an explicit legacy role, so it is not an escalation path.
  if v_no_legacy then
    if nullif(p_payload->>'legacy_role_code', '') is not null then
      raise exception 'identity_legacy_role_conflict' using errcode = '22023';
    end if;
    if not exists (select 1 from public.roles r where r.role_code = 'GUEST' and r.is_active is not false) then
      raise exception 'identity_no_legacy_role_unavailable' using errcode = '22023';
    end if;
    v_baseline := 'GUEST';
  end if;
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

create or replace function public.identity_provision_capabilities()
returns jsonb language sql immutable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object('no_legacy_access', true)
$$;
revoke all on function public.identity_provision_capabilities() from public, anon, authenticated;
grant execute on function public.identity_provision_capabilities() to service_role;
