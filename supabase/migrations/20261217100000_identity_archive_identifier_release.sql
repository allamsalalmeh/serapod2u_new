-- ============================================================================
-- Archive & Revoke Access, and controlled email/phone release
-- (the ongoing lifecycle for former users; complements 20261216100000)
-- ----------------------------------------------------------------------------
-- Decision (owner, 2026-10-24) — supersedes "archive keeps identifiers
-- reserved forever" (20260929160000) with a CONTROLLED release:
--   * the user UUID is the immutable historical identity key: an archived
--     identity keeps its public.users row (name, organization, employee
--     number), so every foreign key and every name lookup in Supply Chain,
--     Finance, HR, S&A and audit history is unchanged;
--   * archiving revokes login and access; releasing the email/phone lets a
--     genuinely NEW person register them with a NEW UUID;
--   * a returning same person is REACTIVATED (identifiers restored), never
--     silently re-created; a new person using a released identifier needs an
--     explicit "new person" decision by an administrator.
--
-- Audit (before this migration)
--   * Archive = identity_set_account_status(...,'ARCHIVED'): account_status,
--     is_active=false; the users trigger runs sa_sync_user_lifecycle (leaver):
--     S&A assignments revoked with an end date, memberships inactive,
--     delegations/requests/emergency grants revoked — history kept.
--     sa_evaluate_permission_core denies inactive actors (ACCOUNT_INACTIVE).
--   * The login ban was a best-effort GoTrue call AFTER the database change
--     (provisioning.ts); sessions and refresh tokens were never revoked, so an
--     existing session kept working until its tokens expired; recovery /
--     magic-link tokens stayed valid.
--   * Email/phone stayed on public.users and auth.users; identity_resolve
--     reported IDENTITY_ARCHIVED, so nobody else could ever use them.
--   * HR: the employment anchor kept onboarding_status/status, so an archived
--     person still appeared under Onboarded or Awaiting onboarding.
--
-- What this migration adds
--   identity_archive_preview / identity_archive_execute   (Archive & Revoke Access)
--   identity_release_identifiers                          (release for an archived identity)
--   identity_identifier_releases                          (restricted snapshot of released values)
--   identity_lifecycle_actions                            (append-only record of archives/releases, incl. blocked)
--   identity_revoke_login(uuid)                           (ban + sessions + refresh/one-time tokens, in SQL)
--   identity_resolve       → IDENTITY_PREVIOUSLY_RELEASED instead of NO_MATCH for a released identifier
--   identity_set_account_status → reactivating an archived identity restores released identifiers
--                                 (fails closed if someone else owns them now) and lifts the ban
--
-- Login revocation (verified on the self-hosted GoTrue schema): in the same
-- transaction as the status change — auth.users.banned_until (+100 years,
-- what the admin API sets for 876000h), recovery/confirmation/email-change/
-- reauthentication tokens cleared, auth.sessions deleted (their refresh
-- tokens cascade; session-less refresh tokens deleted by user_id),
-- auth.one_time_tokens deleted, unused application OTP codes invalidated. A
-- JWT whose session no longer exists is refused by GoTrue /user, which every
-- request goes through (middleware + route handlers).
--
-- Identifier release: public.users.email (NOT NULL, unique) becomes the
-- unique non-deliverable placeholder archived+<uuid>@released.invalid
-- (RFC 2606 .invalid), phone NULL; auth.users email/phone likewise, password
-- cleared, provider identities (auth.identities) deleted so no OAuth account
-- can sign in to it. The original values are kept only in
-- identity_identifier_releases (RLS on, no API role access). full_name,
-- employee number and organization are never changed.
--
-- Authorization: identity_deletion_authorize (20261216100000) — explicit
-- platform.identity.delete in the target's organization (+ hr.employee.delete
-- from HR), no delegation; then identity_set_account_status re-asserts
-- platform.identity.delete and Root protections. Protections: own account,
-- Root Access holder, Super Admin (unless actor is Super Admin/Root), target
-- the actor does not dominate, last active HQ administrator. Not tied to HR
-- go-live: archival is the standard lifecycle.
--
-- Prerequisites: 20261216100000 (identity_deletion_authorize /
-- identity_deletion_actor_blockers), 20261027100000 (identity_root_target_refusal),
-- 20261214100000. Idempotent: yes. Grants nothing; no migration mode change.
-- Apply manually (SQL editor / psql) as the database owner.
--
-- Rollback (reverse order): re-run identity_resolve and identity_set_account_status
-- from the version before this file (staging schema 2026-10-22 / 20261027100000);
-- drop identity_archive_execute, identity_archive_preview, identity_archive_plan,
-- identity_release_identifiers, identity_release_internal, identity_restore_released_identifiers,
-- identity_revoke_login, identity_released_placeholder_email; keep the two tables (audit).
-- Released identities stay released (their originals are in identity_identifier_releases).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Prerequisites
-- ---------------------------------------------------------------------------
do $pre$
begin
  if to_regprocedure('public.identity_deletion_authorize(uuid,uuid,text)') is null
     or to_regprocedure('public.identity_deletion_actor_blockers(uuid,jsonb)') is null then
    raise exception 'identity_prerequisite_missing: permanent identity deletion (20261216100000)';
  end if;
  if to_regprocedure('public.identity_set_account_status(uuid,uuid,text,text)') is null
     or to_regprocedure('public.identity_root_target_refusal(uuid,uuid)') is null
     or to_regprocedure('public.identity_resolve(text,text)') is null
     or to_regprocedure('public.identity_normalize_email(text)') is null
     or to_regprocedure('public.identity_normalize_phone(text)') is null then
    raise exception 'identity_prerequisite_missing: identity foundation / Root target protection (20261027100000)';
  end if;
  if to_regclass('auth.sessions') is null or to_regclass('auth.refresh_tokens') is null
     or to_regclass('auth.one_time_tokens') is null or to_regclass('auth.identities') is null then
    raise exception 'identity_prerequisite_missing: GoTrue auth schema (sessions, refresh_tokens, one_time_tokens, identities)';
  end if;
  if not has_table_privilege(current_user, 'auth.users', 'UPDATE') or not has_table_privilege(current_user, 'auth.sessions', 'DELETE') then
    raise exception 'identity_prerequisite_missing: % cannot change auth.users / auth.sessions (run as the database owner)', current_user;
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.identity_identifier_releases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete restrict,
  email text,
  email_normalized text,
  phone text,
  released_at timestamptz not null default now(),
  released_by uuid not null,
  reason text not null,
  request_id uuid not null,
  restored_at timestamptz,
  restored_by uuid
);
create unique index if not exists identity_identifier_releases_open_uniq on public.identity_identifier_releases (user_id) where restored_at is null;
create index if not exists identity_identifier_releases_email_idx on public.identity_identifier_releases (email_normalized) where restored_at is null;
create index if not exists identity_identifier_releases_phone_idx on public.identity_identifier_releases (phone) where restored_at is null;
alter table public.identity_identifier_releases enable row level security;
revoke all on table public.identity_identifier_releases from public, anon, authenticated, service_role;
comment on table public.identity_identifier_releases is
  'Original email/phone of archived identities whose identifiers were released for reuse (restricted: no API role access). restored_at is set when the same person is reactivated.';

