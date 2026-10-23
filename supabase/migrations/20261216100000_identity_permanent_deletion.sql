-- ============================================================================
-- Permanent identity deletion (pre-go-live clean-up) — one canonical operation
-- for User Management (Delete User) and HR → People → Employees
-- (Delete Employee Permanently)
-- ----------------------------------------------------------------------------
-- Why a new operation
--   * User Management "Delete User" hard-deleted only identities without
--     history (identity_history_references); every internal employee has an
--     employment anchor (hr_employees.user_id), which that function counts as
--     HR history, so employees were always ARCHIVED, never deleted. Its
--     application-side cleanup also deleted audit_logs and re-assigned orders /
--     documents to the administrator, and it removed public.users and the
--     login in two separate calls (a failed auth delete still reported success).
--   * HR "Delete Employee" (20261214100000) only moves the onboarding state
--     completed|reset → pending; identity, login and anchor stay, so a pending
--     employee has nothing to delete.
--
-- What this migration adds
--   identity_deletion_plan(target)          dependency graph + protections (no writes, no authorization)
--   identity_deletion_preview(actor, target, entry)
--   identity_deletion_execute(actor, target, entry, request_id, preview_token, reason, confirmation)
--   identity_deletion_record_auth_check(request_id, verified, detail)   (server post-commit check)
--   identity_deletion_requests              durable record (blocked + completed), append-only
--   identity_history_delete_guard           also passes the delete issued by an executing request
--
-- Dependency classes (discovered from pg_constraint at preview AND execution)
--   CLEANUP   explicit allowlist of identity-owned rows (v_cleanup below); every
--             row is copied into identity_deletion_requests.before_image first.
--   RETAINED  append-only audit logs that store the person id WITHOUT a foreign
--             key (v_retained): untouched, so the evidence stays intact; the
--             deletion record maps the id to the person's name/email.
--   BLOCKING  everything else: every other foreign key to public.users,
--             auth.users or the employment record (whatever its ON DELETE rule —
--             CASCADE would erase it, SET NULL would erase attribution), every
--             other uuid person column without a foreign key, rows of OTHER
--             people that point at a cleanup row with SET NULL / NO ACTION
--             (e.g. an access review of the person's assignment), direct
--             reports, and HR records kept by a restorable HR reset snapshot.
--   Nothing is re-assigned or nulled to force a deletion through.
--
-- Protections (blockers): own account; Root Access holder (any grant row);
--   Super Admin target unless the actor is Super Admin / Root; target the actor
--   does not dominate (sa_actor_dominates); the last active HQ Admin / Super
--   Admin of an organization; HR live (hr_go_live_state = 'live') for an
--   identity with an employment record (identities without one are not
--   subject to the HR lifecycle).
--
-- Authorization (database, every call, every migration mode, no delegation)
--   platform.identity.delete in the target's organization (explicit S&A:
--   sa_evaluate_permission(..., false)); the HR entry point additionally needs
--   hr.employee.delete in the employment record's organization, and only works
--   for a person with an employment record. hr.employee.manage / HR & Payroll
--   Full Access never suffice. A refusal raises 42501 before anything about the
--   target is returned.
--
-- Atomicity (auth + central identity + HR anchor)
--   On this deployment GoTrue stores accounts in auth.users of the same
--   database, so the login (auth.users and its cascading auth.identities /
--   sessions / refresh tokens / MFA factors), public.users and hr_employees are
--   removed in ONE transaction with the dependency re-check: either all of it
--   commits or nothing changes. No GoTrue HTTP call is part of the critical
--   path. The server then verifies through the GoTrue admin API that the
--   account is gone and records the result (identity_deletion_record_auth_check);
--   it never reports success without that verification.
--
-- Concurrency / idempotency: request_id is unique (a repeat returns the
--   recorded outcome, a reuse for another target is refused); per-identity
--   advisory lock; FOR UPDATE on the identity, login and employment rows (any
--   concurrent insert referencing them through a foreign key waits, so the
--   re-check is exact); SHARE locks on tables whose person columns have no
--   foreign key; lock_timeout 5s; preview token must still match.
--
-- Recreation: nothing recreates the identity — fn_auto_create_hr_employee runs
--   on INSERT of public.users only, identity_users_forward_employment on UPDATE
--   of an existing row; a later sign-up with the same email is a new identity.
--
-- Prerequisites: 20260929150000 (identity history guard), 20261003100000 (HR
--   onboarding state / go-live), 20261214100000 (hr.employee.delete). The
--   migration role must be able to DELETE from auth.users.
-- Idempotent: yes. No migration mode and no grant is changed; nobody receives a
--   permission from this migration. Apply manually (SQL editor / psql).
--
-- Rollback (reverse order):
--   restore identity_history_delete_guard from 20260929120000;
--   drop function identity_deletion_record_auth_check, identity_deletion_execute,
--     identity_deletion_preview, identity_deletion_actor_check, identity_deletion_actor_blockers,
--     identity_deletion_authorize, identity_deletion_plan, identity_deletion_in_progress,
--     identity_deletion_category;
--   keep identity_deletion_requests (audit) or archive it before dropping.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Prerequisites
-- ---------------------------------------------------------------------------
do $pre$
begin
  if to_regprocedure('public.identity_history_references(uuid)') is null
     or to_regprocedure('public.identity_history_delete_guard()') is null then
    raise exception 'identity_prerequisite_missing: identity history guard (20260929120000 / 20260929150000)';
  end if;
  if to_regclass('public.hr_go_live_state') is null or to_regprocedure('public.hr_reject_append_only()') is null then
    raise exception 'hr_prerequisite_missing: HR onboarding state (20261003100000)';
  end if;
  if not exists (select 1 from public.sa_permissions where permission_key = 'hr.employee.delete')
     or not exists (select 1 from public.sa_permissions where permission_key = 'platform.identity.delete') then
    raise exception 'sa_prerequisite_missing: hr.employee.delete (20261214100000) / platform.identity.delete';
  end if;
  if to_regprocedure('public.sa_evaluate_permission(uuid,text,jsonb,boolean)') is null
     or to_regprocedure('public.sa_actor_dominates(uuid,uuid)') is null
     or to_regprocedure('public.sa_actor_is_root(uuid)') is null then
    raise exception 'sa_prerequisite_missing: sa_evaluate_permission / sa_actor_dominates / sa_actor_is_root';
  end if;
  if not has_table_privilege(current_user, 'auth.users', 'DELETE') then
    raise exception 'identity_prerequisite_missing: % cannot delete from auth.users (run as the database owner)', current_user;
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Durable record (blocked and completed deletions)
-- ---------------------------------------------------------------------------
create table if not exists public.identity_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  actor_id uuid not null,
  target_user_id uuid not null,
  entry_point text not null check (entry_point in ('user_management','hr')),
  organization_id uuid,
  status text not null check (status in ('blocked','executing','completed')),
  reason text not null,
  preview_token text not null,
  confirmation text,
  blockers jsonb not null default '[]'::jsonb,
  cleanup jsonb not null default '[]'::jsonb,
  retained jsonb not null default '[]'::jsonb,
  target_snapshot jsonb not null default '{}'::jsonb,
  before_image jsonb,
  executing_txid bigint,
  auth_verified_at timestamptz,
  auth_verification text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists identity_deletion_requests_target_idx on public.identity_deletion_requests (target_user_id, created_at desc);
