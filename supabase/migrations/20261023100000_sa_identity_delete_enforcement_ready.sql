-- ============================================================================
-- Archive Identities (platform.identity.delete) — enforcement readiness
-- ----------------------------------------------------------------------------
-- Purpose
--   Registers platform.identity.delete in public.sa_enforcement_readiness so
--   management can move it to New Access Active (single or group change).
--   Until now it was deliberately unregistered: the removal routes decided it
--   in the ADMINISTRATOR's organization (not the target's), the archive wrote
--   account_status directly instead of through the governance function, and
--   deleteUserWithAuth / bulk-delete-users removed identities without deciding
--   it at all. The application change shipped with this migration wires every
--   path (lib/identity/removal-authorization.ts):
--     * POST /api/admin/delete-user-otp/request and /verify-and-delete
--       (User Management "Delete user"): decided for the target's
--       organization, re-decided at submission before the OTP is consumed;
--     * deleteUserWithAuth (server action) and /api/admin/bulk-delete-users:
--       the same decision per target; refused targets are never removed;
--     * organization deletion (/api/organizations/delete/request-otp,
--       /verify-and-delete and the guarded /api/organizations/delete):
--       hard_delete_organization deletes every public.users row of the
--       organization (check_organization_dependencies does not treat members
--       as a blocker), so every member must pass the same decision, re-decided
--       before the code is consumed; otherwise nothing is deleted;
--     * setUserAccountStatus (lifecycle server action) refuses ARCHIVED at
--       runtime; reactivating an archived identity is decided by
--       identity_set_account_status as platform.identity.delete;
--     * once enforced, archiving runs through identity_set_account_status(),
--       which re-asserts platform.identity.delete over the target's
--       organization in the database (row lock, ARCHIVED terminal,
--       sa_access_change_log);
--     * target protection: sa_actor_dominates once enforced, and a Super Admin
--       account is removable only by a Super Admin in every mode.
--   Database backstop for every other path: API roles cannot delete or change
--   the lifecycle of public.users (users_protect_access_fields), a hard delete
--   of an identity with history is refused (users_history_delete_guard), and
--   identity_set_account_status is service-role only. /api/admin/delete-all-data
--   uses the session client, so the same trigger refuses its user deletes.
--
-- Semantics: unchanged. "Archive Identities" is a soft archive (ARCHIVED,
--   identifiers reserved, login banned) for an identity with history; only an
--   identity without any history is hard-deleted, exactly as before.
--
-- Mode: NOT changed. platform.identity.delete stays in its current mode
--   (Monitoring / Shadow); management enforces it in the S&A console.
--
-- Depends on (must already be applied):
--   20260929110000_identity_foundation.sql            (permission, mode, compat rule)
--   20260929120000_identity_protected_fields_guard.sql (API-role write/delete guard, history guard)
--   20260929160000_identity_stage2_archive_keeps_identifiers.sql (identity_set_account_status)
--   20260930100000_sa_stage2d_deferred_closure.sql    (sa_actor_dominates)
--   20261019110000_sa_mode_change_note_and_keep_retired.sql (current mode-change functions; optional, any version reads readiness)
--
-- Idempotent: yes. Application order: after the files above; independent of
--   the other unapplied 202610xx migrations.
--
-- Rollback (only while platform.identity.delete is not NEW_ENFORCED / LEGACY_RETIRED):
--   delete from public.sa_enforcement_readiness where permission_key = 'platform.identity.delete';
-- ============================================================================

do $pre$
begin
  if to_regclass('public.sa_enforcement_readiness') is null or to_regclass('public.sa_permissions') is null then
    raise exception 'sa_prerequisite_missing: Security & Access readiness tables (20260928130000)';
  end if;
  if not exists (select 1 from public.sa_permissions where permission_key = 'platform.identity.delete') then
    raise exception 'sa_prerequisite_missing: apply 20260929110000_identity_foundation.sql first';
  end if;
  if to_regprocedure('public.identity_set_account_status(uuid,uuid,text,text)') is null then
    raise exception 'sa_prerequisite_missing: identity_set_account_status (20260929160000)';
  end if;
  if position('platform.identity.delete' in pg_get_functiondef('public.identity_set_account_status(uuid,uuid,text,text)'::regprocedure)) = 0 then
    raise exception 'sa_prerequisite_missing: identity_set_account_status must assert platform.identity.delete for ARCHIVED (20260929160000)';
  end if;
  if to_regprocedure('public.sa_actor_dominates(uuid,uuid)') is null then
    raise exception 'sa_prerequisite_missing: sa_actor_dominates (20260930100000)';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'users_protect_access_fields' and tgrelid = 'public.users'::regclass and not tgisinternal and tgenabled = 'O')
     or not exists (select 1 from pg_trigger where tgname = 'users_history_delete_guard' and tgrelid = 'public.users'::regclass and not tgisinternal and tgenabled = 'O') then
    raise exception 'sa_prerequisite_missing: users_protect_access_fields / users_history_delete_guard (20260929120000)';
  end if;
end $pre$;

insert into public.sa_enforcement_readiness(permission_key, route_wiring, database_backstop, intentional_tightening, notes) values
 ('platform.identity.delete', true, 'governance_function',
  'Once enforced: the compatibility audience is Super Admin only, so an HQ Admin keeps Archive Identities only through an explicit grant (e.g. Platform & Settings Full Access); the decision is made for the target''s organization; target protection becomes "hold every grant of the target" (sa_actor_dominates) and a Super Admin account stays removable only by a Super Admin.',
  'delete-user-otp request/verify-and-delete, deleteUserWithAuth, bulk-delete-users and organization deletion (every member identity) decide through S&A for the target''s organization (lib/identity/removal-authorization.ts; legacy HQ Admin / Super Admin rule until enforced). Archive → identity_set_account_status() once enforced; API roles cannot delete or archive users (users_protect_access_fields); history blocks hard delete (users_history_delete_guard).')
on conflict (permission_key) do update set route_wiring = excluded.route_wiring, database_backstop = excluded.database_backstop,
  intentional_tightening = excluded.intentional_tightening, notes = excluded.notes;

-- Post-conditions: registered, and no mode was changed by this migration.
do $post$
begin
  if not exists (select 1 from public.sa_enforcement_readiness where permission_key = 'platform.identity.delete' and route_wiring) then
    raise exception 'postcondition: platform.identity.delete readiness missing';
  end if;
end $post$;
