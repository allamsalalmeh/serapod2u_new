-- ============================================================================
-- Event Management (Phase 1/3): event_* tables
-- ----------------------------------------------------------------------------
-- Purpose
--   Create the six Event Management tables. An event is a field marketing
--   activity (first for the Ellbow cat-food brand) where visitors scan a staff
--   or booth QR, submit a short anonymous form (name + Malaysian mobile phone
--   mandatory; email / cat name / cat breed optional) and receive a generic
--   confirmation. No visitor login. Admin (HQ Marketing) manages events, staff,
--   QRs, visitor lists, counts, staff comparison and export.
--
-- Tables
--   event_events          event + status + registration window + form config
--   event_staff           participating staff assigned to an event
--   event_qr_tokens       single source of truth for staff AND booth QR tokens
--   event_contacts        event-specific anonymous contact (phone-deduped)
--   event_registrations   one registration per contact per event (attribution)
--   event_consents        registration consent vs marketing consent (separate)
--
-- Security model (Strategy B - deny direct database access)
--   RLS is ENABLED on every table and ALL privileges are revoked from
--   public/anon/authenticated. Only service_role (and the table owner) can
--   read or write. The Marketing parent gate (`marketing.module.view`) has no
--   database equivalent usable inside RLS, so org isolation is enforced in the
--   server endpoints (explicit organization_id filtering), never left to RLS.
--   service_role bypasses RLS, so RLS here is a deny-by-default containment,
--   not an org-isolation mechanism.
--
-- Prerequisites / execution order
--   1. this file (event01)
--   2. 20261007_event02_event_qr_functions.sql (functions depend on tables)
--   3. 20261007_event03_event_constraints_verify.sql (composite FKs + partial
--      unique indexes + verification queries)
--   Depends on existing public.organizations / public.brands / public.users and
--   the pgcrypto extension (gen_random_bytes used for the QR token default;
--   already enabled for the existing roadtour_qr_codes.token default).
--
-- Verification (run after all three files)
--   select table_name from information_schema.tables
--     where table_schema = 'public' and table_name like 'event\_%' order by 1;
--   select relname, relrowsecurity from pg_class
--     where relnamespace = 'public'::regnamespace and relname like 'event\_%'
--     order by 1;
--
-- Rollback
--   drop table if exists public.event_consents;
--   drop table if exists public.event_registrations;
--   drop table if exists public.event_contacts;
--   drop table if exists public.event_qr_tokens;
--   drop table if exists public.event_staff;
--   drop table if exists public.event_events;
-- ============================================================================

create table if not exists public.event_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  brand_id uuid references public.brands(id) on delete set null,
  name text not null check (length(btrim(name)) between 1 and 160),
  slug text not null,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'ended', 'cancelled')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'Asia/Kuala_Lumpur',
  -- Optional overrides; NULL falls back to starts_at/ends_at (never "always open").
  registration_opens_at timestamptz,
  registration_closes_at timestamptz,
  form_config jsonb not null default '{}'::jsonb,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_events_dates_order check (ends_at >= starts_at)
);

create index if not exists event_events_org_idx on public.event_events (organization_id);
create index if not exists event_events_status_idx on public.event_events (organization_id, status);

comment on table public.event_events is
  'A field marketing event. Public registration is allowed only while status = ''active'' and within the effective registration window (registration_opens_at/registration_closes_at or starts_at/ends_at). No visitor personal data lives in this table.';

