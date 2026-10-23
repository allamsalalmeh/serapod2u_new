-- ============================================================================
-- Archive & Revoke Access: reason becomes optional (UI simplification)
-- ----------------------------------------------------------------------------
-- Decision (owner, 2026-10-24) — the Archive & Revoke Access dialog previously
-- required a mandatory reason (min 10 characters) plus a redundant "I confirm…"
-- checkbox. The typed target-email confirmation is the single user-facing
-- confirmation, so the reason is now optional for the ARCHIVE action.
--
-- The identifier RELEASE action keeps its mandatory reason (it has no typed
-- email step); identity_set_account_status keeps its own >= 5 reason rule for
-- every other caller (disable / suspend / reactivate / direct archive).
--
-- Audit invariants preserved:
--   * identity_lifecycle_actions.reason still records the exact supplied reason
--     (an empty string when the administrator left it blank) — it is NOT NULL
--     and the append-only triggers keep it immutable;
--   * actor UUID, target UUID, action ('archive'), entry point, employment
--     outcome (details.employment_end), timestamp and execution status are all
--     still recorded exactly as before;
--   * when the administrator supplied no reason, users.account_status_reason
--     and the S&A access-change log record a clearly system-generated note
--     ("no administrator reason recorded") — never a fabricated employment
--     reason and never "resigned"/"terminated" invented from an empty input.
-- ============================================================================

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
  v_reason text;
  v_status_reason text;
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

  -- Reason is optional. The lifecycle action keeps the exact supplied reason
  -- (empty is fine); the status-change surfaces keep mandatory, immutable
  -- system-generated audit metadata instead of a fabricated reason.
  v_reason := btrim(coalesce(p_reason, ''));
  v_status_reason := case when v_reason = '' then 'Archived (Archive & Revoke Access; no administrator reason recorded)' else v_reason end;

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
    values (p_request_id, 'archive', p_actor, p_user, p_entry, v_org, 'blocked', v_reason, v_blockers,
            jsonb_build_object('target', v_plan->'target'))
    returning id into v_id;
    return jsonb_build_object('status', 'blocked', 'action_id', v_id, 'blockers', v_blockers);
  end if;

  -- Employment ends (employee number, onboarding history and HR records are kept).
  update public.hr_employees set status = p_employment_end, end_date = coalesce(end_date, current_date), updated_at = now()
   where user_id = p_user and status not in ('resigned','terminated');
  get diagnostics v_employment = row_count;

  -- Account lifecycle (re-asserts platform.identity.delete and Root protection; the users trigger runs the S&A leaver sync).
  perform public.identity_set_account_status(p_actor, p_user, 'ARCHIVED', v_status_reason);
  v_login := public.identity_revoke_login(p_user);
  -- No more Telegram ordering for a former user (as the previous archive did).
  if to_regclass('public.telegram_links') is not null then
    execute 'update public.telegram_links set is_active = false where user_id = $1 and is_active is true' using p_user;
  end if;
  if p_release_identifiers then
    v_release := public.identity_release_internal(p_actor, p_user, v_reason, p_request_id);
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
  values (p_request_id, 'archive', p_actor, p_user, p_entry, v_org, 'completed', v_reason,
          jsonb_build_object('target', v_plan->'target', 'employment', v_plan->'employment', 'employment_end', p_employment_end,
                             'employment_records_ended', v_employment, 'login', v_login, 'release', v_release))
  returning id into v_id;
  return jsonb_build_object('status', 'completed', 'action_id', v_id, 'login', v_login, 'release', v_release,
                            'employment_records_ended', v_employment);
end $fn$;
revoke all on function public.identity_archive_execute(uuid,uuid,text,uuid,text,text,text,boolean,text) from public, anon, authenticated;
grant execute on function public.identity_archive_execute(uuid,uuid,text,uuid,text,text,text,boolean,text) to service_role;

-- ---------------------------------------------------------------------------
-- Post-conditions: the archive surface stays server-only.
-- ---------------------------------------------------------------------------
do $post$
begin
  if has_function_privilege('authenticated', 'public.identity_archive_execute(uuid,uuid,text,uuid,text,text,text,boolean,text)', 'execute')
     or has_function_privilege('anon', 'public.identity_archive_execute(uuid,uuid,text,uuid,text,text,text,boolean,text)', 'execute') then
    raise exception 'postcondition: archive execute exposed to API roles';
  end if;
end $post$;
