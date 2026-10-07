-- Index the remaining unindexed foreign keys that reference order_items(id).
-- Each deleted order_items row triggers a probe on every referencing table
-- (NO ACTION / CASCADE / SET NULL alike). These tables are small today but
-- grow with every order; the guards keep the file safe on environments where
-- a table does not exist. Plain CREATE INDEX is fine at this size.
--
-- Rollback: DROP INDEX IF EXISTS the four idx_*_order_item_id indexes below.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('inventory_cutoff_decisions',           'idx_inventory_cutoff_decisions_order_item_id'),
      ('inventory_cutoff_audit_events',        'idx_inventory_cutoff_audit_events_order_item_id'),
      ('messaging_preparation_items',          'idx_messaging_preparation_items_order_item_id'),
      ('messaging_delivery_discrepancy_items', 'idx_messaging_delivery_discrepancy_items_order_item_id')
    ) AS v(tbl, idx)
  LOOP
    IF to_regclass('public.' || t.tbl) IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = t.tbl AND column_name = 'order_item_id') THEN
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (order_item_id) WHERE order_item_id IS NOT NULL', t.idx, t.tbl);
    END IF;
  END LOOP;
END $$;
