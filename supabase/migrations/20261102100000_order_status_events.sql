-- ============================================================================
-- Order status event ledger — authoritative, append-only order status history
-- and the FIRST approval timestamp of every order approved from now on.
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Validated only on a throwaway
-- PostgreSQL 17 (supabase/tests/hr_commission/run.sh).
--
-- Findings (2026-10-11 audit)
--   * orders.approved_at exists and is written only when an order moves submitted → approved: orders_approve()
--     (`approved_at = now()`) and the messaging confirm flow. Re-approval overwrites it, so it is the LATEST recorded
--     approval, and nothing records the first one.
--   * There is no durable status history. system_log_events records transitions only since 2026-10-09 and is purged by
--     the retention job; messaging_order_timeline_events covers messaging orders only.
--   * An approved order can still be cancelled (OrdersView, sa_orders_api_write_guard). Cancellation keeps approved_at.
--
-- What this adds
--   1. public.order_status_events: one row per status transition of every order (insert or update of orders.status),
--      written by an AFTER trigger in the same transaction as the transition. Append-only for every API role.
--   2. is_first_approval marks the order's first approval. It is true only when the order had NO recorded approval
--      before the transition (old.approved_at is null) and no earlier approval event exists. A partial unique index
--      allows at most one per order.
--   3. public.order_first_approval(order_id): the first approval instant and where it came from:
--        'approval_event'        the ledger's first-approval event (orders approved after this migration);
--        'recorded_approved_at'  the orders.approved_at value recorded before this ledger existed (the earliest
--                                recorded value: the ledger keeps approved_at_before, so a later re-approval cannot
--                                hide it). For current workflows this is the first approval, because approval is only
--                                possible from 'submitted' and no workflow reopens an approved order;
--        'unavailable'           no approval timestamp exists. Callers must flag such orders, never guess.
--      No timestamp is ever derived from order_date or created_at, and no historical row is backfilled.
--
-- Not changed: orders, orders_approve(), every existing trigger and policy, every existing row.
-- Repeat-safe. Rollback: drop trigger order_status_events_capture on public.orders; drop function
-- public.order_first_approval(uuid); drop table public.order_status_events (only before commission data relies on it).
-- ============================================================================

create table if not exists public.order_status_events (
  id bigint generated always as identity primary key,
  -- No foreign key on purpose: the ledger outlives a deleted draft order and is never cascaded away.
  order_id uuid not null,
  company_id uuid,
  order_no text,
  order_type public.order_type not null,
  from_status public.order_status,
  to_status public.order_status not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default clock_timestamp(),
  actor_id uuid,
  approved_at_before timestamptz,
  approved_at_after timestamptz,
  is_first_approval boolean not null default false,
  source text not null default 'orders_status_trigger',
  constraint order_status_events_first_is_approval check (not is_first_approval or to_status = 'approved')
);

comment on table public.order_status_events is
  'Append-only order status history written by the orders status trigger. is_first_approval marks the first approval of orders approved after 20261102100000; earlier approvals are only known from orders.approved_at (see order_first_approval).';

create unique index if not exists order_status_events_first_approval_uq
  on public.order_status_events(order_id) where is_first_approval;
create index if not exists order_status_events_order_idx on public.order_status_events(order_id, occurred_at);
create index if not exists order_status_events_company_approval_idx
  on public.order_status_events(company_id, occurred_at) where to_status = 'approved';

alter table public.order_status_events enable row level security;
revoke all on public.order_status_events from public, anon, authenticated;
grant select on public.order_status_events to service_role;

create or replace function public.order_status_events_capture()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_actor uuid;
  v_first boolean := false;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return null;
  end if;
  begin
    v_actor := nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid;
  exception when others then
    v_actor := null;
  end;
  v_actor := coalesce(v_actor, case when new.status = 'approved' then new.approved_by end, new.updated_by);

  if new.status = 'approved' then
    v_first := (tg_op = 'INSERT' or old.approved_at is null)
      and not exists (select 1 from public.order_status_events e where e.order_id = new.id and e.to_status = 'approved');
  end if;

  insert into public.order_status_events(order_id, company_id, order_no, order_type, from_status, to_status, occurred_at,
    actor_id, approved_at_before, approved_at_after, is_first_approval)
  values (new.id, new.company_id, coalesce(new.display_doc_no, new.order_no), new.order_type,
    case when tg_op = 'UPDATE' then old.status end, new.status,
    -- An approval is dated by the approved_at the workflow wrote in this transaction; other transitions by now().
    case when new.status = 'approved' and new.approved_at is not null then new.approved_at else now() end,
    v_actor, case when tg_op = 'UPDATE' then old.approved_at end, new.approved_at, v_first);
  return null;
end
$fn$;
revoke all on function public.order_status_events_capture() from public, anon, authenticated;

drop trigger if exists order_status_events_capture on public.orders;
create trigger order_status_events_capture
  after insert or update of status on public.orders
  for each row execute function public.order_status_events_capture();

create or replace function public.order_status_events_append_only()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $fn$
begin
  raise exception 'order_status_events_append_only' using errcode = '42501';
end
$fn$;

drop trigger if exists order_status_events_append_only on public.order_status_events;
create trigger order_status_events_append_only
  before update or delete on public.order_status_events
  for each row execute function public.order_status_events_append_only();

-- First approval of one order. Read by the commission engine (set-based, same rule) and the drill-down screens.
create or replace function public.order_first_approval(p_order_id uuid)
returns table(approved_at timestamptz, source text)
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $fn$
  with ev as (
    select min(e.occurred_at) filter (where e.is_first_approval) as first_at,
           min(e.approved_at_before) as recorded_before
    from public.order_status_events e
    where e.order_id = p_order_id and e.to_status = 'approved'
  )
  select case when ev.first_at is not null then ev.first_at else least(o.approved_at, ev.recorded_before) end,
         case when ev.first_at is not null then 'approval_event'
              when coalesce(o.approved_at, ev.recorded_before) is not null then 'recorded_approved_at'
              else 'unavailable' end
  from public.orders o cross join ev
  where o.id = p_order_id
$fn$;
-- Server and definer functions only: the ledger itself is not readable by API roles.
revoke all on function public.order_first_approval(uuid) from public, anon, authenticated;
grant execute on function public.order_first_approval(uuid) to service_role;
comment on function public.order_first_approval(uuid) is
  'First approval instant of an order and its provenance (approval_event | recorded_approved_at | unavailable). Never derived from order_date or created_at.';
