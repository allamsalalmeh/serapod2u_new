// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import EditOrganizationView from './EditOrganizationView'

const M1 = '10000000-0000-0000-0000-000000000001'
const HQ = '10000000-0000-0000-0000-0000000000aa'
const VAPE = '20000000-0000-0000-0000-000000000001'
const OUTDOOR = '20000000-0000-0000-0000-000000000003'

const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }))

let organization: Record<string, any>
let summaryRow: Record<string, any>
const updates: Record<string, any>[] = []

/** Minimal chainable PostgREST stand-in: every filter returns the builder, awaiting resolves the table's rows. */
function builder(table: string) {
  const state = { single: false, update: null as Record<string, any> | null }
  const query: Record<string, any> = {}
  for (const method of ['select', 'eq', 'neq', 'in', 'or', 'not', 'order', 'limit', 'range', 'is']) {
    query[method] = vi.fn(() => query)
  }
  query.update = vi.fn((payload: Record<string, any>) => {
    state.update = payload
    updates.push(payload)
    return query
  })
  query.single = vi.fn(() => ((state.single = true), query))
  query.maybeSingle = query.single
  query.then = (resolve: (value: unknown) => void) => {
    let data: any = []
    if (table === 'organizations') {
      if (state.update) organization = { ...organization, ...state.update }
      data = state.single ? organization : [organization, { id: HQ, org_code: 'HQ01', org_name: 'HQ', org_type_code: 'HQ', is_active: true }]
    } else if (table === 'product_categories') {
      data = [
        { id: OUTDOOR, category_name: 'Outdoor', is_active: true },
        { id: VAPE, category_name: 'Vape', is_active: true },
      ]
    } else if (state.single) {
      data = null
    }
    resolve({ data, error: null })
  }
  return query
}

const rpc = vi.fn(async (name: string, args: Record<string, any>) => {
  if (name === 'manufacturer_category_summary') return { data: [summaryRow], error: null }
  if (name === 'set_manufacturer_product_categories') {
    summaryRow = {
      ...summaryRow,
      assigned: args.p_category_ids.map((id: string) => ({ category_id: id, category_name: id === VAPE ? 'Vape' : 'Outdoor', is_active: true })),
    }
    return { data: args.p_category_ids, error: null }
  }
  return { data: null, error: null }
})

const supabase = { from: vi.fn((table: string) => builder(table)), rpc, storage: { from: vi.fn() } }
vi.mock('@/lib/hooks/useSupabaseAuth', () => ({ useSupabaseAuth: () => ({ isReady: true, supabase, error: null }) }))

function setup(assigned: string[], derived: Array<{ id: string; name: string; count: number }>) {
  organization = { id: M1, org_code: 'MFG001', org_name: 'Acme Manufacturing', org_type_code: 'MFG', parent_org_id: HQ, is_active: true, logo_url: null }
  summaryRow = {
    manufacturer_id: M1,
    assigned: assigned.map((id) => ({ category_id: id, category_name: id === VAPE ? 'Vape' : 'Outdoor', is_active: true })),
    derived: derived.map((d) => ({ category_id: d.id, category_name: d.name, is_active: true, product_count: d.count })),
    product_count: derived.reduce((total, d) => total + d.count, 0),
    uncategorized_product_count: 0,
  }
  sessionStorage.setItem('selectedOrgId', M1)
  const onViewChange = vi.fn()
  render(<EditOrganizationView userProfile={{ id: 'u1', organization_id: HQ }} onViewChange={onViewChange} />)
  return { onViewChange }
}

const setCalls = () => rpc.mock.calls.filter(([name]) => name === 'set_manufacturer_product_categories')

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  updates.length = 0
  vi.clearAllMocks()
})

describe('Edit Organization — manufacturer product categories', () => {
  it('saves unrelated edits of an unclassified manufacturer without forcing categories', async () => {
    const { onViewChange } = setup([], [])
    await screen.findByText('Not classified')
    expect(screen.getByText('No linked products yet')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: /Save Changes/ })[0])
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(setCalls()).toHaveLength(0)
    await waitFor(() => expect(onViewChange).toHaveBeenCalledWith('organizations'))
  })

  it('confirms a suggested category from linked products and saves the assignment atomically', async () => {
    setup([VAPE], [{ id: VAPE, name: 'Vape', count: 4 }, { id: OUTDOOR, name: 'Outdoor', count: 1 }])
    await screen.findByText('1 linked product uses other categories')
    fireEvent.click(screen.getByRole('button', { name: 'Assign Outdoor' }))
    fireEvent.click(screen.getAllByRole('button', { name: /Save Changes/ })[0])
    await waitFor(() => expect(setCalls()).toHaveLength(1))
    expect(setCalls()[0][1]).toEqual({ p_manufacturer_id: M1, p_category_ids: [VAPE, OUTDOOR] })
    expect(updates).toHaveLength(1)
  })

  it('does not call the category RPC on an unchanged save of a classified manufacturer', async () => {
    setup([VAPE], [{ id: VAPE, name: 'Vape', count: 2 }])
    await screen.findByText('Found in 2 linked products')
    fireEvent.click(screen.getAllByRole('button', { name: /Save Changes/ })[0])
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(setCalls()).toHaveLength(0)
  })

  it('blocks clearing every category before anything is saved', async () => {
    setup([VAPE], [])
    await screen.findByText('No linked products yet')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Vape' }))
    fireEvent.click(screen.getAllByRole('button', { name: /Save Changes/ })[0])
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Check product categories' })))
    expect(updates).toHaveLength(0)
    expect(setCalls()).toHaveLength(0)
  })

  it('keeps the admin on the page when the category save is refused', async () => {
    const { onViewChange } = setup([], [{ id: VAPE, name: 'Vape', count: 1 }])
    await screen.findByText('Not classified')
    rpc.mockImplementationOnce(async () => ({ data: null, error: { code: '42501', message: 'denied' } }) as any)
    fireEvent.click(screen.getByRole('button', { name: 'Assign Vape' }))
    fireEvent.click(screen.getAllByRole('button', { name: /Save Changes/ })[0])
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Product categories not saved' })))
    expect(screen.getAllByRole('alert').some((node) => /permission/.test(node.textContent || ''))).toBe(true)
    expect(onViewChange).not.toHaveBeenCalledWith('organizations')
  })
})
