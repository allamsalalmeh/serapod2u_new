-- ============================================================================
-- Employee Self Service baseline is HQ-only (Add User: ESS by default for HQ staff)
-- ----------------------------------------------------------------------------
-- UNAPPLIED. sa_sync_user_lifecycle (definition of 20260929190000) derived the employee-self-service baseline for every
-- enterprise membership, including Manufacturer, Distributor and Shop accounts. This redefinition derives a NEW baseline
-- only when the user's organization is HQ. Existing baseline rows are still maintained as before: no backfill, no revoke,
-- no change to existing users. The only change is the baseline block; everything else is copied verbatim.
--
-- ESS stays a normal derived assignment on the user's own_record scope (the canonical mechanism); an administrator who
-- excludes it for a non-employee HQ account revokes it with sa_revoke_assignment (audited, converts the row to 'manual',
-- so this sync never resurrects it, and it is restorable through sa_restore_assignment).
--
-- Idempotent (create or replace). Grants unchanged (service_role only).
-- Rollback: re-run the sa_sync_user_lifecycle definition from 20260929190000.
-- ============================================================================

create or replace function public.sa_sync_user_lifecycle(p_user uuid, p_trigger text default 'manual')
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  u record;
  v_enterprise boolean;
  v_employed boolean;
  v_changes jsonb := '[]'::jsonb;
  v_count integer;
  v_membership uuid;
  v_org_type text;
  v_compat_role uuid;
  v_baseline_role uuid;
  v_org_scope uuid;
  v_self_scope uuid;
  v_until timestamptz;
  v_contract_end date;
