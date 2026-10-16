// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ManufacturerCategoryField from '@/components/organizations/ManufacturerCategoryField'
import ManufacturerCategoryBadges from '@/components/organizations/ManufacturerCategoryBadges'
import {
  categoriesOutsideClassification,
  diffCategorySelection,
  loadManufacturerCategorySummaries,
  manufacturerProductsHref,
  matchesManufacturerCategoryFilter,
  saveManufacturerCategories,
  suggestedCategories,
  validateManufacturerCategories,
  type CategoryOption,
  type ManufacturerCategorySummary,
} from './manufacturer-categories'

const VAPE = '20000000-0000-0000-0000-000000000001'
const PET = '20000000-0000-0000-0000-000000000002'
const OUTDOOR = '20000000-0000-0000-0000-000000000003'
const LEGACY = '20000000-0000-0000-0000-000000000004'
const HIDDEN = '20000000-0000-0000-0000-000000000005'
const M1 = '10000000-0000-0000-0000-000000000001'

const options: CategoryOption[] = [
  { id: OUTDOOR, category_name: 'Outdoor', is_active: true },
  { id: PET, category_name: 'Pet Food', is_active: true },
  { id: VAPE, category_name: 'Vape', is_active: true },
  { id: LEGACY, category_name: 'Legacy', is_active: false },
]

const summary = (overrides: Partial<ManufacturerCategorySummary> = {}): ManufacturerCategorySummary => ({
  manufacturer_id: M1,
  assigned: [],
  derived: [],
  product_count: 0,
  uncategorized_product_count: 0,
  ...overrides,
})

afterEach(() => cleanup())

describe('validateManufacturerCategories', () => {
  it('requires at least one category for a new manufacturer', () => {
    expect(validateManufacturerCategories({ mode: 'create', saved: [], selected: [], options })).toMatch(/at least one/)
    expect(validateManufacturerCategories({ mode: 'create', saved: [], selected: [VAPE], options })).toBeNull()
    expect(validateManufacturerCategories({ mode: 'create', saved: [], selected: [VAPE, PET, OUTDOOR], options })).toBeNull()
  })

  it('lets an existing unclassified manufacturer stay unclassified but not clear a classification', () => {
    expect(validateManufacturerCategories({ mode: 'edit', saved: [], selected: [], options })).toBeNull()
    expect(validateManufacturerCategories({ mode: 'edit', saved: [VAPE], selected: [], options })).toMatch(/Keep at least one/)
  })

  it('keeps an already-assigned inactive category but refuses to newly assign one', () => {
    expect(validateManufacturerCategories({ mode: 'edit', saved: [LEGACY], selected: [LEGACY, VAPE], options })).toBeNull()
    expect(validateManufacturerCategories({ mode: 'edit', saved: [VAPE], selected: [VAPE, LEGACY], options })).toBe(
      'Legacy is inactive and cannot be newly assigned.',
    )
    expect(validateManufacturerCategories({ mode: 'create', saved: [], selected: ['missing'], options })).toMatch(/no longer exist/)
  })
})

describe('selection helpers', () => {
  it('diffs selections and treats a reordered set as unchanged', () => {
    expect(diffCategorySelection([VAPE, PET], [PET, VAPE]).changed).toBe(false)
    expect(diffCategorySelection([VAPE], [PET])).toEqual({ add: [PET], remove: [VAPE], changed: true })
  })

  it('reports linked-product categories outside the classification and suggests only active ones', () => {
    const derived = [
      { category_id: OUTDOOR, category_name: 'Outdoor', is_active: true, product_count: 2 },
      { category_id: VAPE, category_name: 'Vape', is_active: true, product_count: 4 },
      { category_id: LEGACY, category_name: 'Legacy', is_active: false, product_count: 1 },
    ]
    expect(categoriesOutsideClassification([VAPE], derived).map((c) => c.category_id)).toEqual([OUTDOOR, LEGACY])
    expect(suggestedCategories([VAPE], derived).map((c) => c.category_id)).toEqual([OUTDOOR])
  })

  it('builds the Product List deep link with the manufacturer id', () => {
    expect(manufacturerProductsHref(M1)).toBe(`/supply-chain/products?manufacturer=${M1}`)
  })

  it('filters the organization list by assigned category, Not classified, or not at all', () => {
    const summaries = new Map([
      [M1, summary({ assigned: [{ category_id: VAPE, category_name: 'Vape', is_active: true }] })],
      ['m2', summary({ manufacturer_id: 'm2' })],
    ])
    const m1 = { id: M1, org_type_code: 'MFG' }
    const m2 = { id: 'm2', org_type_code: 'MFG' }
    const dist = { id: 'd1', org_type_code: 'DIST' }
    expect(matchesManufacturerCategoryFilter(dist, 'all', summaries)).toBe(true)
    expect(matchesManufacturerCategoryFilter(m1, VAPE, summaries)).toBe(true)
    expect(matchesManufacturerCategoryFilter(m2, VAPE, summaries)).toBe(false)
    expect(matchesManufacturerCategoryFilter(m2, 'unclassified', summaries)).toBe(true)
    expect(matchesManufacturerCategoryFilter(m1, 'unclassified', summaries)).toBe(false)
    expect(matchesManufacturerCategoryFilter(dist, 'unclassified', summaries)).toBe(false)
    expect(matchesManufacturerCategoryFilter(m1, VAPE, null)).toBe(false)
  })
})

