// @vitest-environment jsdom

import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  INVENTORY_DATA_REFRESH_EVENT,
  broadcastInventoryDataRefresh,
  subscribeToInventoryDataRefresh,
} from './inventory-data-refresh'

describe('committed-inventory refresh broadcast', () => {
  const unsubscribers: Array<() => void> = []
  afterEach(() => {
    while (unsubscribers.length) unsubscribers.pop()?.()
  })

  const listen = (handler: (detail: unknown) => void) => {
    const off = subscribeToInventoryDataRefresh(handler)
    unsubscribers.push(off)
    return off
  }

  it('delivers the reason and the correlating ids to every subscriber', () => {
    const a = vi.fn()
    const b = vi.fn()
    listen(a)
    listen(b)
    broadcastInventoryDataRefresh({
      reason: 'opening_balance_posted',
      warehouseOrganizationId: 'wh-1',
      referenceId: 'sess-1',
    })
    for (const spy of [a, b]) {
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith({
        reason: 'opening_balance_posted',
        warehouseOrganizationId: 'wh-1',
        referenceId: 'sess-1',
      })
    }
  })

  it('fires exactly once per broadcast — this is invalidation, not polling', () => {
    vi.useFakeTimers()
    try {
      const spy = vi.fn()
      listen(spy)
      broadcastInventoryDataRefresh({ reason: 'opening_balance_posted' })
      expect(spy).toHaveBeenCalledTimes(1)
      // No timer of any kind re-fires the handler.
      vi.advanceTimersByTime(60_000)
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops delivering after unsubscribe', () => {
    const spy = vi.fn()
    const off = listen(spy)
    off()
    broadcastInventoryDataRefresh({ reason: 'opening_balance_posted' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('uses a single namespaced event name', () => {
    expect(INVENTORY_DATA_REFRESH_EVENT).toBe('serapod:inventory-data-refresh')
  })
})

describe('inventory readers subscribe to the authoritative refresh', () => {
  const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
  const inventoryView = read('../../components/inventory/InventoryView.tsx')
  const movementView = read('../../components/inventory/StockMovementReportView.tsx')
  const cutoffSection = read('../../components/inventory/InventoryOpeningCutoffSection.tsx')

  it('View Inventory refetches inventory and incoming on the signal', () => {
    expect(inventoryView).toContain('subscribeToInventoryDataRefresh')
    const block = inventoryView.slice(inventoryView.indexOf('subscribeToInventoryDataRefresh(() => {'))
    expect(block.slice(0, 200)).toContain('fetchInventory()')
    // Incoming is now read and published by the same versioned load as balances.
    // A separate fetchIncoming would duplicate requests and bypass atomic publication.
    const load = inventoryView.slice(inventoryView.indexOf('const fetchInventory = async () => {'))
    expect(load).toContain("supabase.from('v_incoming_stock' as any)")
    expect(load).toContain('const incoming = await incomingResult')
    expect(load).toContain('setIncomingMap(buildIncomingMap(')
  })

  it('Movement Reports reloads movements on the signal', () => {
    expect(movementView).toContain('subscribeToInventoryDataRefresh')
    const block = movementView.slice(movementView.indexOf('subscribeToInventoryDataRefresh(() => {'))
    expect(block.slice(0, 200)).toContain('loadMovements()')
  })

  it('neither reader polls', () => {
    for (const source of [inventoryView, movementView]) {
      const subscription = source.slice(
        source.indexOf('subscribeToInventoryDataRefresh'),
        source.indexOf('subscribeToInventoryDataRefresh') + 400,
      )
      expect(subscription).not.toContain('setInterval')
      expect(subscription).not.toContain('setTimeout')
    }
  })

  it('the Opening Balance section broadcasts only after the post response succeeded', () => {
    const execute = cutoffSection.slice(
      cutoffSection.indexOf('const execute = async () => {'),
      cutoffSection.indexOf('const download = () => {'),
    )
    expect(execute).toContain('broadcastInventoryDataRefresh(')
    // The broadcast sits after the !response.ok throw and after onPosted().
    expect(execute.indexOf('if (!response.ok)')).toBeLessThan(execute.indexOf('broadcastInventoryDataRefresh('))
    expect(execute.indexOf('await onPosted?.()')).toBeLessThan(execute.indexOf('broadcastInventoryDataRefresh('))
    // It is inside the success path, never in the catch block.
    expect(execute.indexOf('broadcastInventoryDataRefresh(')).toBeLessThan(execute.indexOf('} catch (error: any) {'))
  })
})
