-- ============================================================================
-- HR B2A — Leave security containment
-- ----------------------------------------------------------------------------
-- Closes (B0 report SEC-1…SEC-4, verified on the 2026-10-16 production/staging schema):
--   * any staff member could insert a leave request for another employee, in any status (incl. approved);
--   * an employee could approve their own request (UPDATE policy admitted u.id = employee_id);
--   * every member of an organization could read every leave request (reasons may be medical) and balance;
--   * holders of a legacy role level / legacy compatibility policy could approve and read all leave.
--
-- Design reference: docs/hr/assessments/HR_B0_REVIEW_AND_B2_PLAN.md Task 2 (P-R13), with the owner-approved
-- implementation defaults of 2026-10-24 ("IMPLEMENT B2A and B2B"):
--   1 approvers = verified direct manager + explicitly authorized HR      5 suspicious historical rows are reported, never changed
--   2 manager = Manager Self-Service permission + verified reporting line 6 no cross-company approval (same HQ hierarchy only)
--   3 HR visibility requires explicit permission                          7 leave delegation deferred (not honoured)
--   4 only HR cancels approved leave                                      8 rollback never restores self-approval or open reads
--
-- Authority (always the authenticated account, auth.uid(); evaluated in the REQUEST's organization)
--   SELF        auth.uid() = employee_id.
--   MANAGER     explicit non-legacy hr.mss.leave_approve (decide) / hr.mss.leave_view (read) in the request's organization
--               (context: organization + owner_user_id = employee), AND hr_employees(employee, request org).manager_user_id
--               = auth.uid() with the employee's onboarding completed, AND the manager is active, not ARCHIVED and
--               onboarded in the request's organization or one of its ancestors.
--   HR          explicit non-legacy hr.leave.approve in the request's organization, or Root Access.
--   "Explicit non-legacy": sa_evaluate_permission_core(..., delegation => false, emergency => false) = ALLOW through
--   Root Access or through at least one assignment of an ACTIVE policy whose source <> 'legacy'. Legacy compatibility
--   policies (legacy-hq / legacy-power-user / legacy-sa), legacy role levels, delegations and emergency grants never
--   confer leave authority. Memberships count only in the request's organization or its ancestors (canonical
--   sa_org_ancestry): HQ HR covers its own child organizations; another HQ company is never covered.
--
-- Write rules (BEFORE INSERT/UPDATE trigger hr_leave_requests_guard, SECURITY INVOKER)
--   API roles (authenticated, anon, service_role) are always checked — there is NO service-role bypass; the caller
--   must be an active, non-ARCHIVED account (an archived account may still hold an unexpired token):
--     INSERT       self only; status draft|pending; no decision fields. On-behalf submission refused for everyone.
--     SELF         edit content while draft|pending; draft→pending; draft|pending→cancelled (cancelled_at stamped).
--     DECIDE       pending→approved|rejected by MANAGER or HR, never by the employee; only status/approval_comment may
--                  change; approved_by/approved_at are stamped by the database (client values ignored).
--     CANCEL       approved→cancelled by HR only (not by the employee, not by the manager); approver kept.
--     everything else (edit after decision, reopen, change employee/organization) is refused.
--   Database-owned code (any other role: SECURITY DEFINER functions owned by the migration owner, e.g. HR Data
--   Management reset/restore, identity lifecycle functions) is not a user-facing path and keeps working; every such
--   write is still recorded with authority 'maintenance'.
--   Error codes (errcode 42501 / 22023): hr_leave_on_behalf_refused, hr_leave_self_approval, hr_leave_not_authorized,
--   hr_leave_invalid_transition, hr_leave_immutable_field.
--
-- Row-level security (all previous policies on the three tables are dropped; listed verbatim below)
--   hr_leave_requests   SELECT self ∪ MANAGER(view|approve) ∪ HR · INSERT self (in own organization) ·
--                       UPDATE self ∪ MANAGER(approve) ∪ HR (transition rules in the trigger) · no DELETE
--   hr_leave_approvals  SELECT when the request is visible · INSERT approver = auth.uid(), approver ≠ employee and
--                       MANAGER(approve) ∪ HR for that request · no UPDATE/DELETE
--   hr_leave_balances   SELECT self ∪ MANAGER(view|approve) ∪ HR · no writes through the API (no application code writes them)
--   hr_leave_types      unchanged.
--
-- Audit: public.hr_leave_request_events — append-only (UPDATE/DELETE/TRUNCATE refused), RLS forced, no API grants,
--   written only by the AFTER trigger. No reason text, dates or attachments are copied. NO foreign keys and no column
--   matching the person-column patterns of identity deletion / employee delete (the actor is stored as actor_ref), so
--   it never blocks HR reset/restore, controlled employee delete or permanent identity deletion; like the other
--   retained audit logs it keeps the bare id after an identity is deleted. Registered in hr_reset_scope as kept.
--   Coordination (identity workstream): add 'hr_leave_request_events' to v_retained in identity_deletion_plan so the
--   deletion record lists it.
--
-- Existing data: nothing is updated. The status vocabulary (draft|pending|approved|rejected|cancelled) is enforced by
--   the guard for every API write; rows with any other (legacy) value are frozen for the API. Deliberately NO CHECK
--   constraint: even NOT VALID it applies to re-inserted rows and broke HR Data Management restore of historical rows
--   with legacy status values (replica test R6, 2026-10-24). Suspicious rows (self-approved, decided without approver,
--   unknown status) are listed by hr_leave_containment_review(org) for HR.
--
-- S&A: no catalogue, mode, grant, policy-membership or setting change. Reads S&A tables through existing functions.
-- Prerequisites (asserted): sa_evaluate_permission_core, sa_actor_is_root, sa_org_ancestry, hr_reject_append_only,
--   hr_require_onboarded_employee, tables hr_leave_requests / hr_leave_approvals / hr_leave_balances / hr_reset_scope.
--   Does NOT depend on 20261214…20261218 (B1). Idempotent. Apply manually, staging first (D-018), in one transaction:
--     psql "<db>" -X -1 -v ON_ERROR_STOP=1 -f 20261219100000_hr_leave_containment_guard.sql
--
-- ROLLBACK — SAFE (default; never re-opens self-approval, on-behalf submission or organization-wide reads)
--   Use when legitimate approvers are blocked and explicit grants cannot be fixed quickly. It temporarily lets legacy
--   compatibility policies count as HR/manager authority again; every structural rule and RLS restriction stays:
--     create or replace function public.hr_leave_actor_has_explicit(p_permission text, p_context jsonb)
--     returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $f$
--       select auth.uid() is not null
--          and exists (select 1 from public.users u where u.id = auth.uid() and u.is_active is true
--                      and coalesce(u.account_status, 'ACTIVE') <> 'ARCHIVED')
--          and (public.sa_evaluate_permission_core(auth.uid(), p_permission, p_context, false, false)->>'decision') = 'ALLOW'
--     $f$;
--   Re-apply this migration to restore the strict rule (create or replace is idempotent).
-- ROLLBACK — FULL REVERT (emergency only; requires a recorded owner decision because it RE-OPENS SEC-1…SEC-3):
--   drop trigger hr_leave_requests_guard / hr_leave_requests_record_event on hr_leave_requests; drop the B2A policies
--   and recreate the previous policies below; drop the hr_leave_* helper functions. Keep hr_leave_request_events (audit evidence).
--
-- Previous policies (production schema 2026-10-16, verbatim):
--   hr_leave_approvals_delete  FOR DELETE USING (sa_rls_gate('hr.leave.approve', organization_id, EXISTS(users u JOIN roles r
--       ON u.role_code = r.role_code WHERE u.id = auth.uid() AND r.role_level <= 10 AND u.organization_id = hr_leave_approvals.organization_id))
--       OR (sa_rls_new_mode('hr.leave.approve') AND EXISTS(users u WHERE u.id = auth.uid() AND false AND u.organization_id = hr_leave_approvals.organization_id)))
--   hr_leave_approvals_insert  FOR INSERT WITH CHECK (same shape, role_level <= 20)
--   hr_leave_approvals_select  FOR SELECT USING (organization_id IN (SELECT users.organization_id FROM users WHERE users.id = auth.uid()))
--   hr_leave_approvals_update  FOR UPDATE USING (same shape as insert, role_level <= 20)
--   hr_leave_balances_delete   FOR DELETE USING (sa_rls_gate('hr.leave.approve', organization_id, <role_level <= 10 same org>) OR (new-mode false branch))
--   hr_leave_balances_insert   FOR INSERT WITH CHECK (sa_rls_gate('hr.leave.approve', organization_id, <role_level <= 20 same org>) OR (new-mode false branch))
--   hr_leave_balances_select   FOR SELECT USING (organization_id IN (SELECT users.organization_id FROM users WHERE users.id = auth.uid()))
--   hr_leave_balances_update   FOR UPDATE USING (sa_rls_gate('hr.leave.approve', organization_id, <role_level <= 20 same org>) OR (new-mode false branch))
--   hr_leave_requests_delete   FOR DELETE USING (sa_rls_gate('hr.leave.approve', organization_id, <role_level <= 10 same org>) OR (new-mode false branch))
--   hr_leave_requests_insert   FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.organization_id = hr_leave_requests.organization_id))
--   hr_leave_requests_select   FOR SELECT USING (organization_id IN (SELECT users.organization_id FROM users WHERE users.id = auth.uid()))
--   hr_leave_requests_update   FOR UPDATE USING (sa_rls_gate('hr.leave.approve', organization_id, EXISTS(users u LEFT JOIN roles r
--       ON u.role_code = r.role_code WHERE u.id = auth.uid() AND u.organization_id = hr_leave_requests.organization_id
--       AND (u.id = hr_leave_requests.employee_id OR r.role_level <= 20))) OR (new-mode false branch))
--   The full text is preserved in supabase/schemas/audit/production_schema_20261016.sql (CREATE POLICY hr_leave_*).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Prerequisites
-- ---------------------------------------------------------------------------
do $pre$
begin
  if to_regprocedure('public.sa_evaluate_permission_core(uuid,text,jsonb,boolean,boolean)') is null
     or to_regprocedure('public.sa_actor_is_root(uuid)') is null
     or to_regprocedure('public.sa_org_ancestry(uuid)') is null
     or to_regprocedure('public.hr_reject_append_only()') is null
     or to_regprocedure('public.hr_require_onboarded_employee()') is null then
    raise exception 'hr_leave_containment: S&A / HR prerequisite functions missing';
  end if;
  if to_regclass('public.hr_leave_requests') is null or to_regclass('public.hr_leave_approvals') is null
     or to_regclass('public.hr_leave_balances') is null or to_regclass('public.hr_reset_scope') is null
     or to_regclass('public.hr_employees') is null or to_regclass('public.sa_business_roles') is null then
    raise exception 'hr_leave_containment: prerequisite tables missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sa_business_roles' and column_name = 'source')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'hr_leave_requests' and column_name = 'approved_by')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'account_status') then
    raise exception 'hr_leave_containment: prerequisite columns missing';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Audit events (append-only, no foreign keys)
