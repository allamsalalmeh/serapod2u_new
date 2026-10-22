import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  path.resolve(__dirname, '../../../../supabase/migrations/20260720_hq_warehouse_return_posting_03.sql'),
  'utf8',
)
const skipExcludedMigration = readFileSync(
  path.resolve(
    __dirname,
    '../../../../supabase/migrations/20260904120000_return_inventory_skip_historically_excluded.sql',
  ),
  'utf8',
)
const wholeCasesMigration = readFileSync(
  path.resolve(
    __dirname,
    '../../../../supabase/migrations/20261213100000_return_inventory_posts_whole_cases.sql',
  ),
  'utf8',
)
const statusRoute = readFileSync(
  path.resolve(__dirname, '../../app/api/returns/[id]/status/route.ts'),
  'utf8',
)

describe('Return Product warehouse posting contract', () => {
  it('posts only through post_return_case_inventory with return reference metadata', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.post_return_case_inventory')
    expect(migration).toContain("p_reference_type := 'return'")
    expect(migration).toContain('p_organization_id := v_case.return_warehouse_id')
    expect(migration).toContain('Return inventory can only be posted at/after Return Received')
  })

  it('locks destination warehouse after receipt and wires status advance to posting', () => {
    expect(migration).toContain('Return warehouse cannot be changed after inventory receipt/posting has started')
    expect(statusRoute).toContain("next === 'return_received'")
    expect(statusRoute).toContain('post_return_case_inventory')
  })

  it('skips inventory for returns historically excluded by a posted Opening Balance', () => {
    expect(skipExcludedMigration).toContain('historically_excluded')
    expect(skipExcludedMigration).toContain('inventory_cutoff_excluded_transactions')
    expect(skipExcludedMigration).toContain("x.transaction_type = 'return'")
    expect(skipExcludedMigration).toContain("c.status = 'posted'")
    expect(skipExcludedMigration).toMatch(/posted_lines',\s*0/)
    expect(skipExcludedMigration.toLowerCase()).toContain("notify pgrst, 'reload schema'")
    expect(statusRoute).toContain('historically_excluded')
  })

  it('keeps the canonical operational stock configuration resolver', () => {
    expect(skipExcludedMigration).toContain('public.resolve_operational_stock_config(v_item.variant_id)')
    expect(skipExcludedMigration).not.toContain('resolve_default_stock_config(')
  })

  it('restores the exact S&A return guard after replacing the function', () => {
    const saModules = readFileSync(
      path.resolve(__dirname, '../../../../supabase/migrations/20260928120000_sa_final_modules_supply_chain.sql'),
      'utf8',
    )
    const guardOf = (sql: string) =>
      sql.match(/'public\.post_return_case_inventory\(uuid\)'::regprocedure, 'inventory\.return\.manage',\s*(\$g\$[\s\S]*?\$g\$)/)?.[1]
    expect(guardOf(saModules)).toBeTruthy()
    expect(guardOf(skipExcludedMigration)).toBe(guardOf(saModules))
    expect(skipExcludedMigration.indexOf('sa_inject_operation_guard')).toBeGreaterThan(
      skipExcludedMigration.indexOf('CREATE OR REPLACE FUNCTION public.post_return_case_inventory'),
    )
  })

  it('posts whole cases for lines with a pack size and keeps every other rule', () => {
    expect(wholeCasesMigration).toContain('CREATE OR REPLACE FUNCTION public.post_return_case_inventory')
    expect(wholeCasesMigration).toContain('IF COALESCE(v_item.units_per_case_snapshot, 1) > 1 THEN')
    expect(wholeCasesMigration).toContain('v_qty := floor(v_qty::numeric / v_item.units_per_case_snapshot)::integer;')
    expect(wholeCasesMigration.indexOf('floor(v_qty::numeric')).toBeLessThan(
      wholeCasesMigration.indexOf('IF v_qty <= 0 OR v_item.variant_id IS NULL THEN'),
    )
    for (const rule of [
      'Return inventory can only be posted at/after Return Received',
      'inventory_cutoff_excluded_transactions',
      "AND sm.notes LIKE '%' || v_item.id::text || '%'",
      'public.resolve_operational_stock_config(v_item.variant_id)',
      "p_reference_type := 'return'",
      'p_organization_id := v_case.return_warehouse_id',
    ]) {
      expect(wholeCasesMigration).toContain(rule)
    }
  })

  it('restores the same S&A return guard after the whole-cases replacement', () => {
    const saModules = readFileSync(
      path.resolve(__dirname, '../../../../supabase/migrations/20260928120000_sa_final_modules_supply_chain.sql'),
      'utf8',
    )
    const guardOf = (sql: string) =>
      sql.match(/'public\.post_return_case_inventory\(uuid\)'::regprocedure, 'inventory\.return\.manage',\s*(\$g\$[\s\S]*?\$g\$)/)?.[1]
    expect(guardOf(wholeCasesMigration)).toBe(guardOf(saModules))
    expect(wholeCasesMigration.indexOf('sa_inject_operation_guard')).toBeGreaterThan(
      wholeCasesMigration.indexOf('CREATE OR REPLACE FUNCTION public.post_return_case_inventory'),
    )
  })
})
