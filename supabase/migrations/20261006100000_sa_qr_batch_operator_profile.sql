-- ============================================================================
-- Security & Access — QR Batch Operator profile and manufacturer ownership
-- ----------------------------------------------------------------------------
-- Requires 20261005110000_sa_access_profiles.sql (applicability columns).
--
-- Findings (2026-10-06 investigation)
--   * qr.batch.manage was registered (catalogue, migration mode, enforcement
--     readiness, route guards, mark_batch_as_printed guard) but NO standard or
--     custom profile contained it, so administrators had nothing to grant.
--   * The permission could not safely be given to a manufacturer yet:
--       - mark_batch_as_printed (SECURITY DEFINER) checked only the actor's
--         own organization, not that the batch belongs to the manufacturer
--         of the order, so a manufacturer holding the permission once the
--         mode is NEW_ENFORCED could print-mark ANY batch;
--       - the qr_batches SELECT policy let every supply partner read ALL
--         batches (the routes that return batch data had no ownership check).
--   * Ownership model (confirmed in QRBatchesView / qr-batch-access.ts): an
--     H2M order is owned by HQ (company_id / buyer_org_id) and placed WITH a
--     manufacturer (seller_org_id). qr_batches.company_id is the HQ, so the
--     manufacturer party is identified through orders.seller_org_id — never
--     through qr_batches.company_id or an organization on the batch alone.
--
-- Changes (all additive / idempotent)
--   1. Standard profile "QR Batch Operator" (qr-batch-operator): ONLY
--      qr.batch.manage. Applies to HQ and Manufacturer organizations. No
--      warehouse management, order approval or security administration.
--   2. sa_assert_qr_batch_party(batch): partner organizations (manufacturer,
--      distributor, shop) may act only on batches of orders they are the
--      seller of; HQ and other internal staff behave exactly as before.
--      Injected into mark_batch_as_printed (the guard is recorded in
--      sa_function_guard_injections like the existing ones).
--   3. qr_batches SELECT: a manufacturer principal sees only batches of its
--      own orders (sa_actor_may_read_qr_batch); everyone else is unchanged.
--
-- No migration mode is changed and nothing is marked enforcement-ready here.
-- Rollback: drop the profile row (if unassigned), restore the policy from
-- 20260929140000_identity_stage1_closure.sql and the function from
-- sa_function_guard_injections.original_definition.
-- ============================================================================

-- 1. Standard profile ---------------------------------------------------------
insert into public.sa_business_roles(role_key, name, description, source, status, applicable_org_types)
values ('qr-batch-operator', 'QR Batch Operator',
        'Generates, processes, prints and downloads QR batches for orders in scope. HQ staff handle batches of HQ-owned orders; a manufacturer handles only the batches of orders placed with it. Grants nothing else.',
        'template', 'active', array['HQ','MFG'])
on conflict (role_key) do nothing;

insert into public.sa_business_role_permissions(role_id, permission_id)
select br.id, p.id from public.sa_business_roles br join public.sa_permissions p on p.permission_key = 'qr.batch.manage'
where br.role_key = 'qr-batch-operator'
on conflict do nothing;

-- 2. Manufacturer party check -----------------------------------------------
create or replace function public.sa_assert_qr_batch_party(p_batch_id uuid)
returns void language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_type text;
begin
  -- No PostgREST request (database owner, migrations) and service_role pass
  -- through, exactly like sa_require_operation.
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', 'service_role') = 'service_role' then return; end if;
  select u.organization_id, upper(o.org_type_code) into v_org, v_type
  from public.users u left join public.organizations o on o.id = u.organization_id
  where u.id = v_uid and u.is_active is true;
  -- HQ and other internal organizations keep their existing behaviour.
  if v_type is null or v_type not in ('MFG','DIST','SHOP') then return; end if;
  if not exists (
    select 1 from public.qr_batches b join public.orders o on o.id = b.order_id
    where b.id = p_batch_id and o.seller_org_id = v_org) then
    raise exception 'sa_authorization_required' using errcode = '42501', detail = 'qr_batch_not_in_party_scope';
  end if;
end $$;
revoke all on function public.sa_assert_qr_batch_party(uuid) from public, anon;
grant execute on function public.sa_assert_qr_batch_party(uuid) to authenticated, service_role;

do $inject$
begin
  if to_regprocedure('public.mark_batch_as_printed(uuid)') is not null and to_regprocedure('public.sa_inject_operation_guard(regprocedure,text,text,jsonb)') is not null then
    perform public.sa_inject_operation_guard('public.mark_batch_as_printed(uuid)'::regprocedure, 'qr.batch.party',
      $g$PERFORM public.sa_assert_qr_batch_party(p_batch_id);$g$);
  end if;
end $inject$;

-- 3. Read access: a manufacturer reads only the batches of its own orders ---
create or replace function public.sa_actor_may_read_qr_batch(p_order_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select case
    when (select u.principal_type from public.users u where u.id = auth.uid()) = 'MANUFACTURER_USER'
      then exists (select 1 from public.orders o where o.id = p_order_id and o.seller_org_id = public.sa_actor_org_id())
    else true end
$$;
revoke all on function public.sa_actor_may_read_qr_batch(uuid) from public, anon;
grant execute on function public.sa_actor_may_read_qr_batch(uuid) to authenticated, service_role;

drop policy if exists sa_staff_read on public.qr_batches;
create policy sa_staff_read on public.qr_batches for select to authenticated
  using (public.sa_actor_is_staff(40) or (public.sa_actor_is_supply_partner() and public.sa_actor_may_read_qr_batch(order_id)));