alter table public.identity_deletion_requests enable row level security;
revoke all on table public.identity_deletion_requests from public, anon, authenticated, service_role;
comment on table public.identity_deletion_requests is
  'Permanent identity deletions (identity_deletion_execute), including blocked attempts: who, whom (snapshot), why, what was removed (before-image) and what was retained. Append-only apart from executing→completed in the same transaction and the post-commit auth verification (once it succeeded, final).';

create or replace function public.identity_deletion_requests_guard()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $fn$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'identity_deletion_record_append_only' using errcode = '42501';
  end if;
  -- executing → completed, only inside the transaction that started it
  if old.status = 'executing' and new.status = 'completed' and old.executing_txid = txid_current()
     and new.request_id = old.request_id and new.actor_id = old.actor_id and new.target_user_id = old.target_user_id
     and new.reason = old.reason and new.before_image is not distinct from old.before_image then
    return new;
  end if;
  -- the one-time post-commit auth verification of a completed deletion
  if old.status = 'completed' and new.status = 'completed' and new.auth_verified_at is not null
     and (old.auth_verified_at is null or old.auth_verification like 'verification_failed%')
     and (to_jsonb(new) - 'auth_verified_at' - 'auth_verification') = (to_jsonb(old) - 'auth_verified_at' - 'auth_verification') then
    return new;
  end if;
  raise exception 'identity_deletion_record_append_only' using errcode = '42501';
end $fn$;
revoke all on function public.identity_deletion_requests_guard() from public, anon, authenticated, service_role;
drop trigger if exists identity_deletion_requests_guard on public.identity_deletion_requests;
create trigger identity_deletion_requests_guard before update or delete on public.identity_deletion_requests
for each row execute function public.identity_deletion_requests_guard();
drop trigger if exists identity_deletion_requests_no_truncate on public.identity_deletion_requests;
create trigger identity_deletion_requests_no_truncate before truncate on public.identity_deletion_requests
for each statement execute function public.identity_deletion_requests_guard();

