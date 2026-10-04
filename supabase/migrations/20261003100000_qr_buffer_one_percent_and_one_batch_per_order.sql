-- ============================================================================
-- QR generation: 1% manufacturer buffer default, one QR batch per order
-- ----------------------------------------------------------------------------
-- Confirmed business rules: H2M order quantity is in CASES, one unique QR code
-- per case, and the manufacturer supplies an additional 1% of cases as buffer
-- (1,000 ordered cases + 10 buffer cases = 1,010 unique case QR codes; master
-- / box QR codes are separate). Buffer rounding is unchanged:
-- floor(ordered cases × percent ÷ 100), as generateQRBatch has always done.
--
-- orders.qr_buffer_percent (and qr_batches.buffer_percent) defaulted to 10%,
-- and Create Order pre-filled 10%, so orders such as ORD26000106 showed
-- 1,000 + 100 = 1,100 QR codes. The application now defaults to 1%.
--
-- 1. Column defaults 10.00 -> 1.00 (new rows only).
-- 2. H2M orders that have NO QR batch yet and still carry the old 10% default
--    move to 1%. Orders with any qr_batches row are left exactly as they are,
--    and no qr_batches / qr_codes / qr_master_codes row is touched: existing
--    batches keep the buffer_percent they were generated with (the worker now
--    reads the batch's own buffer_percent when it resumes).
--    Preview before running:
--      select o.order_no, o.display_doc_no, o.status, o.qr_buffer_percent
--        from public.orders o
--       where o.order_type = 'H2M' and o.qr_buffer_percent = 10
--         and not exists (select 1 from public.qr_batches b where b.order_id = o.id);
--    Skip section 2 if any of those orders really should keep 10%.
-- 3. One QR batch per order (unique index on qr_batches.order_id), so two
--    concurrent "Generate QR Batch" requests cannot both create a batch. The
--    API also de-duplicates without it. The index is only created when no
--    order already has more than one batch; otherwise a NOTICE lists them and
--    nothing is changed (historical batches are never rewritten here).
--
-- Not required for the "Failed to generate QR batch" fix itself: that fix is
-- in /api/qr-batches/generate (service-role insert after the qr.batch.manage
-- guard and order-ownership check). No RLS policy is changed.
--
-- Idempotent: yes.
-- Rollback:
--   alter table public.orders alter column qr_buffer_percent set default 10.00;
--   alter table public.qr_batches alter column buffer_percent set default 10.00;
--   drop index if exists public.qr_batches_one_per_order;
--   (section 2 is a data change; restore from the preview list if needed)
-- ============================================================================

begin;

-- 1. Defaults -----------------------------------------------------------------
alter table public.orders alter column qr_buffer_percent set default 1.00;
alter table public.qr_batches alter column buffer_percent set default 1.00;

-- 2. Orders not yet generated -------------------------------------------------
update public.orders o
   set qr_buffer_percent = 1.00
 where o.order_type = 'H2M'
   and o.qr_buffer_percent = 10.00
   and not exists (select 1 from public.qr_batches b where b.order_id = o.id);

-- 3. One batch per order --------------------------------------------------------
do $one_batch$
declare
  v_duplicates text;
begin
  if to_regclass('public.qr_batches_one_per_order') is not null then
    return;
  end if;

  select string_agg(format('%s (%s batches)', coalesce(o.display_doc_no, o.order_no, d.order_id::text), d.n), ', ')
    into v_duplicates
    from (select order_id, count(*) as n from public.qr_batches group by order_id having count(*) > 1) d
    left join public.orders o on o.id = d.order_id;

  if v_duplicates is not null then
    raise notice 'qr_batches_one_per_order not created: orders with more than one batch: %', v_duplicates;
    return;
  end if;

  create unique index qr_batches_one_per_order on public.qr_batches (order_id);
end
$one_batch$;

commit;
