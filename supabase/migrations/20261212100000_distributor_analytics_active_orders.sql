-- ============================================================================
-- Distributor Analytics: headline KPIs measure ACTIVE orders only
-- ----------------------------------------------------------------------------
-- UAT (Enhancement03): SO26000151 (D2H, RM3,200) was cancelled and still
-- counted in Total Orders / Order Value, because "All Status" passed
-- p_status = NULL and the eligible population then held every status,
-- draft and cancelled included.
--
-- Approved definitions (sales-kpi.ts is the shared source of truth):
--   Active statuses   = submitted, approved, warehouse_packed,
--                       shipped_distributor, closed
--   Approved Sales    = approved, warehouse_packed, shipped_distributor, closed
--   Pipeline          = submitted
--   Excluded          = draft, cancelled (kept for history and audit only)
--
-- Population model:
--   scope   = D2H orders with a DIST buyer, narrowed by p_status when given.
--             "All Status" (NULL) is inclusive.
--   active  = scope ∩ active statuses. A specific status is honoured by
--             intersecting it with the active set, so status = 'cancelled'
--             yields zero active orders and still lists the cancelled ones.
--
--   From ACTIVE: current / previous orders, orderValue, activeDistributors,
--                dailyTrend, distributors (window values AND lifetime
--                first / last / count — a cancelled order never makes a
--                distributor New, Returning or recent), topProducts.
--   From SCOPE:  current / previous ordersCreated, statusBreakdown (Order
--                Processing Health: approved sales, pipeline, cancelled value,
--                cancellation rate) and recentOrders (cancelled orders stay
--                visible there, labelled by status).
--
-- `kpiModel` = 'active_orders_v1' tells the application this function applies
-- the definitions above; an older function without it is not trusted for the
-- headline and the application aggregates on the server instead.
--
-- Same signature, grants and RLS model (SECURITY INVOKER). No table, row,
-- policy or grant is changed. Rollback: re-apply
-- 20261013150000_distributor_analytics_all_products.sql.
--
-- NOT applied automatically: run manually after review.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reporting_distributor_analytics(
  p_month          text,
  p_distributor_id uuid DEFAULT NULL,
  p_status         text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_month_start   date;
  v_today         date;
  v_current_month date;
  v_prev_month    date;
  v_days_in_month integer;
  v_days_in_prev  integer;
  v_day_count     integer;
  v_cmp_days      integer;
  v_end_date      date;
  v_prev_end_date date;
  v_scope_name    text;
  v_result        jsonb;
  -- Keep in step with ACTIVE_ORDER_STATUSES in app/src/lib/reporting/sales-kpi.ts.
  v_active        public.order_status[] := ARRAY[
    'submitted', 'approved', 'warehouse_packed', 'shipped_distributor', 'closed'
  ]::public.order_status[];
BEGIN
  IF p_month IS NULL OR p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'Invalid reporting month %, expected YYYY-MM', p_month
      USING ERRCODE = '22023';
  END IF;

  v_month_start   := (p_month || '-01')::date;
  v_today         := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
  v_current_month := date_trunc('month', v_today)::date;
  v_prev_month    := (v_month_start - interval '1 month')::date;
  v_days_in_month := extract(day from (v_month_start + interval '1 month' - interval '1 day'))::integer;
  v_days_in_prev  := extract(day from (v_month_start - interval '1 day'))::integer;

  -- Month to date for the running month; the complete month once it is closed.
  v_day_count := CASE
    WHEN v_month_start > v_current_month THEN 0
    WHEN v_month_start = v_current_month THEN LEAST(extract(day from v_today)::integer, v_days_in_month)
    ELSE v_days_in_month
  END;

  -- Same elapsed days of the previous month while reporting MTD (clamped where
  -- that month is shorter); the complete previous month for a closed month.
  v_cmp_days := CASE
    WHEN v_month_start = v_current_month THEN LEAST(v_day_count, v_days_in_prev)
    ELSE v_days_in_prev
  END;

  -- Half-open business-date windows. order_date is already the Malaysia
  -- calendar date, so no time-zone conversion is applied to it anywhere below.
  v_end_date      := v_month_start + v_day_count;
  v_prev_end_date := v_prev_month + v_cmp_days;

  SELECT o.org_name INTO v_scope_name
    FROM public.organizations o
   WHERE p_distributor_id IS NOT NULL
     AND o.id = p_distributor_id;

  WITH scope AS (
    -- The distributor universe: every DIST organisation the caller can read,
    -- narrowed to one when the report is scoped to a single distributor.
    SELECT b.id, b.org_name, b.org_code, b.is_active
      FROM public.organizations b
     WHERE b.org_type_code = 'DIST'
       AND (p_distributor_id IS NULL OR b.id = p_distributor_id)
  ),
  eligible AS (
    -- Every D2H order across ALL history for the scoped distributors, narrowed
    -- by the selected status. "All Status" keeps every status here.
    SELECT o.id, o.buyer_org_id, o.order_date, o.created_at, o.status, o.order_no, o.display_doc_no,
           (o.status = ANY (v_active)) AS is_active
      FROM public.orders o
      JOIN scope s ON s.id = o.buyer_org_id
     WHERE o.order_date IS NOT NULL
       AND o.order_type = 'D2H'
       AND (p_status IS NULL OR o.status = p_status::public.order_status)
  ),
  lifetime AS (
    -- Business order history from ACTIVE orders only: a draft or cancelled
    -- order never makes a distributor New, never resets its recency.
    SELECT e.buyer_org_id,
           min(e.order_date)  AS first_order_date,
           max(e.order_date)  AS last_order_date,
           count(*)::bigint   AS lifetime_orders
      FROM eligible e
     WHERE e.is_active
     GROUP BY e.buyer_org_id
  ),
  windowed AS (
    -- The report window and its comparison window are adjacent, so this is one
    -- index range on orders.order_date rather than two separate scans.
    SELECT e.*,
           (e.order_date >= v_month_start AND e.order_date < v_end_date)      AS in_current,
           (e.order_date >= v_prev_month  AND e.order_date < v_prev_end_date) AS in_previous
      FROM eligible e
     WHERE v_day_count > 0
       AND e.order_date >= v_prev_month
       AND e.order_date <  v_end_date
  ),
  order_values AS (
    SELECT oi.order_id,
           sum(COALESCE(oi.line_total, oi.qty * oi.unit_price))::numeric AS order_value,
           count(*)::bigint                                              AS item_count
      FROM public.order_items oi
      JOIN windowed w ON w.id = oi.order_id
     GROUP BY oi.order_id
  ),
  window_orders AS (
    -- Every scoped order of both windows, any status. An order with no lines
    -- still counts as an order and carries zero value.
    SELECT w.*,
           COALESCE(ov.order_value, 0)::numeric AS order_value,
           COALESCE(ov.item_count, 0)::bigint   AS item_count
      FROM windowed w
      LEFT JOIN order_values ov ON ov.order_id = w.id
  ),
  active_window AS (
    SELECT * FROM window_orders WHERE is_active
  ),
  per_distributor AS (
    SELECT s.id                                                                        AS distributor_id,
           s.org_name,
           s.org_code,
           s.is_active,
           COALESCE(count(*) FILTER (WHERE w.in_current), 0)::bigint                   AS current_orders,
           COALESCE(sum(w.order_value) FILTER (WHERE w.in_current), 0)::numeric        AS current_value,
           COALESCE(count(*) FILTER (WHERE w.in_previous), 0)::bigint                  AS previous_orders,
           COALESCE(sum(w.order_value) FILTER (WHERE w.in_previous), 0)::numeric       AS previous_value,
           l.first_order_date,
           l.last_order_date,
           COALESCE(l.lifetime_orders, 0)::bigint                                      AS lifetime_orders
      FROM scope s
      JOIN lifetime l ON l.buyer_org_id = s.id
      LEFT JOIN active_window w ON w.buyer_org_id = s.id
     -- Distributors with no active order ever carry no trading history; their
     -- draft / cancelled orders remain in the status mix and recent orders.
     GROUP BY s.id, s.org_name, s.org_code, s.is_active,
              l.first_order_date, l.last_order_date, l.lifetime_orders
  ),
  totals AS (
    SELECT
      COALESCE(count(*) FILTER (WHERE in_current AND is_active), 0)::bigint                      AS current_orders,
      COALESCE(sum(order_value) FILTER (WHERE in_current AND is_active), 0)::numeric             AS current_value,
      COALESCE(count(DISTINCT buyer_org_id) FILTER (WHERE in_current AND is_active), 0)::bigint  AS current_active,
      COALESCE(count(*) FILTER (WHERE in_current), 0)::bigint                                    AS current_created,
      COALESCE(count(*) FILTER (WHERE in_previous AND is_active), 0)::bigint                     AS previous_orders,
      COALESCE(sum(order_value) FILTER (WHERE in_previous AND is_active), 0)::numeric            AS previous_value,
      COALESCE(count(DISTINCT buyer_org_id) FILTER (WHERE in_previous AND is_active), 0)::bigint AS previous_active,
      COALESCE(count(*) FILTER (WHERE in_previous), 0)::bigint                                   AS previous_created
      FROM window_orders
  ),
  day_series AS (
    -- Every day of the report window, including days with no trading, and no
    -- day beyond it — the running month stops at today.
    SELECT to_char(v_month_start + gs, 'YYYY-MM-DD') AS day_key
      FROM generate_series(0, GREATEST(v_day_count - 1, 0)) AS gs
     WHERE v_day_count > 0
  ),
  daily AS (
    SELECT to_char(w.order_date, 'YYYY-MM-DD') AS day_key,
           count(*)::bigint          AS orders,
           sum(w.order_value)::numeric AS order_value
      FROM active_window w
     WHERE w.in_current
     GROUP BY 1
  ),
  status_mix AS (
    -- Every status of the scope, draft and cancelled included.
    SELECT w.status::text          AS status,
           count(*)::bigint        AS orders,
           sum(w.order_value)::numeric AS order_value
      FROM window_orders w
     WHERE w.in_current
     GROUP BY 1
  ),
  top_products AS (
    SELECT oi.variant_id,
           (array_agg(pv.product_id))[1] AS product_id,
           max(p.product_name)     AS product_name,
           max(pv.variant_name)    AS variant_name,
           max(pv.product_code)    AS product_code,
           sum(oi.qty)::numeric    AS units,
           sum(COALESCE(oi.line_total, oi.qty * oi.unit_price))::numeric AS order_value
      FROM public.order_items oi
      JOIN active_window w ON w.id = oi.order_id AND w.in_current
      LEFT JOIN public.product_variants pv ON pv.id = oi.variant_id
      LEFT JOIN public.products p          ON p.id = pv.product_id
     GROUP BY oi.variant_id
     ORDER BY order_value DESC NULLS LAST
  ),
  recent AS (
    -- Any status: a cancelled order stays visible here, labelled by status.
    SELECT w.id, w.order_no, w.display_doc_no, w.order_date, w.created_at, w.status,
           w.buyer_org_id, w.order_value, w.item_count, s.org_name
      FROM window_orders w
      JOIN scope s ON s.id = w.buyer_org_id
     WHERE w.in_current
     ORDER BY w.order_date DESC, w.created_at DESC
     LIMIT 20
  )
  SELECT jsonb_build_object(
    'month', p_month,
    'distributorId', COALESCE(p_distributor_id::text, 'all'),
    'distributorName', COALESCE(v_scope_name, 'All Distributors'),
    'status', COALESCE(p_status, 'all'),
    'dateField', 'orders.order_date',
    'kpiModel', 'active_orders_v1',
    'current', jsonb_build_object(
      'orders', t.current_orders,
      'orderValue', round(t.current_value, 2),
      'activeDistributors', t.current_active,
      'ordersCreated', t.current_created
    ),
    'previous', jsonb_build_object(
      'orders', t.previous_orders,
      'orderValue', round(t.previous_value, 2),
      'activeDistributors', t.previous_active,
      'ordersCreated', t.previous_created
    ),
    'dailyTrend', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'date', ds.day_key,
               'orders', COALESCE(d.orders, 0),
               'orderValue', round(COALESCE(d.order_value, 0), 2)
             ) ORDER BY ds.day_key)
        FROM day_series ds
        LEFT JOIN daily d ON d.day_key = ds.day_key
    ), '[]'::jsonb),
    'distributors', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'distributorId', pd.distributor_id,
               'name', pd.org_name,
               'orgCode', pd.org_code,
               'isActive', COALESCE(pd.is_active, true),
               'currentOrders', pd.current_orders,
               'currentValue', round(pd.current_value, 2),
               'previousOrders', pd.previous_orders,
               'previousValue', round(pd.previous_value, 2),
               -- Business dates, plus the instant their MYT day starts so
               -- consumers that measure recency keep working unchanged.
               'firstOrderDate', to_char(pd.first_order_date, 'YYYY-MM-DD'),
               'lastOrderDate', to_char(pd.last_order_date, 'YYYY-MM-DD'),
               'firstOrderAt', pd.first_order_date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur',
               'lastOrderAt', pd.last_order_date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur',
               'lifetimeOrders', pd.lifetime_orders
             ))
        FROM per_distributor pd
    ), '[]'::jsonb),
    'statusBreakdown', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'status', sm.status,
               'orders', sm.orders,
               'orderValue', round(COALESCE(sm.order_value, 0), 2)
             ))
        FROM status_mix sm
    ), '[]'::jsonb),
    'topProducts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'variantId', tp.variant_id,
               'productId', tp.product_id,
               'productName', tp.product_name,
               'variantName', tp.variant_name,
               'productCode', tp.product_code,
               'units', COALESCE(tp.units, 0),
               'orderValue', round(COALESCE(tp.order_value, 0), 2)
             ))
        FROM top_products tp
    ), '[]'::jsonb),
    'recentOrders', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'orderId', r.id,
               'orderNo', COALESCE(r.display_doc_no, r.order_no),
               'orderDate', to_char(r.order_date, 'YYYY-MM-DD'),
               'createdAt', r.created_at,
               'status', r.status::text,
               'distributorId', r.buyer_org_id,
               'distributorName', r.org_name,
               'orderValue', round(r.order_value, 2),
               'itemCount', r.item_count
             ) ORDER BY r.order_date DESC, r.created_at DESC)
        FROM recent r
    ), '[]'::jsonb)
  )
  INTO v_result
  FROM totals t;

  RETURN COALESCE(v_result, jsonb_build_object(
    'month', p_month,
    'distributorId', COALESCE(p_distributor_id::text, 'all'),
    'distributorName', COALESCE(v_scope_name, 'All Distributors'),
    'status', COALESCE(p_status, 'all'),
    'dateField', 'orders.order_date',
    'kpiModel', 'active_orders_v1',
    'current', jsonb_build_object('orders', 0, 'orderValue', 0, 'activeDistributors', 0, 'ordersCreated', 0),
    'previous', jsonb_build_object('orders', 0, 'orderValue', 0, 'activeDistributors', 0, 'ordersCreated', 0),
    'dailyTrend', '[]'::jsonb,
    'distributors', '[]'::jsonb,
    'statusBreakdown', '[]'::jsonb,
    'topProducts', '[]'::jsonb,
    'recentOrders', '[]'::jsonb
  ));
END;
$$;

REVOKE ALL ON FUNCTION public.reporting_distributor_analytics(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reporting_distributor_analytics(text, uuid, text) TO authenticated;

COMMENT ON FUNCTION public.reporting_distributor_analytics(text, uuid, text) IS
  'Monthly distributor management report (MTD vs same elapsed days, or full month vs full previous month) in Asia/Kuala_Lumpur, bucketed on the business date orders.order_date. D2H orders with DIST buyers. Headline orders / value / trend / rankings / products / lifetime use ACTIVE orders only (submitted, approved, warehouse_packed, shipped_distributor, closed); ordersCreated, statusBreakdown and recentOrders cover every status in scope. kpiModel = active_orders_v1. Honors orders / order_items / organizations RLS.';
