-- DISPOSABLE sa_prof_test* DATABASES ONLY. Stand-ins for the platform tables the System Logs migration touches,
-- shaped like production (supabase/schemas/current_schema.sql + 20260929140000 for audit_action_valid).
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;
alter table public.orders add column if not exists order_no text, add column if not exists display_doc_no text,
  add column if not exists notes text, add column if not exists created_by uuid, add column if not exists updated_by uuid,
  add column if not exists created_at timestamptz default now(), add column if not exists updated_at timestamptz default now(),
  add column if not exists base_seq integer;
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(), user_id uuid references public.users(id), user_email text, action text not null,
  entity_type text not null, entity_id uuid, old_values jsonb, new_values jsonb, changed_fields text[], ip_address inet,
  user_agent text, created_at timestamptz default now(),
  constraint audit_action_valid check (action = any (array['INSERT','UPDATE','DELETE','PASSWORD_RESET','BULK_ENABLE_STOCK_CONFIGURATIONS'])));
alter table public.audit_logs enable row level security;
create policy audit_insert_system on public.audit_logs for insert to authenticated with check (true);
create policy audit_read_none on public.audit_logs for select to authenticated using (false);
grant usage on schema public to authenticated, anon, service_role;
grant select, insert, update on public.orders to authenticated;
grant insert on public.audit_logs to authenticated;
