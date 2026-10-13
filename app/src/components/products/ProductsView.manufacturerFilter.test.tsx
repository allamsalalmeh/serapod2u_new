// @vitest-environment jsdom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ProductsView from './ProductsView'

const M1 = '10000000-0000-0000-0000-000000000001'
let search = ''
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(search) }))

const productQueries: Array<Record<string, any>> = []
function queryResult(table: string) {
  const query: Record<string, any> = {}
  for (const method of ['select', 'order', 'eq', 'in', 'or', 'not', 'range', 'maybeSingle']) {
    query[method] = vi.fn(() => query)
  }
  if (table === 'products') productQueries.push(query)
  query.then = (resolve: (value: unknown) => void) => resolve({ data: [], error: null })
  return query
}
const supabase = { from: vi.fn((table: string) => queryResult(table)) }
vi.mock('@/lib/hooks/useSupabaseAuth', () => ({ useSupabaseAuth: () => ({ isReady: true, supabase }) }))

afterEach(() => {
  cleanup()
  productQueries.length = 0
  vi.clearAllMocks()
})

const filteredByManufacturer = (id: string) =>
  productQueries.some((query) => query.eq.mock.calls.some(([column, value]: [string, string]) => column === 'manufacturer_id' && value === id))

describe('Product List manufacturer deep link', () => {
  it('filters products server-side by ?manufacturer=<id> from the first request', async () => {
    search = `manufacturer=${M1}`
    render(<ProductsView userProfile={{ organizations: { org_type_code: 'HQ' } }} />)
    await waitFor(() => expect(productQueries.length).toBeGreaterThan(0))
    expect(productQueries.every((query) => query.eq.mock.calls.some(([c, v]: [string, string]) => c === 'manufacturer_id' && v === M1))).toBe(true)
    expect(productQueries[0].range).toHaveBeenCalledWith(0, 9)
  })

  it('ignores a malformed manufacturer parameter', async () => {
    search = 'manufacturer=not-a-uuid'
    render(<ProductsView userProfile={{ organizations: { org_type_code: 'HQ' } }} />)
    await waitFor(() => expect(productQueries.length).toBeGreaterThan(0))
    expect(filteredByManufacturer('not-a-uuid')).toBe(false)
  })
})