create table if not exists public.event_staff (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.event_events(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (event_id, user_id)
);

create index if not exists event_staff_user_idx on public.event_staff (user_id);

comment on table public.event_staff is
  'Staff assigned to an event. A staff QR token must reference an assigned staff row.';

-- single source of truth for BOTH staff and booth tokens.
create table if not exists public.event_qr_tokens (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.event_events(id) on delete cascade,
  -- staff QR: staff_user_id NOT NULL; booth QR: NULL.
  -- Plain uuid (no FK) so historical staff attribution survives user deletion
  -- and staff reassignment; assignment integrity is enforced in the server layer.
  staff_user_id uuid,
  token text not null unique default encode(gen_random_bytes(32), 'base64url'),
  kind text not null check (kind in ('staff', 'booth')),
  status text not null default 'active' check (status in ('active', 'revoked', 'expired')),
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (event_id, id),
  constraint event_qr_tokens_kind_staff_check
    check ((kind = 'staff' and staff_user_id is not null)
        or (kind = 'booth' and staff_user_id is null))
);

create index if not exists event_qr_tokens_event_idx on public.event_qr_tokens (event_id);

comment on table public.event_qr_tokens is
  'Opaque QR tokens for staff and booth entry. The token is the only thing placed in a QR URL (no personal data). Tokens are soft-revoked (status), never hard-deleted, so historical attribution survives revocation and staff reassignment.';

create table if not exists public.event_contacts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.event_events(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 160),
  phone_normalized text not null,
  email_normalized text,
  cat_name text,
  cat_breed text,
  current_cat_food text,
  -- Explicit identity link only; NEVER inferred from field equality.
  user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (event_id, id),
  unique (event_id, phone_normalized),
  constraint event_contacts_phone_shape check (phone_normalized ~ '^\+601\d{7,9}$')
);

create index if not exists event_contacts_event_idx on public.event_contacts (event_id);

comment on table public.event_contacts is
  'Anonymous event contact. Name and phone_normalized are mandatory (phone is the canonical E.164 +60 mobile format). One normalized phone per event.';

create table if not exists public.event_registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.event_events(id) on delete cascade,
  contact_id uuid not null references public.event_contacts(id) on delete cascade,
  qr_token_id uuid not null references public.event_qr_tokens(id) on delete restrict,
  -- NULL = booth. The FIRST successful source; never overwritten.
  attributed_staff_user_id uuid,
  submitted_at timestamptz not null default now(),
  ip text,
  created_at timestamptz not null default now(),
  unique (event_id, contact_id)
);

create index if not exists event_registrations_event_idx on public.event_registrations (event_id);
create index if not exists event_registrations_staff_idx on public.event_registrations (event_id, attributed_staff_user_id);

comment on table public.event_registrations is
  'One registration per contact per event. attributed_staff_user_id (NULL = booth) is fixed on first success; duplicates never overwrite it. Metrics describe registrations, not verified identities.';

create table if not exists public.event_consents (
  id uuid primary key default gen_random_uuid(),
  registration_id uuid not null references public.event_registrations(id) on delete cascade,
  kind text not null check (kind in ('registration', 'marketing')),
  granted boolean not null default true,
  recorded_at timestamptz not null default now(),
  unique (registration_id, kind)
);

create index if not exists event_consents_registration_idx on public.event_consents (registration_id);

comment on table public.event_consents is
  'Separate registration consent vs marketing consent records. Marketing consent is optional and never preselected; registration consent is recorded on every submission.';

-- ---------------------------------------------------------------------------
-- Access: deny direct database access (Strategy B). Effective from creation.
-- ---------------------------------------------------------------------------
alter table public.event_events         enable row level security;
alter table public.event_staff          enable row level security;
alter table public.event_qr_tokens      enable row level security;
alter table public.event_contacts       enable row level security;
alter table public.event_registrations  enable row level security;
alter table public.event_consents       enable row level security;

revoke all on table public.event_events        from public, anon, authenticated;
revoke all on table public.event_staff         from public, anon, authenticated;
revoke all on table public.event_qr_tokens     from public, anon, authenticated;
revoke all on table public.event_contacts      from public, anon, authenticated;
revoke all on table public.event_registrations from public, anon, authenticated;
revoke all on table public.event_consents      from public, anon, authenticated;

grant all on table public.event_events        to service_role;
grant all on table public.event_staff         to service_role;
grant all on table public.event_qr_tokens     to service_role;
grant all on table public.event_contacts      to service_role;
grant all on table public.event_registrations to service_role;
grant all on table public.event_consents      to service_role;

