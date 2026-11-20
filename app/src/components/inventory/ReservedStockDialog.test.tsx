// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockLoad = vi.fn()
// Stable client, as the real hook returns (a new object per render would re-run the load effect).
const mockSupabase = {}
vi.mock('@/lib/hooks/useSupabaseAuth', () => ({ useSupabaseAuth: () => ({ isReady: true, supabase: mockSupabase }) }))
vi.mock('@/lib/inventory/reserved-stock-loader', () => ({ loadReservationBreakdown: (...args: unknown[]) => mockLoad(...args) }))
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a> }))

import ReservedStockDialog from './ReservedStockDialog'

const baseProps = {
  open: true,
  onClose: () => {},
  variantId: 'var-bv',
  warehouseOrgId: 'wh-hq',
  warehouseName: 'Serapod HQ Warehouse',
  productName: 'Cellera Hero',
  variantName: 'BV',
  configIds: ['cfg-20nb'],
  includeUnconfigured: true,
  storedReserved: 950,
  unit: 'cases' as const,
  pcsPerCase: 4,
}

const result = (over: Record<string, unknown> = {}) => ({
  rows: [
    { key: 'order:o1', sourceType: 'order', referenceId: 'o1', accessible: true, referenceNo: 'SO26000152',
      counterpartyName: 'Distributor A', status: 'submitted', reserved: 600, reservedSince: '2026-10-01T00:00:00Z',
      href: '/supply-chain?view=view-order&orderId=o1' },
    { key: 'order:o2', sourceType: 'order', referenceId: 'o2', accessible: false, referenceNo: null,
      counterpartyName: null, status: null, reserved: 350, reservedSince: '2026-10-02T00:00:00Z', href: null },
  ],
  attributedTotal: 950, storedTotal: 950, unreconciled: 0, anomalies: [], restrictedCount: 1,
  cutoffBoundaryUncertain: false, sources: ['order'], ...over,
})

beforeEach(() => mockLoad.mockReset())
afterEach(cleanup)

describe('ReservedStockDialog', () => {
  it('shows loading, then records with units, restricted rows and a reconciled total', async () => {
    let resolve!: (value: unknown) => void
    mockLoad.mockReturnValue(new Promise(r => { resolve = r }))
    render(<ReservedStockDialog {...baseProps} />)
    expect(screen.getByText('Reserved Stock — 950 cases')).toBeTruthy()
    expect(screen.getByText(/Cellera Hero \[BV\] — Serapod HQ Warehouse/)).toBeTruthy()
    expect(screen.getByText('Loading reserved stock...')).toBeTruthy()

    resolve(result())
    await screen.findByText('SO26000152')
    expect(screen.getByText('Distributor A')).toBeTruthy()
    expect(screen.getByText('Submitted')).toBeTruthy()
    expect(screen.getByText('Restricted record')).toBeTruthy()
    expect(screen.getByText(/1 reserving record is outside your access/)).toBeTruthy()
    expect(screen.queryByText('Source')).toBeNull() // single source → no Source column
    expect(screen.getByRole('link', { name: 'View' }).getAttribute('href')).toBe('/supply-chain?view=view-order&orderId=o1')
    expect(screen.queryByText(/Not attributable/)).toBeNull()
    expect(mockLoad).toHaveBeenCalledWith(mockSupabase, expect.objectContaining({
      variantId: 'var-bv', warehouseOrgId: 'wh-hq', configIds: ['cfg-20nb'], includeUnconfigured: true, storedReserved: 950,
    }))
  })

  it('shows an unreconciled legacy amount explicitly', async () => {
    mockLoad.mockResolvedValue(result({ attributedTotal: 900, unreconciled: 50 }))
    render(<ReservedStockDialog {...baseProps} />)
    await screen.findByText(/Not attributable to an open order or transfer/)
    expect(screen.getByText(/Shown as recorded; nothing was changed/)).toBeTruthy()
  })

  it('shows a Source column when orders and transfers both reserve', async () => {
    mockLoad.mockResolvedValue(result({
      sources: ['order', 'transfer'],
      rows: [{ ...result().rows[0] }, { key: 'transfer:t1', sourceType: 'transfer', referenceId: 't1', accessible: true,
        referenceNo: 'TRF-001', counterpartyName: 'North WH', status: 'ready_to_dispatch', reserved: 350,
        reservedSince: null, href: '/dashboard?view=stock-movements&id=TRF-001' }],
      restrictedCount: 0,
    }))
    render(<ReservedStockDialog {...baseProps} />)
    await screen.findByText('TRF-001')
    expect(screen.getByText('Source')).toBeTruthy()
    expect(screen.getByText('Stock transfer')).toBeTruthy()
    expect(screen.getByText('Ready to Dispatch')).toBeTruthy()
  })

  it('empty state', async () => {
    mockLoad.mockResolvedValue(result({ rows: [], attributedTotal: 0, unreconciled: 950, restrictedCount: 0, sources: [] }))
    render(<ReservedStockDialog {...baseProps} />)
    await screen.findByText(/No order or transfer currently holds a reservation/)
  })

  it('error state with retry', async () => {
    mockLoad.mockRejectedValueOnce(new Error('permission denied')).mockResolvedValueOnce(result())
    render(<ReservedStockDialog {...baseProps} />)
    await screen.findByText('permission denied')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('SO26000152')
    expect(mockLoad).toHaveBeenCalledTimes(2)
  })

  it('Escape closes', async () => {
    const onClose = vi.fn()
    mockLoad.mockResolvedValue(result())
    render(<ReservedStockDialog {...baseProps} onClose={onClose} />)
    await screen.findByText('SO26000152')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})
