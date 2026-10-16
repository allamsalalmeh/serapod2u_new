-- ============================================================================
-- Event Management (Phase 2/3): QR validation + atomic registration RPCs
-- ----------------------------------------------------------------------------
-- Purpose
--   * validate_event_qr_token(token) — resolve an opaque QR token server-side
--     into non-sensitive event/form config. NEVER returns staff or contact
--     data. Returns a status the public endpoint maps to 404/410.
--   * register_event_visitor(...)  — the single atomic registration entry
--     point. Inserts event_contacts + event_registrations + event_consents in
--     ONE transaction; any failure rolls back every row. Enforces active
--     status + effective registration dates in the RPC (not only in the
--     route), normalizes/validates the Malaysian mobile phone, and converges
--     concurrent same-phone submissions to exactly one contact + one
--     registration without overwriting details, consent or attribution.
--
-- Security model (Strategy B — deny direct database access)
--   Both functions are SECURITY DEFINER with a fixed search_path
--   (public, pg_temp). EXECUTE is revoked from PUBLIC (and anon/authenticated)
--   and granted ONLY to service_role. They are reachable only through the
--   server endpoints; anonymous/authenticated callers cannot invoke them
--   directly. service_role bypasses RLS, so org isolation for admin reads is
--   enforced in the server endpoints (explicit organization_id filtering).
--
-- Prerequisites / execution order
--   1. 20261007_event01_create_event_tables.sql
--   2. this file
--   3. 20261007_event03_event_constraints_verify.sql
--   Depends on public.identity_normalize_phone / public.identity_normalize_email
--   (20260929110000_identity_foundation.sql).
--
-- Verification
--   select has_function_privilege('service_role', 'public.validate_event_qr_token(text)', 'EXECUTE');
--   -- must be false for PUBLIC (i.e. anon/authenticated cannot execute):
--   select has_function_privilege('anon', 'public.register_event_visitor(text,text,text,text,text,text,text,boolean,text)', 'EXECUTE');
--
-- Rollback
--   drop function if exists public.register_event_visitor(text,text,text,text,text,text,text,boolean,text);
--   drop function if exists public.validate_event_qr_token(text);
-- ============================================================================

-- ---------------------------------------------------------------------------
-- validate_event_qr_token — resolve token to non-sensitive form config.
-- ---------------------------------------------------------------------------
create or replace function public.validate_event_qr_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token public.event_qr_tokens%rowtype;
  v_event public.event_events%rowtype;
  v_opens_at timestamptz;
  v_closes_at timestamptz;
  v_brand_name text;
begin
  if p_token is null or btrim(p_token) = '' then
    return jsonb_build_object('valid', false, 'status', 'invalid_token', 'message', 'Invalid QR code.');
  end if;

  select * into v_token from public.event_qr_tokens where token = p_token;
  if not found then
    return jsonb_build_object('valid', false, 'status', 'invalid_token', 'message', 'Invalid QR code.');
  end if;

  if v_token.status <> 'active' then
    return jsonb_build_object(
      'valid', false, 'status', v_token.status,
      'message', case when v_token.status = 'revoked' then 'This QR code has been revoked.'
                      else 'This QR code has expired.' end);
  end if;

  select * into v_event from public.event_events where id = v_token.event_id;
  if not found then
    return jsonb_build_object('valid', false, 'status', 'invalid_event', 'message', 'Event not found.');
  end if;

  if v_event.status <> 'active' then
    return jsonb_build_object('valid', false, 'status', 'event_not_active', 'message', 'Registration is closed for this event.');
  end if;

  v_opens_at := coalesce(v_event.registration_opens_at, v_event.starts_at);
  v_closes_at := coalesce(v_event.registration_closes_at, v_event.ends_at);

  select brand_name into v_brand_name from public.brands where id = v_event.brand_id;

  return jsonb_build_object(
    'valid', true,
    'status', 'active',
    'event_id', v_event.id,
    'event_name', v_event.name,
    'brand_id', v_event.brand_id,
    'brand_name', v_brand_name,
    'timezone', v_event.timezone,
    'opens_at', v_opens_at,
    'closes_at', v_closes_at,
    'form_config', v_event.form_config,
    'kind', v_token.kind
  );
end;
$$;

comment on function public.validate_event_qr_token(text) is
  'Resolve an opaque event QR token into non-sensitive event/form config. SECURITY DEFINER; service_role only. Never returns staff or contact data.';

