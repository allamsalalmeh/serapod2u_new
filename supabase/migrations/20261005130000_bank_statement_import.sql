-- ============================================================================
-- Finance → Cash & Banking: bank statement import (read-only bank data)
-- ----------------------------------------------------------------------------
-- Stores the lines of bank statement files uploaded by Finance (first format:
-- Hong Leong Bank "Transaction Details" CSV). There is no connection to the
-- bank and nothing is ever sent to it. Existing bank tables are not changed.
--
-- Delta: every line carries a dedupe_key built by the application from date,
-- debit, credit, running balance and same-day occurrence. The unique
-- (bank_account_id, dedupe_key) constraint means re-importing an overlapping
-- period only adds the lines that are not stored yet.
--
-- Access mirrors bank_reconciliations: write = finance.reconciliation.perform
-- (legacy: member of the company), read = finance.cash.view in NEW modes.
-- Authenticated users can insert lines but never update or delete them; the
-- import header can only be updated (row counts / status) by performers.
--
-- Rollback:
--   drop table if exists public.bank_statement_transactions;
--   drop table if exists public.bank_statement_imports;
-- ============================================================================

create table if not exists public.bank_statement_imports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.organizations(id),
  bank_account_id uuid not null references public.bank_accounts(id) on delete restrict,
  source_format text not null,
  file_name text,
  period_start date,
  period_end date,
  opening_balance numeric(18,2),
  closing_balance numeric(18,2),
  rows_in_file integer not null default 0 check (rows_in_file >= 0),
  rows_inserted integer not null default 0 check (rows_inserted >= 0),
  rows_skipped integer not null default 0 check (rows_skipped >= 0),
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  imported_by uuid references public.users(id) on delete set null,
  imported_at timestamptz not null default now()
);

create index if not exists bank_statement_imports_account_idx
  on public.bank_statement_imports (bank_account_id, imported_at desc);

create table if not exists public.bank_statement_transactions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.organizations(id),
  bank_account_id uuid not null references public.bank_accounts(id) on delete restrict,
  import_id uuid references public.bank_statement_imports(id) on delete set null,
  transaction_date date not null,
  day_sequence integer not null default 1,
  description text,
  cheque_no text,
  counterparty text,
  reference text,
  payment_details text,
  debit_amount numeric(18,2) not null default 0 check (debit_amount >= 0),
  credit_amount numeric(18,2) not null default 0 check (credit_amount >= 0),
  balance numeric(18,2),
  branch_code text,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  constraint bank_statement_transactions_line_key unique (bank_account_id, dedupe_key)
);

create index if not exists bank_statement_transactions_account_date_idx
  on public.bank_statement_transactions (bank_account_id, transaction_date desc, day_sequence desc);

alter table public.bank_statement_imports enable row level security;
alter table public.bank_statement_transactions enable row level security;

revoke all on table public.bank_statement_imports from public, anon, authenticated;
revoke all on table public.bank_statement_transactions from public, anon, authenticated;
grant select, insert on table public.bank_statement_imports to authenticated;
grant update (rows_inserted, rows_skipped, status) on table public.bank_statement_imports to authenticated;
grant select, insert on table public.bank_statement_transactions to authenticated;
grant all on table public.bank_statement_imports to service_role;
grant all on table public.bank_statement_transactions to service_role;

drop policy if exists bank_statement_imports_company_access on public.bank_statement_imports;
create policy bank_statement_imports_company_access on public.bank_statement_imports for all to authenticated
  using (public.sa_rls_gate('finance.reconciliation.perform', company_id,
    company_id in (select u.organization_id from public.users u where u.id = auth.uid())))
  with check (public.sa_rls_gate('finance.reconciliation.perform', company_id,
    company_id in (select u.organization_id from public.users u where u.id = auth.uid()))
    and bank_account_id in (select b.id from public.bank_accounts b where b.company_id = bank_statement_imports.company_id));

drop policy if exists sa_finance_cash_view on public.bank_statement_imports;
create policy sa_finance_cash_view on public.bank_statement_imports for select to authenticated
  using (public.sa_rls_new_mode('finance.cash.view') and public.sa_rls_gate('finance.cash.view', company_id, false));

drop policy if exists bank_statement_transactions_company_access on public.bank_statement_transactions;
create policy bank_statement_transactions_company_access on public.bank_statement_transactions for all to authenticated
  using (public.sa_rls_gate('finance.reconciliation.perform', company_id,
    company_id in (select u.organization_id from public.users u where u.id = auth.uid())))
  with check (public.sa_rls_gate('finance.reconciliation.perform', company_id,
    company_id in (select u.organization_id from public.users u where u.id = auth.uid()))
    and bank_account_id in (select b.id from public.bank_accounts b where b.company_id = bank_statement_transactions.company_id));

drop policy if exists sa_finance_cash_view on public.bank_statement_transactions;
create policy sa_finance_cash_view on public.bank_statement_transactions for select to authenticated
  using (public.sa_rls_new_mode('finance.cash.view') and public.sa_rls_gate('finance.cash.view', company_id, false));

comment on table public.bank_statement_imports is 'Bank statement files imported by Finance (read-only bank data; no bank connection).';
comment on table public.bank_statement_transactions is 'Bank statement lines; unique (bank_account_id, dedupe_key) makes overlapping re-imports add only new lines.';
