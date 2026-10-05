-- ============================================================================
-- Security & Access — bulk migration-mode change for a module group
-- ----------------------------------------------------------------------------
-- Lets an administrator move every permission of a module group (e.g. Supply
-- Chain) or subgroup (e.g. Stock Count) to one migration mode in ONE
-- transaction, without weakening any single-permission rule.
--
-- Group membership is NOT decided here. The application resolves a group to
-- permission keys from its trusted server-side catalog (modules.ts) and passes
-- the keys plus the modes it previewed; this migration re-verifies everything
-- under row locks.
--
-- Objects
--   1. sa_apply_migration_mode()      the former body of sa_set_migration_mode
--      with an optional batch id recorded in the audit details. Internal: no
--      API role may execute it.
--   2. sa_set_migration_mode()        unchanged behaviour; delegates (batch id
--      null). Same signature and grants as before.
--   3. sa_bulk_mode_evaluate()        the single source of eligibility rules
--      (readiness registration; LEGACY_RETIRED only from NEW_ENFORCED /
--      LEGACY_RETIRED). Internal.
--   4. sa_preview_bulk_migration_mode()  read-only preview for the actor.
--   5. sa_bulk_set_migration_mode()   atomic apply: actor re-check, stale
--      preview rejection, blocked handling, no-op rejection, idempotent
--      replay, one audit row per changed permission (shared batch id) plus a
--      batch summary, and an administrator-lockout post-check.
--   6. sa_migration_mode_batches      one row per applied batch (idempotency
--      record and result).
--
-- Never done here: no mode is changed by this migration, nothing is retired
-- through NEW_ENFORCED automatically, no guard is disabled and no actor is
-- impersonated (p_actor is always a real, authorised user).
--
-- Rollback guidance
--   drop function sa_bulk_set_migration_mode, sa_preview_bulk_migration_mode,
--   sa_bulk_mode_evaluate; drop table sa_migration_mode_batches; restore the
--   sa_set_migration_mode body from 20260928130000 and drop
--   sa_apply_migration_mode. Audit rows already written stay (append-only).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Batch record
-- ---------------------------------------------------------------------------
create table if not exists public.sa_migration_mode_batches (
  batch_id uuid primary key,
  actor_id uuid not null references public.users(id),
  idempotency_key uuid not null,
  group_id text not null,
  target_mode text not null check (target_mode in ('LEGACY_ENFORCED','SHADOW','NEW_ENFORCED','LEGACY_RETIRED')),
  selection text not null check (selection in ('all','eligible_only')),
  request_hash text not null,
  reason text not null,
  changed_count integer not null,
  unchanged_count integer not null,
  skipped_count integer not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique (actor_id, idempotency_key)
);
alter table public.sa_migration_mode_batches enable row level security;
alter table public.sa_migration_mode_batches force row level security;
revoke all on table public.sa_migration_mode_batches from public, anon, authenticated, service_role;
grant select on table public.sa_migration_mode_batches to service_role;
comment on table public.sa_migration_mode_batches is
  'One row per applied bulk migration-mode batch: idempotency record (actor + key) and the result returned to the caller. Per-permission before/after rows are in sa_access_change_log (details.batch_id).';

-- ---------------------------------------------------------------------------
-- 2. Single-permission change (existing rules, optional batch id for audit)
-- ---------------------------------------------------------------------------
create or replace function public.sa_apply_migration_mode(p_actor uuid, p_permission text, p_mode text, p_reason text, p_batch_id uuid)
returns text language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_current text;
  v_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role';
begin
  if p_mode not in ('LEGACY_ENFORCED','SHADOW','NEW_ENFORCED','LEGACY_RETIRED') then raise exception 'sa_mode_invalid'; end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then raise exception 'sa_reason_required'; end if;
  -- A human actor is required for every API-originated change; only a direct
  -- database-owner session (reviewed cutover SQL) may act as 'system'.
  if p_actor is null and v_role is not null then raise exception 'sa_actor_required' using errcode = '42501'; end if;
  if p_actor is not null then
    perform public.sa_assert_actor_permission(p_actor, 'security.permission.manage', '{}'::jsonb, public.sa_legacy_is_super_admin(p_actor));
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
  update public.sa_migration_modes set mode = p_mode, updated_at = now(), updated_by = p_actor,
    notes = left(btrim(p_reason), 500)
  where permission_key = p_permission;
  perform public.sa_log_access_change(p_actor, 'migration_mode.changed', null, 'sa_migration_mode', p_permission,
    jsonb_build_object('from', v_current, 'to', p_mode) || case when p_batch_id is null then '{}'::jsonb else jsonb_build_object('batch_id', p_batch_id) end,
    p_reason, case when p_actor is null then 'system' else 'user' end);
  return p_mode;
end $$;
revoke all on function public.sa_apply_migration_mode(uuid,text,text,text,uuid) from public, anon, authenticated, service_role;

