-- ============================================================================
-- Manufacturer ↔ Product Category mapping
-- ----------------------------------------------------------------------------
-- Until now a manufacturer was only linked to a category through its products
-- (products.manufacturer_id + products.category_id), so a manufacturer with no
-- product yet had no category, and one manufacturer could not be declared for
-- several categories. This table records which Product Master categories each
-- manufacturer makes (many-to-many). Products, categories and organizations
-- are not changed.
--
-- Access: everyone signed in can read; writing follows the right to manage the
-- manufacturer organization (platform.organization.manage; legacy: HQ admin /
-- super admin), the same gate as creating manufacturers.
--
-- Rollback:
--   drop table if exists public.manufacturer_product_categories;
--   drop function if exists public.manufacturer_product_categories_check_mfg();
-- ============================================================================

create table if not exists public.manufacturer_product_categories (
  id uuid primary key default gen_random_uuid(),
  manufacturer_id uuid not null references public.organizations(id) on delete cascade,
  category_id uuid not null references public.product_categories(id) on delete cascade,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint manufacturer_product_categories_pair_key unique (manufacturer_id, category_id)
);

create index if not exists manufacturer_product_categories_category_idx
  on public.manufacturer_product_categories (category_id);

create or replace function public.manufacturer_product_categories_check_mfg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.organizations o where o.id = new.manufacturer_id and o.org_type_code = 'MFG') then
    raise exception 'Only manufacturer organizations can be linked to product categories';
  end if;
  return new;
end;
$$;

drop trigger if exists manufacturer_product_categories_check_mfg on public.manufacturer_product_categories;
create trigger manufacturer_product_categories_check_mfg
  before insert or update on public.manufacturer_product_categories
  for each row execute function public.manufacturer_product_categories_check_mfg();

alter table public.manufacturer_product_categories enable row level security;

revoke all on table public.manufacturer_product_categories from public, anon, authenticated;
grant select, insert, delete on table public.manufacturer_product_categories to authenticated;
grant all on table public.manufacturer_product_categories to service_role;

drop policy if exists manufacturer_product_categories_read on public.manufacturer_product_categories;
create policy manufacturer_product_categories_read on public.manufacturer_product_categories for select to authenticated
  using (true);

drop policy if exists manufacturer_product_categories_manage on public.manufacturer_product_categories;
create policy manufacturer_product_categories_manage on public.manufacturer_product_categories for all to authenticated
  using (public.sa_rls_gate('platform.organization.manage', manufacturer_id, (public.is_hq_admin() or public.is_super_admin())))
  with check (public.sa_rls_gate('platform.organization.manage', manufacturer_id, (public.is_hq_admin() or public.is_super_admin())));

comment on table public.manufacturer_product_categories is 'Product Master categories each manufacturer makes (many-to-many); independent of products.';
