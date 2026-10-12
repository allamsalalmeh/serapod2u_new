-- ============================================================================
-- Security & Access — close the tenant-remainder bypass in Final Wave RLS gates (API-role write guards)
--
-- NOT APPLIED. Review, then apply by hand per environment (staging first). Localhost shares the staging database,
-- so nothing in this file has been run against a real database (throwaway PostgreSQL 17 restored from a schema-only
-- staging dump: supabase/tests/security/sa_tenant_remainder/run.sh).
--
-- Audit (2026-10-07). sa_gate_policy() (20260928110000) rewrites a policy as
--   sa_rls_gate(perm, org, (original)) OR (sa_rls_new_mode(perm) AND (<remainder>))
-- where <remainder> is the original with role predicates replaced by false. When the original was
-- "<tenant predicate> OR <role predicate>", the remainder is the tenant predicate, so in NEW_ENFORCED /
-- LEGACY_RETIRED anyone who reaches the organization passes and the S&A decision restricts nothing.
-- Every gated policy (466 rows of sa_policy_rewrites + 5 hand-written finance policies) was classified by folding
-- its remainder with the planner (EXPLAIN of "select 1 from <table> where <remainder>"): 546 of 649 remainders
-- fold to false; the rest were read one by one. Ownership remainders (own record, reporting line, self-service
-- rows, AND'ed with the tenant check) are intended and left alone. Write policies whose remainder is a tenant /
-- organization predicate, and what already backs them:
--   shop_distributors.shop_dist_shop_manage                  customer.shop.manage            no backstop
--   distributor_products.dist_products_dist_manage           product.catalog.manage          no backstop
--   product_images.images_company_manage                     product.catalog.manage          no backstop (remainder =
--                                                            any active user of an HQ/MFR organization)
--   organizations.orgs_update_hierarchy                      platform.organization.manage    no backstop (own row, or a
--                                                            DIST's child shops)
--   orders.orders_update / orders_delete                     supply_chain.order.create       sa_orders_api_write_guard
--                                                            covers INSERT and status changes only
--   order_items.order_items_write                            supply_chain.order.create       no backstop
--   documents.documents_write                                supply_chain.document.manage    sa_documents_api_write_guard
--                                                            covers acknowledgement only
--   document_files.document_files_write                      supply_chain.document.manage    no backstop
--   qr_reverse_jobs.sa_manufacturer_update                   manufacturing.scan.reverse      no backstop
--   qr_reverse_job_items.sa_job_owner_all                    manufacturing.scan.reverse      no backstop
--   qr_prepared_codes.sa_job_manufacturer_update             manufacturing.production.manage no backstop
--   return_case_status_history.return_status_history_all     inventory.return.manage         no backstop
--   serapp_order_holds.serapp_order_holds_insert / _update   supply_chain.order.create       no backstop
--   stock_adjustments."Manufacturers can acknowledge ..."    manufacturing.adjustment.manage no backstop
--   stock_adjustment_manufacturer_actions."... insert ..."   manufacturing.adjustment.manage no backstop
--   stock_count_classification_allocation_resolutions_manage_org inventory.opening_balance.manage  no backstop
--   referral_claims."Managers can manage referral claims of reports"  customer.shop.manage  remainder keeps a
--                                                            hard-coded identity: u.email = 'super@dev.com'
-- Already covered: stock_count_sessions / _items / _scope (20261019100000); product_inventory (quantity, cost and
-- organization changes need inventory.adjustment.post through sa_product_inventory_api_write_guard; settings columns
-- such as reorder point intentionally keep tenant RLS — unchanged here). qr_movements / qr_validation_reports were
-- false positives: their remainder is "false AND (...)", which is false.
--
-- What this adds. Every check is a no-op until the table's permission is NEW_ENFORCED / LEGACY_RETIRED, so applying
-- it changes no behaviour for keys still in SHADOW / LEGACY_ENFORCED.
--   1. sa_api_require_any(perms[], contexts[], resource)  SECURITY DEFINER check: the verified caller must hold one
--      of the permissions for one of the contexts. The first permission is the table's gate key and decides the
--      mode. Memoised per transaction (sa_cached_*), so a draft save of hundreds of rows evaluates once.
--      sa_api_require_resource(perms[], kind, id) resolves the trusted contexts from the parent row (order,
--      document, reverse job, stock count session) without exposing those rows to the caller.
--   2. sa_tenant_remainder_api_guard()  SECURITY INVOKER trigger (the stock_count_session_api_write_guard pattern:
--      SECURITY DEFINER workflow functions and the service role are not API roles and are unaffected). Context is
--      the row's own organizations (organization scopes match through the row organization's ancestry, so an HQ
--      grant covers child organizations), except product_images, whose gate key is decided at the actor's
--      organization exactly like products_hq_manage (images are editable by whoever may edit the product).
--        shop_distributors          I/U/D  customer.shop.manage              shop or distributor (old and new).
--                                          Writes made by another trigger (sync_shop_distributor_link, which runs
--                                          as the caller when an organization is saved) are not re-checked: they
--                                          are derived from a write that its own policy already decided.
--        distributor_products       I/U/D  product.catalog.manage            distributor
--        product_images             I/U/D  product.catalog.manage            actor's organization
--        organizations              U      platform.organization.manage      the organization, and the new parent
--                                          — only when structural, identity or banking columns change
--                                          (org_type_code, parent_org_id, org_code, is_active, registration_no,
--                                          tax_id, payment_term_id, bank_*, default/storefront warehouse). Settings,
--                                          contact, address and logo edits keep tenant RLS: they are saved by many
--                                          module screens (HR configuration, points, templates, banners) under
--                                          those modules' own permissions.
--        orders                     U/D    supply_chain.order.create         buyer or seller — UPDATEs that change
--                                          status stay with sa_orders_api_write_guard
--        order_items                I/U/D  supply_chain.order.create         the order's buyer or seller
--        documents                  I/U/D  supply_chain.document.manage      issuer — UPDATEs into acknowledged /
--                                          completed stay with sa_documents_api_write_guard
--                                          (supply_chain.document.acknowledge)
--        document_files             I/U/D  supply_chain.document.manage      the document's issuer or recipient
--        qr_reverse_jobs            I/U/D  manufacturing.scan.reverse        manufacturer
--                                          (or manufacturing.production.manage: MODEC jobs are created and
--                                          cancelled by production routes)
--        qr_reverse_job_items       I/U/D  same as qr_reverse_jobs           the job's manufacturer
--        qr_prepared_codes          I/U/D  manufacturing.production.manage   the job's manufacturer
--                                          (or manufacturing.scan.reverse)
--        stock_adjustments          I/U    manufacturing.adjustment.manage   reporter or assigned manufacturer
--        stock_count_classification_allocation_resolutions
--                                   I/U/D  inventory.opening_balance.manage  the session warehouse
--                                          ({organization_id, warehouse_id} = warehouse, as for Stock Count)
--   3. Workflow-only (the app writes these only through the service role): return_case_status_history,
--      serapp_order_holds, stock_adjustment_manufacturer_actions get sa_workflow_only_api_write_guard, like
--      return_cases / return_case_items already have.
--   4. referral_claims: the hard-coded identity (u.email = 'super@dev.com') is removed from the NEW-mode remainder;
--      the legacy expression (first sa_rls_gate argument) is untouched.
--
-- Intentional tightening once each key is enforced: users who reach the organization but hold no grant for the
-- table's permission can no longer write these rows directly through PostgREST — e.g. staff of a shop/distributor
-- editing shop–distributor links, any HQ/MFR user editing product images, org members changing their own
-- organization's type, parent, code, active flag or bank details, order parties editing draft orders / items
-- without supply_chain.order.create, issuers editing documents without supply_chain.document.manage.
--
-- Staging (2026-10-07, read-only): customer.shop.manage, product.catalog.manage, platform.organization.manage,
-- inventory.adjustment.post, inventory.opening_balance.manage, inventory.return.manage NEW_ENFORCED;
-- supply_chain.order.create, supply_chain.document.manage, manufacturing.production.manage,
-- manufacturing.scan.reverse, manufacturing.adjustment.manage LEGACY_RETIRED. These guards act immediately there.
--
-- Not changed: no migration mode, grant, assignment, readiness row or policy other than referral_claims. Reads are
-- untouched (no gated SELECT policy has a tenant-only remainder). The gate's own organization expression (often
-- sa_actor_org_id()) is unchanged.
--
-- Order: requires 20260928100000 … 20260928130000 (Final Wave A–D). Independent of 20261019100000 /
-- 20261019110000 / 20261020100000. Repeat-safe.
--
-- Rollback:
--   do $$ declare t text; begin
--     foreach t in array array['shop_distributors','distributor_products','product_images','organizations','orders',
--       'order_items','documents','document_files','qr_reverse_jobs','qr_reverse_job_items','qr_prepared_codes',
--       'stock_adjustments','stock_count_classification_allocation_resolutions'] loop
--       execute format('drop trigger if exists sa_tenant_remainder_api_guard on public.%I', t); end loop;
--     foreach t in array array['return_case_status_history','serapp_order_holds','stock_adjustment_manufacturer_actions'] loop
--       execute format('drop trigger if exists sa_workflow_only_api_write_guard on public.%I', t); end loop; end $$;
--   drop function if exists public.sa_tenant_remainder_api_guard();
--   drop function if exists public.sa_api_require_resource(text[], text, uuid);
--   drop function if exists public.sa_api_require_any(text[], jsonb[], text);
--   -- referral_claims: alter policy "Managers can manage referral claims of reports" on public.referral_claims
--   --   using (<the expression printed by the NOTICE of section 4 when this migration ran>);
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Decision helpers
-- ---------------------------------------------------------------------------
-- Raises 42501 sa_authorization_required unless the verified caller holds one of p_permissions for one of
-- p_contexts. No-op for requests without claims (migrations, owner), for the service role, and while
-- p_permissions[1] is LEGACY_ENFORCED / SHADOW.
create or replace function public.sa_api_require_any(p_permissions text[], p_contexts jsonb[], p_resource text)
returns void language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_role text := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role';
  v_perm text;
  v_ctx jsonb;
