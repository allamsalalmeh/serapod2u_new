-- ============================================================================
-- Security & Access — Migration Modes: optional note for forward changes, required reason for rollbacks, and
-- bulk "New Access Active" keeps Legacy Retired permissions
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database,
-- so nothing in this file has been run against a real database (throwaway PostgreSQL 17 restored from a schema-only
-- staging dump: supabase/tests/security/sa_mode_note_keep_retired/run.sh).
--
-- 1. Reason rule (one definition, shared by the single and the group change; mirrored in
--    app/src/lib/security-access/mode-change-rules.ts and enforced again by the API routes):
--      * an actual change TO LEGACY_ENFORCED or SHADOW (going back to legacy authorization or to monitoring)
--        requires a reason of at least 10 characters;
--      * a change TO NEW_ENFORCED or LEGACY_RETIRED takes an optional note (blank = none, at most 500 characters).
--    When no note is given, the audit row still carries text: an accurate description generated here, e.g.
--      "Migration mode of inventory.transfer.view changed from Monitoring / Shadow to New Access Active. No note provided."
--    sa_access_change_log.details records { from, to, module, note (null when none), reason_generated, batch_id? };
--    actor and timestamp are the row's actor_id / occurred_at, as before. sa_migration_modes.notes keeps the note or
--    the generated description; sa_migration_mode_batches.reason keeps the batch note or a generated description.
--
-- 2. Bulk change to NEW_ENFORCED keeps LEGACY_RETIRED permissions. They already use only the new model; moving them
--    back to NEW_ENFORCED would re-introduce legacy diagnostics. sa_bulk_mode_evaluate (the single eligibility
--    source used by BOTH preview and apply) now returns status 'kept_retired' for them: not changed, not blocked,
--    not counted against "All permissions". The apply re-evaluates under row locks, so preview and execution follow
--    the same rule. Batch results list them as 'kept_retired' and count them (keptRetired / kept_retired_count).
--    The individual control (sa_set_migration_mode) still lets an administrator move one retired permission back to
--    NEW_ENFORCED explicitly. Blocked permissions, readiness, the retire-from-NEW rule, the All vs Eligible-only
--    safeguards, stale-preview rejection, idempotent replay and the administrator-lockout check are unchanged.
--
-- Not changed: no migration mode, grant or assignment. Function signatures and grants are unchanged.
--
-- Order: requires 20261004100000_sa_bulk_migration_mode.sql and 20261008100000_sa_mode_governance_actor_context.sql
-- (whose function bodies this replaces). Independent of 20261019100000. Repeat-safe.
--
-- Rollback: re-run the function definitions of 20261008100000_sa_mode_governance_actor_context.sql and the
-- sa_bulk_mode_evaluate definition of 20261004100000_sa_bulk_migration_mode.sql;
--   alter table public.sa_migration_mode_batches drop column if exists kept_retired_count;
--   drop function if exists public.sa_mode_reason_required(text, text);
--   drop function if exists public.sa_mode_display_label(text);
--   drop function if exists public.sa_mode_change_description(text, text, text);
-- Audit rows already written stay (append-only).
-- ============================================================================

alter table public.sa_migration_mode_batches add column if not exists kept_retired_count integer not null default 0;

-- ---------------------------------------------------------------------------
-- Shared rules
-- ---------------------------------------------------------------------------
-- True when an ACTUAL change from p_from to p_to needs a written reason (going back to legacy / monitoring).
create or replace function public.sa_mode_reason_required(p_from text, p_to text)
returns boolean language sql immutable set search_path = pg_catalog, pg_temp as $$
  select p_to in ('LEGACY_ENFORCED','SHADOW') and p_from is distinct from p_to
$$;
revoke all on function public.sa_mode_reason_required(text, text) from public, anon, authenticated;

-- Same names as the Migration Modes screen (labels.ts MODE_LABELS).
create or replace function public.sa_mode_display_label(p_mode text)
returns text language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case p_mode
    when 'LEGACY_ENFORCED' then 'Legacy enforced'
    when 'SHADOW' then 'Monitoring / Shadow'
    when 'NEW_ENFORCED' then 'New Access Active'
    when 'LEGACY_RETIRED' then 'Legacy Retired'
    else coalesce(p_mode, 'unregistered') end
$$;
revoke all on function public.sa_mode_display_label(text) from public, anon, authenticated;

