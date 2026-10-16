import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const repoFile = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8')

// The staging schema snapshot is local-only (kept out of git on purpose); the audits derived from it run only where it
// exists. The consumer checks below read tracked source and always run.
const stagingSnapshot = (() => { try { return repoFile('supabase/schemas/current_schema_stg.sql') } catch { return null } })()
const schema = stagingSnapshot ?? ''
const migration = repoFile('supabase/migrations/20260716_stock_movement_history_balance_fix_04.sql')
const report = repoFile('app/src/components/inventory/StockMovementReportView.tsx')
const movementsApi = repoFile('app/src/app/api/movements/route.ts')

const stockConfigMigrations = [
  '20260717_stock_config_01_groundwork.sql',
  '20260717_stock_config_02_core_ledger.sql',
  '20260717_stock_config_03_ord_repack.sql',
  '20260717_stock_config_04_stock_count.sql',
  '20260717_stock_config_05_so_fulfilment.sql',
  '20260717_stock_config_06_views_reports.sql',
  '20260717_stock_config_07_reference_type_fix.sql',
  '20260717_stock_config_08_initial_classification.sql',
  '20260718_stock_config_09_full_count_classification_guard.sql',
  '20260718_stock_config_10_repack_to_20nb.sql',
  '20260718_stock_config_11_transfer_workflow.sql',
  '20260718_stock_config_12_transfer_dispatch_lifecycle.sql',
  '20260718_stock_config_13_manual_stock_addition.sql',
  '20260719_stock_config_14_classification_post_grant.sql',
  '20260719_stock_config_15_posting_statement_timeout.sql',
  '20260719_stock_config_16_classification_allocation_legacy_guards.sql',
  '20260719_stock_config_17_discard_stock_count_drafts.sql',
  '20260719_stock_config_18_classification_allow_physical_variance.sql',
  '20260719_stock_config_19_collision_safe_stock_sku_generator.sql',
  '20260719_stock_config_20_view_contract_compatibility.sql',
].map(name => repoFile(`supabase/migrations/${name}`))
const cutoffMigrations = [
  '01_cutoff_foundation.sql',
  '02_cutoff_preview_and_decisions.sql',
  '03_cutoff_atomic_posting.sql',
  '04_unified_opening_balance_flow.sql',
].map(name => repoFile(`supabase/migrations/20260726_inventory_opening_balance_cutoff/${name}`))

// Reconstruct the final installed definitions by applying each CREATE OR
// REPLACE in migration order. This keeps the writer inventory deterministic
// even when a developer's ignored staging-schema snapshot predates Migrations
// 01-20.
const finalFunctionBodies = new Map<string, string>()
for (const sql of [schema, ...stockConfigMigrations, ...cutoffMigrations]) {
  for (const match of sql.matchAll(
    /CREATE(?: OR REPLACE)? FUNCTION public\.([a-zA-Z0-9_]+)\([^;]*?AS \$\$([\s\S]*?)\$\$;/gi,
  )) {
    finalFunctionBodies.set(match[1], match[2])
  }
}
const functionBodies = Array.from(finalFunctionBodies, ([name, body]) => ({ name, body }))

describe('stock movement consumer audit contract', () => {
  it('routes active application closing-balance consumers through the shared helper', () => {
    expect(report).toContain('resolveStockMovementHistoryValues')
    expect(movementsApi).toContain('historicalQuantityAfter(row.quantity_before, row.quantity_change)')
  })

  it.skipIf(!stagingSnapshot)('corrects all schema views that expose quantity_after', () => {
    const viewNames = Array.from(
      schema.matchAll(/CREATE VIEW public\.([a-zA-Z0-9_]+) AS\s+([\s\S]*?);/g),
      match => ({ name: match[1], body: match[2] }),
    )
      .filter(view => view.body.includes('quantity_after'))
      .map(view => view.name)
      .sort()

    expect(viewNames).toEqual([
      'v_stock_movements_display',
      'v_wms_movements_recent',
      'vw_stock_movements_ordered',
    ])

    for (const viewName of viewNames) {
      expect(migration).toContain(`CREATE OR REPLACE VIEW public.${viewName}`)
    }
  })
})

describe.skipIf(!stagingSnapshot)('stock movement writer audit contract', () => {
  it('keeps an explicit inventory of every direct SQL writer in the staging schema', () => {
    const directWriters = functionBodies
      .filter(fn => /INSERT\s+INTO\s+public\.stock_movements/i.test(fn.body))
      .map(fn => fn.name)
      .sort()

    expect(directWriters).toEqual([
      '_stock_transfer_release_reservations',
      '_stock_transfer_reserve_items',
      'allocate_inventory_for_order',
      'fn_test_balance_request_flow',
      'fulfill_order_inventory',
      'log_qr_receive_movement',
      'log_qr_shipment_movement',
      'record_stock_movement',
      'release_allocation_for_order',
      'set_order_item_stock_config',
      'stock_count_carry_classification_allocations',
      'verify_and_post_inventory_opening_cutoff',
      'wms_record_movement_from_summary',
    ])
  })

  it('keeps an explicit inventory of SQL services that delegate to record_stock_movement', () => {
    const rpcWriters = functionBodies
      .filter(fn => fn.name !== 'record_stock_movement' && /record_stock_movement\s*\(/.test(fn.body))
      .map(fn => fn.name)
      .sort()

    expect(rpcWriters).toEqual([
      'delete_scratch_campaign',
      'dispatch_stock_transfer',
      'post_manual_stock_addition',
      'post_return_case_inventory',
      'post_stock_transfer_configured',
      'post_warehouse_receipt',
      'receive_stock_transfer',
      'repack_stock_v2',
      'verify_and_post_stock_classification',
      'verify_and_post_stock_count',
      'wms_reverse_manual_movement',
      'wms_ship_mixed',
    ])
  })

  it('serializes the authoritative writer before its balance read', () => {
    const replacement = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.record_stock_movement'))
    expect(replacement.indexOf('pg_advisory_xact_lock')).toBeLessThan(replacement.indexOf('SELECT id, quantity_on_hand'))
    expect(replacement).toContain('FOR UPDATE')
  })

  it('keeps allocation pairs invariant while validating ordinary movements against on-hand', () => {
    expect(migration).toContain("NEW.movement_type IN ('allocation', 'deallocation')")
    expect(migration).toContain('NEW.quantity_after <> NEW.quantity_before + NEW.quantity_change')
    expect(migration).toContain('v_current_qty = NEW.quantity_before OR v_current_qty = NEW.quantity_after')
  })
})
