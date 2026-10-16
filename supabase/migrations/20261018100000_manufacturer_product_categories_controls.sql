-- ============================================================================
-- Manufacturer product categories: atomic save, active-category guard, summary
-- ----------------------------------------------------------------------------
-- Depends on 20261005150000_manufacturer_product_categories.sql (the
-- manufacturer_product_categories table, its RLS policies and check trigger).
--
-- 1. manufacturer_product_categories_check_mfg(): besides "manufacturer
--    organizations only", a NEW link must point at an existing, active
--    category. Links to a category that was deactivated later are kept as is.
-- 2. set_manufacturer_product_categories(manufacturer, categories[]): replaces
--    a manufacturer's assigned categories in one transaction. SECURITY INVOKER,
--    so the table's RLS still applies; it also checks the same S&A gate as the
--    policy (platform.organization.manage on the manufacturer; legacy: HQ
--    admin / super admin) and refuses an empty set, non-manufacturers and
--    newly added inactive/unknown categories.
-- 3. manufacturer_category_summary(manufacturers[]): per manufacturer, the
--    assigned categories plus the categories found on its linked products
--    (products.manufacturer_id + products.category_id) with product counts,
--    aggregated in SQL so the organization list never loads products.
--    SECURITY INVOKER: callers only count products/categories their RLS shows.
--
-- Classification only. Products, categories, organizations, orders, QR,
-- loyalty and S&A grants are not changed, and nothing is backfilled.
--
-- Rollback:
--   drop function if exists public.manufacturer_category_summary(uuid[]);
--   drop function if exists public.set_manufacturer_product_categories(uuid, uuid[]);
--   then re-run the check function from 20261005150000 to restore its old body.
-- ============================================================================

create or replace function public.manufacturer_product_categories_check_mfg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.organizations o where o.id = new.manufacturer_id and o.org_type_code = 'MFG') then
    raise exception 'Only manufacturer organizations can be linked to product categories'
      using errcode = '22023';
  end if;

  if tg_op = 'UPDATE' then
    if new.category_id is not distinct from old.category_id then
      return new;
    end if;
  end if;

  if not exists (select 1 from public.product_categories pc where pc.id = new.category_id and pc.is_active is true) then
    raise exception 'Inactive or unknown product categories cannot be assigned to a manufacturer'
      using errcode = '22023';
  end if;

  return new;
end;
$$;

create or replace function public.set_manufacturer_product_categories(
  p_manufacturer_id uuid,
  p_category_ids uuid[]
)
returns uuid[]
language plpgsql
volatile
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_wanted uuid[];
  v_current uuid[];
  v_added uuid[];
  v_actor uuid;
begin
  if p_manufacturer_id is null then
    raise exception 'Manufacturer is required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.organizations o
    where o.id = p_manufacturer_id and o.org_type_code = 'MFG'
  ) then
    raise exception 'Product categories can only be assigned to a manufacturer organization'
      using errcode = '22023';
  end if;

  if not public.sa_rls_gate(
    'platform.organization.manage',
    p_manufacturer_id,
    (public.is_hq_admin() or public.is_super_admin())
  ) then
    raise exception 'You are not allowed to change this manufacturer''s product categories'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct c), '{}'::uuid[])
    into v_wanted
    from unnest(coalesce(p_category_ids, '{}'::uuid[])) as c
   where c is not null;

  if cardinality(v_wanted) = 0 then
    raise exception 'Select at least one product category' using errcode = '22023';
  end if;

  -- One writer per manufacturer at a time, so concurrent saves cannot interleave.
  perform pg_advisory_xact_lock(hashtextextended('manufacturer_product_categories:' || p_manufacturer_id::text, 0));

  select coalesce(array_agg(mpc.category_id), '{}'::uuid[])
    into v_current
    from public.manufacturer_product_categories mpc
   where mpc.manufacturer_id = p_manufacturer_id;

  v_added := array(select unnest(v_wanted) except select unnest(v_current));

  -- Kept categories may have been deactivated since; only additions must be active.
  if exists (
    select 1 from unnest(v_added) as a
     where not exists (
       select 1 from public.product_categories pc where pc.id = a and pc.is_active is true
     )
  ) then
    raise exception 'One or more selected product categories are inactive or do not exist'
      using errcode = '22023';
  end if;

  delete from public.manufacturer_product_categories mpc
   where mpc.manufacturer_id = p_manufacturer_id
     and mpc.category_id <> all (v_wanted);

  select u.id into v_actor from public.users u where u.id = auth.uid();

  insert into public.manufacturer_product_categories (manufacturer_id, category_id, created_by)
  select p_manufacturer_id, a, v_actor
    from unnest(v_added) as a
  on conflict (manufacturer_id, category_id) do nothing;

  return array(
    select mpc.category_id
      from public.manufacturer_product_categories mpc
     where mpc.manufacturer_id = p_manufacturer_id
     order by mpc.category_id
  );
