-- ============================================================================
-- E-commerce → TikTok Shop: sales data imported from TikTok Seller Center
-- ----------------------------------------------------------------------------
-- Stores the TikTok Shop exports Finance/E-commerce download today (the
-- "OrderSKUList" orders file and the "Transaction record" file with order
-- settlements and withdrawals), so reports can be built in Serapod2U. The
-- same tables will later be filled by the TikTok Shop API (source = 'api').
--
-- No customer personal data is stored: buyer name/username, recipient, phone,
-- address, postcode, buyer message, seller note, tracking number and the
-- customer's bank are dropped by the importer. Only the state is kept.
--
-- Delta: order lines are unique per (shop, order, SKU) and are updated when a
-- later file shows a new status; settlement rows carry a dedupe key built from
-- order/adjustment ID, type, settlement date and same-day occurrence; payouts
-- are unique per (shop, reference, type). Re-importing a file adds nothing.
--
-- Access: only the server API (service role) reads or writes these tables,
-- after the S&A decision ecommerce.order.manage. App users have no direct
-- table access (RLS on, no policies, privileges revoked).
--
-- Rollback:
--   drop table if exists public.marketplace_payouts;
--   drop table if exists public.marketplace_settlements;
--   drop table if exists public.marketplace_order_lines;
--   drop table if exists public.marketplace_imports;
--   drop table if exists public.marketplace_shops;
-- ============================================================================

create table if not exists public.marketplace_shops (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.organizations(id),
  platform text not null check (platform in ('tiktok_shop')),
  shop_name text not null check (length(btrim(shop_name)) between 1 and 120),
  external_shop_id text,
  is_active boolean not null default true,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists marketplace_shops_name_key
  on public.marketplace_shops (company_id, platform, lower(btrim(shop_name)));

create table if not exists public.marketplace_imports (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.organizations(id),
  shop_id uuid not null references public.marketplace_shops(id) on delete restrict,
  source text not null default 'excel' check (source in ('excel', 'api')),
  file_kind text not null check (file_kind in ('orders', 'settlements')),
  file_name text,
  period_start date,
  period_end date,
  rows_in_file integer not null default 0 check (rows_in_file >= 0),
  rows_inserted integer not null default 0 check (rows_inserted >= 0),
  rows_updated integer not null default 0 check (rows_updated >= 0),
  rows_unchanged integer not null default 0 check (rows_unchanged >= 0),
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  imported_by uuid references public.users(id) on delete set null,
  imported_at timestamptz not null default now()
);

create index if not exists marketplace_imports_shop_idx
  on public.marketplace_imports (shop_id, imported_at desc);

create table if not exists public.marketplace_order_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.organizations(id),
  shop_id uuid not null references public.marketplace_shops(id) on delete restrict,
  last_import_id uuid references public.marketplace_imports(id) on delete set null,
  order_id text not null,
  sku_id text not null default '',
  seller_sku text,
  product_name text,
  variation text,
  order_status text,
  order_substatus text,
  cancel_return_type text,
  normal_or_preorder text,
  quantity integer not null default 0,
  return_quantity integer not null default 0,
  unit_original_price numeric(14,2),
  subtotal_before_discount numeric(14,2),
  platform_discount numeric(14,2),
  seller_discount numeric(14,2),
  subtotal_after_discount numeric(14,2),
  shipping_fee_after_discount numeric(14,2),
  original_shipping_fee numeric(14,2),
  shipping_fee_seller_discount numeric(14,2),
  shipping_fee_platform_discount numeric(14,2),
  payment_platform_discount numeric(14,2),
  taxes numeric(14,2),
  order_amount numeric(14,2),
  order_refund_amount numeric(14,2),
  created_time timestamptz,
  paid_time timestamptz,
  rts_time timestamptz,
  shipped_time timestamptz,
  delivered_time timestamptz,
  cancelled_time timestamptz,
  cancel_by text,
  cancel_reason text,
  fulfillment_type text,
  warehouse_name text,
  delivery_option text,
  shipping_provider text,
  payment_method text,
  weight_kg numeric(10,3),
  product_category text,
  package_id text,
  purchase_channel text,
  order_channel text,
  creator_handle text,
  buyer_state text,
  buyer_country text,
  content_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketplace_order_lines_line_key unique (shop_id, order_id, sku_id)
);

create index if not exists marketplace_order_lines_shop_created_idx
  on public.marketplace_order_lines (shop_id, created_time desc);
create index if not exists marketplace_order_lines_order_idx
  on public.marketplace_order_lines (order_id);

create table if not exists public.marketplace_settlements (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.organizations(id),
  shop_id uuid not null references public.marketplace_shops(id) on delete restrict,
  import_id uuid references public.marketplace_imports(id) on delete set null,
  record_id text not null,
  transaction_type text not null,
  related_order_id text,
  order_created_date date,
  settled_date date,
  currency text,
  total_settlement_amount numeric(14,2) not null default 0,
  total_revenue numeric(14,2),
  total_fees numeric(14,2),
  subtotal_before_discounts numeric(14,2),
  seller_discounts numeric(14,2),
  subtotal_after_seller_discounts numeric(14,2),
  refund_subtotal_after_seller_discounts numeric(14,2),
  customer_payment numeric(14,2),
  customer_refund numeric(14,2),
  adjustment_amount numeric(14,2),
  fee_breakdown jsonb not null default '{}'::jsonb,
  items_sold text,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  constraint marketplace_settlements_line_key unique (shop_id, dedupe_key)
);

create index if not exists marketplace_settlements_shop_settled_idx
  on public.marketplace_settlements (shop_id, settled_date desc);
create index if not exists marketplace_settlements_record_idx
  on public.marketplace_settlements (record_id);

create table if not exists public.marketplace_payouts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.organizations(id),
  shop_id uuid not null references public.marketplace_shops(id) on delete restrict,
  import_id uuid references public.marketplace_imports(id) on delete set null,
  reference_id text not null,
  transaction_type text not null,
  request_date date,
  amount numeric(14,2) not null default 0,
  status text,
  success_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketplace_payouts_line_key unique (shop_id, reference_id, transaction_type)
);

create index if not exists marketplace_payouts_shop_request_idx
  on public.marketplace_payouts (shop_id, request_date desc);

alter table public.marketplace_shops enable row level security;
alter table public.marketplace_imports enable row level security;
alter table public.marketplace_order_lines enable row level security;
alter table public.marketplace_settlements enable row level security;
alter table public.marketplace_payouts enable row level security;

revoke all on table public.marketplace_shops from public, anon, authenticated;
revoke all on table public.marketplace_imports from public, anon, authenticated;
revoke all on table public.marketplace_order_lines from public, anon, authenticated;
revoke all on table public.marketplace_settlements from public, anon, authenticated;
revoke all on table public.marketplace_payouts from public, anon, authenticated;

grant all on table public.marketplace_shops to service_role;
grant all on table public.marketplace_imports to service_role;
grant all on table public.marketplace_order_lines to service_role;
grant all on table public.marketplace_settlements to service_role;
grant all on table public.marketplace_payouts to service_role;

comment on table public.marketplace_shops is 'Marketplace shops (TikTok Shop) whose sales are imported; external_shop_id is for the later API connection.';
comment on table public.marketplace_order_lines is 'TikTok Shop order lines (one per order and SKU) without customer personal data; updated when a later export shows a new status.';
comment on table public.marketplace_settlements is 'TikTok Shop settlement rows per order/adjustment with every fee in fee_breakdown; overlapping exports add only new rows.';
comment on table public.marketplace_payouts is 'TikTok Shop earnings and withdrawals from the transaction export.';
