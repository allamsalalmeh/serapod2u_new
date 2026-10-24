-- Disposable schema that mirrors only the lock-relevant structure of the
-- canonical identity tables (no production data):
--   * hr_employees is in identity_deletion_plan.lock_tables because
--     onboarded_by / onboarding_reset_by are person columns without a FK;
--   * a permanent deletion takes LOCK TABLE hr_employees IN SHARE MODE and then
--     DELETEs from hr_employees in the same transaction;
--   * an archive UPDATEs hr_employees and INSERTs into identity_lifecycle_actions.
create extension if not exists pgcrypto;
create table users(id uuid primary key, account_status text not null default 'ACTIVE', updated_at timestamptz not null default now());
create table hr_employees(
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  onboarded_by uuid,
  onboarding_reset_by uuid,
  status text not null default 'active',
  end_date date,
  updated_at timestamptz not null default now()
);
create table identity_lifecycle_actions(
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  actor_id uuid not null,
  target_user_id uuid not null,
  action text not null,
  status text not null,
  details jsonb not null default '{}'::jsonb
);
create table identity_deletion_requests(
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  target_user_id uuid not null,
  status text not null
);
insert into users(id) values
 ('00000000-0000-0000-0000-00000000000a'),
 ('00000000-0000-0000-0000-00000000000b'),
 ('00000000-0000-0000-0000-00000000000c'),
 ('00000000-0000-0000-0000-00000000000d');
insert into hr_employees(user_id) select id from users;
