-- ============================================================================
-- Finance → Cash & Banking: bank statement upload, validation and two-person
-- approval (extends 20261005130000_bank_statement_import)
-- ----------------------------------------------------------------------------
-- Workflow (one import row per uploaded file):
--
--   uploaded ──submit──▶ pending_approval ──approve──▶ completed ──reverse──▶ reversed
--      │                       │
--      └──────reject───────────┴──▶ rejected
--
--   * The original file is stored unchanged in the private bucket
--     'bank-statements' at {company_id}/{bank_account_id}/{import_id}/{file}.
--     Its SHA-256 is recorded; the same file cannot be imported twice.
--   * bank_statement_stage() re-checks the parsed lines in the database
--     (running balance, totals, period, monthly statement, overlap, duplicate
--     lines) and stores them in bank_statement_import_lines (immutable).
--   * The expected opening balance is the closing balance of the previous
--     completed statement, or the account opening balance (with its date)
--     when there is none. A difference, a gap or no basis at all requires a
--     written reason before submission.
--   * bank_statement_approve() is the only path that writes
--     bank_statement_transactions. The uploader/submitter can never approve
--     the same import (SoD rule bank-statement-maker-checker, enforced). A
--     temporary exception is a standard S&A SoD mitigation granted by a
--     Super Admin / security administrator to another person (never to
--     oneself); each use is recorded as 'allowed_mitigated'.
--   * bank_accounts.opening_balance / opening_balance_date and
--     statement_frequency can be set when the account is created; afterwards
--     only a Super Admin may change them, and every change is logged in
--     bank_statement_events.
--   * statement_frequency (per bank account) decides which files are accepted:
--       monthly  one whole calendar month per statement; any gap between
--                statements requires a reason.
--       daily    one day or several consecutive days within one calendar
--                month, never in the future; a gap requires a reason only when
--                the opening balance does not match (days without
--                transactions leave the balance unchanged).
--
-- Permissions: finance.statement.import (prepare + submit),
-- finance.statement.approve (approve, reject, reverse). Seeded in SHADOW and
-- registered as enforcement-ready (like Stage 2D): until a security
-- administrator switches them to NEW_ENFORCED in Security & Access
-- (sa_set_migration_mode), the legacy rule decides = Super Admin only. After
-- enforcement, the finance-statement-preparer / -approver roles apply.
-- (app/src/lib/security-access/bank-statement-catalog.ts mirrors this.)
--
-- Rollback (only while no import has used the new workflow):
--   drop function if exists public.bank_statement_stage(uuid,uuid,jsonb,jsonb);
--   drop function if exists public.bank_statement_check(uuid,date,date,text,numeric);
--   drop function if exists public.bank_statement_submit(uuid,text);
--   drop function if exists public.bank_statement_approve(uuid);
--   drop function if exists public.bank_statement_reject(uuid,text);
--   drop function if exists public.bank_statement_reverse(uuid,text);
--   drop trigger if exists bank_accounts_opening_balance_guard on public.bank_accounts;
--   drop function if exists public.bank_statement_reason_codes(text,numeric,integer,text);
--   drop function if exists public.bank_statement_period_error(text,date,date);
--   drop table if exists public.bank_statement_events, public.bank_statement_import_lines;
--   delete from public.sa_sod_rules where rule_key = 'bank-statement-maker-checker';
--   (permissions/roles: delete role grants, readiness, modes, compat rules, then sa_permissions rows)
--   grant insert on public.bank_statement_transactions, public.bank_statement_imports to authenticated;
--   grant update (rows_inserted, rows_skipped, status) on public.bank_statement_imports to authenticated;
-- ============================================================================

do $$
begin
  if to_regclass('public.bank_statement_imports') is null
     or to_regclass('public.bank_statement_transactions') is null then
    raise exception 'requires migration 20261005130000_bank_statement_import';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Bank accounts: opening balance date
-- ---------------------------------------------------------------------------
alter table public.bank_accounts
  add column if not exists opening_balance_date date;
alter table public.bank_accounts
  add column if not exists statement_frequency text not null default 'monthly';
alter table public.bank_accounts drop constraint if exists bank_accounts_statement_frequency_check;
alter table public.bank_accounts add constraint bank_accounts_statement_frequency_check
  check (statement_frequency in ('monthly','daily'));
comment on column public.bank_accounts.statement_frequency is
  'Bank statement files accepted for this account: monthly (whole calendar month) or daily (one or more consecutive days within a month). Changeable only by Super Admin after creation.';
comment on column public.bank_accounts.opening_balance_date is
  'Date the opening_balance refers to (end of day). Used as the opening basis for the first imported statement. Changeable only by Super Admin.';

-- ---------------------------------------------------------------------------
-- 2. Import header: file, validation and approval columns
-- ---------------------------------------------------------------------------
alter table public.bank_statement_imports
  add column if not exists period_type text not null default 'monthly',
  add column if not exists file_path text,
  add column if not exists file_size bigint,
  add column if not exists file_sha256 text,
  add column if not exists total_debit numeric(18,2),
  add column if not exists total_credit numeric(18,2),
  add column if not exists debit_count integer,
  add column if not exists credit_count integer,
  add column if not exists expected_opening_balance numeric(18,2),
  add column if not exists opening_difference numeric(18,2),
  add column if not exists opening_basis text,
  add column if not exists previous_import_id uuid references public.bank_statement_imports(id) on delete restrict,
  add column if not exists reason_required boolean not null default false,
  add column if not exists mismatch_reason text,
  add column if not exists validation jsonb not null default '{}'::jsonb,
  add column if not exists submitted_by uuid references public.users(id) on delete set null,
  add column if not exists submitted_at timestamptz,
  add column if not exists approved_by uuid references public.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists rejected_by uuid references public.users(id) on delete set null,
  add column if not exists rejected_at timestamptz,
  add column if not exists rejection_reason text,
  add column if not exists reversed_by uuid references public.users(id) on delete set null,
  add column if not exists reversed_at timestamptz,
  add column if not exists reversal_reason text;

alter table public.bank_statement_imports drop constraint if exists bank_statement_imports_status_check;
alter table public.bank_statement_imports add constraint bank_statement_imports_status_check
  check (status in ('pending','uploaded','pending_approval','rejected','completed','failed','reversed'));
-- 'pending' is kept only for rows written by the first (direct) import route.

