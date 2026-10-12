-- ============================================================================
-- Security & Access — One-click Restore of a revoked Group Policy grant
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database,
-- so nothing in this file has been run against a real database (throwaway PostgreSQL 17 with the real S&A migrations:
-- supabase/tests/security/sa_policy_restore/run.sh).
--
-- People & Access → person → Access history: an administrator restores a grant they (or another administrator)
-- revoked, without re-entering the policy, organization, scope or validity. Restore creates a NEW active grant through
-- the ordinary grant pipeline; the revoked grant stays in history exactly as it was.
--
-- What this changes:
--   1. sa_role_assignments.restored_from_assignment_id — the revoked grant a restored grant was created from.
--   2. One LIVE row per (person, policy, membership) instead of one row ever: the table constraint
--      sa_role_assignments_user_id_role_id_membership_id_key becomes the partial unique index
--      sa_role_assignments_live_identity_uidx (status <> 'revoked'). Revoked rows are history and may accumulate.
--      Consequence for ordinary grants too: granting a policy again after a revoke now adds a new row instead of
--      overwriting the revoked one, so Access history keeps every revoked grant.
--      sa_create_assignment_internal_audited's upsert targets that partial index (body otherwise identical to
--      20261020100000). sa_ensure_derived_assignment prefers the live row (body otherwise identical to 20260928110000),
--      so the lifecycle never picks an old revoked row while a live one exists, and never resurrects a revoked row
--      while a live one exists.
--   3. sa_assign_role_audited — the body of sa_assign_role (20261020100000) with a generated-text argument, extra audit
--      details and a per-(person, policy, organization) transaction lock that serializes grants and restores of the
--      same identity. sa_assign_role keeps its signature and becomes a thin wrapper (same behaviour).
--   4. sa_revoke_assignment also records previous_effective_from / previous_effective_until (the validity the revoke
--      cut short), so a restore never has to guess (body otherwise identical to 20261001100000).
--   5. sa_policy_restore_validity / sa_policy_restore_blocker / sa_policy_restore_status (read-only, service_role) and
--      sa_restore_policy_grant (the restore itself, service_role).
--   6. sa_restorable_assignments (automatic access) skips a revoked row that already has a live successor.
--
-- Restore rules (sa_policy_restore_blocker; re-checked inside sa_restore_policy_grant under the row lock):
--   * the row is revoked, administrator-granted (manual / access_request), not a compatibility role and not automatic
--     access an administrator overrode (that keeps its own restore, sa_restore_assignment);
--   * explicitly revoked: its latest status change is assignment.revoked by a user (sa_revoke_assignment). Expiry
--     (maintenance), leaver/mover, access-review revokes and earlier restores are NOT restorable here;
--   * the validity it had when revoked is known and has not ended (a temporary grant whose end has passed must go
--     through Grant Policy — the end date is never silently extended);
--   * no live grant of the same policy for the same person in the same organization, and no newer grant replaced it;
--   * the policy is active and eligible for the organization type; the membership and the person are active; every
--     original scope is still active and inside the membership.
--   Then sa_assign_role_audited applies everything an ordinary grant applies: no self-grant, security.role.assign in
--   the organization, eligibility, duplicate rule, membership, scopes, SoD, and the sensitive-permission / scope
--   authority / eligibility triggers. The CURRENT policy definition applies (assignments reference the policy; no
--   permission snapshot is copied).
--
-- Audit (sa_access_change_log):
--   * on the NEW grant: assignment.granted with details { …, source: 'manual', action_type: 'policy_restore',
--     restored_from_assignment_id, note: null, reason_generated: true } — like every grant;
--   * on the ORIGINAL grant: policy_restore with details { action_type, original_assignment_id, restored_assignment_id,
--     role_id, organization_id, membership_id, scope_ids, effective_from, effective_until }.
--   Actor = the restoring administrator, target = the person, time = occurred_at. A refused restore writes nothing.
--
-- Order: requires 20261020100000_sa_grant_optional_note.sql (and its prerequisites), 20261001100000 and
-- 20261030100000_sa_policy_org_type_eligibility.sql. Repeat-safe. Statements are ordered so the live-identity index
-- exists before any function relies on it and the old constraint is dropped last.
--
-- Rollback: re-run the definitions of sa_assign_role / sa_create_assignment_internal_audited (20261020100000),
-- sa_revoke_assignment / sa_restorable_assignments (20261001100000), sa_ensure_derived_assignment (20260928110000); then
--   drop function if exists public.sa_restore_policy_grant(uuid, uuid);
--   drop function if exists public.sa_policy_restore_status(uuid[]);
--   drop function if exists public.sa_policy_restore_blocker(uuid);
--   drop function if exists public.sa_policy_restore_validity(uuid);
--   drop function if exists public.sa_assign_role_audited(uuid,uuid,uuid,uuid,uuid[],timestamptz,timestamptz,text,text,jsonb);
-- The table constraint can be re-added only while no (person, policy, membership) has more than one row:
--   alter table public.sa_role_assignments add constraint sa_role_assignments_user_id_role_id_membership_id_key
--     unique (user_id, role_id, membership_id);
--   drop index if exists public.sa_role_assignments_live_identity_uidx;
-- restored_from_assignment_id may stay (nullable, unused after rollback).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Lineage column
-- ---------------------------------------------------------------------------
alter table public.sa_role_assignments
  add column if not exists restored_from_assignment_id uuid references public.sa_role_assignments(id) on delete set null;