begin
  if v_role is null or v_role = 'service_role' then return; end if;
  if coalesce(array_length(p_permissions, 1), 0) = 0 then
    raise exception 'sa_api_require_any: no permission given';
  end if;
  if not public.sa_cached_mode_is_new(p_permissions[1]) then return; end if;
  if auth.uid() is not null then
    foreach v_ctx in array coalesce(p_contexts, array[]::jsonb[]) loop
      if v_ctx is null or v_ctx->>'organization_id' is null then continue; end if;
      foreach v_perm in array p_permissions loop
        if public.sa_cached_actor_allows(v_perm, v_ctx) then return; end if;
      end loop;
    end loop;
  end if;
  raise exception 'sa_authorization_required'
    using errcode = '42501',
          detail = format('permission=%s resource=%s', array_to_string(p_permissions, '|'), coalesce(p_resource, '-'));
end $$;
revoke all on function public.sa_api_require_any(text[], jsonb[], text) from public;
-- The SECURITY INVOKER trigger below runs as the API role, so that role must be able to call the check. It only
-- ever answers for auth.uid() (raise or return), exactly like sa_require_operation. anon is included so that an
-- anonymous write keeps its current outcome (RLS decides) while the key is SHADOW, instead of failing on EXECUTE;
-- once enforced, anon (no auth.uid()) is refused.
grant execute on function public.sa_api_require_any(text[], jsonb[], text) to anon, authenticated, service_role;

