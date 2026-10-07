-- ============================================================================
-- E-commerce → TikTok Shop: API connection per shop
-- ----------------------------------------------------------------------------
-- A seller authorizes the Serapod2U TikTok Shop app (Partner Center custom
-- app) from the TikTok Shop page; the callback stores the seller's tokens
-- here, linked to one marketplace shop. The sync (button and hourly worker)
-- then reads orders, daily settlement statements and withdrawals from the
-- TikTok Shop API into the existing marketplace tables (source = 'api').
--
-- data_from: settlements and payouts dated on or after this day come from the
-- API; the Excel import skips them, so the two sources never double count.
-- It is set when the shop is first connected (the day after the last Excel
-- settlement/payout already imported). Order lines share their key with the
-- Excel import (shop, order, SKU) and are simply updated.
--
-- No customer personal data is stored (the API mapper keeps the same columns
-- as the Excel import). Tokens are readable only by the server (service role).
--
-- Rollback:
--   drop table if exists public.marketplace_shop_connections;
-- ============================================================================

create table if not exists public.marketplace_shop_connections (
  shop_id uuid primary key references public.marketplace_shops(id) on delete cascade,
  company_id uuid not null references public.organizations(id),
  platform text not null default 'tiktok_shop' check (platform in ('tiktok_shop')),
  open_id text not null,
  seller_name text,
  seller_base_region text,
  external_shop_id text not null,
  external_shop_code text,
  external_shop_name text,
  shop_cipher text not null,
  access_token text not null,
  access_token_expires_at timestamptz not null,
  refresh_token text not null,
  refresh_token_expires_at timestamptz,
  granted_scopes text[] not null default '{}',
  data_from date not null,
  orders_synced_to timestamptz,
  statements_synced_to timestamptz,
  payouts_synced_to timestamptz,
  last_sync_at timestamptz,
  last_sync_status text check (last_sync_status in ('running', 'ok', 'failed')),
  last_sync_error text,
  sync_started_at timestamptz,
  authorized_by uuid references public.users(id) on delete set null,
  authorized_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketplace_shop_connections_external_key unique (platform, external_shop_id)
);

create index if not exists marketplace_shop_connections_company_idx
  on public.marketplace_shop_connections (company_id);

alter table public.marketplace_shop_connections enable row level security;
revoke all on table public.marketplace_shop_connections from public, anon, authenticated;
grant all on table public.marketplace_shop_connections to service_role;

comment on table public.marketplace_shop_connections is 'TikTok Shop API authorization per marketplace shop (tokens, shop cipher, sync cursors). Server only.';
comment on column public.marketplace_shop_connections.data_from is 'Settlements and payouts on or after this date come from the API; the Excel import skips them.';