end;
$$;

create or replace function public.manufacturer_category_summary(p_manufacturer_ids uuid[])
returns table (
  manufacturer_id uuid,
  assigned jsonb,
  derived jsonb,
  product_count bigint,
  uncategorized_product_count bigint
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  if coalesce(cardinality(p_manufacturer_ids), 0) > 1000 then
    raise exception 'At most 1000 manufacturers per request' using errcode = '22023';
  end if;

  return query
  with m as (
    select o.id
      from public.organizations o
     where o.id = any (coalesce(p_manufacturer_ids, '{}'::uuid[]))
       and o.org_type_code = 'MFG'
  ),
  a as (
    select mpc.manufacturer_id as mid,
           jsonb_agg(
             jsonb_build_object(
               'category_id', mpc.category_id,
               'category_name', pc.category_name,
               'is_active', pc.is_active
             )
             order by pc.category_name nulls last, mpc.category_id
           ) as items
      from public.manufacturer_product_categories mpc
      join m on m.id = mpc.manufacturer_id
      left join public.product_categories pc on pc.id = mpc.category_id
     group by mpc.manufacturer_id
  ),
  per_category as (
    select p.manufacturer_id as mid, p.category_id as cid, count(*)::bigint as n
      from public.products p
      join m on m.id = p.manufacturer_id
     group by p.manufacturer_id, p.category_id
  ),
  d as (
    select pcat.mid,
           coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'category_id', pcat.cid,
                 'category_name', pc.category_name,
                 'is_active', pc.is_active,
                 'product_count', pcat.n
               )
               order by pc.category_name nulls last, pcat.cid
             ) filter (where pcat.cid is not null),
             '[]'::jsonb
           ) as items,
           sum(pcat.n)::bigint as total,
           coalesce(sum(pcat.n) filter (where pcat.cid is null), 0)::bigint as uncategorized
      from per_category pcat
      left join public.product_categories pc on pc.id = pcat.cid
     group by pcat.mid
  )
  select m.id,
         coalesce(a.items, '[]'::jsonb),
         coalesce(d.items, '[]'::jsonb),
         coalesce(d.total, 0)::bigint,
         coalesce(d.uncategorized, 0)::bigint
    from m
    left join a on a.mid = m.id
    left join d on d.mid = m.id;
end;
$$;

revoke all on function public.set_manufacturer_product_categories(uuid, uuid[]) from public, anon;
grant execute on function public.set_manufacturer_product_categories(uuid, uuid[]) to authenticated, service_role;

revoke all on function public.manufacturer_category_summary(uuid[]) from public, anon;
grant execute on function public.manufacturer_category_summary(uuid[]) to authenticated, service_role;

comment on function public.set_manufacturer_product_categories(uuid, uuid[]) is
  'Replaces a manufacturer''s assigned Product Master categories atomically. Classification only; never changes products.';
comment on function public.manufacturer_category_summary(uuid[]) is
  'Per manufacturer: assigned categories, categories found on linked products (with counts), product totals. Read-only, RLS-respecting.';
