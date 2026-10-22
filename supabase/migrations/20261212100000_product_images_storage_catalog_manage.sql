-- Product images bucket: anyone allowed to manage the product catalogue may upload,
-- replace and remove the main product image, not only role level <= 10.
--
-- Additive: every caller allowed before (is_hq_admin) is still allowed. A caller
-- is also allowed when Security & Access grants product.catalog.manage for their
-- organization (the same decision the products / product_images / product_variants
-- policies already use). The public read policy is unchanged.

begin;

drop policy if exists "Authenticated can upload product images" on storage.objects;
create policy "Authenticated can upload product images" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'product-images'
    and (
      (select public.is_hq_admin())
      or public.sa_rls_gate('product.catalog.manage', public.sa_actor_org_id(), false)
    )
  );

drop policy if exists "Admins can update product images" on storage.objects;
create policy "Admins can update product images" on storage.objects
  for update to authenticated
  using (bucket_id = 'product-images')
  with check (
    (select public.is_hq_admin())
    or (bucket_id = 'product-images' and public.sa_rls_gate('product.catalog.manage', public.sa_actor_org_id(), false))
  );

drop policy if exists "Admins can delete product images" on storage.objects;
create policy "Admins can delete product images" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'product-images'
    and (
      (select public.is_hq_admin())
      or public.sa_rls_gate('product.catalog.manage', public.sa_actor_org_id(), false)
    )
  );

commit;