-- Same, with the contexts resolved from a trusted parent row. A missing parent leaves no context (→ denied when
-- enforced). Never returns parent data to the caller.
create or replace function public.sa_api_require_resource(p_permissions text[], p_kind text, p_id uuid)
returns void language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_orgs uuid[];
  v_wh uuid;
  v_ctx jsonb[] := array[]::jsonb[];
  v_org uuid;
begin
  if p_kind = 'order' then
    select array[o.buyer_org_id, o.seller_org_id] into v_orgs from public.orders o where o.id = p_id;
  elsif p_kind = 'document' then
    select array[d.issued_by_org_id, d.issued_to_org_id] into v_orgs from public.documents d where d.id = p_id;
  elsif p_kind = 'reverse_job' then
    select array[j.manufacturer_org_id] into v_orgs from public.qr_reverse_jobs j where j.id = p_id;
  elsif p_kind = 'stock_count_session' then
    select s.warehouse_organization_id into v_wh from public.stock_count_sessions s where s.id = p_id;
    if v_wh is not null then
      v_ctx := array[jsonb_build_object('organization_id', v_wh, 'warehouse_id', v_wh)];
    end if;
  else
    raise exception 'sa_api_require_resource: unknown kind %', p_kind;
  end if;
  foreach v_org in array coalesce(v_orgs, array[]::uuid[]) loop
    if v_org is not null then v_ctx := v_ctx || jsonb_build_object('organization_id', v_org); end if;
  end loop;
  perform public.sa_api_require_any(p_permissions, v_ctx, p_kind || ':' || coalesce(p_id::text, '-'));
