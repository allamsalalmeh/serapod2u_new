-- ============================================================================
-- Security & Access — switch Emergency Access ON (separate, explicit decision)
--
-- NOT APPLIED. Optional. Apply only after 20261024100000_sa_emergency_access_grant_flow.sql AND after the application
-- release with TOTP enrollment / step-up and the Emergency Access screen is deployed.
--
-- Effect: sa_settings emergency_access.enabled = true. Nothing is granted: an authorized administrator must still
-- grant each time-boxed emergency access through Security & Access → Advanced → Governance → Emergency Access, with a
-- fresh authenticator-app (TOTP) verification. The sa_settings_guard trigger (20260928100000) refuses this unless
-- emergency_access.mfa_step_up_available is already true (set by 20261024100000).
--
-- Not changed: migration modes, grants, assignments.
-- Idempotent: yes.
-- Rollback (turns the grant flow off again; existing active grants keep working until they expire or are revoked —
-- revoke them first if that is not wanted):
--   update public.sa_settings set setting_value = 'false'::jsonb, updated_at = now() where setting_key = 'emergency_access.enabled';
-- ============================================================================

do $pre$
begin
  if to_regprocedure('public.sa_grant_emergency_access(uuid,uuid,uuid,text[],uuid,text,integer,uuid,uuid)') is null then
    raise exception 'sa_prerequisite_missing: apply 20261024100000_sa_emergency_access_grant_flow.sql first';
  end if;
end $pre$;

update public.sa_settings set setting_value = 'true'::jsonb, updated_at = now()
where setting_key = 'emergency_access.enabled' and setting_value is distinct from 'true'::jsonb;

do $post$
begin
  if not public.sa_setting_bool('emergency_access.enabled', false) then
    raise exception 'postcondition: emergency access was not enabled';
  end if;
end $post$;
