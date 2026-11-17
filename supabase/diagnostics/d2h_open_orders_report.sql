-- Read-only: open D2H orders, what was paid (receipts) vs verified by Finance vs order total.
-- Run after migration 20261231100000 (uses its functions). Changes nothing.
SELECT o.order_no,
       b.org_name                                   AS distributor,
       o.status,
       o.created_at::date                           AS created,
       public.d2h_order_total(o.id)                 AS order_total,
       public.d2h_order_paid_amount(o.id)           AS paid,
       public.fin_order_received_total(o.id)        AS verified_by_finance,
       public.d2h_order_total(o.id) - public.d2h_order_paid_amount(o.id) AS outstanding,
       (SELECT count(*) FROM public.documents d
         WHERE d.order_id = o.id AND d.doc_type = 'PAYMENT' AND d.status = 'pending') AS pending_payments,
       CASE
         WHEN public.d2h_order_paid_amount(o.id) = 0 THEN 'not paid'
         WHEN public.d2h_order_paid_amount(o.id) < public.d2h_order_total(o.id) - 0.005 THEN 'partially paid'
         WHEN public.fin_order_received_total(o.id) < public.d2h_order_total(o.id) - 0.005 THEN 'paid - awaiting Finance'
         ELSE 'paid and verified (should close)'
       END                                          AS state
  FROM public.orders o
  LEFT JOIN public.organizations b ON b.id = o.buyer_org_id
 WHERE o.order_type = 'D2H'
   AND o.status::text NOT IN ('closed', 'cancelled', 'draft')
 ORDER BY o.created_at;