create or replace function public.sa_mode_change_description(p_permission text, p_from text, p_to text)
returns text language sql immutable set search_path = pg_catalog, pg_temp as $$
  select format('Migration mode of %s changed from %s to %s. No note provided.',
                p_permission, public.sa_mode_display_label(p_from), public.sa_mode_display_label(p_to))
$$;
revoke all on function public.sa_mode_change_description(text, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Single change (also used for every permission of a batch)
-- ---------------------------------------------------------------------------
create or replace function public.sa_apply_migration_mode(p_actor uuid, p_permission text, p_mode text, p_reason text, p_batch_id uuid)
returns text language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_current text;
  v_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role';
  v_note text := nullif(btrim(coalesce(p_reason, '')), '');
  v_text text;
begin
  if p_mode is null or p_mode not in ('LEGACY_ENFORCED','SHADOW','NEW_ENFORCED','LEGACY_RETIRED') then raise exception 'sa_mode_invalid'; end if;
  if length(v_note) > 500 then raise exception 'sa_reason_too_long'; end if;
  -- A human actor is required for every API-originated change; only a direct
  -- database-owner session (reviewed cutover SQL) may act as 'system'.
  if p_actor is null and v_role is not null then raise exception 'sa_actor_required' using errcode = '42501'; end if;
  if p_actor is not null then
    perform public.sa_assert_actor_permission(p_actor, 'security.permission.manage', public.sa_actor_org_context(p_actor), public.sa_legacy_is_super_admin(p_actor));
  end if;
  select mode into v_current from public.sa_migration_modes where permission_key = p_permission for update;
  if not found then raise exception 'sa_permission_unknown: %', p_permission; end if;
  if p_mode in ('NEW_ENFORCED','LEGACY_RETIRED')
     and not exists (select 1 from public.sa_enforcement_readiness where permission_key = p_permission) then
    raise exception 'sa_not_enforcement_ready: %', p_permission using hint = 'Every mutation path must be wired before enforcement.';
  end if;
  if p_mode = 'LEGACY_RETIRED' and v_current not in ('NEW_ENFORCED','LEGACY_RETIRED') then
    raise exception 'sa_retire_requires_new_enforced: %', p_permission;
  end if;
  if v_current = p_mode then return v_current; end if;
  if public.sa_mode_reason_required(v_current, p_mode) and (v_note is null or length(v_note) < 10) then
    raise exception 'sa_reason_required' using hint = 'Moving back to Legacy enforced or Monitoring / Shadow needs a reason of at least 10 characters.';
  end if;
  v_text := coalesce(v_note, public.sa_mode_change_description(p_permission, v_current, p_mode));
  update public.sa_migration_modes set mode = p_mode, updated_at = now(), updated_by = p_actor, notes = left(v_text, 500)
  where permission_key = p_permission;
  perform public.sa_log_access_change(p_actor, 'migration_mode.changed', null, 'sa_migration_mode', p_permission,
    jsonb_build_object('from', v_current, 'to', p_mode, 'module', split_part(p_permission, '.', 1),
                       'note', v_note, 'reason_generated', v_note is null)
      || case when p_batch_id is null then '{}'::jsonb else jsonb_build_object('batch_id', p_batch_id) end,
    v_text, case when p_actor is null then 'system' else 'user' end);
  return p_mode;
end $$;
revoke all on function public.sa_apply_migration_mode(uuid,text,text,text,uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Eligibility (preview AND apply)
-- ---------------------------------------------------------------------------
create or replace function public.sa_bulk_mode_evaluate(p_permissions text[], p_target text)
returns table(permission_key text, current_mode text, status text, blockers text[])
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  with input as (select distinct k from unnest(p_permissions) as k)
  select i.k,
         m.mode,
         case when m.permission_key is null then 'blocked'
              when cardinality(b.list) > 0 then 'blocked'
              when m.mode = p_target then 'unchanged'
              -- Already using only the new model: a group move to New Access Active keeps it retired.
              when p_target = 'NEW_ENFORCED' and m.mode = 'LEGACY_RETIRED' then 'kept_retired'
              else 'change' end,
         b.list
  from input i
  left join public.sa_migration_modes m on m.permission_key = i.k
  cross join lateral (
    select array_remove(array[
      case when m.permission_key is null then 'sa_permission_unknown' end,
      case when m.permission_key is not null and p_target in ('NEW_ENFORCED','LEGACY_RETIRED')
                and not exists (select 1 from public.sa_enforcement_readiness r where r.permission_key = i.k)
           then 'sa_not_enforcement_ready' end,
      case when m.permission_key is not null and p_target = 'LEGACY_RETIRED'
                and m.mode not in ('NEW_ENFORCED','LEGACY_RETIRED')
           then 'sa_retire_requires_new_enforced' end
    ], null) as list
  ) b
  order by i.k
$$;
revoke all on function public.sa_bulk_mode_evaluate(text[],text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Group change
-- ---------------------------------------------------------------------------
create or replace function public.sa_bulk_set_migration_mode(
  p_actor uuid, p_permissions text[], p_expected jsonb, p_target text, p_reason text,
  p_group_id text, p_selection text, p_idempotency_key uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_batch uuid := gen_random_uuid();
  v_hash text;
  v_existing public.sa_migration_mode_batches%rowtype;
  v_keys text[];
  v_locked integer;
  v_stale text;
  v_blocked integer;
  v_changes text[];
  v_key text;
  v_items jsonb;
  v_changed integer;
  v_unchanged integer;
  v_skipped integer;
  v_kept integer;
  v_result jsonb;
  v_note text := nullif(btrim(coalesce(p_reason, '')), '');
  v_text text;
begin
  if p_target is null or p_target not in ('LEGACY_ENFORCED','SHADOW','NEW_ENFORCED','LEGACY_RETIRED') then raise exception 'sa_mode_invalid'; end if;
  if length(v_note) > 500 then raise exception 'sa_reason_too_long'; end if;
  if p_actor is null then raise exception 'sa_actor_required' using errcode = '42501'; end if;
  if p_selection is null or p_selection not in ('all','eligible_only') then raise exception 'sa_bulk_selection_invalid'; end if;
  if p_idempotency_key is null or p_group_id is null or length(btrim(p_group_id)) = 0 then raise exception 'sa_bulk_selection_invalid'; end if;
  if p_permissions is null or cardinality(p_permissions) = 0 or cardinality(p_permissions) > 500
     or p_expected is null or jsonb_typeof(p_expected) <> 'object' then raise exception 'sa_bulk_selection_invalid'; end if;

  perform public.sa_assert_actor_permission(p_actor, 'security.permission.manage', public.sa_actor_org_context(p_actor), public.sa_legacy_is_super_admin(p_actor));

  select coalesce(array_agg(distinct k order by k), '{}') into v_keys from unnest(p_permissions) as k;
  if cardinality(v_keys) <> cardinality(p_permissions) then raise exception 'sa_bulk_selection_invalid'; end if;
  v_hash := md5(p_group_id || '|' || p_target || '|' || p_selection || '|' || array_to_string(v_keys, ',') || '|' || p_expected::text);

  -- Repeated submission: the second caller waits here, then replays the stored
  -- result without changing or auditing anything again.
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text || ':' || p_idempotency_key::text, 0));
  select * into v_existing from public.sa_migration_mode_batches where actor_id = p_actor and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_hash <> v_hash then raise exception 'sa_bulk_idempotency_conflict'; end if;
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;

  -- Lock every selected row, then require the exact set and modes previewed.
  select count(*) into v_locked from (
    select 1 from public.sa_migration_modes where permission_key = any(v_keys) order by permission_key for update
  ) l;
  if v_locked <> cardinality(v_keys) then raise exception 'sa_bulk_stale_preview' using detail = 'group membership changed'; end if;
  if (select count(*) from jsonb_object_keys(p_expected)) <> cardinality(v_keys) then raise exception 'sa_bulk_stale_preview' using detail = 'selection changed'; end if;
  select m.permission_key into v_stale from public.sa_migration_modes m
    where m.permission_key = any(v_keys) and (p_expected ->> m.permission_key) is distinct from m.mode limit 1;
  if v_stale is not null then raise exception 'sa_bulk_stale_preview' using detail = v_stale; end if;

  select count(*) into v_blocked from public.sa_bulk_mode_evaluate(v_keys, p_target) where status = 'blocked';
  if p_selection = 'all' and v_blocked > 0 then raise exception 'sa_bulk_blocked: %', v_blocked; end if;
  select coalesce(array_agg(permission_key order by (permission_key = 'security.permission.manage'), permission_key), '{}') into v_changes
    from public.sa_bulk_mode_evaluate(v_keys, p_target) where status = 'change';
  if cardinality(v_changes) = 0 then raise exception 'sa_bulk_no_changes'; end if;
  -- Every permission that changes moves to p_target, so one rule covers the batch.
  if public.sa_mode_reason_required(null, p_target) and (v_note is null or length(v_note) < 10) then
    raise exception 'sa_reason_required' using hint = 'Moving back to Legacy enforced or Monitoring / Shadow needs a reason of at least 10 characters.';
  end if;

  -- Snapshot of what this batch does (taken before any change is applied).
  select jsonb_agg(jsonb_build_object(
           'permissionKey', e.permission_key, 'from', e.current_mode,
           'to', case when e.status = 'change' then p_target else e.current_mode end,
           'status', case e.status when 'change' then 'changed' when 'blocked' then 'skipped'
                                   when 'kept_retired' then 'kept_retired' else 'unchanged' end,
           'blockers', to_jsonb(e.blockers)) order by e.permission_key)
    into v_items from public.sa_bulk_mode_evaluate(v_keys, p_target) e;

  -- Same validation and audit as a single change; any failure aborts the batch.
  foreach v_key in array v_changes loop
    perform public.sa_apply_migration_mode(p_actor, v_key, p_target, v_note, v_batch);
  end loop;

  -- Administrator-lockout guard: the actor must still hold the authority they
  -- just used (e.g. security.permission.manage moved to NEW_ENFORCED).
  perform set_config('sa_cache.epoch', gen_random_uuid()::text, true);
  begin
    perform public.sa_assert_actor_permission(p_actor, 'security.permission.manage', public.sa_actor_org_context(p_actor), public.sa_legacy_is_super_admin(p_actor));
  exception when others then
    raise exception 'sa_bulk_actor_lockout' using hint = 'This change would remove your own authority to manage permissions.';
  end;

  select count(*) filter (where i->>'status' = 'changed'), count(*) filter (where i->>'status' = 'unchanged'),
         count(*) filter (where i->>'status' = 'skipped'), count(*) filter (where i->>'status' = 'kept_retired')
    into v_changed, v_unchanged, v_skipped, v_kept from jsonb_array_elements(v_items) i;

  v_text := coalesce(v_note, format('Group %s moved to %s: %s changed, %s unchanged, %s kept retired, %s skipped. No note provided.',
                                    p_group_id, public.sa_mode_display_label(p_target), v_changed, v_unchanged, v_kept, v_skipped));
  v_result := jsonb_build_object('batchId', v_batch, 'groupId', p_group_id, 'targetMode', p_target, 'selection', p_selection,
                                 'changed', v_changed, 'unchanged', v_unchanged, 'skipped', v_skipped, 'keptRetired', v_kept,
                                 'note', v_note, 'items', v_items, 'replayed', false);
  insert into public.sa_migration_mode_batches(batch_id, actor_id, idempotency_key, group_id, target_mode, selection, request_hash, reason,
                                               changed_count, unchanged_count, skipped_count, kept_retired_count, result)
  values (v_batch, p_actor, p_idempotency_key, p_group_id, p_target, p_selection, v_hash, v_text, v_changed, v_unchanged, v_skipped, v_kept, v_result);
  perform public.sa_log_access_change(p_actor, 'migration_mode.bulk_changed', null, 'sa_migration_mode_batch', v_batch::text,
    jsonb_build_object('group', p_group_id, 'to', p_target, 'selection', p_selection, 'changed', v_changed, 'unchanged', v_unchanged,
                       'skipped', v_skipped, 'kept_retired', v_kept, 'note', v_note, 'reason_generated', v_note is null),
    v_text, 'user');
  return v_result;
end $$;
revoke all on function public.sa_bulk_set_migration_mode(uuid,text[],jsonb,text,text,text,text,uuid) from public, anon, authenticated;
grant execute on function public.sa_bulk_set_migration_mode(uuid,text[],jsonb,text,text,text,text,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Post-conditions
-- ---------------------------------------------------------------------------
do $$
begin
  if not public.sa_mode_reason_required('NEW_ENFORCED', 'SHADOW') or not public.sa_mode_reason_required('SHADOW', 'LEGACY_ENFORCED')
     or public.sa_mode_reason_required('SHADOW', 'NEW_ENFORCED') or public.sa_mode_reason_required('NEW_ENFORCED', 'LEGACY_RETIRED')
     or public.sa_mode_reason_required('SHADOW', 'SHADOW') then
    raise exception 'postcondition: reason rule';
  end if;
  if has_function_privilege('authenticated', 'public.sa_apply_migration_mode(uuid,text,text,text,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.sa_bulk_set_migration_mode(uuid,text[],jsonb,text,text,text,text,uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.sa_bulk_set_migration_mode(uuid,text[],jsonb,text,text,text,text,uuid)', 'EXECUTE') then
    raise exception 'postcondition: mode change grants';
  end if;
end $$;