create or replace function public.identity_identifier_releases_guard()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $fn$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then raise exception 'identity_release_record_append_only' using errcode = '42501'; end if;
  -- only the one-time restoration may change a row
  if old.restored_at is null and new.restored_at is not null
     and (to_jsonb(new) - 'restored_at' - 'restored_by') = (to_jsonb(old) - 'restored_at' - 'restored_by') then
    return new;
  end if;
  raise exception 'identity_release_record_append_only' using errcode = '42501';
end $fn$;
revoke all on function public.identity_identifier_releases_guard() from public, anon, authenticated, service_role;
drop trigger if exists identity_identifier_releases_guard on public.identity_identifier_releases;
create trigger identity_identifier_releases_guard before update or delete on public.identity_identifier_releases
for each row execute function public.identity_identifier_releases_guard();
drop trigger if exists identity_identifier_releases_no_truncate on public.identity_identifier_releases;
create trigger identity_identifier_releases_no_truncate before truncate on public.identity_identifier_releases
for each statement execute function public.identity_identifier_releases_guard();

create table if not exists public.identity_lifecycle_actions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  action text not null check (action in ('archive','release')),
  actor_id uuid not null,
  target_user_id uuid not null,
  entry_point text not null check (entry_point in ('user_management','hr')),
  organization_id uuid,
  status text not null check (status in ('completed','blocked')),
  reason text not null,
  blockers jsonb not null default '[]'::jsonb,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists identity_lifecycle_actions_target_idx on public.identity_lifecycle_actions (target_user_id, created_at desc);
alter table public.identity_lifecycle_actions enable row level security;
revoke all on table public.identity_lifecycle_actions from public, anon, authenticated, service_role;
comment on table public.identity_lifecycle_actions is
  'Archive & Revoke Access and identifier releases (completed and blocked), with who, whom, why and what changed. Append-only.';
drop trigger if exists identity_lifecycle_actions_append_only on public.identity_lifecycle_actions;
create trigger identity_lifecycle_actions_append_only before update or delete on public.identity_lifecycle_actions
for each row execute function public.hr_reject_append_only();
drop trigger if exists identity_lifecycle_actions_no_truncate on public.identity_lifecycle_actions;
create trigger identity_lifecycle_actions_no_truncate before truncate on public.identity_lifecycle_actions
for each statement execute function public.hr_reject_append_only();

