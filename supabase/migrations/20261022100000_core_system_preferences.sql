-- ============================================================================
-- core.system_preferences — per-organization feature preferences (QR tracking visibility)
--
-- NOT APPLIED. Prepare only. Do not run against production or the shared staging
-- database without explicit approval.
--
-- Why this exists: the application reads and writes this table from
--   * app/src/components/settings/SettingsView.tsx  (load + upsert)
--   * app/src/components/layout/Sidebar.tsx         (load)
-- via `supabase.schema('core').from('system_preferences')`. The table was never
-- migrated anywhere, which is the source of the recurring production error
--   `relation "core.system_preferences" does not exist`
-- (PostgREST already exposes the `core` schema: PGRST_DB_SCHEMAS includes `core`.)
-- The app already degrades gracefully (try/catch + `?? true` fallbacks), so this
-- migration is additive: it unblocks the "QR tracking visibility" preference and
-- removes the error noise, without changing behaviour where the table is absent.
--
-- Data model (confirmed from the code):
--   company_id  -> the organization id (mirrors users.organization_id)
--   module      -> feature area, currently 'qr_tracking'
--   key         -> preference key (e.g. 'manufacturer_scan', 'warehouse_receive')
--   value       -> small jsonb, currently { "visible": boolean }
--   (company_id, module, key) is the conflict target used by the app's upsert.
--
-- Idempotent: create schema/table with IF NOT EXISTS; drop policies before create;
-- grants are additive. Repeat-safe.
--
-- Rollback (destroys preference data only):
--   drop schema core cascade;
--
-- Order: independent of Security & Access. Requires public.organizations(id),
--   public.users and auth.uid() (all foundational, long since applied).
-- ============================================================================

-- Schema (new; nothing else in the repo uses `core`).
create schema if not exists core;
grant usage on schema core to postgres, anon, authenticated, service_role, authenticator;

-- Table.
create table if not exists core.system_preferences (
  company_id  uuid not null references public.organizations(id) on delete cascade,
  module      text not null,
  key         text not null,
  value       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (company_id, module, key)
);

comment on table core.system_preferences is
  'Per-organization feature preferences (e.g. QR tracking visibility). Owned by the organization referenced by company_id.';
comment on column core.system_preferences.company_id is 'Organization id (mirrors public.users.organization_id).';
comment on column core.system_preferences.module is 'Feature area, currently ''qr_tracking''.';
comment on column core.system_preferences.key is 'Preference key within the module.';
comment on column core.system_preferences.value is 'Preference value (jsonb), currently { "visible": boolean }.';

-- Grants. RLS still applies to `authenticated`; `service_role` bypasses RLS.
grant select, insert, update, delete on core.system_preferences to authenticated;
grant all on core.system_preferences to service_role;

-- RLS: an authenticated user may read/write only their own organization's rows.
alter table core.system_preferences enable row level security;

drop policy if exists core_system_preferences_org_read on core.system_preferences;
create policy core_system_preferences_org_read on core.system_preferences
  for select to authenticated
  using (company_id = (select u.organization_id from public.users u where u.id = auth.uid() and u.is_active = true));

drop policy if exists core_system_preferences_org_insert on core.system_preferences;
create policy core_system_preferences_org_insert on core.system_preferences
  for insert to authenticated
  with check (company_id = (select u.organization_id from public.users u where u.id = auth.uid() and u.is_active = true));

drop policy if exists core_system_preferences_org_update on core.system_preferences;
create policy core_system_preferences_org_update on core.system_preferences
  for update to authenticated
  using (company_id = (select u.organization_id from public.users u where u.id = auth.uid() and u.is_active = true))
  with check (company_id = (select u.organization_id from public.users u where u.id = auth.uid() and u.is_active = true));
