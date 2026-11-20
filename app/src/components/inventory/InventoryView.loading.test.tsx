// @vitest-environment jsdom
import { StrictMode } from 'react'
import userEvent from '@testing-library/user-event'
import { act, cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ calls: [] as { table: string; start: number; end?: number }[], fail: '', delay: 20, balanceDelay: 20, user: 'u1', empty: false, balance: 12, listeners: [] as (() => void)[] }))
const balance = () => ({ id: 'i1', variant_id: 'v1', organization_id: 'wh1', product_name: 'Cellera Hero', variant_name: 'Banana', variant_code: 'BV', stock_config_id: 'c1', config_label: '20ml New Box', default_for_ord: true, quantity_on_hand: state.balance, pcs_on_hand: 2, pcs_per_case: 4, quantity_allocated: 3, quantity_available: state.balance - 3, reorder_point: 5, unit_cost: 10 })
const client = { from(table: string) {
  const q: any = new Proxy({}, { get(_, key) {
    if (key === 'then') return (resolve: any, reject: any) => {
      const call = { table, start: performance.now(), end: 0 }; state.calls.push(call)
      return new Promise(r => setTimeout(() => {
        call.end = performance.now()
        r({ data: table === 'vw_inventory_on_hand' ? (state.empty ? [] : [balance()]) : table === 'product_variants' ? [{ id: 'v1', base_cost: 10 }] : table === 'organizations' ? [{ id: 'wh1', org_name: 'Warehouse A', org_type_code: 'WH', is_active: true }, { id: 'wh2', org_name: 'Warehouse B', org_type_code: 'WH', is_active: true }] : [], error: state.fail === table ? { message: 'permission denied', code: '42501' } : null })
      }, table === 'vw_inventory_on_hand' ? state.balanceDelay : state.delay)).then(resolve, reject)
    }
    return () => q
  } }); return q
} }
vi.mock('@/lib/hooks/useSupabaseAuth', () => ({ useSupabaseAuth: () => ({ isReady: true, supabase: client, user: { id: state.user } }) }))
vi.mock('@/hooks/usePermissions', () => ({ usePermissions: () => ({ hasPermission: () => true }) }))
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('@/lib/inventory/inventory-data-refresh', () => ({ subscribeToInventoryDataRefresh: (fn: () => void) => { state.listeners.push(fn); return () => { state.listeners = state.listeners.filter(x => x !== fn) } } }))
vi.mock('./ProductThumbnail', () => ({ default: () => null }))
vi.mock('./StockSettingsPanel', () => ({ default: () => null }))
vi.mock('./IncomingStockDialog', () => ({ default: () => null }))
vi.mock('./ReservedStockDialog', () => ({ default: () => null }))
import InventoryView from './InventoryView'
const props = { userProfile: { roles: { role_level: 10 }, organizations: { org_type_code: 'HQ' } } }
beforeEach(() => { state.calls = []; state.fail = ''; state.delay = 20; state.balanceDelay = 20; state.user = 'u1'; state.empty = false; state.balance = 12; state.listeners = [] })
afterEach(cleanup)

it('records comparable component load samples with real delayed request boundaries', async () => {
  for (let i = 0; i < 3; i++) {
    state.calls = []
    const started = performance.now()
    const view = render(<InventoryView {...props} />)
    await screen.findByText(/1 flavour summary found/)
    console.log('INVENTORY_COMPONENT_SAMPLE', JSON.stringify({ sample: i + 1, ms: Math.round(performance.now() - started), requests: state.calls.length, calls: state.calls.map(x => ({ table: x.table, start: Math.round(x.start - started), end: Math.round((x.end || 0) - started) })) }))
    view.unmount()
  }
})

it('uses skeletons until a complete response, and does not eagerly load either detail source', async () => {
  render(<InventoryView {...props} />)
  expect(screen.queryByText('No items to display')).toBeNull()
  expect(screen.getByLabelText('Loading inventory value')).toBeTruthy()
  expect(screen.getAllByLabelText('Loading inventory row')).toHaveLength(6)
  await screen.findByText(/1 flavour summary found/)
  expect(document.querySelector('.sera-sc-kpi__value')?.textContent).toBe('RM 125.00')
  expect(state.calls.map(x => x.table).sort()).toEqual(['organizations', 'product_variants', 'stock_movements', 'v_incoming_stock', 'vw_inventory_on_hand'].sort())
  const metadata = state.calls.find(x => x.table === 'product_variants')!
  const warranty = state.calls.find(x => x.table === 'stock_movements')!
  expect(warranty.start).toBeLessThan(metadata.end!)
})

