-- Stand-ins for the inventory tables, the tenant helpers and the four inventory views (disposable DB only).
-- Policies, helper bodies and view definitions are copied from staging (read-only catalogue read, 2026-10-11).
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;

alter table public.organizations add column if not exists org_code text;
alter table public.product_variants add column if not exists variant_code text, add column if not exists variant_name text,
  add column if not exists image_url text;
create table public.brands (id uuid primary key, brand_name text);
create table public.products (id uuid primary key, product_name text, product_code text, brand_id uuid);
create table public.inventory_stock_configurations (
  id uuid primary key, variant_id uuid not null, config_code text, config_label text, stock_sku text, volume_ml integer,
  packaging text, status text not null default 'active', is_variant_default boolean, requires_repacking_before_sale boolean,
  default_for_ord boolean);
create table public.product_inventory (
  id uuid primary key default gen_random_uuid(), variant_id uuid not null, organization_id uuid not null,
  quantity_on_hand integer not null default 0, quantity_allocated integer not null default 0,
  quantity_available integer generated always as (quantity_on_hand - quantity_allocated) stored,
  reorder_point integer default 0, reorder_quantity integer, max_stock_level integer, safety_stock integer, lead_time_days integer,
  average_cost numeric, total_value numeric, warehouse_location text, updated_at timestamptz default now(),
  stock_config_id uuid, is_active boolean not null default true, last_counted_at timestamptz);
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(), created_at timestamptz default now(), movement_type text not null,
  variant_id uuid, from_organization_id uuid, to_organization_id uuid, quantity_change integer not null,
  quantity_before integer not null default 0, unit_cost numeric, reference_id uuid, reason text, created_by uuid,
  reference_type text, stock_config_id uuid);

-- Tenant helpers (production bodies; get_my_role_level = the caller's role level).
create function public.get_my_role_level() returns integer language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(public.current_user_role_level(), 999) $$;
create function public.is_hq_admin() returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
BEGIN
  RETURN public.get_my_role_level() <= 10;
END; $$;
create function public.get_org_descendants(p_org_id uuid) returns table(org_id uuid, level integer) language sql stable as $$
  WITH RECURSIVE d AS (
    SELECT id, 0 AS level FROM organizations WHERE id = p_org_id
    UNION ALL
    SELECT o.id, d.level + 1 FROM organizations o JOIN d ON o.parent_org_id = d.id WHERE d.level < 10
  )
  SELECT id, level FROM d; $$;
alter function public.get_org_descendants(uuid) set search_path = public, pg_temp;
create function public.can_access_org(p_org_id uuid) returns boolean language sql stable security definer set search_path = public, extensions, pg_temp as $$
  SELECT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid() AND u.is_active = true
      AND (public.is_hq_admin()
           OR u.organization_id = p_org_id
           OR p_org_id IN (SELECT org_id FROM public.get_org_descendants(u.organization_id))
           OR u.organization_id IN (SELECT org_id FROM public.get_org_descendants(p_org_id)))
  ); $$;

-- product_inventory policies exactly as on staging (after the Final Wave gate).
alter table public.product_inventory enable row level security;
create policy inventory_read_org_hierarchy on public.product_inventory for select to authenticated
  using ((is_active = true) AND (can_access_org(organization_id) OR is_hq_admin()));
create policy inventory_org_manage on public.product_inventory for all to authenticated
  using ((sa_rls_gate('inventory.adjustment.post'::text, organization_id, (can_access_org(organization_id) OR is_hq_admin())) OR (sa_rls_new_mode('inventory.adjustment.post'::text) AND (can_access_org(organization_id) OR false))))
  with check ((sa_rls_gate('inventory.adjustment.post'::text, organization_id, (can_access_org(organization_id) OR is_hq_admin())) OR (sa_rls_new_mode('inventory.adjustment.post'::text) AND (can_access_org(organization_id) OR false))));
alter table public.stock_movements enable row level security;  -- its own (legacy) SELECT policy is out of scope
grant select, insert, update, delete on public.product_inventory to authenticated;
grant select on public.products, public.brands, public.inventory_stock_configurations to authenticated;

-- The four views, staging definitions (superuser owner, not security_invoker, granted to authenticated).
create view public.vw_inventory_on_hand as
 SELECT pi.id, pi.variant_id, pi.organization_id, pi.quantity_on_hand, pi.quantity_allocated, pi.quantity_available,
    pi.reorder_point, pi.reorder_quantity, pi.max_stock_level, pi.safety_stock, pi.lead_time_days, pi.average_cost,
    pi.total_value, pi.warehouse_location, pv.variant_code, pv.variant_name, pv.image_url AS variant_image_url,
    p.id AS product_id, p.product_name, p.product_code, o.org_name AS organization_name, o.org_code AS organization_code,
    pi.updated_at, pi.stock_config_id, c.config_code, c.config_label, c.stock_sku, c.volume_ml, c.packaging,
    c.status AS stock_config_status, c.is_variant_default, c.requires_repacking_before_sale, c.default_for_ord
   FROM product_inventory pi
     JOIN inventory_stock_configurations c ON c.id = pi.stock_config_id AND c.variant_id = pi.variant_id
     JOIN product_variants pv ON pv.id = pi.variant_id
     JOIN products p ON p.id = pv.product_id
     JOIN organizations o ON o.id = pi.organization_id
  WHERE pi.is_active = true AND (c.status = 'active'::text OR pi.quantity_on_hand <> 0 OR pi.quantity_allocated <> 0);

