-- ============================================================================
-- E-commerce → TikTok Shop: reporting data
-- ----------------------------------------------------------------------------
-- 1. marketplace_order_lines.tracking_number: the courier tracking number of
--    the order's parcel, so shipping reports can answer "where is this order".
--    It identifies a parcel, not a person; recipient name, phone and address
--    are still never stored.
-- 2. marketplace_unsettled: what TikTok still owes for orders that are not
--    settled yet (estimated revenue, fees, shipping and settlement, with the
--    reason). It is a snapshot replaced by every API sync, one row per TikTok
--    transaction, so it never duplicates.
--
-- Access: like the other marketplace tables, server only (service role) after
-- the S&A decision ecommerce.order.manage.
--
-- Rollback:
--   drop table if exists public.marketplace_unsettled;
--   alter table public.marketplace_order_lines drop column if exists tracking_number;
-- ============================================================================

alter table public.marketplace_order_lines add column if not exists tracking_number text;

create table if not exists public.marketplace_unsettled (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.organizations(id),
  shop_id uuid not null references public.marketplace_shops(id) on delete cascade,
  transaction_id text not null,
  transaction_type text,
  order_id text,
  order_created_at timestamptz,
  delivered_at timestamptz,
  status text,
  reason text,
  currency text,
  est_revenue numeric(14,2),
  est_fees numeric(14,2),
  est_shipping numeric(14,2),
  est_settlement numeric(14,2),
  synced_at timestamptz not null default now(),
  constraint marketplace_unsettled_line_key unique (shop_id, transaction_id)
);

alter table public.marketplace_unsettled enable row level security;
revoke all on table public.marketplace_unsettled from public, anon, authenticated;
grant all on table public.marketplace_unsettled to service_role;

comment on column public.marketplace_order_lines.tracking_number is 'Courier tracking number of the parcel (TikTok Shop API). No recipient data.';
comment on table public.marketplace_unsettled is 'TikTok Shop orders not settled yet with estimated amounts; replaced by every API sync.';
