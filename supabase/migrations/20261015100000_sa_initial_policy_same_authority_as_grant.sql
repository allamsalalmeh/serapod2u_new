-- ============================================================================
-- S&A: Add User (initial Group Policies) uses the SAME authority checks as Grant Policy
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database,
-- so nothing in this file has been run against a real database.
--
-- Confirmed cause of "Full Access policies cannot be assigned while creating a user":
--   sa_assign_initial_profiles (20261005110000_sa_access_profiles.sql) rejects ANY policy for which sa_profile_sensitive()
--   is true (a permission like security.*, hr.data.reset, finance.data.reset, platform.data.destructive) with
--   sa_profile_sensitive_not_initial. Grant Policy (sa_assign_role) has no such block. For both paths the real authority
--   check is the same and already in the database:
--     * sa_assign_role           -> security.role.assign in the target organization (actor re-checked, no self-assignment)
--     * sa_create_assignment_internal -> membership, scope inside membership, separation of duties
--     * sa_assignment_grant_guard (trigger, 20261009100000) -> a sensitive permission may be granted only by an actor who
--       holds it in the target organization (the existing legacy Super Admin rule is the only exception, as for Grant Policy)
--     * sa_assignment_scope_guard / sa_assignment_scope_eligibility (triggers) -> scope authority and HQ/warehouse eligibility
--   so the blanket block in the Add User path was an extra, older restriction, not a separate authority model.
--
-- What this changes:
--   1. sa_actor_may_assign_profile(actor, role, org) — one read-only predicate with the guard's rule: true for a policy
--      with no sensitive permission, else when the actor holds EVERY sensitive permission of it in `org` (or the existing
--      legacy Super Admin rule). The application calls it to decide which sensitive policies Add User may offer; it also
--      works as the capability probe (the picker offers sensitive policies only where this function exists). The trigger
--      stays the enforcement; this only lets the UI agree with it.
--   2. sa_assign_initial_profiles — the blanket sa_profile_sensitive_not_initial block is removed and replaced by an early,
--      explicit call to the same predicate (error sa_grant_beyond_authority, mapped by the application like Grant Policy).
--      Everything else (scope required, one policy once, at most ten, sa_assign_role per policy) is unchanged.
--   3. sa_assign_role — refuses a second ACTIVE grant of the same policy in the same membership (sa_role_already_held),
--      the identity rule sa_submit_access_request already uses (user + role + membership organization, any source, not
--      expired). Without it sa_create_assignment_internal's upsert would silently REPLACE the scopes of the existing grant
--      (for example an HQ grant replaced by one warehouse). An expired or revoked grant can still be granted again.
--
-- What this does NOT change:
--   * No existing assignment, scope or role is rewritten, deleted or revoked.
--   * No new bypass: the Super Admin exception is the one sa_assignment_grant_guard already applies to Grant Policy.
--   * Policies of Platform & Settings, partner restrictions, applicability, recipient eligibility, ESS (HQ-only) and the
--     scope rules are untouched.
--
-- Rollback: re-run the sa_assign_initial_profiles / sa_assign_role definitions of 20261005110000_sa_access_profiles.sql and
--           drop function if exists public.sa_actor_may_assign_profile(uuid, uuid, uuid);
--
-- How to run (staging first, service role / SQL editor, one statement block at a time is fine; no session temp tables):
--   psql "$DATABASE_URL" -f supabase/migrations/20261015100000_sa_initial_policy_same_authority_as_grant.sql
-- Requires 20261005110000_sa_access_profiles.sql and 20261009100000_sa_group_policies_full_access.sql.
-- ============================================================================

create or replace function public.sa_actor_may_assign_profile(p_actor uuid, p_role uuid, p_org uuid)
returns boolean language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_key text;
begin
  if p_actor is null or p_role is null or p_org is null then return false; end if;
  -- Same rule as sa_assignment_grant_guard (which stays the enforcement).
  if public.sa_legacy_is_super_admin(p_actor) then return true; end if;
  for v_key in
    select p.permission_key from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id
    where rp.role_id = p_role and public.sa_permission_is_sensitive(p.permission_key)
  loop
    if not public.sa_actor_holds_permission(p_actor, v_key, p_org) then return false; end if;
  end loop;
  return true;
end
$fn$;
revoke all on function public.sa_actor_may_assign_profile(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.sa_actor_may_assign_profile(uuid, uuid, uuid) to service_role;
comment on function public.sa_actor_may_assign_profile(uuid, uuid, uuid) is
  'May this actor grant this policy in this organization with respect to its sensitive permissions? Mirrors sa_assignment_grant_guard; read-only; service role only. Existence also signals that Add User may offer sensitive policies.';

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
    -- Same authority as Grant Policy: a sensitive policy only for an actor who holds its sensitive permissions here.
    if not public.sa_actor_may_assign_profile(p_actor, v_role, p_org) then
      raise exception 'sa_grant_beyond_authority' using errcode = '42501',
        hint = 'An administrator can grant a sensitive permission only while holding it in that organization.';
    end if;
    v_ids := v_ids || public.sa_assign_role(p_actor, p_user, v_role, p_org, v_scopes, now(), null,
      coalesce(nullif(btrim(v_item->>'reason'), ''), 'Initial access at provisioning'));
  end loop;
  return v_ids;
end $$;
revoke all on function public.sa_assign_initial_profiles(uuid,uuid,uuid,jsonb,boolean) from public, anon, authenticated;
grant execute on function public.sa_assign_initial_profiles(uuid,uuid,uuid,jsonb,boolean) to service_role;

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
  -- Identity of a grant = person + policy + membership organization. A second active grant would REPLACE the scopes of the
  -- first (upsert in sa_create_assignment_internal); never silently: the existing grant is changed only by revoking it.
  if exists (select 1 from public.sa_role_assignments a join public.sa_organization_memberships m on m.id = a.membership_id
             where a.user_id = p_user and a.role_id = p_role and m.organization_id = p_org and a.status = 'active'
               and (a.effective_until is null or a.effective_until > now())) then
    raise exception 'sa_role_already_held' using hint = 'The person already holds this policy in this organization.';
  end if;
  return public.sa_create_assignment_internal(p_actor, p_user, p_role, p_org, p_scope_ids, p_from, p_until, btrim(p_reason), 'manual');
end $$;
revoke all on function public.sa_assign_role(uuid,uuid,uuid,uuid,uuid[],timestamptz,timestamptz,text) from public, anon, authenticated;
grant execute on function public.sa_assign_role(uuid,uuid,uuid,uuid,uuid[],timestamptz,timestamptz,text) to service_role;
