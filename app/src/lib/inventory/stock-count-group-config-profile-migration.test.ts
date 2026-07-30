import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = fs.readFileSync(
  new URL('../../../../supabase/migrations/20260727_stock_count_group_config_profile.sql', import.meta.url),
  'utf8',
)

describe('group configuration profile migration', () => {
  it('adds an explicit, defaulted group profile column with a check constraint', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS stock_config_profile text')
    expect(migration).toContain("DEFAULT 'standard'")
    expect(migration).toContain("CHECK (stock_config_profile IN ('concentration', 'standard'))")
  })

  it('backfills concentration only for groups that genuinely used concentration configs', () => {
    expect(migration).toMatch(/UPDATE public\.product_groups[\s\S]*SET stock_config_profile = 'concentration'/)
    // Balance / movement / order reference are the data-driven signals.
    expect(migration).toContain('pi.quantity_on_hand <> 0')
    expect(migration).toContain('public.stock_movements sm')
    expect(migration).toContain('public.order_items oi')
  })

  it('installs a backend guard trigger rejecting concentration configs on standard groups', () => {
    expect(migration).toContain('assert_stock_config_group_eligibility')
    expect(migration).toContain('trg_stock_config_group_eligibility')
    expect(migration).toContain('BEFORE INSERT OR UPDATE')
    expect(migration).toMatch(/is not valid for a non-flavour product group/i)
  })

  it('never deletes configs, and never auto-runs the destructive deactivation', () => {
    expect(migration).not.toMatch(/DELETE\s+FROM\s+public\.inventory_stock_configurations/i)
    // Part C is documented-only: the deactivation must not run automatically,
    // because it depends on a heuristic profile that is environment-sensitive
    // (the 2026-07-27 production Cartridge incident).
    expect(migration).toContain('DO NOT AUTO-RUN')
    // Every deactivation UPDATE must be commented out (each such line starts with --).
    const activeDeactivation = migration
      .split('\n')
      .filter(line => /UPDATE public\.inventory_stock_configurations/.test(line))
      .filter(line => !line.trimStart().startsWith('--'))
    expect(activeDeactivation).toEqual([])
    // The reviewed manual template still documents the safe guards.
    expect(migration).toContain('explicit allowlist')
    expect(migration).toContain('quantity_on_hand <> 0')
  })

  it('documents the Unclassified -> Standard transfer without executing an inventory move', () => {
    expect(migration).toContain('DOCUMENTED ONLY')
    expect(migration).toContain('duplicating')
    expect(migration).toContain('device_unclassified_to_standard')
  })
})