create or replace function public.sa_set_migration_mode(p_actor uuid, p_permission text, p_mode text, p_reason text)
returns text language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  return public.sa_apply_migration_mode(p_actor, p_permission, p_mode, p_reason, null);
end $$;
revoke all on function public.sa_set_migration_mode(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.sa_set_migration_mode(uuid,text,text,text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Eligibility rules (mirror sa_apply_migration_mode, same order)
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
-- 4. Preview (read-only)
-- ---------------------------------------------------------------------------
create or replace function public.sa_preview_bulk_migration_mode(p_actor uuid, p_permissions text[], p_target text)
returns table(permission_key text, current_mode text, status text, blockers text[])
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  if p_target is null or p_target not in ('LEGACY_ENFORCED','SHADOW','NEW_ENFORCED','LEGACY_RETIRED') then raise exception 'sa_mode_invalid'; end if;
  if p_actor is null then raise exception 'sa_actor_required' using errcode = '42501'; end if;
  perform public.sa_assert_actor_permission(p_actor, 'security.permission.manage', '{}'::jsonb, public.sa_legacy_is_super_admin(p_actor));
  if p_permissions is null or cardinality(p_permissions) = 0 or cardinality(p_permissions) > 500 then raise exception 'sa_bulk_selection_invalid'; end if;
  return query select e.permission_key, e.current_mode, e.status, e.blockers from public.sa_bulk_mode_evaluate(p_permissions, p_target) e;
end $$;
revoke all on function public.sa_preview_bulk_migration_mode(uuid,text[],text) from public, anon, authenticated;
grant execute on function public.sa_preview_bulk_migration_mode(uuid,text[],text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Apply (atomic)
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
  v_result jsonb;
begin
  if p_target is null or p_target not in ('LEGACY_ENFORCED','SHADOW','NEW_ENFORCED','LEGACY_RETIRED') then raise exception 'sa_mode_invalid'; end if;
  if p_reason is null or length(btrim(p_reason)) < 10 then raise exception 'sa_reason_required'; end if;
  if p_actor is null then raise exception 'sa_actor_required' using errcode = '42501'; end if;
  if p_selection is null or p_selection not in ('all','eligible_only') then raise exception 'sa_bulk_selection_invalid'; end if;
  if p_idempotency_key is null or p_group_id is null or length(btrim(p_group_id)) = 0 then raise exception 'sa_bulk_selection_invalid'; end if;
  if p_permissions is null or cardinality(p_permissions) = 0 or cardinality(p_permissions) > 500
     or p_expected is null or jsonb_typeof(p_expected) <> 'object' then raise exception 'sa_bulk_selection_invalid'; end if;

  perform public.sa_assert_actor_permission(p_actor, 'security.permission.manage', '{}'::jsonb, public.sa_legacy_is_super_admin(p_actor));

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

  -- Snapshot of what this batch does (taken before any change is applied).
  select jsonb_agg(jsonb_build_object(
           'permissionKey', e.permission_key, 'from', e.current_mode,
           'to', case when e.status = 'change' then p_target else e.current_mode end,
           'status', case e.status when 'change' then 'changed' when 'blocked' then 'skipped' else 'unchanged' end,
           'blockers', to_jsonb(e.blockers)) order by e.permission_key)
    into v_items from public.sa_bulk_mode_evaluate(v_keys, p_target) e;

  -- Same validation and audit as a single change; any failure aborts the batch.
  foreach v_key in array v_changes loop
    perform public.sa_apply_migration_mode(p_actor, v_key, p_target, p_reason, v_batch);
  end loop;

  -- Administrator-lockout guard: the actor must still hold the authority they
  -- just used (e.g. security.permission.manage moved to NEW_ENFORCED).
  perform set_config('sa_cache.epoch', gen_random_uuid()::text, true);
  begin
    perform public.sa_assert_actor_permission(p_actor, 'security.permission.manage', '{}'::jsonb, public.sa_legacy_is_super_admin(p_actor));
  exception when others then
    raise exception 'sa_bulk_actor_lockout' using hint = 'This change would remove your own authority to manage permissions.';
  end;

  select count(*) filter (where i->>'status' = 'changed'), count(*) filter (where i->>'status' = 'unchanged'), count(*) filter (where i->>'status' = 'skipped')
    into v_changed, v_unchanged, v_skipped from jsonb_array_elements(v_items) i;

  v_result := jsonb_build_object('batchId', v_batch, 'groupId', p_group_id, 'targetMode', p_target, 'selection', p_selection,
                                 'changed', v_changed, 'unchanged', v_unchanged, 'skipped', v_skipped, 'items', v_items, 'replayed', false);
  insert into public.sa_migration_mode_batches(batch_id, actor_id, idempotency_key, group_id, target_mode, selection, request_hash, reason,
                                               changed_count, unchanged_count, skipped_count, result)
  values (v_batch, p_actor, p_idempotency_key, p_group_id, p_target, p_selection, v_hash, btrim(p_reason), v_changed, v_unchanged, v_skipped, v_result);
  perform public.sa_log_access_change(p_actor, 'migration_mode.bulk_changed', null, 'sa_migration_mode_batch', v_batch::text,
    jsonb_build_object('group', p_group_id, 'to', p_target, 'selection', p_selection, 'changed', v_changed, 'unchanged', v_unchanged, 'skipped', v_skipped),
    p_reason, 'user');
  return v_result;
end $$;
revoke all on function public.sa_bulk_set_migration_mode(uuid,text[],jsonb,text,text,text,text,uuid) from public, anon, authenticated;
grant execute on function public.sa_bulk_set_migration_mode(uuid,text[],jsonb,text,text,text,text,uuid) to service_role;