-- ---------------------------------------------------------------------------
create table if not exists public.hr_leave_request_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  request_id      uuid not null,
  actor_ref       uuid,                       -- auth.uid() of the API caller; null for database-owned maintenance
  actor_db_role   text not null,
  authority       text not null check (authority in ('self', 'manager', 'hr', 'root', 'maintenance')),
  action          text not null check (action in ('insert', 'update', 'status_change')),
  from_status     text,
  to_status       text,
  changed_columns text[] not null default '{}',
  occurred_at     timestamptz not null default now()
);
create index if not exists hr_leave_request_events_request_idx on public.hr_leave_request_events (request_id, occurred_at);
create index if not exists hr_leave_request_events_org_idx on public.hr_leave_request_events (organization_id, occurred_at);
comment on table public.hr_leave_request_events is
  'B2A: append-only record of every insert/update of hr_leave_requests (who, under which authority, which status change, which columns). No reason text or dates. No foreign keys by design (never blocks reset/restore or identity deletion).';
alter table public.hr_leave_request_events enable row level security;
alter table public.hr_leave_request_events force row level security;
revoke all on table public.hr_leave_request_events from public, anon, authenticated, service_role;
drop trigger if exists hr_leave_request_events_append_only on public.hr_leave_request_events;
create trigger hr_leave_request_events_append_only before update or delete on public.hr_leave_request_events
  for each row execute function public.hr_reject_append_only();