end $$;
revoke all on function public.sa_api_require_resource(text[], text, uuid) from public;
grant execute on function public.sa_api_require_resource(text[], text, uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. API-role write guard
-- ---------------------------------------------------------------------------
create or replace function public.sa_tenant_remainder_api_guard()
returns trigger
language plpgsql
-- SECURITY INVOKER on purpose: current_user must be the caller's role (see stock_count_session_api_write_guard).
set search_path = pg_catalog, pg_temp
as $$
declare
  v_res text;
begin
  if current_user not in ('anon', 'authenticated') then
    return coalesce(new, old);
  end if;
  v_res := tg_table_name || ':' || coalesce(case when tg_op = 'DELETE' then to_jsonb(old)->>'id' else to_jsonb(new)->>'id' end, '-');

  if tg_table_name = 'shop_distributors' then
    if pg_trigger_depth() > 1 then return coalesce(new, old); end if; -- derived link written by another trigger
    if tg_op in ('UPDATE', 'DELETE') then
      perform public.sa_api_require_any(array['customer.shop.manage'],
        array[jsonb_build_object('organization_id', old.shop_id), jsonb_build_object('organization_id', old.distributor_id)], v_res);
    end if;
    if tg_op = 'INSERT' or (tg_op = 'UPDATE' and (new.shop_id, new.distributor_id) is distinct from (old.shop_id, old.distributor_id)) then
      perform public.sa_api_require_any(array['customer.shop.manage'],
        array[jsonb_build_object('organization_id', new.shop_id), jsonb_build_object('organization_id', new.distributor_id)], v_res);
    end if;

  elsif tg_table_name = 'distributor_products' then
    if tg_op in ('UPDATE', 'DELETE') then
      perform public.sa_api_require_any(array['product.catalog.manage'], array[jsonb_build_object('organization_id', old.distributor_id)], v_res);
    end if;
    if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.distributor_id is distinct from old.distributor_id) then
      perform public.sa_api_require_any(array['product.catalog.manage'], array[jsonb_build_object('organization_id', new.distributor_id)], v_res);
    end if;

  elsif tg_table_name = 'product_images' then
    perform public.sa_api_require_any(array['product.catalog.manage'],
      array[jsonb_build_object('organization_id', public.sa_actor_org_id())], v_res);

  elsif tg_table_name = 'organizations' then
    if tg_op = 'UPDATE' and (
         new.org_type_code, new.parent_org_id, new.org_code, new.is_active, new.registration_no, new.tax_id,
         new.payment_term_id, new.bank_id, new.bank_name, new.bank_account_number, new.bank_account_holder_name,
         new.default_warehouse_org_id, new.storefront_warehouse_org_id, new.id)
       is distinct from (
         old.org_type_code, old.parent_org_id, old.org_code, old.is_active, old.registration_no, old.tax_id,
         old.payment_term_id, old.bank_id, old.bank_name, old.bank_account_number, old.bank_account_holder_name,
         old.default_warehouse_org_id, old.storefront_warehouse_org_id, old.id) then
      perform public.sa_api_require_any(array['platform.organization.manage'], array[jsonb_build_object('organization_id', old.id)], v_res);
      if new.parent_org_id is distinct from old.parent_org_id and new.parent_org_id is not null then
        perform public.sa_api_require_any(array['platform.organization.manage'], array[jsonb_build_object('organization_id', new.parent_org_id)], v_res);
      end if;
    end if;

  elsif tg_table_name = 'orders' then
    if tg_op = 'UPDATE' and new.status is distinct from old.status then
      return new; -- status transitions: sa_orders_api_write_guard
    end if;
    perform public.sa_api_require_any(array['supply_chain.order.create'],
      array[jsonb_build_object('organization_id', old.buyer_org_id), jsonb_build_object('organization_id', old.seller_org_id)], v_res);
    if tg_op = 'UPDATE' and (new.buyer_org_id, new.seller_org_id) is distinct from (old.buyer_org_id, old.seller_org_id) then
      perform public.sa_api_require_any(array['supply_chain.order.create'],
        array[jsonb_build_object('organization_id', new.buyer_org_id), jsonb_build_object('organization_id', new.seller_org_id)], v_res);
    end if;

  elsif tg_table_name = 'order_items' then
    if tg_op in ('UPDATE', 'DELETE') then
      perform public.sa_api_require_resource(array['supply_chain.order.create'], 'order', old.order_id);
    end if;
    if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.order_id is distinct from old.order_id) then
      perform public.sa_api_require_resource(array['supply_chain.order.create'], 'order', new.order_id);
    end if;

  elsif tg_table_name = 'documents' then
    if tg_op = 'UPDATE' and new.status is distinct from old.status and new.status::text in ('acknowledged', 'completed') then
      return new; -- acknowledgement: sa_documents_api_write_guard (supply_chain.document.acknowledge)
    end if;
    if tg_op in ('UPDATE', 'DELETE') then
      perform public.sa_api_require_any(array['supply_chain.document.manage'], array[jsonb_build_object('organization_id', old.issued_by_org_id)], v_res);
    end if;
    if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.issued_by_org_id is distinct from old.issued_by_org_id) then
      perform public.sa_api_require_any(array['supply_chain.document.manage'], array[jsonb_build_object('organization_id', new.issued_by_org_id)], v_res);
    end if;

  elsif tg_table_name = 'document_files' then
    if tg_op in ('UPDATE', 'DELETE') then
      perform public.sa_api_require_resource(array['supply_chain.document.manage'], 'document', old.document_id);
    end if;
    if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.document_id is distinct from old.document_id) then
      perform public.sa_api_require_resource(array['supply_chain.document.manage'], 'document', new.document_id);
    end if;

  elsif tg_table_name = 'qr_reverse_jobs' then
    if tg_op in ('UPDATE', 'DELETE') then
      perform public.sa_api_require_any(array['manufacturing.scan.reverse', 'manufacturing.production.manage'],
        array[jsonb_build_object('organization_id', old.manufacturer_org_id)], v_res);
    end if;
    if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.manufacturer_org_id is distinct from old.manufacturer_org_id) then
      perform public.sa_api_require_any(array['manufacturing.scan.reverse', 'manufacturing.production.manage'],
        array[jsonb_build_object('organization_id', new.manufacturer_org_id)], v_res);
    end if;

  elsif tg_table_name in ('qr_reverse_job_items', 'qr_prepared_codes') then
    if tg_op in ('UPDATE', 'DELETE') then
      perform public.sa_api_require_resource(
        case when tg_table_name = 'qr_prepared_codes' then array['manufacturing.production.manage', 'manufacturing.scan.reverse']
             else array['manufacturing.scan.reverse', 'manufacturing.production.manage'] end,
        'reverse_job', old.job_id);
    end if;
    if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.job_id is distinct from old.job_id) then
      perform public.sa_api_require_resource(
        case when tg_table_name = 'qr_prepared_codes' then array['manufacturing.production.manage', 'manufacturing.scan.reverse']
             else array['manufacturing.scan.reverse', 'manufacturing.production.manage'] end,
        'reverse_job', new.job_id);
    end if;

  elsif tg_table_name = 'stock_adjustments' then
    if tg_op = 'UPDATE' then
      perform public.sa_api_require_any(array['manufacturing.adjustment.manage'],
        array[jsonb_build_object('organization_id', old.organization_id), jsonb_build_object('organization_id', old.target_manufacturer_org_id)], v_res);
    end if;
    if tg_op = 'INSERT' or (tg_op = 'UPDATE' and (new.organization_id, new.target_manufacturer_org_id) is distinct from (old.organization_id, old.target_manufacturer_org_id)) then
      perform public.sa_api_require_any(array['manufacturing.adjustment.manage'],
        array[jsonb_build_object('organization_id', new.organization_id), jsonb_build_object('organization_id', new.target_manufacturer_org_id)], v_res);
    end if;

  elsif tg_table_name = 'stock_count_classification_allocation_resolutions' then
    if tg_op in ('UPDATE', 'DELETE') then
      perform public.sa_api_require_resource(array['inventory.opening_balance.manage'], 'stock_count_session', old.session_id);
    end if;
    if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.session_id is distinct from old.session_id) then
      perform public.sa_api_require_resource(array['inventory.opening_balance.manage'], 'stock_count_session', new.session_id);
    end if;

  else
    raise exception 'sa_tenant_remainder_api_guard: not configured for %', tg_table_name;
  end if;
  return coalesce(new, old);