alter table public.bank_statement_imports drop constraint if exists bank_statement_imports_period_type_check;
alter table public.bank_statement_imports add constraint bank_statement_imports_period_type_check
  check (period_type in ('monthly','daily'));
alter table public.bank_statement_imports drop constraint if exists bank_statement_imports_file_sha256_check;
alter table public.bank_statement_imports add constraint bank_statement_imports_file_sha256_check
  check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$');
alter table public.bank_statement_imports drop constraint if exists bank_statement_imports_file_size_check;
alter table public.bank_statement_imports add constraint bank_statement_imports_file_size_check
  check (file_size is null or file_size > 0);
alter table public.bank_statement_imports drop constraint if exists bank_statement_imports_opening_basis_check;
alter table public.bank_statement_imports add constraint bank_statement_imports_opening_basis_check
  check (opening_basis is null or opening_basis in ('previous_statement','account_opening_balance','none'));
alter table public.bank_statement_imports drop constraint if exists bank_statement_imports_period_valid;
alter table public.bank_statement_imports add constraint bank_statement_imports_period_valid
  check (period_start is null or period_end is null or period_end >= period_start);

-- The same file (by content) can be live only once per account.
create unique index if not exists bank_statement_imports_file_once
  on public.bank_statement_imports (bank_account_id, file_sha256)
  where file_sha256 is not null and status in ('uploaded','pending_approval','completed');
create index if not exists bank_statement_imports_status_idx
  on public.bank_statement_imports (status, imported_at desc);

-- Header writes go through the workflow functions only.
revoke insert, update on table public.bank_statement_imports from authenticated;

-- ---------------------------------------------------------------------------
-- 3. Transactions: row number, restrict FK, no direct writes
-- ---------------------------------------------------------------------------
alter table public.bank_statement_transactions
  add column if not exists source_row_no integer;

do $$
declare v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  where c.conrelid = 'public.bank_statement_transactions'::regclass and c.contype = 'f'
    and c.confrelid = 'public.bank_statement_imports'::regclass;
  if v_name is not null then
    execute format('alter table public.bank_statement_transactions drop constraint %I', v_name);
  end if;
  alter table public.bank_statement_transactions
    add constraint bank_statement_transactions_import_id_fkey
    foreign key (import_id) references public.bank_statement_imports(id) on delete restrict;
end $$;

create index if not exists bank_statement_transactions_import_idx
  on public.bank_statement_transactions (import_id);

revoke insert, update, delete on table public.bank_statement_transactions from authenticated;

-- ---------------------------------------------------------------------------
-- 4. Staged lines (immutable copy of the validated file content)
-- ---------------------------------------------------------------------------
create table if not exists public.bank_statement_import_lines (
  import_id uuid not null references public.bank_statement_imports(id) on delete restrict,
  company_id uuid not null references public.organizations(id),
  bank_account_id uuid not null references public.bank_accounts(id) on delete restrict,
  line_no integer not null check (line_no > 0),
  source_row_no integer not null check (source_row_no > 0),
  transaction_date date not null,
  day_sequence integer not null check (day_sequence > 0),
  description text,
  cheque_no text,
  counterparty text,
  reference text,
  payment_details text,
  debit_amount numeric(18,2) not null default 0 check (debit_amount >= 0),
  credit_amount numeric(18,2) not null default 0 check (credit_amount >= 0),
  balance numeric(18,2) not null,
  branch_code text,
  dedupe_key text not null check (length(dedupe_key) between 1 and 200),
  primary key (import_id, line_no),
  constraint bank_statement_import_lines_key unique (import_id, dedupe_key),
  constraint bank_statement_import_lines_row unique (import_id, source_row_no)
);
comment on table public.bank_statement_import_lines is
  'Validated lines of an uploaded statement, in chronological order (line_no). Immutable. Copied to bank_statement_transactions on approval.';

drop trigger if exists bank_statement_import_lines_append_only on public.bank_statement_import_lines;
create trigger bank_statement_import_lines_append_only before update or delete on public.bank_statement_import_lines
for each row execute function public.sa_reject_append_only_mutation();
drop trigger if exists bank_statement_import_lines_no_truncate on public.bank_statement_import_lines;
create trigger bank_statement_import_lines_no_truncate before truncate on public.bank_statement_import_lines
for each statement execute function public.sa_reject_append_only_mutation();

-- ---------------------------------------------------------------------------
-- 5. Event log (append-only)
-- ---------------------------------------------------------------------------
create table if not exists public.bank_statement_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  company_id uuid not null references public.organizations(id),
  bank_account_id uuid not null references public.bank_accounts(id) on delete restrict,
  import_id uuid references public.bank_statement_imports(id) on delete restrict,
  event text not null check (event in ('uploaded','submitted','approved','rejected','reversed','opening_balance_changed','statement_frequency_changed')),
  actor_id uuid,           -- no FK: the log outlives user records
  reason text,
  details jsonb not null default '{}'::jsonb
);
create index if not exists bank_statement_events_account_idx on public.bank_statement_events (bank_account_id, occurred_at desc);
create index if not exists bank_statement_events_import_idx on public.bank_statement_events (import_id, occurred_at);

drop trigger if exists bank_statement_events_append_only on public.bank_statement_events;
create trigger bank_statement_events_append_only before update or delete on public.bank_statement_events
for each row execute function public.sa_reject_append_only_mutation();
drop trigger if exists bank_statement_events_no_truncate on public.bank_statement_events;
create trigger bank_statement_events_no_truncate before truncate on public.bank_statement_events
for each statement execute function public.sa_reject_append_only_mutation();

alter table public.bank_statement_import_lines enable row level security;
alter table public.bank_statement_events enable row level security;
revoke all on table public.bank_statement_import_lines from public, anon, authenticated;
revoke all on table public.bank_statement_events from public, anon, authenticated;
grant select on table public.bank_statement_import_lines to authenticated;
grant select on table public.bank_statement_events to authenticated;
grant select on table public.bank_statement_import_lines to service_role;
grant select on table public.bank_statement_events to service_role;

-- ---------------------------------------------------------------------------
-- 6. Permissions, roles, SoD rule
-- ---------------------------------------------------------------------------
insert into public.sa_permissions(permission_key, module, resource, action, description, source, audit_sensitivity) values
 ('finance.statement.import','finance','statement','import','Upload a bank statement file, validate it and submit it for approval','new','security_sensitive'),
 ('finance.statement.approve','finance','statement','approve','Approve, reject or reverse an uploaded bank statement (never one you uploaded or submitted)','new','security_sensitive')