drop trigger if exists hr_leave_request_events_no_truncate on public.hr_leave_request_events;
create trigger hr_leave_request_events_no_truncate before truncate on public.hr_leave_request_events
  for each statement execute function public.hr_reject_append_only();

insert into public.hr_reset_scope(table_name, category, action, delete_order, label)
select 'hr_leave_request_events', 'not_in_scope', 'keep', null, 'Leave audit events (append-only, kept)'
where not exists (select 1 from public.hr_reset_scope where table_name = 'hr_leave_request_events');

-- ---------------------------------------------------------------------------
-- 2. Authority helpers (SECURITY DEFINER predicates about auth.uid() only; they never take an actor argument)
-- ---------------------------------------------------------------------------
create or replace function public.hr_leave_actor_has_explicit(p_permission text, p_context jsonb)
returns boolean language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_uid uuid := auth.uid();
  v_key text;
  v_val text;
  v jsonb;
begin
  if v_uid is null or p_permission is null then return false; end if;
  -- per-transaction memo (same pattern as sa_cached_actor_allows; sa_cache.epoch invalidates it)
  v_key := 'hr_leave.c' || md5(coalesce(current_setting('sa_cache.epoch', true), '') || '|' || v_uid::text || '|' || p_permission || '|' || coalesce(p_context::text, ''));
  v_val := current_setting(v_key, true);
  if v_val in ('t', 'f') then return v_val = 't'; end if;

  v_val := 'f';
  if exists (select 1 from public.users u where u.id = v_uid and u.is_active is true and coalesce(u.account_status, 'ACTIVE') <> 'ARCHIVED') then
    v := public.sa_evaluate_permission_core(v_uid, p_permission, coalesce(p_context, '{}'::jsonb), false, false);
    if v->>'decision' = 'ALLOW' then
      if v->>'reason_code' = 'ALLOWED_BY_ROOT_ACCESS' then
        v_val := 't';
      elsif v->>'reason_code' = 'ALLOWED_BY_ASSIGNMENT' and exists (
              select 1 from jsonb_array_elements(coalesce(v->'matched_assignments', '[]'::jsonb)) m
              join public.sa_business_roles br on br.id = nullif(m->>'roleId', '')::uuid
              where br.status = 'active' and br.source <> 'legacy') then
        v_val := 't';
      end if;
    end if;
  end if;
  perform set_config(v_key, v_val, true);
  return v_val = 't';