end $$;
revoke all on function public.sa_tenant_remainder_api_guard() from public, anon, authenticated;
comment on function public.sa_tenant_remainder_api_guard() is
  'S&A backstop for RLS gates whose NEW-mode remainder is a tenant predicate: API-role writes need the gate permission for the row''s organization. No-op in LEGACY_ENFORCED/SHADOW and for SECURITY DEFINER workflow functions / service role.';

do $guards$
declare
  v_spec text[];
begin
  foreach v_spec slice 1 in array array[
    array['shop_distributors',                                  'insert or update or delete'],
    array['distributor_products',                               'insert or update or delete'],
    array['product_images',                                     'insert or update or delete'],
    array['organizations',                                      'update'],
    array['orders',                                             'update or delete'],
    array['order_items',                                        'insert or update or delete'],
    array['documents',                                          'insert or update or delete'],
    array['document_files',                                     'insert or update or delete'],
    array['qr_reverse_jobs',                                    'insert or update or delete'],
    array['qr_reverse_job_items',                               'insert or update or delete'],
    array['qr_prepared_codes',                                  'insert or update or delete'],
    array['stock_adjustments',                                  'insert or update'],
    array['stock_count_classification_allocation_resolutions',  'insert or update or delete']
  ] loop
    if to_regclass('public.' || v_spec[1]) is null then
      raise notice 'sa_tenant_remainder_api_guard: % not present, skipped', v_spec[1];
      continue;
    end if;
    execute format('drop trigger if exists sa_tenant_remainder_api_guard on public.%I', v_spec[1]);
    execute format('create trigger sa_tenant_remainder_api_guard before %s on public.%I
                    for each row execute function public.sa_tenant_remainder_api_guard()', v_spec[2], v_spec[1]);
    execute format('revoke truncate on table public.%I from anon, authenticated', v_spec[1]);
  end loop;
end $guards$;

-- ---------------------------------------------------------------------------
-- 3. Workflow-only tables (the app writes them only with the service role)
-- ---------------------------------------------------------------------------
do $workflow_only$
declare t text;
begin
  foreach t in array array['return_case_status_history', 'serapp_order_holds', 'stock_adjustment_manufacturer_actions'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists sa_workflow_only_api_write_guard on public.%I', t);
    execute format('create trigger sa_workflow_only_api_write_guard before insert or update or delete on public.%I
                    for each row execute function public.sa_workflow_only_api_write_guard()', t);
    execute format('revoke truncate on table public.%I from anon, authenticated', t);
  end loop;
end $workflow_only$;

-- ---------------------------------------------------------------------------
-- 4. referral_claims: no hard-coded identity in the NEW-mode remainder
-- ---------------------------------------------------------------------------
do $referral$
declare
  v_qual text;
  v_marker text := 'sa_rls_new_mode(''customer.shop.manage''::text) AND';
  v_pos int;
  v_tail text;
begin
  select pg_get_expr(pol.polqual, pol.polrelid) into v_qual
  from pg_policy pol
  where pol.polrelid = to_regclass('public.referral_claims') and pol.polname = 'Managers can manage referral claims of reports';
  if v_qual is null then
    raise notice 'referral_claims policy not present, skipped';
    return;
  end if;
  v_pos := strpos(v_qual, v_marker);
  if v_pos = 0 then
    raise notice 'referral_claims policy is not S&A-gated here, skipped';
    return;
  end if;
  v_tail := substr(v_qual, v_pos);
  if v_tail !~ 'super@dev\.com' then
    return; -- already clean (repeat run)
  end if;
  raise notice 'referral_claims original USING (rollback): %', v_qual;
  v_tail := regexp_replace(v_tail, '\(u\.email = ''super@dev\.com''::text\) OR ', '', 'g');
  if v_tail ~ 'super@dev\.com' then
    raise exception 'referral_claims: unexpected remainder shape, not rewritten';
  end if;
  execute format('alter policy %I on public.referral_claims using (%s)',
                 'Managers can manage referral claims of reports', substr(v_qual, 1, v_pos - 1) || v_tail);
end $referral$;

-- ---------------------------------------------------------------------------
-- 5. Post-conditions
-- ---------------------------------------------------------------------------
do $$
declare
  v_tbl text;
  v_tail text;
begin
  foreach v_tbl in array array['shop_distributors', 'distributor_products', 'product_images', 'organizations', 'orders',
                               'order_items', 'documents', 'document_files', 'qr_reverse_jobs', 'qr_reverse_job_items',
                               'qr_prepared_codes', 'stock_adjustments', 'stock_count_classification_allocation_resolutions'] loop
    if to_regclass('public.' || v_tbl) is not null
       and not exists (select 1 from pg_trigger where tgname = 'sa_tenant_remainder_api_guard'
                       and tgrelid = ('public.' || v_tbl)::regclass and tgenabled = 'O') then
      raise exception 'postcondition: tenant remainder guard missing on %', v_tbl;
    end if;
  end loop;
  foreach v_tbl in array array['return_case_status_history', 'serapp_order_holds', 'stock_adjustment_manufacturer_actions'] loop
    if to_regclass('public.' || v_tbl) is not null
       and not exists (select 1 from pg_trigger where tgname = 'sa_workflow_only_api_write_guard'
                       and tgrelid = ('public.' || v_tbl)::regclass and tgenabled = 'O') then
      raise exception 'postcondition: workflow-only guard missing on %', v_tbl;
    end if;
  end loop;
  if (select prosecdef from pg_proc where oid = 'public.sa_tenant_remainder_api_guard()'::regprocedure) then
    raise exception 'postcondition: tenant remainder guard must be SECURITY INVOKER';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.sa_api_require_any(text[],jsonb[],text)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.sa_api_require_resource(text[],text,uuid)'::regprocedure) then
    raise exception 'postcondition: decision helpers must be SECURITY DEFINER';
  end if;
  if has_function_privilege('public', 'public.sa_api_require_any(text[],jsonb[],text)', 'EXECUTE')
     or has_function_privilege('public', 'public.sa_api_require_resource(text[],text,uuid)', 'EXECUTE') then
    raise exception 'postcondition: decision helpers must not be granted to PUBLIC';
  end if;
  select substr(q, strpos(q, 'sa_rls_new_mode')) into v_tail
  from (select pg_get_expr(pol.polqual, pol.polrelid) q from pg_policy pol
        where pol.polrelid = to_regclass('public.referral_claims') and pol.polname = 'Managers can manage referral claims of reports') x;
  if v_tail ~ 'super@dev\.com' then
    raise exception 'postcondition: referral_claims NEW-mode remainder still has a hard-coded identity';
  end if;
end $$;
