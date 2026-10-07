import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }))

import { diffCategorySelection } from './ManufacturerCategoriesCard'

const sql = fs.readFileSync(
  path.resolve(__dirname, '../../../../supabase/migrations/20261005150000_manufacturer_product_categories.sql'),
  'utf8',
).toLowerCase()

describe('manufacturer product categories', () => {
  it('saves only what changed', () => {
    expect(diffCategorySelection(['a', 'b'], ['b', 'c'])).toEqual({ add: ['c'], remove: ['a'] })
    expect(diffCategorySelection(['a'], ['a'])).toEqual({ add: [], remove: [] })
  })

  it('lets one manufacturer have several categories, each once', () => {
    expect(sql).toContain('unique (manufacturer_id, category_id)')
    expect(sql).toContain("o.org_type_code = 'mfg'")
  })

  it('gates writes like managing the manufacturer and leaves existing tables alone', () => {
    expect(sql).toContain('alter table public.manufacturer_product_categories enable row level security')
    expect(sql).toContain("sa_rls_gate('platform.organization.manage', manufacturer_id")
    expect(sql).not.toMatch(/grant[^;]*update[^;]*manufacturer_product_categories to authenticated/)
    expect(sql).not.toMatch(/alter table public\.(products|product_categories|organizations)\b/)
  })
})