on conflict (permission_key) do nothing;

insert into public.sa_migration_modes(permission_key, mode, legacy_permission_key, notes)
select k, 'SHADOW', null, 'Bank statement approval: legacy (Super Admin only) decides until enforced from Security & Access.'
from unnest(array['finance.statement.import','finance.statement.approve']) k
on conflict (permission_key) do nothing;

insert into public.sa_enforcement_readiness(permission_key, route_wiring, database_backstop, intentional_tightening, notes) values
 ('finance.statement.import', true, 'rpc_guard', null, 'Bank statement routes decide through S&A; bank_statement_stage/submit re-check the actor.'),
 ('finance.statement.approve', true, 'rpc_guard', null, 'Bank statement routes decide through S&A; bank_statement_approve/reject/reverse re-check the actor and enforce maker/checker.')
on conflict (permission_key) do nothing;

-- Compatibility: only Super Admin (role level 1) holds them by default.
insert into public.sa_legacy_compat_rules(permission_key, max_role_level, role_codes, legacy_permissions, employee_baseline, notes) values
 ('finance.statement.import', 1, '{}', '{}', false, 'Bank statement approval: Super Admin only; others through finance-statement-* roles'),
 ('finance.statement.approve', 1, '{}', '{}', false, 'Bank statement approval: Super Admin only; others through finance-statement-* roles')
on conflict (permission_key) do nothing;

insert into public.sa_business_roles(role_key, name, description, source) values
 ('finance-statement-preparer','Bank Statement Preparer','Uploads bank statement files, reviews validation and submits them for approval.','template'),
 ('finance-statement-approver','Bank Statement Approver','Approves, rejects or reverses bank statements uploaded by someone else.','template')
on conflict (role_key) do nothing;

insert into public.sa_business_role_permissions(role_id, permission_id)
select br.id, p.id
from (values
  ('finance-statement-preparer', array['finance.module.view','finance.cash.view','finance.statement.import']),
  ('finance-statement-approver', array['finance.module.view','finance.cash.view','finance.statement.approve']),
  ('finance-admin',              array['finance.statement.import','finance.statement.approve'])
) as t(role_key, keys)
join public.sa_business_roles br on br.role_key = t.role_key
join public.sa_permissions p on p.permission_key = any(t.keys)
on conflict do nothing;

-- Existing Super Admin compatibility role (if present): both permissions.
insert into public.sa_business_role_permissions(role_id, permission_id)
select br.id, p.id
from public.sa_business_roles br
join public.sa_permissions p on p.permission_key in ('finance.statement.import','finance.statement.approve')
where br.role_key in (select public.sa_compat_role_key(r.role_code) from public.roles r where r.role_level = 1)
on conflict do nothing;

insert into public.sa_sod_rules(rule_key, name, description, rule_kind, left_key, right_key, document_type, enforcement) values
 ('bank-statement-maker-checker', 'Bank statement maker/checker',
  'The person who uploaded or submitted a bank statement may not approve it.',
  'same_document', 'finance.statement.import', 'finance.statement.approve', 'bank_statement_import', 'enforce')
on conflict (rule_key) do nothing;

-- ---------------------------------------------------------------------------
-- 7. Read access for the workflow roles
-- ---------------------------------------------------------------------------
drop policy if exists bank_statement_imports_workflow_read on public.bank_statement_imports;
create policy bank_statement_imports_workflow_read on public.bank_statement_imports for select to authenticated
  using (public.sa_rls_gate('finance.statement.import', company_id, false)
      or public.sa_rls_gate('finance.statement.approve', company_id, false));

drop policy if exists bank_statement_import_lines_read on public.bank_statement_import_lines;
create policy bank_statement_import_lines_read on public.bank_statement_import_lines for select to authenticated
  using (public.sa_rls_gate('finance.statement.import', company_id, false)
      or public.sa_rls_gate('finance.statement.approve', company_id, false)
      or public.sa_rls_gate('finance.cash.view', company_id, false));

drop policy if exists bank_statement_events_read on public.bank_statement_events;
create policy bank_statement_events_read on public.bank_statement_events for select to authenticated
  using (public.sa_rls_gate('finance.statement.import', company_id, false)
      or public.sa_rls_gate('finance.statement.approve', company_id, false)
      or public.sa_rls_gate('finance.cash.view', company_id, false));

-- ---------------------------------------------------------------------------
-- 8. Private storage bucket for the original files
-- ---------------------------------------------------------------------------
-- No storage policies are created: browsers can neither list, read, write nor
-- delete. The server uploads (upsert: false) and serves downloads with the
-- service role after its own authorization check.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('bank-statements', 'bank-statements', false, 5242880,
        array['text/csv','text/plain','application/vnd.ms-excel','application/octet-stream'])
on conflict (id) do update set public = false;

-- ---------------------------------------------------------------------------
-- 9. Helpers
-- ---------------------------------------------------------------------------
create or replace function public.bank_statement_actor()
returns uuid language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare v uuid := auth.uid();
begin
  if v is null then raise exception 'bank_statement_actor_required' using errcode = '42501'; end if;
  return v;
end $$;
revoke all on function public.bank_statement_actor() from public, anon, authenticated;

create or replace function public.bank_statement_assert(p_actor uuid, p_permission text, p_company uuid)
returns void language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform public.sa_assert_actor_permission(p_actor, p_permission,
    jsonb_build_object('organization_id', p_company), public.sa_legacy_is_super_admin(p_actor));
end $$;
revoke all on function public.bank_statement_assert(uuid,text,uuid) from public, anon, authenticated;

create or replace function public.bank_statement_has(p_actor uuid, p_permission text, p_company uuid)
returns boolean language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform public.bank_statement_assert(p_actor, p_permission, p_company);
  return true;
exception when insufficient_privilege then
  return false;
end $$;
revoke all on function public.bank_statement_has(uuid,text,uuid) from public, anon, authenticated;

-- Opening basis for a statement starting on p_period_start.
create or replace function public.bank_statement_opening_basis(p_bank_account_id uuid, p_period_start date, p_exclude uuid)
returns table(expected numeric, basis text, previous_import_id uuid, gap_days integer)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_prev record;
  v_acc record;