end $fn$;

create or replace function public.hr_leave_hr_authority(p_org uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select p_org is not null and public.hr_leave_actor_has_explicit('hr.leave.approve', jsonb_build_object('organization_id', p_org))
$fn$;

create or replace function public.hr_leave_manager_authority(p_org uuid, p_employee uuid, p_permission text)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select auth.uid() is not null and p_org is not null and p_employee is not null and p_employee <> auth.uid()
     and p_permission in ('hr.mss.leave_approve', 'hr.mss.leave_view')
     and exists (select 1 from public.hr_employees e
                 where e.user_id = p_employee and e.organization_id = p_org
                   and e.manager_user_id = auth.uid() and e.onboarding_status = 'completed')
     and exists (select 1 from public.users m where m.id = auth.uid() and m.is_active is true
                   and coalesce(m.account_status, 'ACTIVE') <> 'ARCHIVED')
     and exists (select 1 from public.hr_employees me
                 where me.user_id = auth.uid() and me.onboarding_status = 'completed'
                   and me.organization_id = any(public.sa_org_ancestry(p_org)))
     and public.hr_leave_actor_has_explicit(p_permission,
           jsonb_build_object('organization_id', p_org, 'owner_user_id', p_employee))
$fn$;

create or replace function public.hr_leave_can_view(p_org uuid, p_employee uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select auth.uid() is not null and (
         p_employee = auth.uid()
      or public.hr_leave_hr_authority(p_org)
      or public.hr_leave_manager_authority(p_org, p_employee, 'hr.mss.leave_view')
      or public.hr_leave_manager_authority(p_org, p_employee, 'hr.mss.leave_approve'))
$fn$;

create or replace function public.hr_leave_can_decide(p_org uuid, p_employee uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select auth.uid() is not null and p_employee is distinct from auth.uid() and (
         public.hr_leave_hr_authority(p_org)
      or public.hr_leave_manager_authority(p_org, p_employee, 'hr.mss.leave_approve'))
$fn$;

-- Which authority decides (null = none). Root first, then HR, then the direct manager.
create or replace function public.hr_leave_decider_authority(p_org uuid, p_employee uuid)
returns text language sql stable security definer set search_path = pg_catalog, pg_temp as $fn$
  select case
    when auth.uid() is null or p_employee is not distinct from auth.uid() then null
    when public.sa_actor_is_root(auth.uid()) and public.hr_leave_hr_authority(p_org) then 'root'
    when public.hr_leave_hr_authority(p_org) then 'hr'
    when public.hr_leave_manager_authority(p_org, p_employee, 'hr.mss.leave_approve') then 'manager'
  end
$fn$;

revoke all on function public.hr_leave_actor_has_explicit(text, jsonb) from public, anon;
revoke all on function public.hr_leave_hr_authority(uuid) from public, anon;
revoke all on function public.hr_leave_manager_authority(uuid, uuid, text) from public, anon;
revoke all on function public.hr_leave_can_view(uuid, uuid) from public, anon;
revoke all on function public.hr_leave_can_decide(uuid, uuid) from public, anon;
revoke all on function public.hr_leave_decider_authority(uuid, uuid) from public, anon;
grant execute on function public.hr_leave_actor_has_explicit(text, jsonb) to authenticated, service_role;
grant execute on function public.hr_leave_hr_authority(uuid) to authenticated, service_role;
grant execute on function public.hr_leave_manager_authority(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.hr_leave_can_view(uuid, uuid) to authenticated, service_role;
grant execute on function public.hr_leave_can_decide(uuid, uuid) to authenticated, service_role;
grant execute on function public.hr_leave_decider_authority(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Transition guard (SECURITY INVOKER: current_user is the statement's role) and event recorder
-- ---------------------------------------------------------------------------
create or replace function public.hr_leave_requests_guard()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $fn$
declare
  v_uid uuid := auth.uid();
  v_role text := current_user;
  v_auth text;
  -- columns an approver may set besides the database stamps
  c_decision constant text[] := array['status', 'approval_comment', 'approved_by', 'approved_at', 'updated_at'];
  -- columns that never change through a self-service edit
  c_decided constant text[] := array['approved_by', 'approved_at', 'approval_comment', 'cancelled_at'];
begin
  if v_role not in ('authenticated', 'anon', 'service_role') then
    -- database-owned code (reset/restore, identity lifecycle, migrations): not a user-facing path
    perform set_config('hr_leave.e' || replace(new.id::text, '-', ''), 'maintenance|' || v_role, true);
    return new;
  end if;
  if v_uid is null then
    raise exception 'hr_leave_not_authorized' using errcode = '42501', detail = 'An authenticated employee is required.';
  end if;
  -- an archived/deactivated account can still hold an unexpired token until it lapses: refuse every write
  if not exists (select 1 from public.users u where u.id = v_uid and u.is_active is true
                 and coalesce(u.account_status, 'ACTIVE') <> 'ARCHIVED') then
    raise exception 'hr_leave_not_authorized' using errcode = '42501', detail = 'The account is not active.';
  end if;

  if tg_op = 'INSERT' then
    if new.employee_id is distinct from v_uid then
      raise exception 'hr_leave_on_behalf_refused' using errcode = '42501',
        detail = 'Leave can only be submitted by the employee themself.';
    end if;
    if new.status is null or new.status not in ('draft', 'pending')
       or new.approved_by is not null or new.approved_at is not null or new.approval_comment is not null or new.cancelled_at is not null then
      raise exception 'hr_leave_invalid_transition' using errcode = '22023',
        detail = 'A new request starts as draft or pending, without decision fields.';
    end if;
    perform set_config('hr_leave.e' || replace(new.id::text, '-', ''), 'self|' || v_role, true);
    return new;
  end if;

  -- UPDATE
  if new.id is distinct from old.id or new.employee_id is distinct from old.employee_id
     or new.organization_id is distinct from old.organization_id or new.created_at is distinct from old.created_at then
    raise exception 'hr_leave_immutable_field' using errcode = '42501',
      detail = 'The employee, organization and identity of a leave request cannot change.';
  end if;

  if new.status is not distinct from old.status then
    -- content edit: only the employee, only while draft/pending, decision fields untouched
    if v_uid = old.employee_id and old.status in ('draft', 'pending')
       and (select bool_and(to_jsonb(new)->k is not distinct from to_jsonb(old)->k) from unnest(c_decided) k) then
      perform set_config('hr_leave.e' || replace(new.id::text, '-', ''), 'self|' || v_role, true);
      return new;
    end if;
    raise exception 'hr_leave_invalid_transition' using errcode = '22023',
      detail = format('A %s request cannot be edited by this account.', old.status);
  end if;

  -- self-service status changes
  if (old.status = 'draft' and new.status in ('pending', 'cancelled')) or (old.status = 'pending' and new.status = 'cancelled') then
    if v_uid <> old.employee_id then
      raise exception 'hr_leave_not_authorized' using errcode = '42501', detail = 'Only the employee can submit or withdraw their request.';
    end if;
    if new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at
       or new.approval_comment is distinct from old.approval_comment then
      raise exception 'hr_leave_invalid_transition' using errcode = '22023';
    end if;
    new.cancelled_at := case when new.status = 'cancelled' then now() else old.cancelled_at end;
    perform set_config('hr_leave.e' || replace(new.id::text, '-', ''), 'self|' || v_role, true);
    return new;
  end if;

  -- decision
  if old.status = 'pending' and new.status in ('approved', 'rejected') then
    if v_uid = old.employee_id then
      raise exception 'hr_leave_self_approval' using errcode = '42501', detail = 'An employee cannot decide their own leave.';
    end if;
    v_auth := public.hr_leave_decider_authority(old.organization_id, old.employee_id);
    if v_auth is null then
      raise exception 'hr_leave_not_authorized' using errcode = '42501',
        detail = 'Only the direct manager (Manager Self-Service) or explicitly authorized HR can decide this request.';
    end if;
    if (to_jsonb(new) - c_decision) is distinct from (to_jsonb(old) - c_decision) then
      raise exception 'hr_leave_invalid_transition' using errcode = '22023', detail = 'A decision cannot change the request content.';
    end if;
    new.approved_by := v_uid;
    new.approved_at := now();
    perform set_config('hr_leave.e' || replace(new.id::text, '-', ''), v_auth || '|' || v_role, true);
    return new;
  end if;

  -- cancellation of approved leave: explicit HR (or Root) only
  if old.status = 'approved' and new.status = 'cancelled' then
    if v_uid = old.employee_id then
      raise exception 'hr_leave_invalid_transition' using errcode = '22023', detail = 'Approved leave can only be cancelled by HR.';
    end if;
    v_auth := case when public.hr_leave_hr_authority(old.organization_id)
                   then case when public.sa_actor_is_root(v_uid) then 'root' else 'hr' end end;
    if v_auth is null then
      raise exception 'hr_leave_not_authorized' using errcode = '42501', detail = 'Approved leave can only be cancelled by HR.';
    end if;
    if (to_jsonb(new) - c_decision - 'cancelled_at') is distinct from (to_jsonb(old) - c_decision - 'cancelled_at') then
      raise exception 'hr_leave_invalid_transition' using errcode = '22023', detail = 'A cancellation cannot change the request content.';
    end if;
    new.approved_by := old.approved_by;
    new.approved_at := old.approved_at;
    new.cancelled_at := now();
    perform set_config('hr_leave.e' || replace(new.id::text, '-', ''), v_auth || '|' || v_role, true);
    return new;
  end if;

  raise exception 'hr_leave_invalid_transition' using errcode = '22023',
    detail = format('%s → %s is not an allowed leave transition.', old.status, new.status);
end $fn$;
revoke all on function public.hr_leave_requests_guard() from public, anon, authenticated, service_role;

create or replace function public.hr_leave_requests_record_event()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $fn$
declare
  v_key text := 'hr_leave.e' || replace(new.id::text, '-', '');
  v_tag text := nullif(current_setting(v_key, true), '');
  v_changed text[] := '{}';
begin
  if v_tag is null then
    raise exception 'hr_leave_audit_context_missing' using errcode = '55000';   -- the guard did not run: refuse
  end if;
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(k order by k), '{}') into v_changed
    from jsonb_object_keys(to_jsonb(new)) k
    where k <> 'updated_at' and to_jsonb(new)->k is distinct from to_jsonb(old)->k;
  end if;
  insert into public.hr_leave_request_events(organization_id, request_id, actor_ref, actor_db_role, authority, action,
                                             from_status, to_status, changed_columns)
  values (new.organization_id, new.id, auth.uid(), split_part(v_tag, '|', 2), split_part(v_tag, '|', 1),
          case when tg_op = 'INSERT' then 'insert' when new.status is distinct from old.status then 'status_change' else 'update' end,
          case when tg_op = 'UPDATE' then old.status end, new.status, v_changed);
  perform set_config(v_key, '', true);
  return null;
end $fn$;
revoke all on function public.hr_leave_requests_record_event() from public, anon, authenticated, service_role;

drop trigger if exists hr_leave_requests_guard on public.hr_leave_requests;
create trigger hr_leave_requests_guard before insert or update on public.hr_leave_requests
  for each row execute function public.hr_leave_requests_guard();
drop trigger if exists hr_leave_requests_record_event on public.hr_leave_requests;
create trigger hr_leave_requests_record_event after insert or update on public.hr_leave_requests
  for each row execute function public.hr_leave_requests_record_event();

-- ---------------------------------------------------------------------------
-- 4. Status vocabulary: enforced by the guard for API writes only (see header). Remove a CHECK left by any
--    pre-release build of this migration, so restore of historical rows keeps working.
-- ---------------------------------------------------------------------------
alter table public.hr_leave_requests drop constraint if exists hr_leave_requests_status_chk;

-- ---------------------------------------------------------------------------
-- 5. Row-level security (replace every existing policy on the three tables)
-- ---------------------------------------------------------------------------
do $drop$
declare p record;
begin
  for p in select tablename, policyname from pg_policies
           where schemaname = 'public' and tablename in ('hr_leave_requests', 'hr_leave_approvals', 'hr_leave_balances')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $drop$;
alter table public.hr_leave_requests enable row level security;
alter table public.hr_leave_approvals enable row level security;
alter table public.hr_leave_balances enable row level security;

create policy hr_leave_requests_b2a_select on public.hr_leave_requests for select to authenticated
  using (employee_id = auth.uid() or public.hr_leave_can_view(organization_id, employee_id));
create policy hr_leave_requests_b2a_insert on public.hr_leave_requests for insert to authenticated
  with check (employee_id = auth.uid()
              and exists (select 1 from public.users u where u.id = auth.uid() and u.organization_id = hr_leave_requests.organization_id));
create policy hr_leave_requests_b2a_update on public.hr_leave_requests for update to authenticated
  using (employee_id = auth.uid() or public.hr_leave_can_decide(organization_id, employee_id))
  with check (employee_id = auth.uid() or public.hr_leave_can_decide(organization_id, employee_id));

create policy hr_leave_approvals_b2a_select on public.hr_leave_approvals for select to authenticated
  using (exists (select 1 from public.hr_leave_requests r where r.id = hr_leave_approvals.request_id));
create policy hr_leave_approvals_b2a_insert on public.hr_leave_approvals for insert to authenticated
  with check (approver_id = auth.uid()
              and exists (select 1 from public.hr_leave_requests r
                          where r.id = hr_leave_approvals.request_id
                            and r.organization_id = hr_leave_approvals.organization_id
                            and r.employee_id <> auth.uid()
                            and public.hr_leave_can_decide(r.organization_id, r.employee_id)));

create policy hr_leave_balances_b2a_select on public.hr_leave_balances for select to authenticated
  using (employee_id = auth.uid() or public.hr_leave_can_view(organization_id, employee_id));

-- ---------------------------------------------------------------------------
-- 6. Review of suspicious historical rows (explicit HR of the organization only; read-only)
-- ---------------------------------------------------------------------------
create or replace function public.hr_leave_containment_review(p_org uuid)
returns table (request_id uuid, employee_id uuid, finding text, status text, approved_by uuid, approved_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $fn$
begin
  if not public.hr_leave_hr_authority(p_org) then
    raise exception 'hr_leave_not_authorized' using errcode = '42501';
  end if;
  return query
    select r.id, r.employee_id,
           case when r.status not in ('draft', 'pending', 'approved', 'rejected', 'cancelled') then 'unknown_status'
                when r.approved_by is not null and r.approved_by = r.employee_id then 'self_approved'
                else 'approved_without_approver' end,
           r.status, r.approved_by, r.approved_at
    from public.hr_leave_requests r
    where r.organization_id = p_org
      and (r.status not in ('draft', 'pending', 'approved', 'rejected', 'cancelled')
           or (r.approved_by is not null and r.approved_by = r.employee_id)
           or (r.status in ('approved', 'rejected') and r.approved_by is null))
    order by r.created_at;
end $fn$;
revoke all on function public.hr_leave_containment_review(uuid) from public, anon;
grant execute on function public.hr_leave_containment_review(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Post-conditions
-- ---------------------------------------------------------------------------
do $post$
begin
  if exists (select 1 from pg_policies where schemaname = 'public'
             and tablename in ('hr_leave_requests', 'hr_leave_approvals', 'hr_leave_balances') and policyname not like '%\_b2a\_%') then
    raise exception 'hr_leave_containment: unexpected policy left on a leave table';
  end if;
  if (select count(*) from pg_trigger where tgrelid = 'public.hr_leave_requests'::regclass
      and tgname in ('hr_leave_requests_guard', 'hr_leave_requests_record_event') and not tgisinternal) <> 2 then
    raise exception 'hr_leave_containment: triggers missing';
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.hr_leave_request_events'::regclass and contype = 'f') then
    raise exception 'hr_leave_containment: events table must not have foreign keys';
  end if;
end $post$;