create index if not exists sa_role_assignments_restored_from_idx
  on public.sa_role_assignments(restored_from_assignment_id) where restored_from_assignment_id is not null;
comment on column public.sa_role_assignments.restored_from_assignment_id is
  'The revoked grant this grant was restored from (Access history → Restore); null for every other grant.';

-- ---------------------------------------------------------------------------
-- 2. One live row per (person, policy, membership). Existing data already satisfies it (the full constraint held).
-- ---------------------------------------------------------------------------
create unique index if not exists sa_role_assignments_live_identity_uidx
  on public.sa_role_assignments(user_id, role_id, membership_id) where status <> 'revoked';

-- Assignment creation (body identical to 20261020100000 except the ON CONFLICT target).
create or replace function public.sa_create_assignment_internal_audited(p_actor uuid, p_user uuid, p_role uuid, p_org uuid, p_scope_ids uuid[],
  p_from timestamptz, p_until timestamptz, p_reason text, p_source text, p_audit jsonb)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $function$
declare
  v_membership uuid;
  v_assignment uuid;
  v_conflict record;
  v_scope_count integer;
begin
  if p_user is null or p_role is null or p_org is null then raise exception 'sa_invalid_assignment'; end if;
  if not exists (select 1 from public.sa_business_roles where id = p_role and status = 'active') then
    raise exception 'sa_role_not_assignable';
  end if;
  if exists (select 1 from public.sa_business_roles where id = p_role and source = 'legacy') and p_source not in ('backfill','derived') then
    raise exception 'sa_compat_role_not_assignable' using hint = 'Compatibility roles are managed by the lifecycle sync.';
  end if;
  select m.id into v_membership from public.sa_organization_memberships m
  where m.user_id = p_user and m.organization_id = p_org and m.status = 'active'
    and (m.effective_until is null or m.effective_until > now())
  order by m.is_primary desc limit 1;
  if v_membership is null then raise exception 'sa_membership_required'; end if;
  if p_source not in ('backfill','derived') and exists (
       select 1 from public.sa_role_assignments a
       where a.user_id = p_user and a.role_id = p_role and a.membership_id = v_membership
         and a.status = 'active' and a.source in ('backfill','derived')
         and (a.effective_until is null or a.effective_until > now())) then
    raise exception 'sa_role_already_held' using hint = 'The person already holds this role automatically.';
  end if;
  if not exists (select 1 from public.users u where u.id = p_user and u.is_active is true) then
    raise exception 'sa_target_inactive';
  end if;
  if coalesce(cardinality(p_scope_ids), 0) = 0 then raise exception 'sa_scope_required'; end if;
  select count(*) into v_scope_count from public.sa_scope_definitions sd
  where sd.id = any(p_scope_ids) and sd.status = 'active'
    and ((sd.organization_id is not null and p_org = any(public.sa_org_ancestry(sd.organization_id)))
      or (sd.organization_id is null and sd.scope_type not in ('organization','warehouse','department','own_record','direct_reports')));
  if v_scope_count <> cardinality(p_scope_ids) then raise exception 'sa_scope_outside_membership'; end if;

  for v_conflict in select * from public.sa_sod_holding_conflicts(p_user, p_role) loop
    if v_conflict.enforcement = 'enforce' and not v_conflict.mitigated then
      raise exception 'sod_violation: %', v_conflict.rule_key using errcode = '42501';
    end if;
    insert into public.sa_sod_violations(rule_id, user_id, outcome, details)
    values (v_conflict.rule_id, p_user, case when v_conflict.mitigated then 'allowed_mitigated' else 'allowed_monitor' end,
            jsonb_build_object('role_id', p_role, 'context', 'assignment'));
  end loop;

  -- Only a LIVE row (not revoked) is updated in place; a revoked row is history and a new row is added beside it.
  insert into public.sa_role_assignments(user_id, role_id, membership_id, status, effective_from, effective_until,
                                         assignment_reason, source, created_by, updated_by)
  values (p_user, p_role, v_membership, 'active', p_from, p_until, p_reason, p_source, p_actor, p_actor)
  on conflict (user_id, role_id, membership_id) where status <> 'revoked' do update set
    status = 'active', effective_from = excluded.effective_from, effective_until = excluded.effective_until,
    assignment_reason = excluded.assignment_reason, source = excluded.source, ended_reason = null,
    updated_at = now(), updated_by = excluded.updated_by
  returning id into v_assignment;
  delete from public.sa_assignment_scopes where assignment_id = v_assignment;
  insert into public.sa_assignment_scopes(assignment_id, scope_id, created_by)
  select v_assignment, unnest(p_scope_ids), p_actor on conflict do nothing;

  perform public.sa_log_access_change(p_actor, 'assignment.granted', p_user, 'sa_role_assignment', v_assignment::text,
    jsonb_build_object('role_id', p_role, 'organization_id', p_org, 'scope_ids', p_scope_ids,
                       'effective_from', p_from, 'effective_until', p_until, 'source', p_source) || coalesce(p_audit, '{}'::jsonb),
    p_reason, case when p_source in ('backfill','derived') then 'system' else 'user' end);
  return v_assignment;