begin
  select i.id, i.closing_balance, i.period_end into v_prev
  from public.bank_statement_imports i
  where i.bank_account_id = p_bank_account_id and i.status = 'completed'
    and i.period_end < p_period_start and i.id is distinct from p_exclude
  order by i.period_end desc, i.approved_at desc nulls last
  limit 1;
  if found then
    return query select v_prev.closing_balance, 'previous_statement'::text, v_prev.id,
                        (p_period_start - v_prev.period_end - 1)::integer;
    return;
  end if;
  select b.opening_balance, b.opening_balance_date into v_acc from public.bank_accounts b where b.id = p_bank_account_id;
  if v_acc.opening_balance_date is not null and v_acc.opening_balance_date < p_period_start then
    return query select coalesce(v_acc.opening_balance, 0)::numeric, 'account_opening_balance'::text, null::uuid,
                        (p_period_start - v_acc.opening_balance_date - 1)::integer;
    return;
  end if;
  return query select null::numeric, 'none'::text, null::uuid, null::integer;
end $$;
revoke all on function public.bank_statement_opening_basis(uuid,date,uuid) from public, anon, authenticated;

create or replace function public.bank_statement_log(
  p_company uuid, p_account uuid, p_import uuid, p_event text, p_actor uuid, p_reason text, p_details jsonb)
returns void language sql security definer set search_path = pg_catalog, pg_temp as $$
  insert into public.bank_statement_events(company_id, bank_account_id, import_id, event, actor_id, reason, details)
  values (p_company, p_account, p_import, p_event, p_actor, p_reason, coalesce(p_details, '{}'::jsonb))
$$;
revoke all on function public.bank_statement_log(uuid,uuid,uuid,text,uuid,text,jsonb) from public, anon, authenticated;

-- Why a submission needs a written reason. A gap between statements only
-- matters for daily accounts when the balance does not continue.
create or replace function public.bank_statement_reason_codes(
  p_basis text, p_difference numeric, p_gap_days integer, p_period_type text)
returns text[] language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array_remove(array[
    case when p_basis = 'none' then 'no_opening_basis' end,
    case when p_difference is not null and p_difference <> 0 then 'opening_mismatch' end,
    case when coalesce(p_gap_days, 0) > 0 and (p_period_type <> 'daily' or coalesce(p_difference, 0) <> 0)
         then 'period_gap' end
  ]::text[], null)
$$;
revoke all on function public.bank_statement_reason_codes(text,numeric,integer,text) from public, anon, authenticated;

-- Period rules per account frequency. Returns null when valid, else the error code.
create or replace function public.bank_statement_period_error(p_frequency text, p_start date, p_end date)
returns text language sql stable set search_path = pg_catalog, pg_temp as $$
  select case
    when p_start is null or p_end is null or p_end < p_start then 'bank_statement_period_invalid'
    when p_frequency = 'monthly'
         and (p_start <> date_trunc('month', p_start)::date
              or p_end <> (date_trunc('month', p_start) + interval '1 month - 1 day')::date)
      then 'bank_statement_not_full_month'
    when p_frequency = 'daily' and date_trunc('month', p_start) <> date_trunc('month', p_end)
      then 'bank_statement_period_crosses_month'
    when p_frequency = 'daily' and p_end > (now() at time zone 'Asia/Kuala_Lumpur')::date
      then 'bank_statement_period_in_future'
    when p_frequency not in ('monthly','daily') then 'bank_statement_period_type_not_supported'
  end
