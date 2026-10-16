-- ============================================================================
-- Event Management (Phase 3/3): cross-entity constraints + verification
-- ----------------------------------------------------------------------------
-- Purpose
--   Finalize the Event Management schema with cross-entity consistency
--   constraints that keep a contact / QR token / registration bound to the
--   same event (and therefore the same organization), plus the partial unique
--   indexes that guarantee a single ACTIVE staff QR per (event, staff) and a
--   single ACTIVE booth QR per event.
--
--   * event_registrations(event_id, contact_id)  -> event_contacts(event_id, id)
--       a registration can only reference a contact from the SAME event/org.
--   * event_registrations(event_id, qr_token_id) -> event_qr_tokens(event_id, id)
--       a registration can only reference a QR token from the SAME event/org.
--   * one ACTIVE staff QR per (event, staff): staff_user_id must be a currently
--     assigned staff for that event, enforced in the server layer (the admin
--     API validates event_staff before creating a staff token and the atomic
--     RPC validates on use). Token history is preserved because tokens are
--     soft-revoked, never hard-deleted.
--   * one ACTIVE booth QR per event.
--
--   NOTE on staff-assignment integrity: a composite FK from
--   event_qr_tokens(event_id, staff_user_id) -> event_staff(event_id, user_id)
--   would hard-delete staff tokens when a staff member is unassigned (losing
--   historical attribution). Instead, assignment is validated in code and the
--   staff_user_id is stored as a plain uuid so attribution survives staff
--   reassignment and user deletion.
--
-- Prerequisites / execution order
--   1. 20261007_event01_create_event_tables.sql
--   2. 20261007_event02_event_qr_functions.sql
--   3. this file
--
-- Verification (run after this file)
--   select conname, contype from pg_constraint
--     where conname like 'event_registrations%fkey' order by 1;
--   select indexname, indexdef from pg_indexes
--     where schemaname = 'public' and indexname like 'event_qr_tokens%' order by 1;
--
-- Rollback
--   alter table public.event_registrations drop constraint if exists event_registrations_contact_event_fkey;
--   alter table public.event_registrations drop constraint if exists event_registrations_token_event_fkey;
--   drop index if exists event_qr_tokens_active_staff_key;
--   drop index if exists event_qr_tokens_active_booth_key;
-- ============================================================================

-- Composite FKs keep contact/token in the same event (and therefore org).
alter table public.event_registrations
  add constraint event_registrations_contact_event_fkey
  foreign key (event_id, contact_id)
  references public.event_contacts (event_id, id)
  on delete cascade;

alter table public.event_registrations
  add constraint event_registrations_token_event_fkey
  foreign key (event_id, qr_token_id)
  references public.event_qr_tokens (event_id, id)
  on delete restrict;

-- One ACTIVE staff QR per (event, staff); one ACTIVE booth QR per event.
-- (NULL staff_user_id for booth rows does not participate in the staff index.)
create unique index if not exists event_qr_tokens_active_staff_key
  on public.event_qr_tokens (event_id, staff_user_id)
  where kind = 'staff' and status = 'active';

create unique index if not exists event_qr_tokens_active_booth_key
  on public.event_qr_tokens (event_id)
  where kind = 'booth' and status = 'active';

-- Supporting indexes for the admin visitors/stats/export read paths.
create index if not exists event_registrations_contact_idx
  on public.event_registrations (contact_id);
create index if not exists event_registrations_token_idx
  on public.event_registrations (qr_token_id);