begin
  if not public.sa_setting_bool('lifecycle.sync_enabled', true) then
    return jsonb_build_object('status', 'disabled');
  end if;
  select id, is_active, employment_status, account_scope, organization_id, role_code, employment_type, account_status
    into u from public.users where id = p_user;
  if not found then return jsonb_build_object('status', 'no_user'); end if;

  v_enterprise := u.account_scope = 'portal' and u.organization_id is not null;
  v_employed := coalesce(u.is_active, false) and coalesce(u.employment_status, 'active') = 'active';

  -- SUSPENDED (Identity Stage 2): a temporary hold. Business access is
  -- suspended, not revoked, and restored exactly on reactivation (including
  -- administrator-granted roles). Delegations are revoked (they are
  -- time-bound grants to act for someone else).
  if v_enterprise and u.account_status = 'SUSPENDED' and coalesce(u.employment_status, 'active') = 'active' then
    with x as (
      update public.sa_role_assignments set status = 'suspended', updated_at = now()
      where user_id = p_user and status = 'active' returning id)
    select count(*) into v_count from x;
    if v_count > 0 then v_changes := v_changes || jsonb_build_object('assignments_suspended', v_count); end if;
    with x as (
      update public.sa_organization_memberships set status = 'suspended', updated_at = now()
      where user_id = p_user and status = 'active' returning id)
    select count(*) into v_count from x;
    if v_count > 0 then v_changes := v_changes || jsonb_build_object('memberships_suspended', v_count); end if;
    with x as (
      update public.sa_delegations set status = 'revoked', revoked_at = now(), revoke_reason = 'lifecycle: suspended'
      where (delegator_id = p_user or delegate_id = p_user) and status = 'active' returning id)
    select count(*) into v_count from x;
    if v_count > 0 then v_changes := v_changes || jsonb_build_object('delegations_revoked', v_count); end if;
    if jsonb_array_length(v_changes) > 0 then
      perform public.sa_log_access_change(null, 'lifecycle.suspended', p_user, 'user', p_user::text,
        jsonb_build_object('trigger', p_trigger, 'changes', v_changes), null, 'system');
    end if;
    return jsonb_build_object('status', 'suspended', 'changes', v_changes);
  end if;

  -- LEAVER (or no longer an enterprise identity): end every business
  -- relationship. Consumer relationships live elsewhere and are untouched.
  if not (v_enterprise and v_employed) then
    with x as (
      update public.sa_role_assignments set status = 'revoked',
        ended_reason = 'leaver:' || coalesce(u.employment_status, 'inactive'),
        effective_until = public.sa_end_at(effective_from, effective_until), updated_at = now()
      where user_id = p_user and status in ('active', 'suspended') returning id)
    select count(*) into v_count from x;
    if v_count > 0 then v_changes := v_changes || jsonb_build_object('assignments_revoked', v_count); end if;

    with x as (
      update public.sa_organization_memberships set status = 'inactive',
        ended_reason = 'leaver:' || coalesce(u.employment_status, 'inactive'),
        effective_until = public.sa_end_at(effective_from, effective_until),
        is_primary = false, updated_at = now()
      where user_id = p_user and status in ('active', 'suspended') returning id)
    select count(*) into v_count from x;
    if v_count > 0 then v_changes := v_changes || jsonb_build_object('memberships_ended', v_count); end if;

    with x as (
      update public.sa_delegations set status = 'revoked', revoked_at = now(), revoke_reason = 'lifecycle: leaver'
      where (delegator_id = p_user or delegate_id = p_user) and status = 'active' returning id)
    select count(*) into v_count from x;
    if v_count > 0 then v_changes := v_changes || jsonb_build_object('delegations_revoked', v_count); end if;

    with x as (
      update public.sa_access_requests set status = 'cancelled', updated_at = now(),
        decision_reason = 'lifecycle: leaver'
      where (target_user_id = p_user or requester_id = p_user) and status = 'requested' returning id)
    select count(*) into v_count from x;
    if v_count > 0 then v_changes := v_changes || jsonb_build_object('requests_cancelled', v_count); end if;

    update public.sa_emergency_access_grants set status = 'revoked'
    where user_id = p_user and status in ('requested','active');

    if jsonb_array_length(v_changes) > 0 then
      perform public.sa_log_access_change(null, 'lifecycle.leaver', p_user, 'user', p_user::text,
        jsonb_build_object('trigger', p_trigger, 'employment_status', u.employment_status, 'is_active', u.is_active,
                           'account_scope', u.account_scope, 'changes', v_changes), null, 'system');
    end if;
    return jsonb_build_object('status', 'leaver', 'changes', v_changes);
  end if;

  -- RESTORE after a suspension: exactly what was suspended comes back
  -- (expired assignments stay ended).
  with x as (
    update public.sa_organization_memberships set status = 'active', updated_at = now()
    where user_id = p_user and status = 'suspended' returning id)
  select count(*) into v_count from x;
  if v_count > 0 then v_changes := v_changes || jsonb_build_object('memberships_restored', v_count); end if;
  with x as (
    update public.sa_role_assignments set status = 'active', updated_at = now()
    where user_id = p_user and status = 'suspended' and (effective_until is null or effective_until > now()) returning id)
  select count(*) into v_count from x;
  if v_count > 0 then v_changes := v_changes || jsonb_build_object('assignments_restored', v_count); end if;

  -- MOVER: lifecycle-owned memberships in another organization end, together
  -- with every assignment on them; delegations involving the user are
  -- revoked (re-evaluation of authority in the new context).
  with ended as (
    update public.sa_organization_memberships set status = 'inactive', ended_reason = 'mover',
      effective_until = public.sa_end_at(effective_from, effective_until), is_primary = false, updated_at = now()
    where user_id = p_user and status = 'active' and source in ('backfill','derived')
      and organization_id <> u.organization_id
    returning id)
  select count(*) into v_count from ended;
  if v_count > 0 then
    update public.sa_role_assignments a set status = 'revoked', ended_reason = 'mover',
      effective_until = public.sa_end_at(a.effective_from, a.effective_until), updated_at = now()
    where a.user_id = p_user and a.status = 'active'
      and a.membership_id in (select m.id from public.sa_organization_memberships m
                              where m.user_id = p_user and m.status = 'inactive' and m.ended_reason = 'mover');
    update public.sa_delegations set status = 'revoked', revoked_at = now(), revoke_reason = 'lifecycle: mover'
    where (delegator_id = p_user or delegate_id = p_user) and status = 'active';
    v_changes := v_changes || jsonb_build_object('mover_memberships_ended', v_count);
  end if;

  -- JOINER / current organization membership.
  select id into v_membership from public.sa_organization_memberships
  where user_id = p_user and organization_id = u.organization_id
  order by (status = 'active') desc, is_primary desc limit 1;
  update public.sa_organization_memberships set is_primary = false
  where user_id = p_user and is_primary and (v_membership is null or id <> v_membership);
  if v_membership is null then
    insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status, source)
    values (p_user, u.organization_id, 'employee', true, 'active', 'derived') returning id into v_membership;
    v_changes := v_changes || jsonb_build_object('membership_created', u.organization_id);
  else
    update public.sa_organization_memberships set status = 'active', is_primary = true, ended_reason = null,
      effective_until = null, updated_at = now()
    where id = v_membership and (status <> 'active' or not is_primary or effective_until is not null);
    if found then v_changes := v_changes || jsonb_build_object('membership_reactivated', u.organization_id); end if;
  end if;

  -- Temporary workers: mandatory expiry.
  if u.employment_type in ('Contract','Intern') then
    select max(c.expiry_date) into v_contract_end from public.hr_contracts c
    where c.employee_user_id = p_user and c.status = 'active' and c.expiry_date >= current_date;
    v_until := coalesce((v_contract_end + 1)::timestamptz,
                        date_trunc('day', now()) + make_interval(days => public.sa_setting_int('lifecycle.contractor_default_expiry_days', 90)));
  else
    v_until := null;
  end if;

  select org_type_code into v_org_type from public.organizations where id = u.organization_id;
  v_org_scope := public.sa_ensure_scope_internal(u.organization_id,
    case when v_org_type = 'WH' then 'warehouse' else 'organization' end,
    u.organization_id::text, coalesce((select org_name from public.organizations where id = u.organization_id), u.organization_id::text),
    jsonb_build_object('source', 'lifecycle', 'org_type_code', v_org_type));
  v_self_scope := public.sa_ensure_scope_internal(u.organization_id, 'own_record', 'self', 'Own record',
    jsonb_build_object('source', 'lifecycle'));

  -- Compatibility role for the legacy role code (explicit, removable grants).
  -- Once Security & Access is the only writable authorization source
  -- (legacy_authorization.read_only), a legacy role code no longer grants
  -- anything: new access comes only from S&A assignments or approved access
  -- requests, and a role-code change only removes obsolete compatibility
  -- access (below). This neutralises role_code as an escalation path.
  v_compat_role := case when public.sa_setting_bool('legacy_authorization.read_only', false)
                        then (select id from public.sa_business_roles where role_key = public.sa_compat_role_key(u.role_code)
                              and exists (select 1 from public.sa_role_assignments a where a.role_id = sa_business_roles.id
                                          and a.user_id = p_user and a.status = 'active' and a.source in ('backfill','derived')))
                        else public.sa_refresh_compat_role(u.role_code, true) end;
  if v_compat_role is not null then
    perform public.sa_ensure_derived_assignment(p_user, v_compat_role, v_membership, v_org_scope, v_until,
      'Lifecycle: compatibility role for legacy ' || u.role_code);
  end if;
  -- MOVER (role change): end lifecycle-owned compatibility assignments for
  -- other role codes.
  with x as (
    update public.sa_role_assignments a set status = 'revoked', ended_reason = 'mover:role_change',
      effective_until = public.sa_end_at(a.effective_from, a.effective_until), updated_at = now()
    from public.sa_business_roles br
    where a.role_id = br.id and br.source = 'legacy' and a.user_id = p_user and a.status = 'active'
      and a.source in ('backfill','derived') and (v_compat_role is null or a.role_id <> v_compat_role)
    returning a.id)
  select count(*) into v_count from x;
  if v_count > 0 then v_changes := v_changes || jsonb_build_object('role_change_revoked', v_count); end if;

  -- Baseline: employee self-service on the employee's own record.
  select id into v_baseline_role from public.sa_business_roles where role_key = 'employee-self-service' and status = 'active';
  -- ESS is HQ-only. A NEW baseline is derived only for an HQ organization; a row that already exists (any organization,
  -- any status) keeps being maintained exactly as before, so existing users and their access are unchanged (no backfill,
  -- nothing is revoked here). An administrator-revoked row is administrator-owned and is never resurrected.
  if v_baseline_role is not null and (
       v_org_type = 'HQ'
       or exists (select 1 from public.sa_role_assignments a
                  where a.user_id = p_user and a.role_id = v_baseline_role and a.membership_id = v_membership)) then
    perform public.sa_ensure_derived_assignment(p_user, v_baseline_role, v_membership, v_self_scope, v_until,
      'Lifecycle: employee self-service baseline');
  end if;

  -- Contract end date changes flow into lifecycle-owned assignments.
  update public.sa_role_assignments set effective_until = v_until, updated_at = now()
  where user_id = p_user and membership_id = v_membership and status = 'active'
    and source in ('backfill','derived') and effective_until is distinct from v_until;

  if jsonb_array_length(v_changes) > 0 then
    perform public.sa_log_access_change(null,
      case when v_changes::text like '%mover%' or v_changes::text like '%role_change%' then 'lifecycle.mover' else 'lifecycle.joiner' end,
      p_user, 'user', p_user::text,
      jsonb_build_object('trigger', p_trigger, 'organization_id', u.organization_id, 'role_code', u.role_code,
                         'employment_type', u.employment_type, 'effective_until', v_until, 'changes', v_changes), null, 'system');
  end if;
  return jsonb_build_object('status', 'active', 'membership_id', v_membership, 'effective_until', v_until, 'changes', v_changes);
end $$;
revoke all on function public.sa_sync_user_lifecycle(uuid,text) from public, anon, authenticated;
grant execute on function public.sa_sync_user_lifecycle(uuid,text) to service_role;

do $$
begin
  if position('v_org_type = ''HQ''' in pg_get_functiondef('public.sa_sync_user_lifecycle(uuid,text)'::regprocedure)) = 0
     or position('lifecycle.suspended' in pg_get_functiondef('public.sa_sync_user_lifecycle(uuid,text)'::regprocedure)) = 0 then
    raise exception 'postcondition: HQ-only ESS lifecycle not installed';
  end if;
  if has_function_privilege('authenticated', 'public.sa_sync_user_lifecycle(uuid,text)', 'EXECUTE') then
    raise exception 'postcondition: lifecycle must stay service-role only';
  end if;
end $$;
