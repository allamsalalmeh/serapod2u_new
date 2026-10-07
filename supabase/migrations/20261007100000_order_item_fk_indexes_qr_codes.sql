-- Index the order_items referencing column on qr_codes.
--
-- Evidence (read-only, staging 2026-10-07): public.qr_codes (~1.1M rows,
-- 1.1 GB) has FK qr_codes_order_item_id_fkey -> order_items(id) (NO ACTION)
-- and NO index on order_item_id. Every row deleted from order_items makes the
-- FK check run `SELECT 1 FROM ONLY qr_codes WHERE order_item_id = $1`, a
-- parallel sequential scan (~115-320 ms per deleted line on staging, warm
-- cache). Saving an edited order deletes and re-inserts all its lines, and
-- the `authenticated` role has statement_timeout = 8s, so multi-line orders
-- on a larger qr_codes table hit "canceling statement due to statement
-- timeout" in the delete stage.
--
-- Partial index: the column is NULL for the vast majority of rows (0 non-null
-- on staging), so the index stays tiny while still serving the FK probe.
--
-- IMPORTANT: apply as the ONLY statement of its own transaction/file. CREATE
-- INDEX CONCURRENTLY cannot run inside a transaction block, so do not bundle
-- it with other statements. It does not block writers (QR generation).
-- If it is interrupted an INVALID index may remain: DROP INDEX CONCURRENTLY
-- IF EXISTS public.idx_qr_codes_order_item_id; then re-run.
--
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS public.idx_qr_codes_order_item_id;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_qr_codes_order_item_id
  ON public.qr_codes (order_item_id)
  WHERE order_item_id IS NOT NULL;