-- True only inside the transaction of an executing deletion of that identity.
create or replace function public.identity_deletion_in_progress(p_user uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select exists (select 1 from public.identity_deletion_requests r
                 where r.target_user_id = p_user and r.status = 'executing' and r.executing_txid = txid_current())
$fn$;
revoke all on function public.identity_deletion_in_progress(uuid) from public, anon, authenticated;
grant execute on function public.identity_deletion_in_progress(uuid) to service_role;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant execute on function public.identity_deletion_in_progress(uuid) to supabase_auth_admin';
  end if;
end $g$;

-- ---------------------------------------------------------------------------
-- 2. History guard: the canonical deletion is the one sanctioned hard delete
--    of an identity whose only references are cleanup / retained rows.
-- ---------------------------------------------------------------------------
create or replace function public.identity_history_delete_guard()
returns trigger language plpgsql
-- SECURITY INVOKER: current_user/session_user identify the caller.
set search_path = pg_catalog, pg_temp as $$
declare v_refs text[];
begin
  if current_user in ('anon', 'authenticated') then
    return old;  -- API roles cannot delete identities at all (users_protect_access_fields)
  end if;
  if current_user <> 'service_role'
     and session_user not in ('supabase_auth_admin', 'authenticator') then
    return old;
  end if;
  -- identity_deletion_execute re-checked the full dependency graph under lock in this transaction.
  if public.identity_deletion_in_progress(old.id) then
    return old;
  end if;
  v_refs := public.identity_history_references(old.id);
  if cardinality(v_refs) > 0 then
    raise exception 'identity_has_history'
      using errcode = '23503',
            detail = array_to_string(v_refs[1:10], ', '),
            hint = 'This identity is referenced by business or audit history. Archive it (account lifecycle) instead of deleting it.';
  end if;
  return old;
end $$;
revoke all on function public.identity_history_delete_guard() from public;
grant execute on function public.identity_history_delete_guard() to anon, authenticated, service_role;
do $g$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant execute on function public.identity_history_delete_guard() to supabase_auth_admin';
  end if;
end $g$;

-- ---------------------------------------------------------------------------
-- 3. Category of a referencing table (display + blocker grouping)
-- ---------------------------------------------------------------------------
create or replace function public.identity_deletion_category(p_table text)
returns text language sql immutable set search_path = pg_catalog, pg_temp as $fn$
  select case
    when p_table like 'hr\_attendance%' or p_table like 'hr\_overtime%' or p_table like 'hr\_timesheet%' or p_table like 'hr\_shift%' then 'hr_attendance'
    when p_table like 'hr\_leave%' then 'hr_leave'
    when p_table like 'hr\_payroll%' or p_table like 'hr\_payslip%' or p_table like 'payroll\_%' then 'payroll'
    when p_table like '%commission%' then 'commission'
    when p_table in ('hr_employee_compensation','hr_employee_allowances','hr_employee_deductions') or p_table like 'hr\_benefit%' or p_table like 'hr\_salary%' then 'compensation'
    when p_table like 'hr\_kpi%' or p_table like 'hr\_performance%' or p_table like 'hr\_appraisal%' or p_table like 'hr\_review%' or p_table like 'hr\_skill%' then 'performance'
    when p_table like 'hr\_position%' then 'positions'
    when p_table like 'hr\_document%' or p_table like 'hr\_contract%' or p_table like 'hr\_employee\_document%' then 'hr_documents'
    when p_table like 'hr\_%' then 'hr_other'
    when p_table like 'gl\_%' or p_table like 'accounting\_%' or p_table like 'fiscal\_%' or p_table like 'bank\_%' or p_table like 'ap\_%' or p_table like 'ar\_%'
      or p_table like '%invoice%' or p_table like '%payment%' or p_table like '%payout%' or p_table like 'incentive\_%' then 'finance'
    when p_table like 'purchase\_%' or p_table like 'po\_%' then 'purchase_orders'
    when p_table like 'order%' or p_table like 'stock\_%' or p_table like 'inventory\_%' or p_table like 'warehouse\_%' or p_table like 'qr\_%'
      or p_table like 'shipment%' or p_table like 'return\_%' or p_table like 'product%' or p_table like 'storefront\_%' or p_table like 'document%' then 'supply_chain'
    when p_table like 'roadtour\_%' or p_table like 'outdoor\_%' or p_table like 'event\_%' then 'roadtour_operations'
    when p_table like 'sa\_%' or p_table like 'account\_scope%' then 'security_access'
    when p_table like 'support\_%' or p_table like 'message%' or p_table like 'notification%' or p_table like 'wa\_%' or p_table like 'whatsapp%'
      or p_table like 'telegram%' or p_table like 'marketing\_%' then 'notifications_messaging'
    when p_table like '%audit%' or p_table like '%\_log' or p_table like '%\_logs' or p_table like '%history%' then 'audit'
    when p_table like 'point%' or p_table like 'consumer\_%' or p_table like 'ellbow\_%' or p_table like 'loyalty\_%' or p_table like 'redeem\_%'
      or p_table like 'scratch\_%' or p_table like 'spin\_%' or p_table like 'daily\_quiz%' then 'loyalty'
    else 'other' end
$fn$;
revoke all on function public.identity_deletion_category(text) from public, anon;
grant execute on function public.identity_deletion_category(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Plan (shared by preview and execution; actor-independent; no writes)
-- ---------------------------------------------------------------------------
create or replace function public.identity_deletion_plan(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  -- Identity-owned rows removed with the identity (justification in the header / report):
  -- access state (memberships, assignments — their history stays in sa_access_change_log),
  -- the employment anchor, personal channels/sessions/inbox, and the person's own scope log.
  v_cleanup constant text[] := array[
    'public.hr_employees.user_id',
    'public.sa_organization_memberships.user_id', 'public.sa_role_assignments.user_id',
    'public.hr_access_group_members.user_id', 'public.account_scope_audit_log.user_id',
    'public.telegram_links.user_id', 'public.telegram_link_tokens.user_id', 'public.serapp_user_presence.user_id',
    'public.message_notifications.user_id', 'public.support_thread_reads.user_id',
    'public.support_thread_participants.user_id', 'public.admin_whatsapp_identities.admin_user_id'];
  -- Append-only logs keeping the person id without a foreign key: never touched, so they stay valid.
  v_retained constant text[] := array[
    'sa_authorization_decisions', 'sa_access_change_log', 'hr_employee_onboarding_log', 'hr_employee_registration_actions',
    'hr_profile_edit_audit', 'hr_kpi_audit_log', 'hr_position_audit_events', 'hr_commission_audit_log',
    'hr_reset_runs', 'hr_reset_restorations', 'destructive_ops_audit_log', 'identity_conflicts',
    'identity_deletion_requests', 'notification_events', 'auth_verification_codes', 'legacy_config_cutover_snapshot'];
  u record;
  au record;
  r record;
  ch record;
  v_n bigint;
  v_emp uuid[];
  v_hr jsonb := '[]'::jsonb;
  v_blockers jsonb := '[]'::jsonb;
  v_cleanup_rows jsonb := '[]'::jsonb;
  v_retained_rows jsonb := '[]'::jsonb;
  v_locks text[] := '{}';
  v_key text;
  v_where text;
  v_admin_orgs jsonb := '[]'::jsonb;
  v_live boolean;
begin
  if p_user is null then return jsonb_build_object('found', false); end if;
  select pu.id, pu.full_name, pu.email, pu.phone, pu.organization_id, pu.role_code, pu.principal_type, pu.account_status,
         pu.is_active, pu.employee_no, pu.updated_at, o.org_name as organization_name, ro.role_level
    into u
  from public.users pu
  left join public.organizations o on o.id = pu.organization_id
  left join public.roles ro on ro.role_code = pu.role_code
  where pu.id = p_user;
  select a.id, a.email, a.phone, a.updated_at into au from auth.users a where a.id = p_user;
  if u.id is null and au.id is null then return jsonb_build_object('found', false); end if;

  select coalesce(array_agg(e.id), '{}'),
         coalesce(jsonb_agg(jsonb_build_object('employment_id', e.id, 'organization_id', e.organization_id, 'employee_no', e.employee_no,
                  'onboarding_status', e.onboarding_status, 'status', e.status, 'updated_at', e.updated_at) order by e.created_at), '[]'::jsonb)
    into v_emp, v_hr
  from public.hr_employees e where e.user_id = p_user;

  -- (a) Every single-column foreign key to the identity, the login or the employment record.
  for r in
    select distinct on (n.nspname, cls.relname, a.attname, c.confrelid = 'public.hr_employees'::regclass)
           n.nspname as sch, cls.relname as tbl, a.attname as col, c.confdeltype::text as rule,
           case when c.confrelid = 'public.hr_employees'::regclass then 'employment' else 'identity' end as target
    from pg_constraint c
    join pg_class cls on cls.oid = c.conrelid
    join pg_namespace n on n.oid = cls.relnamespace
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and cardinality(c.conkey) = 1 and n.nspname <> 'auth'
      and c.confrelid in ('public.users'::regclass, 'auth.users'::regclass, 'public.hr_employees'::regclass)
      and not (cls.oid = 'public.users'::regclass and a.attname = 'id')
    order by n.nspname, cls.relname, a.attname, c.confrelid = 'public.hr_employees'::regclass
  loop
    v_key := r.sch || '.' || r.tbl || '.' || r.col;
    v_where := format('t.%I = any($1)', r.col);
    -- The person's own rows do not reference them as somebody else.
    if r.sch = 'public' and r.tbl = 'users' then v_where := v_where || ' and t.id <> $2'; end if;
    if r.sch = 'public' and r.tbl = 'hr_employees' and r.col <> 'user_id' then v_where := v_where || ' and t.user_id <> $2'; end if;
    execute format('select count(*) from %I.%I t where ' || v_where, r.sch, r.tbl)
      into v_n using (case when r.target = 'employment' then v_emp else array[p_user] end), p_user;
    continue when v_n = 0;
    if v_key = any(v_cleanup) and r.target = 'identity' then
      v_cleanup_rows := v_cleanup_rows || jsonb_build_object('table', r.tbl, 'column', r.col, 'count', v_n, 'rule', r.rule);
    else
      v_blockers := v_blockers || jsonb_build_object(
        'code', case when r.col = 'manager_user_id' then 'DIRECT_REPORTS' else 'PROTECTED_RECORDS' end,
        'category', case when r.col = 'manager_user_id' then 'reporting_line' else public.identity_deletion_category(r.tbl) end,
        'table', r.tbl, 'column', r.col, 'count', v_n);
    end if;
  end loop;

  -- (b) Rows of OTHER people pointing at a cleanup row (only CASCADE children go with it).
  for r in
    select x->>'table' as tbl, x->>'column' as col from jsonb_array_elements(v_cleanup_rows) x
  loop
    for ch in
      select cls.relname as ctbl, a.attname as ccol, pa.attname as pcol, c.confdeltype::text as rule
      from pg_constraint c
      join pg_class cls on cls.oid = c.conrelid
      join pg_namespace n on n.oid = cls.relnamespace and n.nspname = 'public'
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1]
      where c.contype = 'f' and cardinality(c.conkey) = 1 and c.confrelid = to_regclass('public.' || r.tbl)
    loop
      continue when ch.rule = 'c';
      -- a reference between the person's own cleanup rows is not someone else's record
      if ('public.' || ch.ctbl || '.user_id') = any(v_cleanup) then
        execute format('select count(*) from public.%I t where t.%I in (select p.%I from public.%I p where p.%I = $1) and t.user_id is distinct from $1',
                       ch.ctbl, ch.ccol, ch.pcol, r.tbl, r.col) into v_n using p_user;
      else
        execute format('select count(*) from public.%I t where t.%I in (select p.%I from public.%I p where p.%I = $1)',
                       ch.ctbl, ch.ccol, ch.pcol, r.tbl, r.col) into v_n using p_user;
      end if;
      continue when v_n = 0;
      v_blockers := v_blockers || jsonb_build_object('code', 'PROTECTED_RECORDS', 'category', public.identity_deletion_category(ch.ctbl),
        'table', ch.ctbl, 'column', ch.ccol, 'count', v_n, 'via', r.tbl);
    end loop;
  end loop;

  -- (c) Person columns without a foreign key (against the identity and the employment record ids).
  for r in
    select cls.relname as tbl, a.attname as col
    from pg_class cls
    join pg_namespace n on n.oid = cls.relnamespace and n.nspname = 'public'
    join pg_attribute a on a.attrelid = cls.oid and a.attnum > 0 and not a.attisdropped
    where cls.relkind in ('r','p') and a.atttypid = 'uuid'::regtype
      and (a.attname ~ '(user_id|_by|actor_id|employee_id|employment_id|_user)$' or a.attname in ('consumer_id','owner_id'))
      and not exists (select 1 from pg_constraint c2 where c2.conrelid = cls.oid and c2.contype = 'f'
                      and cardinality(c2.conkey) = 1 and c2.conkey[1] = a.attnum)
    order by 1, 2
  loop
    v_where := 't.%I = any($1)';
    if r.tbl = 'hr_employees' then v_where := v_where || ' and t.user_id <> $2'; end if;
    if r.tbl = 'users' then v_where := v_where || ' and t.id <> $2'; end if;
    if r.tbl = any(v_retained) then
      execute format('select exists (select 1 from public.%I t where ' || v_where || ')', r.tbl, r.col)
        into v_live using array[p_user] || v_emp, p_user;
      if v_live then v_retained_rows := v_retained_rows || jsonb_build_object('table', r.tbl, 'column', r.col); end if;
      continue;
    end if;
    v_locks := v_locks || r.tbl;
    execute format('select count(*) from public.%I t where ' || v_where, r.tbl, r.col)
      into v_n using array[p_user] || v_emp, p_user;
    continue when v_n = 0;
    v_blockers := v_blockers || jsonb_build_object('code', 'PROTECTED_RECORDS', 'category', public.identity_deletion_category(r.tbl),
      'table', r.tbl, 'column', r.col, 'count', v_n, 'foreign_key', false);
  end loop;

  -- (d) HR records held by a restorable HR reset snapshot (restoring would need this person).
  select count(*) into v_n
  from public.hr_reset_snapshots s
  where s.table_name <> 'hr_employees'
    and not exists (select 1 from public.hr_reset_restorations x where x.run_id = s.run_id)
    and exists (select 1 from jsonb_each_text(s.row_data) kv where kv.value = p_user::text or kv.value = any(v_emp::text[]));
  if v_n > 0 then
    v_blockers := v_blockers || jsonb_build_object('code', 'HR_RESET_SNAPSHOT', 'category', 'hr_other', 'table', 'hr_reset_snapshots', 'count', v_n);
  end if;

  -- (e) Protections that do not depend on the actor.
  if exists (select 1 from public.sa_root_access_grants g where g.user_id = p_user) then
    v_blockers := v_blockers || jsonb_build_object('code', 'PROTECTED_ROOT');
  end if;
  if u.id is not null and u.role_level is not null and u.role_level <= 10 and u.is_active is true and u.organization_id is not null
     and not exists (select 1 from public.users o join public.roles ro on ro.role_code = o.role_code
                     where o.organization_id = u.organization_id and o.id <> p_user and o.is_active is true and ro.role_level <= 10) then
    v_blockers := v_blockers || jsonb_build_object('code', 'LAST_ADMINISTRATOR', 'organization_id', u.organization_id);
  end if;
  if exists (select 1 from public.hr_employees e join public.hr_go_live_state g on g.organization_id = e.organization_id
             where e.user_id = p_user and g.phase = 'live') then
    v_blockers := v_blockers || jsonb_build_object('code', 'HR_LIVE');
  end if;

  return jsonb_build_object(
    'found', true,
    'target', jsonb_build_object(
      'user_id', p_user, 'full_name', u.full_name, 'email', coalesce(u.email, au.email), 'phone', coalesce(u.phone, au.phone),
      'organization_id', u.organization_id, 'organization_name', u.organization_name, 'role_code', u.role_code,
      'role_level', u.role_level, 'principal_type', u.principal_type, 'account_status', u.account_status,
      'employee_no', u.employee_no, 'has_identity', u.id is not null, 'has_login', au.id is not null),
    'employment', v_hr,
    'cleanup', v_cleanup_rows,
    'retained', v_retained_rows,
    'blockers', v_blockers,
    'lock_tables', to_jsonb(v_locks),
    'confirmation_phrase', coalesce(nullif(btrim(coalesce(u.email, au.email)), ''), nullif(btrim(coalesce(u.phone, au.phone)), ''), p_user::text),
    'preview_token', md5(concat_ws('|', p_user, u.updated_at, au.updated_at, v_hr::text, v_cleanup_rows::text, v_blockers::text))
  );
end $fn$;
revoke all on function public.identity_deletion_plan(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Authorization (raises; returns the organization the decision was made in)
-- ---------------------------------------------------------------------------
create or replace function public.identity_deletion_authorize(p_actor uuid, p_user uuid, p_entry text)
returns uuid language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_org uuid;
  v_hr_org uuid;
begin
  if p_actor is null then raise exception 'sa_actor_required' using errcode = '42501'; end if;
  if p_entry is null or p_entry not in ('user_management','hr') then
    raise exception 'identity_deletion_entry_invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from public.users u where u.id = p_actor and u.is_active is true) then
    raise exception 'sa_actor_inactive' using errcode = '42501';
  end if;
  -- The target's organization decides; a target without one is judged in the actor's own (no disclosure).
  select u.organization_id into v_org from public.users u where u.id = p_user;
  if v_org is null then select u.organization_id into v_org from public.users u where u.id = p_actor; end if;
  if v_org is null or coalesce(public.sa_evaluate_permission(p_actor, 'platform.identity.delete',
       jsonb_build_object('organization_id', v_org), false)->>'decision', 'DENY') <> 'ALLOW' then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'platform.identity.delete';
  end if;
  if p_entry = 'hr' then
    select e.organization_id into v_hr_org from public.hr_employees e
    where e.user_id = p_user order by (e.organization_id = v_org) desc, e.created_at limit 1;
    if v_hr_org is null then
      raise exception 'hr_employee_not_in_organization' using errcode = '22023';
    end if;
    if coalesce(public.sa_evaluate_permission(p_actor, 'hr.employee.delete',
         jsonb_build_object('organization_id', v_hr_org), false)->>'decision', 'DENY') <> 'ALLOW' then
      raise exception 'sa_authorization_required' using errcode = '42501', detail = 'hr.employee.delete';
    end if;
  end if;
  return v_org;
end $fn$;
revoke all on function public.identity_deletion_authorize(uuid,uuid,text) from public, anon, authenticated, service_role;

-- Actor-dependent protections, appended to the plan's blockers.
create or replace function public.identity_deletion_actor_blockers(p_actor uuid, p_plan jsonb)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v jsonb := '[]'::jsonb;
  v_target uuid := (p_plan->'target'->>'user_id')::uuid;
  v_actor_level integer;
begin
  if p_actor = v_target then v := v || jsonb_build_object('code', 'SELF'); end if;
  select ro.role_level into v_actor_level from public.users u left join public.roles ro on ro.role_code = u.role_code where u.id = p_actor;
  if (p_plan->'target'->>'role_level')::integer = 1 and v_actor_level is distinct from 1 and not public.sa_actor_is_root(p_actor) then
    v := v || jsonb_build_object('code', 'PROTECTED_SUPER_ADMIN');
  end if;
  if (p_plan->'target'->>'has_identity')::boolean and p_actor <> v_target and not public.sa_actor_dominates(p_actor, v_target) then
    v := v || jsonb_build_object('code', 'TARGET_MORE_PRIVILEGED');
  end if;
  return v;
end $fn$;
revoke all on function public.identity_deletion_actor_blockers(uuid,jsonb) from public, anon, authenticated, service_role;

-- UI hint only (whether to offer the action); preview and execution decide for the target.
create or replace function public.identity_deletion_actor_check(p_actor uuid, p_entry text)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare v_org uuid;
begin
  select u.organization_id into v_org from public.users u where u.id = p_actor and u.is_active is true;
  return jsonb_build_object('permission', v_org is not null
    and coalesce(public.sa_evaluate_permission(p_actor, 'platform.identity.delete', jsonb_build_object('organization_id', v_org), false)->>'decision', 'DENY') = 'ALLOW'
    and (p_entry is distinct from 'hr'
         or coalesce(public.sa_evaluate_permission(p_actor, 'hr.employee.delete', jsonb_build_object('organization_id', v_org), false)->>'decision', 'DENY') = 'ALLOW'));
end $fn$;
revoke all on function public.identity_deletion_actor_check(uuid,text) from public, anon, authenticated;
grant execute on function public.identity_deletion_actor_check(uuid,text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Preview (no writes)
-- ---------------------------------------------------------------------------
create or replace function public.identity_deletion_preview(p_actor uuid, p_user uuid, p_entry text)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v jsonb;
  v_org uuid;
begin
  if p_user is null then raise exception 'identity_deletion_input_required' using errcode = '22023'; end if;
  v_org := public.identity_deletion_authorize(p_actor, p_user, p_entry);
  v := public.identity_deletion_plan(p_user);
  if not (v->>'found')::boolean then raise exception 'identity_deletion_target_not_found' using errcode = '22023'; end if;
  v := jsonb_set(v, '{blockers}', (v->'blockers') || public.identity_deletion_actor_blockers(p_actor, v));
  return (v - 'lock_tables') || jsonb_build_object('entry_point', p_entry, 'decision_organization_id', v_org,
                                                   'allowed', jsonb_array_length(v->'blockers') = 0);
end $fn$;
revoke all on function public.identity_deletion_preview(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.identity_deletion_preview(uuid,uuid,text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Execute (one transaction: re-check under lock, record, delete, verify)
-- ---------------------------------------------------------------------------
create or replace function public.identity_deletion_execute(
  p_actor uuid, p_user uuid, p_entry text, p_request_id uuid, p_preview_token text, p_reason text, p_confirmation text)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_existing record;
  v_seen boolean;
  v_plan jsonb;
  v_blockers jsonb;
  v_org uuid;
  v_id uuid;
  v_before jsonb := '{}'::jsonb;
  v_rows jsonb;
  x jsonb;
  t text;
  v_n integer;
  v_removed jsonb := '[]'::jsonb;
begin
  if p_request_id is null or p_user is null then
    raise exception 'identity_deletion_input_required' using errcode = '22023';
  end if;
  -- The same actor repeating the same request gets its recorded outcome (also once the identity is
  -- gone, so a retry after a failed post-commit verification works); anyone else is authorized first.
  select * into v_existing from public.identity_deletion_requests where request_id = p_request_id;
  v_seen := found;
  if v_seen and v_existing.actor_id = p_actor and v_existing.target_user_id = p_user and v_existing.entry_point = p_entry
     and exists (select 1 from public.users u where u.id = p_actor and u.is_active is true) then
    return jsonb_build_object('status', v_existing.status, 'replayed', true, 'deletion_id', v_existing.id, 'blockers', v_existing.blockers);
  end if;
  v_org := public.identity_deletion_authorize(p_actor, p_user, p_entry);
  if v_seen then
    raise exception 'identity_deletion_request_reused' using errcode = '22023';
  end if;

  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'identity_deletion_reason_required' using errcode = '22023';
  end if;

  perform set_config('lock_timeout', '5s', true);
  perform pg_advisory_xact_lock(hashtextextended('identity_deletion:' || p_user::text, 0));
  -- the same request may have committed while this one waited for the lock
  select * into v_existing from public.identity_deletion_requests where request_id = p_request_id;
  if found then
    if v_existing.actor_id <> p_actor or v_existing.target_user_id <> p_user or v_existing.entry_point <> p_entry then
      raise exception 'identity_deletion_request_reused' using errcode = '22023';
    end if;
    return jsonb_build_object('status', v_existing.status, 'replayed', true, 'deletion_id', v_existing.id, 'blockers', v_existing.blockers);
  end if;

  -- Lock the identity, its login and employment records: every concurrent insert that references
  -- them through a foreign key (KEY SHARE) now waits, so the re-check below is exact.
  perform 1 from public.users where id = p_user for update;
  perform 1 from auth.users where id = p_user for update;
  perform 1 from public.hr_employees where user_id = p_user for update;
  v_plan := public.identity_deletion_plan(p_user);
  if not (v_plan->>'found')::boolean then
    raise exception 'identity_deletion_target_not_found' using errcode = '22023';
  end if;
  -- Person columns without a foreign key: block writers to those tables until commit, then re-plan.
  for t in select distinct value from jsonb_array_elements_text(v_plan->'lock_tables') loop
    execute format('lock table public.%I in share mode', t);
  end loop;
  v_plan := public.identity_deletion_plan(p_user);

  if p_preview_token is distinct from (v_plan->>'preview_token') then
    return jsonb_build_object('status', 'stale');
  end if;
  if lower(btrim(coalesce(p_confirmation, ''))) is distinct from lower(v_plan->>'confirmation_phrase') then
    raise exception 'identity_deletion_confirmation_mismatch' using errcode = '22023';
  end if;

  v_blockers := (v_plan->'blockers') || public.identity_deletion_actor_blockers(p_actor, v_plan);
  if jsonb_array_length(v_blockers) > 0 then
    insert into public.identity_deletion_requests(request_id, actor_id, target_user_id, entry_point, organization_id, status, reason,
      preview_token, confirmation, blockers, cleanup, retained, target_snapshot)
    values (p_request_id, p_actor, p_user, p_entry, v_org, 'blocked', btrim(p_reason), p_preview_token, p_confirmation,
      v_blockers, v_plan->'cleanup', v_plan->'retained', v_plan->'target')
    returning id into v_id;
    return jsonb_build_object('status', 'blocked', 'deletion_id', v_id, 'blockers', v_blockers);
  end if;

  -- Before-image: everything that is about to be removed (never credentials).
  select coalesce(jsonb_agg(to_jsonb(x0)), '[]'::jsonb) into v_rows from public.users x0 where x0.id = p_user;
  v_before := v_before || jsonb_build_object('users', v_rows);
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'email', a.email, 'phone', a.phone, 'created_at', a.created_at,
                  'last_sign_in_at', a.last_sign_in_at, 'email_confirmed_at', a.email_confirmed_at)), '[]'::jsonb)
    into v_rows from auth.users a where a.id = p_user;
  v_before := v_before || jsonb_build_object('auth.users', v_rows);
  for x in select * from jsonb_array_elements(v_plan->'cleanup') loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%I t where t.%I = $1', x->>'table', x->>'column')
      into v_rows using p_user;
    v_before := v_before || jsonb_build_object(x->>'table', v_rows);
  end loop;

  insert into public.identity_deletion_requests(request_id, actor_id, target_user_id, entry_point, organization_id, status, reason,
    preview_token, confirmation, blockers, cleanup, retained, target_snapshot, before_image, executing_txid)
  values (p_request_id, p_actor, p_user, p_entry, v_org, 'executing', btrim(p_reason), p_preview_token, p_confirmation,
    '[]'::jsonb, v_plan->'cleanup', v_plan->'retained', v_plan->'target' || jsonb_build_object('employment', v_plan->'employment'),
    v_before, txid_current())
  returning id into v_id;

  -- Allowlisted rows (access state first, the employment anchor last), then identity, then login.
  for x in
    select value from jsonb_array_elements(v_plan->'cleanup')
    order by case value->>'table' when 'sa_role_assignments' then 1 when 'sa_organization_memberships' then 2 when 'hr_employees' then 9 else 5 end
  loop
    execute format('delete from public.%I t where t.%I = $1', x->>'table', x->>'column') using p_user;
    get diagnostics v_n = row_count;
    v_removed := v_removed || jsonb_build_object('table', x->>'table', 'count', v_n);
  end loop;
  delete from public.users where id = p_user;
  get diagnostics v_n = row_count;
  v_removed := v_removed || jsonb_build_object('table', 'users', 'count', v_n);
  delete from auth.users where id = p_user;
  get diagnostics v_n = row_count;
  v_removed := v_removed || jsonb_build_object('table', 'auth.users', 'count', v_n);

  -- Post-conditions: nothing of the identity is left (otherwise everything rolls back).
  if exists (select 1 from public.users where id = p_user) or exists (select 1 from auth.users where id = p_user)
     or exists (select 1 from public.hr_employees where user_id = p_user) then
    raise exception 'identity_deletion_incomplete' using errcode = 'P0001';
  end if;

  update public.identity_deletion_requests set status = 'completed', cleanup = v_removed, completed_at = now() where id = v_id;
  return jsonb_build_object('status', 'completed', 'deletion_id', v_id, 'removed', v_removed, 'retained', v_plan->'retained');
end $fn$;
revoke all on function public.identity_deletion_execute(uuid,uuid,text,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.identity_deletion_execute(uuid,uuid,text,uuid,text,text,text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Post-commit auth verification by the server (GoTrue admin API)
-- ---------------------------------------------------------------------------
create or replace function public.identity_deletion_record_auth_check(p_request_id uuid, p_verified boolean, p_detail text)
returns void language plpgsql volatile security definer set search_path = pg_catalog, pg_temp as $fn$
begin
  update public.identity_deletion_requests
     set auth_verified_at = now(),
         auth_verification = case when p_verified then 'verified_absent' else 'verification_failed: ' || left(coalesce(p_detail, ''), 300) end
   where request_id = p_request_id and status = 'completed'
     and (auth_verified_at is null or auth_verification like 'verification_failed%');
end $fn$;
revoke all on function public.identity_deletion_record_auth_check(uuid,boolean,text) from public, anon, authenticated;
grant execute on function public.identity_deletion_record_auth_check(uuid,boolean,text) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Post-conditions
-- ---------------------------------------------------------------------------
do $post$
begin
  if to_regprocedure('public.identity_deletion_execute(uuid,uuid,text,uuid,text,text,text)') is null
     or to_regprocedure('public.identity_deletion_preview(uuid,uuid,text)') is null then
    raise exception 'postcondition: identity deletion functions missing';
  end if;
  if has_function_privilege('authenticated', 'public.identity_deletion_execute(uuid,uuid,text,uuid,text,text,text)', 'execute')
     or has_function_privilege('anon', 'public.identity_deletion_preview(uuid,uuid,text)', 'execute')
     or has_table_privilege('service_role', 'public.identity_deletion_requests', 'insert') then
    raise exception 'postcondition: identity deletion surface exposed to API roles';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'users_history_delete_guard'
                 and tgrelid = 'public.users'::regclass and not tgisinternal and tgenabled = 'O') then
    raise exception 'postcondition: users_history_delete_guard trigger missing';
  end if;
end $post$;
