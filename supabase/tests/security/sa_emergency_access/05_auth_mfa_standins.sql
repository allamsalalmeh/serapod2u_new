-- DISPOSABLE sa_prof_test* DATABASES ONLY. Stand-ins for the GoTrue MFA tables the step-up check reads, with the
-- staging column names and enum types (verified read-only on staging, GoTrue v2.186.0). Rows are fixtures written
-- by the tests: this exercises the database decision logic, not GoTrue's TOTP verification.
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;
create type auth.aal_level as enum ('aal1', 'aal2', 'aal3');
create type auth.factor_type as enum ('totp', 'webauthn', 'phone');
create type auth.factor_status as enum ('unverified', 'verified');
create table auth.mfa_factors (id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade, friendly_name text,
  factor_type auth.factor_type not null, status auth.factor_status not null, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), secret text);
create table auth.sessions (id uuid primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(), updated_at timestamptz default now(), factor_id uuid, aal auth.aal_level, not_after timestamptz);
create table auth.mfa_amr_claims (session_id uuid not null references auth.sessions(id) on delete cascade, created_at timestamptz not null,
  updated_at timestamptz not null, authentication_method text not null, id uuid primary key default gen_random_uuid(),
  constraint mfa_amr_claims_session_id_authentication_method_pkey unique (session_id, authentication_method));