end $function$;
revoke all on function public.sa_create_assignment_internal_audited(uuid,uuid,uuid,uuid,uuid[],timestamptz,timestamptz,text,text,jsonb) from public, anon, authenticated;

-- Lifecycle-owned assignment (body identical to 20260928110000 except: the live row is preferred over revoked history).
create or replace function public.sa_ensure_derived_assignment(
  p_user uuid, p_role uuid, p_membership uuid, p_scope uuid, p_until timestamptz, p_reason text)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid; v_prev record;
begin
  select id, status, effective_until, source into v_prev from public.sa_role_assignments
  where user_id = p_user and role_id = p_role and membership_id = p_membership
  order by (status <> 'revoked') desc, updated_at desc, created_at desc
  limit 1;
  if v_prev.id is null then
    insert into public.sa_role_assignments(user_id, role_id, membership_id, status, effective_until, assignment_reason, source)
    values (p_user, p_role, p_membership, 'active', p_until, p_reason, 'derived') returning id into v_id;
    perform public.sa_log_access_change(null, 'assignment.derived', p_user, 'sa_role_assignment', v_id::text,
      jsonb_build_object('role_id', p_role, 'membership_id', p_membership, 'effective_until', p_until), p_reason, 'system');
  else
    v_id := v_prev.id;
    -- Never resurrect or extend an assignment an administrator ended/granted
    -- manually; only lifecycle-owned rows are maintained here.
    if v_prev.source in ('backfill','derived') then
      update public.sa_role_assignments set status = 'active', ended_reason = null, effective_until = p_until, updated_at = now()
      where id = v_id and (status <> 'active' or effective_until is distinct from p_until);
      if found and v_prev.status <> 'active' then
        perform public.sa_log_access_change(null, 'assignment.derived', p_user, 'sa_role_assignment', v_id::text,
          jsonb_build_object('role_id', p_role, 'membership_id', p_membership, 'reactivated', true), p_reason, 'system');
      end if;
    end if;
  end if;
  insert into public.sa_assignment_scopes(assignment_id, scope_id) values (v_id, p_scope) on conflict do nothing;
  return v_id;