it('reports permission failures with retry instead of an empty balance', async () => {
  state.fail = 'vw_inventory_on_hand'
  render(<InventoryView {...props} />)
  await screen.findByRole('alert')
  expect(screen.queryByText('No inventory items found')).toBeNull()
  expect(state.calls.some(x => x.table === 'product_inventory')).toBe(false)
  state.fail = ''
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText(/1 flavour summary found/)
})

it('retains current data during refresh and on refresh error, explicitly marked outdated', async () => {
  render(<InventoryView {...props} />)
  await waitFor(() => expect(document.querySelector('.sera-sc-kpi__value')?.textContent).toBe('RM 125.00'))
  state.fail = 'stock_movements'
  act(() => state.listeners.forEach(fn => fn()))
  expect(document.querySelector('.sera-sc-kpi__value')?.textContent).toBe('RM 125.00')
  expect(screen.getByText('Updating inventory…')).toBeTruthy()
  await screen.findByRole('alert')
  expect(document.querySelector('.sera-sc-kpi__value')?.textContent).toBe('RM 125.00')
  expect(screen.getByRole('alert').textContent).toContain('outdated')
})

it('does not allow a superseded refresh to clear loading or publish old results', async () => {
  render(<InventoryView {...props} />)
  await waitFor(() => expect(document.querySelector('.sera-sc-kpi__value')?.textContent).toBe('RM 125.00'))
  state.balanceDelay = 100
  act(() => state.listeners.forEach(fn => fn()))
  state.balanceDelay = 10
  state.balance = 25
  act(() => state.listeners.forEach(fn => fn()))
  await waitFor(() => expect(document.querySelector('.sera-sc-kpi__value')?.textContent).toBe('RM 255.00'))
  state.balance = 99
  await act(async () => { await new Promise(r => setTimeout(r, 150)) })
  expect(document.querySelector('.sera-sc-kpi__value')?.textContent).toBe('RM 255.00')
  expect(screen.queryByText('RM 995.00')).toBeNull()
})

it('renders an empty state only after a successful empty read', async () => {
  state.empty = true
  render(<InventoryView {...props} />)
  expect(screen.queryByText('No inventory items found')).toBeNull()
  await screen.findByText('No inventory items found')
  expect(screen.queryByRole('alert')).toBeNull()
})
it('does not issue reads for a signed-out viewer', async () => {
  state.user = ''
  render(<InventoryView {...props} />)
  await act(async () => { await new Promise(r => setTimeout(r, 50)) })
  expect(state.calls).toHaveLength(0)
})
it('does not duplicate reads during StrictMode effect replay', async () => {
  render(<StrictMode><InventoryView {...props} /></StrictMode>)
  await screen.findByText(/1 flavour summary found/)
  expect(state.calls).toHaveLength(5)
})
it('keeps a newly selected location scoped correctly when a refresh resolves', async () => {
  // Radix uses these browser APIs for its accessible select popup.
  HTMLElement.prototype.scrollIntoView = vi.fn()
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.releasePointerCapture = vi.fn()
  const user = userEvent.setup()
  render(<InventoryView {...props} />)
  await screen.findByText(/1 flavour summary found/)
  state.balanceDelay = 100
  act(() => state.listeners.forEach(fn => fn()))
  await user.click(screen.getAllByRole('combobox')[0])
  await user.click(screen.getByRole('option', { name: 'Warehouse B' }))
  await screen.findByText('No inventory items found')
  expect(document.querySelector('.sera-sc-kpi__value')?.textContent).toBe('RM 0.00')
  await waitFor(() => expect(screen.queryByText('Updating inventory…')).toBeNull())
  expect(screen.getByText('No inventory items found')).toBeTruthy()
  expect(state.calls.filter(x => x.table === 'vw_inventory_on_hand')).toHaveLength(2)
})

it('does not present balances as complete when Incoming fails', async () => {
  state.fail = 'v_incoming_stock'
  render(<InventoryView {...props} />)
  await screen.findByRole('alert')
  expect(screen.queryByText(/1 flavour summary found/)).toBeNull()
  expect(screen.queryByText('No inventory items found')).toBeNull()
  expect(screen.getByLabelText('Loading inventory value')).toBeTruthy()
})
it('hides the prior viewer snapshot when the authenticated viewer changes', async () => {
  const view = render(<InventoryView {...props} />)
  await screen.findByText(/1 flavour summary found/)
  state.user = 'u2'
  state.fail = 'vw_inventory_on_hand'
  view.rerender(<InventoryView {...props} />)
  expect(screen.getByLabelText('Loading inventory value')).toBeTruthy()
  await screen.findByRole('alert')
  expect(screen.queryByText(/1 flavour summary found/)).toBeNull()
})
