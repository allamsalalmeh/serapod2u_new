import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  STOCK_MOVEMENT_ACCESS_DENIED_MESSAGE,
  STOCK_MOVEMENT_REPORT_SOURCE,
  STOCK_MOVEMENT_RESTRICTED_COLUMNS,
  isStockMovementAccessDenied,
} from './stock-movement-access'

const repoPath = (path: string) => new URL(`../../../../${path}`, import.meta.url)
const repoFile = (path: string) => readFileSync(repoPath(path), 'utf8')

const migration = repoFile('supabase/migrations/20261107100000_sa_stock_movement_access.sql')
const superseded = repoFile('supabase/migrations/20261029100000_stock_movements_ordered_view_invoker.sql')
const report = repoFile('app/src/components/inventory/StockMovementReportView.tsx')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : []
  })
}

describe('stock movement access — migration lock-step', () => {
  it('revokes exactly the restricted columns from the table and keeps the rest readable', () => {
    expect(migration).toContain(
      `revoke select (${STOCK_MOVEMENT_RESTRICTED_COLUMNS.join(', ')}) on table public.stock_movements from anon, authenticated;`,
    )
    expect(migration).toContain('revoke select on table public.stock_movements from anon, authenticated;')
    expect(migration).toContain(
      `and a.attname not in (${STOCK_MOVEMENT_RESTRICTED_COLUMNS.map((c) => `'${c}'`).join(', ')});`,
    )
  })

  it('replaces the legacy staff/partner read rule with the inventory scope rule', () => {
    expect(migration).toContain('drop policy if exists stock_movements_view_all on public.stock_movements;')
    expect(migration).toMatch(
      /create policy stock_movements_inventory_read on public\.stock_movements for select to authenticated\s+using \(public\.sa_stock_movement_row_visible\(from_organization_id, to_organization_id, \(select public\.sa_stock_movement_scope\(\)\)\)\);/,
    )
  })

  it('keeps both movement views owner-run, filtered and masked (never security_invoker)', () => {
    for (const view of [STOCK_MOVEMENT_REPORT_SOURCE, 'v_stock_movements_display']) {
      expect(migration).toContain(`create or replace view public.${view} as`)
      expect(migration).toContain(`alter view public.${view} set (security_invoker = false, security_barrier = true);`)
      expect(migration).toContain(`grant select on table public.${view} to authenticated;`)
    }
    expect(migration.match(/(where|and) public\.sa_stock_movement_row_visible\(sm\.from_organization_id, sm\.to_organization_id/g)).toHaveLength(2)
    expect(migration.match(/then sm\.unit_cost end::numeric\(12,2\) as unit_cost/g)).toHaveLength(2)
    expect(migration.match(/then sm\.quantity_before \+ sm\.quantity_change end as quantity_after/g)).toHaveLength(2)
  })

  it('removes the role-level shortcut from the stock rule', () => {
    const rowRule = migration.slice(
      migration.indexOf('create or replace function public.sa_inventory_stock_row_visible'),
      migration.indexOf('revoke all on function public.sa_inventory_stock_row_visible'),
    )
    expect(rowRule).not.toContain('is_hq_admin')
    expect(rowRule).not.toContain('can_access_org')
  })

  it('leaves the superseded invoker draft as a no-op', () => {
    expect(superseded).not.toMatch(/security_invoker\s*=\s*true/i)
    expect(superseded).not.toMatch(/^\s*grant/im)
    expect(superseded).toContain('20261107100000_sa_stock_movement_access.sql')
  })
})

describe('stock movement access — application readers', () => {
  it('reads the report from the masked view only, with no base-table fallback', () => {
    expect(report).toContain('.from(STOCK_MOVEMENT_REPORT_SOURCE)')
    expect(report).not.toMatch(/tableName = 'stock_movements'/)
    expect(report).toContain('isStockMovementAccessDenied(error)')
    expect(report).not.toMatch(/from\('product_variants'\)\s*\.select\('[^']*base_cost/)
  })

  it('never selects a restricted column (or *) from the stock_movements table in browser or server code', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(repoPath('app/src').pathname)) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/\.from\(['"]stock_movements['"]\)\s*\.select\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g)) {
        const columns = match[1].slice(1, -1)
        const top = columns.replace(/\([^()]*(\([^()]*\))*[^()]*\)/g, '')
        if (/(^|[\s,])\*([\s,]|$)/.test(top) || STOCK_MOVEMENT_RESTRICTED_COLUMNS.some((c) => new RegExp(`\\b${c}\\b`).test(top))) {
          offenders.push(`${file.split('/app/src/')[1]}: ${columns.replace(/\s+/g, ' ').trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('classifies permission errors as access denied, not as an empty list', () => {
    expect(isStockMovementAccessDenied({ code: '42501', message: 'permission denied for view vw_stock_movements_ordered' })).toBe(true)
    expect(isStockMovementAccessDenied({ status: 403, message: '' })).toBe(true)
    expect(isStockMovementAccessDenied({ code: 'PGRST116', message: 'no rows' })).toBe(false)
    expect(isStockMovementAccessDenied(null)).toBe(false)
    expect(STOCK_MOVEMENT_ACCESS_DENIED_MESSAGE).toMatch(/permission/)
  })
})
