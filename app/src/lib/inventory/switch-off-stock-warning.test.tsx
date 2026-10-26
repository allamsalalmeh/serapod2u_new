import { describe, expect, it, vi } from 'vitest'
import { confirmSwitchOffWithStock, stockHeldByVariants, switchOffStockWarning } from './switch-off-stock-warning'

function supabaseWith(rows: any[] | null, error: any = null) {
  const builder: any = {
    select: vi.fn(() => builder),
    in: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    gt: vi.fn(() => builder),
    then: (resolve: (value: any) => unknown) => Promise.resolve({ data: rows, error }).then(resolve),
  }
  return { from: vi.fn(() => builder), builder }
}

describe('switch-off stock warning', () => {
  it('lists the stock per location, largest first', async () => {
    const { from } = supabaseWith([
      { quantity_on_hand: 80, organizations: { org_name: 'Serapod Warehouse Balakong' } },
      { quantity_on_hand: 402, organizations: { org_name: 'Serapod Technology Sdn Bhd' } },
    ])
    expect(await stockHeldByVariants({ from }, ['v1'])).toEqual([
      { warehouse: 'Serapod Technology Sdn Bhd', quantity: 402 },
      { warehouse: 'Serapod Warehouse Balakong', quantity: 80 },
    ])
  })

  it('explains where the stock is and how to fix it later', () => {
    const text = switchOffStockWarning('Camping Mat 200cmx200cm', [{ warehouse: 'Serapod Warehouse Balakong', quantity: 80 }])
    expect(text).toContain('Camping Mat 200cmx200cm still has stock:')
    expect(text).toContain('• Serapod Warehouse Balakong: 80')
    expect(text).toContain('switch it back on, then count or move it')
    expect(text).toContain('Switch it off anyway?')
  })

  it('does not ask when nothing is held, and lets the user cancel when stock is held', async () => {
    const ask = vi.fn(() => false)
    expect(await confirmSwitchOffWithStock(supabaseWith([]), 'X', ['v1'], ask)).toBe(true)
    expect(ask).not.toHaveBeenCalled()
    const held = supabaseWith([{ quantity_on_hand: 5, organizations: { org_name: 'WH' } }])
    expect(await confirmSwitchOffWithStock(held, 'X', ['v1'], ask)).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('never blocks switching off when stock cannot be read', async () => {
    const ask = vi.fn(() => false)
    expect(await confirmSwitchOffWithStock(supabaseWith(null, { message: 'denied' }), 'X', ['v1'], ask)).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })
})