end $$;
revoke all on function public.sa_ensure_derived_assignment(uuid,uuid,uuid,uuid,timestamptz,text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Administrator grant with extra audit details (body of sa_assign_role, 20261020100000)
-- ---------------------------------------------------------------------------
create or replace function public.sa_assign_role_audited(
  p_actor uuid, p_user uuid, p_role uuid, p_org uuid, p_scope_ids uuid[],
  p_from timestamptz, p_until timestamptz, p_reason text, p_generated text, p_audit jsonb)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_note text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_actor = p_user then raise exception 'sa_self_assignment_prohibited' using errcode = '42501'; end if;
  if length(v_note) > 500 then raise exception 'sa_note_too_long'; end if;
  perform public.sa_assert_actor_permission(p_actor, 'security.role.assign',
    jsonb_build_object('organization_id', p_org), public.sa_legacy_is_super_admin(p_actor));
  if not public.sa_profile_applicable(p_role, p_org) then raise exception 'sa_profile_not_applicable'; end if;
  -- Grants and restores of the same person + policy + organization run one at a time, so the duplicate rule below
  -- always sees a concurrent one that committed first.
  perform pg_advisory_xact_lock(hashtextextended('sa_role_identity:' || p_user::text || ':' || p_role::text || ':' || p_org::text, 0));
  -- Identity of a grant = person + policy + membership organization; a second active grant would replace the first's scopes.
  if exists (select 1 from public.sa_role_assignments a join public.sa_organization_memberships m on m.id = a.membership_id
             where a.user_id = p_user and a.role_id = p_role and m.organization_id = p_org and a.status = 'active'
               and (a.effective_until is null or a.effective_until > now())) then
    raise exception 'sa_role_already_held' using hint = 'The person already holds this policy in this organization.';
  end if;
  return public.sa_create_assignment_internal_audited(p_actor, p_user, p_role, p_org, p_scope_ids, p_from, p_until,
    coalesce(v_note, nullif(btrim(coalesce(p_generated, '')), ''), public.sa_grant_description(p_user, p_role, p_org, p_scope_ids, p_until)), 'manual',
    jsonb_build_object('note', v_note, 'reason_generated', v_note is null) || coalesce(p_audit, '{}'::jsonb));
end $$;
revoke all on function public.sa_assign_role_audited(uuid,uuid,uuid,uuid,uuid[],timestamptz,timestamptz,text,text,jsonb) from public, anon, authenticated;

-- Same signature and behaviour as before.
create or replace function public.sa_assign_role(
  p_actor uuid, p_user uuid, p_role uuid, p_org uuid, p_scope_ids uuid[],
  p_from timestamptz, p_until timestamptz, p_reason text)
returns uuid language sql security definer set search_path = pg_catalog, pg_temp as $$
  select public.sa_assign_role_audited(p_actor, p_user, p_role, p_org, p_scope_ids, p_from, p_until, p_reason, null, null)
$$;
revoke all on function public.sa_assign_role(uuid,uuid,uuid,uuid,uuid[],timestamptz,timestamptz,text) from public, anon, authenticated;
grant execute on function public.sa_assign_role(uuid,uuid,uuid,uuid,uuid[],timestamptz,timestamptz,text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Revoke records the validity it cut short (body identical to 20261001100000 otherwise)
-- ---------------------------------------------------------------------------
create or replace function public.sa_revoke_assignment(p_actor uuid, p_assignment uuid, p_reason text)
 returns void
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'pg_temp'
as $function$
declare
  v_a record;
begin
  select a.*, m.organization_id into v_a from public.sa_role_assignments a
  join public.sa_organization_memberships m on m.id = a.membership_id where a.id = p_assignment for update of a;
  if not found then raise exception 'sa_assignment_not_found'; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then raise exception 'sa_reason_required'; end if;
  perform public.sa_assert_actor_permission(p_actor, 'security.role.assign',
    jsonb_build_object('organization_id', v_a.organization_id), public.sa_legacy_is_super_admin(p_actor));
  -- An administrator's decision is final: a lifecycle-owned row becomes
  -- administrator-owned so the lifecycle sync never re-activates it.
  -- sa_restore_assignment can hand it back (previous_source below).
  update public.sa_role_assignments set status = 'revoked', ended_reason = btrim(p_reason),
    source = case when source in ('backfill','derived') then 'manual' else source end,
    effective_until = public.sa_end_at(effective_from, effective_until), updated_at = now(), updated_by = p_actor
  where id = p_assignment and status <> 'revoked';
  perform public.sa_log_access_change(p_actor, 'assignment.revoked', v_a.user_id, 'sa_role_assignment', p_assignment::text,
    jsonb_build_object('role_id', v_a.role_id, 'organization_id', v_a.organization_id, 'previous_source', v_a.source,
                       'previous_status', v_a.status, 'previous_effective_from', v_a.effective_from,
                       'previous_effective_until', v_a.effective_until), btrim(p_reason));
end $function$;

-- Automatic access: a revoked row that already has a live successor is not offered (body otherwise as 20261001100000).
create or replace function public.sa_restorable_assignments()
 returns table(assignment_id uuid, restored_source text)
 language sql
 stable
 security definer
 set search_path to 'pg_catalog', 'pg_temp'
as $function$
  select a.id, public.sa_assignment_overridden_source(a.id)
  from public.sa_role_assignments a
  where a.status = 'revoked' and a.source = 'manual'
    and public.sa_assignment_overridden_source(a.id) is not null
    and not exists (select 1 from public.sa_role_assignments b
                    where b.user_id = a.user_id and b.role_id = a.role_id and b.membership_id = a.membership_id
                      and b.status <> 'revoked')
$function$;
revoke all on function public.sa_restorable_assignments() from public, anon, authenticated;
grant execute on function public.sa_restorable_assignments() to service_role;

-- ---------------------------------------------------------------------------
-- 5. Restore of a revoked administrator grant
-- ---------------------------------------------------------------------------
-- The validity a grant had when it was explicitly revoked. Revokes recorded by this migration carry it in the audit
-- row; for older revokes it is the latest recorded end: the grant's own audit row or a later access-review change.
-- known = false when neither exists (never guessed).
create or replace function public.sa_policy_restore_validity(p_assignment uuid)
returns table(known boolean, effective_from timestamptz, effective_until timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_row record;
  v_revoke jsonb;
  v_until timestamptz;
  v_found boolean := false;
begin
  select a.effective_from into v_row from public.sa_role_assignments a where a.id = p_assignment;
  if not found then return query select false, null::timestamptz, null::timestamptz; return; end if;
  select l.details into v_revoke from public.sa_access_change_log l
  where l.entity_type = 'sa_role_assignment' and l.entity_id = p_assignment::text and l.action = 'assignment.revoked'
  order by l.occurred_at desc limit 1;
  if v_revoke ? 'previous_effective_until' then
    return query select true,
      coalesce(nullif(v_revoke->>'previous_effective_from', '')::timestamptz, v_row.effective_from),
      nullif(v_revoke->>'previous_effective_until', '')::timestamptz;
    return;
  end if;
  select true, x.until into v_found, v_until from (
    select l.occurred_at, nullif(l.details->>'effective_until', '')::timestamptz as until
    from public.sa_access_change_log l
    where l.entity_type = 'sa_role_assignment' and l.entity_id = p_assignment::text and l.action = 'assignment.granted'
    union all
    select l.occurred_at, nullif(l.details->>'new_effective_until', '')::timestamptz
    from public.sa_access_change_log l
    where l.action = 'access_review.modify' and l.details->>'assignment_id' = p_assignment::text
  ) x order by x.occurred_at desc limit 1;
  return query select coalesce(v_found, false), v_row.effective_from, v_until;
end $$;
revoke all on function public.sa_policy_restore_validity(uuid) from public, anon, authenticated;
grant execute on function public.sa_policy_restore_validity(uuid) to service_role;

-- Why a revoked grant cannot be restored right now (null = restorable). Read-only; does not judge the administrator
-- (sa_restore_policy_grant checks authority first).
create or replace function public.sa_policy_restore_blocker(p_assignment uuid)
returns text language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_a record;
  v_u record;
  v_last record;
  v_valid record;
  v_scopes integer;
  v_valid_scopes integer;
begin
  select a.id, a.user_id, a.role_id, a.membership_id, a.status, a.source, a.created_at,
         m.organization_id, m.status as membership_status, m.effective_until as membership_until,
         r.status as role_status, r.source as role_source
    into v_a
  from public.sa_role_assignments a
  join public.sa_organization_memberships m on m.id = a.membership_id
  join public.sa_business_roles r on r.id = a.role_id
  where a.id = p_assignment;
  if not found then return 'sa_assignment_not_found'; end if;
  if v_a.status <> 'revoked' then return 'sa_restore_not_revoked'; end if;
  -- Compatibility roles and administrator-overridden automatic access have their own path (sa_restore_assignment).
  if v_a.role_source = 'legacy' or v_a.source not in ('manual', 'access_request')
     or public.sa_assignment_overridden_source(p_assignment) is not null then
    return 'sa_restore_automatic';
  end if;
  -- Explicitly revoked: the latest status change is an administrator revoke (not expiry, lifecycle, review or a restore).
  select l.action, l.actor_kind into v_last from public.sa_access_change_log l
  where l.entity_type = 'sa_role_assignment' and l.entity_id = p_assignment::text
    and l.action in ('assignment.granted', 'assignment.derived', 'assignment.revoked', 'assignment.restored', 'policy_restore')
  -- Same timestamp (one transaction): a row is granted, then revoked, then restored — never the other way round.
  order by l.occurred_at desc,
           case l.action when 'policy_restore' then 0 when 'assignment.restored' then 1 when 'assignment.revoked' then 2 else 3 end
  limit 1;
  if v_last.action = 'policy_restore' then return 'sa_restore_already_restored'; end if;
  if v_last.action is distinct from 'assignment.revoked' or v_last.actor_kind is distinct from 'user' then
    return 'sa_restore_not_explicit_revoke';
  end if;
  select * into v_valid from public.sa_policy_restore_validity(p_assignment);
  if not v_valid.known then return 'sa_restore_validity_unknown'; end if;
  if v_valid.effective_until is not null and v_valid.effective_until <= now() then return 'sa_restore_validity_expired'; end if;
  -- Already held (any membership in this organization), or replaced by a newer grant of the same identity.
  if exists (select 1 from public.sa_role_assignments b join public.sa_organization_memberships bm on bm.id = b.membership_id
             where b.user_id = v_a.user_id and b.role_id = v_a.role_id and bm.organization_id = v_a.organization_id
               and b.status = 'active' and (b.effective_until is null or b.effective_until > now())) then
    return 'sa_role_already_held';
  end if;
  if exists (select 1 from public.sa_role_assignments b
             where b.user_id = v_a.user_id and b.role_id = v_a.role_id and b.membership_id = v_a.membership_id and b.id <> v_a.id
               and (b.status <> 'revoked' or b.created_at > v_a.created_at)) then
    return 'sa_restore_superseded';
  end if;
  if v_a.role_status <> 'active' then return 'sa_role_not_assignable'; end if;
  if not public.sa_profile_applicable(v_a.role_id, v_a.organization_id) then return 'sa_profile_not_applicable'; end if;
  if v_a.membership_status <> 'active' or (v_a.membership_until is not null and v_a.membership_until <= now()) then
    return 'sa_membership_required';
  end if;
  select is_active, account_scope, employment_status, account_status into v_u from public.users where id = v_a.user_id;
  if not coalesce(v_u.is_active, false) or v_u.account_scope is distinct from 'portal'
     or coalesce(v_u.employment_status, 'active') <> 'active' or v_u.account_status = 'SUSPENDED' then
    return 'sa_target_inactive';
  end if;
  select count(*), count(*) filter (where sd.status = 'active' and (
           (sd.organization_id is not null and v_a.organization_id = any(public.sa_org_ancestry(sd.organization_id)))
           or (sd.organization_id is null and sd.scope_type not in ('organization','warehouse','department','own_record','direct_reports'))))
    into v_scopes, v_valid_scopes
  from public.sa_assignment_scopes s join public.sa_scope_definitions sd on sd.id = s.scope_id
  where s.assignment_id = p_assignment;
  if v_scopes = 0 then return 'sa_scope_required'; end if;
  if v_valid_scopes <> v_scopes then return 'sa_scope_outside_membership'; end if;
  return null;
end $$;
revoke all on function public.sa_policy_restore_blocker(uuid) from public, anon, authenticated;
grant execute on function public.sa_policy_restore_blocker(uuid) to service_role;

-- For the People & Access screen (display only; the restore re-checks everything).
create or replace function public.sa_policy_restore_status(p_assignments uuid[])
returns table(assignment_id uuid, blocker text, effective_from timestamptz, effective_until timestamptz)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select x.id, public.sa_policy_restore_blocker(x.id), v.effective_from, v.effective_until
  from (select distinct unnest(p_assignments) as id) x
  cross join lateral public.sa_policy_restore_validity(x.id) v
  where coalesce(cardinality(p_assignments), 0) <= 500
$$;
revoke all on function public.sa_policy_restore_status(uuid[]) from public, anon, authenticated;
grant execute on function public.sa_policy_restore_status(uuid[]) to service_role;

-- The restore: a NEW grant through the ordinary grant pipeline; the revoked grant is locked, re-checked and left as is.
create or replace function public.sa_restore_policy_grant(p_actor uuid, p_assignment uuid)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_a record;
  v_block text;
  v_valid record;
  v_scope_ids uuid[];
  v_from timestamptz;
  v_new uuid;
  v_new_membership uuid;
begin
  select a.id, a.user_id, a.role_id, a.membership_id, m.organization_id into v_a
  from public.sa_role_assignments a join public.sa_organization_memberships m on m.id = a.membership_id
  where a.id = p_assignment for update of a;
  if not found then raise exception 'sa_assignment_not_found'; end if;
  if p_actor = v_a.user_id then raise exception 'sa_self_assignment_prohibited' using errcode = '42501'; end if;
  -- Authority first: an administrator without it learns nothing about the grant.
  perform public.sa_assert_actor_permission(p_actor, 'security.role.assign',
    jsonb_build_object('organization_id', v_a.organization_id), public.sa_legacy_is_super_admin(p_actor));
  -- Same lock as sa_assign_role_audited: a concurrent grant or restore of this identity waits, then sees this one.
  perform pg_advisory_xact_lock(hashtextextended('sa_role_identity:' || v_a.user_id::text || ':' || v_a.role_id::text || ':' || v_a.organization_id::text, 0));
  v_block := public.sa_policy_restore_blocker(p_assignment);
  if v_block is not null then
    raise exception '%', v_block using hint = 'Use Grant Policy to grant this policy again.';
  end if;
  select * into v_valid from public.sa_policy_restore_validity(p_assignment);
  select array_agg(s.scope_id order by s.scope_id) into v_scope_ids from public.sa_assignment_scopes s where s.assignment_id = p_assignment;
  -- A grant revoked before it started keeps its start; otherwise it starts now. The end is never extended.
  v_from := case when v_valid.effective_from > now() then v_valid.effective_from end;

  v_new := public.sa_assign_role_audited(p_actor, v_a.user_id, v_a.role_id, v_a.organization_id, v_scope_ids,
    v_from, v_valid.effective_until, null,
    format('Restored revoked grant %s. %s', p_assignment,
           public.sa_grant_description(v_a.user_id, v_a.role_id, v_a.organization_id, v_scope_ids, v_valid.effective_until)),
    jsonb_build_object('action_type', 'policy_restore', 'restored_from_assignment_id', p_assignment));

  select membership_id into v_new_membership from public.sa_role_assignments where id = v_new;
  if v_new = p_assignment or v_new_membership is distinct from v_a.membership_id then
    raise exception 'sa_restore_membership_changed' using hint = 'Use Grant Policy to grant this policy again.';
  end if;
  update public.sa_role_assignments set restored_from_assignment_id = p_assignment where id = v_new;

  perform public.sa_log_access_change(p_actor, 'policy_restore', v_a.user_id, 'sa_role_assignment', p_assignment::text,
    jsonb_build_object('action_type', 'policy_restore', 'original_assignment_id', p_assignment, 'restored_assignment_id', v_new,
                       'role_id', v_a.role_id, 'organization_id', v_a.organization_id, 'membership_id', v_a.membership_id,
                       'scope_ids', to_jsonb(v_scope_ids), 'effective_from', v_from, 'effective_until', v_valid.effective_until),
    format('Restored as grant %s', v_new));
  return v_new;
end $$;
revoke all on function public.sa_restore_policy_grant(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sa_restore_policy_grant(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Last: the old one-row-ever constraint (the partial index above replaces it).
-- ---------------------------------------------------------------------------
alter table public.sa_role_assignments drop constraint if exists sa_role_assignments_user_id_role_id_membership_id_key;