$$;
revoke all on function public.bank_statement_period_error(text,date,date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 10. Stage: record an uploaded + parsed file (status 'uploaded')
-- ---------------------------------------------------------------------------
-- p_file: { file_name, file_path, file_size, file_sha256, source_format,
--           period_type, period_start, period_end, opening_balance,
--           closing_balance, account_number, currency_code, warnings[] }
-- p_lines: [{ line_no, source_row_no, transaction_date, day_sequence,
--             description, cheque_no, counterparty, reference,
--             payment_details, debit_amount, credit_amount, balance,
--             branch_code, dedupe_key }]  (chronological order)
create or replace function public.bank_statement_stage(
  p_import_id uuid, p_bank_account_id uuid, p_file jsonb, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_actor uuid := public.bank_statement_actor();
  v_acc public.bank_accounts;
  v_start date; v_end date; v_type text;
  v_open numeric(18,2); v_close numeric(18,2);
  v_path text; v_sha text; v_size bigint; v_name text;
  v_n integer; v_bad integer; v_existing integer;
  v_debit numeric(18,2); v_credit numeric(18,2); v_dc integer; v_cc integer;
  v_last_balance numeric(18,2);
  v_basis record;
  v_diff numeric(18,2);
  v_reasons text[] := array[]::text[];
  v_validation jsonb;
begin
  if p_import_id is null or p_bank_account_id is null or p_file is null
     or jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'bank_statement_invalid_request' using errcode = '22023';
  end if;

  select * into v_acc from public.bank_accounts where id = p_bank_account_id;
  if not found then raise exception 'bank_account_not_found' using errcode = 'P0002'; end if;
  perform public.bank_statement_assert(v_actor, 'finance.statement.import', v_acc.company_id);
  if v_acc.is_active is false then raise exception 'bank_account_inactive' using errcode = '22023'; end if;

  perform pg_advisory_xact_lock(hashtextextended('bank_statement:' || p_bank_account_id::text, 0));

  -- Account and currency match
  if regexp_replace(coalesce(p_file->>'account_number',''), '\D', '', 'g')
     is distinct from regexp_replace(coalesce(v_acc.account_number,''), '\D', '', 'g')
     or regexp_replace(coalesce(v_acc.account_number,''), '\D', '', 'g') = '' then
    raise exception 'bank_statement_account_mismatch' using errcode = '22023';
  end if;
  if nullif(p_file->>'currency_code','') is not null
     and upper(p_file->>'currency_code') is distinct from upper(coalesce(v_acc.currency_code,'MYR')) then
    raise exception 'bank_statement_currency_mismatch' using errcode = '22023';
  end if;

  -- Period: follows the account's statement frequency
  v_type  := v_acc.statement_frequency;
  v_start := (p_file->>'period_start')::date;
  v_end   := (p_file->>'period_end')::date;
  if nullif(p_file->>'period_type','') is not null and p_file->>'period_type' <> v_type then
    raise exception 'bank_statement_period_type_mismatch' using errcode = '22023',
      detail = format('account=%s file=%s', v_type, p_file->>'period_type');
  end if;
  if public.bank_statement_period_error(v_type, v_start, v_end) is not null then
    raise exception '%', public.bank_statement_period_error(v_type, v_start, v_end) using errcode = '22023',
      detail = format('%s..%s (%s)', v_start, v_end, v_type);
  end if;

  -- File (the server stored the original before calling)
  v_name := nullif(btrim(p_file->>'file_name'), '');
  v_path := p_file->>'file_path';
  v_sha  := lower(p_file->>'file_sha256');
  v_size := (p_file->>'file_size')::bigint;
  if v_name is null or v_sha is null or v_sha !~ '^[0-9a-f]{64}$' or coalesce(v_size, 0) <= 0 then
    raise exception 'bank_statement_file_metadata_invalid' using errcode = '22023';
  end if;
  if v_path is null or v_path not like format('%s/%s/%s/%%', v_acc.company_id, p_bank_account_id, p_import_id) then
    raise exception 'bank_statement_file_path_invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'bank-statements' and o.name = v_path) then
    raise exception 'bank_statement_file_not_stored' using errcode = '22023';
  end if;
  if exists (select 1 from public.bank_statement_imports i
             where i.bank_account_id = p_bank_account_id and i.file_sha256 = v_sha
               and i.status in ('uploaded','pending_approval','completed')) then
    raise exception 'bank_statement_duplicate_file' using errcode = '23505';
  end if;

  -- Period overlap with any live statement of this account
  if exists (select 1 from public.bank_statement_imports i
             where i.bank_account_id = p_bank_account_id
               and i.status in ('uploaded','pending_approval','completed')
               and daterange(i.period_start, i.period_end, '[]') && daterange(v_start, v_end, '[]')) then
    raise exception 'bank_statement_period_overlap' using errcode = '23P01';
  end if;

  v_open  := (p_file->>'opening_balance')::numeric;
  v_close := (p_file->>'closing_balance')::numeric;
  if v_open is null or v_close is null then
    raise exception 'bank_statement_balances_missing' using errcode = '22023';
  end if;

  -- Lines: shape and per-line rules
  create temporary table if not exists pg_temp.bs_stage_lines (
    line_no integer, source_row_no integer, transaction_date date, day_sequence integer,
    description text, cheque_no text, counterparty text, reference text, payment_details text,
    debit_amount numeric(18,2), credit_amount numeric(18,2), balance numeric(18,2),
    branch_code text, dedupe_key text) on commit drop;
  truncate pg_temp.bs_stage_lines;
  insert into pg_temp.bs_stage_lines
  select (l->>'line_no')::int, (l->>'source_row_no')::int, (l->>'transaction_date')::date,
         coalesce((l->>'day_sequence')::int, 1),
         l->>'description', l->>'cheque_no', l->>'counterparty', l->>'reference', l->>'payment_details',
         coalesce((l->>'debit_amount')::numeric, 0), coalesce((l->>'credit_amount')::numeric, 0),
         (l->>'balance')::numeric, l->>'branch_code', l->>'dedupe_key'
  from jsonb_array_elements(p_lines) l;

  select count(*) into v_n from pg_temp.bs_stage_lines;
  if v_n = 0 then raise exception 'bank_statement_no_lines' using errcode = '22023'; end if;
  if v_n > 20000 then raise exception 'bank_statement_too_many_lines' using errcode = '22023'; end if;

  -- line_no must be exactly 1..n
  if (select count(distinct line_no) from pg_temp.bs_stage_lines where line_no between 1 and v_n) <> v_n then
    raise exception 'bank_statement_line_numbers_invalid' using errcode = '22023';
  end if;

  select count(*) into v_bad from pg_temp.bs_stage_lines
  where transaction_date is null or balance is null or source_row_no is null or source_row_no < 1
     or nullif(dedupe_key, '') is null
     or debit_amount < 0 or credit_amount < 0 or (debit_amount > 0 and credit_amount > 0)
     or transaction_date < v_start or transaction_date > v_end;
  if v_bad > 0 then
    raise exception 'bank_statement_lines_invalid' using errcode = '22023', detail = format('%s line(s)', v_bad);
  end if;

  -- Chronological order and running balance: balance(n) = balance(n-1) + credit - debit
  select count(*) into v_bad from (
    select transaction_date, balance, debit_amount, credit_amount,
           lag(transaction_date) over w as prev_date,
           coalesce(lag(balance) over w, v_open) as prev_balance
    from pg_temp.bs_stage_lines window w as (order by line_no)
  ) s
  where (prev_date is not null and transaction_date < prev_date)
     or balance <> prev_balance + credit_amount - debit_amount;
  if v_bad > 0 then
    raise exception 'bank_statement_running_balance_invalid' using errcode = '22023', detail = format('%s line(s)', v_bad);
  end if;

  select sum(debit_amount), sum(credit_amount),
         count(*) filter (where debit_amount > 0), count(*) filter (where credit_amount > 0)
  into v_debit, v_credit, v_dc, v_cc from pg_temp.bs_stage_lines;
  select balance into v_last_balance from pg_temp.bs_stage_lines order by line_no desc limit 1;
  if v_last_balance <> v_close or v_open + v_credit - v_debit <> v_close then
    raise exception 'bank_statement_closing_balance_mismatch' using errcode = '22023';
  end if;

  -- Lines already stored for this account (monthly statements never overlap)
  select count(*) into v_existing from pg_temp.bs_stage_lines s
  where exists (select 1 from public.bank_statement_transactions t
                where t.bank_account_id = p_bank_account_id and t.dedupe_key = s.dedupe_key);
  if v_existing > 0 then
    raise exception 'bank_statement_lines_already_imported' using errcode = '23505', detail = format('%s line(s)', v_existing);
  end if;

  -- Opening balance vs previous closing
  select * into v_basis from public.bank_statement_opening_basis(p_bank_account_id, v_start, null);
  v_diff := case when v_basis.expected is null then null else v_open - v_basis.expected end;
  v_reasons := public.bank_statement_reason_codes(v_basis.basis, v_diff, v_basis.gap_days, v_type);

  v_validation := jsonb_build_object(
    'checked_at', now(),
    'rows', v_n,
    'reason_codes', to_jsonb(v_reasons),
    'gap_days', v_basis.gap_days,
    'warnings', coalesce(p_file->'warnings', '[]'::jsonb));

  insert into public.bank_statement_imports(
    id, company_id, bank_account_id, source_format, file_name, period_type, period_start, period_end,
    opening_balance, closing_balance, rows_in_file, rows_inserted, rows_skipped, status, imported_by, imported_at,
    file_path, file_size, file_sha256, total_debit, total_credit, debit_count, credit_count,
    expected_opening_balance, opening_difference, opening_basis, previous_import_id,
    reason_required, validation)
  values (
    p_import_id, v_acc.company_id, p_bank_account_id, coalesce(nullif(p_file->>'source_format',''), 'HLB_CSV'),
    v_name, v_type, v_start, v_end, v_open, v_close, v_n, 0, 0, 'uploaded', v_actor, now(),
    v_path, v_size, v_sha, v_debit, v_credit, v_dc, v_cc,
    v_basis.expected, v_diff, v_basis.basis, v_basis.previous_import_id,
    cardinality(v_reasons) > 0, v_validation);

  insert into public.bank_statement_import_lines(
    import_id, company_id, bank_account_id, line_no, source_row_no, transaction_date, day_sequence,
    description, cheque_no, counterparty, reference, payment_details,
    debit_amount, credit_amount, balance, branch_code, dedupe_key)
  select p_import_id, v_acc.company_id, p_bank_account_id, line_no, source_row_no, transaction_date, day_sequence,
         description, cheque_no, counterparty, reference, payment_details,
         debit_amount, credit_amount, balance, branch_code, dedupe_key
  from pg_temp.bs_stage_lines order by line_no;

  perform public.bank_statement_log(v_acc.company_id, p_bank_account_id, p_import_id, 'uploaded', v_actor, null,
    jsonb_build_object('file_name', v_name, 'file_sha256', v_sha, 'file_size', v_size,
                       'period_start', v_start, 'period_end', v_end, 'rows', v_n));

  return jsonb_build_object(
    'import_id', p_import_id, 'status', 'uploaded', 'rows', v_n,
    'period_start', v_start, 'period_end', v_end,
    'opening_balance', v_open, 'closing_balance', v_close,
    'total_debit', v_debit, 'total_credit', v_credit, 'debit_count', v_dc, 'credit_count', v_cc,
    'expected_opening_balance', v_basis.expected, 'opening_difference', v_diff, 'opening_basis', v_basis.basis,
    'reason_required', cardinality(v_reasons) > 0, 'reason_codes', to_jsonb(v_reasons));
end $$;
revoke all on function public.bank_statement_stage(uuid,uuid,jsonb,jsonb) from public, anon;
grant execute on function public.bank_statement_stage(uuid,uuid,jsonb,jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 10b. Read-only pre-check used by the preview (no writes)
-- ---------------------------------------------------------------------------
create or replace function public.bank_statement_check(
  p_bank_account_id uuid, p_period_start date, p_period_end date, p_file_sha256 text, p_opening_balance numeric)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_actor uuid := public.bank_statement_actor();
  v_company uuid;
  v_frequency text;
  v_period_error text;
  v_dup record;
  v_overlap record;
  v_basis record;
  v_diff numeric(18,2);
  v_reasons text[] := array[]::text[];
begin
  select company_id, statement_frequency into v_company, v_frequency from public.bank_accounts where id = p_bank_account_id;
  if v_company is null then raise exception 'bank_account_not_found' using errcode = 'P0002'; end if;
  perform public.bank_statement_assert(v_actor, 'finance.statement.import', v_company);
  v_period_error := public.bank_statement_period_error(v_frequency, p_period_start, p_period_end);

  select i.id, i.status, i.period_start, i.period_end into v_dup from public.bank_statement_imports i
  where i.bank_account_id = p_bank_account_id and i.file_sha256 = lower(p_file_sha256)
    and i.status in ('uploaded','pending_approval','completed')
  limit 1;
  select i.id, i.status, i.period_start, i.period_end into v_overlap from public.bank_statement_imports i
  where i.bank_account_id = p_bank_account_id and i.status in ('uploaded','pending_approval','completed')
    and daterange(i.period_start, i.period_end, '[]') && daterange(p_period_start, p_period_end, '[]')
  order by i.period_start limit 1;

  select * into v_basis from public.bank_statement_opening_basis(p_bank_account_id, p_period_start, null);
  v_diff := case when v_basis.expected is null or p_opening_balance is null then null else p_opening_balance - v_basis.expected end;
  v_reasons := public.bank_statement_reason_codes(v_basis.basis, v_diff, v_basis.gap_days, v_frequency);

  return jsonb_build_object(
    'statement_frequency', v_frequency, 'period_error', v_period_error,
    'duplicate_file', case when v_dup.id is null then null else jsonb_build_object('import_id', v_dup.id, 'status', v_dup.status, 'period_start', v_dup.period_start, 'period_end', v_dup.period_end) end,
    'overlap', case when v_overlap.id is null then null else jsonb_build_object('import_id', v_overlap.id, 'status', v_overlap.status, 'period_start', v_overlap.period_start, 'period_end', v_overlap.period_end) end,
    'expected_opening_balance', v_basis.expected, 'opening_basis', v_basis.basis,
    'opening_difference', v_diff, 'gap_days', v_basis.gap_days,
    'reason_required', cardinality(v_reasons) > 0, 'reason_codes', to_jsonb(v_reasons));
end $$;
revoke all on function public.bank_statement_check(uuid,date,date,text,numeric) from public, anon;
grant execute on function public.bank_statement_check(uuid,date,date,text,numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- 11. Submit for approval
-- ---------------------------------------------------------------------------
create or replace function public.bank_statement_submit(p_import_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_actor uuid := public.bank_statement_actor();
  v_imp public.bank_statement_imports;
  v_basis record;
  v_diff numeric(18,2);
  v_required boolean;
  v_reason text := nullif(btrim(p_reason), '');
begin
  select * into v_imp from public.bank_statement_imports where id = p_import_id;
  if not found then raise exception 'bank_statement_not_found' using errcode = 'P0002'; end if;
  perform public.bank_statement_assert(v_actor, 'finance.statement.import', v_imp.company_id);
  perform pg_advisory_xact_lock(hashtextextended('bank_statement:' || v_imp.bank_account_id::text, 0));
  select * into v_imp from public.bank_statement_imports where id = p_import_id for update;
  if v_imp.status <> 'uploaded' then
    raise exception 'bank_statement_invalid_status' using errcode = '22023', detail = v_imp.status;
  end if;

  -- Re-evaluate the opening basis (another statement may have been approved meanwhile)
  select * into v_basis from public.bank_statement_opening_basis(v_imp.bank_account_id, v_imp.period_start, v_imp.id);
  v_diff := case when v_basis.expected is null then null else v_imp.opening_balance - v_basis.expected end;
  v_required := cardinality(public.bank_statement_reason_codes(v_basis.basis, v_diff, v_basis.gap_days, v_imp.period_type)) > 0;

  if v_required and (v_reason is null or length(v_reason) < 10) then
    raise exception 'bank_statement_reason_required' using errcode = '22023',
      detail = 'A reason of at least 10 characters is required (opening balance difference, gap or no basis).';
  end if;

  update public.bank_statement_imports set
    status = 'pending_approval', submitted_by = v_actor, submitted_at = now(),
    expected_opening_balance = v_basis.expected, opening_difference = v_diff,
    opening_basis = v_basis.basis, previous_import_id = v_basis.previous_import_id,
    reason_required = v_required, mismatch_reason = v_reason
  where id = p_import_id;

  perform public.bank_statement_log(v_imp.company_id, v_imp.bank_account_id, p_import_id, 'submitted', v_actor, v_reason,
    jsonb_build_object('expected_opening_balance', v_basis.expected, 'opening_difference', v_diff,
                       'opening_basis', v_basis.basis, 'reason_required', v_required));
  return jsonb_build_object('import_id', p_import_id, 'status', 'pending_approval', 'reason_required', v_required);
end $$;
revoke all on function public.bank_statement_submit(uuid,text) from public, anon;
grant execute on function public.bank_statement_submit(uuid,text) to authenticated;

-- ---------------------------------------------------------------------------
-- 12. Approve: the only writer of bank_statement_transactions
-- ---------------------------------------------------------------------------
create or replace function public.bank_statement_approve(p_import_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_actor uuid := public.bank_statement_actor();
  v_imp public.bank_statement_imports;
  v_basis record;
  v_existing integer;
  v_inserted integer;
begin
  select * into v_imp from public.bank_statement_imports where id = p_import_id;
  if not found then raise exception 'bank_statement_not_found' using errcode = 'P0002'; end if;
  perform public.bank_statement_assert(v_actor, 'finance.statement.approve', v_imp.company_id);
  perform pg_advisory_xact_lock(hashtextextended('bank_statement:' || v_imp.bank_account_id::text, 0));
  select * into v_imp from public.bank_statement_imports where id = p_import_id for update;
  if v_imp.status <> 'pending_approval' then
    raise exception 'bank_statement_invalid_status' using errcode = '22023', detail = v_imp.status;
  end if;

  -- Two-person rule (enforced; a granted SoD mitigation is the only exception)
  perform public.sa_enforce_same_document_sod('bank-statement-maker-checker', p_import_id::text, v_actor,
    array_remove(array[v_imp.imported_by, v_imp.submitted_by], null));

  -- The basis the submitter justified must still hold
  select * into v_basis from public.bank_statement_opening_basis(v_imp.bank_account_id, v_imp.period_start, v_imp.id);
  if v_basis.basis is distinct from v_imp.opening_basis
     or v_basis.expected is distinct from v_imp.expected_opening_balance
     or v_basis.previous_import_id is distinct from v_imp.previous_import_id then
    raise exception 'bank_statement_opening_basis_changed' using errcode = '40001',
      detail = 'The previous statement or account opening balance changed after submission. Reject and upload again.';
  end if;

  if exists (select 1 from public.bank_statement_imports i
             where i.bank_account_id = v_imp.bank_account_id and i.id <> v_imp.id and i.status = 'completed'
               and daterange(i.period_start, i.period_end, '[]') && daterange(v_imp.period_start, v_imp.period_end, '[]')) then
    raise exception 'bank_statement_period_overlap' using errcode = '23P01';
  end if;

  select count(*) into v_existing from public.bank_statement_import_lines s
  where s.import_id = p_import_id
    and exists (select 1 from public.bank_statement_transactions t
                where t.bank_account_id = s.bank_account_id and t.dedupe_key = s.dedupe_key);
  if v_existing > 0 then
    raise exception 'bank_statement_lines_already_imported' using errcode = '23505', detail = format('%s line(s)', v_existing);
  end if;

  insert into public.bank_statement_transactions(
    company_id, bank_account_id, import_id, transaction_date, day_sequence, description, cheque_no,
    counterparty, reference, payment_details, debit_amount, credit_amount, balance, branch_code,
    dedupe_key, source_row_no)
  select s.company_id, s.bank_account_id, s.import_id, s.transaction_date, s.day_sequence, s.description, s.cheque_no,
         s.counterparty, s.reference, s.payment_details, s.debit_amount, s.credit_amount, s.balance, s.branch_code,
         s.dedupe_key, s.source_row_no
  from public.bank_statement_import_lines s
  where s.import_id = p_import_id
  order by s.line_no;
  get diagnostics v_inserted = row_count;

  update public.bank_statement_imports set
    status = 'completed', approved_by = v_actor, approved_at = now(),
    rows_inserted = v_inserted, rows_skipped = 0
  where id = p_import_id;

  perform public.bank_statement_log(v_imp.company_id, v_imp.bank_account_id, p_import_id, 'approved', v_actor, null,
    jsonb_build_object('rows_inserted', v_inserted));
  return jsonb_build_object('import_id', p_import_id, 'status', 'completed', 'rows_inserted', v_inserted);
end $$;
revoke all on function public.bank_statement_approve(uuid) from public, anon;
grant execute on function public.bank_statement_approve(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 13. Reject (approver) or withdraw (uploader/submitter)
-- ---------------------------------------------------------------------------
create or replace function public.bank_statement_reject(p_import_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_actor uuid := public.bank_statement_actor();
  v_imp public.bank_statement_imports;
  v_reason text := nullif(btrim(p_reason), '');
  v_is_maker boolean;
begin
  select * into v_imp from public.bank_statement_imports where id = p_import_id;
  if not found then raise exception 'bank_statement_not_found' using errcode = 'P0002'; end if;
  v_is_maker := v_actor = v_imp.imported_by or v_actor = v_imp.submitted_by;
  if not (public.bank_statement_has(v_actor, 'finance.statement.approve', v_imp.company_id)
          or (v_is_maker and public.bank_statement_has(v_actor, 'finance.statement.import', v_imp.company_id))) then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'finance.statement.approve';
  end if;
  if v_reason is null or length(v_reason) < 5 then
    raise exception 'bank_statement_reason_required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bank_statement:' || v_imp.bank_account_id::text, 0));
  select * into v_imp from public.bank_statement_imports where id = p_import_id for update;
  if v_imp.status not in ('uploaded','pending_approval') then
    raise exception 'bank_statement_invalid_status' using errcode = '22023', detail = v_imp.status;
  end if;

  update public.bank_statement_imports set
    status = 'rejected', rejected_by = v_actor, rejected_at = now(), rejection_reason = v_reason
  where id = p_import_id;
  perform public.bank_statement_log(v_imp.company_id, v_imp.bank_account_id, p_import_id, 'rejected', v_actor, v_reason,
    jsonb_build_object('previous_status', v_imp.status, 'withdrawn_by_maker', v_is_maker));
  return jsonb_build_object('import_id', p_import_id, 'status', 'rejected');
end $$;
revoke all on function public.bank_statement_reject(uuid,text) from public, anon;
grant execute on function public.bank_statement_reject(uuid,text) to authenticated;

-- ---------------------------------------------------------------------------
-- 14. Reverse a completed statement (latest one of the account only)
-- ---------------------------------------------------------------------------
create or replace function public.bank_statement_reverse(p_import_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_actor uuid := public.bank_statement_actor();
  v_imp public.bank_statement_imports;
  v_reason text := nullif(btrim(p_reason), '');
  v_deleted integer;
begin
  select * into v_imp from public.bank_statement_imports where id = p_import_id;
  if not found then raise exception 'bank_statement_not_found' using errcode = 'P0002'; end if;
  perform public.bank_statement_assert(v_actor, 'finance.statement.approve', v_imp.company_id);
  if v_reason is null or length(v_reason) < 10 then
    raise exception 'bank_statement_reason_required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bank_statement:' || v_imp.bank_account_id::text, 0));
  select * into v_imp from public.bank_statement_imports where id = p_import_id for update;
  if v_imp.status <> 'completed' or v_imp.file_sha256 is null then
    raise exception 'bank_statement_invalid_status' using errcode = '22023', detail = v_imp.status;
  end if;
  if exists (select 1 from public.bank_statement_imports i
             where i.bank_account_id = v_imp.bank_account_id and i.id <> v_imp.id
               and i.status in ('uploaded','pending_approval','completed') and i.period_start > v_imp.period_end) then
    raise exception 'bank_statement_not_latest' using errcode = '22023',
      detail = 'Reverse or reject the later statements of this account first.';
  end if;

  delete from public.bank_statement_transactions where import_id = p_import_id;
  get diagnostics v_deleted = row_count;

  update public.bank_statement_imports set
    status = 'reversed', reversed_by = v_actor, reversed_at = now(), reversal_reason = v_reason
  where id = p_import_id;
  perform public.bank_statement_log(v_imp.company_id, v_imp.bank_account_id, p_import_id, 'reversed', v_actor, v_reason,
    jsonb_build_object('rows_removed', v_deleted));
  return jsonb_build_object('import_id', p_import_id, 'status', 'reversed', 'rows_removed', v_deleted);
end $$;
revoke all on function public.bank_statement_reverse(uuid,text) from public, anon;
grant execute on function public.bank_statement_reverse(uuid,text) to authenticated;

-- ---------------------------------------------------------------------------
-- 15. Opening balance lock on bank_accounts
-- ---------------------------------------------------------------------------
create or replace function public.bank_accounts_opening_balance_guard()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role';
  v_actor uuid := auth.uid();
  v_opening_changed boolean := new.opening_balance is distinct from old.opening_balance
                               or new.opening_balance_date is distinct from old.opening_balance_date;
  v_frequency_changed boolean := new.statement_frequency is distinct from old.statement_frequency;
begin
  if not v_opening_changed and not v_frequency_changed then
    return new;
  end if;
  -- Any API request (authenticated or service role) needs a Super Admin user.
  -- Direct database sessions (migrations, owner) are allowed and still logged.
  if v_role is not null and (v_actor is null or not public.sa_legacy_is_super_admin(v_actor)) then
    if v_opening_changed then
      raise exception 'bank_account_opening_balance_locked' using errcode = '42501',
        detail = 'Only a Super Admin can change the opening balance or its date.';
    end if;
    raise exception 'bank_account_statement_frequency_locked' using errcode = '42501',
      detail = 'Only a Super Admin can change the statement frequency.';
  end if;
  if v_opening_changed then
    insert into public.bank_statement_events(company_id, bank_account_id, import_id, event, actor_id, reason, details)
    values (new.company_id, new.id, null, 'opening_balance_changed', v_actor, null,
            jsonb_build_object('old_opening_balance', old.opening_balance, 'new_opening_balance', new.opening_balance,
                               'old_opening_balance_date', old.opening_balance_date, 'new_opening_balance_date', new.opening_balance_date,
                               'via', coalesce(v_role, 'database')));
  end if;
  if v_frequency_changed then
    insert into public.bank_statement_events(company_id, bank_account_id, import_id, event, actor_id, reason, details)
    values (new.company_id, new.id, null, 'statement_frequency_changed', v_actor, null,
            jsonb_build_object('old_statement_frequency', old.statement_frequency, 'new_statement_frequency', new.statement_frequency,
                               'via', coalesce(v_role, 'database')));
  end if;
  return new;
end $$;
revoke all on function public.bank_accounts_opening_balance_guard() from public, anon, authenticated;

drop trigger if exists bank_accounts_opening_balance_guard on public.bank_accounts;
create trigger bank_accounts_opening_balance_guard
before update of opening_balance, opening_balance_date, statement_frequency on public.bank_accounts
for each row execute function public.bank_accounts_opening_balance_guard();

comment on table public.bank_statement_events is 'Append-only audit of bank statement uploads, approvals, rejections, reversals and opening balance changes.';