create view public.vw_manual_stock_balance as
 SELECT CASE WHEN sm.movement_type = 'manual_in'::text THEN sm.to_organization_id
             WHEN sm.movement_type = 'manual_out'::text THEN sm.from_organization_id ELSE NULL::uuid END AS warehouse_id,
    sm.variant_id,
    sum(CASE WHEN sm.movement_type = ANY (ARRAY['manual_in'::text, 'manual_out'::text]) THEN sm.quantity_change ELSE 0 END) AS manual_balance_qty,
    sm.stock_config_id, c.config_code, c.config_label, c.stock_sku, c.volume_ml, c.packaging,
    sm.stock_config_id IS NULL AS is_legacy_configuration
   FROM stock_movements sm
     LEFT JOIN inventory_stock_configurations c ON c.id = sm.stock_config_id AND c.variant_id = sm.variant_id
  WHERE sm.movement_type = ANY (ARRAY['manual_in'::text, 'manual_out'::text])
  GROUP BY (CASE WHEN sm.movement_type = 'manual_in'::text THEN sm.to_organization_id
                 WHEN sm.movement_type = 'manual_out'::text THEN sm.from_organization_id ELSE NULL::uuid END),
           sm.variant_id, sm.stock_config_id, c.config_code, c.config_label, c.stock_sku, c.volume_ml, c.packaging;

create view public.v_low_stock_alerts as
 WITH balances AS (
   SELECT min(pi.id::text)::uuid AS id, pi.organization_id, pi.variant_id,
      sum(pi.quantity_on_hand)::integer AS quantity_on_hand, sum(pi.quantity_allocated)::integer AS quantity_allocated,
      sum(pi.quantity_available)::integer AS quantity_available, max(pi.reorder_point) AS reorder_point,
      max(pi.reorder_quantity) AS reorder_quantity, max(pi.max_stock_level) AS max_stock_level,
      string_agg(DISTINCT pi.warehouse_location, ', '::text) FILTER (WHERE pi.warehouse_location IS NOT NULL) AS warehouse_location,
      max(pi.last_counted_at) AS last_counted_at, max(pi.updated_at) AS updated_at
     FROM product_inventory pi WHERE pi.is_active = true GROUP BY pi.organization_id, pi.variant_id
 )
 SELECT a.id, a.organization_id, o.org_name, o.org_type_code, a.variant_id, pv.variant_code, pv.variant_name,
    p.id AS product_id, p.product_code, p.product_name, p.brand_id, b.brand_name, a.quantity_on_hand, a.quantity_allocated,
    a.quantity_available, a.reorder_point, a.reorder_quantity, a.max_stock_level, a.reorder_point - a.quantity_available AS units_below_reorder,
    CASE WHEN a.reorder_point > 0 THEN round(a.quantity_available::numeric / a.reorder_point::numeric * 100::numeric, 1) ELSE 0::numeric END AS stock_level_percent,
    CASE WHEN a.quantity_available <= 0 THEN 'CRITICAL'::text
         WHEN a.quantity_available::numeric <= (a.reorder_point::numeric * 0.5) THEN 'HIGH'::text
         WHEN a.quantity_available <= a.reorder_point THEN 'MEDIUM'::text ELSE 'LOW'::text END AS priority,
    a.warehouse_location, a.last_counted_at, a.updated_at
   FROM balances a
     JOIN product_variants pv ON pv.id = a.variant_id
     JOIN products p ON p.id = pv.product_id
     LEFT JOIN brands b ON b.id = p.brand_id
     JOIN organizations o ON o.id = a.organization_id
  WHERE a.quantity_available <= a.reorder_point;

create view public.v_stock_movements_display as
 SELECT sm.id, sm.created_at, sm.movement_type, sm.variant_id, sm.from_organization_id, sm.to_organization_id,
    sm.quantity_change, sm.quantity_before, sm.quantity_before + sm.quantity_change AS quantity_after, sm.unit_cost,
    sm.reference_id, sm.reason, sm.created_by, sm.reference_type, sm.stock_config_id, c.config_code, c.config_label,
    c.stock_sku, c.volume_ml, c.packaging, sm.stock_config_id IS NULL AS is_legacy_configuration
   FROM stock_movements sm
     LEFT JOIN inventory_stock_configurations c ON c.id = sm.stock_config_id AND c.variant_id = sm.variant_id
  WHERE NOT (sm.movement_type = 'order_fulfillment'::text AND sm.quantity_before = 0 AND (sm.quantity_before + sm.quantity_change) = 0)
    AND NOT (sm.from_organization_id IS NULL AND sm.to_organization_id IS NULL);

grant select on public.vw_inventory_on_hand, public.vw_manual_stock_balance, public.v_low_stock_alerts, public.v_stock_movements_display to authenticated, service_role;
