import { beforeEach, describe, expect, it, vi } from 'vitest'

const held = new Set<string>()
vi.mock('@/lib/security-access/operation', () => ({
  userAllowed: vi.fn(async (_user: string, permission: string) => held.has(permission)),
}))

import { SC_TOOL_PERMISSIONS, executeAuthorizedSCTool, type SCToolName } from './tools-supply-chain'
import { INVENTORY_STOCK_READ_PERMISSIONS } from '@/lib/security-access/inventory-stock'

/** A service client that records every table it is asked for and returns no rows. */
function recordingClient() {
  const tables: string[] = []
  const chain: any = new Proxy({}, {
    get: (_t, prop) => (prop === 'then' ? (resolve: any) => resolve({ data: [], count: 0, error: null }) : () => chain),
  })
  return { tables, client: { from: (t: string) => { tables.push(t); return chain } } as any }
}
const actor = { userId: 'u1', organizationId: 'o1' }

beforeEach(() => held.clear())

describe('Supply Chain assistant tools decide through Security & Access', () => {
  it('every tool has a permission list', () => {
    const tools = Object.keys(SC_TOOL_PERMISSIONS) as SCToolName[]
    expect(tools.length).toBe(17)
    for (const tool of tools) expect(SC_TOOL_PERMISSIONS[tool].length, tool).toBeGreaterThan(0)
  })
  it('stock figures need the database stock read permissions; order approval never reads them', () => {
    for (const tool of ['inventorySummary', 'lowStockItems', 'warehouseList'] as SCToolName[]) {
      expect(SC_TOOL_PERMISSIONS[tool], tool).toEqual(INVENTORY_STOCK_READ_PERMISSIONS)
      expect(SC_TOOL_PERMISSIONS[tool], tool).not.toContain('supply_chain.order.approve')
    }
    expect(SC_TOOL_PERMISSIONS.stockMovements).toEqual(['inventory.report.view'])
  })
  it('without a grant: a refusal answer and no query at all', async () => {
    const { tables, client } = recordingClient()
    const result = await executeAuthorizedSCTool('inventorySummary', client, 'o1', actor)
    expect(result.success).toBe(true)
    expect(result.rows).toBeUndefined()
    expect(result.summary).toMatch(/do not have access/)
    expect(tables).toEqual([])
  })
  it('Order Approver only: orders yes, inventory no', async () => {
    held.add('supply_chain.order.approve')
    const orders = recordingClient()
    await executeAuthorizedSCTool('pendingOrders', orders.client, 'o1', actor)
    expect(orders.tables.length).toBeGreaterThan(0)
    const stock = recordingClient()
    await executeAuthorizedSCTool('lowStockItems', stock.client, 'o1', actor)
    expect(stock.tables).toEqual([])
  })
  it('Inventory Viewer: inventory tools run', async () => {
    held.add('inventory.stock.view')
    const { tables, client } = recordingClient()
    await executeAuthorizedSCTool('lowStockItems', client, 'o1', actor)
    expect(tables).toContain('v_low_stock_alerts')
  })
})
