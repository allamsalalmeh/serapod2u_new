-- ============================================================================
-- Security & Access — Grant a Group Policy: optional note instead of a mandatory reason
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database,
-- so nothing in this file has been run against a real database (throwaway PostgreSQL 17 with the real S&A migrations:
-- supabase/tests/security/sa_grant_note/run.sh).
--
-- Confirmed cause of "Grant access stays disabled" (People & Access → Grant a Group Policy): the button required a
-- typed Reason of at least five characters, and sa_assign_role raised sa_reason_required for the same rule. The
-- sentence "You cannot grant access to yourself…" next to the button was static guidance, not a denial.
--
-- What this changes (ordinary administrator grants only):
--   1. sa_assign_role takes p_reason as an OPTIONAL note (blank = none, at most 500 characters, else sa_note_too_long).
--      When no note is given, the assignment and the audit row still carry text: an accurate description generated here,
--        'Group Policy "Security & Access Full Access" granted to supply@dev.com in Serapod Technology Sdn Bhd
--         (scope: Serapod Technology Sdn Bhd (HQ); no end date). No note provided.'
--   2. The audit row (sa_access_change_log, action assignment.granted) records in details
--        { role_id, organization_id, scope_ids, effective_from, effective_until, source, note, reason_generated }
--      note is the administrator's text or null; reason_generated tells a generated description from a user note.
--      Actor, target and time are the row's actor_id / target_user_id / occurred_at, as before. A refused grant rolls
--      back and writes nothing (the authorization engine's own decision log keeps denials).
--   3. sa_create_assignment_internal_audited — the body of sa_create_assignment_internal
--      (20261001130000_sa_grant_keeps_automatic_access.sql) with one extra argument merged into the audit details.
--      sa_create_assignment_internal keeps its signature and becomes a thin wrapper, so every other caller (access
--      request approval, lifecycle sync, provisioning) is unchanged.
--
-- What this does NOT change:
--   * Self-assignment, security.role.assign in the target organization, applicability, the duplicate-grant rule,
--     membership, scope rules, separation of duties and the sensitive-permission grant guard (triggers) — all as before.
--   * Revoke / restore reasons, access-request reasons, Migration Modes reasons (20261019110000) — untouched.
--   * No existing assignment, scope, role or audit row is rewritten.
--
-- Order: requires 20261015100000_sa_initial_policy_same_authority_as_grant.sql (whose sa_assign_role it replaces; it
-- keeps the duplicate-grant rule) and 20261001130000. Independent of 20261019100000 / 20261019110000. Repeat-safe.
--
-- Rollback: re-run the sa_assign_role definition of 20261015100000 and the sa_create_assignment_internal definition of
-- 20261001130000; then
--   drop function if exists public.sa_create_assignment_internal_audited(uuid,uuid,uuid,uuid,uuid[],timestamptz,timestamptz,text,text,jsonb);
--   drop function if exists public.sa_grant_description(uuid,uuid,uuid,uuid[],timestamptz);
-- The application keeps working on rollback: it retries a note-less grant with a server-generated description.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Generated description (used only when no note is given)
-- ---------------------------------------------------------------------------
create or replace function public.sa_grant_description(p_user uuid, p_role uuid, p_org uuid, p_scope_ids uuid[], p_until timestamptz)
returns text language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select format('Group Policy "%s" granted to %s in %s (scope: %s; %s). No note provided.',
    coalesce((select r.name from public.sa_business_roles r where r.id = p_role), p_role::text),
    coalesce((select nullif(u.email, '') from public.users u where u.id = p_user), p_user::text),
    coalesce((select o.org_name from public.organizations o where o.id = p_org), p_org::text),
    coalesce((select string_agg(coalesce(sd.display_name, sd.id::text), ', ' order by sd.display_name)
                from public.sa_scope_definitions sd where sd.id = any(p_scope_ids)), 'none'),
    case when p_until is null then 'no end date'
         else 'until ' || to_char(p_until at time zone 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC' end)
$$;
revoke all on function public.sa_grant_description(uuid,uuid,uuid,uuid[],timestamptz) from public, anon, authenticated;
grant execute on function public.sa_grant_description(uuid,uuid,uuid,uuid[],timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- Assignment creation with extra audit details (body identical to 20261001130000 except p_audit)
-- ---------------------------------------------------------------------------
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

  insert into public.sa_role_assignments(user_id, role_id, membership_id, status, effective_from, effective_until,
                                         assignment_reason, source, created_by, updated_by)
  values (p_user, p_role, v_membership, 'active', p_from, p_until, p_reason, p_source, p_actor, p_actor)
  on conflict (user_id, role_id, membership_id) do update set
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

-- Same signature as before; every existing caller is unchanged.
create or replace function public.sa_create_assignment_internal(p_actor uuid, p_user uuid, p_role uuid, p_org uuid, p_scope_ids uuid[],
  p_from timestamptz, p_until timestamptz, p_reason text, p_source text)
returns uuid language sql security definer set search_path = pg_catalog, pg_temp as $$
  select public.sa_create_assignment_internal_audited(p_actor, p_user, p_role, p_org, p_scope_ids, p_from, p_until, p_reason, p_source, null)
$$;
revoke all on function public.sa_create_assignment_internal(uuid,uuid,uuid,uuid,uuid[],timestamptz,timestamptz,text,text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Administrator grant: optional note (every other rule as in 20261015100000)
-- ---------------------------------------------------------------------------
create or replace function public.sa_assign_role(
  p_actor uuid, p_user uuid, p_role uuid, p_org uuid, p_scope_ids uuid[],
  p_from timestamptz, p_until timestamptz, p_reason text)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_note text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_actor = p_user then raise exception 'sa_self_assignment_prohibited' using errcode = '42501'; end if;
  if length(v_note) > 500 then raise exception 'sa_note_too_long'; end if;
  perform public.sa_assert_actor_permission(p_actor, 'security.role.assign',
    jsonb_build_object('organization_id', p_org), public.sa_legacy_is_super_admin(p_actor));
  if not public.sa_profile_applicable(p_role, p_org) then raise exception 'sa_profile_not_applicable'; end if;
  -- Identity of a grant = person + policy + membership organization; a second active grant would replace the first's scopes.
  if exists (select 1 from public.sa_role_assignments a join public.sa_organization_memberships m on m.id = a.membership_id
             where a.user_id = p_user and a.role_id = p_role and m.organization_id = p_org and a.status = 'active'
               and (a.effective_until is null or a.effective_until > now())) then
    raise exception 'sa_role_already_held' using hint = 'The person already holds this policy in this organization.';
  end if;
  return public.sa_create_assignment_internal_audited(p_actor, p_user, p_role, p_org, p_scope_ids, p_from, p_until,
    coalesce(v_note, public.sa_grant_description(p_user, p_role, p_org, p_scope_ids, p_until)), 'manual',
    jsonb_build_object('note', v_note, 'reason_generated', v_note is null));
end $$;
revoke all on function public.sa_assign_role(uuid,uuid,uuid,uuid,uuid[],timestamptz,timestamptz,text) from public, anon, authenticated;
grant execute on function public.sa_assign_role(uuid,uuid,uuid,uuid,uuid[],timestamptz,timestamptz,text) to service_role;