-- A decision on a released identifier is recorded like any other resolution outcome.
do $c$
declare v_def text;
begin
  select pg_get_constraintdef(oid) into v_def from pg_constraint
  where conrelid = 'public.identity_conflicts'::regclass and conname = 'identity_conflicts_conflict_code_check';
  if v_def is not null and v_def not like '%IDENTITY_PREVIOUSLY_RELEASED%' then
    alter table public.identity_conflicts drop constraint identity_conflicts_conflict_code_check;
    alter table public.identity_conflicts add constraint identity_conflicts_conflict_code_check check (conflict_code = any (array[
      'IDENTITY_CONFLICT','IDENTITY_AMBIGUOUS_EMAIL','IDENTITY_AMBIGUOUS_PHONE','IDENTITY_VERIFICATION_REQUIRED','IDENTITY_ARCHIVED',
      'IDENTITY_INACTIVE','IDENTITY_PRINCIPAL_UPGRADE_REQUIRED','IDENTITY_ORG_MOVE_REQUIRED','IDENTITY_PREVIOUSLY_RELEASED']));
  end if;
end $c$;

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------
create or replace function public.identity_released_placeholder_email(p_user uuid)
returns text language sql immutable set search_path = pg_catalog, pg_temp as $fn$
  select 'archived+' || replace(p_user::text, '-', '') || '@released.invalid'
$fn$;
revoke all on function public.identity_released_placeholder_email(uuid) from public, anon;
grant execute on function public.identity_released_placeholder_email(uuid) to authenticated, service_role;

-- Ends every way the login can be used, inside the caller's transaction.
create or replace function public.identity_revoke_login(p_user uuid)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_sessions integer; v_refresh integer; v_tokens integer; v_codes integer := 0;
begin
  update auth.users set banned_until = now() + interval '100 years',
         recovery_token = '', confirmation_token = '', email_change_token_new = '', email_change_token_current = '',
         reauthentication_token = '', updated_at = now()
   where id = p_user;
  delete from auth.sessions where user_id = p_user;
  get diagnostics v_sessions = row_count;
  delete from auth.refresh_tokens where user_id = p_user::text;
  get diagnostics v_refresh = row_count;
  delete from auth.one_time_tokens where user_id = p_user;
  get diagnostics v_tokens = row_count;
  if to_regclass('public.auth_verification_codes') is not null then
    update public.auth_verification_codes set invalidated_at = now()
     where user_id = p_user and used_at is null and invalidated_at is null;
    get diagnostics v_codes = row_count;
  end if;
  return jsonb_build_object('sessions_revoked', v_sessions, 'refresh_tokens_revoked', v_refresh,
                            'one_time_tokens_revoked', v_tokens, 'otp_codes_invalidated', v_codes);
end $fn$;
revoke all on function public.identity_revoke_login(uuid) from public, anon, authenticated, service_role;