describe('server calls', () => {
  it('loads one aggregated summary row per manufacturer through the RPC and dedupes ids', async () => {
    const rpc = vi.fn(async () => ({
      data: [{ manufacturer_id: M1, assigned: [], derived: [{ category_id: VAPE, category_name: 'Vape', is_active: true, product_count: '3' }], product_count: '3', uncategorized_product_count: 0 }],
      error: null,
    }))
    const result = await loadManufacturerCategorySummaries({ rpc }, [M1, M1, ''])
    expect(rpc).toHaveBeenCalledWith('manufacturer_category_summary', { p_manufacturer_ids: [M1] })
    expect(result?.get(M1)?.product_count).toBe(3)
    expect(result?.get(M1)?.derived[0].product_count).toBe(3)
  })

  it('returns null instead of throwing when the summary cannot be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const rpc = vi.fn(async () => ({ data: null, error: { code: 'PGRST202', message: 'not found' } }))
    expect(await loadManufacturerCategorySummaries({ rpc }, [M1])).toBeNull()
  })

  it('saves through the atomic RPC and translates permission errors', async () => {
    const ok = vi.fn(async () => ({ data: [VAPE], error: null }))
    await expect(saveManufacturerCategories({ rpc: ok }, M1, [VAPE])).resolves.toEqual([VAPE])
    expect(ok).toHaveBeenCalledWith('set_manufacturer_product_categories', { p_manufacturer_id: M1, p_category_ids: [VAPE] })

    const denied = vi.fn(async () => ({ data: null, error: { code: '42501', message: 'nope' } }))
    await expect(saveManufacturerCategories({ rpc: denied }, M1, [VAPE])).rejects.toThrow(/permission/)
  })
})

