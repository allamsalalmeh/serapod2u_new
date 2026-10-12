-- ============================================================================
-- SUPERSEDED — intentionally a no-op. Do not apply the earlier draft of this file.
-- ----------------------------------------------------------------------------
-- The earlier (never applied) draft made vw_stock_movements_ordered security_invoker and granted it to
-- authenticated. That fixed the Phase 0B 403 but left the legacy stock_movements_view_all rule (no inventory
-- permission required, ancestors and the role-level shortcut allowed) and exposed HQ unit costs and warehouse
-- balances to partner accounts.
--
-- The complete fix is 20261107100000_sa_stock_movement_access.sql: permission-aware movement rows, cost/balance
-- column revoke on stock_movements, and both movement views owner-run with filtering and field masking. An invoker
-- view cannot work after that file (authenticated can no longer read the cost/balance columns), so this file must
-- stay a no-op. Kept only so the migration sequence has no gap.
-- ============================================================================

do $superseded$
begin
  raise notice '20261029100000 is superseded by 20261107100000_sa_stock_movement_access.sql; nothing to do.';
end
$superseded$;