-- Release (no authorization: callers decide). Requires an archived identity.
create or replace function public.identity_release_internal(p_actor uuid, p_user uuid, p_reason text, p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $fn$
declare u record; v_placeholder text := public.identity_released_placeholder_email(p_user); v_identities integer;
begin
  select pu.email, pu.email_normalized, pu.phone, pu.account_status into u from public.users pu where pu.id = p_user for update;
  if not found then raise exception 'identity_unknown' using errcode = '22023'; end if;
  if u.account_status <> 'ARCHIVED' then raise exception 'identity_release_requires_archived' using errcode = '42501'; end if;
  if exists (select 1 from public.identity_identifier_releases r where r.user_id = p_user and r.restored_at is null) then
    return jsonb_build_object('released', false, 'already_released', true);
  end if;
  insert into public.identity_identifier_releases(user_id, email, email_normalized, phone, released_by, reason, request_id)
  values (p_user, u.email, u.email_normalized, u.phone, p_actor, left(btrim(p_reason), 500), p_request_id);
  update public.users set email = v_placeholder, phone = null, phone_verified_at = null, email_verified_at = null, updated_at = now()
   where id = p_user;
  update auth.users set email = v_placeholder, phone = null, encrypted_password = '', email_change = '', phone_change = '',
         email_confirmed_at = null, phone_confirmed_at = null, updated_at = now()
   where id = p_user;
  delete from auth.identities where user_id = p_user;
  get diagnostics v_identities = row_count;
  perform public.identity_revoke_login(p_user);
  perform public.sa_log_access_change(p_actor, 'identity.identifiers_released', p_user, 'user', p_user::text,
    jsonb_build_object('email_released', u.email is not null, 'phone_released', u.phone is not null), p_reason, 'user');
  return jsonb_build_object('released', true, 'email_released', u.email is not null, 'phone_released', u.phone is not null,
                            'provider_identities_removed', v_identities);
end $fn$;
revoke all on function public.identity_release_internal(uuid,uuid,text,uuid) from public, anon, authenticated, service_role;

-- Same person returning: put the released identifiers back (fails closed when someone else owns them now).
create or replace function public.identity_restore_released_identifiers(p_actor uuid, p_user uuid)
returns boolean language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $fn$
declare r record;
begin
  select * into r from public.identity_identifier_releases x where x.user_id = p_user and x.restored_at is null for update;
  if not found then return false; end if;
  if (r.email_normalized is not null and (
        exists (select 1 from public.users pu where pu.email_normalized = r.email_normalized and pu.id <> p_user)
        or exists (select 1 from auth.users au where lower(btrim(au.email)) = r.email_normalized and au.id <> p_user)))
     or (r.phone is not null and (
        exists (select 1 from public.users pu where pu.phone = r.phone and pu.id <> p_user)
        or exists (select 1 from auth.users au where au.phone is not null and au.phone <> ''
                   and public.identity_normalize_phone('+' || ltrim(au.phone, '+')) = r.phone and au.id <> p_user))) then
    raise exception 'identity_released_identifier_taken' using errcode = '23505',
      hint = 'The released email or phone now belongs to another identity. Reactivation needs new contact details.';
  end if;
  update public.identity_identifier_releases set restored_at = now(), restored_by = p_actor where id = r.id;
  update public.users set email = r.email, phone = r.phone, updated_at = now() where id = p_user;
  update auth.users set email = r.email, phone = nullif(ltrim(coalesce(r.phone, ''), '+'), ''), updated_at = now() where id = p_user;
  return true;
end $fn$;
revoke all on function public.identity_restore_released_identifiers(uuid,uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. identity_set_account_status: reactivation restores identifiers and lifts the ban
--    (body otherwise identical to the 20261027100000 version)
-- ---------------------------------------------------------------------------
create or replace function public.identity_set_account_status(p_actor uuid, p_user uuid, p_status text, p_reason text)
returns text language plpgsql security definer set search_path = pg_catalog, pg_temp as $function$
declare v_old text; v_org uuid; v_perm text; v_root text;
begin
  if p_status not in ('ACTIVE','SUSPENDED','DISABLED','ARCHIVED') then raise exception 'identity_status_invalid' using errcode = '22023'; end if;
  if p_actor is null or p_user is null then raise exception 'identity_actor_and_user_required' using errcode = '22023'; end if;
  if p_actor = p_user then raise exception 'identity_self_status_change_prohibited' using errcode = '42501'; end if;
  if p_reason is null or length(btrim(p_reason)) < 5 then raise exception 'identity_reason_required' using errcode = '22023'; end if;
  -- Root target protection first (takes the Root Access lock before the row lock, like the Root Access functions).
  v_root := public.identity_root_target_refusal(p_actor, p_user);
  if v_root is not null then
    raise exception '%', v_root using errcode = '42501', hint = 'Only another Root Administrator can change a Root Administrator''s account.';
  end if;
  select u.account_status, u.organization_id into v_old, v_org from public.users u where u.id = p_user for update;
  if not found then raise exception 'identity_unknown' using errcode = '22023'; end if;
  -- Archiving and reactivating an archived identity are Super Admin actions.
  v_perm := case when p_status = 'ARCHIVED' or v_old = 'ARCHIVED' then 'platform.identity.delete' else 'platform.identity.disable' end;
  perform public.sa_assert_actor_permission(p_actor, v_perm,
    jsonb_build_object('organization_id', coalesce(v_org, (select u.organization_id from public.users u where u.id = p_actor))),
    case when v_perm = 'platform.identity.delete' then public.sa_legacy_is_super_admin(p_actor) else public.identity_legacy_user_admin(p_actor) end);
  if v_old = p_status then return v_old; end if;
  if v_old = 'ARCHIVED' and p_status <> 'ACTIVE' then
    raise exception 'identity_archived_is_terminal' using errcode = '42501', hint = 'An archived identity can only be reactivated.';
  end if;
  -- Deactivating an active Root Administrator must leave at least one other (held under the Root Access lock above).
  if p_status <> 'ACTIVE' and public.sa_actor_is_root(p_user) and public.sa_active_root_count(p_user) = 0 then
    raise exception 'identity_last_root_administrator' using errcode = '42501',
      hint = 'The last active Root Administrator cannot be deactivated.';
  end if;
  if v_old = 'ARCHIVED' then
    -- The same person returning: released identifiers come back (or nothing changes), the login ban is lifted.
    perform public.identity_restore_released_identifiers(p_actor, p_user);
    update auth.users set banned_until = null, updated_at = now() where id = p_user;
    perform set_config('identity.reactivating', 'on', true);
  end if;
  update public.users set account_status = p_status, account_status_reason = left(btrim(p_reason), 500) where id = p_user;
  perform set_config('identity.reactivating', 'off', true);
  perform public.sa_log_access_change(p_actor, case when v_old = 'ARCHIVED' then 'identity.reactivated' else 'identity.status_changed' end,
    p_user, 'user', p_user::text, jsonb_build_object('from', v_old, 'to', p_status), p_reason, 'user');
  return p_status;
end $function$;
revoke all on function public.identity_set_account_status(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.identity_set_account_status(uuid,uuid,text,text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. identity_resolve: a released identifier is not silently free
--    (body identical to the staging version except the NO_MATCH refinement)
-- ---------------------------------------------------------------------------
create or replace function public.identity_resolve(p_email text, p_phone text)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $function$
declare
  v_email text := public.identity_normalize_email(p_email);
  v_phone text := public.identity_normalize_phone(p_phone);
  v_email_ids uuid[];
  v_phone_ids uuid[];
  v_email_user uuid;
  v_phone_user uuid;
  v_user uuid;
  v_outcome text;
  v_matched_by text;
  v_released uuid[] := '{}';
  u record;
begin
  if (nullif(btrim(coalesce(p_email, '')), '') is not null and v_email is null)
     or (nullif(btrim(coalesce(p_phone, '')), '') is not null and v_phone is null)
     or (v_email is null and v_phone is null) then
    return jsonb_build_object('outcome', 'INVALID_INPUT',
      'email_valid', v_email is not null or nullif(btrim(coalesce(p_email, '')), '') is null,
      'phone_valid', v_phone is not null or nullif(btrim(coalesce(p_phone, '')), '') is null);
  end if;

  if v_email is not null then
    select coalesce(array_agg(distinct x.id), '{}') into v_email_ids from (
      select pu.id from public.users pu where pu.email_normalized = v_email
      union select au.id from auth.users au where lower(btrim(au.email)) = v_email) x;
  else v_email_ids := '{}'; end if;

  if v_phone is not null then
    select coalesce(array_agg(distinct x.id), '{}') into v_phone_ids from (
      select pu.id from public.users pu where pu.phone = v_phone
      union select au.id from auth.users au
            where au.phone is not null and au.phone <> '' and public.identity_normalize_phone('+' || ltrim(au.phone, '+')) = v_phone) x;
  else v_phone_ids := '{}'; end if;

  v_email_user := v_email_ids[1];
  if cardinality(v_email_ids) > 1 then
    v_outcome := 'IDENTITY_AMBIGUOUS_EMAIL';
  elsif v_email_user is not null and exists (select 1 from unnest(v_phone_ids) p where p <> v_email_user) then
    -- The phone belongs to (at least) one identity other than the email's.
    v_phone_user := (select p from unnest(v_phone_ids) p where p <> v_email_user limit 1);
    v_outcome := 'IDENTITY_CONFLICT';
  elsif v_email_user is null and cardinality(v_phone_ids) > 1 then
    v_outcome := 'IDENTITY_AMBIGUOUS_PHONE';
  else
    v_phone_user := v_phone_ids[1];
    if v_email_user is null and v_phone_user is null then
      v_outcome := 'NO_MATCH';
      -- Identifiers released by an archived identity: a new person is possible, but only by an explicit
      -- decision (a returning person is reactivated instead).
      select coalesce(array_agg(distinct r.user_id), '{}') into v_released
      from public.identity_identifier_releases r
      where r.restored_at is null
        and ((v_email is not null and r.email_normalized = v_email) or (v_phone is not null and r.phone = v_phone));
      if cardinality(v_released) > 0 then v_outcome := 'IDENTITY_PREVIOUSLY_RELEASED'; end if;
    else
      v_user := coalesce(v_email_user, v_phone_user);
      v_matched_by := case when v_email_user is not null and v_phone_user is not null then 'email+phone'
                           when v_email_user is not null then 'email' else 'phone' end;
      v_outcome := 'MATCH';
      select pu.account_status, pu.phone_verified_at, pu.principal_type, pu.organization_id, pu.account_scope
        into u from public.users pu where pu.id = v_user;
      if found and u.account_status = 'ARCHIVED' then
        v_outcome := 'IDENTITY_ARCHIVED';
      elsif v_matched_by = 'phone' and (not found or u.phone_verified_at is null) then
        -- An unverified phone never proves ownership.
        v_outcome := 'IDENTITY_VERIFICATION_REQUIRED';
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'outcome', v_outcome,
    'user_id', case when v_outcome = 'MATCH' then v_user end,
    'matched_by', v_matched_by,
    'email_user_id', v_email_user,
    'phone_user_id', v_phone_user,
    'matched_user_ids', to_jsonb(array(select distinct unnest(v_email_ids || v_phone_ids))),
    'released_user_ids', to_jsonb(v_released),
    'has_profile', case when v_user is null then null else exists (select 1 from public.users pu where pu.id = v_user) end,
    'account_status', case when v_user is not null then (select pu.account_status from public.users pu where pu.id = v_user) end,
    'principal_type', case when v_user is not null then (select pu.principal_type from public.users pu where pu.id = v_user) end,
    'organization_id', case when v_user is not null then (select pu.organization_id from public.users pu where pu.id = v_user) end,
    'phone_is_new', v_phone is not null and cardinality(v_phone_ids) = 0,
    'email_is_new', v_email is not null and cardinality(v_email_ids) = 0);
end $function$;
revoke all on function public.identity_resolve(text,text) from public, anon, authenticated;
grant execute on function public.identity_resolve(text,text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Archive plan / preview / execute
-- ---------------------------------------------------------------------------
create or replace function public.identity_archive_plan(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare u record; v_hr jsonb; v_blockers jsonb := '[]'::jsonb; v_warnings jsonb := '[]'::jsonb; v_n bigint; v_released boolean;
begin
  select pu.id, pu.full_name, pu.email, pu.phone, pu.organization_id, pu.role_code, pu.account_status, pu.is_active,
         pu.employee_no, pu.updated_at, o.org_name as organization_name, ro.role_level
    into u
  from public.users pu
  left join public.organizations o on o.id = pu.organization_id
  left join public.roles ro on ro.role_code = pu.role_code
  where pu.id = p_user;
  if u.id is null then return jsonb_build_object('found', false); end if;
  v_released := exists (select 1 from public.identity_identifier_releases r where r.user_id = p_user and r.restored_at is null);

  select coalesce(jsonb_agg(jsonb_build_object('employment_id', e.id, 'organization_id', e.organization_id, 'employee_no', e.employee_no,
           'onboarding_status', e.onboarding_status, 'status', e.status, 'end_date', e.end_date, 'updated_at', e.updated_at) order by e.created_at), '[]'::jsonb)
    into v_hr from public.hr_employees e where e.user_id = p_user;

  if exists (select 1 from public.sa_root_access_grants g where g.user_id = p_user and g.status = 'active'
             and (g.effective_until is null or g.effective_until > now())) then
    v_blockers := v_blockers || jsonb_build_object('code', 'PROTECTED_ROOT');
  end if;
  if u.role_level is not null and u.role_level <= 10 and u.is_active is true and u.organization_id is not null
     and not exists (select 1 from public.users o join public.roles ro on ro.role_code = o.role_code
                     where o.organization_id = u.organization_id and o.id <> p_user and o.is_active is true and ro.role_level <= 10) then
    v_blockers := v_blockers || jsonb_build_object('code', 'LAST_ADMINISTRATOR', 'organization_id', u.organization_id);
  end if;

  select count(*) into v_n from public.users r where r.manager_user_id = p_user and r.id <> p_user and r.account_status <> 'ARCHIVED';
  if v_n > 0 then v_warnings := v_warnings || jsonb_build_object('code', 'DIRECT_REPORTS', 'count', v_n); end if;
  select count(*) into v_n from public.sa_role_assignments a where a.user_id = p_user and a.status in ('active','suspended');
  if v_n > 0 then v_warnings := v_warnings || jsonb_build_object('code', 'ACCESS_REVOKED', 'count', v_n); end if;
  select count(*) into v_n from public.sa_delegations d where (d.delegator_id = p_user or d.delegate_id = p_user) and d.status = 'active';
  if v_n > 0 then v_warnings := v_warnings || jsonb_build_object('code', 'DELEGATIONS_REVOKED', 'count', v_n); end if;
  select count(*) into v_n from auth.sessions s where s.user_id = p_user;
  if v_n > 0 then v_warnings := v_warnings || jsonb_build_object('code', 'SESSIONS_REVOKED', 'count', v_n); end if;

  return jsonb_build_object(
    'found', true,
    'target', jsonb_build_object('user_id', p_user, 'full_name', u.full_name, 'email', case when v_released then null else u.email end,
      'phone', case when v_released then null else u.phone end, 'organization_id', u.organization_id, 'organization_name', u.organization_name,
      'role_code', u.role_code, 'role_level', u.role_level, 'account_status', u.account_status, 'employee_no', u.employee_no,
      'has_identity', true, 'has_login', exists (select 1 from auth.users a where a.id = p_user)),
    'employment', v_hr,
    'archived', u.account_status = 'ARCHIVED',
    'identifiers_released', v_released,
    'releasable', u.email is not null or u.phone is not null,
    'blockers', v_blockers,
    'warnings', v_warnings,
    'confirmation_phrase', case when v_released then p_user::text
      else coalesce(nullif(btrim(coalesce(u.email, '')), ''), nullif(btrim(coalesce(u.phone, '')), ''), p_user::text) end,
    'preview_token', md5(concat_ws('|', p_user, u.updated_at, u.account_status, v_released, v_hr::text, v_blockers::text))
  );
end $fn$;
revoke all on function public.identity_archive_plan(uuid) from public, anon, authenticated, service_role;

create or replace function public.identity_archive_preview(p_actor uuid, p_user uuid, p_entry text)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v jsonb; v_org uuid;
begin
  if p_user is null then raise exception 'identity_archive_input_required' using errcode = '22023'; end if;
  v_org := public.identity_deletion_authorize(p_actor, p_user, p_entry);
  v := public.identity_archive_plan(p_user);
  if not (v->>'found')::boolean then raise exception 'identity_deletion_target_not_found' using errcode = '22023'; end if;
  v := jsonb_set(v, '{blockers}', (v->'blockers') || public.identity_deletion_actor_blockers(p_actor, v));
  return v || jsonb_build_object('entry_point', p_entry, 'decision_organization_id', v_org,
    'archive_allowed', jsonb_array_length(v->'blockers') = 0 and not (v->>'archived')::boolean,
    'release_allowed', jsonb_array_length(v->'blockers') = 0 and not (v->>'identifiers_released')::boolean and (v->>'releasable')::boolean);
end $fn$;
revoke all on function public.identity_archive_preview(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.identity_archive_preview(uuid,uuid,text) to service_role;

create or replace function public.identity_archive_execute(
  p_actor uuid, p_user uuid, p_entry text, p_request_id uuid, p_preview_token text, p_reason text, p_confirmation text,
  p_release_identifiers boolean default false, p_employment_end text default 'resigned')
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_existing record;
  v_seen boolean;
  v_plan jsonb;
  v_blockers jsonb;
  v_org uuid;
  v_id uuid;
  v_login jsonb;
  v_release jsonb := null;
  v_employment integer := 0;
begin
  if p_request_id is null or p_user is null then raise exception 'identity_archive_input_required' using errcode = '22023'; end if;
  if p_employment_end is null or p_employment_end not in ('resigned','terminated') then
    raise exception 'identity_archive_employment_end_invalid' using errcode = '22023';
  end if;
  -- The same actor repeating the same request gets its recorded outcome; anyone else is authorized first.
  select * into v_existing from public.identity_lifecycle_actions where request_id = p_request_id;
  v_seen := found;
  if v_seen and v_existing.action = 'archive' and v_existing.actor_id = p_actor and v_existing.target_user_id = p_user
     and v_existing.entry_point = p_entry then
    return jsonb_build_object('status', v_existing.status, 'replayed', true, 'action_id', v_existing.id, 'blockers', v_existing.blockers,
                              'details', v_existing.details);
  end if;
  v_org := public.identity_deletion_authorize(p_actor, p_user, p_entry);
  if v_seen then raise exception 'identity_archive_request_reused' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'identity_archive_reason_required' using errcode = '22023'; end if;

  perform set_config('lock_timeout', '5s', true);
  -- Same key as identity_deletion_execute: an archive and a permanent delete of one identity never interleave.
  perform pg_advisory_xact_lock(hashtextextended('identity_deletion:' || p_user::text, 0));
  select * into v_existing from public.identity_lifecycle_actions where request_id = p_request_id;
  if found then
    if v_existing.action <> 'archive' or v_existing.actor_id <> p_actor or v_existing.target_user_id <> p_user or v_existing.entry_point <> p_entry then
      raise exception 'identity_archive_request_reused' using errcode = '22023';
    end if;
    return jsonb_build_object('status', v_existing.status, 'replayed', true, 'action_id', v_existing.id, 'blockers', v_existing.blockers,
                              'details', v_existing.details);
  end if;

  perform 1 from public.users where id = p_user for update;
  perform 1 from auth.users where id = p_user for update;
  perform 1 from public.hr_employees where user_id = p_user for update;
  v_plan := public.identity_archive_plan(p_user);
  if not (v_plan->>'found')::boolean then raise exception 'identity_deletion_target_not_found' using errcode = '22023'; end if;
  if p_preview_token is distinct from (v_plan->>'preview_token') then return jsonb_build_object('status', 'stale'); end if;
  if lower(btrim(coalesce(p_confirmation, ''))) is distinct from lower(v_plan->>'confirmation_phrase') then
    raise exception 'identity_deletion_confirmation_mismatch' using errcode = '22023';
  end if;

  v_blockers := (v_plan->'blockers') || public.identity_deletion_actor_blockers(p_actor, v_plan);
  if (v_plan->>'archived')::boolean then v_blockers := v_blockers || jsonb_build_object('code', 'ALREADY_ARCHIVED'); end if;
  if jsonb_array_length(v_blockers) > 0 then
    insert into public.identity_lifecycle_actions(request_id, action, actor_id, target_user_id, entry_point, organization_id, status, reason, blockers, details)
    values (p_request_id, 'archive', p_actor, p_user, p_entry, v_org, 'blocked', btrim(p_reason), v_blockers,
            jsonb_build_object('target', v_plan->'target'))
    returning id into v_id;
    return jsonb_build_object('status', 'blocked', 'action_id', v_id, 'blockers', v_blockers);
  end if;

  -- Employment ends (employee number, onboarding history and HR records are kept).
  update public.hr_employees set status = p_employment_end, end_date = coalesce(end_date, current_date), updated_at = now()
   where user_id = p_user and status not in ('resigned','terminated');
  get diagnostics v_employment = row_count;

  -- Account lifecycle (re-asserts platform.identity.delete and Root protection; the users trigger runs the S&A leaver sync).
  perform public.identity_set_account_status(p_actor, p_user, 'ARCHIVED', btrim(p_reason));
  v_login := public.identity_revoke_login(p_user);
  -- No more Telegram ordering for a former user (as the previous archive did).
  if to_regclass('public.telegram_links') is not null then
    execute 'update public.telegram_links set is_active = false where user_id = $1 and is_active is true' using p_user;
  end if;
  if p_release_identifiers then
    v_release := public.identity_release_internal(p_actor, p_user, btrim(p_reason), p_request_id);
  end if;

  -- Post-conditions: archived, no live access, no session.
  if (select account_status from public.users where id = p_user) <> 'ARCHIVED'
     or exists (select 1 from public.sa_role_assignments a where a.user_id = p_user and a.status in ('active','suspended'))
     or exists (select 1 from public.sa_organization_memberships m where m.user_id = p_user and m.status in ('active','suspended'))
     or exists (select 1 from auth.sessions s where s.user_id = p_user)
     or exists (select 1 from auth.users a where a.id = p_user and (a.banned_until is null or a.banned_until <= now())) then
    raise exception 'identity_archive_incomplete' using errcode = 'P0001';
  end if;

  insert into public.identity_lifecycle_actions(request_id, action, actor_id, target_user_id, entry_point, organization_id, status, reason, details)
  values (p_request_id, 'archive', p_actor, p_user, p_entry, v_org, 'completed', btrim(p_reason),
          jsonb_build_object('target', v_plan->'target', 'employment', v_plan->'employment', 'employment_end', p_employment_end,
                             'employment_records_ended', v_employment, 'login', v_login, 'release', v_release))
  returning id into v_id;
  return jsonb_build_object('status', 'completed', 'action_id', v_id, 'login', v_login, 'release', v_release,
                            'employment_records_ended', v_employment);
end $fn$;
revoke all on function public.identity_archive_execute(uuid,uuid,text,uuid,text,text,text,boolean,text) from public, anon, authenticated;
grant execute on function public.identity_archive_execute(uuid,uuid,text,uuid,text,text,text,boolean,text) to service_role;

-- Release for an identity that is already archived (Archived view).
create or replace function public.identity_release_identifiers(p_actor uuid, p_user uuid, p_entry text, p_request_id uuid, p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_existing record; v_seen boolean; v_org uuid; v_plan jsonb; v_blockers jsonb; v_release jsonb; v_id uuid;
begin
  if p_request_id is null or p_user is null then raise exception 'identity_archive_input_required' using errcode = '22023'; end if;
  select * into v_existing from public.identity_lifecycle_actions where request_id = p_request_id;
  v_seen := found;
  if v_seen and v_existing.action = 'release' and v_existing.actor_id = p_actor and v_existing.target_user_id = p_user
     and v_existing.entry_point = p_entry then
    return jsonb_build_object('status', v_existing.status, 'replayed', true, 'action_id', v_existing.id, 'blockers', v_existing.blockers);
  end if;
  v_org := public.identity_deletion_authorize(p_actor, p_user, p_entry);
  if v_seen then raise exception 'identity_archive_request_reused' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then raise exception 'identity_archive_reason_required' using errcode = '22023'; end if;
  perform set_config('lock_timeout', '5s', true);
  perform pg_advisory_xact_lock(hashtextextended('identity_deletion:' || p_user::text, 0));
  perform 1 from public.users where id = p_user for update;
  v_plan := public.identity_archive_plan(p_user);
  if not (v_plan->>'found')::boolean then raise exception 'identity_deletion_target_not_found' using errcode = '22023'; end if;
  v_blockers := (v_plan->'blockers') || public.identity_deletion_actor_blockers(p_actor, v_plan);
  if not (v_plan->>'archived')::boolean then v_blockers := v_blockers || jsonb_build_object('code', 'NOT_ARCHIVED'); end if;
  if (v_plan->>'identifiers_released')::boolean then v_blockers := v_blockers || jsonb_build_object('code', 'ALREADY_RELEASED'); end if;
  if jsonb_array_length(v_blockers) > 0 then
    insert into public.identity_lifecycle_actions(request_id, action, actor_id, target_user_id, entry_point, organization_id, status, reason, blockers)
    values (p_request_id, 'release', p_actor, p_user, p_entry, v_org, 'blocked', btrim(p_reason), v_blockers) returning id into v_id;
    return jsonb_build_object('status', 'blocked', 'action_id', v_id, 'blockers', v_blockers);
  end if;
  v_release := public.identity_release_internal(p_actor, p_user, btrim(p_reason), p_request_id);
  insert into public.identity_lifecycle_actions(request_id, action, actor_id, target_user_id, entry_point, organization_id, status, reason, details)
  values (p_request_id, 'release', p_actor, p_user, p_entry, v_org, 'completed', btrim(p_reason), jsonb_build_object('release', v_release))
  returning id into v_id;
  return jsonb_build_object('status', 'completed', 'action_id', v_id, 'release', v_release);
end $fn$;
revoke all on function public.identity_release_identifiers(uuid,uuid,text,uuid,text) from public, anon, authenticated;
grant execute on function public.identity_release_identifiers(uuid,uuid,text,uuid,text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Post-conditions
-- ---------------------------------------------------------------------------
do $post$
begin
  if has_function_privilege('authenticated', 'public.identity_archive_execute(uuid,uuid,text,uuid,text,text,text,boolean,text)', 'execute')
     or has_function_privilege('anon', 'public.identity_resolve(text,text)', 'execute')
     or has_table_privilege('service_role', 'public.identity_identifier_releases', 'select') then
    raise exception 'postcondition: archive / release surface exposed to API roles';
  end if;
  if public.identity_normalize_email(public.identity_released_placeholder_email(gen_random_uuid())) is not null
     and public.identity_normalize_email(public.identity_released_placeholder_email(gen_random_uuid())) not like '%@released.invalid' then
    raise exception 'postcondition: placeholder email normalization changed';
  end if;
end $post$;