describe('ManufacturerCategoryField', () => {
  it('marks the field required on create and offers only active categories', () => {
    render(<ManufacturerCategoryField mode="create" options={options} savedIds={[]} value={[]} onChange={() => {}} />)
    expect(screen.getByText('Product Categories *')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Product Categories/ }))
    expect(screen.getByText('Vape')).toBeTruthy()
    expect(screen.queryByText('Legacy')).toBeNull()
    expect(screen.queryByText('Not classified')).toBeNull()
  })

  it('selects several categories from the picker', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <ManufacturerCategoryField mode="create" options={options} savedIds={[]} value={[]} onChange={onChange} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^Product Categories/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Vape' }))
    expect(onChange).toHaveBeenLastCalledWith([VAPE])
    rerender(<ManufacturerCategoryField mode="create" options={options} savedIds={[]} value={[VAPE]} onChange={onChange} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pet Food' }))
    expect(onChange).toHaveBeenLastCalledWith([VAPE, PET])
  })

  it('shows an existing unclassified manufacturer with no linked products', () => {
    render(
      <ManufacturerCategoryField mode="edit" options={options} savedIds={[]} value={[]} onChange={() => {}} summary={summary()} manufacturerId={M1} />,
    )
    expect(screen.getByText('Not classified')).toBeTruthy()
    expect(screen.getByText('No linked products yet')).toBeTruthy()
    expect(screen.queryByText(/Suggested/)).toBeNull()
  })

  it('suggests derived categories for confirmation without assigning them', () => {
    const onChange = vi.fn()
    render(
      <ManufacturerCategoryField
        mode="edit"
        options={options}
        savedIds={[]}
        value={[]}
        onChange={onChange}
        manufacturerId={M1}
        summary={summary({
          product_count: 6,
          uncategorized_product_count: 1,
          derived: [
            { category_id: OUTDOOR, category_name: 'Outdoor', is_active: true, product_count: 1 },
            { category_id: VAPE, category_name: 'Vape', is_active: true, product_count: 4 },
          ],
        })}
      />,
    )
    expect(screen.getByText(/Found in 6 linked products · 1 without a category/)).toBeTruthy()
    expect(screen.getByText('Vape (4)')).toBeTruthy()
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Assign Vape' }))
    expect(onChange).toHaveBeenCalledWith([VAPE])
    expect(screen.getByRole('link', { name: /View products/ }).getAttribute('href')).toBe(manufacturerProductsHref(M1))
  })

  it('shows a concise mismatch and keeps inactive and hidden assigned categories with an accurate status', () => {
    render(
      <ManufacturerCategoryField
        mode="edit"
        options={options}
        savedIds={[VAPE, LEGACY, HIDDEN]}
        value={[VAPE, LEGACY, HIDDEN]}
        onChange={() => {}}
        manufacturerId={M1}
        summary={summary({
          assigned: [
            { category_id: VAPE, category_name: 'Vape', is_active: true },
            { category_id: LEGACY, category_name: 'Legacy', is_active: false },
            { category_id: HIDDEN, category_name: null, is_active: null },
          ],
          product_count: 3,
          derived: [
            { category_id: OUTDOOR, category_name: 'Outdoor', is_active: true, product_count: 2 },
            { category_id: VAPE, category_name: 'Vape', is_active: true, product_count: 1 },
          ],
        })}
      />,
    )
    expect(screen.queryByText('Not classified')).toBeNull()
    expect(screen.getByText('2 linked products use other categories')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'About the category mismatch' })).toBeTruthy()
    const selected = screen.getByLabelText('Selected product categories')
    expect(selected.textContent).toContain('Legacy· Inactive')
    expect(selected.textContent).toContain('Unavailable category· Inactive')
    // Inactive Legacy is still offered (it is assigned) so it can be kept or removed.
    const trigger = screen.getByRole('button', { name: /^Product Categories/ })
    expect(trigger.textContent).toContain('3 selected')
    fireEvent.click(trigger)
    expect(screen.getByRole('checkbox', { name: /Legacy/ })).toBeTruthy()
  })

  it('is read-only when linked data cannot be read', () => {
    render(
      <ManufacturerCategoryField mode="edit" options={options} savedIds={[]} value={[]} onChange={() => {}} summary={null} disabled />,
    )
    expect(screen.getByText('Linked products could not be read.')).toBeTruthy()
    expect((screen.getByRole('button', { name: /^Product Categories/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ManufacturerCategoryBadges', () => {
  it('shows assigned badges, linked-product count and the View products link', () => {
    render(
      <ManufacturerCategoryBadges
        manufacturerId={M1}
        showProductsLink
        summary={summary({
          assigned: [{ category_id: VAPE, category_name: 'Vape', is_active: true }],
          product_count: 5,
          derived: [
            { category_id: VAPE, category_name: 'Vape', is_active: true, product_count: 4 },
            { category_id: OUTDOOR, category_name: 'Outdoor', is_active: true, product_count: 1 },
          ],
        })}
      />,
    )
    expect(screen.getByText('Vape')).toBeTruthy()
    expect(screen.getByText('5 linked products')).toBeTruthy()
    expect(screen.getByText('· Also in products: Outdoor')).toBeTruthy()
    expect(screen.getByRole('link', { name: /View products/ }).getAttribute('href')).toBe(manufacturerProductsHref(M1))
  })

  it('shows Not classified with derived categories for an unclassified manufacturer', () => {
    render(
      <ManufacturerCategoryBadges
        manufacturerId={M1}
        summary={summary({ product_count: 1, derived: [{ category_id: PET, category_name: 'Pet Food', is_active: true, product_count: 1 }] })}
      />,
    )
    expect(screen.getByText('Not classified')).toBeTruthy()
    expect(screen.getByText('· Found in products: Pet Food')).toBeTruthy()
  })
})