-- ---------------------------------------------------------------------------
-- register_event_visitor — atomic contact + registration + consent insert.
-- ---------------------------------------------------------------------------
create or replace function public.register_event_visitor(
  p_token             text,
  p_name              text,
  p_phone             text,
  p_email             text,
  p_cat_name          text,
  p_cat_breed         text,
  p_current_cat_food  text,
  p_marketing_consent boolean,
  p_ip                text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token public.event_qr_tokens%rowtype;
  v_event public.event_events%rowtype;
  v_now timestamptz := now();
  v_opens_at timestamptz;
  v_closes_at timestamptz;
  v_name text;
  v_phone text;
  v_email text;
  v_attributed uuid;
  v_contact_id uuid;
  v_registration_id uuid;
  v_existing_contact_id uuid;
  v_existing_registration_id uuid;
begin
  -- 1) Resolve token server-side; never trust a client-supplied staff id.
  if p_token is null or btrim(p_token) = '' then
    return jsonb_build_object('valid', false, 'status', 'invalid_token', 'message', 'Invalid QR code.');
  end if;
  select * into v_token from public.event_qr_tokens where token = p_token;
  if not found then
    return jsonb_build_object('valid', false, 'status', 'invalid_token', 'message', 'Invalid QR code.');
  end if;
  if v_token.status <> 'active' then
    return jsonb_build_object('valid', false, 'status', v_token.status, 'message', 'This QR code is no longer active.');
  end if;

  -- 2) Event must exist and be active.
  select * into v_event from public.event_events where id = v_token.event_id;
  if not found then
    return jsonb_build_object('valid', false, 'status', 'invalid_event', 'message', 'Event not found.');
  end if;
  if v_event.status <> 'active' then
    return jsonb_build_object('valid', false, 'status', 'event_not_active', 'message', 'Registration is closed for this event.');
  end if;

  -- 3) Enforce the effective registration window (UTC storage; Asia/Kuala_Lumpur
  --    is the display concern handled by the app).
  v_opens_at := coalesce(v_event.registration_opens_at, v_event.starts_at);
  v_closes_at := coalesce(v_event.registration_closes_at, v_event.ends_at);
  if v_now < v_opens_at then
    return jsonb_build_object('valid', false, 'status', 'not_open', 'message', 'Registration is not open yet.');
  end if;
  if v_now > v_closes_at then
    return jsonb_build_object('valid', false, 'status', 'closed', 'message', 'Registration has closed.');
  end if;

  -- 4) Mandatory fields + server-side normalization/validation.
  v_name := btrim(coalesce(p_name, ''));
  if v_name = '' then
    return jsonb_build_object('valid', false, 'status', 'name_required', 'message', 'Name is required.');
  end if;

  v_phone := public.identity_normalize_phone(p_phone);
  if v_phone is null or v_phone !~ '^\+601\d{7,9}$' then
    return jsonb_build_object('valid', false, 'status', 'phone_invalid', 'message', 'A valid Malaysian mobile number is required.');
  end if;

  v_email := public.identity_normalize_email(p_email);

  -- 5) Attribution: first successful source is fixed. Booth => NULL.
  if v_token.kind = 'staff' then
    v_attributed := v_token.staff_user_id;
  else
    v_attributed := null;
  end if;

  -- 6) Duplicate guard: one normalized phone per event (fast path).
  select id into v_existing_contact_id
    from public.event_contacts
    where event_id = v_token.event_id and phone_normalized = v_phone;

  if v_existing_contact_id is not null then
    return jsonb_build_object('valid', true, 'status', 'duplicate', 'confirmed', true);
  end if;

  -- 7) Atomic insert: contact + registration + consents (all-or-nothing).
  insert into public.event_contacts
    (event_id, name, phone_normalized, email_normalized, cat_name, cat_breed, current_cat_food)
  values
    (v_token.event_id, v_name, v_phone, v_email,
     nullif(btrim(coalesce(p_cat_name, '')), ''),
     nullif(btrim(coalesce(p_cat_breed, '')), ''),
     nullif(btrim(coalesce(p_current_cat_food, '')), ''))
  returning id into v_contact_id;

  insert into public.event_registrations
    (event_id, contact_id, qr_token_id, attributed_staff_user_id, ip)
  values
    (v_token.event_id, v_contact_id, v_token.id, v_attributed, nullif(btrim(coalesce(p_ip, '')), ''))
  returning id into v_registration_id;

  insert into public.event_consents (registration_id, kind, granted)
  values (v_registration_id, 'registration', true);

  if p_marketing_consent is true then
    insert into public.event_consents (registration_id, kind, granted)
    values (v_registration_id, 'marketing', true);
  end if;

  return jsonb_build_object('valid', true, 'status', 'registered', 'confirmed', true);

exception
  when unique_violation then
    -- Concurrent same-phone submission: the other transaction won. Converge to
    -- exactly one contact + one registration and return a generic confirmation.
    select c.id, r.id into v_existing_contact_id, v_existing_registration_id
      from public.event_contacts c
      join public.event_registrations r on r.contact_id = c.id and r.event_id = c.event_id
      where c.event_id = v_token.event_id and c.phone_normalized = v_phone;
    if v_existing_registration_id is not null then
      return jsonb_build_object('valid', true, 'status', 'duplicate', 'confirmed', true);
    end if;
    raise;
end;
$$;

comment on function public.register_event_visitor(text,text,text,text,text,text,text,boolean,text) is
  'Atomic anonymous event registration: inserts contact + registration + consents in one transaction; enforces active status and the effective date window; normalizes/validates the Malaysian mobile phone; converges concurrent same-phone submissions to one registration. SECURITY DEFINER; service_role only.';

-- ---------------------------------------------------------------------------
-- Privileges: revoke EXECUTE from PUBLIC (and anon/authenticated); service_role only.
-- ---------------------------------------------------------------------------
revoke all on function public.validate_event_qr_token(text) from public, anon, authenticated;
revoke all on function public.register_event_visitor(text,text,text,text,text,text,text,boolean,text) from public, anon, authenticated;

grant execute on function public.validate_event_qr_token(text) to service_role;
grant execute on function public.register_event_visitor(text,text,text,text,text,text,text,boolean,text) to service_role;

